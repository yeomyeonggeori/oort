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
//! that RLS and the membership predicate both agreed to.
//!
//! ## What is *not* here
//!
//! * **No SQL.** Every statement is `momo_messaging::attachment`'s.
//! * **No HTTP client.** Every archive call is `momo_drive`'s, through a trait
//!   with five methods. `reqwest` is still not a dependency of this binary.
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
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_drive::{
    received_size_agrees_with_declaration, received_size_within_ceiling, DriveError,
    MAX_ATTACHMENT_BYTES,
};
use momo_messaging::{
    create_pending_upload_in_tx, is_attachment_channel_member, load_attachment_in_tx,
    settle_upload_in_tx, validate_attachment_mime, validate_attachment_name, Attachment,
};
use uuid::Uuid;

use crate::dto::{AttachmentResponse, AttachmentUploadResponse, CreateAttachmentUploadRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, workspace_scope, DbRejectable,
};
use crate::AppState;

/// Swift `AttachmentRoutes.httpError` (:470-479) — the archive's vocabulary
/// mapped onto status codes, one for one.
///
/// `AccessDenied` is a **502, not a 403**: Drive refusing *momo's* service
/// account is an upstream problem with the instance's configuration, not the
/// caller lacking permission. Answering 403 would tell a member who is perfectly
/// entitled to the file that they are not.
pub(crate) fn drive_error(error: DriveError) -> ApiError {
    let message = error.safe_message();
    match error {
        DriveError::Unavailable => ApiError::new(StatusCode::SERVICE_UNAVAILABLE, message),
        DriveError::InvalidArguments(_) => ApiError::bad_request(message),
        DriveError::AccessDenied => ApiError::new(StatusCode::BAD_GATEWAY, message),
        DriveError::FileNotFound => ApiError::not_found(message),
        DriveError::ContentTooLarge => ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, message),
        DriveError::UpstreamFailure => ApiError::new(StatusCode::BAD_GATEWAY, message),
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
                match load_attachment_in_tx(conn, attachment_id, channel_id, Some(member_id), false)
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
                    load_attachment_in_tx(conn, attachment_id, channel_id, Some(member_id), true)
                        .await?;
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

/// `GET /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/content`
///
/// The authorization proxy. Any **active member of the channel** may read a
/// completed attachment — not only its uploader, because a file posted to a room
/// belongs to the conversation.
///
/// Anything that is not a completed attachment of this channel is a flat 404:
/// pending, failed, another channel's, another tenant's (invisible under RLS)
/// all answer identically, so the route cannot be used to enumerate what exists.
pub async fn content(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, attachment)): Path<(String, String, String)>,
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
            // `None` uploader scope: this is the one attachment read that is not
            // restricted to whoever uploaded it.
            match load_attachment_in_tx(conn, attachment_id, channel_id, None, false).await? {
                Some(attachment) => Ok(Ok(attachment)),
                None => Ok(Err(ApiError::not_found("completed attachment not found"))),
            }
        })
    })
    .await;
    let attachment = crate::routes::shared::settle_db("attachments.content", found)?;

    let Some(drive_file_id) = attachment
        .drive_file_id
        .filter(|_| attachment.status == "complete")
    else {
        return Err(ApiError::not_found("completed attachment not found"));
    };

    let archived = state
        .drive
        .file_content(&drive_file_id, MAX_ATTACHMENT_BYTES)
        .await
        .map_err(drive_error)?;

    // `Content-Disposition: attachment` is deliberate and is not cosmetic: the
    // proxy serves caller-supplied bytes from the API's own origin, so anything
    // the browser might render inline — an uploaded `.html`, an SVG carrying a
    // script — would run as same-origin content. Forcing a download makes the
    // stored mime a label rather than an execution instruction. `nosniff` closes
    // the same door for a browser that would otherwise guess.
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, archived.mime)
        .header(header::CONTENT_LENGTH, archived.size_bytes.to_string())
        .header(header::CONTENT_DISPOSITION, "attachment")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from_stream(archived.body))
        .map_err(|error| ApiError::internal("attachments.content.response", error))
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
pub async fn stub_upload(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<StatusCode, ApiError> {
    // The same `^[a-f0-9-]{36}$` shape Swift required. A token that is not a
    // lowercase UUID cannot be one this process issued, so it is refused before
    // the archive is asked about it.
    let is_token = token.len() == 36
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase() || byte == b'-');
    if !is_token {
        return Err(ApiError::not_found("stub upload session not found"));
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    state
        .drive
        .accept_stub_upload(&token, mime, body.to_vec())
        .await
        .map_err(drive_error)?;
    Ok(StatusCode::OK)
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

    /// The stub token shape, asserted directly: a path segment that is not a
    /// lowercase UUID must never reach the archive.
    #[test]
    fn a_stub_token_must_be_a_lowercase_uuid() {
        let ok = |token: &str| {
            token.len() == 36
                && token.bytes().all(|byte| {
                    byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase() || byte == b'-'
                })
        };
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
