use crate::error::AppError;
use git2::Repository;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub oid: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Blob,
    Tree,
    Symlink,
    Commit, // submodule
}

#[derive(Debug, Serialize)]
pub struct BlobResponse {
    pub path: String,
    pub content: String,
    pub size: usize,
    pub is_binary: bool,
}

/// List all entries in the tree at the given commit OID, recursively.
pub fn list_tree(repo: &Repository, oid_str: &str) -> Result<Vec<TreeEntry>, AppError> {
    let oid_hex = crate::git::resolve_ref(repo, oid_str)?;
    let oid = git2::Oid::from_str(&oid_hex)
        .map_err(|_| AppError::NotFound(oid_str.to_string()))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|_| AppError::NotFound(format!("commit not found: {oid_str}")))?;

    let tree = commit.tree().map_err(AppError::Git)?;

    let mut entries = Vec::new();

    tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
        let name = match entry.name() {
            Some(n) => n,
            None => return git2::TreeWalkResult::Ok,
        };
        let path = if root.is_empty() {
            name.to_string()
        } else {
            format!("{root}{name}")
        };

        let kind = match entry.kind() {
            Some(git2::ObjectType::Blob) => EntryKind::Blob,
            Some(git2::ObjectType::Tree) => EntryKind::Tree,
            Some(git2::ObjectType::Commit) => EntryKind::Commit,
            _ => EntryKind::Symlink,
        };

        // Only get size for blobs (avoid loading trees)
        let size = if matches!(kind, EntryKind::Blob) {
            repo.find_blob(entry.id()).ok().map(|b| b.size() as u64)
        } else {
            None
        };

        entries.push(TreeEntry {
            path,
            kind,
            size,
            oid: entry.id().to_string(),
        });

        git2::TreeWalkResult::Ok
    })
    .map_err(AppError::Git)?;

    Ok(entries)
}

/// Return the content of a file at a specific commit.
pub fn get_blob_at_commit(
    repo: &Repository,
    oid_str: &str,
    file_path: &str,
) -> Result<BlobResponse, AppError> {
    let oid_hex = crate::git::resolve_ref(repo, oid_str)?;
    let oid = git2::Oid::from_str(&oid_hex)
        .map_err(|_| AppError::NotFound(oid_str.to_string()))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|_| AppError::NotFound(format!("commit not found: {oid_str}")))?;

    let tree = commit.tree().map_err(AppError::Git)?;

    let entry = tree
        .get_path(std::path::Path::new(file_path))
        .map_err(|_| AppError::NotFound(format!("path not found: {file_path}")))?;

    let blob = repo
        .find_blob(entry.id())
        .map_err(|_| AppError::NotFound(format!("blob not found for: {file_path}")))?;

    let size = blob.size();
    let is_binary = blob.is_binary();

    let content = if is_binary {
        String::new()
    } else {
        std::str::from_utf8(blob.content())
            .map(str::to_string)
            .unwrap_or_default()
    };

    Ok(BlobResponse {
        path: file_path.to_string(),
        content,
        size,
        is_binary,
    })
}
