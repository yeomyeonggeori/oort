//! The HTTP error envelope.
//!
//! Wire parity with Hummingbird's `HTTPError`: the body is
//! `{"error":{"message":"…"}}` (`docs/api/openapi.yaml` → `ErrorResponse`), so a
//! client that already parses the Swift server's errors needs no change.
//!
//! ## `error.code` (ADR-0188 R0)
//!
//! A refusal a client must branch on — not merely display — may also carry a
//! stable machine `code` beside the sentence: `{"error":{"message":"…",
//! "code":"remote_host_kill_only"}}`. It is **additive and optional**: the key
//! is omitted entirely when a refusal has none (the encoding rule every other
//! optional field on this API follows), so every error this server answered
//! before carries exactly the bytes it always did. The sentence stays free to be
//! reworded; the code does not.
//!
//! Internal failures (DB/transaction errors) are logged with detail but answered
//! with a fixed message — an error body must never leak SQL, table names, or
//! tenant data.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use momo_auth::NewPasswordInvalid;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

/// A status + client-safe message, and — for the refusals a client branches
/// on — a stable machine code.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    /// `error.code` on the wire; `None` omits the key.
    pub code: Option<&'static str>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            code: None,
        }
    }

    /// A refusal that also names itself with a stable machine code.
    pub fn coded(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            code: Some(code),
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

    /// The envelope this error answers with — one place, so the omission rule
    /// for `code` cannot differ between the response and its tests.
    fn envelope(self) -> ErrorBody {
        ErrorBody {
            error: ErrorMessage {
                message: self.message,
                code: self.code,
            },
        }
    }
}

/// A refused new password (ADR-0215 D2) is a 400. The three real refusals carry
/// their stable `error.code` (`password_too_short` / `password_too_long` /
/// `password_invalid_char`); the empty password keeps the code-less sentence it
/// always had. `?` on
/// `momo_auth::normalized_new_password` in a handler is this conversion, so
/// every path that sets a password answers one way.
impl From<NewPasswordInvalid> for ApiError {
    fn from(invalid: NewPasswordInvalid) -> Self {
        match invalid.code() {
            Some(code) => ApiError::coded(StatusCode::BAD_REQUEST, code, invalid.to_string()),
            None => ApiError::bad_request(invalid.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        (status, Json(self.envelope())).into_response()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every error this server answered before `code` existed keeps its exact
    /// bytes: the key is omitted, never serialized as `null` (the API-wide
    /// "optional fields are omitted" rule, `docs/api/openapi.yaml` header).
    #[test]
    fn an_uncoded_error_keeps_the_original_envelope() {
        let body = serde_json::to_value(ApiError::forbidden("nope").envelope()).unwrap();
        assert_eq!(body, serde_json::json!({"error": {"message": "nope"}}));
    }

    /// ADR-0215 D2 on the wire: the length refusals and the NUL refusal are
    /// 400s that name themselves; the empty password is the code-less 400 it
    /// always was.
    #[test]
    fn a_refused_new_password_is_a_400_that_names_its_reason() {
        let short = ApiError::from(NewPasswordInvalid::TooShort);
        assert_eq!(short.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::to_value(short.envelope()).unwrap(),
            serde_json::json!({"error": {
                "message": "password must be at least 10 characters",
                "code": "password_too_short"
            }})
        );
        let long = ApiError::from(NewPasswordInvalid::TooLong);
        assert_eq!(long.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::to_value(long.envelope()).unwrap(),
            serde_json::json!({"error": {
                "message": "password must be at most 72 bytes in UTF-8",
                "code": "password_too_long"
            }})
        );
        let nul = ApiError::from(NewPasswordInvalid::InvalidChar);
        assert_eq!(nul.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::to_value(nul.envelope()).unwrap(),
            serde_json::json!({"error": {
                "message": "password must not contain a NUL character",
                "code": "password_invalid_char"
            }})
        );
        let empty = ApiError::from(NewPasswordInvalid::Missing);
        assert_eq!(empty.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::to_value(empty.envelope()).unwrap(),
            serde_json::json!({"error": {"message": "password is required"}}),
            "the empty password keeps its code-less envelope"
        );
    }

    /// A coded refusal carries the code beside the sentence, inside `error`.
    #[test]
    fn a_coded_error_names_itself_beside_the_sentence() {
        let error = ApiError::coded(StatusCode::FORBIDDEN, "remote_host_kill_only", "kill only");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        let body = serde_json::to_value(error.envelope()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"error": {"message": "kill only", "code": "remote_host_kill_only"}})
        );
    }
}
