use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{error::ApiResult, state::AppState};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeKind {
    Bitbucket,
    Github,
    Gitlab,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ForgeConfigRequest {
    pub kind: ForgeKind,
    /// Base URL — required for self-hosted instances, optional for cloud.
    pub base_url: Option<String>,
    /// Workspace/org/group slug.
    pub workspace: String,
    /// Repository slug.
    pub repo: String,
    /// Personal access token / app password. Stored in OS keychain, not config file.
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct PrSummary {
    pub id: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub source_branch: String,
    pub destination_branch: String,
    pub url: String,
    /// OID of the tip commit of the source branch, if resolvable locally.
    pub tip_oid: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ListPrsQuery {
    /// Filter by state: open | merged | declined (default: open).
    pub state: Option<String>,
}

/// POST /api/v1/forge/config — save forge credentials to the OS keychain.
pub async fn set_forge_config(
    State(_state): State<AppState>,
    Json(req): Json<ForgeConfigRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    // Store token in OS keychain using the `keyring` crate.
    let service = format!("git-atlas:{:?}:{}", req.kind, req.workspace);
    let entry = keyring::Entry::new(&service, &req.repo)
        .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))?;
    entry
        .set_password(&req.token)
        .map_err(|e| crate::error::AppError::Internal(anyhow::anyhow!(e)))?;

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

/// GET /api/v1/forge/prs — list pull requests from the configured forge.
pub async fn list_prs(
    State(_state): State<AppState>,
    Query(_query): Query<ListPrsQuery>,
) -> ApiResult<Json<Vec<PrSummary>>> {
    // TODO: retrieve forge config from keychain, call forge API, return results.
    // Stubbed until forge::client module is implemented.
    Ok(Json(vec![]))
}
