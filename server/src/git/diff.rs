use crate::error::AppError;
use git2::{Delta, DiffOptions, Repository};
use serde::Serialize;
use std::cell::RefCell;

#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub files: Vec<FileDiff>,
    pub stats: DiffStats,
}

#[derive(Debug, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<Hunk>,
    pub is_binary: bool,
}

#[derive(Debug, Serialize)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub origin: char,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct DiffStats {
    pub files_changed: usize,
    pub additions: usize,
    pub deletions: usize,
}

/// Diff a commit against its first parent (or an empty tree if it has no parents).
pub fn diff_commit_vs_parent(repo: &Repository, oid_str: &str) -> Result<DiffResponse, AppError> {
    let oid = resolve_oid(repo, oid_str)?;
    let commit = repo.find_commit(oid).map_err(AppError::Git)?;
    let new_tree = commit.tree().map_err(AppError::Git)?;

    let diff = if let Ok(parent) = commit.parent(0) {
        let old_tree = parent.tree().map_err(AppError::Git)?;
        repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), None)
            .map_err(AppError::Git)?
    } else {
        repo.diff_tree_to_tree(None, Some(&new_tree), None)
            .map_err(AppError::Git)?
    };

    parse_diff(diff)
}

/// Diff two arbitrary commits.
pub fn diff_two_commits(
    repo: &Repository,
    base_str: &str,
    target_str: &str,
    path_filter: Option<&str>,
) -> Result<DiffResponse, AppError> {
    let base_oid = resolve_oid(repo, base_str)?;
    let target_oid = resolve_oid(repo, target_str)?;

    let base_tree = repo
        .find_commit(base_oid)
        .map_err(AppError::Git)?
        .tree()
        .map_err(AppError::Git)?;
    let target_tree = repo
        .find_commit(target_oid)
        .map_err(AppError::Git)?
        .tree()
        .map_err(AppError::Git)?;

    let mut opts = DiffOptions::new();
    if let Some(path) = path_filter {
        opts.pathspec(path);
    }

    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&target_tree), Some(&mut opts))
        .map_err(AppError::Git)?;

    parse_diff(diff)
}

struct FileAccumulator {
    file: FileDiff,
    current_hunk: Option<Hunk>,
}

fn parse_diff(diff: git2::Diff) -> Result<DiffResponse, AppError> {
    let stats = diff.stats().map_err(AppError::Git)?;

    // Use RefCell so multiple closures can access accumulators without
    // triggering Rust's multiple-mutable-borrow check.
    let accumulators: RefCell<Vec<FileAccumulator>> = RefCell::new(Vec::new());

    diff.foreach(
        &mut |delta, _progress| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let old_path = if delta.old_file().path() != delta.new_file().path() {
                delta
                    .old_file()
                    .path()
                    .map(|p| p.to_string_lossy().to_string())
            } else {
                None
            };

            let status = match delta.status() {
                Delta::Added => "added",
                Delta::Deleted => "deleted",
                Delta::Modified => "modified",
                Delta::Renamed => "renamed",
                Delta::Copied => "copied",
                Delta::Untracked => "untracked",
                Delta::Typechange => "typechange",
                _ => "unknown",
            }
            .to_string();

            accumulators.borrow_mut().push(FileAccumulator {
                file: FileDiff {
                    path,
                    old_path,
                    status,
                    additions: 0,
                    deletions: 0,
                    hunks: Vec::new(),
                    is_binary: delta.new_file().is_binary(),
                },
                current_hunk: None,
            });
            true
        },
        None,
        Some(&mut |_delta, hunk| {
            let header = std::str::from_utf8(hunk.header())
                .unwrap_or("")
                .trim()
                .to_string();
            let mut accs = accumulators.borrow_mut();
            if let Some(acc) = accs.last_mut() {
                if let Some(h) = acc.current_hunk.take() {
                    acc.file.hunks.push(h);
                }
                acc.current_hunk = Some(Hunk {
                    header,
                    lines: Vec::new(),
                });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            let origin = line.origin();
            let content = std::str::from_utf8(line.content())
                .unwrap_or("")
                .trim_end_matches('\n')
                .to_string();

            let mut accs = accumulators.borrow_mut();
            if let Some(acc) = accs.last_mut() {
                match origin {
                    '+' => acc.file.additions += 1,
                    '-' => acc.file.deletions += 1,
                    _ => {}
                }

                let diff_line = DiffLine {
                    origin,
                    content,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                };

                if let Some(h) = acc.current_hunk.as_mut() {
                    h.lines.push(diff_line);
                }
            }
            true
        }),
    )
    .map_err(AppError::Git)?;

    // Flush remaining open hunks and collect files
    let files = accumulators
        .into_inner()
        .into_iter()
        .map(|mut acc| {
            if let Some(h) = acc.current_hunk.take() {
                acc.file.hunks.push(h);
            }
            acc.file
        })
        .collect();

    Ok(DiffResponse {
        files,
        stats: DiffStats {
            files_changed: stats.files_changed(),
            additions: stats.insertions(),
            deletions: stats.deletions(),
        },
    })
}

fn resolve_oid(repo: &Repository, s: &str) -> Result<git2::Oid, AppError> {
    git2::Oid::from_str(s)
        .or_else(|_| repo.revparse_single(s).map(|o| o.id()))
        .map_err(|_| AppError::NotFound(format!("ref not found: {s}")))
}

/// Build DiffOptions that include untracked (and their contents) so brand-new
/// files show up in the working-tree diff the way users expect.
fn workdir_diff_opts() -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    opts
}

/// Unstaged changes: differences between the index and the working directory
/// (what `git diff` shows). Includes untracked files.
pub fn diff_working(repo: &Repository) -> Result<DiffResponse, AppError> {
    let mut opts = workdir_diff_opts();
    let index = repo.index().map_err(AppError::Git)?;
    let diff = repo
        .diff_index_to_workdir(Some(&index), Some(&mut opts))
        .map_err(AppError::Git)?;
    parse_diff(diff)
}

/// Staged changes: differences between HEAD's tree and the index
/// (what `git diff --cached` shows). On an unborn HEAD, diffs an empty tree
/// against the index so the first staged files still appear.
pub fn diff_staged(repo: &Repository) -> Result<DiffResponse, AppError> {
    let index = repo.index().map_err(AppError::Git)?;

    // HEAD tree, or None if the branch is unborn (no commits yet).
    let head_tree = match repo.head() {
        Ok(head) => {
            let obj = head.peel_to_tree().map_err(AppError::Git)?;
            Some(obj)
        }
        Err(_) => None,
    };

    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map_err(AppError::Git)?;
    parse_diff(diff)
}

/// A single stash entry.
#[derive(Debug, Serialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub oid: String,
    /// OID of the commit the stash was based on (its first parent), if any.
    /// Lets the UI anchor the stash node to a real commit in the graph.
    pub base_oid: Option<String>,
}

/// Summary of the repository's current working state, used to drive UI badges
/// and to decide whether to show the working-tree pseudo-node and stash nodes.
#[derive(Debug, Serialize)]
pub struct StatusSummary {
    pub staged_count: usize,
    pub unstaged_count: usize,
    /// True if there are any staged or unstaged changes (untracked included).
    pub is_dirty: bool,
    pub stashes: Vec<StashEntry>,
}

/// Collect the list of stashes. `stash_foreach` requires `&mut Repository`.
/// Done in two passes because the foreach callback holds a borrow of the repo
/// and cannot itself look up each stash commit's parent.
pub fn list_stashes(repo: &mut Repository) -> Result<Vec<StashEntry>, AppError> {
    // Pass 1: gather index/message/oid inside the callback.
    let mut raw: Vec<(usize, String, git2::Oid)> = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        raw.push((index, message.to_string(), *oid));
        true
    })
    .map_err(AppError::Git)?;

    // Pass 2: resolve each stash's first parent (the base it was taken from).
    let mut stashes = Vec::with_capacity(raw.len());
    for (index, message, oid) in raw {
        let base_oid = repo
            .find_commit(oid)
            .ok()
            .and_then(|c| c.parent(0).ok())
            .map(|p| p.id().to_string());
        stashes.push(StashEntry {
            index,
            message,
            oid: oid.to_string(),
            base_oid,
        });
    }
    Ok(stashes)
}

/// Compute a status summary: staged/unstaged counts + stash list.
pub fn status_summary(repo: &mut Repository) -> Result<StatusSummary, AppError> {
    let staged = diff_staged(repo)?;
    let unstaged = diff_working(repo)?;
    let stashes = list_stashes(repo)?;

    let staged_count = staged.stats.files_changed;
    let unstaged_count = unstaged.stats.files_changed;

    Ok(StatusSummary {
        staged_count,
        unstaged_count,
        is_dirty: staged_count > 0 || unstaged_count > 0,
        stashes,
    })
}

/// Diff a single stash entry against its base (first parent) commit.
/// A stash is a commit whose first parent is the commit that was checked out
/// when the stash was created, so this shows what the stash actually changed.
pub fn diff_stash(repo: &mut Repository, index: usize) -> Result<DiffResponse, AppError> {
    // Resolve the stash entry's commit OID by index.
    let stashes = list_stashes(repo)?;
    let entry = stashes
        .iter()
        .find(|s| s.index == index)
        .ok_or_else(|| AppError::NotFound(format!("stash index out of range: {index}")))?;

    let stash_oid = git2::Oid::from_str(&entry.oid).map_err(AppError::Git)?;
    let stash_commit = repo.find_commit(stash_oid).map_err(AppError::Git)?;
    let stash_tree = stash_commit.tree().map_err(AppError::Git)?;

    // First parent is the base the stash was taken from.
    let base_tree = match stash_commit.parent(0) {
        Ok(parent) => Some(parent.tree().map_err(AppError::Git)?),
        Err(_) => None,
    };

    let diff = repo
        .diff_tree_to_tree(base_tree.as_ref(), Some(&stash_tree), None)
        .map_err(AppError::Git)?;
    parse_diff(diff)
}


#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature, Time};
    use std::path::PathBuf;

    /// Create a fresh empty repo in a unique temp directory.
    fn temp_repo() -> (Repository, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "git-atlas-diff-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        (repo, dir)
    }

    fn cleanup(dir: PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Write a file into the repo's working directory.
    fn write_file(repo: &Repository, rel: &str, contents: &str) {
        let path = repo.workdir().unwrap().join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn remove_file(repo: &Repository, rel: &str) {
        std::fs::remove_file(repo.workdir().unwrap().join(rel)).unwrap();
    }

    /// Stage every change in the working tree (adds, modifications, deletions).
    fn stage_all(repo: &Repository) {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        // add_all does not record deletions of tracked files; update_all does.
        index.update_all(["*"], None).unwrap();
        index.write().unwrap();
    }

    /// Commit whatever is staged with a fixed timestamp. Returns the commit OID.
    fn commit(repo: &Repository, msg: &str, ts: i64) -> git2::Oid {
        let mut index = repo.index().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::new("t", "t@t.co", &Time::new(ts, 0)).unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(h) => vec![h.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    /// Stage everything then commit — convenience for the common case.
    fn commit_all(repo: &Repository, msg: &str, ts: i64) -> git2::Oid {
        stage_all(repo);
        commit(repo, msg, ts)
    }

    fn find<'a>(resp: &'a DiffResponse, path: &str) -> &'a FileDiff {
        resp.files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("expected file {path} in diff, got {:?}", resp.files))
    }

    #[test]
    fn first_commit_diffs_against_empty_tree_as_all_added() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "one\ntwo\n");
        let c1 = commit_all(&repo, "init", 1000);

        let resp = diff_commit_vs_parent(&repo, &c1.to_string()).unwrap();
        assert_eq!(resp.stats.files_changed, 1);
        let f = find(&resp, "a.txt");
        assert_eq!(f.status, "added");
        assert_eq!(f.additions, 2);
        assert_eq!(f.deletions, 0);
        assert!(!f.is_binary);
        cleanup(dir);
    }

    #[test]
    fn modification_counts_additions_and_deletions() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "one\ntwo\nthree\n");
        commit_all(&repo, "init", 1000);
        write_file(&repo, "a.txt", "one\nCHANGED\nthree\nfour\n");
        let c2 = commit_all(&repo, "edit", 2000);

        let resp = diff_commit_vs_parent(&repo, &c2.to_string()).unwrap();
        let f = find(&resp, "a.txt");
        assert_eq!(f.status, "modified");
        // line "two" removed, "CHANGED" + "four" added
        assert_eq!(f.additions, 2);
        assert_eq!(f.deletions, 1);
        assert!(!f.hunks.is_empty());
        cleanup(dir);
    }

    #[test]
    fn deletion_is_reported_as_deleted() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "one\n");
        write_file(&repo, "b.txt", "keep\n");
        commit_all(&repo, "init", 1000);
        remove_file(&repo, "a.txt");
        let c2 = commit_all(&repo, "rm a", 2000);

        let resp = diff_commit_vs_parent(&repo, &c2.to_string()).unwrap();
        assert_eq!(resp.stats.files_changed, 1);
        let f = find(&resp, "a.txt");
        assert_eq!(f.status, "deleted");
        assert_eq!(f.deletions, 1);
        cleanup(dir);
    }

    #[test]
    fn diff_two_commits_reports_net_change_and_respects_path_filter() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "a1\n");
        write_file(&repo, "b.txt", "b1\n");
        let base = commit_all(&repo, "base", 1000);
        write_file(&repo, "a.txt", "a1\na2\n");
        write_file(&repo, "b.txt", "b1\nb2\n");
        let target = commit_all(&repo, "grow", 2000);

        let full = diff_two_commits(&repo, &base.to_string(), &target.to_string(), None).unwrap();
        assert_eq!(full.stats.files_changed, 2);

        let filtered =
            diff_two_commits(&repo, &base.to_string(), &target.to_string(), Some("a.txt")).unwrap();
        assert_eq!(filtered.files.len(), 1);
        assert_eq!(filtered.files[0].path, "a.txt");
        cleanup(dir);
    }

    #[test]
    fn resolve_oid_accepts_refs_and_reports_missing() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "x\n");
        commit_all(&repo, "init", 1000);

        // HEAD is a symbolic ref that revparse should resolve.
        let by_ref = diff_commit_vs_parent(&repo, "HEAD").unwrap();
        assert_eq!(by_ref.files[0].path, "a.txt");

        let err = diff_commit_vs_parent(&repo, "does-not-exist").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(dir);
    }

    #[test]
    fn working_diff_includes_untracked_files() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "tracked.txt", "v1\n");
        commit_all(&repo, "init", 1000);

        // Unstaged edit to the tracked file + a brand-new untracked file.
        write_file(&repo, "tracked.txt", "v1\nv2\n");
        write_file(&repo, "new.txt", "hello\n");

        let resp = diff_working(&repo).unwrap();
        let paths: Vec<&str> = resp.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"tracked.txt"), "got {paths:?}");
        assert!(paths.contains(&"new.txt"), "untracked file missing: {paths:?}");
        cleanup(dir);
    }

    #[test]
    fn staged_diff_shows_only_index_changes() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "v1\n");
        commit_all(&repo, "init", 1000);

        // Stage an edit to a.txt, but leave an unstaged new file uncommitted.
        write_file(&repo, "a.txt", "v1\nv2\n");
        stage_all(&repo);
        write_file(&repo, "unstaged.txt", "not staged\n");

        let staged = diff_staged(&repo).unwrap();
        let staged_paths: Vec<&str> = staged.files.iter().map(|f| f.path.as_str()).collect();
        assert!(staged_paths.contains(&"a.txt"));
        assert!(
            !staged_paths.contains(&"unstaged.txt"),
            "unstaged file should not appear in staged diff: {staged_paths:?}"
        );
        cleanup(dir);
    }

    #[test]
    fn staged_diff_on_unborn_head_shows_first_files() {
        let (repo, dir) = temp_repo();
        // No commits yet: stage a file directly.
        write_file(&repo, "first.txt", "hi\n");
        stage_all(&repo);

        let staged = diff_staged(&repo).unwrap();
        assert_eq!(staged.files.len(), 1);
        assert_eq!(staged.files[0].path, "first.txt");
        assert_eq!(staged.files[0].status, "added");
        cleanup(dir);
    }

    #[test]
    fn status_summary_tracks_dirty_and_counts() {
        let (mut repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "v1\n");
        commit_all(&repo, "init", 1000);

        // Clean working tree.
        let clean = status_summary(&mut repo).unwrap();
        assert!(!clean.is_dirty);
        assert_eq!(clean.staged_count, 0);
        assert_eq!(clean.unstaged_count, 0);
        assert!(clean.stashes.is_empty());

        // One staged change + one unstaged new file.
        write_file(&repo, "a.txt", "v1\nv2\n");
        stage_all(&repo);
        write_file(&repo, "b.txt", "new\n");

        let dirty = status_summary(&mut repo).unwrap();
        assert!(dirty.is_dirty);
        assert_eq!(dirty.staged_count, 1);
        assert_eq!(dirty.unstaged_count, 1);
        cleanup(dir);
    }

    #[test]
    fn stash_is_listed_and_diffable() {
        let (mut repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "v1\n");
        commit_all(&repo, "init", 1000);

        // Make a change and stash it.
        write_file(&repo, "a.txt", "v1\nstashed\n");
        let sig = Signature::new("t", "t@t.co", &Time::new(2000, 0)).unwrap();
        repo.stash_save(&sig, "wip", None).unwrap();

        let stashes = list_stashes(&mut repo).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
        assert!(stashes[0].base_oid.is_some(), "stash should have a base");

        // The stash diff should show the change we stashed.
        let resp = diff_stash(&mut repo, 0).unwrap();
        let f = find(&resp, "a.txt");
        assert_eq!(f.additions, 1);

        // Out-of-range index is a NotFound, not a panic.
        let err = diff_stash(&mut repo, 99).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(dir);
    }

    #[test]
    fn diff_line_content_strips_trailing_newline() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", "hello\n");
        let c1 = commit_all(&repo, "init", 1000);

        let resp = diff_commit_vs_parent(&repo, &c1.to_string()).unwrap();
        let f = find(&resp, "a.txt");
        let line = f
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .find(|l| l.origin == '+')
            .expect("an added line");
        assert_eq!(line.content, "hello");
        assert_eq!(line.new_lineno, Some(1));
        cleanup(dir);
    }
}
