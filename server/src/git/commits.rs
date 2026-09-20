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
