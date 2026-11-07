//! #5371 — the address the agent-worker writes ONE re-encoded picture to
//! (ADR-0151 증보 8, the mirror of the read route in [`crate::routes::self_media`]).
//!
//! ```text
//! PUT /v1/agent-media/{ws}/{token}     public by construction; the one-time token is the only authority
//! ```
//!
//! The agent-worker cannot write to this process's archive (on Railway the `local` volume belongs to
//! the api alone), so it mints a single-use token in the database and spends it **itself**, once,
//! against the api's private address. This handler is everything between that request and the
//! `complete` attachment row.
//!
//! ## The order is the argument (W4)
//!
//! Each step is only reached when the one before it held, so a refusal never opens the next:
//!
//! 1. method — the router answers 405 (`Allow: PUT`) for anything else, before this handler;
//! 2. path shape — a canonical workspace id and a well-formed token, no database;
//! 3. **`Content-Length` required and ≤ 5 MiB** — 411 / 413, before a body byte is read, before the
//!    database, and without spending the token;
//! 4. a write slot — [`WRITE_IN_FLIGHT`] at once per process; 503 `busy` before the token is spent;
//! 5. **spend the token** ([`momo_messaging::redeem_agent_picture_in_tx`]) — one statement; the run's
//!    requester and channel come from the **run**, never from the request. Every refusal is the
//!    one 404 that spends the caller's refusal budget ([`crate::rate_limit::per_ip_agent_media`]);
//! 6. **only now the body**: exactly the declared length, within a deadline;
//! 7. sniff — png, jpeg or webp magic, nothing else (a one-frame GIF the decoder would accept stops
//!    here: this is the only place that closes it);
//! 8. the isolated decoder, `--prepare`, waiting at most 3 s in a line of 2 for one of its two slots;
//! 9. the archive, with the decoder's **output** — the input bytes go nowhere;
//! 10. one tenant transaction: the same binding question a third time, the workspace's own 24-hour
//!     ceiling, the `complete` row (uploader = the run's agent), its audit line, the token's record of
//!     the attachment it made;
//! 11. 201.
//!
//! A refusal after step 5 answers a closed word (never a sentence, never a cause) and leaves one audit
//! line with the same word; a stored object whose row was refused or failed is deleted.
//!
//! **Everything after the spend runs in a task of its own** ([`land`]); the request only waits for its
//! answer. A worker that gives up, crashes or loses the connection drops the handler's future, and a
//! future dropped between the archive write and the row would strand an object no row names — so
//! the token's holder can leave, and the work still finishes: the row is written or the object is
//! removed (the decoder's supervisor already works this way, `media::run_with_permit`).
//!
//! What this module does not do: log the path, the token, a byte or a cause beyond a fixed word;
//! follow anything the request names (a channel, a requester, an uploader, a file name, a content
//! type are all ignored); retry anything (the worker tries once).

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use momo_drive::DriveError;
use momo_expressions::media::{self, Rejected};
use momo_messaging::{
    bytes_match_mime, picture_name, record_picture_refused_in_tx, redeem_agent_picture_in_tx,
    token_is_well_formed, write_picture_in_tx, AgentPictureTarget, PictureWriteRefused,
    StoredPicture, AGENT_PICTURE_MAX_INPUT_BYTES,
};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::shared::agent_tenant_tx;
use crate::AppState;

/// How many picture writes one process serves at once (ADR-0151 증보 8 W4 **[추정]**).
pub(crate) const WRITE_IN_FLIGHT: usize = 4;
/// The longest the body may take once the token is spent (W4 **[추정]**).
pub(crate) const BODY_DEADLINE: Duration = Duration::from_secs(10);
/// `Retry-After` of the one 503 a caller may retry (`busy`).
const BUSY_RETRY_AFTER_SECONDS: u64 = 5;
/// The three types the route accepts, by magic. GIF is not among them.
const SNIFFED: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

/// The one refusal that depends on the token: unknown, malformed, another workspace's, expired,
/// spent, run over, someone gone, channel archived, slot beyond the run's limit — all this exact
/// answer, so the status says nothing about which.
fn refused() -> Response {
    ApiError::not_found("not found").into_response()
}

/// A refusal made **without** touching the database or after the caller proved the token: a status
/// and one closed word, nothing else. Only `busy` may be retried and says when.
fn closed(status: StatusCode, code: &'static str) -> Response {
    let error = ApiError::coded(status, code, code);
    if code == "busy" {
        error
            .with_retry_after(BUSY_RETRY_AFTER_SECONDS)
            .into_response()
    } else {
        error.into_response()
    }
}

/// `Content-Length` as one number, or `None` when it is absent, repeated or not a number.
fn declared_length(headers: &HeaderMap) -> Option<u64> {
    let mut values = headers.get_all(header::CONTENT_LENGTH).iter();
    let first = values.next()?;
    if values.next().is_some() {
        return None;
    }
    first.to_str().ok()?.trim().parse::<u64>().ok()
}

/// A refusal **after** the token was spent: one audit line with the closed word (best effort — the
/// answer does not wait on it succeeding), then the answer.
async fn refuse_after(
    state: &AppState,
    workspace_id: Uuid,
    target: &AgentPictureTarget,
    status: StatusCode,
    code: &'static str,
    bytes_in: i64,
) -> Response {
    let target = *target;
    let _ = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            record_picture_refused_in_tx(conn, workspace_id, &target, code, bytes_in).await
        })
    })
    .await;
    closed(status, code)
}

/// Delete an object whose row was never written. A failure to delete leaves an object no row
/// names; the log line is a fixed word and nothing the archive said.
async fn discard(state: &AppState, drive_file_id: &str) {
    if state.drive.delete_file(drive_file_id).await.is_err() {
        tracing::warn!(
            cause = "object_left",
            "agent-media: a stored picture could not be removed"
        );
    }
}

/// `PUT /v1/agent-media/{ws}/{token}`
pub async fn write(
    State(state): State<AppState>,
    Path((workspace, token)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // 2. Shape first, without the database.
    let Ok(workspace_id) = Uuid::parse_str(&workspace) else {
        return refused();
    };
    if workspace_id.to_string() != workspace || !token_is_well_formed(&token) {
        return refused();
    }
    // 3. A length is required and bounded before a byte of the body is read or the database asked.
    // (A request with neither `Content-Length` nor a transfer coding reaches here with no header.)
    let declared = match declared_length(&headers) {
        None => return closed(StatusCode::LENGTH_REQUIRED, "length_required"),
        Some(length) if length > AGENT_PICTURE_MAX_INPUT_BYTES as u64 => {
            return closed(StatusCode::PAYLOAD_TOO_LARGE, "too_large")
        }
        Some(length) => length as usize,
    };
    // 4. A write slot, before the token: a caller turned away here has lost nothing.
    let Ok(slot) = state.agent_media_slots.clone().try_acquire_owned() else {
        return closed(StatusCode::SERVICE_UNAVAILABLE, "busy");
    };
    // 5. Spend the token. The target (run, agent, requester, channel, slot) is derived from the run.
    let spent = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { redeem_agent_picture_in_tx(conn, workspace_id, &token).await })
    })
    .await;
    let target = match spent {
        Ok(Some(target)) => target,
        Ok(None) => return refused(),
        Err(error) => return ApiError::internal("agent_media.redeem", error).into_response(),
    };
    // 6.-11. Everything from here runs to its end whether or not the caller waits for it.
    let work = tokio::spawn(land(state, workspace_id, target, declared, body, slot));
    match work.await {
        Ok(response) => response,
        Err(_) => ApiError::internal("agent_media.land", "the landing task ended abnormally")
            .into_response(),
    }
}

/// Steps 6-11 of the module doc: the body, the sniff, the decoder, the archive, the row. Runs as its own
/// task so a caller that disconnects cannot strand a stored object (module doc). `_slot` is the write
/// slot taken before the token was spent; it is released when this task ends.
async fn land(
    state: AppState,
    workspace_id: Uuid,
    target: AgentPictureTarget,
    declared: usize,
    body: Body,
    _slot: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let bytes_in = declared as i64;
    // 6. The body: exactly the declared length (the HTTP framing ends the body there), in time.
    let bytes = match tokio::time::timeout(
        state.agent_media_body_deadline,
        axum::body::to_bytes(body, declared),
    )
    .await
    {
        Ok(Ok(bytes)) if bytes.len() == declared => bytes,
        _ => {
            return refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::BAD_REQUEST,
                "length_mismatch",
                bytes_in,
            )
            .await
        }
    };
    // 7. What the bytes say they are, by magic. Whatever the request called them is not looked at.
    let Some(mime_in) = SNIFFED
        .into_iter()
        .find(|mime| bytes_match_mime(mime, &bytes))
    else {
        return refuse_after(
            &state,
            workspace_id,
            &target,
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_format",
            bytes_in,
        )
        .await;
    };
    // 8. The isolated decoder, waiting for a slot as an agent's candidates do (≤ 3 s, line of 2).
    let started = Instant::now();
    let prepared = match media::prepare_photo_waiting(bytes.to_vec(), media::WAIT_MAX).await {
        Ok(prepared) => prepared,
        Err(Rejected::Busy) => {
            return refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                bytes_in,
            )
            .await
        }
        Err(Rejected::Timeout) => {
            return refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                bytes_in,
            )
            .await
        }
        Err(Rejected::TooLarge | Rejected::Invalid | Rejected::Video) => {
            return refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_picture",
                bytes_in,
            )
            .await
        }
    };
    drop(bytes);
    let decode_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);

    // 9. The archive gets the decoder's output; the name is the server's, never the request's.
    let mime_out = prepared.mime.clone();
    let name = picture_name(target.slot, &mime_out);
    let size_out = i64::try_from(prepared.data.len()).unwrap_or(i64::MAX);
    let stored = match state
        .drive
        .put_object(target.channel_id, &name, &mime_out, prepared.data)
        .await
    {
        Ok(file) => file,
        Err(DriveError::Unavailable) => {
            return refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::SERVICE_UNAVAILABLE,
                "drive_not_configured",
                bytes_in,
            )
            .await
        }
        Err(_) => {
            return refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::BAD_GATEWAY,
                "storage_failed",
                bytes_in,
            )
            .await
        }
    };

    // 10. The row: re-prove, count, write. A refusal here writes nothing, so the object goes too.
    let drive_file_id = stored.drive_file_id.clone();
    let picture = StoredPicture {
        drive_file_id: stored.drive_file_id,
        name,
        mime: mime_out.clone(),
        size_bytes: size_out,
        mime_in,
        bytes_in,
        decode_ms,
        backend: state.drive.backend_kind(),
    };
    let ceiling = state.agent_media_daily_ceiling;
    let written = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            write_picture_in_tx(conn, workspace_id, &target, &picture, ceiling).await
        })
    })
    .await;
    match written {
        Ok(Ok(attachment_id)) => (
            StatusCode::CREATED,
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({
                "attachmentId": attachment_id.to_string(),
                "mime": mime_out,
                "sizeBytes": size_out,
            })),
        )
            .into_response(),
        Ok(Err(PictureWriteRefused::RunOver)) => {
            discard(&state, &drive_file_id).await;
            refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::CONFLICT,
                "run_over",
                bytes_in,
            )
            .await
        }
        Ok(Err(PictureWriteRefused::CapReached)) => {
            discard(&state, &drive_file_id).await;
            refuse_after(
                &state,
                workspace_id,
                &target,
                StatusCode::TOO_MANY_REQUESTS,
                "cap_reached",
                bytes_in,
            )
            .await
        }
        Err(error) => {
            discard(&state, &drive_file_id).await;
            ApiError::internal("agent_media.write", error).into_response()
        }
    }
}
