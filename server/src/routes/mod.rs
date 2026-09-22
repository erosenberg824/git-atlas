use axum::{
    routing::{get, post},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::state::AppState;

pub mod repo;
pub mod graph;
pub mod commits;
pub mod containment;
pub mod diff;
pub mod tree;
pub mod search;
pub mod forge;
pub mod events;

/// Build the top-level Axum router with all API routes and middleware.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        // Repository management
        .route("/repo", post(repo::open_repo))
        .route("/repo", get(repo::get_repo))
        .route("/repo/recent", get(repo::get_recent_repos))
        // Working-tree status (staged/unstaged counts + stash list)
        .route("/status", get(repo::get_status))
        // Graph — commit DAG
        .route("/graph", get(graph::get_graph))
        .route("/timebounds", get(graph::get_time_bounds))
        // Commits
        .route("/commits/:oid", get(commits::get_commit))
        .route("/commits/:oid/containment", get(containment::get_containment))
        // Diffs — static segments (working/staged/stash) are registered before
        // the /diff/:oid catch-all so they aren't parsed as commit OIDs.
        .route("/diff/working", get(diff::get_working_diff))
        .route("/diff/staged", get(diff::get_staged_diff))
        .route("/diff/stash/:index", get(diff::get_stash_diff))
        .route("/diff/:oid", get(diff::get_commit_diff))
        .route("/diff", get(diff::get_arbitrary_diff))
        // Tree / file browser at a commit
        .route("/tree/:oid", get(tree::get_tree))
        .route("/tree/:oid/blob", get(tree::get_blob))
        // Full-text search
        .route("/search", get(search::search))
        .route("/search/index", post(search::build_index))
        // Forge integrations (Bitbucket, GitHub, GitLab)
        .route("/forge/config", post(forge::set_forge_config))
        .route("/forge/prs", get(forge::list_prs))
        // Live updates — WebSocket that emits repo-change events
        .route("/events", get(events::events_ws));

    Router::new()
        .nest("/api/v1", api)
        // Anything not under /api/v1 falls through to the embedded web UI
        // (with SPA fallback to index.html). Makes the standalone binary serve
        // the full app to a browser with no external files / dev server.
        .fallback(crate::static_assets::static_handler)
        .layer(
            CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
