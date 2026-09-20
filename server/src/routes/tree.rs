use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{error::ApiResult, git::tree::{BlobResponse, TreeEntry}, state::AppState};

#[derive(Debug, Deserialize)]
pub struct BlobQuery {
    /// Path to the file within the tree.
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct TreeResponse {
    pub commit_oid: String,
    pub entries: Vec<TreeEntry>,
}

/// GET /api/v1/tree/:oid — list all files in the repository at a given commit.
pub async fn get_tree(
    State(state): State<AppState>,
    Path(oid): Path<String>,
) -> ApiResult<Json<TreeResponse>> {
    let repo_path = state.repo_path().await?;
    let oid_clone = oid.clone();
    let entries = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&repo_path).map_err(crate::error::AppError::Git)?;
        crate::git::tree::list_tree(&repo, &oid_clone)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(TreeResponse { commit_oid: oid, entries }))
}

/// GET /api/v1/tree/:oid/blob?path=... — get file contents at a given commit.
pub async fn get_blob(
    State(state): State<AppState>,
    Path(oid): Path<String>,
    Query(query): Query<BlobQuery>,
) -> ApiResult<Json<BlobResponse>> {
    let repo_path = state.repo_path().await?;
    let result = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&repo_path).map_err(crate::error::AppError::Git)?;
        crate::git::tree::get_blob_at_commit(&repo, &oid, &query.path)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(result))
}
