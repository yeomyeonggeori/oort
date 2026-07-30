//! The HTTP error envelope.
//!
//! Wire parity with Hummingbird's `HTTPError`: the body is
//! `{"error":{"message":"…"}}` (`docs/api/openapi.yaml` → `ErrorResponse`), so a
//! client that already parses the Swift server's errors needs no change.
//!
//! Internal failures (DB/transaction errors) are logged with detail but answered
//! with a fixed message — an error body must never leak SQL, table names, or
//! tenant data.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use momo_db::DbError;
use momo_messaging::MessagingError;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorMessage,
}

#[derive(Debug, Serialize)]
struct ErrorMessage {
    message: String,
}

/// A status + client-safe message.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::UNAUTHORIZED, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::FORBIDDEN, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::NOT_FOUND, message)
    }

    /// Log the cause, answer with an opaque 500.
    pub fn internal(context: &str, cause: impl std::fmt::Display) -> Self {
        tracing::error!(context, error = %cause, "request failed");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorMessage {
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

/// Map a DB error onto HTTP. `RowNotFound` is the one case the write path uses
/// semantically (a channel with no `channel_seq` row), so it becomes a 404 with
/// the Swift wording; everything else is an opaque 500.
pub fn db_error(context: &str, error: DbError) -> ApiError {
    if let DbError::Sqlx(sqlx_error) = &error {
        if matches!(sqlx_error, momo_db::sqlx::Error::RowNotFound) {
            return ApiError::not_found("channel not found or not provisioned");
        }
    }
    ApiError::internal(context, error)
}

/// Same mapping for the messaging crate's widened error.
pub fn messaging_error(context: &str, error: MessagingError) -> ApiError {
    match error {
        MessagingError::Db(inner) => db_error(context, inner),
        other => ApiError::internal(context, other),
    }
}
