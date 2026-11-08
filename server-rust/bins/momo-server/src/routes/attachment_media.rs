//! Video meta and poster, and a photo's or GIF's size — the two routes of ADR-0151 증보 5 D5
//! (#4673 C5) and 증보 9 (#5469).
//!
//! ```text
//! PUT …/channels/{ch}/attachments/{id}/media    → setAttachmentMedia   (the uploader, before the send)
//! GET …/channels/{ch}/attachments/{id}/poster   → getAttachmentPoster  (anyone the content route serves)
//! ```
//!
//! The write takes **two shapes** (a `oneOf`, discriminated by `kind`): a video's `{durationMs, width,
//! height, poster?}` (`kind` absent or `"video"` — a client older than 증보 9 sends none) and a
//! picture's `{kind: "image", width, height}`. Each is a closed object: a picture that names a length
//! or a poster is a key the route does not know (422), as a video with a `kind` of anything else is.
//! Past the shape, a picture takes **the same four steps** a video does, with its own two questions of
//! the file ([`MediaWrite::require_mime`], [`MediaWrite::magic_matches`]).
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
//! The write's checks come in two groups, and the order between them is the point. The **shape of
//! the request** (the numbers inside their ranges, the poster's label, base64, bytes and size) is
//! judged first, before any connection is taken, and answers 400 to whoever sent it: it reads the
//! body and nothing else, so it says nothing about any file. The checks that **read the file** (is
//! its stored type a video type, do its first bytes say so) come after the authorization and answer
//! 400 only to the file's own uploader, who knows what they uploaded. (A body the JSON reader cannot
//! use never gets here: the framework answers 400, 415 or 422 first, and the member-write budget
//! sits in front of all of it.)
//!
//! ## What is not here
//!
//! * **No SQL, no parser.** Every statement is `momo_messaging::attachment_media`'s and the server
//!   does not look inside the video (see that module's header).
//! * **No new archive call.** The container check reads the first bytes through the same
//!   [`momo_drive::DriveArchive::file_range`] the content route reads from, resolved against the
//!   row's size exactly as that route does: twelve bytes at most, whatever the object's size, and
//!   no archive lock held while they stream.
//! * **No change to `routes::attachments`.** `content` is another slice's (C3, `Range`); the refusal
//!   sentences this module repeats are held equal to it by a test over real HTTP.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use futures::StreamExt;
use momo_auth::Principal;
use momo_drive::{ByteRange, DriveArchive, DriveError, MAX_ATTACHMENT_BYTES};
use momo_messaging::{
    is_attachment_channel_member, load_attachment_in_tx, load_poster_in_tx,
    load_readable_attachment_in_tx, may_hold_media, set_attachment_media_in_tx,
    validate_image_declaration, validate_media_declaration, validate_poster, Attachment,
    AttachmentMedia, MediaRejected, MediaWrite, MEDIA_PREFIX_BYTES,
};
use serde::{Deserialize, Deserializer};

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

/// `PUT …/media` request (openapi `SetAttachmentMediaRequest`, a `oneOf`).
///
/// `kind` decides which closed shape the body must be: `"image"` is an [`ImageMediaRequest`]; absent or
/// `"video"` is a [`VideoMediaRequest`] (a client older than ADR-0151 증보 9 sends no `kind`), and any
/// other `kind` is that same shape with a `kind` it does not accept, so it is refused like a key the
/// route does not know. A body the JSON reader cannot use never gets further: the framework answers
/// 400, 415 or 422 first (this type's errors are data errors, so 422).
#[derive(Debug)]
pub enum SetAttachmentMediaRequest {
    Video(VideoMediaRequest),
    Image(ImageMediaRequest),
}

impl<'de> Deserialize<'de> for SetAttachmentMediaRequest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        // `"image"` selects the picture's shape. **Everything else is the video's**, whose own `kind`
        // accepts nothing but `"video"` (or no `kind` at all): that one field is what turns an unknown
        // word, another case or another type away, so this choice has no second copy of the rule.
        if value.get("kind").is_some_and(|kind| kind == "image") {
            serde_json::from_value(value)
                .map(Self::Image)
                .map_err(D::Error::custom)
        } else {
            serde_json::from_value(value)
                .map(Self::Video)
                .map_err(D::Error::custom)
        }
    }
}

impl SetAttachmentMediaRequest {
    /// Step 1, the **shape** of the request: the numbers inside their ranges and, for a video, the
    /// poster's label, base64, bytes and size. Reads the body and nothing else.
    fn into_write(self) -> Result<MediaWrite, MediaRejected> {
        match self {
            Self::Video(video) => {
                let declaration =
                    validate_media_declaration(video.duration_ms, video.width, video.height)?;
                let poster = video
                    .poster
                    .as_ref()
                    .map(|poster| validate_poster(&poster.mime, &poster.data_base64))
                    .transpose()?;
                Ok(MediaWrite::Video {
                    declaration,
                    poster,
                })
            }
            Self::Image(image) => Ok(MediaWrite::Image(validate_image_declaration(
                image.width,
                image.height,
            )?)),
        }
    }
}

/// The video shape.
///
/// The three numbers are integers: a fractional `durationMs` is a client that did not round, and
/// is refused as a malformed body rather than truncated. `poster` may be absent (a device that could
/// measure the video but not take a frame): the media then has no poster and says so (`hasPoster`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoMediaRequest {
    /// Absent, or exactly `"video"` (checked by the enum's reader before this struct is read).
    #[serde(default)]
    #[allow(dead_code)]
    kind: Option<VideoKind>,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    #[serde(default)]
    pub poster: Option<PosterRequest>,
}

/// The picture shape (ADR-0151 증보 9): a size and nothing else. A photo or GIF has no length and no
/// poster, so naming one is a key the route does not know.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageMediaRequest {
    #[allow(dead_code)]
    kind: ImageKind,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum VideoKind {
    Video,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ImageKind {
    Image,
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
/// Sets (or replaces, whole) the length, size and poster of a video — or the size of a photo or GIF
/// (ADR-0151 증보 9) — that the caller uploaded and has not sent yet. Order, and why (the same four
/// steps for both kinds):
///
/// 1. the **shape** of the request, before any connection is taken — it needs nothing from the
///    database and the answer to it is the caller's own business;
/// 2. **who and what**: the content route's membership and readability, then [`may_hold_media`];
///    any failure is the flat 404 (a non-member's is the 403);
/// 3. **the file**: a stored type from the kind's closed list (the three video types, or the four
///    picture types), and the object's first bytes — read outside any transaction, because holding a
///    Postgres connection across an archive round trip is how a slow upstream becomes a pool outage;
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
    let write = request.into_write().map_err(rejected)?;

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
    write.require_mime(&found.mime).map_err(rejected)?;
    let prefix = first_bytes(&*state.drive, &found, &drive_file_id).await?;
    write
        .magic_matches(&found.mime, &prefix)
        .map_err(rejected)?;

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
                    &write,
                )
                .await?;
                Ok(Ok(media))
            })
        })
        .await;
    Ok(Json(settle_db("attachment_media.set", written)?))
}

/// The first [`MEDIA_PREFIX_BYTES`] bytes of the object (fewer when it is shorter), by the archive's
/// range read: the range is resolved against **the row's** size — the archive is never asked for a
/// byte past the end — and the archive's own idea of the length must be the row's, or the read is
/// refused with the 502 the content route gives the same disagreement.
///
/// An empty object has no range to read and no container magic either: it answers no bytes, and the
/// caller turns that into the 400 for bytes that are not the video type they are labelled as.
async fn first_bytes(
    drive: &dyn DriveArchive,
    attachment: &Attachment,
    drive_file_id: &str,
) -> Result<Vec<u8>, ApiError> {
    let Some(last_byte) = u64::try_from(attachment.size_bytes)
        .ok()
        .and_then(|size| size.checked_sub(1))
    else {
        return Ok(Vec::new());
    };
    let range = ByteRange::new(0, last_byte.min(MEDIA_PREFIX_BYTES as u64 - 1))
        .ok_or_else(|| drive_error(DriveError::UpstreamFailure))?;
    // The ceiling, not any effective limit: a file that is complete stays readable whatever an
    // operator later lowers what may be uploaded (ADR-0151 증보 5 D1).
    let mut archived = drive
        .file_range(drive_file_id, range, MAX_ATTACHMENT_BYTES)
        .await
        .map_err(drive_error)?;
    if archived.total_size_bytes != attachment.size_bytes {
        tracing::warn!(
            row_bytes = attachment.size_bytes,
            archive_bytes = archived.total_size_bytes,
            "attachment media refused: the archive's length disagrees with the row"
        );
        return Err(drive_error(DriveError::UpstreamFailure));
    }
    let mut prefix = Vec::with_capacity(MEDIA_PREFIX_BYTES);
    while let Some(chunk) = archived.body.next().await {
        prefix.extend_from_slice(&chunk.map_err(drive_error)?);
        if prefix.len() >= MEDIA_PREFIX_BYTES {
            break;
        }
    }
    prefix.truncate(MEDIA_PREFIX_BYTES);
    Ok(prefix)
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/poster`
///
/// The poster of a video, to everyone the content route would serve that video to, in its own words:
/// a non-member's 403, and one flat 404 for everything unreadable — **and the same headers**
/// (`Content-Disposition: attachment`, `nosniff`, `Cache-Control: private, no-store, no-transform`:
/// the proxy serves caller-supplied bytes from the API's own origin, so a picture is a download to a
/// browser that is pointed at it, never a page, and an edge is asked not to rewrite it). The one
/// header of the content route this answer leaves out is `Accept-Ranges`: it has no ranges to offer.
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
        .header(header::CACHE_CONTROL, "private, no-store, no-transform")
        .body(Body::from(poster.bytes))
        .map_err(|error| ApiError::internal("attachment_media.poster.response", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
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

    fn request(body: serde_json::Value) -> Result<SetAttachmentMediaRequest, serde_json::Error> {
        serde_json::from_value(body)
    }

    #[test]
    fn the_request_is_closed_and_its_poster_is_optional() {
        let SetAttachmentMediaRequest::Video(full) = request(serde_json::json!({
            "durationMs": 4200, "width": 1280, "height": 720,
            "poster": {"mime": "image/jpeg", "dataBase64": "AAAA"}
        }))
        .expect("a full request") else {
            panic!("a body with a length is a video");
        };
        assert!(full.poster.is_some());
        let SetAttachmentMediaRequest::Video(bare) = request(serde_json::json!({
            "durationMs": 4200, "width": 1280, "height": 720
        }))
        .expect("a request without a poster") else {
            panic!("a body with a length is a video");
        };
        assert!(bare.poster.is_none());
        // an unknown key is a client that means something the server does not do
        assert!(request(serde_json::json!({
            "durationMs": 1, "width": 1, "height": 1, "kind": "audio"
        }))
        .is_err());
        assert!(request(serde_json::json!({
            "durationMs": 1, "width": 1, "height": 1, "colour": "red"
        }))
        .is_err());
        // and a fractional duration is not rounded for the client
        assert!(request(serde_json::json!({
            "durationMs": 1.5, "width": 1, "height": 1
        }))
        .is_err());
        // a video missing a number is not a body this route can use
        assert!(request(serde_json::json!({"width": 1, "height": 1})).is_err());
    }

    /// ADR-0151 증보 9: `kind` is the discriminator. A video may name itself or say nothing (a client
    /// older than the amendment sends none); a picture must name itself and may carry nothing else.
    #[test]
    fn the_kind_picks_one_of_two_closed_shapes() {
        // the picture
        assert!(matches!(
            request(serde_json::json!({"kind": "image", "width": 4032, "height": 3024})),
            Ok(SetAttachmentMediaRequest::Image(_))
        ));
        // a video that names itself is the same video
        assert!(matches!(
            request(serde_json::json!({
                "kind": "video", "durationMs": 1, "width": 1, "height": 1
            })),
            Ok(SetAttachmentMediaRequest::Video(_))
        ));
        // a picture with a length or a poster is a key the route does not know: the picture has neither
        for stray in [
            serde_json::json!({"kind": "image", "width": 1, "height": 1, "durationMs": 5}),
            serde_json::json!({
                "kind": "image", "width": 1, "height": 1,
                "poster": {"mime": "image/jpeg", "dataBase64": "AAAA"}
            }),
            serde_json::json!({"kind": "image", "width": 1, "height": 1, "hasPoster": false}),
        ] {
            assert!(request(stray.clone()).is_err(), "{stray}");
        }
        // a picture needs both numbers, integers
        for lacking in [
            serde_json::json!({"kind": "image", "width": 1}),
            serde_json::json!({"kind": "image", "height": 1}),
            serde_json::json!({"kind": "image"}),
            serde_json::json!({"kind": "image", "width": 1.5, "height": 1}),
            serde_json::json!({"kind": "image", "width": "640", "height": 1}),
        ] {
            assert!(request(lacking.clone()).is_err(), "{lacking}");
        }
        // no `kind` is a video, so a picture's two numbers alone are a video missing its length
        assert!(request(serde_json::json!({"width": 640, "height": 480})).is_err());
        // any other `kind` — another word, another case, another type — is refused
        for kind in [
            serde_json::json!("audio"),
            serde_json::json!("Image"),
            serde_json::json!("IMAGE"),
            serde_json::json!(""),
            serde_json::json!(null),
            serde_json::json!(1),
            serde_json::json!(["image"]),
        ] {
            assert!(
                request(serde_json::json!({"kind": kind, "width": 1, "height": 1})).is_err(),
                "{kind}"
            );
        }
        // not an object at all
        assert!(request(serde_json::json!([1, 2])).is_err());
        assert!(request(serde_json::json!("image")).is_err());
    }

    /// The shape step turns a usable body into the write the later steps ask questions of, and
    /// range-checks it: a picture's numbers by the same bound a video's side is held to.
    #[test]
    fn the_shape_step_builds_the_write_and_range_checks_it() {
        let write = |body| request(body).expect("a body").into_write();
        assert_eq!(
            write(serde_json::json!({"kind": "image", "width": 4032, "height": 3024})),
            Ok(MediaWrite::Image(momo_messaging::ImageDeclaration {
                width: 4032,
                height: 3024
            }))
        );
        for (w, h) in [(0, 10), (10, 0), (16_385, 10), (10, 16_385), (-5, 10)] {
            assert_eq!(
                write(serde_json::json!({"kind": "image", "width": w, "height": h})),
                Err(MediaRejected::Dimensions),
                "{w}x{h}"
            );
        }
        assert_eq!(
            write(serde_json::json!({"kind": "image", "width": 16_384, "height": 16_384}))
                .map(|write| write.kind()),
            Ok("image")
        );
        // the video's own checks are unchanged
        assert_eq!(
            write(serde_json::json!({"durationMs": 0, "width": 1, "height": 1})),
            Err(MediaRejected::Duration)
        );
        assert_eq!(
            write(serde_json::json!({"durationMs": 1, "width": 1, "height": 1}))
                .map(|write| write.kind()),
            Ok("video")
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

    /// An archive that records the one range it was asked for and answers a canned object.
    #[derive(Debug)]
    struct RangeProbe {
        total_size_bytes: i64,
        bytes: Vec<u8>,
        asked: std::sync::Mutex<Vec<(u64, u64)>>,
        fail_after: Option<usize>,
    }

    #[async_trait::async_trait]
    impl DriveArchive for RangeProbe {
        async fn create_resumable_upload(
            &self,
            _channel_id: Uuid,
            _name: &str,
            _mime: &str,
            _size_bytes: i64,
        ) -> Result<momo_drive::DriveUploadSession, DriveError> {
            Err(DriveError::Unavailable)
        }

        async fn file_metadata(&self, _file_id: &str) -> Result<momo_drive::DriveFile, DriveError> {
            Err(DriveError::Unavailable)
        }

        async fn file_content(
            &self,
            _file_id: &str,
            _max_bytes: i64,
        ) -> Result<momo_drive::DriveContent, DriveError> {
            panic!("the first bytes are read by the range read, never by opening the whole object");
        }

        async fn file_range(
            &self,
            _file_id: &str,
            range: ByteRange,
            _max_bytes: i64,
        ) -> Result<momo_drive::DriveRangeContent, DriveError> {
            self.asked
                .lock()
                .expect("asked")
                .push((range.start(), range.end()));
            let wanted = self.bytes[range.start() as usize..=range.end() as usize].to_vec();
            let items: Vec<Result<axum::body::Bytes, DriveError>> = match self.fail_after {
                Some(n) => vec![
                    Ok(axum::body::Bytes::from(wanted[..n].to_vec())),
                    Err(DriveError::UpstreamFailure),
                ],
                None => vec![Ok(axum::body::Bytes::from(wanted))],
            };
            Ok(momo_drive::DriveRangeContent {
                total_size_bytes: self.total_size_bytes,
                body: futures::stream::iter(items).boxed(),
            })
        }
    }

    fn row_of_size(size_bytes: i64) -> Attachment {
        Attachment {
            id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            uploader_member_id: Uuid::from_u128(3),
            message_id: None,
            drive_file_id: Some("f".into()),
            name: "clip.mp4".into(),
            mime: "video/mp4".into(),
            size_bytes,
            status: "complete".into(),
            created_at: chrono::Utc::now(),
        }
    }

    fn probe(total: i64, len: usize, fail_after: Option<usize>) -> RangeProbe {
        RangeProbe {
            total_size_bytes: total,
            bytes: (0..len).map(|i| i as u8).collect(),
            asked: std::sync::Mutex::new(Vec::new()),
            fail_after,
        }
    }

    /// The prefix is read by one range read **resolved against the row's size** — never past the end of
    /// a short object, never more than twelve bytes of a long one — and a disagreement between the
    /// archive's length and the row's is the content route's own 502, before any byte is used.
    #[tokio::test]
    async fn the_first_bytes_are_one_range_resolved_against_the_rows_size() {
        // a long object: twelve bytes, from the start
        let long = probe(1_000_000, 1_000_000, None);
        let prefix = first_bytes(&long, &row_of_size(1_000_000), "f")
            .await
            .expect("prefix");
        assert_eq!(prefix, (0..12u8).collect::<Vec<_>>());
        assert_eq!(*long.asked.lock().unwrap(), vec![(0, 11)]);
        // exactly twelve bytes
        let exact = probe(12, 12, None);
        assert_eq!(
            first_bytes(&exact, &row_of_size(12), "f")
                .await
                .expect("prefix")
                .len(),
            12
        );
        assert_eq!(*exact.asked.lock().unwrap(), vec![(0, 11)]);
        // a short object: only the bytes that exist are asked for
        let short = probe(5, 5, None);
        assert_eq!(
            first_bytes(&short, &row_of_size(5), "f")
                .await
                .expect("prefix")
                .len(),
            5
        );
        assert_eq!(*short.asked.lock().unwrap(), vec![(0, 4)]);
        // an empty object has nothing to ask for: the archive is not touched
        let empty = probe(0, 0, None);
        assert!(first_bytes(&empty, &row_of_size(0), "f")
            .await
            .expect("empty")
            .is_empty());
        assert!(empty.asked.lock().unwrap().is_empty());
        // an archive whose length is not the row's is refused (the content route's 502)
        let liar = probe(999, 20, None);
        let refused = first_bytes(&liar, &row_of_size(20), "f")
            .await
            .expect_err("a lying length");
        assert_eq!(refused.status, StatusCode::BAD_GATEWAY);
        // and a body that fails part way is an error, never a short prefix passed off as the whole
        let broken = probe(20, 20, Some(3));
        let failed = first_bytes(&broken, &row_of_size(20), "f")
            .await
            .expect_err("a broken body");
        assert_eq!(failed.status, StatusCode::BAD_GATEWAY);
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
