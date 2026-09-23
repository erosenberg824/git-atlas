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
    /// For local branches: the short name of the configured upstream
    /// (remote-tracking) branch, e.g. `origin/main`. `None` for remotes/tags or
    /// when the local branch has no upstream configured. Lets the client pair a
    /// local branch with its remote counterpart in the branch picker.
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Branch,
    RemoteBranch,
    Tag,
    Head,
}

/// Result of a graph walk: the windowed nodes/edges plus the ref labels and the
/// counts of visible commits that were NOT returned as nodes, so the UI can show
/// an accurate total without holding the whole history.
pub struct GraphData {
    pub nodes: Vec<CommitNode>,
    pub edges: Vec<CommitEdge>,
    pub refs: Vec<RefLabel>,
    /// Visible-branch commits OLDER than the window's `since` (hidden below).
    pub before_count: usize,
    /// Visible-branch commits NEWER than the window's `until` (hidden above).
    pub after_count: usize,
    /// In-window commits dropped because the node `limit` was reached. Non-zero
    /// even with no time filter — this is what makes the "N commits" total
    /// correct on a full-history view that exceeds `limit`.
    pub hidden_count: usize,
}

/// Build a commit graph starting from `start` (ref or OID), limited to `limit` commits.
pub fn build_graph(
    repo: &Repository,
    start: Option<&str>,
    limit: usize,
    since: Option<i64>,
    until: Option<i64>,
    seed_refs: Option<&[String]>,
) -> Result<GraphData, AppError> {
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
            return Ok(GraphData {
                nodes: Vec::new(),
                edges: Vec::new(),
                refs,
                before_count: 0,
                after_count: 0,
                hidden_count: 0,
            });
        }
    } else {
        // A repository with no commits has an unborn HEAD (e.g. refs/heads/main
        // that doesn't exist yet). push_head() would fail with a Reference error,
        // so treat this as a valid-but-empty graph rather than an error.
        if repo.is_empty().unwrap_or(false) || repo.head().is_err() {
            let refs = collect_refs(repo)?;
            return Ok(GraphData {
                nodes: Vec::new(),
                edges: Vec::new(),
                refs,
                before_count: 0,
                after_count: 0,
                hidden_count: 0,
            });
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

    // Counts of visible (seeded) commits NOT returned as nodes, so the UI can
    // show an accurate total without holding the whole history:
    //   before = older than `since`, after = newer than `until`,
    //   hidden  = in-window but past the node `limit`.
    // Tallied over the full walk (independent of the node limit).
    let mut before_count = 0usize;
    let mut after_count = 0usize;
    let mut hidden_count = 0usize;
    let mut node_budget_left = limit > 0;

    // Whether any time window is active. When there is none, a commit past the
    // node budget needs no timestamp classification — it is unconditionally an
    // in-window "hidden" commit — so we can count it WITHOUT the expensive
    // `find_commit` object decode. This is the hot path for a full-history view
    // of a large repo (walk stays O(n) in revwalk steps, but avoids n object
    // inflations once the window is full).
    let windowed = since.is_some() || until.is_some();

    for oid_result in revwalk {
        let oid = oid_result.map_err(AppError::Git)?;
        if !seen.insert(oid) {
            continue;
        }

        // Fast path: budget exhausted and no time filter — every remaining
        // commit is a hidden in-window commit. Count it and skip the decode.
        if !node_budget_left && !windowed {
            hidden_count += 1;
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

        // In-window commit: build a node until the limit is reached. Past the
        // limit we keep walking to finish tallying before/after/hidden counts.
        if !node_budget_left {
            hidden_count += 1; // in-window but beyond the node budget
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
    Ok(GraphData {
        nodes,
        edges,
        refs,
        before_count,
        after_count,
        hidden_count,
    })
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
                upstream: None,
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

        // For local branches, resolve the configured upstream (tracking) branch
        // so the client can pair local↔remote branches in the picker.
        let upstream = if kind == RefKind::Branch {
            repo.find_branch(&short_name, git2::BranchType::Local)
                .and_then(|b| b.upstream())
                .ok()
                .and_then(|u| u.name().ok().flatten().map(str::to_owned))
        } else {
            None
        };

        labels.push(RefLabel {
            name: short_name,
            oid: target_oid.to_string(),
            kind,
            is_head,
            tip_ts,
            upstream,
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
        let g = build_graph(&repo, None, 500, None, None, None).unwrap();
        assert!(g.nodes.is_empty());
        assert!(g.edges.is_empty());
        assert_eq!((g.before_count, g.after_count, g.hidden_count), (0, 0, 0));
        cleanup(dir);
    }

    #[test]
    fn linear_history_nodes_and_edges() {
        let (repo, dir) = temp_repo();
        commit(&repo, "c1", 1000);
        commit(&repo, "c2", 2000);
        commit(&repo, "c3", 3000);
        let g = build_graph(&repo, None, 500, None, None, None).unwrap();
        assert_eq!(g.nodes.len(), 3);
        assert_eq!(g.edges.len(), 2); // c1->c2, c2->c3
        assert_eq!(g.hidden_count, 0);
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

        let g = build_graph(&repo, None, 500, None, None, None).unwrap();
        // Seeding from ALL refs should include the feature-only commit.
        let summaries: Vec<&str> = g.nodes.iter().map(|n| n.summary.as_str()).collect();
        assert!(summaries.contains(&"feat-only"), "expected feat-only, got {summaries:?}");
        assert!(g.refs.iter().any(|r| r.name == "feature"));
        cleanup(dir);
    }

    #[test]
    fn local_branch_exposes_configured_upstream() {
        let (repo, dir) = temp_repo();
        let base = commit(&repo, "base", 1000);
        let base_commit = repo.find_commit(base).unwrap();

        // Simulate a remote-tracking branch: configure an `origin` remote, then
        // create refs/remotes/origin/master and set it as the local upstream.
        repo.remote("origin", "https://example.invalid/repo.git").unwrap();
        repo.reference(
            "refs/remotes/origin/master",
            base,
            true,
            "seed remote",
        )
        .unwrap();
        let mut local = repo
            .find_branch("master", git2::BranchType::Local)
            .or_else(|_| repo.find_branch("main", git2::BranchType::Local))
            .unwrap();
        let local_name = local.name().unwrap().unwrap().to_string();
        // Point the remote-tracking ref at the local branch's actual name so the
        // upstream (origin/<name>) exists regardless of default branch naming.
        repo.reference(
            &format!("refs/remotes/origin/{local_name}"),
            base,
            true,
            "seed remote",
        )
        .unwrap();
        local.set_upstream(Some(&format!("origin/{local_name}"))).unwrap();

        // A second local branch WITHOUT any upstream configured.
        repo.branch("feature", &base_commit, false).unwrap();

        let g = build_graph(&repo, None, 500, None, None, None).unwrap();

        let tracked = g.refs.iter().find(|r| r.name == local_name).unwrap();
        assert_eq!(tracked.upstream.as_deref(), Some(format!("origin/{local_name}").as_str()));

        let untracked = g.refs.iter().find(|r| r.name == "feature").unwrap();
        assert_eq!(untracked.upstream, None);

        // Remote branches never carry an upstream of their own.
        let remote = g.refs.iter().find(|r| r.kind == RefKind::RemoteBranch).unwrap();
        assert_eq!(remote.upstream, None);

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

        let g = build_graph(&repo, None, 500, None, None, None).unwrap();
        let node_ids: std::collections::HashSet<&str> =
            g.nodes.iter().map(|n| n.oid.as_str()).collect();
        for name in ["light", "annot"] {
            let r = g.refs.iter().find(|r| r.name == name).expect("tag ref present");
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
        let g = build_graph(&repo, None, 500, Some(2500), Some(4500), None).unwrap();
        let mut summaries: Vec<&str> = g.nodes.iter().map(|n| n.summary.as_str()).collect();
        summaries.sort();
        assert_eq!(summaries, vec!["c3", "c4"]);
        assert_eq!(g.before_count, 2, "c1,c2 older than window"); // older
        assert_eq!(g.after_count, 2, "c5,c6 newer than window"); // newer
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
        let g = build_graph(&repo, None, 500, None, None, Some(&seed)).unwrap();
        let summaries: Vec<&str> = g.nodes.iter().map(|n| n.summary.as_str()).collect();
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
        let g = build_graph(&repo, None, 2, None, None, None).unwrap();
        let (nodes, edges) = (g.nodes, g.edges);
        assert_eq!(nodes.len(), 2);
        let ids: std::collections::HashSet<&str> = nodes.iter().map(|n| n.oid.as_str()).collect();
        for e in &edges {
            assert!(ids.contains(e.source.as_str()) && ids.contains(e.target.as_str()));
        }
        cleanup(dir);
    }

    #[test]
    fn hidden_count_reports_commits_dropped_by_limit() {
        let (repo, dir) = temp_repo();
        for i in 1..=10 {
            commit(&repo, &format!("c{i}"), i as i64 * 1000);
        }
        // No time window, limit=4: 4 nodes returned, 6 in-window commits hidden
        // by the limit. This is the full-history case the old code reported as
        // "500" (hidden_count was never tallied). before/after stay 0 since
        // there's no window.
        let g = build_graph(&repo, None, 4, None, None, None).unwrap();
        assert_eq!(g.nodes.len(), 4);
        assert_eq!(g.hidden_count, 6, "6 commits beyond the limit");
        assert_eq!((g.before_count, g.after_count), (0, 0));
        // The reconstructed total matches the real commit count.
        assert_eq!(
            g.nodes.len() + g.before_count + g.after_count + g.hidden_count,
            10
        );
        cleanup(dir);
    }

    #[test]
    fn hidden_count_alongside_time_window() {
        let (repo, dir) = temp_repo();
        for i in 1..=10 {
            commit(&repo, &format!("c{i}"), i as i64 * 1000);
        }
        // window [2500, 8500] includes c3..c8 (6 commits); limit=2 shows 2 and
        // hides 4 in-window. c1,c2 are before; c9,c10 are after.
        let g = build_graph(&repo, None, 2, Some(2500), Some(8500), None).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.before_count, 2, "c1,c2");
        assert_eq!(g.after_count, 2, "c9,c10");
        assert_eq!(g.hidden_count, 4, "in-window commits past the limit");
        cleanup(dir);
    }
}
