//! Bitbucket Cloud REST API v2.0 client.

use crate::error::AppError;
use reqwest::Client;
use serde::Deserialize;

const BITBUCKET_API_BASE: &str = "https://api.bitbucket.org/2.0";

pub struct BitbucketClient {
    client: Client,
    base_url: String,
    workspace: String,
    repo: String,
    token: String,
}

impl BitbucketClient {
    pub fn new(workspace: &str, repo: &str, token: &str, base_url: Option<&str>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.unwrap_or(BITBUCKET_API_BASE).to_string(),
            workspace: workspace.to_string(),
            repo: repo.to_string(),
            token: token.to_string(),
        }
    }

    /// List pull requests. State: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED"
    pub async fn list_prs(&self, state: &str) -> Result<Vec<PullRequest>, AppError> {
        let url = format!(
            "{}/repositories/{}/{}/pullrequests?state={}",
            self.base_url, self.workspace, self.repo, state
        );

        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| AppError::Forge(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Forge(format!(
                "Bitbucket API error {status}: {body}"
            )));
        }

        let page: PaginatedResponse<PullRequest> = response
            .json()
            .await
            .map_err(|e| AppError::Forge(e.to_string()))?;

        Ok(page.values)
    }
}

#[derive(Debug, Deserialize)]
struct PaginatedResponse<T> {
    values: Vec<T>,
}

#[derive(Debug, Deserialize)]
pub struct PullRequest {
    pub id: u64,
    pub title: String,
    pub state: String,
    pub author: Author,
    pub source: PrEndpoint,
    pub destination: PrEndpoint,
    pub links: PrLinks,
}

#[derive(Debug, Deserialize)]
pub struct Author {
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct PrEndpoint {
    pub branch: Branch,
    pub commit: CommitRef,
}

#[derive(Debug, Deserialize)]
pub struct Branch {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct CommitRef {
    pub hash: String,
}

#[derive(Debug, Deserialize)]
pub struct PrLinks {
    #[serde(rename = "html")]
    pub html: Link,
}

#[derive(Debug, Deserialize)]
pub struct Link {
    pub href: String,
}
