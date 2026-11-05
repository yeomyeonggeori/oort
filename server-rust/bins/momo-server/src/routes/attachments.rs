//! Attachments — the three Drive routes (ADR-0151 D1, port of Swift
//! `AttachmentRoutes.swift`).
//!
//! Paths verbatim from the spec (`docs/api/openapi.yaml:2991,3041,3080`) and
//! from Swift (`AttachmentRoutes.swift:41-54`):
//!
//! ```text
//! POST …/channels/{ch}/attachments/uploads             → createAttachmentUpload
//! POST …/channels/{ch}/attachments/{id}/complete       → completeAttachmentUpload
//! GET  …/channels/{ch}/attachments/{id}/content        → getAttachmentContent
//! ```
//!
//! ## The asymmetry, restated where it is enforced
//!
//! **Bytes bypass this server going up; they are proxied coming down.** The
//! upload route hands back a Drive capability URL and never touches a body. The
//! content route reads the bytes itself, *after* the same channel-membership
//! check every other read on this server makes — so a Drive URL never reaches a
//! client, and the only way to an attachment's bytes is an authenticated request
//! that RLS and the membership predicate both agreed to, for a file a live message
//! carries or one the caller uploaded herself (a draft is its uploader's alone,
//! ADR-0208 남는 위험 8; a file a deleted message carried is nobody's, ADR-0151 증보 2).
//!
//! ## What is *not* here
//!
//! * **No SQL.** Every statement is `momo_messaging::attachment`'s.
//! * **No HTTP client.** Every archive call is `momo_drive`'s, through the
//!   `DriveArchive` trait. `reqwest` is still not a dependency of this binary.
//! * **No 307.** Swift's content route could answer a redirect, but only the
//!   unported S3 client ever produced one, and the spec documents no redirect
//!   for this operation.
//!
//! ## Two transactions, not one, on the write paths
//!
//! Both writes check membership, then call Drive, then write — and the Drive
//! call cannot happen inside a transaction, because holding a Postgres
//! transaction open across a network round trip to Google is how a slow upstream
//! becomes a connection-pool outage. So membership is checked **twice**: once
//! before the archive call and once inside the transaction that commits. Swift
//! does the same and says why (`AttachmentRoutes.swift:88-90`): a membership can
//! change while Google is working, and the row must not be committed by someone
//! who left in between.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_drive::{
    received_size_agrees_with_declaration, received_size_within_ceiling, DriveError,
    MAX_ATTACHMENT_BYTES,
};
use momo_messaging::{
    create_pending_upload_in_tx, is_attachment_channel_member, load_attachment_in_tx,
    load_readable_attachment_in_tx, settle_upload_in_tx, validate_attachment_mime,
    validate_attachment_name, Attachment,
};
use uuid::Uuid;

use crate::dto::{AttachmentResponse, AttachmentUploadResponse, CreateAttachmentUploadRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, workspace_scope, DbRejectable,
};
use crate::AppState;

/// `error.code` of the 503 an instance without a usable archive answers (ADR-0151 증보 7 D1).
/// An operator has to fix it, so it never carries a `Retry-After`.
pub(crate) const CODE_DRIVE_NOT_CONFIGURED: &str = "drive_not_configured";

/// `error.code` of the 502 for the archive refusing *this instance's own* credentials (증보 7 D1).
/// Also an operator's to fix, so no `Retry-After`.
pub(crate) const CODE_DRIVE_ACCESS_DENIED: &str = "drive_access_denied";

/// `error.code` of the 502 for an archive request that failed, or whose bytes disagree with the
/// row (증보 7 D1). The one archive answer that may clear by waiting.
pub(crate) const CODE_DRIVE_UPSTREAM_FAILED: &str = "drive_upstream_failed";

/// `Retry-After` (whole seconds) on [`CODE_DRIVE_UPSTREAM_FAILED`] (증보 7 D3): a hint, not a
/// promise — a client may back off on its own schedule.
pub(crate) const DRIVE_UPSTREAM_RETRY_AFTER_SECONDS: u64 = 5;

/// Swift `AttachmentRoutes.httpError` (:470-479) — the archive's vocabulary
/// mapped onto status codes, one for one.
///
/// `AccessDenied` is a **502, not a 403**: Drive refusing *momo's* service
/// account is an upstream problem with the instance's configuration, not the
/// caller lacking permission. Answering 403 would tell a member who is perfectly
/// entitled to the file that they are not.
///
/// The 502s and the 503 also name themselves (ADR-0151 증보 7 D1): a client can then tell "this
/// server has no archive" and "the archive failed" from a 502/503 that something in front of the
/// server produced, which carries no `error.code`. The 400, 404 and 413 stay exactly as they were —
/// the 404 above all, which amendments 1 and 2 keep byte-identical to an unknown id.
pub(crate) fn drive_error(error: DriveError) -> ApiError {
    let message = error.safe_message();
    match error {
        DriveError::Unavailable => ApiError::coded(
            StatusCode::SERVICE_UNAVAILABLE,
            CODE_DRIVE_NOT_CONFIGURED,
            message,
        ),
        DriveError::InvalidArguments(_) => ApiError::bad_request(message),
        DriveError::AccessDenied => {
            ApiError::coded(StatusCode::BAD_GATEWAY, CODE_DRIVE_ACCESS_DENIED, message)
        }
        DriveError::FileNotFound => ApiError::not_found(message),
        DriveError::ContentTooLarge => ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, message),
        DriveError::UpstreamFailure => {
            ApiError::coded(StatusCode::BAD_GATEWAY, CODE_DRIVE_UPSTREAM_FAILED, message)
                .with_retry_after(DRIVE_UPSTREAM_RETRY_AFTER_SECONDS)
        }
    }
}

fn attachment_response(attachment: &Attachment, status: &str) -> AttachmentResponse {
    AttachmentResponse {
        id: attachment.id.to_string(),
        channel_id: attachment.channel_id.to_string(),
        uploader_member_id: attachment.uploader_member_id.to_string(),
        message_id: attachment.message_id.map(|id| id.to_string()),
        name: attachment.name.clone(),
        mime: attachment.mime.clone(),
        size: attachment.size_bytes,
        status: status.to_string(),
        created_at_ms: epoch_ms(attachment.created_at),
    }
}

/// The 403 both write routes and the read route answer, worded exactly as Swift
/// does so a client's error surface is unchanged.
fn not_a_member() -> ApiError {
    ApiError::forbidden("active channel membership required")
}

/// `POST /v1/workspaces/{ws}/channels/{ch}/attachments/uploads`
///
/// Creates the Drive resumable session and the `pending` row that owns its
/// lifecycle. **The session is created before the row**, so a Drive failure
/// leaves nothing behind to reap; the row is then written with the file id it is
/// waiting for, so an abandoned upload is always identifiable.
pub async fn create_upload(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<CreateAttachmentUploadRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;

    // Shape first, before any connection is taken (MOMO-362's rule).
    let name = validate_attachment_name(&request.name)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let mime = validate_attachment_mime(&request.mime)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    if !(0..=MAX_ATTACHMENT_BYTES).contains(&request.size) {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "attachment size must be at most 100 MB",
        ));
    }

    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let allowed: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                return Ok(Err(not_a_member()));
            }
            Ok(Ok(()))
        })
    })
    .await;
    crate::routes::shared::settle_db("attachments.create_upload.membership", allowed)?;

    let session = state
        .drive
        .create_resumable_upload(channel_id, &name, &mime, request.size)
        .await
        .map_err(drive_error)?;
    let upload_url =
        state.advertised_local_upload_url(&headers, uri.scheme_str(), session.upload_url)?;

    let created: DbRejectable<Uuid> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // Membership can change while Google creates the session. Rechecked
            // before the row and its audit record commit.
            if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                return Ok(Err(not_a_member()));
            }
            let id = create_pending_upload_in_tx(
                conn,
                workspace_id,
                channel_id,
                member_id,
                via_token_id,
                &session.drive_file_id,
                &name,
                &mime,
                request.size,
            )
            .await?;
            Ok(Ok(id))
        })
    })
    .await;
    let attachment_id = crate::routes::shared::settle_db("attachments.create_upload", created)?;
    // #4443: remember the workspace for the local-volume reclaim tick (this process cannot
    // enumerate tenants itself). `workspace_id` is the principal's own, checked by
    // `workspace_scope` above — never a request-supplied id. An id and nothing else.
    state.attachment_reclaim_touched.touch(workspace_id);

    Ok((
        StatusCode::CREATED,
        Json(AttachmentUploadResponse {
            id: attachment_id.to_string(),
            status: "pending".to_string(),
            upload_url,
        }),
    ))
}

/// `POST /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/complete`
///
/// Verifies what Drive actually holds against what the uploader declared, then
/// transitions the row. The measured archive size is what the row (and the
/// response) keep; a declared `0` is unknown and is not a mismatch.
///
/// **A mismatch commits `failed` and *then* answers 409.** That order is Swift's
/// (`AttachmentRoutes.swift:162-208`) and it is the honest one: the divergence is
/// a fact worth recording, and a row left `pending` forever would be reaped as an
/// abandoned upload rather than read as a rejected one. The client still gets its
/// refusal — it just gets it after the record exists. An over-ceiling measured
/// size is the same durable `failed` write, then 413.
///
/// Idempotent: completing an already-complete attachment returns it unchanged.
pub async fn complete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, attachment)): Path<(String, String, String)>,
) -> Result<Json<AttachmentResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let attachment_id = path_uuid(&attachment, "invalid attachment id")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let pending: DbRejectable<Attachment> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                    return Ok(Err(not_a_member()));
                }
                // Scoped to the uploader: an attachment someone else started is
                // indistinguishable from one that does not exist.
                match load_attachment_in_tx(conn, attachment_id, channel_id, member_id, false)
                    .await?
                {
                    None => Ok(Err(ApiError::not_found("attachment not found"))),
                    Some(attachment) => Ok(Ok(attachment)),
                }
            })
        })
        .await;
    let pending = crate::routes::shared::settle_db("attachments.complete.load", pending)?;

    if pending.status == "complete" {
        return Ok(Json(attachment_response(&pending, "complete")));
    }
    let Some(drive_file_id) = pending
        .drive_file_id
        .clone()
        .filter(|_| pending.status == "pending")
    else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "attachment upload cannot be completed",
        ));
    };

    let metadata = state
        .drive
        .file_metadata(&drive_file_id)
        .await
        .map_err(drive_error)?;
    // Mime and file id must agree. Size agrees when the declaration is known;
    // `0` is unknown and is not a mismatch. The 100 MB ceiling is on the
    // archive's measured length, so a shrunk declaration cannot complete an
    // over-ceiling object.
    let over_ceiling = !received_size_within_ceiling(metadata.size_bytes);
    let matched = !over_ceiling
        && received_size_agrees_with_declaration(pending.size_bytes, metadata.size_bytes)
        && metadata.mime == pending.mime
        && metadata.drive_file_id == drive_file_id;

    let expected_mime = pending.mime.clone();
    let actual_mime = metadata.mime.clone();
    let expected_size = pending.size_bytes;
    let actual_size = metadata.size_bytes;
    let locked_file_id = drive_file_id.clone();

    let settled: DbRejectable<Attachment> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                    return Ok(Err(not_a_member()));
                }
                let locked =
                    load_attachment_in_tx(conn, attachment_id, channel_id, member_id, true).await?;
                let Some(mut locked) = locked else {
                    return Ok(Err(ApiError::not_found("attachment not found")));
                };
                if locked.status == "complete" {
                    return Ok(Ok(locked));
                }
                // The row moved under us between the two reads — a concurrent
                // complete, or a file id that is no longer the one we verified.
                if locked.status != "pending"
                    || locked.drive_file_id.as_deref() != Some(&locked_file_id)
                {
                    return Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "attachment upload state changed",
                    )));
                }
                settle_upload_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    attachment_id,
                    member_id,
                    via_token_id,
                    matched,
                    (&expected_mime, expected_size),
                    (&actual_mime, actual_size),
                )
                .await?;
                if matched {
                    locked.size_bytes = actual_size;
                    locked.status = "complete".to_string();
                }
                Ok(Ok(locked))
            })
        })
        .await;
    let settled = crate::routes::shared::settle_db("attachments.complete", settled)?;

    // The transition is committed; only now is the caller told whether it was
    // the one they wanted.
    if over_ceiling {
        return Err(drive_error(DriveError::ContentTooLarge));
    }
    if !matched {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "uploaded file size or mime does not match",
        ));
    }
    Ok(Json(attachment_response(&settled, "complete")))
}

/// `GET|HEAD /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/content`
///
/// The authorization proxy. An **active member of the channel** may read a
/// completed attachment **a live message carries** — not only its uploader, because
/// a file posted to a room belongs to the conversation. A completed attachment **no
/// message carries yet** (a draft in a composer tray, or a file a scheduled
/// message is holding for up to 120 days) is its uploader's alone to read
/// (ADR-0208 남는 위험 8, #4233); the uploader still passes the membership check
/// first, so leaving the channel ends her access like everyone else's. A file a
/// **deleted** message carried is nobody's to read — its author and uploader
/// included, a workspace admin included (ADR-0151 증보 2, #4443).
///
/// Anything that is not a completed attachment this member may read is a flat
/// 404: pending, failed, **another member's draft**, **a deleted message's file**,
/// another channel's, another tenant's (invisible under RLS) all answer
/// identically, so the route cannot be used to enumerate what exists — or whose
/// drafts do.
///
/// **`Range` and `HEAD` come last (ADR-0151 증보 5 D3, #4671).** The order is the
/// contract: authentication, active channel membership, the readable predicate,
/// `status = complete` — and only **after** all four does the request's `Range` get
/// read. A request that fails any of them is answered exactly as it was before
/// ranges existed (403 for a non-member, the one 404 for the rest) whatever `Range`
/// it carries, so a 416 is only ever sent for a file the reader may read and a
/// `Range` header cannot ask whether a file exists or how big it is. What follows —
/// the `200`/`206`/`416` table, the headers, the `HEAD` that opens nothing — is
/// [`attachment_bytes`](crate::routes::attachment_bytes).
pub async fn content(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, attachment)): Path<(String, String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let attachment_id = path_uuid(&attachment, "invalid attachment id")?;
    let member_id = principal.member_id;

    let found: DbRejectable<Attachment> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                return Ok(Err(not_a_member()));
            }
            // Carried by a live message, or uploaded by this very member and carried
            // by none: nothing else is readable, and what is not is the same `None` as
            // an id that never existed (`load_readable_attachment_in_tx`).
            match load_readable_attachment_in_tx(conn, attachment_id, channel_id, member_id).await?
            {
                Some(attachment) => Ok(Ok(attachment)),
                None => Ok(Err(ApiError::not_found("completed attachment not found"))),
            }
        })
    })
    .await;
    let attachment = crate::routes::shared::settle_db("attachments.content", found)?;

    let Some(drive_file_id) = attachment
        .drive_file_id
        .clone()
        .filter(|_| attachment.status == "complete")
    else {
        return Err(ApiError::not_found("completed attachment not found"));
    };

    // `Content-Disposition: attachment` is deliberate and is not cosmetic: the
    // proxy serves caller-supplied bytes from the API's own origin, so anything
    // the browser might render inline — an uploaded `.html`, an SVG carrying a
    // script — would run as same-origin content. Forcing a download makes the
    // stored mime a label rather than an execution instruction. `nosniff` closes
    // the same door for a browser that would otherwise guess. A 206 is a download
    // like any other: the same headers go on every answer.
    crate::routes::attachment_bytes::respond(
        &*state.drive,
        &attachment,
        &drive_file_id,
        &headers,
        method == Method::HEAD,
    )
    .await
}

/// `PUT /__momo_stub/drive/uploads/{token}` — the in-process upload endpoint
/// (Swift `AttachmentRoutes.stubUpload`, :257-280; ADR-0169 local archive).
///
/// Mounted **only when the configured archive accepts stub uploads**. The
/// in-memory stub is a boot error in `staging`/`prod` (see
/// `config::DriveSettings::boot_error`); the local-volume archive is not,
/// because its bytes survive a restart. Public by construction: it stands in for
/// Google's resumable session URL, which carries no bearer either — its
/// authorization is the unguessable token in the path, and the token names one
/// pre-declared file. A declared length of 0 is unknown; the received length is
/// measured and the 100 MB ceiling is enforced on those bytes.
///
/// The token is **single-use and expires** (#2615,
/// [`momo_drive::UPLOAD_SESSION_TTL`]): the upload it accepts spends it, so the
/// URL cannot replace bytes that were completed and posted. A spent, expired or
/// never-issued token answers the same 404 — which status a client sees says
/// nothing about which URLs once worked, and every client already restarts a
/// failed upload with a new session.
///
/// **The body is not read until the capability has been checked (#2628).**
/// The extractor is the raw [`Body`], so nothing is buffered before this
/// function runs; the token's shape is checked here, and the archive checks the
/// session and the announced `Content-Length` before it pulls the first chunk,
/// then writes the body as it arrives. A PUT with a made-up token costs the
/// server its headers, not its body — before #2628 the `Bytes` extractor held
/// up to 100 MB of it in memory first, for anyone who asked.
///
/// **This route answers 404 for a capability it refuses, and for nothing
/// else** — malformed, unknown, spent, expired. The per-IP gate around it
/// (`rate_limit::per_ip_drive_upload`) spends an address's budget on exactly
/// those 404s and never refuses a live capability, so keep every other refusal
/// here on its own status.
pub async fn stub_upload(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<StatusCode, ApiError> {
    // The same `^[a-f0-9-]{36}$` shape Swift required. A token that is not a
    // lowercase UUID cannot be one this process issued, so it is refused before
    // the archive is asked about it — and before a byte of the body is read.
    if !is_upload_token(&token) {
        return Err(ApiError::not_found("stub upload session not found"));
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let content_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    state
        .drive
        .accept_stub_upload(
            &token,
            mime,
            content_length,
            momo_drive::upload_body(body.into_data_stream()),
        )
        .await
        .map_err(drive_error)?;
    Ok(StatusCode::OK)
}

/// Whether `token` has the shape of a capability this process mints: a
/// lowercase hyphenated UUID. An uppercase alias of a live token is refused
/// here, so a case-insensitive filesystem never sees it.
fn is_upload_token(token: &str) -> bool {
    token.len() == 36
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive's refusals must not be laundered into the caller's fault, and the
    /// two that would be easiest to get wrong are the ones asserted hardest.
    #[test]
    fn the_archive_error_table_matches_swift() {
        assert_eq!(
            drive_error(DriveError::Unavailable).status,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            drive_error(DriveError::AccessDenied).status,
            StatusCode::BAD_GATEWAY,
            "Drive refusing OUR service account is an upstream fault, not the caller's"
        );
        assert_eq!(
            drive_error(DriveError::FileNotFound).status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            drive_error(DriveError::ContentTooLarge).status,
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            drive_error(DriveError::UpstreamFailure).status,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            drive_error(DriveError::InvalidArguments("bad".into())).status,
            StatusCode::BAD_REQUEST
        );
    }

    /// ADR-0151 증보 7 D1·D3: the archive faults that are 502/503 name themselves with a stable
    /// `error.code`, and only the one that clears by waiting says when to come back. The rest of the
    /// table (400/404/413) keeps the exact envelope it always had — the 404 above all, which
    /// amendments 1 and 2 pin as byte-identical to an unknown id. Read off the real response, so the
    /// header and the body are what a client gets.
    #[tokio::test]
    async fn an_archive_fault_names_itself_and_only_a_passing_one_says_when_to_come_back() {
        use serde_json::{json, Value};

        // (fault, status, code, Retry-After)
        let table: [(DriveError, StatusCode, Option<&str>, Option<&str>); 6] = [
            (
                DriveError::Unavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                Some("drive_not_configured"),
                None,
            ),
            (
                DriveError::AccessDenied,
                StatusCode::BAD_GATEWAY,
                Some("drive_access_denied"),
                None,
            ),
            (
                DriveError::UpstreamFailure,
                StatusCode::BAD_GATEWAY,
                Some("drive_upstream_failed"),
                Some("5"),
            ),
            (
                DriveError::InvalidArguments("bad".into()),
                StatusCode::BAD_REQUEST,
                None,
                None,
            ),
            (DriveError::FileNotFound, StatusCode::NOT_FOUND, None, None),
            (
                DriveError::ContentTooLarge,
                StatusCode::PAYLOAD_TOO_LARGE,
                None,
                None,
            ),
        ];
        // Every row is judged before the test fails, so one run names every row that is wrong.
        let mut mismatches: Vec<String> = Vec::new();
        for (fault, status, code, retry_after) in table {
            let message = fault.safe_message();
            let response = drive_error(fault).into_response();
            let got_status = response.status();
            let got_retry_after = response
                .headers()
                .get(header::RETRY_AFTER)
                .map(|value| value.to_str().expect("an ascii header").to_string());
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .expect("a small body");
            let body: Value = serde_json::from_slice(&bytes).expect("a json body");
            let mut expected = json!({"error": {"message": message}});
            if let Some(code) = code {
                expected["error"]["code"] = json!(code);
            }
            if got_status != status {
                mismatches.push(format!("{message}: status {got_status}, wanted {status}"));
            }
            if got_retry_after.as_deref() != retry_after {
                mismatches.push(format!(
                    "{message}: Retry-After {got_retry_after:?}, wanted {retry_after:?}"
                ));
            }
            if body != expected {
                mismatches.push(format!("{message}: body {body}, wanted {expected}"));
            }
        }
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    /// The wire contract names what the server sends (ADR-0151 증보 7): the registry of error codes
    /// lists the three archive codes, and every operation that reaches the archive documents them and
    /// the `Retry-After` header of its 502. There is no YAML crate here, so an operation is the stretch
    /// from its `operationId:` line to the next one (the reading
    /// `invites::tests::the_openapi_names_the_paused_code_on_every_door_that_answers_it` makes); if
    /// the spec stops naming a code on a door, this goes red with the door's name.
    #[test]
    fn the_openapi_names_the_archive_codes_where_the_server_sends_them() {
        let spec = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/api/openapi.yaml"
        ))
        .expect("read openapi.yaml");
        let codes = [
            CODE_DRIVE_NOT_CONFIGURED,
            CODE_DRIVE_ACCESS_DENIED,
            CODE_DRIVE_UPSTREAM_FAILED,
        ];
        for operation in [
            "createAttachmentUpload",
            "completeAttachmentUpload",
            "getAttachmentContent",
        ] {
            let header = format!("operationId: {operation}\n");
            let start = spec
                .find(&header)
                .unwrap_or_else(|| panic!("openapi.yaml has no `{operation}`"));
            let rest = &spec[start + header.len()..];
            let end = rest.find("operationId:").unwrap_or(rest.len());
            let stretch = &rest[..end];
            for code in codes {
                assert!(stretch.contains(code), "`{operation}` must name `{code}`");
            }
            assert!(
                stretch.contains("Retry-After:"),
                "`{operation}` must document the `Retry-After` header of its 502"
            );
        }
        let registry = spec
            .find("Stable machine code for a refusal a client branches on")
            .expect("openapi.yaml has the error-code registry");
        let end = spec[registry..]
            .find("dev_cannot_decide")
            .map_or(spec.len(), |at| registry + at);
        for code in codes {
            assert!(
                spec[registry..end].contains(code),
                "the error-code registry must list `{code}`"
            );
        }
    }

    /// No archive error message may carry upstream detail into a response body.
    #[test]
    fn no_refusal_names_google() {
        for error in [
            DriveError::Unavailable,
            DriveError::AccessDenied,
            DriveError::FileNotFound,
            DriveError::ContentTooLarge,
            DriveError::UpstreamFailure,
        ] {
            let api = drive_error(error);
            assert!(!api.message.contains("googleapis.com"), "{}", api.message);
            assert!(!api.message.contains("Bearer"), "{}", api.message);
        }
    }

    /// The stub token shape, asserted on the route's own predicate (it used to
    /// be a copy, which a change to the route could not turn red — #2624
    /// review S12): a path segment that is not a lowercase UUID must never
    /// reach the archive. `tests/drive_upload_edge.rs` asserts the same over
    /// HTTP.
    #[test]
    fn a_stub_token_must_be_a_lowercase_uuid() {
        let ok = is_upload_token;
        assert!(ok("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
        assert!(!ok("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "uppercase");
        assert!(!ok("../../etc/passwd"));
        assert!(!ok("3f2504e0-4f89-41d3-9a0c-0305e82c330"), "35 chars");
        assert!(!ok(""));
    }

    #[test]
    fn the_membership_refusal_keeps_swifts_sentence() {
        let error = not_a_member();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.message, "active channel membership required");
    }
}
