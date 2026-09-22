use crate::config::AppConfig;
use crate::git::containment::ContainmentMap;
use crate::search::IndexCache;
use crate::watcher::{self, RepoChanged, WatchHandle};
use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

/// Cache of computed graph/time-bounds results, invalidated wholesale whenever
/// the repo changes (watcher `RepoChanged`) or a new repo is opened. Both are
/// pure functions of repo state, so a stale entry is never *wrong* — we simply
/// drop everything on any change and recompute lazily on the next request.
///
/// The graph varies by query params, so it is keyed by a canonical string of
/// those params. Time bounds have no params — a single `Option` slot.
#[derive(Default)]
pub struct GraphCache {
    /// key = canonical query string (limit|start|since|until|refs) → JSON graph.
    pub graph: HashMap<String, Arc<serde_json::Value>>,
    /// Cached /timebounds JSON (no params).
    pub time_bounds: Option<Arc<serde_json::Value>>,
}

impl GraphCache {
    fn clear(&mut self) {
        self.graph.clear();
        self.time_bounds = None;
    }
}

/// Cache of the whole-repo commit→containing-refs map. Unlike `GraphCache`,
/// this is NOT cleared on every repo change: containment only changes when the
/// *ref set* changes (a ref added, deleted, or moved). Most `.git` events
/// (index writes, working-tree edits, new unreferenced objects) leave
/// containment untouched, and recomputing it is expensive (a walk per ref), so
/// we key the cache by a fingerprint of the ref set and rebuild only on a
/// mismatch. A stale entry is never *wrong* because the fingerprint guards it.
#[derive(Default)]
pub struct ContainmentCache {
    /// The ref-set fingerprint the cached `map` was computed for.
    pub fingerprint: Option<u64>,
    /// The memoized map, shared cheaply via `Arc` with concurrent readers.
    pub map: Option<Arc<ContainmentMap>>,
}

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
    /// Memoized graph + time-bounds results, invalidated on repo change so a
    /// large repo isn't re-walked on every request and every live-update event.
    pub graph_cache: RwLock<GraphCache>,
    /// Memoized commit→containing-refs map, keyed by ref-set fingerprint so it
    /// rebuilds only when refs actually change (not on every `.git` event).
    pub containment_cache: RwLock<ContainmentCache>,
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
                graph_cache: RwLock::new(GraphCache::default()),
                containment_cache: RwLock::new(ContainmentCache::default()),
                events,
                watch: Mutex::new(None),
            }),
        };
        // Drop cached graph/time-bounds whenever the repo changes on disk, so
        // the next request recomputes against current state.
        state.spawn_cache_invalidator();
        Ok(state)
    }

    /// Subscribe to repo-change events and clear the graph cache on each, so a
    /// live-update-driven refetch recomputes exactly once per change rather than
    /// serving stale (or repeatedly recomputing) results.
    fn spawn_cache_invalidator(&self) {
        let inner = self.inner.clone();
        let mut rx = self.inner.events.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(_) => inner.graph_cache.write().await.clear(),
                    // Lagged: we missed some events but the point is just "changed",
                    // so clear and keep going.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        inner.graph_cache.write().await.clear();
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// Read a cached graph JSON for `key`, if present.
    pub async fn cached_graph(&self, key: &str) -> Option<Arc<serde_json::Value>> {
        self.inner.graph_cache.read().await.graph.get(key).cloned()
    }

    /// Store a graph JSON under `key`.
    pub async fn cache_graph(&self, key: String, value: Arc<serde_json::Value>) {
        self.inner.graph_cache.write().await.graph.insert(key, value);
    }

    /// Read cached time-bounds JSON, if present.
    pub async fn cached_time_bounds(&self) -> Option<Arc<serde_json::Value>> {
        self.inner.graph_cache.read().await.time_bounds.clone()
    }

    /// Store time-bounds JSON.
    pub async fn cache_time_bounds(&self, value: Arc<serde_json::Value>) {
        self.inner.graph_cache.write().await.time_bounds = Some(value);
    }

    /// Return the cached containment map iff it was computed for `fingerprint`.
    /// A `None` means the caller must (re)compute and then call
    /// [`AppState::cache_containment`].
    pub async fn cached_containment(&self, fingerprint: u64) -> Option<Arc<ContainmentMap>> {
        let guard = self.inner.containment_cache.read().await;
        if guard.fingerprint == Some(fingerprint) {
            guard.map.clone()
        } else {
            None
        }
    }

    /// Store a freshly computed containment `map` under its ref-set
    /// `fingerprint`, replacing any prior entry.
    pub async fn cache_containment(&self, fingerprint: u64, map: Arc<ContainmentMap>) {
        let mut guard = self.inner.containment_cache.write().await;
        guard.fingerprint = Some(fingerprint);
        guard.map = Some(map);
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
        // A different repo invalidates any cached graph/time-bounds immediately
        // (don't wait for a filesystem event that may never come).
        self.inner.graph_cache.write().await.clear();
        {
            // Drop the containment map too — a new repo's fingerprint would
            // differ anyway, but don't hold a large stale map for a closed repo.
            let mut c = self.inner.containment_cache.write().await;
            c.fingerprint = None;
            c.map = None;
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


