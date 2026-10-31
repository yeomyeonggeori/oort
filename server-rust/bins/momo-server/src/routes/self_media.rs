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
//! * **One refusal.** Malformed, unknown, another workspace's, expired, spent, run over, not the
//!   requester's file, deleted, Drive trouble — one 404, one body. Only that 404 spends the
//!   caller's per-IP budget ([`crate::rate_limit::per_ip_self_media`]).
//! * **No token in a log line.** This module logs nothing about a request; an internal error
//!   logs its cause only, and a database error never carries a bound value.
//! * **GET only.** axum answers `HEAD` with the GET handler and drops the body, which would spend
//!   the token for nothing; so the handler's first line turns any method but GET away with a 405
//!   before it looks at the path or the database.
//!
//! Consume-then-fetch means a Drive error after the spend burns the token. That is the contract
//! (a token is single-use); the model's next call simply has no source.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use momo_messaging::{bytes_match_mime, redeem_in_tx, token_is_well_formed};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::shared::agent_tenant_tx;
use crate::AppState;

/// The one refusal. Every reason a request is not served is this exact answer.
fn refused() -> Response {
    ApiError::not_found("not found").into_response()
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
    // than the row says, or bytes that are not the declared image, are refused and never truncated.
    let Ok(declared) = usize::try_from(source.size_bytes) else {
        return refused();
    };
    let Ok(content) = state
        .drive
        .file_content(&source.drive_file_id, source.size_bytes)
        .await
    else {
        return refused();
    };
    let Ok(bytes) = content.read_prefix(declared + 1).await else {
        return refused();
    };
    if bytes.len() != declared || !bytes_match_mime(&source.mime, &bytes) {
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
