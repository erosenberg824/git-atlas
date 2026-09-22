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


#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature, Time};
    use std::path::PathBuf;

    fn temp_repo() -> (Repository, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "git-atlas-tree-test-{}-{}",
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

    fn write_file(repo: &Repository, rel: &str, contents: &[u8]) {
        let path = repo.workdir().unwrap().join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    /// Stage everything and commit with a fixed timestamp; returns the OID.
    fn commit_all(repo: &Repository, msg: &str, ts: i64) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
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

    fn find<'a>(entries: &'a [TreeEntry], path: &str) -> &'a TreeEntry {
        entries
            .iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("expected entry {path}, got {entries:?}"))
    }

    #[test]
    fn list_tree_returns_nested_paths_with_forward_slashes() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "README.md", b"top\n");
        write_file(&repo, "src/main.rs", b"fn main() {}\n");
        write_file(&repo, "src/lib/util.rs", b"pub fn u() {}\n");
        let c = commit_all(&repo, "init", 1000);

        let entries = list_tree(&repo, &c.to_string()).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"README.md"), "got {paths:?}");
        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(paths.contains(&"src/lib"));
        assert!(paths.contains(&"src/lib/util.rs"));
        cleanup(dir);
    }

    #[test]
    fn blobs_have_sizes_and_directories_do_not() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "src/main.rs", b"12345"); // 5 bytes
        let c = commit_all(&repo, "init", 1000);

        let entries = list_tree(&repo, &c.to_string()).unwrap();
        let file = find(&entries, "src/main.rs");
        assert!(matches!(file.kind, EntryKind::Blob));
        assert_eq!(file.size, Some(5));

        let subdir = find(&entries, "src");
        assert!(matches!(subdir.kind, EntryKind::Tree));
        assert_eq!(subdir.size, None);
        cleanup(dir);
    }

    #[test]
    fn list_tree_reports_missing_commit() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", b"x\n");
        commit_all(&repo, "init", 1000);

        let err = list_tree(&repo, "0123456789012345678901234567890123456789").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(dir);
    }

    #[test]
    fn get_blob_returns_text_content() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "src/hello.txt", b"hello world\n");
        let c = commit_all(&repo, "init", 1000);

        let blob = get_blob_at_commit(&repo, &c.to_string(), "src/hello.txt").unwrap();
        assert_eq!(blob.path, "src/hello.txt");
        assert_eq!(blob.content, "hello world\n");
        assert_eq!(blob.size, 12);
        assert!(!blob.is_binary);
        cleanup(dir);
    }

    #[test]
    fn get_blob_marks_binary_and_empties_content() {
        let (repo, dir) = temp_repo();
        // NUL byte forces libgit2 to classify the blob as binary.
        write_file(&repo, "data.bin", &[0u8, 1, 2, 3, 0, 255]);
        let c = commit_all(&repo, "init", 1000);

        let blob = get_blob_at_commit(&repo, &c.to_string(), "data.bin").unwrap();
        assert!(blob.is_binary);
        assert_eq!(blob.content, "");
        assert_eq!(blob.size, 6);
        cleanup(dir);
    }

    #[test]
    fn get_blob_reports_missing_path() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", b"x\n");
        let c = commit_all(&repo, "init", 1000);

        let err = get_blob_at_commit(&repo, &c.to_string(), "nope.txt").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(dir);
    }

    #[test]
    fn resolve_by_ref_name_works() {
        let (repo, dir) = temp_repo();
        write_file(&repo, "a.txt", b"x\n");
        commit_all(&repo, "init", 1000);

        // HEAD should resolve via resolve_ref just like a raw OID.
        let entries = list_tree(&repo, "HEAD").unwrap();
        assert!(entries.iter().any(|e| e.path == "a.txt"));
        cleanup(dir);
    }
}
