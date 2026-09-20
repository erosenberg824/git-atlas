use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{error::ApiResult, git::graph as git_graph, state::AppState};

#[derive(Debug, Deserialize)]
pub struct GraphQuery {
    /// Max number of commits to return (default: 500).
    pub limit: Option<usize>,
    /// Start walking from this ref/oid (default: HEAD).
    pub start: Option<String>,
    /// Only include commits with time >= since (unix seconds).
    pub since: Option<i64>,
    /// Only include commits with time <= until (unix seconds).
    pub until: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct GraphResponse {
    pub nodes: Vec<git_graph::CommitNode>,
    pub edges: Vec<git_graph::CommitEdge>,
    pub refs: Vec<git_graph::RefLabel>,
}

/// GET /api/v1/graph — return the commit DAG as nodes and edges.
pub async fn get_graph(
    State(state): State<AppState>,
    Query(query): Query<GraphQuery>,
) -> ApiResult<Json<GraphResponse>> {
    let path = state.repo_path().await?;
    let limit = query.limit.unwrap_or(500);
    let start = query.start.clone();
    let since = query.since;
    let until = query.until;

    let (nodes, edges, refs) = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        git_graph::build_graph(&repo, start.as_deref(), limit, since, until)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(GraphResponse { nodes, edges, refs }))
}

/// GET /api/v1/timebounds — newest/oldest commit timestamps + total count,
/// for the time scrubber's full-range extent.
pub async fn get_time_bounds(
    State(state): State<AppState>,
) -> ApiResult<Json<git_graph::TimeBounds>> {
    let path = state.repo_path().await?;
    let bounds = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        git_graph::time_bounds(&repo)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    Ok(Json(bounds))
}
