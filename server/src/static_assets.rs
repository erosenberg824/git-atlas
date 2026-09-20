//! Embedded web UI.
//!
//! The production frontend build (`ui/dist`) is embedded into the server binary
//! at compile time via `rust-embed`, so the standalone `git-atlas` binary can
//! serve the full app to a browser with no Vite / external files. This is what
//! makes the WSL / browser usage path a single self-contained binary.
//!
//! Routing: `/api/v1/*` is handled by the API router; everything else falls
//! through to [`static_handler`], which serves an embedded asset by path or, for
//! unknown non-asset routes, returns `index.html` so the client-side SPA router
//! can take over (deep links / refresh work).

use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../ui/dist"]
struct Assets;

/// Serve an embedded asset for `uri`, falling back to `index.html` for unknown
/// paths (SPA client-side routing). Used as the Axum router `fallback`.
pub async fn static_handler(uri: Uri) -> Response {
    // Strip the leading '/'; root maps to index.html.
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(content) => serve_embedded(path, content),
        None => {
            // Not a real asset. If it looks like a file request (has an
            // extension) treat it as a genuine 404; otherwise serve index.html
            // so the SPA router handles the route.
            if path.contains('.') {
                not_found()
            } else {
                match Assets::get("index.html") {
                    Some(content) => serve_embedded("index.html", content),
                    None => ui_not_built(),
                }
            }
        }
    }
}

fn serve_embedded(path: &str, content: rust_embed::EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    (
        [(header::CONTENT_TYPE, mime.as_ref())],
        content.data.into_owned(),
    )
        .into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "404 Not Found").into_response()
}

/// Returned when the UI was never built into the binary (empty `ui/dist` at
/// compile time). Gives a clear, actionable message instead of a blank 404.
fn ui_not_built() -> Response {
    (
        StatusCode::NOT_FOUND,
        Body::from(
            "git-atlas web UI is not embedded in this build.\n\
             Build the frontend first (cd ui && npm run build), then rebuild the server.\n\
             The REST API is available under /api/v1/.",
        ),
    )
        .into_response()
}

/// True if any UI assets were embedded (i.e. `index.html` exists). Lets the
/// server log a helpful hint when serving an API-only build.
pub fn ui_embedded() -> bool {
    Assets::get("index.html").is_some()
}
