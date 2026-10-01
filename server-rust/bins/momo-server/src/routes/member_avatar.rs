//! Member avatar — the Drive routes of ADR-0161 증보 (2026-10-01, #3277), the
//! workspace avatar (`workspace_avatar.rs`) re-aimed at a person.
//!
//! ```text
//! POST   …/workspaces/{ws}/members/me/avatar/uploads         → create_upload
//! POST   …/workspaces/{ws}/members/me/avatar/{id}/complete   → complete
//! DELETE …/workspaces/{ws}/members/me/avatar                 → remove
//! GET    …/workspaces/{ws}/members/{member}/avatar/content   → content
//! ```
//!
//! ## What differs from the workspace avatar
//!
//! * **Who may set: the member themself, and only themself.** There is no
//!   `{member}` in any write path — `me` is the entire addressing scheme, so no
//!   request can name another member (same discipline as `sidebar_prefs`). The
//!   media row is looked up by `(id, caller)` at `complete`, so a pending upload
//!   someone else started is invisible; migration 111's composite FK is the
//!   backstop that makes a pointer at another member's media impossible.
//! * **Humans only.** `require_human` here, and the agent-bearer allow-list
//!   (`auth.rs::required_agent_scope`) does not list these paths, so an agent
//!   credential is refused before the database.
//! * **Allow-listed raster mimes + magic-number check.** PNG/JPEG/WebP/GIF. SVG
//!   is refused outright (a script-capable document served from this origin).
//!   `complete` additionally reads the first bytes from Drive and requires the
//!   magic number to agree with the declared mime — both the declared and the
//!   Drive-reported mime are client-supplied.
//! * **Read scope: any active workspace member**, for any member's avatar,
//!   because avatars render in the timeline, roster, mentions and thread panes.
//! * **Caching.** Same as the workspace avatar: the roster URL carries
//!   `?v={media}`, so the proxy answers `private, max-age=…, immutable`.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_drive::MAX_ATTACHMENT_BYTES;
use momo_messaging::{
    active_workspace_role, clear_own_member_avatar_in_tx,
    count_recent_pending_member_avatar_uploads_in_tx, create_pending_member_avatar_upload_in_tx,
    load_own_member_avatar_media_in_tx, read_current_member_avatar_media_in_tx,
    settle_member_avatar_upload_in_tx, sniff_image_mime, validate_avatar_name,
    validate_member_avatar_mime, MemberAvatarMedia, IMAGE_SNIFF_PREFIX_BYTES,
    MAX_WORKSPACE_AVATAR_BYTES,
};
use uuid::Uuid;

use crate::dto::{AvatarUploadResponse, CreateAvatarUploadRequest, MemberAvatarResponse};
use crate::error::ApiError;
use crate::routes::attachments::drive_error;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, require_human, settle_db,
    workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMANS_ONLY: &str = "only a human member can change their profile picture";

/// At most this many unfinished upload sessions per member per ten minutes.
const MAX_RECENT_PENDING_UPLOADS: i64 = 10;

/// The versioned content path of a member's avatar. `?v={media}` changes on every
/// replacement, so an `immutable` cache entry is never stale.
pub(crate) fn member_avatar_url(workspace_id: Uuid, member_id: Uuid, media_id: Uuid) -> String {
    format!("/v1/workspaces/{workspace_id}/members/{member_id}/avatar/content?v={media_id}")
}

/// The avatar URL every member DTO exposes: the uploaded avatar when set,
/// otherwise the legacy bare `member.avatar_url` (ADR-0161 증보 D-M4), otherwise
/// absent (initials).
pub(crate) fn resolved_member_avatar_url(
    workspace_id: Uuid,
    member_id: Uuid,
    avatar_media_id: Option<Uuid>,
    legacy_avatar_url: Option<&str>,
) -> Option<String> {
    match avatar_media_id {
        Some(media_id) => Some(member_avatar_url(workspace_id, member_id, media_id)),
        None => legacy_avatar_url.map(str::to_string),
    }
}

fn response(media: &MemberAvatarMedia, status: &str) -> MemberAvatarResponse {
    MemberAvatarResponse {
        id: media.id.to_string(),
        workspace_id: media.workspace_id.to_string(),
        member_id: media.member_id.to_string(),
        name: media.name.clone(),
        mime: media.mime.clone(),
        size: media.size_bytes,
        status: status.to_string(),
        avatar_url: member_avatar_url(media.workspace_id, media.member_id, media.id),
        created_at_ms: epoch_ms(media.created_at),
    }
}

/// The caller must be a live member of the workspace. A platform-scope or
/// departed principal has a valid token but no member row to put a picture on.
async fn require_active_member(
    state: &AppState,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), ApiError> {
    let role = settle_db(
        "member_avatar.authorize",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(
                    active_workspace_role(conn, workspace_id, member_id).await?
                ))
            })
        })
        .await,
    )?;
    if role.is_some() {
        Ok(())
    } else {
        Err(ApiError::forbidden("not a workspace member"))
    }
}

/// `POST /v1/workspaces/{ws}/members/me/avatar/uploads`
pub async fn create_upload(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<CreateAvatarUploadRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, HUMANS_ONLY)?;

    // Shape first, before any connection is taken.
    let name = validate_avatar_name(&request.name)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let mime = validate_member_avatar_mime(&request.mime)
        .map_err(|_| ApiError::bad_request("avatar mime must be png, jpeg, webp or gif"))?;
    if !(1..=MAX_WORKSPACE_AVATAR_BYTES).contains(&request.size) {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "avatar size must be between 1 byte and 5 MB",
        ));
    }

    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    // Membership + the spam brake in one short read, before the Drive round trip.
    let gate: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(ApiError::forbidden("not a workspace member")));
            }
            let pending =
                count_recent_pending_member_avatar_uploads_in_tx(conn, workspace_id, member_id)
                    .await?;
            if pending >= MAX_RECENT_PENDING_UPLOADS {
                return Ok(Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "too many unfinished avatar uploads; try again in a few minutes",
                )));
            }
            Ok(Ok(()))
        })
    })
    .await;
    settle_db("member_avatar.create_upload.gate", gate)?;

    // The Drive session is created OUTSIDE any transaction. The workspace id is
    // the Drive folder scope, as for the workspace avatar.
    let session = state
        .drive
        .create_resumable_upload(workspace_id, &name, &mime, request.size)
        .await
        .map_err(drive_error)?;
    let upload_url =
        state.advertised_local_upload_url(&headers, uri.scheme_str(), session.upload_url)?;

    let created: DbRejectable<Uuid> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let id = create_pending_member_avatar_upload_in_tx(
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
    let media_id = settle_db("member_avatar.create_upload", created)?;

    Ok((
        StatusCode::CREATED,
        Json(AvatarUploadResponse {
            id: media_id.to_string(),
            status: "pending".to_string(),
            upload_url,
        }),
    ))
}

/// `POST /v1/workspaces/{ws}/members/me/avatar/{id}/complete`
///
/// Verifies what Drive holds against what was declared (size, mime, file id) and
/// against the file's own magic number, then transitions the row and — on a
/// match — points the caller at it. A mismatch commits `failed` and *then*
/// answers 409. Idempotent.
pub async fn complete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, media)): Path<(String, String)>,
) -> Result<Json<MemberAvatarResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, HUMANS_ONLY)?;
    let media_id = path_uuid(&media, "invalid avatar id")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    require_active_member(&state, workspace_id, member_id).await?;

    let pending: DbRejectable<MemberAvatarMedia> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Owner-scoped: an upload someone else started is invisible (404).
                match load_own_member_avatar_media_in_tx(
                    conn,
                    media_id,
                    workspace_id,
                    member_id,
                    false,
                )
                .await?
                {
                    None => Ok(Err(ApiError::not_found("avatar upload not found"))),
                    Some(media) => Ok(Ok(media)),
                }
            })
        })
        .await;
    let pending = settle_db("member_avatar.complete.load", pending)?;

    if pending.status == "complete" {
        return Ok(Json(response(&pending, "complete")));
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
    // Size, mime and file id must all agree with the declaration …
    let mut matched = metadata.size_bytes == pending.size_bytes
        && metadata.mime == pending.mime
        && metadata.drive_file_id == drive_file_id;
    let mut actual_mime = metadata.mime.clone();
    // … and so must the bytes themselves. Only worth a Drive read if the cheap
    // checks passed.
    if matched {
        let prefix = state
            .drive
            .file_content(&drive_file_id, MAX_ATTACHMENT_BYTES)
            .await
            .map_err(drive_error)?
            .read_prefix(IMAGE_SNIFF_PREFIX_BYTES)
            .await
            .map_err(drive_error)?;
        match sniff_image_mime(&prefix) {
            Some(sniffed) if sniffed == pending.mime => {}
            other => {
                matched = false;
                actual_mime = other.unwrap_or("unrecognized").to_string();
            }
        }
    }

    let expected_mime = pending.mime.clone();
    let expected_size = pending.size_bytes;
    let actual_size = metadata.size_bytes;
    let locked_file_id = drive_file_id.clone();

    let settled: DbRejectable<MemberAvatarMedia> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let locked = load_own_member_avatar_media_in_tx(
                    conn,
                    media_id,
                    workspace_id,
                    member_id,
                    true,
                )
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
                settle_member_avatar_upload_in_tx(
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
    let settled = settle_db("member_avatar.complete", settled)?;

    if !matched {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "uploaded file size, mime or content does not match",
        ));
    }
    Ok(Json(response(&settled, "complete")))
}

/// `DELETE /v1/workspaces/{ws}/members/me/avatar` — clear the caller's own
/// avatar (back to the legacy URL if any, else initials). Idempotent: 204 whether
/// or not there was one.
pub async fn remove(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<StatusCode, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, HUMANS_ONLY)?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let cleared: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(ApiError::forbidden("not a workspace member")));
            }
            clear_own_member_avatar_in_tx(conn, workspace_id, member_id, via_token_id).await?;
            Ok(Ok(()))
        })
    })
    .await;
    settle_db("member_avatar.remove", cleared)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /v1/workspaces/{ws}/members/{member}/avatar/content`
///
/// The authorization proxy. **Any active workspace member** may read any member's
/// current avatar (the timeline renders it for everyone); 404 when that member
/// has none. Cacheable-immutable: `?v={media}` in the roster URL changes on
/// replacement.
pub async fn content(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, member)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let target_member = path_uuid(&member, "invalid member id")?;
    let viewer = principal.member_id;

    let found: DbRejectable<MemberAvatarMedia> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, viewer)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                }
                match read_current_member_avatar_media_in_tx(conn, workspace_id, target_member)
                    .await?
                {
                    Some(media) => Ok(Ok(media)),
                    None => Ok(Err(ApiError::not_found("member has no avatar"))),
                }
            })
        })
        .await;
    let media = settle_db("member_avatar.content", found)?;

    let Some(drive_file_id) = media.drive_file_id.filter(|_| media.status == "complete") else {
        return Err(ApiError::not_found("member has no avatar"));
    };

    let archived = state
        .drive
        .file_content(&drive_file_id, MAX_WORKSPACE_AVATAR_BYTES)
        .await
        .map_err(drive_error)?;

    // The mime served is the **stored, allow-listed** one — never the archive's
    // own claim — so this response can only ever be one of four raster types.
    // `sandbox` is belt and braces against a browser that navigates to the URL.
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media.mime)
        .header(header::CONTENT_LENGTH, archived.size_bytes.to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .body(Body::from_stream(archived.body))
        .map_err(|error| ApiError::internal("member_avatar.content.response", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_uploaded_avatar_beats_the_legacy_column_and_the_legacy_column_beats_nothing() {
        let (ws, member, media) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let uploaded = resolved_member_avatar_url(ws, member, Some(media), Some("https://x/a.png"))
            .expect("uploaded");
        assert_eq!(
            uploaded,
            format!("/v1/workspaces/{ws}/members/{member}/avatar/content?v={media}")
        );
        assert_eq!(
            resolved_member_avatar_url(ws, member, None, Some("https://x/a.png")).as_deref(),
            Some("https://x/a.png")
        );
        assert_eq!(resolved_member_avatar_url(ws, member, None, None), None);
    }
}
