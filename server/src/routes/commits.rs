use axum::{
    extract::{Path, State},
    Json,
};

use crate::{
    error::ApiResult,
    git::commits::{CommitDetail, IncludedCommit},
    state::AppState,
};

/// GET /api/v1/commits/:oid — return full details for a single commit.
pub async fn get_commit(
    State(state): State<AppState>,
    Path(oid): Path<String>,
) -> ApiResult<Json<CommitDetail>> {
    let path = state.repo_path().await?;
    let detail = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::commits::get_commit_detail(&repo, &oid)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(detail))
}

/// GET /api/v1/commits/:oid/included — the commits a merge brought in (the
/// merged-in side): `reachable(secondary parents) \ reachable(first parent)`.
/// Empty for a non-merge commit.
pub async fn get_included(
    State(state): State<AppState>,
    Path(oid): Path<String>,
) -> ApiResult<Json<Vec<IncludedCommit>>> {
    let path = state.repo_path().await?;
    let included = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::commits::merge_included_commits(&repo, &oid)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(included))
}
