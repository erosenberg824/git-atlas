use crate::error::AppError;
use git2::{Repository, Sort};
use serde::Serialize;

/// A single commit node in the graph.
#[derive(Debug, Serialize)]
pub struct CommitNode {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
}

/// A directed edge from parent to child.
#[derive(Debug, Serialize)]
pub struct CommitEdge {
    pub source: String,
    pub target: String,
}

/// A ref label (branch, tag, HEAD) pointing at a commit OID.
#[derive(Debug, Serialize)]
pub struct RefLabel {
    pub name: String,
    pub oid: String,
    pub kind: RefKind,
    pub is_head: bool,
    /// Commit time (unix seconds) of the ref's target commit — lets the client
    /// rank branches by recency (for the "recent branches" default visibility).
    pub tip_ts: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Branch,
    RemoteBranch,
    Tag,
    Head,
}

/// Build a commit graph starting from `start` (ref or OID), limited to `limit` commits.
/// Returns (nodes, edges, refs).
pub fn build_graph(
    repo: &Repository,
    start: Option<&str>,
    limit: usize,
    since: Option<i64>,
    until: Option<i64>,
    seed_refs: Option<&[String]>,
) -> Result<(Vec<CommitNode>, Vec<CommitEdge>, Vec<RefLabel>, usize, usize), AppError> {
    let mut revwalk = repo.revwalk().map_err(AppError::Git)?;
    revwalk
        .set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(AppError::Git)?;

    // Push the starting ref
    if let Some(s) = start {
        let obj = repo
            .revparse_single(s)
            .map_err(|_| AppError::NotFound(format!("ref not found: {s}")))?;
        revwalk.push(obj.id()).map_err(AppError::Git)?;
    } else if let Some(refs) = seed_refs.filter(|r| !r.is_empty()) {
        // Seed only from the caller-selected refs (branch scoping). Each is
        // peeled to a commit; unresolvable/empty refs are skipped. If none
        // resolve, fall through to an empty graph rather than erroring.
        let mut pushed = 0;
        for name in refs {
            if let Ok(reference) = repo
                .revparse_single(name)
                .or_else(|_| repo.revparse_single(&format!("refs/heads/{name}")))
                .or_else(|_| repo.revparse_single(&format!("refs/remotes/{name}")))
            {
                if let Ok(commit) = reference.peel_to_commit() {
                    if revwalk.push(commit.id()).is_ok() {
                        pushed += 1;
                    }
                }
            }
        }
        if pushed == 0 {
            let refs = collect_refs(repo)?;
            return Ok((Vec::new(), Vec::new(), refs, 0, 0));
        }
    } else {
        // A repository with no commits has an unborn HEAD (e.g. refs/heads/main
        // that doesn't exist yet). push_head() would fail with a Reference error,
        // so treat this as a valid-but-empty graph rather than an error.
        if repo.is_empty().unwrap_or(false) || repo.head().is_err() {
            let refs = collect_refs(repo)?;
            return Ok((Vec::new(), Vec::new(), refs, 0, 0));
        }
        // Seed the walk from ALL refs (local + remote branches, tags, HEAD) so
        // the graph includes commits reachable from any ref — not just those on
        // the current HEAD. Without this, e.g. freshly fetched remote branches
        // would collect ref labels but have no commit nodes to attach to.
        revwalk.push_glob("refs/*").map_err(AppError::Git)?;
    }

    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Counts of visible (seeded) commits that fall OUTSIDE the window, so the UI
    // can show "X before · Y after". before = older than `since`, after = newer
    // than `until`. Tallied over the full walk (independent of the node limit).
    let mut before_count = 0usize;
    let mut after_count = 0usize;
    let mut node_budget_left = limit > 0;

    for oid_result in revwalk {
        let oid = oid_result.map_err(AppError::Git)?;
        if !seen.insert(oid) {
            continue;
        }

        let commit = repo.find_commit(oid).map_err(AppError::Git)?;
        let ts = commit.time().seconds();

        // Time-window classification.
        if let Some(until) = until {
            if ts > until {
                after_count += 1; // newer than the window
                continue;
            }
        }
        if let Some(since) = since {
            if ts < since {
                before_count += 1; // older than the window
                continue;
            }
        }

        // In-window commit: build a node until the limit is reached. (We keep
        // walking after the limit only to finish tallying before/after counts.)
        if !node_budget_left {
            continue;
        }

        let short_oid = oid.to_string()[..8].to_string();
        let parents: Vec<String> = commit
            .parent_ids()
            .map(|p| p.to_string())
            .collect();

        // Edges: parent → this commit
        for parent_oid in &parents {
            edges.push(CommitEdge {
                source: parent_oid.clone(),
                target: oid.to_string(),
            });
        }

        nodes.push(CommitNode {
            oid: oid.to_string(),
            short_oid,
            summary: commit.summary().unwrap_or("").to_string(),
            author_name: commit.author().name().unwrap_or("").to_string(),
            author_email: commit.author().email().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            parents,
        });
        if nodes.len() >= limit {
            node_budget_left = false;
        }
    }

    // Drop edges whose endpoints aren't both in the returned node set. With a
    // `limit`, a commit near the cutoff can have a parent that falls outside the
    // window; emitting that edge would reference a non-existent node and break
    // client-side rendering (React Flow throws on edges to unknown nodes).
    let node_ids: std::collections::HashSet<&str> =
        nodes.iter().map(|n| n.oid.as_str()).collect();
    edges.retain(|e| node_ids.contains(e.source.as_str()) && node_ids.contains(e.target.as_str()));

    let refs = collect_refs(repo)?;
    Ok((nodes, edges, refs, before_count, after_count))
}

/// Repository time bounds: newest & oldest commit timestamps (unix seconds)
/// across all refs, plus the total commit count. Drives the time scrubber's
/// full-range extent. Returns None bounds for an empty repo.
#[derive(Debug, Serialize)]
pub struct TimeBounds {
    pub newest_ts: Option<i64>,
    pub oldest_ts: Option<i64>,
    pub count: usize,
}

pub fn time_bounds(repo: &Repository) -> Result<TimeBounds, AppError> {
    if repo.is_empty().unwrap_or(false) || repo.head().is_err() {
        return Ok(TimeBounds { newest_ts: None, oldest_ts: None, count: 0 });
    }
    let mut revwalk = repo.revwalk().map_err(AppError::Git)?;
    revwalk.push_glob("refs/*").map_err(AppError::Git)?;

    let mut newest: Option<i64> = None;
    let mut oldest: Option<i64> = None;
    let mut count = 0usize;
    for oid_result in revwalk {
        let oid = oid_result.map_err(AppError::Git)?;
        let ts = repo.find_commit(oid).map_err(AppError::Git)?.time().seconds();
        newest = Some(newest.map_or(ts, |n| n.max(ts)));
        oldest = Some(oldest.map_or(ts, |o| o.min(ts)));
        count += 1;
    }
    Ok(TimeBounds { newest_ts: newest, oldest_ts: oldest, count })
}

/// Collect all local branches, remote branches, and tags with their target OIDs.
fn collect_refs(repo: &Repository) -> Result<Vec<RefLabel>, AppError> {
    let mut labels = Vec::new();

    // HEAD
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            let tip_ts = repo.find_commit(target).ok().map(|c| c.time().seconds());
            labels.push(RefLabel {
                name: "HEAD".into(),
                oid: target.to_string(),
                kind: RefKind::Head,
                is_head: true,
                tip_ts,
            });
        }
    }

    // All references
    let ref_names: Vec<String> = repo
        .references()
        .map_err(AppError::Git)?
        .filter_map(|r| r.ok())
        .filter_map(|r| r.name().map(str::to_owned))
        .collect();

    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_owned));

    for name in ref_names {
        let reference = repo.find_reference(&name).map_err(AppError::Git)?;
        // Peel the reference to the commit it ultimately points at. This is
        // essential for ANNOTATED tags, whose direct target is the tag object
        // (not a commit) — using target() there would attach the badge to a
        // non-existent node. peel_to_commit() resolves lightweight tags,
        // annotated tags, and branches alike to the underlying commit OID.
        let (target_oid, tip_ts) = match reference.peel_to_commit() {
            Ok(commit) => (commit.id(), Some(commit.time().seconds())),
            Err(_) => continue, // e.g. a ref that doesn't resolve to a commit
        };

        let (short_name, kind) = if name.starts_with("refs/heads/") {
            (name.trim_start_matches("refs/heads/").to_string(), RefKind::Branch)
        } else if name.starts_with("refs/remotes/") {
            (name.trim_start_matches("refs/remotes/").to_string(), RefKind::RemoteBranch)
        } else if name.starts_with("refs/tags/") {
            (name.trim_start_matches("refs/tags/").to_string(), RefKind::Tag)
        } else {
            continue;
        };

        let is_head = head_name.as_deref() == Some(&short_name);

        labels.push(RefLabel {
            name: short_name,
            oid: target_oid.to_string(),
            kind,
            is_head,
            tip_ts,
        });
    }

    Ok(labels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature, Time};
    use std::path::PathBuf;

    /// Create a fresh empty repo in a unique temp directory.
    fn temp_repo() -> (Repository, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "git-atlas-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        (repo, dir)
    }

    /// Commit a file change on the current HEAD with a fixed timestamp (unix secs).
    /// Returns the new commit OID.
    fn commit(repo: &Repository, msg: &str, ts: i64) -> git2::Oid {
        let dir = repo.workdir().unwrap();
        std::fs::write(dir.join("f.txt"), format!("{msg}\n")).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("f.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::new("t", "t@t.co", &Time::new(ts, 0)).unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(h) => vec![h.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs).unwrap()
    }

    fn cleanup(dir: PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_repo_yields_empty_graph() {
        let (repo, dir) = temp_repo();
        let (nodes, edges, _refs, before, after) =
            build_graph(&repo, None, 500, None, None, None).unwrap();
        assert!(nodes.is_empty());
        assert!(edges.is_empty());
        assert_eq!((before, after), (0, 0));
        cleanup(dir);
    }

    #[test]
    fn linear_history_nodes_and_edges() {
        let (repo, dir) = temp_repo();
        commit(&repo, "c1", 1000);
        commit(&repo, "c2", 2000);
        commit(&repo, "c3", 3000);
        let (nodes, edges, _refs, _b, _a) =
            build_graph(&repo, None, 500, None, None, None).unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(edges.len(), 2); // c1->c2, c2->c3
        cleanup(dir);
    }

    #[test]
    fn all_refs_seeded_includes_non_head_branch() {
        let (repo, dir) = temp_repo();
        let base = commit(&repo, "base", 1000);
        // feature branch off base with a unique commit
        let base_commit = repo.find_commit(base).unwrap();
        repo.branch("feature", &base_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        commit(&repo, "feat-only", 2000);
        // back to the original branch (master/main)
        repo.set_head("refs/heads/master")
            .or_else(|_| repo.set_head("refs/heads/main"))
            .unwrap();

        let (nodes, _e, refs, _b, _a) =
            build_graph(&repo, None, 500, None, None, None).unwrap();
        // Seeding from ALL refs should include the feature-only commit.
        let summaries: Vec<&str> = nodes.iter().map(|n| n.summary.as_str()).collect();
        assert!(summaries.contains(&"feat-only"), "expected feat-only, got {summaries:?}");
        assert!(refs.iter().any(|r| r.name == "feature"));
        cleanup(dir);
    }

    #[test]
    fn annotated_and_lightweight_tags_attach_to_commits() {
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        let c2 = commit(&repo, "c2", 2000);
        // lightweight tag on c1
        repo.tag_lightweight("light", &repo.find_object(c1, None).unwrap(), false).unwrap();
        // annotated tag on c2 (its ref target is the tag object, not the commit)
        let sig = Signature::new("t", "t@t.co", &Time::new(2000, 0)).unwrap();
        repo.tag("annot", &repo.find_object(c2, None).unwrap(), &sig, "annotated", false).unwrap();

        let (nodes, _e, refs, _b, _a) =
            build_graph(&repo, None, 500, None, None, None).unwrap();
        let node_ids: std::collections::HashSet<&str> =
            nodes.iter().map(|n| n.oid.as_str()).collect();
        for name in ["light", "annot"] {
            let r = refs.iter().find(|r| r.name == name).expect("tag ref present");
            // Both must peel to a real commit node (annotated tag must NOT point
            // at the tag object).
            assert!(node_ids.contains(r.oid.as_str()), "{name} should attach to a commit node");
        }
        cleanup(dir);
    }

    #[test]
    fn time_window_filters_and_counts() {
        let (repo, dir) = temp_repo();
        for i in 1..=6 {
            commit(&repo, &format!("c{i}"), i as i64 * 1000);
        }
        // window [2500, 4500] -> includes c3(3000), c4(4000)
        let (nodes, _e, _r, before, after) =
            build_graph(&repo, None, 500, Some(2500), Some(4500), None).unwrap();
        let mut summaries: Vec<&str> = nodes.iter().map(|n| n.summary.as_str()).collect();
        summaries.sort();
        assert_eq!(summaries, vec!["c3", "c4"]);
        assert_eq!(before, 2, "c1,c2 older than window"); // older
        assert_eq!(after, 2, "c5,c6 newer than window"); // newer
        cleanup(dir);
    }

    #[test]
    fn ref_scoping_limits_to_selected_branch() {
        let (repo, dir) = temp_repo();
        let base = commit(&repo, "base", 1000);
        let base_commit = repo.find_commit(base).unwrap();
        repo.branch("feature", &base_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        commit(&repo, "feat-only", 2000);
        let main_name = if repo.find_reference("refs/heads/master").is_ok() {
            "master"
        } else {
            "main"
        };
        repo.set_head(&format!("refs/heads/{main_name}")).unwrap();

        // Scope to the main branch only -> feat-only excluded.
        let seed = vec![main_name.to_string()];
        let (nodes, _e, _r, _b, _a) =
            build_graph(&repo, None, 500, None, None, Some(&seed)).unwrap();
        let summaries: Vec<&str> = nodes.iter().map(|n| n.summary.as_str()).collect();
        assert!(summaries.contains(&"base"));
        assert!(!summaries.contains(&"feat-only"), "feature commit should be scoped out");
        cleanup(dir);
    }

    #[test]
    fn dangling_edges_dropped_at_limit() {
        let (repo, dir) = temp_repo();
        for i in 1..=5 {
            commit(&repo, &format!("c{i}"), i as i64 * 1000);
        }
        // limit=2 -> only 2 nodes; the older parent of the 2nd is outside the
        // set, so its edge must be dropped (no edge referencing a missing node).
        let (nodes, edges, _r, _b, _a) =
            build_graph(&repo, None, 2, None, None, None).unwrap();
        assert_eq!(nodes.len(), 2);
        let ids: std::collections::HashSet<&str> = nodes.iter().map(|n| n.oid.as_str()).collect();
        for e in &edges {
            assert!(ids.contains(e.source.as_str()) && ids.contains(e.target.as_str()));
        }
        cleanup(dir);
    }
}
