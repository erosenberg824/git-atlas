use crate::config::AppConfig;
use crate::search::IndexCache;
use crate::watcher::{self, RepoChanged, WatchHandle};
use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

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
    /// Broadcast channel for live "repo changed" events (fed by the watcher,
    /// consumed by /events WebSocket clients).
    pub events: broadcast::Sender<RepoChanged>,
    /// Active filesystem watcher handle; replaced when the repo changes.
    pub watch: Mutex<Option<WatchHandle>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Result<Self> {
        let repo_path = RwLock::new(config.repo_path.clone());
        let (events, _) = broadcast::channel(64);
        let state = Self {
            inner: Arc::new(Inner {
                config,
                repo_path,
                index_cache: crate::search::new_index_cache(),
                events,
                watch: Mutex::new(None),
            }),
        };
        Ok(state)
    }

    /// Subscribe to live repo-change events.
    pub fn subscribe(&self) -> broadcast::Receiver<RepoChanged> {
        self.inner.events.subscribe()
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

    /// Set the repository path and (re)point the filesystem watcher at it so
    /// live-update events fire for the newly opened repo.
    pub async fn set_repo_path(&self, path: PathBuf) {
        {
            let mut guard = self.inner.repo_path.write().await;
            *guard = Some(path.clone());
        }
        self.start_watching(&path).await;
    }

    /// (Re)start watching `path`'s `.git`. Drops any previous watcher first.
    pub async fn start_watching(&self, path: &std::path::Path) {
        let handle = watcher::start(path, self.inner.events.clone());
        let mut guard = self.inner.watch.lock().await;
        *guard = handle; // dropping the old handle stops the old watcher
    }
}


