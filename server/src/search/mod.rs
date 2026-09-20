use crate::{error::AppError, routes::search::SearchResult, state::AppState};
use std::collections::HashMap;
use std::sync::Arc;
use tantivy::{
    collector::TopDocs,
    query::QueryParser,
    schema::{Schema, Value, STORED, STRING, TEXT},
    Index, TantivyDocument,
};
use tokio::sync::Mutex;

/// Cache of in-memory tantivy indexes keyed by commit OID.
/// Each index is built on demand and cached for the lifetime of the server.
pub type IndexCache = Arc<Mutex<HashMap<String, Index>>>;

pub fn new_index_cache() -> IndexCache {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Build a tantivy schema for file content indexing.
fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("path", STRING | STORED);
    builder.add_text_field("content", TEXT | STORED);
    builder.build()
}

/// Build (or rebuild) a tantivy index for all text files at the given commit.
/// Git operations run in a blocking context; the resulting index is stored in cache.
pub async fn build_index_for_commit(
    state: &AppState,
    commit_oid: &str,
) -> Result<(), AppError> {
    let repo_path = state.repo_path().await?;
    let commit_oid = commit_oid.to_string();

    // Run all git + tantivy work in a blocking thread (git2 is !Send)
    let commit_oid_clone = commit_oid.clone();
    let index = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&repo_path).map_err(AppError::Git)?;

        let schema = build_schema();
        let index = Index::create_in_ram(schema.clone());
        let mut writer = index
            .writer(50_000_000)
            .map_err(|e| AppError::Search(e.to_string()))?;

        let path_field = schema.get_field("path").unwrap();
        let content_field = schema.get_field("content").unwrap();

        let oid = git2::Oid::from_str(&commit_oid_clone)
            .map_err(|_| AppError::NotFound(format!("commit not found: {commit_oid_clone}")))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|_| AppError::NotFound(format!("commit not found: {commit_oid_clone}")))?;
        let tree = commit.tree().map_err(AppError::Git)?;

        let mut indexed = 0usize;
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() != Some(git2::ObjectType::Blob) {
                return git2::TreeWalkResult::Ok;
            }
            let name = match entry.name() {
                Some(n) => n,
                None => return git2::TreeWalkResult::Ok,
            };
            let path = if root.is_empty() {
                name.to_string()
            } else {
                format!("{root}{name}")
            };

            if let Ok(blob) = repo.find_blob(entry.id()) {
                if !blob.is_binary() {
                    if let Ok(text) = std::str::from_utf8(blob.content()) {
                        let mut doc = TantivyDocument::default();
                        doc.add_text(path_field, &path);
                        doc.add_text(content_field, text);
                        let _ = writer.add_document(doc);
                        indexed += 1;
                    }
                }
            }
            git2::TreeWalkResult::Ok
        })
        .map_err(AppError::Git)?;

        writer
            .commit()
            .map_err(|e| AppError::Search(e.to_string()))?;

        tracing::info!(
            "Indexed {} files for commit {}",
            indexed,
            &commit_oid_clone[..8.min(commit_oid_clone.len())]
        );

        Ok::<Index, AppError>(index)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))??;

    state
        .inner
        .index_cache
        .lock()
        .await
        .insert(commit_oid, index);

    Ok(())
}

/// Query the tantivy index for the given commit. Builds the index if not cached.
pub async fn query_index(
    state: &AppState,
    commit_oid: &str,
    query_str: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, AppError> {
    // Auto-build index if missing
    {
        let cache = state.inner.index_cache.lock().await;
        if !cache.contains_key(commit_oid) {
            drop(cache);
            build_index_for_commit(state, commit_oid).await?;
        }
    }

    let cache = state.inner.index_cache.lock().await;
    let index = cache
        .get(commit_oid)
        .ok_or_else(|| AppError::Search("index not found after build".into()))?;

    let schema = index.schema();
    let path_field = schema.get_field("path").unwrap();
    let content_field = schema.get_field("content").unwrap();

    let reader = index
        .reader()
        .map_err(|e| AppError::Search(e.to_string()))?;
    let searcher = reader.searcher();

    let query_parser = QueryParser::for_index(index, vec![content_field, path_field]);
    let query = query_parser
        .parse_query(query_str)
        .map_err(|e| AppError::Search(e.to_string()))?;

    let top_docs = searcher
        .search(&query, &TopDocs::with_limit(limit))
        .map_err(|e| AppError::Search(e.to_string()))?;

    let mut results = Vec::new();
    for (score, doc_address) in top_docs {
        let doc = searcher
            .doc::<TantivyDocument>(doc_address)
            .map_err(|e| AppError::Search(e.to_string()))?;

        let path = doc
            .get_first(path_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let content = doc
            .get_first(content_field)
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let snippets = extract_snippets(content, query_str, 2);

        results.push(SearchResult { path, score, snippets });
    }

    Ok(results)
}

/// Extract up to `count` short context snippets from content around query terms.
fn extract_snippets(content: &str, query: &str, count: usize) -> Vec<String> {
    let query_lower = query.to_lowercase();
    let content_lower = content.to_lowercase();

    let first_term = query_lower
        .split_whitespace()
        .find(|t| !t.starts_with('+') && !t.starts_with('-'))
        .unwrap_or(&query_lower);

    let mut snippets = Vec::new();
    let mut search_from = 0;

    while snippets.len() < count {
        match content_lower[search_from..].find(first_term) {
            None => break,
            Some(rel_pos) => {
                let pos = search_from + rel_pos;
                let start = content[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let end = content[pos..].find('\n').map(|i| pos + i).unwrap_or(content.len());
                snippets.push(content[start..end].trim().to_string());
                search_from = end + 1;
                if search_from >= content.len() {
                    break;
                }
            }
        }
    }

    snippets
}
