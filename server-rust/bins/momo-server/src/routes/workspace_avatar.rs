//! Workspace avatar — the three Drive routes (ADR-0161 D5), the attachment
//! surface (`attachments.rs`) re-aimed at a workspace.
//!
//! ```text
//! POST …/workspaces/{ws}/avatar/uploads          → avatar_create_upload
//! POST …/workspaces/{ws}/avatar/{id}/complete    → avatar_complete
//! GET  …/workspaces/{ws}/avatar/content          → avatar_content
//! ```
//!
//! ## What is reused, and what differs
//!
//! Reused verbatim: the ADR-0151 asymmetry (bytes bypass this server going up
//! via a Drive capability URL, proxied coming down), the Drive resumable-upload
//! primitive, and the `drive_error` status table (imported from `attachments`).
//!
//! Differs, each an ADR-0161 D5 decision:
//! * **Who may set.** Not "any channel member" but the workspace owner/admin
//!   (`require_workspace_operator`) — setting an avatar is a workspace-settings
//!   write. Gated on *both* `create_upload` and `complete`, so a pending upload
//!   started by an owner who was demoted mid-Drive cannot be finished.
//! * **Who may read.** Wider than an attachment: **any active workspace member**
//!   (`active_workspace_role(...).is_some()`), because the rail renders the
//!   avatar for everyone. Not the uploader, not a channel — the workspace.
//! * **Caching.** The content path is served `immutable` with a long max-age;
//!   the URL's `?v={media}` (built in `workspaces::workspace_dto`) changes on
//!   replacement, so a cache is never stale. The attachment route's
//!   `no-store`/`Content-Disposition: attachment` would defeat both.
//!
//! ## Drive folder scope
//!
//! `create_resumable_upload` takes a `channel_id: Uuid` that scopes the Drive
//! folder. There is no channel here, so the **workspace id** is passed as that
//! scope — the literal "reuse the transport primitive" of ADR-0161 D5. In the
//! Google backend this lands avatars under `channels/<ws-uuid>/`; a dedicated
//! `workspaces/<ws>/avatar` namespace is a cosmetic follow-up (banked), not a
//! correctness issue — the row binding and RLS are workspace-scoped regardless,
//! and the stub backend (which the red proof uses) ignores the scope id.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_drive::MAX_ATTACHMENT_BYTES;
use momo_messaging::{
    active_workspace_role, create_pending_avatar_upload_in_tx, load_avatar_media_in_tx,
    read_current_avatar_media_in_tx, settle_avatar_upload_in_tx, validate_avatar_mime,
    validate_avatar_name, AvatarMedia, MAX_WORKSPACE_AVATAR_BYTES,
};
use uuid::Uuid;

use crate::dto::{AvatarResponse, AvatarUploadResponse, CreateAvatarUploadRequest};
use crate::error::ApiError;
use crate::routes::attachments::drive_error;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, require_workspace_operator,
    settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

fn avatar_response(media: &AvatarMedia, status: &str) -> AvatarResponse {
    AvatarResponse {
        id: media.id.to_string(),
        workspace_id: media.workspace_id.to_string(),
        uploader_member_id: media.uploader_member_id.to_string(),
        name: media.name.clone(),
        mime: media.mime.clone(),
        size: media.size_bytes,
        status: status.to_string(),
        created_at_ms: epoch_ms(media.created_at),
    }
}

/// `POST /v1/workspaces/{ws}/avatar/uploads`
///
/// Owner/admin gate, then the Drive resumable session, then the `pending` row —
/// the session before the row (attachments' rule), so a Drive failure leaves
/// nothing to reap.
pub async fn avatar_create_upload(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<CreateAvatarUploadRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;

    // Shape first, before any connection is taken.
    let name = validate_avatar_name(&request.name)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let mime = validate_avatar_mime(&request.mime)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    if !(0..=MAX_WORKSPACE_AVATAR_BYTES).contains(&request.size) {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "avatar size must be at most 5 MB",
        ));
    }

    // Only an owner/admin may set the workspace avatar (ADR-0117 D3 — settings
    // write). Same gate re-run at `complete`.
    require_workspace_operator(&state, &principal, workspace_id).await?;

    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    // The Drive session is created OUTSIDE any transaction (a network round trip
    // must not hold a Postgres connection). The workspace id is the Drive folder
    // scope — see the module header.
    let session = state
        .drive
        .create_resumable_upload(workspace_id, &name, &mime, request.size)
        .await
        .map_err(drive_error)?;
    let upload_url =
        state.advertised_local_upload_url(&headers, uri.scheme_str(), session.upload_url)?;

    let created: DbRejectable<Uuid> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let id = create_pending_avatar_upload_in_tx(
                conn,
                workspace_id,
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
    let media_id = settle_db("workspace_avatar.create_upload", created)?;

    Ok((
        StatusCode::CREATED,
        Json(AvatarUploadResponse {
            id: media_id.to_string(),
            status: "pending".to_string(),
            upload_url,
        }),
    ))
}

/// `POST /v1/workspaces/{ws}/avatar/{id}/complete`
///
/// Verifies what Drive holds against what was declared, then transitions the row
/// and — on a match — re-points the workspace at it. A mismatch commits `failed`
/// and *then* answers 409 (attachments' honest order). Idempotent.
pub async fn avatar_complete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, media)): Path<(String, String)>,
) -> Result<Json<AvatarResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let media_id = path_uuid(&media, "invalid avatar id")?;
    require_workspace_operator(&state, &principal, workspace_id).await?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let pending: DbRejectable<AvatarMedia> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Uploader-scoped: an upload someone else started is invisible.
                match load_avatar_media_in_tx(conn, media_id, workspace_id, Some(member_id), false)
                    .await?
                {
                    None => Ok(Err(ApiError::not_found("avatar upload not found"))),
                    Some(media) => Ok(Ok(media)),
                }
            })
        })
        .await;
    let pending = settle_db("workspace_avatar.complete.load", pending)?;

    if pending.status == "complete" {
        return Ok(Json(avatar_response(&pending, "complete")));
    }
    let Some(drive_file_id) = pending
        .drive_file_id
        .clone()
        .filter(|_| pending.status == "pending")
    else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "avatar upload cannot be completed",
        ));
    };

    let metadata = state
        .drive
        .file_metadata(&drive_file_id)
        .await
        .map_err(drive_error)?;
    // All three must agree — including the file id, or a client could make
    // `complete` verify a different file than the one the row names.
    let matched = metadata.size_bytes == pending.size_bytes
        && metadata.mime == pending.mime
        && metadata.drive_file_id == drive_file_id;

    let expected_mime = pending.mime.clone();
    let actual_mime = metadata.mime.clone();
    let expected_size = pending.size_bytes;
    let actual_size = metadata.size_bytes;
    let locked_file_id = drive_file_id.clone();

    let settled: DbRejectable<AvatarMedia> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let locked =
                    load_avatar_media_in_tx(conn, media_id, workspace_id, Some(member_id), true)
                        .await?;
                let Some(locked) = locked else {
                    return Ok(Err(ApiError::not_found("avatar upload not found")));
                };
                if locked.status == "complete" {
                    return Ok(Ok(locked));
                }
                if locked.status != "pending"
                    || locked.drive_file_id.as_deref() != Some(&locked_file_id)
                {
                    return Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "avatar upload state changed",
                    )));
                }
                settle_avatar_upload_in_tx(
                    conn,
                    workspace_id,
                    media_id,
                    member_id,
                    via_token_id,
                    matched,
                    (&expected_mime, expected_size),
                    (&actual_mime, actual_size),
                )
                .await?;
                Ok(Ok(locked))
            })
        })
        .await;
    let settled = settle_db("workspace_avatar.complete", settled)?;

    if !matched {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "uploaded file size or mime does not match",
        ));
    }
    Ok(Json(avatar_response(&settled, "complete")))
}

/// `GET /v1/workspaces/{ws}/avatar/content`
///
/// The authorization proxy. **Any active workspace member** may read the current
/// avatar — wider than an attachment (channel member), because the rail renders
/// it for everyone (ADR-0161 D5). Served cacheable-immutable: the `?v={media}`
/// in the URL changes on replacement, so a cache is never stale.
pub async fn avatar_content(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let found: DbRejectable<AvatarMedia> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Read scope = active workspace membership, not channel membership.
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                }
                match read_current_avatar_media_in_tx(conn, workspace_id).await? {
                    Some(media) => Ok(Ok(media)),
                    None => Ok(Err(ApiError::not_found("workspace has no avatar"))),
                }
            })
        })
        .await;
    let media = settle_db("workspace_avatar.content", found)?;

    let Some(drive_file_id) = media.drive_file_id.filter(|_| media.status == "complete") else {
        return Err(ApiError::not_found("workspace has no avatar"));
    };

    let archived = state
        .drive
        .file_content(&drive_file_id, MAX_ATTACHMENT_BYTES)
        .await
        .map_err(drive_error)?;

    // `nosniff` still applies — the bytes are caller-supplied and served from
    // this origin — but no `Content-Disposition: attachment`: an avatar is meant
    // to render, and the mime was pinned to `image/*` and Drive-verified at
    // complete. `immutable` + long max-age is safe because the URL is versioned.
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, archived.mime)
        .header(header::CONTENT_LENGTH, archived.size_bytes.to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .body(Body::from_stream(archived.body))
        .map_err(|error| ApiError::internal("workspace_avatar.content.response", error))
}
