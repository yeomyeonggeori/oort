//! #4820 C2a — the self-media address the co-hosted Hermes' picture tool reads
//! (ADR-0218 증보 G4·G8, ADR-0203 증보 I2·I4; owner 10-30 결정 ①).
//!
//! ```text
//! GET /v1/self-media/{ws}/{token}     public; the one-time token is the only authority
//! ```
//!
//! ## What the route is
//!
//! The agent-worker mints one token per hosted turn whose trigger message carries a picture
//! (`momo_messaging::self_media`), and the Hermes picture tool downloads
//! `{origin}/v1/self-media/{ws}/{token}` itself. This handler spends the token and answers the
//! bytes. It is **public by construction**, like `/v1/join` and the Drive stub: the caller
//! is Hermes, which holds no oort credential, and there is no workspace to bind before the
//! path's `{ws}` says which one — so that is the tenant transaction's workspace (RLS FORCE,
//! non-bypass role), and a token presented under any other workspace is simply unknown.
//!
//! ## What it will not do
//!
//! * **No redirect, ever.** The bytes come from this process. A 3xx would let Hermes' HTTP
//!   client follow it to wherever it points, and a Drive URL must never leave this server.
//! * **No Drive trace.** The response carries a fixed header list. The Drive file id, the
//!   archive's own headers and its mime string never reach the wire: the content type is the
//!   attachment row's (png/jpeg/webp), and the bytes must start like that image.
//! * **One refusal before the token is spent.** Malformed, unknown, another workspace's, expired,
//!   spent, run over, not the requester's file, deleted — one 404, one body, and the same 404 for bytes
//!   that are not the declared type (a property of the file, said to the person as such). Only that 404
//!   spends the caller's per-IP budget ([`crate::rate_limit::per_ip_self_media`]).
//! * **One more shape after it, for a caller who has proved the token** (#5072, ADR-0151 증보 6): the
//!   archive could not give the bytes the row promised — it failed, or the bytes are not the row's length —
//!   is one 502 with one fixed body. It says nothing about any file but the caller's own, and it is not a
//!   guess, so it does not spend the budget (a storage outage must not lock a workspace's pictures out).
//! * **No token in a log line.** This module logs nothing about a request; an internal error
//!   logs its cause only, and a database error never carries a bound value.
//! * **GET only.** axum answers `HEAD` with the GET handler and drops the body, which would spend
//!   the token for nothing; so the handler's first line turns any method but GET away with a 405
//!   before it looks at the path or the database.
//!
//! Consume-then-fetch means a Drive error after the spend burns the token. That is the contract
//! (a token is single-use); the model's next call simply has no source. What the caller is *told* about
//! that error is the 502 above, not the 404: until #5072 a failing archive and a file that is not the
//! type it claims were one answer, and the helper told the person their own file was unreadable when the
//! storage had merely failed.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use momo_messaging::{bytes_match_mime, redeem_in_tx, token_is_well_formed};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::shared::agent_tenant_tx;
use crate::AppState;

/// The one refusal. Every reason a request is not served before its token is spent — and a stored file that
/// is not the type it claims — is this exact answer.
fn refused() -> Response {
    ApiError::not_found("not found").into_response()
}

/// The sentence of the one answer for a caller whose token was spent and whose bytes then could not be
/// served. Fixed text: it carries no file id, no archive wording and no cause.
const STORAGE_FAILED_MESSAGE: &str = "the stored file could not be read";

/// The second shape: the archive failed, or its bytes are not the length the row declared (#5072, ADR-0151
/// 증보 6). Only a caller that has already redeemed a valid token reaches this, so it tells no one anything
/// about a file that is not theirs. `cause` is a fixed word for the log (never an id, a path or the archive's
/// own text); the caller is told only the status and [`STORAGE_FAILED_MESSAGE`].
fn storage_failed(cause: &'static str) -> Response {
    tracing::warn!(cause, "self-media: the stored bytes could not be served");
    ApiError::new(StatusCode::BAD_GATEWAY, STORAGE_FAILED_MESSAGE).into_response()
}

/// `GET /v1/self-media/{ws}/{token}`
pub async fn serve(
    State(state): State<AppState>,
    method: Method,
    Path((workspace, token)): Path<(String, String)>,
) -> Response {
    if method != Method::GET {
        let mut response = StatusCode::METHOD_NOT_ALLOWED.into_response();
        response
            .headers_mut()
            .insert(header::ALLOW, header::HeaderValue::from_static("GET"));
        return response;
    }
    // Shape first, without the database: only the canonical lowercase hyphenated workspace id and
    // exactly a minted token's alphabet and length go any further.
    let Ok(workspace_id) = Uuid::parse_str(&workspace) else {
        return refused();
    };
    if workspace_id.to_string() != workspace || !token_is_well_formed(&token) {
        return refused();
    }

    let redeemed = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { redeem_in_tx(conn, workspace_id, &token).await })
    })
    .await;
    let source = match redeemed {
        Ok(Some(source)) => source,
        Ok(None) => return refused(),
        Err(error) => return ApiError::internal("self_media.redeem", error).into_response(),
    };

    // The bytes: read by this server, bounded by what the row declared. A stream longer or shorter
    // than the row says is never truncated to fit and never served. From here the token is spent and
    // the caller has proved it, so the two things that can go wrong are told apart (#5072): the archive
    // (or the row) failing is `storage_failed`; bytes that are not the declared type are the file's own
    // property and stay the one 404.
    let Ok(declared) = usize::try_from(source.size_bytes) else {
        return storage_failed("size");
    };
    let content = match state
        .drive
        .file_content(&source.drive_file_id, source.size_bytes)
        .await
    {
        Ok(content) => content,
        Err(_) => return storage_failed("archive_open"),
    };
    let bytes = match content.read_prefix(declared + 1).await {
        Ok(bytes) => bytes,
        Err(_) => return storage_failed("archive_read"),
    };
    if bytes.len() != declared {
        return storage_failed("length");
    }
    if !bytes_match_mime(&source.mime, &bytes) {
        return refused();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, source.mime)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::CONTENT_DISPOSITION, "attachment")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from(bytes))
        .unwrap_or_else(|error| ApiError::internal("self_media.response", error).into_response())
}
