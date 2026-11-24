//! #6013 — the address an Agent Port agent uploads ONE picture for its own message to
//! (ADR-0151 증보 10 P3, ADR-0162 증보 7 I5).
//!
//! ```text
//! PUT /v1/agent-uploads/{ws}/{token}     public by design; the one-time token is the only authority
//! ```
//!
//! An agent connected from outside over MCP gets this address from `oort_picture_upload_begin` and sends
//! the picture with its own hands (a shell, an HTTP client). The address is **not** the Agent Port: no
//! bearer is asked for (P3 6 — the shell holds none, and handing it one would leave the credential in the
//! shell's history), and the token opens nothing but this one upload, once (I5).
//!
//! ## The order is the worker road's W4, step for step (P3)
//!
//! 1. method — the router answers 405 for anything else;
//! 2. path shape — a canonical workspace id and a well-formed token, no database; and the operator's switch
//!    (P8): off — or no public base address to have issued from — is the same 404 as an unknown token;
//! 3. **`Content-Length` required and ≤ 5 MiB** — 411 / 413 before a body byte is read or the database is
//!    asked, and without spending the token;
//! 4. a write slot — **one** per process, this prefix's own (P3 3: never the worker's four, so a caller
//!    from outside cannot hold both decoder slots); 503 `busy` before the token is spent;
//! 5. **spend the token** ([`momo_messaging::redeem_agent_upload_in_tx`]) — one statement, then the standing
//!    predicate asked **now** (P3 1); the agent and the channel come from the token row. Every refusal is
//!    the one 404 that spends the caller's refusal budget ([`crate::rate_limit::per_ip_agent_uploads`]);
//! 6. **only now the body**: exactly the declared length, within a deadline;
//! 7. sniff — png, jpeg or webp magic, nothing else (P4);
//! 8. the isolated decoder, `--prepare`, unchanged (P4);
//! 9. the archive, with the decoder's **output**;
//! 10. one tenant transaction: the predicate a third time, the ceilings counted again, the `complete` row
//!     (uploader = the token's agent), the mark, the token's record, the audit line (P3 2 · P5);
//! 11. 201 `{attachmentId, mime, sizeBytes}`.
//!
//! A refusal after step 5 answers a closed word and leaves one audit line with it (P12); a stored object
//! whose row was refused or failed is deleted. Steps 6-11 run in a task of their own, for the reason the
//! worker road gives (`routes::agent_media`): a caller who leaves cannot strand an object.
//!
//! What this module does not do: log the path, the token, a byte or a cause beyond a fixed word; read any
//! request value that would name a channel, an uploader, a file name or a content type; fetch anything
//! (P14).

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use momo_drive::DriveError;
use momo_expressions::media::{self, Rejected};
use momo_messaging::{
    bytes_match_mime, record_upload_refused_in_tx, redeem_agent_upload_in_tx, token_is_well_formed,
    upload_picture_name, write_upload_picture_in_tx, AgentUploadTarget, StoredUploadPicture,
    UploadWriteRefused, AGENT_PICTURES_DAILY_CEILING, AGENT_PICTURE_MAX_INPUT_BYTES,
    AGENT_UPLOADS_PATH_PREFIX,
};
use uuid::Uuid;

use crate::config::AgentUploadsConfig;
use crate::error::ApiError;
use crate::routes::agent_media::{closed, declared_length, discard, refused, SNIFFED};
use crate::routes::shared::agent_tenant_tx;
use crate::AppState;

/// How many uploads one process serves at once on this prefix (P3 3): one, so the decoder's two slots
/// always keep one for a person's upload and the team AI's picture.
pub(crate) const WRITE_IN_FLIGHT: usize = 1;
/// The longest the body may take once the token is spent (the worker road's number).
pub(crate) const BODY_DEADLINE: Duration = crate::routes::agent_media::BODY_DEADLINE;

/// The road's process-wide state: what the operator set at boot, and the pieces a test shortens.
#[derive(Debug, Clone)]
pub struct AgentUploadsState {
    pub config: AgentUploadsConfig,
    pub slots: Arc<tokio::sync::Semaphore>,
    pub daily_ceiling: i64,
    pub body_deadline: Duration,
}

impl AgentUploadsState {
    pub fn new(config: AgentUploadsConfig) -> Self {
        AgentUploadsState {
            config,
            slots: Arc::new(tokio::sync::Semaphore::new(WRITE_IN_FLIGHT)),
            daily_ceiling: AGENT_PICTURES_DAILY_CEILING,
            body_deadline: BODY_DEADLINE,
        }
    }
}

/// The public origin the upload address is built on, when the road is open: the operator's switch is on
/// **and** `MOMO_PUBLIC_BASE_URL` is an absolute https address (P2 · PT3 — never the request's `Host` or a
/// forwarded header). `None` is the road shut: the tool is not served, `attachmentIds` is not accepted and
/// the route answers its one 404.
pub(crate) fn served_origin(state: &AppState) -> Option<String> {
    if !state.agent_uploads.config.pictures_enabled {
        return None;
    }
    state.t3.ready_public_base_url()
}

/// The upload address for a freshly issued token.
pub(crate) fn upload_url(origin: &str, workspace_id: Uuid, token: &str) -> String {
    format!("{origin}{AGENT_UPLOADS_PATH_PREFIX}{workspace_id}/{token}")
}

/// A refusal **after** the token was spent: one audit line with the closed word (best effort), then the
/// answer.
async fn refuse_after(
    state: &AppState,
    workspace_id: Uuid,
    target: &AgentUploadTarget,
    status: StatusCode,
    code: &'static str,
    bytes_in: i64,
) -> Response {
    let target = *target;
    let _ = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            record_upload_refused_in_tx(conn, workspace_id, &target, code, bytes_in).await
        })
    })
    .await;
    closed(status, code)
}

/// `PUT /v1/agent-uploads/{ws}/{token}`
pub async fn upload(
    State(state): State<AppState>,
    Path((workspace, token)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // 2. Shape first, without the database; and a shut road is the same answer as an unknown token.
    let Ok(workspace_id) = Uuid::parse_str(&workspace) else {
        return refused();
    };
    if workspace_id.to_string() != workspace || !token_is_well_formed(&token) {
        return refused();
    }
    if served_origin(&state).is_none() {
        return refused();
    }
    // 3. A length is required and bounded before a byte of the body is read or the database asked.
    let declared = match declared_length(&headers) {
        None => return closed(StatusCode::LENGTH_REQUIRED, "length_required"),
        Some(length) if length > AGENT_PICTURE_MAX_INPUT_BYTES as u64 => {
            return closed(StatusCode::PAYLOAD_TOO_LARGE, "too_large")
        }
        Some(length) => length as usize,
    };
    // 4. This prefix's own write slot, before the token: a caller turned away here has lost nothing.
    let Ok(slot) = state.agent_uploads.slots.clone().try_acquire_owned() else {
        return closed(StatusCode::SERVICE_UNAVAILABLE, "busy");
    };
    // 5. Spend the token; the agent and the channel are the token row's, asked again now.
    let spent = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { redeem_agent_upload_in_tx(conn, workspace_id, &token).await })
    })
    .await;
    let target = match spent {
        Ok(Some(target)) => target,
        Ok(None) => return refused(),
        Err(error) => return ApiError::internal("agent_uploads.redeem", error).into_response(),
    };
    // 6.-11. Everything from here runs to its end whether or not the caller waits for it.
    let work = tokio::spawn(land(state, workspace_id, target, declared, body, slot));
    match work.await {
        Ok(response) => response,
        Err(_) => ApiError::internal("agent_uploads.land", "the landing task ended abnormally")
            .into_response(),
    }
}

/// Steps 6-11 of the module doc. `_slot` is the write slot taken before the token was spent.
async fn land(
    state: AppState,
    workspace_id: Uuid,
    target: AgentUploadTarget,
    declared: usize,
    body: Body,
    _slot: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let bytes_in = declared as i64;
    let refuse = |status: StatusCode, code: &'static str| {
        let state = state.clone();
        async move { refuse_after(&state, workspace_id, &target, status, code, bytes_in).await }
    };
    // 6. The body: exactly the declared length, in time.
    let bytes = match tokio::time::timeout(
        state.agent_uploads.body_deadline,
        axum::body::to_bytes(body, declared),
    )
    .await
    {
        Ok(Ok(bytes)) if bytes.len() == declared => bytes,
        _ => return refuse(StatusCode::BAD_REQUEST, "length_mismatch").await,
    };
    // 7. What the bytes say they are, by magic. Whatever the request called them is not looked at.
    let Some(mime_in) = SNIFFED
        .into_iter()
        .find(|mime| bytes_match_mime(mime, &bytes))
    else {
        return refuse(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_format").await;
    };
    // 8. The isolated decoder, as the worker road waits for it (≤ 3 s, line of 2).
    let started = Instant::now();
    let prepared = match media::prepare_photo_waiting(bytes.to_vec(), media::WAIT_MAX).await {
        Ok(prepared) => prepared,
        Err(Rejected::Busy) => return refuse(StatusCode::SERVICE_UNAVAILABLE, "busy").await,
        Err(Rejected::Timeout) => return refuse(StatusCode::GATEWAY_TIMEOUT, "timeout").await,
        Err(Rejected::TooLarge | Rejected::Invalid | Rejected::Video) => {
            return refuse(StatusCode::UNPROCESSABLE_ENTITY, "invalid_picture").await
        }
    };
    drop(bytes);
    let decode_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);

    // 9. The archive gets the decoder's output; the name is the server's.
    let mime_out = prepared.mime.clone();
    let name = upload_picture_name(&mime_out);
    let size_out = i64::try_from(prepared.data.len()).unwrap_or(i64::MAX);
    let stored = match state
        .drive
        .put_object(target.channel_id, &name, &mime_out, prepared.data)
        .await
    {
        Ok(file) => file,
        Err(DriveError::Unavailable) => {
            return refuse(StatusCode::SERVICE_UNAVAILABLE, "drive_not_configured").await
        }
        Err(_) => return refuse(StatusCode::BAD_GATEWAY, "storage_failed").await,
    };

    // 10. The row: re-prove, count again, write. A refusal here writes nothing, so the object goes too.
    let drive_file_id = stored.drive_file_id.clone();
    let picture = StoredUploadPicture {
        drive_file_id: stored.drive_file_id,
        name,
        mime: mime_out.clone(),
        size_bytes: size_out,
        mime_in,
        bytes_in,
        decode_ms,
        backend: state.drive.backend_kind(),
    };
    let ceiling = state.agent_uploads.daily_ceiling;
    let written = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            write_upload_picture_in_tx(conn, workspace_id, &target, &picture, ceiling).await
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
        Ok(Err(UploadWriteRefused::NotAllowedNow)) => {
            discard(&state, &drive_file_id).await;
            refuse(StatusCode::CONFLICT, "not_allowed_now").await
        }
        Ok(Err(UploadWriteRefused::CapReached)) => {
            discard(&state, &drive_file_id).await;
            refuse(StatusCode::TOO_MANY_REQUESTS, "cap_reached").await
        }
        Err(error) => {
            discard(&state, &drive_file_id).await;
            ApiError::internal("agent_uploads.write", error).into_response()
        }
    }
}
