use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{error::ApiResult, git::graph as git_graph, state::AppState};

/// Default max commits returned when the client sends no `limit`. This is a
/// SAFETY CAP, not a target — the client mirrors it as `GRAPH_NODE_LIMIT` and
/// passes it explicitly on every fetch. Overflow beyond this is reported via
/// `hidden_count` so the total stays correct and the UI can point the user at
/// the time scrubber / branch scoping to reach the rest.
const DEFAULT_GRAPH_LIMIT: usize = 500;

#[derive(Debug, Deserialize)]
pub struct GraphQuery {
    /// Max number of commits to return (default: `DEFAULT_GRAPH_LIMIT`).
    pub limit: Option<usize>,
    /// Start walking from this ref/oid (default: HEAD).
    pub start: Option<String>,
    /// Only include commits with time >= since (unix seconds).
    pub since: Option<i64>,
    /// Only include commits with time <= until (unix seconds).
    pub until: Option<i64>,
    /// Comma-separated ref names to seed the walk from (branch scoping). When
    /// omitted, seeds from all refs.
    pub refs: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GraphResponse {
    pub nodes: Vec<git_graph::CommitNode>,
    pub edges: Vec<git_graph::CommitEdge>,
    pub refs: Vec<git_graph::RefLabel>,
    /// Visible-branch commits OLDER than the window's `since` (hidden below).
    pub before_count: usize,
    /// Visible-branch commits NEWER than the window's `until` (hidden above).
    pub after_count: usize,
    /// In-window commits dropped because the node `limit` was reached. Lets the
    /// client show a correct total even on a full-history view that exceeds the
    /// limit (where before/after are both 0).
    pub hidden_count: usize,
}

/// GET /api/v1/graph — return the commit DAG as nodes and edges.
pub async fn get_graph(
    State(state): State<AppState>,
    Query(query): Query<GraphQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let path = state.repo_path().await?;
    let limit = query.limit.unwrap_or(DEFAULT_GRAPH_LIMIT);
    let start = query.start.clone();
    let since = query.since;
    let until = query.until;
    let seed_refs: Option<Vec<String>> = query.refs.as_ref().map(|s| {
        s.split(',')
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect()
    });

    // Canonical cache key: identical query params → identical result for a given
    // repo state. Cleared wholesale on any repo change (see AppState).
    let cache_key = format!(
        "{limit}|{}|{}|{}|{}",
        start.as_deref().unwrap_or(""),
        since.map(|s| s.to_string()).unwrap_or_default(),
        until.map(|u| u.to_string()).unwrap_or_default(),
        query.refs.as_deref().unwrap_or(""),
    );
    if let Some(cached) = state.cached_graph(&cache_key).await {
        return Ok(Json((*cached).clone()));
    }

    let data = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        git_graph::build_graph(&repo, start.as_deref(), limit, since, until, seed_refs.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    let response = GraphResponse {
        nodes: data.nodes,
        edges: data.edges,
        refs: data.refs,
        before_count: data.before_count,
        after_count: data.after_count,
        hidden_count: data.hidden_count,
    };
    let value = serde_json::to_value(&response)
        .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))?;
    let value = std::sync::Arc::new(value);
    state.cache_graph(cache_key, value.clone()).await;
    Ok(Json((*value).clone()))
}

/// GET /api/v1/timebounds — newest/oldest commit timestamps + total count,
/// for the time scrubber's full-range extent.
pub async fn get_time_bounds(
    State(state): State<AppState>,
) -> ApiResult<Json<serde_json::Value>> {
    if let Some(cached) = state.cached_time_bounds().await {
        return Ok(Json((*cached).clone()));
    }
    let path = state.repo_path().await?;
    let bounds = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(crate::error::AppError::Git)?;
        git_graph::time_bounds(&repo)
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))??;

    let value = serde_json::to_value(&bounds)
        .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))?;
    let value = std::sync::Arc::new(value);
    state.cache_time_bounds(value.clone()).await;
    Ok(Json((*value).clone()))
}
