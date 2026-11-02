//! Video meta and poster — the two routes of ADR-0151 증보 5 D5 (#4673 C5).
//!
//! ```text
//! PUT …/channels/{ch}/attachments/{id}/media    → setAttachmentMedia   (the uploader, before the send)
//! GET …/channels/{ch}/attachments/{id}/poster   → getAttachmentPoster  (anyone the content route serves)
//! ```
//!
//! ## One authorization, two doors
//!
//! Both routes ask the **content route's own two functions** —
//! [`is_attachment_channel_member`] and [`load_readable_attachment_in_tx`] — and answer their
//! refusals in the content route's own words (a non-member's 403, every other refusal the same flat
//! 404), so a member's view of a file cannot differ between the bytes and the picture, and neither
//! route can be asked whether a file exists. The poster route stops there; the write route asks
//! more ([`may_hold_media`]: the uploader's own, finished, not yet on a message) and answers a failure
//! of *that* with the same flat 404.
//!
//! The write's **content** checks (is it a video type, do the bytes say so, are the numbers and the
//! poster inside their ranges) come **after** that authorization and answer 400. They are therefore
//! only ever seen by the file's own uploader, who knows what they uploaded.
//!
//! ## What is not here
//!
//! * **No SQL, no parser.** Every statement is `momo_messaging::attachment_media`'s and the server
//!   does not look inside the video (see that module's header).
//! * **No new archive call.** The container check reads the first bytes through the same
//!   [`momo_drive::DriveArchive::file_content`] the content route streams from.
//! * **No change to `routes::attachments`.** `content` is another slice's (C3, `Range`); the refusal
//!   sentences this module repeats are held equal to it by a test over real HTTP.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_drive::MAX_ATTACHMENT_BYTES;
use momo_messaging::{
    is_attachment_channel_member, load_attachment_in_tx, load_poster_in_tx,
    load_readable_attachment_in_tx, may_hold_media, require_video_mime, set_attachment_media_in_tx,
    validate_media_declaration, validate_poster, video_magic_matches, Attachment, AttachmentMedia,
    MediaRejected, VIDEO_PREFIX_BYTES,
};
use serde::Deserialize;

use crate::error::ApiError;
use crate::routes::attachments::drive_error;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

/// The write's body ceiling: a 256 KiB poster is 341 KiB of base64, and the numbers are a few dozen
/// bytes. 512 KiB leaves the framing room and nothing for a bulk upload to ride on.
pub const MAX_MEDIA_BODY_BYTES: usize = 512 * 1024;

/// `PUT …/media` request (openapi `SetAttachmentMediaRequest`).
///
/// The three numbers are integers: a fractional `durationMs` is a client that did not round, and
/// is refused as a malformed body rather than truncated. `poster` may be absent (a device that could
/// measure the video but not take a frame): the media then has no poster and says so (`hasPoster`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAttachmentMediaRequest {
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    #[serde(default)]
    pub poster: Option<PosterRequest>,
}

/// The poster half of the request: its type label and its bytes, standard base64.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PosterRequest {
    pub mime: String,
    pub data_base64: String,
}

/// The 403 the content route gives a caller who is not an active member of the channel, in its own
/// words (held equal by `the_poster_route_is_the_content_route_for_everyone_else`).
fn not_a_member() -> ApiError {
    ApiError::forbidden("active channel membership required")
}

/// The flat 404 of the content route: unknown id, another channel's or tenant's file, a draft that is
/// not the caller's, a deleted message's file, a file that is not complete. One sentence for all of
/// them, so none of them can be told from another.
fn not_readable() -> ApiError {
    ApiError::not_found("completed attachment not found")
}

fn rejected(why: MediaRejected) -> ApiError {
    ApiError::bad_request(why.to_string())
}

/// `PUT /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/media`
///
/// Sets (or replaces, whole) the length, size and poster of a video the caller uploaded and has not
/// sent yet. Order, and why:
///
/// 1. the **shape** of the request, before any connection is taken — it needs nothing from the
///    database and the answer to it is the caller's own business;
/// 2. **who and what**: the content route's membership and readability, then [`may_hold_media`];
///    any failure is the flat 404 (a non-member's is the 403);
/// 3. **the file**: a stored type from the closed video list, and the object's first bytes — read
///    outside any transaction, because holding a Postgres connection across an archive round trip
///    is how a slow upstream becomes a pool outage;
/// 4. **the write**, in a second transaction that repeats the membership check and takes the
///    attachment row `FOR UPDATE` — the lock a send takes to bind the file, so the two are ordered —
///    and asks [`may_hold_media`] again before anything is written.
pub async fn set_media(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, attachment)): Path<(String, String, String)>,
    Json(request): Json<SetAttachmentMediaRequest>,
) -> Result<Json<AttachmentMedia>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "human member required")?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let attachment_id = path_uuid(&attachment, "invalid attachment id")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    // 1. shape
    let declaration =
        validate_media_declaration(request.duration_ms, request.width, request.height)
            .map_err(rejected)?;
    let poster = request
        .poster
        .as_ref()
        .map(|poster| validate_poster(&poster.mime, &poster.data_base64))
        .transpose()
        .map_err(rejected)?;

    // 2. who and what
    let found: DbRejectable<Attachment> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                return Ok(Err(not_a_member()));
            }
            match load_readable_attachment_in_tx(conn, attachment_id, channel_id, member_id).await?
            {
                Some(found) if may_hold_media(&found, member_id) => Ok(Ok(found)),
                _ => Ok(Err(not_readable())),
            }
        })
    })
    .await;
    let found = settle_db("attachment_media.set.load", found)?;
    let Some(drive_file_id) = found.drive_file_id.clone() else {
        return Err(not_readable());
    };

    // 3. the file
    require_video_mime(&found.mime).map_err(rejected)?;
    let prefix = state
        .drive
        .file_content(&drive_file_id, MAX_ATTACHMENT_BYTES)
        .await
        .map_err(drive_error)?
        .read_prefix(VIDEO_PREFIX_BYTES)
        .await
        .map_err(drive_error)?;
    video_magic_matches(&found.mime, &prefix).map_err(rejected)?;

    // 4. the write
    let written: DbRejectable<AttachmentMedia> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Membership can change while the archive is read; the row is not committed by
                // someone who left in between (the same two-step the other write routes take).
                if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                    return Ok(Err(not_a_member()));
                }
                let locked =
                    load_attachment_in_tx(conn, attachment_id, channel_id, member_id, true).await?;
                // A send that bound the file while the archive was read, a file that is no longer
                // the one that was checked: nothing is written, and the answer is the flat 404.
                let Some(locked) = locked.filter(|locked| {
                    may_hold_media(locked, member_id)
                        && locked.drive_file_id.as_deref() == Some(drive_file_id.as_str())
                }) else {
                    return Ok(Err(not_readable()));
                };
                let media = set_attachment_media_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    locked.id,
                    member_id,
                    via_token_id,
                    declaration,
                    poster.as_ref(),
                )
                .await?;
                Ok(Ok(media))
            })
        })
        .await;
    Ok(Json(settle_db("attachment_media.set", written)?))
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/poster`
///
/// The poster of a video, to everyone the content route would serve that video to, in its own words:
/// a non-member's 403, and one flat 404 for everything unreadable — **and the same headers**
/// (`attachment`, `nosniff`, `no-store`: the proxy serves caller-supplied bytes from the API's own
/// origin, so a picture is a download to a browser that is pointed at it, never a page).
///
/// A readable file with no poster (a photo, a video nobody measured, a measurement without a frame)
/// is a 404 of its own sentence. Only someone who may read the file ever sees it.
pub async fn poster(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, attachment)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let attachment_id = path_uuid(&attachment, "invalid attachment id")?;
    let member_id = principal.member_id;

    let found: DbRejectable<Option<momo_messaging::PosterImage>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_attachment_channel_member(conn, workspace_id, channel_id, member_id).await? {
                    return Ok(Err(not_a_member()));
                }
                match load_readable_attachment_in_tx(conn, attachment_id, channel_id, member_id)
                    .await?
                {
                    Some(found) if found.status == "complete" => {
                        Ok(Ok(load_poster_in_tx(conn, workspace_id, found.id).await?))
                    }
                    _ => Ok(Err(not_readable())),
                }
            })
        })
        .await;
    let Some(poster) = settle_db("attachment_media.poster", found)? else {
        return Err(ApiError::not_found("attachment poster not found"));
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, poster.mime)
        .header(header::CONTENT_LENGTH, poster.bytes.len().to_string())
        .header(header::CONTENT_DISPOSITION, "attachment")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from(poster.bytes))
        .map_err(|error| ApiError::internal("attachment_media.poster.response", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// Both refusals are the content route's own sentences. The test over real HTTP
    /// (`the_poster_route_is_the_content_route_for_everyone_else`) holds them equal to what that
    /// route answers; this one pins the spelling so a drive-by edit shows up here first.
    #[test]
    fn the_refusals_keep_the_content_routes_sentences() {
        let forbidden = not_a_member();
        assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
        assert_eq!(forbidden.message, "active channel membership required");
        let flat = not_readable();
        assert_eq!(flat.status, StatusCode::NOT_FOUND);
        assert_eq!(flat.message, "completed attachment not found");
    }

    #[test]
    fn the_request_is_closed_and_its_poster_is_optional() {
        let full: SetAttachmentMediaRequest = serde_json::from_value(serde_json::json!({
            "durationMs": 4200, "width": 1280, "height": 720,
            "poster": {"mime": "image/jpeg", "dataBase64": "AAAA"}
        }))
        .expect("a full request");
        assert!(full.poster.is_some());
        let bare: SetAttachmentMediaRequest = serde_json::from_value(serde_json::json!({
            "durationMs": 4200, "width": 1280, "height": 720
        }))
        .expect("a request without a poster");
        assert!(bare.poster.is_none());
        // an unknown key is a client that means something the server does not do
        assert!(
            serde_json::from_value::<SetAttachmentMediaRequest>(serde_json::json!({
                "durationMs": 1, "width": 1, "height": 1, "kind": "audio"
            }))
            .is_err()
        );
        // and a fractional duration is not rounded for the client
        assert!(
            serde_json::from_value::<SetAttachmentMediaRequest>(serde_json::json!({
                "durationMs": 1.5, "width": 1, "height": 1
            }))
            .is_err()
        );
    }

    /// The ADR keeps agents out of attachment uploads (「바뀌지 않는 것」), and a developer token has
    /// a closed table of eight routes. Neither door lists either new route, so an agent bearer is
    /// answered 403 and a developer token 401/403 **before the database** (`auth.rs`). The controls
    /// are rows each table does hold, so a `None` here is the table's answer and not a bad call.
    #[test]
    fn neither_an_agent_bearer_nor_a_developer_token_has_a_door_to_either_route() {
        let (ws, ch, id) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        for (method, leaf) in [("PUT", "media"), ("GET", "poster")] {
            let path = format!("/v1/workspaces/{ws}/channels/{ch}/attachments/{id}/{leaf}");
            assert_eq!(
                momo_auth::required_agent_scope(method, &path),
                None,
                "{method} {path}: an agent bearer has no scope for it"
            );
            let template =
                format!("/v1/workspaces/{{ws}}/channels/{{ch}}/attachments/{{attachment}}/{leaf}");
            assert_eq!(
                momo_auth::required_dev_scope(method, &template),
                None,
                "{method} {template}: a developer token has no row for it"
            );
        }
        assert!(
            momo_auth::required_agent_scope(
                "POST",
                &format!("/v1/workspaces/{ws}/channels/{ch}/messages")
            )
            .is_some(),
            "control: the agent table does open the send"
        );
        let first = &momo_auth::DEV_ROUTE_TABLE[0];
        assert!(
            momo_auth::required_dev_scope(first.method, first.template).is_some(),
            "control: the developer table does open its own first row"
        );
    }

    #[test]
    fn the_body_ceiling_holds_the_largest_poster_in_base64() {
        // 256 KiB of poster is ceil(262144 / 3) * 4 = 349528 base64 characters
        let largest_poster_encoded =
            momo_messaging::attachment_media::POSTER_MAX_BYTES.div_ceil(3) * 4;
        assert!(MAX_MEDIA_BODY_BYTES > largest_poster_encoded + 1024);
        assert!(MAX_MEDIA_BODY_BYTES < 2 * largest_poster_encoded);
    }
}
