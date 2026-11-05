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
    /// `claimKind` beside `error` (ADR-0215 D6) — only `POST /v1/claim`'s 409 and 410
    /// carry it; omitted (never `null`) everywhere else.
    #[serde(rename = "claimKind", skip_serializing_if = "Option::is_none")]
    claim_kind: Option<String>,
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
    /// `Retry-After` (whole seconds) on the response; `None` sends no header. Only a
    /// refusal that tells the client when to come back carries one ([`ApiError::busy`],
    /// [`ApiError::with_retry_after`]).
    pub retry_after_seconds: Option<u64>,
    /// `claimKind` at the top of the body, beside `error` (ADR-0215 D6). Set only by
    /// [`ApiError::with_claim_kind`], which only the claim route's 409 and 410 call.
    pub claim_kind: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            code: None,
            retry_after_seconds: None,
            claim_kind: None,
        }
    }

    /// A refusal that also names itself with a stable machine code.
    pub fn coded(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            code: Some(code),
            retry_after_seconds: None,
            claim_kind: None,
        }
    }

    /// A door that would have had to queue for a lock answers this instead: 503 with
    /// a `Retry-After`. Nothing was written and nothing is held, so the retry is
    /// safe whatever the request was.
    pub fn busy(retry_after_seconds: u64) -> Self {
        ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "the server is busy; retry shortly".to_string(),
            code: None,
            retry_after_seconds: Some(retry_after_seconds),
            claim_kind: None,
        }
    }

    /// Tell the client when to come back: whole seconds, sent as `Retry-After`. Only a refusal
    /// that *knows* waiting can help asks for one — a passing fault, never a state an operator has
    /// to fix, where the header would be a lie (ADR-0151 증보 7 D3). It adds the header and
    /// nothing else: the status, the sentence and the `code` stay as they were built.
    pub fn with_retry_after(mut self, seconds: u64) -> Self {
        self.retry_after_seconds = Some(seconds);
        self
    }

    /// Name the kind of the claim token this refusal is about (ADR-0215 D6). Called only for
    /// the claim route's 409 and 410: the caller holds the token itself, which is 256 bits
    /// and so no oracle. A 404, 400 or 429 must not carry it.
    pub fn with_claim_kind(mut self, claim_kind: impl Into<String>) -> Self {
        self.claim_kind = Some(claim_kind.into());
        self
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
            claim_kind: self.claim_kind,
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
        let retry_after = self.retry_after_seconds;
        let mut response = (status, Json(self.envelope())).into_response();
        if let Some(seconds) = retry_after {
            if let Ok(value) = seconds.to_string().parse() {
                response.headers_mut().insert("retry-after", value);
            }
        }
        response
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

    /// ADR-0215 D6: `claimKind` sits beside `error`, only when a refusal was given one.
    #[test]
    fn a_claim_refusal_names_the_kind_beside_the_error_and_nothing_else_does() {
        let named = ApiError::new(StatusCode::GONE, "claim token has expired")
            .with_claim_kind("password_reset");
        assert_eq!(
            serde_json::to_value(named.envelope()).unwrap(),
            serde_json::json!({
                "error": {"message": "claim token has expired"},
                "claimKind": "password_reset"
            })
        );
        let plain = ApiError::not_found("claim token is invalid");
        let body = serde_json::to_value(plain.envelope()).unwrap();
        assert!(
            body.get("claimKind").is_none(),
            "an error nobody named a kind for must not grow the key: {body}"
        );
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

    /// ADR-0151 증보 7 D3 on the wire: a coded refusal can also say when to come back, and only
    /// when it asked. The header is read off the real response (`into_response`), so a refusal that
    /// never asked keeps the response it always had, and `busy` keeps its header without growing a
    /// code.
    #[tokio::test]
    async fn a_retry_after_rides_with_a_code_and_only_when_asked() {
        async fn answer(error: ApiError) -> (StatusCode, Option<String>, serde_json::Value) {
            let response = error.into_response();
            let status = response.status();
            let retry_after = response
                .headers()
                .get("retry-after")
                .map(|value| value.to_str().expect("an ascii header").to_string());
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .expect("a small body");
            (
                status,
                retry_after,
                serde_json::from_slice(&bytes).expect("a json body"),
            )
        }

        let asked = ApiError::coded(StatusCode::BAD_GATEWAY, "wait_for_it", "try later")
            .with_retry_after(5);
        assert_eq!(
            answer(asked).await,
            (
                StatusCode::BAD_GATEWAY,
                Some("5".to_string()),
                serde_json::json!({"error": {"message": "try later", "code": "wait_for_it"}})
            )
        );

        let silent = ApiError::coded(StatusCode::SERVICE_UNAVAILABLE, "fix_it", "operator");
        assert_eq!(
            answer(silent).await,
            (
                StatusCode::SERVICE_UNAVAILABLE,
                None,
                serde_json::json!({"error": {"message": "operator", "code": "fix_it"}})
            )
        );

        let busy = answer(ApiError::busy(2)).await;
        assert_eq!(busy.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(busy.1.as_deref(), Some("2"));
        assert!(
            busy.2["error"].get("code").is_none(),
            "adding the builder does not name the older busy refusal: {}",
            busy.2
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
