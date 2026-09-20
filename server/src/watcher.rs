//! Live-update filesystem watcher.
//!
//! Watches the open repository's `.git` directory and, after a short debounce,
//! broadcasts a "repo changed" event so connected WebSocket clients can
//! re-fetch the graph/status. Watching `.git` (rather than the whole worktree)
//! captures commits, branch/tag/HEAD changes, fetches, stashes, and index
//! (staging) changes, while keeping the event volume manageable.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::broadcast;
use tracing::{debug, warn};

/// Event broadcast to subscribers when the repository changes. Unit payload for
/// now — clients respond by re-fetching graph + status.
#[derive(Clone, Debug)]
pub struct RepoChanged;

/// Debounce window: coalesce bursts of filesystem events (e.g. a single git
/// command touches many files) into one broadcast.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// Handle to an active watcher. Dropping it stops watching and ends the
/// debounce task (used when re-pointing to a new repo).
pub struct WatchHandle {
    _watcher: RecommendedWatcher,
    stop: mpsc::Sender<()>,
}

/// Start watching `<repo>/.git`, broadcasting [`RepoChanged`] on `tx` after a
/// debounce whenever something changes. Returns a handle that stops watching
/// when dropped. Returns `None` if the watcher could not be created.
pub fn start(repo: &Path, tx: broadcast::Sender<RepoChanged>) -> Option<WatchHandle> {
    let git_dir = repo.join(".git");
    let watch_target = if git_dir.exists() { git_dir } else { repo.to_path_buf() };

    // notify runs its callback on its own thread; forward raw events over a
    // std mpsc channel to our debounce thread.
    let (raw_tx, raw_rx) = mpsc::channel::<()>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            // We don't care about the specifics; any change is a signal.
            let _ = raw_tx.send(());
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

    // Debounce thread: collect raw events, and once things go quiet for
    // DEBOUNCE, broadcast a single RepoChanged. A separate stop channel lets us
    // end the thread when the handle is dropped.
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        loop {
            // Block until the first event (or stop).
            match raw_rx.recv() {
                Ok(()) => {}
                Err(_) => break, // watcher dropped
            }
            if stop_rx.try_recv().is_ok() {
                break;
            }
            // Drain any further events during the debounce window.
            loop {
                match raw_rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => continue,           // more activity — keep waiting
                    Err(mpsc::RecvTimeoutError::Timeout) => break, // quiet — fire
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if stop_rx.try_recv().is_ok() {
                break;
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

impl Drop for WatchHandle {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}
