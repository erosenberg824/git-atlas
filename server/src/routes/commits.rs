use axum::{
    extract::{Path, State},
    Json,
};

use crate::{error::ApiResult, git::commits::CommitDetail, state::AppState};

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
