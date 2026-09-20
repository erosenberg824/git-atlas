use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{error::ApiResult, state::AppState};

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    /// The search query string.
    pub q: String,
    /// Commit OID to search at (defaults to HEAD).
    pub commit: Option<String>,
    /// Maximum number of results (default: 50).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct IndexRequest {
    /// Commit OID to index (defaults to HEAD).
    pub commit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub score: f32,
    pub snippets: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub commit_oid: String,
    pub results: Vec<SearchResult>,
}

/// GET /api/v1/search?q=...&commit=OID — full-text search at a commit.
pub async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<SearchResponse>> {
    // Resolve the commit OID in a blocking context (git2 is !Send)
    let state_clone = state.clone();
    let commit_ref = query.commit.clone().unwrap_or_else(|| "HEAD".to_string());
    let commit_oid = tokio::task::spawn_blocking(move || {
        let guard = state_clone.inner.repo_path.blocking_read();
        let path = guard.as_ref().ok_or_else(|| {
            crate::error::AppError::BadRequest("No repository is open.".into())
        })?;
        let repo = git2::Repository::open(path).map_err(crate::error::AppError::Git)?;
        crate::git::resolve_ref(&repo, &commit_ref)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    let limit = query.limit.unwrap_or(50);
    let results = crate::search::query_index(&state, &commit_oid, &query.q, limit).await?;

    Ok(Json(SearchResponse {
        query: query.q,
        commit_oid,
        results,
    }))
}

/// POST /api/v1/search/index — build (or rebuild) the search index for a commit.
pub async fn build_index(
    State(state): State<AppState>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let state_clone = state.clone();
    let commit_ref = req.commit.clone().unwrap_or_else(|| "HEAD".to_string());

    // Resolve ref and build index in blocking thread
    let commit_oid = tokio::task::spawn_blocking(move || {
        let guard = state_clone.inner.repo_path.blocking_read();
        let path = guard.as_ref().ok_or_else(|| {
            crate::error::AppError::BadRequest("No repository is open.".into())
        })?;
        let repo = git2::Repository::open(path).map_err(crate::error::AppError::Git)?;
        crate::git::resolve_ref(&repo, &commit_ref)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    crate::search::build_index_for_commit(&state, &commit_oid).await?;

    Ok(Json(serde_json::json!({
        "status": "ok",
        "commit_oid": commit_oid,
    })))
}
