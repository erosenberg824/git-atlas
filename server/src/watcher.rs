//! Live-update filesystem watcher.
//!
//! Watches the open repository's worktree (including its `.git` directory) and,
//! after a short debounce, broadcasts a "repo changed" event so connected
//! WebSocket clients can re-fetch the graph/status. Watching the whole worktree
//! (not just `.git`) means uncommitted working-tree edits update the
//! working-tree node live, in addition to commits, branch/tag/HEAD changes,
//! fetches, stashes, and index (staging) changes.
//!
//! To keep event volume sane, changed paths are filtered against the repo's
//! own ignore rules (`.gitignore`, `.git/info/exclude`, core.excludesFile) via
//! libgit2 — exactly the set of paths git itself disregards, and therefore the
//! set that can never affect the graph or status. Changes under `.git` are
//! always treated as meaningful (that's where commits/refs/index live).

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::broadcast;
use tracing::{debug, warn};

/// Decides whether a changed path is meaningful (should trigger a broadcast) or
/// git-ignored noise (should be dropped). Backed by libgit2's ignore rules so
/// the filter matches what `git status` would report. Lives on the debounce
/// thread; `git2::Repository` is `!Send`, so it is opened and kept there.
struct IgnoreFilter {
    repo: Option<git2::Repository>,
    workdir: PathBuf,
}

impl IgnoreFilter {
    fn new(repo_path: &Path) -> Self {
        let repo = git2::Repository::open(repo_path).ok();
        // Prefer the repo's real workdir; fall back to the passed path so a
        // failed open still yields sensible `.git` detection.
        let workdir = repo
            .as_ref()
            .and_then(|r| r.workdir().map(Path::to_path_buf))
            .unwrap_or_else(|| repo_path.to_path_buf());
        Self { repo, workdir }
    }

    /// True if `path` is a meaningful change (not git-ignored). Anything under
    /// `.git`, and anything we can't classify, is treated as meaningful so we
    /// never miss a real change.
    fn is_meaningful(&self, path: &Path) -> bool {
        // Changes inside `.git` (commits, refs, index, HEAD, stash) always
        // matter and are outside the reach of gitignore rules.
        if path
            .components()
            .any(|c| c.as_os_str() == std::ffi::OsStr::new(".git"))
        {
            return true;
        }
        match &self.repo {
            // libgit2 wants a path relative to the workdir; fall back to the
            // absolute path if it isn't under the workdir. On any error, err on
            // the side of "meaningful".
            Some(repo) => {
                let rel = path.strip_prefix(&self.workdir).unwrap_or(path);
                !repo.is_path_ignored(rel).unwrap_or(false)
            }
            None => true,
        }
    }

    /// True if `path` is an ignore-rule source (`.gitignore` anywhere in the
    /// tree, or `.git/info/exclude`). When one of these changes, libgit2's
    /// cached ignore state is stale and must be reloaded before classifying
    /// subsequent paths.
    fn is_ignore_source(path: &Path) -> bool {
        let file_name = path.file_name().and_then(|n| n.to_str());
        if file_name == Some(".gitignore") {
            return true;
        }
        // `.git/info/exclude`
        let mut comps = path.components().rev();
        matches!(
            (comps.next().and_then(|c| c.as_os_str().to_str()),
             comps.next().and_then(|c| c.as_os_str().to_str())),
            (Some("exclude"), Some("info"))
        ) && path
            .components()
            .any(|c| c.as_os_str() == std::ffi::OsStr::new(".git"))
    }

    /// Reload ignore rules from disk after an ignore-source change so future
    /// [`is_meaningful`](Self::is_meaningful) calls reflect the new rules.
    /// libgit2 caches parsed `.gitignore`s per repo snapshot; clearing the
    /// internal rules forces a fresh read on the next query.
    fn reload_ignores(&self) {
        if let Some(repo) = &self.repo {
            // `clear_ignore_rules` drops both the explicitly-added rules and
            // the cached parse of on-disk ignore files, so the next
            // `is_path_ignored` re-reads `.gitignore`/exclude from disk.
            let _ = repo.clear_ignore_rules();
        }
    }
}

/// Event broadcast to subscribers when the repository changes. Unit payload for
/// now — clients respond by re-fetching graph + status.
#[derive(Clone, Debug)]
pub struct RepoChanged;

/// Quiet-window debounce: once no further events arrive for this long, the
/// burst is considered finished and a broadcast fires. Coalesces the many
/// filesystem events a single git command (or editor save) produces.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Upper bound on how long a broadcast may be deferred while events keep
/// arriving. Without this cap, a steady stream of saves would keep resetting
/// the quiet window and starve the broadcast (the "laggy count" symptom). Once
/// this much time has elapsed since the first event of a burst, we fire even if
/// activity hasn't fully settled.
const MAX_WAIT: Duration = Duration::from_millis(600);

/// Handle to an active watcher. Dropping it stops watching and ends the
/// debounce task (used when re-pointing to a new repo).
pub struct WatchHandle {
    _watcher: RecommendedWatcher,
    stop: mpsc::Sender<()>,
}

/// Start watching `repo`'s worktree (recursively, including `.git`),
/// broadcasting [`RepoChanged`] on `tx` after a debounce whenever a
/// non-git-ignored path changes. Returns a handle that stops watching when
/// dropped, or `None` if the watcher could not be created.
pub fn start(repo: &Path, tx: broadcast::Sender<RepoChanged>) -> Option<WatchHandle> {
    // Watch the worktree root so uncommitted file edits are observed too. This
    // also covers `.git` (commits, refs, index). For a bare/gitdir-file repo
    // where the worktree root is the repo path itself, this is still correct.
    let watch_target = repo.to_path_buf();

    // notify runs its callback on its own thread; forward the changed paths
    // over a std mpsc channel to our debounce thread, which owns the (!Send)
    // git2 handle used for ignore filtering.
    let (raw_tx, raw_rx) = mpsc::channel::<Vec<PathBuf>>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let _ = raw_tx.send(event.paths);
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            warn!("failed to create filesystem watcher: {e}");
            return None;
        }
    };

    if let Err(e) = watcher.watch(&watch_target, RecursiveMode::Recursive) {
        warn!("failed to watch {}: {e}", watch_target.display());
        return None;
    }
    debug!("watching {} for changes", watch_target.display());

    // Debounce thread: collect raw events, drop git-ignored noise, and once
    // things go quiet for DEBOUNCE, broadcast a single RepoChanged (only if at
    // least one meaningful path was seen). A separate stop channel lets us end
    // the thread when the handle is dropped.
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let filter = IgnoreFilter::new(repo);
    std::thread::spawn(move || {
        // Not a `while let`: after the blocking recv we still run stop-channel
        // checks, a debounce-drain inner loop, and a conditional broadcast.
        #[allow(clippy::while_let_loop)]
        loop {
            // Block until the first event (or stop).
            let first = match raw_rx.recv() {
                Ok(paths) => paths,
                Err(_) => break, // watcher dropped
            };
            if stop_rx.try_recv().is_ok() {
                break;
            }
            let mut meaningful = paths_are_meaningful(&filter, &first);
            // Drain further events, but bound the total wait: coalesce a quiet
            // window of DEBOUNCE, yet never defer longer than MAX_WAIT from the
            // first event of the burst (so a steady stream of saves still gets
            // a timely broadcast instead of starving the quiet window).
            let burst_start = std::time::Instant::now();
            loop {
                let wait = match next_debounce_wait(burst_start.elapsed(), DEBOUNCE, MAX_WAIT) {
                    Some(w) => w,
                    None => break, // hit the cap — fire now even if still active
                };
                match raw_rx.recv_timeout(wait) {
                    Ok(paths) => {
                        meaningful |= paths_are_meaningful(&filter, &paths);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break, // quiet — fire
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if stop_rx.try_recv().is_ok() {
                break;
            }
            if !meaningful {
                // The whole burst was git-ignored noise (e.g. build output).
                continue;
            }
            // Broadcast; ignore error (no subscribers is fine).
            let _ = tx.send(RepoChanged);
            debug!("broadcast repo-changed event");
        }
    });

    Some(WatchHandle {
        _watcher: watcher,
        stop: stop_tx,
    })
}

/// Compute the next `recv_timeout` duration for the debounce drain loop, or
/// `None` when the burst has already reached `max_wait` (fire immediately).
///
/// The quiet window is `debounce`, but the total deferral is capped at
/// `max_wait` measured from the first event of the burst — so a steady stream
/// of events can't keep resetting the window and starving the broadcast (the
/// "laggy working-tree count" symptom).
fn next_debounce_wait(
    elapsed: Duration,
    debounce: Duration,
    max_wait: Duration,
) -> Option<Duration> {
    if elapsed >= max_wait {
        return None;
    }
    Some(debounce.min(max_wait - elapsed))
}

/// True if any path in the batch is a meaningful (non-git-ignored) change. An
/// empty batch is treated as meaningful (some backends report path-less
/// events). If the batch touches an ignore source (`.gitignore` /
/// `.git/info/exclude`), the filter's cached ignore rules are reloaded first so
/// the remaining paths are classified against the new rules — and the ignore
/// edit itself counts as meaningful (it changes what `git status` reports).
fn paths_are_meaningful(filter: &IgnoreFilter, paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return true;
    }
    let touched_ignore_source = paths.iter().any(|p| IgnoreFilter::is_ignore_source(p));
    if touched_ignore_source {
        filter.reload_ignores();
        return true;
    }
    paths.iter().any(|p| filter.is_meaningful(p))
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::{paths_are_meaningful, IgnoreFilter};
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Build a fresh temp repo (project convention: unique dir under the OS
    /// temp dir, cleaned up by the caller — no `tempfile` crate dependency).
    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "git-atlas-watcher-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        dir
    }

    fn cleanup(dir: PathBuf) {
        let _ = fs::remove_dir_all(dir);
    }

    fn write_gitignore(dir: &Path, contents: &str) {
        fs::write(dir.join(".gitignore"), contents).unwrap();
    }

    #[test]
    fn tracked_source_edit_is_meaningful() {
        let dir = temp_repo();
        write_gitignore(&dir, "target/\nnode_modules/\n*.log\n");
        let filter = IgnoreFilter::new(&dir);
        assert!(filter.is_meaningful(&dir.join("src/main.rs")));
        assert!(filter.is_meaningful(&dir.join("README.md")));
        assert!(filter.is_meaningful(&dir.join(".gitignore")));
        cleanup(dir);
    }

    #[test]
    fn gitignored_paths_are_not_meaningful() {
        let dir = temp_repo();
        write_gitignore(&dir, "target/\nnode_modules/\n*.log\n");
        let filter = IgnoreFilter::new(&dir);
        assert!(!filter.is_meaningful(&dir.join("target/debug/app")));
        assert!(!filter.is_meaningful(&dir.join("node_modules/react/index.js")));
        assert!(!filter.is_meaningful(&dir.join("debug.log")));
        cleanup(dir);
    }

    #[test]
    fn git_internal_changes_are_always_meaningful() {
        let dir = temp_repo();
        let filter = IgnoreFilter::new(&dir);
        // Commits/refs/index writes under .git must always signal, even though
        // they're never git-ignored.
        assert!(filter.is_meaningful(&dir.join(".git/index")));
        assert!(filter.is_meaningful(&dir.join(".git/refs/heads/main")));
        assert!(filter.is_meaningful(&dir.join(".git/logs/HEAD")));
        // Stash operations write these; they must trigger a refresh so stash
        // pseudo-nodes appear/disappear live.
        assert!(filter.is_meaningful(&dir.join(".git/refs/stash")));
        assert!(filter.is_meaningful(&dir.join(".git/logs/refs/stash")));
        cleanup(dir);
    }

    #[test]
    fn non_repo_path_defaults_to_meaningful() {
        let dir = std::env::temp_dir().join(format!(
            "git-atlas-watcher-norepo-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        // No repo initialized here — filter can't open one, so it must not
        // silently swallow events.
        let filter = IgnoreFilter::new(&dir);
        assert!(filter.is_meaningful(&dir.join("anything.txt")));
        cleanup(dir);
    }

    #[test]
    fn ignore_sources_are_detected() {
        assert!(IgnoreFilter::is_ignore_source(Path::new("/repo/.gitignore")));
        assert!(IgnoreFilter::is_ignore_source(Path::new("/repo/sub/dir/.gitignore")));
        assert!(IgnoreFilter::is_ignore_source(Path::new(
            "/repo/.git/info/exclude"
        )));
        assert!(!IgnoreFilter::is_ignore_source(Path::new("/repo/src/main.rs")));
        assert!(!IgnoreFilter::is_ignore_source(Path::new("/repo/exclude")));
    }

    #[test]
    fn editing_gitignore_is_meaningful_and_refreshes_rules() {
        let dir = temp_repo();
        // Start with app.log ignored.
        write_gitignore(&dir, "*.log\n");
        let filter = IgnoreFilter::new(&dir);
        assert!(!filter.is_meaningful(&dir.join("app.log")));

        // Rewrite .gitignore so *.log is no longer ignored, and feed the
        // .gitignore change through the batch classifier (as the watcher does).
        write_gitignore(&dir, "target/\n");
        let gitignore_batch = vec![dir.join(".gitignore")];
        // The .gitignore edit itself is a meaningful change...
        assert!(paths_are_meaningful(&filter, &gitignore_batch));
        // ...and the cached rules were reloaded, so app.log is now meaningful.
        assert!(filter.is_meaningful(&dir.join("app.log")));
        cleanup(dir);
    }

    #[test]
    fn empty_batch_is_meaningful() {
        let dir = temp_repo();
        let filter = IgnoreFilter::new(&dir);
        assert!(paths_are_meaningful(&filter, &[]));
        cleanup(dir);
    }

    #[test]
    fn debounce_wait_uses_quiet_window_early_in_burst() {
        use super::next_debounce_wait;
        use std::time::Duration;
        let debounce = Duration::from_millis(200);
        let max = Duration::from_millis(600);
        // Early in the burst: full quiet window.
        assert_eq!(
            next_debounce_wait(Duration::from_millis(0), debounce, max),
            Some(debounce)
        );
        assert_eq!(
            next_debounce_wait(Duration::from_millis(100), debounce, max),
            Some(debounce)
        );
    }

    #[test]
    fn debounce_wait_shrinks_near_cap_then_fires() {
        use super::next_debounce_wait;
        use std::time::Duration;
        let debounce = Duration::from_millis(200);
        let max = Duration::from_millis(600);
        // Close to the cap: wait is clamped so we don't overshoot max_wait.
        assert_eq!(
            next_debounce_wait(Duration::from_millis(500), debounce, max),
            Some(Duration::from_millis(100))
        );
        // At/after the cap: fire immediately (None).
        assert_eq!(next_debounce_wait(max, debounce, max), None);
        assert_eq!(
            next_debounce_wait(Duration::from_millis(700), debounce, max),
            None
        );
    }
}
