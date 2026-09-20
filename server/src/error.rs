use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Repository error: {0}")]
    Git(#[from] git2::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid request: {0}")]
    BadRequest(String),

    #[error("Search error: {0}")]
    Search(String),

    #[error("Forge API error: {0}")]
    #[allow(dead_code)]
    Forge(String),

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

/// Implement `IntoResponse` so handlers can return `Result<T, AppError>` directly.
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Git(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            AppError::Search(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            AppError::Forge(msg) => (StatusCode::BAD_GATEWAY, msg.clone()),
            AppError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };

        let body = Json(json!({ "error": message }));
        (status, body).into_response()
    }
}

pub type ApiResult<T> = Result<T, AppError>;
