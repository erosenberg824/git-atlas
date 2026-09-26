use crate::error::AppError;
use git2::Repository;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub message: String,
    pub author: Signature,
    pub committer: Signature,
    pub parents: Vec<String>,
    pub tree_oid: String,
}

#[derive(Debug, Serialize)]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub timestamp: i64,
}

/// One commit brought in by a merge (a member of the merged-in side). A compact
/// shape (not the full `CommitDetail`) — enough for the "Included N commits"
/// list in the commit panel to show and link each entry.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct IncludedCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub timestamp: i64,
}

pub fn get_commit_detail(repo: &Repository, oid_str: &str) -> Result<CommitDetail, AppError> {
    let oid = git2::Oid::from_str(oid_str)
        .or_else(|_| repo.revparse_single(oid_str).map(|o| o.id()))
        .map_err(|_| AppError::NotFound(format!("commit not found: {oid_str}")))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|_| AppError::NotFound(format!("commit not found: {oid_str}")))?;

    let short_oid = oid.to_string()[..8].to_string();

    let author = Signature {
        name: commit.author().name().unwrap_or("").to_string(),
        email: commit.author().email().unwrap_or("").to_string(),
        timestamp: commit.author().when().seconds(),
    };

    let committer = Signature {
        name: commit.committer().name().unwrap_or("").to_string(),
        email: commit.committer().email().unwrap_or("").to_string(),
        timestamp: commit.committer().when().seconds(),
    };

    let parents = commit.parent_ids().map(|p| p.to_string()).collect();

    Ok(CommitDetail {
        oid: oid.to_string(),
        short_oid,
        message: commit.message().unwrap_or("").to_string(),
        author,
        committer,
        parents,
        tree_oid: commit.tree_id().to_string(),
    })
}

/// The commits a merge brought in — the "merged-in side(s)" of the merge.
///
/// Defined exactly as `reachable(secondary parents) \ reachable(first parent)`:
/// we revwalk from every parent EXCEPT the first (the mainline / trunk side the
/// merge was made ONTO) and HIDE everything reachable from the first parent.
/// What remains is precisely the set of commits unique to the branch(es) that
/// were merged in — window-independent (a real git revwalk, not bounded by the
/// loaded graph window), and correct for octopus merges (all parents ≥ 1 are
/// pushed). The merge commit itself is not included.
///
/// Returns an empty vec for a non-merge commit (< 2 parents) — there is no
/// merged-in side to report. Ordered newest-first (TIME sort).
pub fn merge_included_commits(
    repo: &Repository,
    oid_str: &str,
) -> Result<Vec<IncludedCommit>, AppError> {
    let oid = git2::Oid::from_str(oid_str)
        .or_else(|_| repo.revparse_single(oid_str).map(|o| o.id()))
        .map_err(|_| AppError::NotFound(format!("commit not found: {oid_str}")))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|_| AppError::NotFound(format!("commit not found: {oid_str}")))?;

    let parents: Vec<git2::Oid> = commit.parent_ids().collect();
    // Not a merge → nothing was merged in.
    if parents.len() < 2 {
        return Ok(Vec::new());
    }

    let mut revwalk = repo.revwalk().map_err(AppError::Git)?;
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(AppError::Git)?;
    // Push each merged-in (secondary) parent; hide the first-parent side so only
    // the commits UNIQUE to the merged-in branch(es) remain.
    for p in &parents[1..] {
        revwalk.push(*p).map_err(AppError::Git)?;
    }
    revwalk.hide(parents[0]).map_err(AppError::Git)?;

    let mut included = Vec::new();
    for oid_result in revwalk {
        let oid = oid_result.map_err(AppError::Git)?;
        let c = repo.find_commit(oid).map_err(AppError::Git)?;
        included.push(IncludedCommit {
            oid: oid.to_string(),
            short_oid: oid.to_string()[..8].to_string(),
            summary: c.summary().unwrap_or("").to_string(),
            author_name: c.author().name().unwrap_or("").to_string(),
            timestamp: c.time().seconds(),
        });
    }
    Ok(included)
}


#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Time};
    use std::path::PathBuf;

    fn temp_repo() -> (Repository, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "git-atlas-commits-test-{}-{}",
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

    /// Commit a file with an explicit author signature + timestamp.
    fn commit(repo: &Repository, msg: &str, ts: i64) -> git2::Oid {
        let dir = repo.workdir().unwrap();
        std::fs::write(dir.join("f.txt"), format!("{msg}\n")).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("f.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::new("Ada", "ada@example.com", &Time::new(ts, 0)).unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(h) => vec![h.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    #[test]
    fn detail_reports_signature_message_and_tree() {
        let (repo, dir) = temp_repo();
        let oid = commit(&repo, "first commit\n\nbody", 1234);

        let detail = get_commit_detail(&repo, &oid.to_string()).unwrap();
        assert_eq!(detail.oid, oid.to_string());
        assert_eq!(detail.short_oid, oid.to_string()[..8]);
        assert_eq!(detail.message, "first commit\n\nbody");
        assert_eq!(detail.author.name, "Ada");
        assert_eq!(detail.author.email, "ada@example.com");
        assert_eq!(detail.author.timestamp, 1234);
        assert_eq!(detail.committer.timestamp, 1234);
        assert!(detail.parents.is_empty());
        assert!(!detail.tree_oid.is_empty());
        cleanup(dir);
    }

    #[test]
    fn detail_lists_parent_oids() {
        let (repo, dir) = temp_repo();
        let c1 = commit(&repo, "c1", 1000);
        let c2 = commit(&repo, "c2", 2000);

        let detail = get_commit_detail(&repo, &c2.to_string()).unwrap();
        assert_eq!(detail.parents, vec![c1.to_string()]);
        cleanup(dir);
    }

    #[test]
    fn detail_resolves_by_ref_name() {
        let (repo, dir) = temp_repo();
        let oid = commit(&repo, "c1", 1000);
        let detail = get_commit_detail(&repo, "HEAD").unwrap();
        assert_eq!(detail.oid, oid.to_string());
        cleanup(dir);
    }

    #[test]
    fn detail_reports_missing_commit() {
        let (repo, dir) = temp_repo();
        commit(&repo, "c1", 1000);
        let err = get_commit_detail(&repo, "not-a-real-ref").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(dir);
    }

    /// Create a merge commit of `parents` (first = mainline) with a fixed ts.
    fn merge_commit(repo: &Repository, msg: &str, ts: i64, parents: &[git2::Oid]) -> git2::Oid {
        let sig = git2::Signature::new("Ada", "ada@example.com", &Time::new(ts, 0)).unwrap();
        let commits: Vec<git2::Commit> =
            parents.iter().map(|p| repo.find_commit(*p).unwrap()).collect();
        let refs: Vec<&git2::Commit> = commits.iter().collect();
        // Use the first parent's tree (content merge is irrelevant to topology tests).
        let tree = refs[0].tree().unwrap();
        // `None` (don't move any ref): the current HEAD need not be the first
        // parent, which lets a test merge arbitrary commits by oid.
        repo.commit(None, &sig, &sig, msg, &tree, &refs).unwrap()
    }

    #[test]
    fn included_is_empty_for_a_non_merge() {
        let (repo, dir) = temp_repo();
        let c = commit(&repo, "solo", 1000);
        let included = merge_included_commits(&repo, &c.to_string()).unwrap();
        assert!(included.is_empty());
        cleanup(dir);
    }

    #[test]
    fn included_lists_only_the_merged_in_side() {
        let (repo, dir) = temp_repo();
        // base -> m1 (mainline). feature forks at base: f1, f2.
        let base = commit(&repo, "base", 1000);
        let m1 = commit(&repo, "m1", 2000);

        // Build the feature branch off base.
        repo.branch("feature", &repo.find_commit(base).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        let f1 = commit(&repo, "f1", 3000);
        let f2 = commit(&repo, "f2", 4000);

        // Merge feature (f2) into mainline (m1): parents = [m1, f2].
        let merge = merge_commit(&repo, "Merge feature", 5000, &[m1, f2]);

        let included = merge_included_commits(&repo, &merge.to_string()).unwrap();
        let oids: Vec<&str> = included.iter().map(|c| c.oid.as_str()).collect();
        let f1s = f1.to_string();
        let f2s = f2.to_string();
        // Only the feature-side commits are included, newest-first.
        assert_eq!(oids, vec![f2s.as_str(), f1s.as_str()]);
        // Mainline commits (base, m1) and the merge itself are NOT included.
        assert!(!oids.contains(&base.to_string().as_str()));
        assert!(!oids.contains(&m1.to_string().as_str()));
        assert!(!oids.contains(&merge.to_string().as_str()));
        // Compact fields populated.
        assert_eq!(included[0].summary, "f2");
        assert_eq!(included[0].author_name, "Ada");
        assert_eq!(included[0].timestamp, 4000);
        assert_eq!(included[0].short_oid, f2s[..8]);
        cleanup(dir);
    }

    #[test]
    fn included_excludes_commits_shared_with_mainline() {
        let (repo, dir) = temp_repo();
        // base -> shared -> m1 mainline; feature forks at `shared`.
        let base = commit(&repo, "base", 1000);
        let shared = commit(&repo, "shared", 2000);
        let m1 = commit(&repo, "m1", 3000);

        repo.branch("feature", &repo.find_commit(shared).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        let f1 = commit(&repo, "f1", 4000);

        let merge = merge_commit(&repo, "Merge feature", 5000, &[m1, f1]);
        let included = merge_included_commits(&repo, &merge.to_string()).unwrap();
        let oids: Vec<String> = included.iter().map(|c| c.oid.clone()).collect();
        // Only f1 is unique to the feature side; `shared`/`base`/`m1` are hidden
        // by the first-parent side.
        assert_eq!(oids, vec![f1.to_string()]);
        assert!(!oids.contains(&shared.to_string()));
        let _ = base;
        cleanup(dir);
    }

    #[test]
    fn included_reports_missing_commit() {
        let (repo, dir) = temp_repo();
        commit(&repo, "c1", 1000);
        let err = merge_included_commits(&repo, "not-a-real-ref").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(dir);
    }
}
