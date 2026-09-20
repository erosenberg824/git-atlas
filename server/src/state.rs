use crate::config::AppConfig;
use crate::search::IndexCache;
use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Shared application state passed to all route handlers via Axum extractors.
#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Inner>,
}

pub struct Inner {
    #[allow(dead_code)] // used by config reading code in future
    pub config: AppConfig,
    /// Currently open repository path (can be changed at runtime via API).
    pub repo_path: RwLock<Option<PathBuf>>,
    /// Tantivy index cache keyed by commit OID.
    pub index_cache: IndexCache,
}

impl AppState {
    pub fn new(config: AppConfig) -> Result<Self> {
        let repo_path = RwLock::new(config.repo_path.clone());
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                repo_path,
                index_cache: crate::search::new_index_cache(),
            }),
        })
    }

    /// Read the currently configured repository path asynchronously.
    pub async fn repo_path(&self) -> Result<PathBuf, crate::error::AppError> {
        let guard = self.inner.repo_path.read().await;
        guard.clone().ok_or_else(|| {
            crate::error::AppError::BadRequest(
                "No repository is open. POST /api/v1/repo first.".into(),
            )
        })
    }

    /// Set the repository path.
    pub async fn set_repo_path(&self, path: PathBuf) {
        let mut guard = self.inner.repo_path.write().await;
        *guard = Some(path);
    }
}


