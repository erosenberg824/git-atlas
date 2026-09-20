use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::{error::ApiResult, state::AppState};

#[derive(Debug, Deserialize)]
pub struct OpenRepoRequest {
    pub path: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub head: Option<String>,
    pub is_bare: bool,
}

/// POST /api/v1/repo — open a repository by path.
pub async fn open_repo(
    State(state): State<AppState>,
    Json(req): Json<OpenRepoRequest>,
) -> ApiResult<Json<RepoInfo>> {
    let path = req.path.clone();
    let info = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        let is_bare = repo.is_bare();
        let head = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_owned));
        Ok::<_, crate::error::AppError>(RepoInfo {
            path: path.to_string_lossy().to_string(),
            head,
            is_bare,
        })
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    state.set_repo_path(req.path.clone()).await;
    let _ = crate::config::save_repo_path(&req.path);
    Ok(Json(info))
}

/// GET /api/v1/repo — return info about the currently open repository.
pub async fn get_repo(State(state): State<AppState>) -> ApiResult<Json<RepoInfo>> {
    let path = state.repo_path().await?;
    let info = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        let is_bare = repo.is_bare();
        let head = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(str::to_owned));
        Ok::<_, crate::error::AppError>(RepoInfo {
            path: path.to_string_lossy().to_string(),
            head,
            is_bare,
        })
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(info))
}

/// GET /api/v1/repo/recent — return the list of recently opened repositories.
pub async fn get_recent_repos() -> ApiResult<Json<Vec<String>>> {
    Ok(Json(crate::config::load_recent_repos()))
}

/// GET /api/v1/status — working-tree status summary (staged/unstaged counts + stashes).
pub async fn get_status(
    State(state): State<AppState>,
) -> ApiResult<Json<crate::git::diff::StatusSummary>> {
    let path = state.repo_path().await?;
    let summary = tokio::task::spawn_blocking(move || {
        let mut repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        crate::git::diff::status_summary(&mut repo)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(summary))
}