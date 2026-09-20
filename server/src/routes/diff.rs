use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;

use crate::{error::ApiResult, git::diff::DiffResponse, state::AppState};

#[derive(Debug, Deserialize)]
pub struct ArbitraryDiffQuery {
    /// Base commit OID.
    pub base: String,
    /// Target commit OID.
    pub target: String,
    /// Optional path filter.
    pub path: Option<String>,
}

/// GET /api/v1/diff/:oid — diff a commit against its first parent.
pub async fn get_commit_diff(
    State(state): State<AppState>,
    Path(oid): Path<String>,
) -> ApiResult<Json<DiffResponse>> {
    let path = state.repo_path().await?;
    let result = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::diff::diff_commit_vs_parent(&repo, &oid)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(result))
}

/// GET /api/v1/diff?base=OID&target=OID — diff two arbitrary commits.
pub async fn get_arbitrary_diff(
    State(state): State<AppState>,
    Query(query): Query<ArbitraryDiffQuery>,
) -> ApiResult<Json<DiffResponse>> {
    let path = state.repo_path().await?;
    let result = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::diff::diff_two_commits(&repo, &query.base, &query.target, query.path.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(result))
}

/// GET /api/v1/diff/working — unstaged changes (index → working dir, untracked included).
pub async fn get_working_diff(
    State(state): State<AppState>,
) -> ApiResult<Json<DiffResponse>> {
    let path = state.repo_path().await?;
    let result = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::diff::diff_working(&repo)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(result))
}

/// GET /api/v1/diff/staged — staged changes (HEAD tree → index).
pub async fn get_staged_diff(
    State(state): State<AppState>,
) -> ApiResult<Json<DiffResponse>> {
    let path = state.repo_path().await?;
    let result = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::diff::diff_staged(&repo)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(result))
}

/// GET /api/v1/diff/stash/:index — diff a stash entry against its base.
pub async fn get_stash_diff(
    State(state): State<AppState>,
    Path(index): Path<usize>,
) -> ApiResult<Json<DiffResponse>> {
    let path = state.repo_path().await?;
    let result = tokio::task::spawn_blocking(move || {
        let mut repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::diff::diff_stash(&mut repo, index)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(result))
}
