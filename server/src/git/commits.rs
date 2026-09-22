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
}
