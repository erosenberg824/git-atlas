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
) -> Result<(Vec<CommitNode>, Vec<CommitEdge>, Vec<RefLabel>), AppError> {
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
    } else {
        // A repository with no commits has an unborn HEAD (e.g. refs/heads/main
        // that doesn't exist yet). push_head() would fail with a Reference error,
        // so treat this as a valid-but-empty graph rather than an error.
        if repo.is_empty().unwrap_or(false) || repo.head().is_err() {
            let refs = collect_refs(repo)?;
            return Ok((Vec::new(), Vec::new(), refs));
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

    for (i, oid_result) in revwalk.enumerate() {
        if i >= limit {
            break;
        }
        let oid = oid_result.map_err(AppError::Git)?;
        if !seen.insert(oid) {
            continue;
        }

        let commit = repo.find_commit(oid).map_err(AppError::Git)?;
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
    }

    // Drop edges whose endpoints aren't both in the returned node set. With a
    // `limit`, a commit near the cutoff can have a parent that falls outside the
    // window; emitting that edge would reference a non-existent node and break
    // client-side rendering (React Flow throws on edges to unknown nodes).
    let node_ids: std::collections::HashSet<&str> =
        nodes.iter().map(|n| n.oid.as_str()).collect();
    edges.retain(|e| node_ids.contains(e.source.as_str()) && node_ids.contains(e.target.as_str()));

    let refs = collect_refs(repo)?;
    Ok((nodes, edges, refs))
}

/// Collect all local branches, remote branches, and tags with their target OIDs.
fn collect_refs(repo: &Repository) -> Result<Vec<RefLabel>, AppError> {
    let mut labels = Vec::new();

    // HEAD
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            labels.push(RefLabel {
                name: "HEAD".into(),
                oid: target.to_string(),
                kind: RefKind::Head,
                is_head: true,
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
        let target_oid = match reference.peel_to_commit() {
            Ok(commit) => commit.id(),
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
        });
    }

    Ok(labels)
}
