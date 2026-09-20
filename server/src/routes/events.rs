//! Live-update WebSocket endpoint.
//!
//! `GET /api/v1/events` upgrades to a WebSocket and forwards a small JSON
//! message (`{"type":"repo-changed"}`) each time the filesystem watcher
//! broadcasts a change. Clients respond by re-fetching the graph + status.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use tokio::sync::broadcast::error::RecvError;

use crate::state::AppState;

/// GET /api/v1/events — upgrade to a WebSocket that streams repo-change events.
pub async fn events_ws(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut rx = state.subscribe();

    // Send an initial hello so the client knows the stream is live.
    if socket
        .send(Message::Text("{\"type\":\"connected\"}".into()))
        .await
        .is_err()
    {
        return;
    }

    loop {
        match rx.recv().await {
            Ok(_) => {
                if socket
                    .send(Message::Text("{\"type\":\"repo-changed\"}".into()))
                    .await
                    .is_err()
                {
                    break; // client disconnected
                }
            }
            // If we lagged (slow client), just coalesce: tell them to refresh.
            Err(RecvError::Lagged(_)) => {
                if socket
                    .send(Message::Text("{\"type\":\"repo-changed\"}".into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(RecvError::Closed) => break,
        }
    }
}
