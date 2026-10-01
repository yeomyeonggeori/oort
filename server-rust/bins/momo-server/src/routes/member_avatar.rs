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
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    activate_member_avatar_upload_in_tx, active_workspace_role, clear_own_member_avatar_in_tx,
    image_dimensions, load_own_member_avatar_media_in_tx, read_current_member_avatar_media_in_tx,
    reserve_member_avatar_upload_in_tx, settle_member_avatar_upload_in_tx, sniff_image_mime,
    validate_avatar_name, validate_member_avatar_mime, MemberAvatarMedia,
    IMAGE_HEADER_PREFIX_BYTES, MAX_MEMBER_AVATAR_DIMENSION, MAX_MEMBER_AVATAR_UPLOADS_PER_HOUR,
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

    // Membership, the rate limit and the reservation row in ONE transaction,
    // serialized behind a lock on the caller's member row — so a burst of
    // concurrent requests cannot overshoot the hourly limit. The Drive round trip
    // happens after this commits (a network call must not hold a connection).
    let (reserve_name, reserve_mime, reserve_size) = (name.clone(), mime.clone(), request.size);
    let reserved: DbRejectable<Uuid> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(ApiError::forbidden("not a workspace member")));
            }
            match reserve_member_avatar_upload_in_tx(
                conn,
                workspace_id,
                member_id,
                &reserve_name,
                &reserve_mime,
                reserve_size,
            )
            .await?
            {
                Some(id) => Ok(Ok(id)),
                None => Ok(Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    format!(
                        "at most {MAX_MEMBER_AVATAR_UPLOADS_PER_HOUR} avatar uploads per hour; \
                         try again later"
                    ),
                ))),
            }
        })
    })
    .await;
    let media_id = settle_db("member_avatar.create_upload.reserve", reserved)?;

    // The Drive session is created OUTSIDE any transaction. If it fails, the
    // reservation stays `failed` (it still counts against the limit) and there
    // is no Drive object to reap. The workspace id is the Drive folder scope, as
    // for the workspace avatar.
    let session = state
        .drive
        .create_resumable_upload(workspace_id, &name, &mime, request.size)
        .await
        .map_err(drive_error)?;
    let upload_url =
        state.advertised_local_upload_url(&headers, uri.scheme_str(), session.upload_url)?;

    let activated: DbRejectable<bool> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            Ok(Ok(activate_member_avatar_upload_in_tx(
                conn,
                workspace_id,
                member_id,
                media_id,
                via_token_id,
                &session.drive_file_id,
                &name,
                &mime,
                request.size,
            )
            .await?))
        })
    })
    .await;
    if !settle_db("member_avatar.create_upload.activate", activated)? {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "avatar upload reservation was not found",
        ));
    }

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

    let loaded: DbRejectable<(MemberAvatarMedia, bool)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Owner-scoped: an upload someone else started is invisible (404).
                let Some(media) = load_own_member_avatar_media_in_tx(
                    conn,
                    media_id,
                    workspace_id,
                    member_id,
                    false,
                )
                .await?
                else {
                    return Ok(Err(ApiError::not_found("avatar upload not found")));
                };
                let current = read_current_member_avatar_media_in_tx(conn, workspace_id, member_id)
                    .await?
                    .is_some_and(|current| current.id == media.id);
                Ok(Ok((media, current)))
            })
        })
        .await;
    let (pending, is_current) = settle_db("member_avatar.complete.load", loaded)?;

    if pending.status == "complete" {
        // Idempotent only for the avatar that is *still* current. A completed
        // upload that has since been replaced or removed answers 409 and does
        // NOT silently re-point the member at an old picture (L-4): upload again.
        if is_current {
            return Ok(Json(response(&pending, "complete")));
        }
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "avatar upload is no longer your current avatar; upload it again",
        ));
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
    let mut refusal: Option<(StatusCode, &'static str)> = None;
    // … and so must the bytes themselves — the magic number AND the pixel
    // dimensions from the header (a 5 MiB file may still decode to gigabytes).
    // Only worth a Drive read if the cheap checks passed. Unknown or unparsable
    // dimensions are a refusal, not a pass.
    if matched {
        let prefix = state
            .drive
            .file_content(&drive_file_id, MAX_WORKSPACE_AVATAR_BYTES)
            .await
            .map_err(drive_error)?
            .read_prefix(IMAGE_HEADER_PREFIX_BYTES)
            .await
            .map_err(drive_error)?;
        match sniff_image_mime(&prefix) {
            Some(sniffed) if sniffed == pending.mime => match image_dimensions(sniffed, &prefix) {
                Some((w, h))
                    if w <= MAX_MEMBER_AVATAR_DIMENSION && h <= MAX_MEMBER_AVATAR_DIMENSION => {}
                other => {
                    matched = false;
                    actual_mime = match other {
                        Some((w, h)) => format!("{sniffed};dimensions={w}x{h}"),
                        None => format!("{sniffed};dimensions=unreadable"),
                    };
                    refusal = Some((
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "avatar dimensions must be readable and at most 4096x4096",
                    ));
                }
            },
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
        let (status, message) = refusal.unwrap_or((
            StatusCode::CONFLICT,
            "uploaded file size, mime or content does not match",
        ));
        return Err(ApiError::new(status, message));
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

/// The `?v={media}` cache key (see [`member_avatar_url`]).
#[derive(Debug, serde::Deserialize)]
pub struct ContentQuery {
    v: Option<String>,
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
    Query(query): Query<ContentQuery>,
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

    // L-1: the `immutable` year-long cache is only safe when the URL names the
    // bytes. A `v` that is not the *current* media id (stale, forged or garbage)
    // is a 404 — it must never get today's bytes cached under yesterday's key.
    // No `v` at all is a legitimate bare fetch: served, but revalidated, not
    // cached for a year.
    let cache_control = match query.v.as_deref() {
        Some(v) if v == media.id.to_string() => "private, max-age=31536000, immutable",
        Some(_) => return Err(ApiError::not_found("avatar version is not current")),
        None => "private, no-cache",
    };

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
        .header(header::CACHE_CONTROL, cache_control)
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
