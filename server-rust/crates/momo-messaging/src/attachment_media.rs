//! Video meta and poster — the `attachment_media` table's every statement (ADR-0151 증보 5 D5,
//! #4673 C5).
//!
//! A phone that picks a video measures its length and size, takes a frame, and sends both before
//! the message goes out; the receiving card then draws at the right shape with a picture in it
//! instead of a grey box. This module is the server's half of that, and its whole stance is one
//! sentence: **the server does not look inside the video.** No parser crate, no ffmpeg, no child
//! process — ADR-0151 증보 4 D7 put the one hostile-format parser this tree has in a cage, and a
//! second one would need the same. What the server checks is what a cheap, bounded read can prove:
//!
//! * the stored mime is one of three video types and the object's first bytes carry that
//!   container's magic number ([`video_magic_matches`]) — a text file labelled `video/mp4` cannot
//!   hold media;
//! * the declared length and size are inside a range ([`validate_media_declaration`]) — the numbers
//!   are the sender's word, so a client clamps what it draws from them;
//! * the poster is an image whose **bytes** say what its label says, whose header says it is small,
//!   and whose size is bounded ([`validate_poster`]). The server reads a header, never decodes, so a
//!   JPEG that is cut off after its header passes — a decoder on the client is what rejects that,
//!   and the risk is a broken picture, not a server one (ADR-0151 증보 5 D5).
//!
//! ## Who may write, and when
//!
//! Only **the uploader**, of a **complete** file that **no message carries yet** ([`may_hold_media`]).
//! Once a message carries the file the numbers are part of what the room saw, so they stop moving.
//! The write takes the attachment row `FOR UPDATE` (the route's second transaction), the same lock the
//! send takes to bind it, so a write and a send of the same file are ordered, never interleaved.
//!
//! ## Where the poster's bytes go
//!
//! Into `attachment_media.poster_bytes` and out through `GET …/poster`, and nowhere else. The page
//! projection ([`crate::attachment::PAGED_ATTACHMENT_JOIN`]), the per-message projection, the realtime
//! frame and the outbox row all carry [`AttachmentMedia`] — numbers and a `hasPoster` flag. A
//! 256 KiB blob in every history page would be the cost of every conversation for the sake of the
//! few cards that show it.

use base64::Engine as _;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::attachment::{Attachment, AttachmentMedia, MEDIA_KIND_VIDEO};
use crate::member_avatar::{image_dimensions, sniff_image_mime};

/// The video types a file may carry media for — a closed list (ADR-0151 증보 5 D5). Growing it is an
/// amendment to the ADR: a new container is a new magic number to check.
pub const VIDEO_MIMES: [&str; 3] = ["video/mp4", "video/quicktime", "video/webm"];

/// 24 hours, in milliseconds. `attachment_media_duration_ck` holds the same bound.
pub const MEDIA_MAX_DURATION_MS: i64 = 86_400_000;

/// The largest declared video side (`attachment_media_dimensions_ck`).
pub const MEDIA_MAX_DIMENSION: i64 = 16_384;

/// The poster types: a photographic frame, so JPEG or WebP. PNG is a screenshot's format and GIF is
/// not a still.
pub const POSTER_MIMES: [&str; 2] = ["image/jpeg", "image/webp"];

/// The largest poster, decoded (`attachment_media_poster_ck`).
pub const POSTER_MAX_BYTES: usize = 256 * 1024;

/// The longest poster side, in pixels (`attachment_media_poster_ck`). A card is a few hundred points
/// wide; 1,280 is a retina phone's width with room to spare.
pub const POSTER_MAX_DIMENSION: u32 = 1_280;

/// How many leading bytes of the object the container check reads: `ftyp` sits at offset 4..8, the
/// EBML magic at 0..4.
pub const VIDEO_PREFIX_BYTES: usize = 12;

/// Why a media declaration, a poster or the object itself was refused. Each is a **400** and each
/// has its own sentence, because the client that sent it can act on which one it was; none of them
/// is reachable by anyone who is not the file's uploader (the authorization precedes them), so the
/// sentences confirm nothing about a file the caller could not already see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MediaRejected {
    #[error("durationMs must be an integer from 1 to 86400000")]
    Duration,
    #[error("width and height must be integers from 1 to 16384")]
    Dimensions,
    #[error("attachment is not a video type that can hold media")]
    NotAVideo,
    #[error("attachment bytes are not the video type they are labelled as")]
    VideoBytes,
    #[error("poster mime must be image/jpeg or image/webp")]
    PosterMime,
    #[error("poster dataBase64 is not valid base64")]
    PosterEncoding,
    #[error("poster must be at most 256 KiB")]
    PosterTooLarge,
    #[error("poster bytes are not the image type they are labelled as")]
    PosterBytes,
    #[error("poster dimensions must be readable and at most 1280x1280")]
    PosterDimensions,
}

/// A poster that passed [`validate_poster`]: the label the bytes proved to be, the header's size,
/// and the bytes themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Poster {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

/// The sender's declared numbers, once they are inside their range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaDeclaration {
    pub duration_ms: i32,
    pub width: i32,
    pub height: i32,
}

/// The decision, in one place, of whether `attachment` may take media from `member_id` **now**:
/// theirs, finished, and not yet on a message. The route asks it in both of its transactions, and a
/// clause removed here loosens both.
///
/// Anything else is the route's flat 404 — the same sentence a missing id gets, so a member cannot
/// tell another's draft from an id that does not exist.
pub fn may_hold_media(attachment: &Attachment, member_id: Uuid) -> bool {
    attachment.uploader_member_id == member_id
        && attachment.status == "complete"
        && attachment.message_id.is_none()
}

/// Range-check the declared length and size. They are a claim, not a measurement: the server
/// cannot know them without decoding the video, which it will not do.
pub fn validate_media_declaration(
    duration_ms: i64,
    width: i64,
    height: i64,
) -> Result<MediaDeclaration, MediaRejected> {
    if !(1..=MEDIA_MAX_DURATION_MS).contains(&duration_ms) {
        return Err(MediaRejected::Duration);
    }
    let side = 1..=MEDIA_MAX_DIMENSION;
    if !side.contains(&width) || !side.contains(&height) {
        return Err(MediaRejected::Dimensions);
    }
    // All three fit an i32: the bounds above are well inside it.
    Ok(MediaDeclaration {
        duration_ms: duration_ms as i32,
        width: width as i32,
        height: height as i32,
    })
}

/// Whether the file's stored mime is a video type that may carry media. Asked **before** the object
/// is read, so a document never costs a read.
pub fn require_video_mime(stored_mime: &str) -> Result<(), MediaRejected> {
    if VIDEO_MIMES.contains(&stored_mime) {
        Ok(())
    } else {
        Err(MediaRejected::NotAVideo)
    }
}

/// Whether the object's leading bytes are the container its stored mime names: an ISO base media
/// `ftyp` box at offset 4 for MP4 and QuickTime, the EBML header for WebM. A file whose label and
/// bytes disagree cannot hold media. (An old `.mov` that does not open with `ftyp` is turned away
/// too: it stays a download card, which is what it was.)
pub fn video_magic_matches(stored_mime: &str, prefix: &[u8]) -> Result<(), MediaRejected> {
    let matches = match stored_mime {
        "video/mp4" | "video/quicktime" => prefix.get(4..8) == Some(b"ftyp".as_slice()),
        "video/webm" => prefix.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]),
        _ => return Err(MediaRejected::NotAVideo),
    };
    if matches {
        Ok(())
    } else {
        Err(MediaRejected::VideoBytes)
    }
}

/// The base64 length of the largest poster. Anything longer is refused before it is decoded.
const POSTER_MAX_BASE64_CHARS: usize = POSTER_MAX_BYTES.div_ceil(3) * 4;

/// Check a poster by its bytes, not its label (ADR-0151 증보 5 D5): the label must be one of the
/// two poster types, the encoding strict base64, the decoded size at most 256 KiB, the **magic
/// number** the very type the label names, and the **header's** pixel size readable and at most
/// 1,280 on a side. Nothing is decoded.
pub fn validate_poster(declared_mime: &str, data_base64: &str) -> Result<Poster, MediaRejected> {
    let declared = declared_mime.trim().to_ascii_lowercase();
    let Some(label) = POSTER_MIMES.iter().find(|mime| **mime == declared) else {
        return Err(MediaRejected::PosterMime);
    };
    if data_base64.len() > POSTER_MAX_BASE64_CHARS {
        return Err(MediaRejected::PosterTooLarge);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| MediaRejected::PosterEncoding)?;
    if bytes.len() > POSTER_MAX_BYTES {
        return Err(MediaRejected::PosterTooLarge);
    }
    if sniff_image_mime(&bytes) != Some(*label) {
        return Err(MediaRejected::PosterBytes);
    }
    let (width, height) = image_dimensions(label, &bytes).ok_or(MediaRejected::PosterDimensions)?;
    if width == 0 || height == 0 || width > POSTER_MAX_DIMENSION || height > POSTER_MAX_DIMENSION {
        return Err(MediaRejected::PosterDimensions);
    }
    Ok(Poster {
        mime: label,
        width,
        height,
        bytes,
    })
}

/// Write (or replace) the media of one attachment, with its audit record, in the caller's
/// transaction. The caller has locked the attachment row `FOR UPDATE` and asked [`may_hold_media`].
///
/// **A replace is a whole replace**: a second write without a poster clears the first one's poster,
/// so the row always describes the last request and never a mix of two. The audit row names the
/// kind and whether there is a poster, not the numbers and never the picture.
#[allow(clippy::too_many_arguments)]
pub async fn set_attachment_media_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    attachment_id: Uuid,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
    declaration: MediaDeclaration,
    poster: Option<&Poster>,
) -> Result<AttachmentMedia, DbError> {
    let replaced: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM attachment_media \
                        WHERE workspace_id = $1 AND attachment_id = $2)",
    )
    .bind(workspace_id)
    .bind(attachment_id)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query(
        "INSERT INTO attachment_media \
           (workspace_id, attachment_id, duration_ms, width, height, \
            poster_mime, poster_width, poster_height, poster_bytes) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (workspace_id, attachment_id) DO UPDATE SET \
            duration_ms = EXCLUDED.duration_ms, width = EXCLUDED.width, \
            height = EXCLUDED.height, poster_mime = EXCLUDED.poster_mime, \
            poster_width = EXCLUDED.poster_width, poster_height = EXCLUDED.poster_height, \
            poster_bytes = EXCLUDED.poster_bytes",
    )
    .bind(workspace_id)
    .bind(attachment_id)
    .bind(declaration.duration_ms)
    .bind(declaration.width)
    .bind(declaration.height)
    .bind(poster.map(|poster| poster.mime))
    .bind(poster.map(|poster| poster.width as i32))
    .bind(poster.map(|poster| poster.height as i32))
    .bind(poster.map(|poster| poster.bytes.as_slice()))
    .execute(&mut *conn)
    .await?;

    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "attachment.media_set")
            .by(actor_member_id)
            .about_optional(None)
            .target("attachment", attachment_id)
            .via_token(via_token_id)
            .with_schema(
                "momo.attachment.media_set.v1",
                json!({
                    "channel_id": channel_id.to_string(),
                    "kind": MEDIA_KIND_VIDEO,
                    "has_poster": poster.is_some(),
                    "replaced": replaced,
                }),
            ),
    )
    .await?;

    Ok(AttachmentMedia {
        kind: MEDIA_KIND_VIDEO.to_string(),
        duration_ms: i64::from(declaration.duration_ms),
        width: i64::from(declaration.width),
        height: i64::from(declaration.height),
        has_poster: poster.is_some(),
    })
}

/// A stored poster, ready to be served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosterImage {
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// The poster of one attachment, or `None` when it has no media or none was sent. **Authorization is
/// the caller's** (`is_attachment_channel_member` and `load_readable_attachment_in_tx`, the content
/// route's own pair) and this statement trusts it: it is the only place the poster's bytes are read.
pub async fn load_poster_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    attachment_id: Uuid,
) -> Result<Option<PosterImage>, DbError> {
    let row = sqlx::query(
        "SELECT poster_mime, poster_bytes FROM attachment_media \
          WHERE workspace_id = $1 AND attachment_id = $2 AND poster_bytes IS NOT NULL",
    )
    .bind(workspace_id)
    .bind(attachment_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.map(|row| {
        Ok(PosterImage {
            mime: row.try_get("poster_mime")?,
            bytes: row.try_get("poster_bytes")?,
        })
    })
    .transpose()
    .map_err(|error: sqlx::Error| DbError::from(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
    use std::io::Cursor;

    fn encoded(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let buffer = ImageBuffer::from_pixel(width, height, Rgb([30u8, 90, 200]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(buffer)
            .write_to(&mut out, format)
            .expect("encode");
        out.into_inner()
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn a_declaration_is_range_checked_at_both_ends() {
        let ok = |d, w, h| validate_media_declaration(d, w, h);
        assert_eq!(
            ok(1, 1, 1),
            Ok(MediaDeclaration {
                duration_ms: 1,
                width: 1,
                height: 1
            })
        );
        assert_eq!(
            ok(86_400_000, 16_384, 16_384),
            Ok(MediaDeclaration {
                duration_ms: 86_400_000,
                width: 16_384,
                height: 16_384
            })
        );
        for duration in [0, -1, 86_400_001, i64::MAX, i64::MIN] {
            assert_eq!(
                ok(duration, 640, 360),
                Err(MediaRejected::Duration),
                "{duration}"
            );
        }
        for (w, h) in [(0, 360), (640, 0), (16_385, 360), (640, 16_385), (-1, 360)] {
            assert_eq!(ok(1_000, w, h), Err(MediaRejected::Dimensions), "{w}x{h}");
        }
    }

    #[test]
    fn only_the_three_video_types_may_hold_media() {
        for mime in VIDEO_MIMES {
            assert_eq!(require_video_mime(mime), Ok(()), "{mime}");
        }
        for mime in [
            "video/x-matroska",
            "video/ogg",
            "audio/mp4",
            "image/gif",
            "application/pdf",
            "text/html",
            "VIDEO/MP4",
        ] {
            assert_eq!(
                require_video_mime(mime),
                Err(MediaRejected::NotAVideo),
                "{mime}"
            );
        }
    }

    #[test]
    fn the_container_magic_is_the_one_the_stored_type_names() {
        let mp4 = b"\0\0\0\x18ftypmp42\0\0\0\0";
        let webm = b"\x1A\x45\xDF\xA3\x9F\x42\x86\x81\x01\0\0\0";
        assert_eq!(video_magic_matches("video/mp4", mp4), Ok(()));
        assert_eq!(video_magic_matches("video/quicktime", mp4), Ok(()));
        assert_eq!(video_magic_matches("video/webm", webm), Ok(()));
        // a label that does not match the bytes, either way round
        assert_eq!(
            video_magic_matches("video/webm", mp4),
            Err(MediaRejected::VideoBytes)
        );
        assert_eq!(
            video_magic_matches("video/mp4", webm),
            Err(MediaRejected::VideoBytes)
        );
        // text, an empty object, an object shorter than the box tag
        for prefix in [&b"hello, this is text"[..], &b""[..], &b"\0\0\0\x18ft"[..]] {
            assert_eq!(
                video_magic_matches("video/mp4", prefix),
                Err(MediaRejected::VideoBytes),
                "{prefix:?}"
            );
        }
        // `ftyp` at the wrong offset is not the box
        assert_eq!(
            video_magic_matches("video/mp4", b"ftyp\0\0\0\x18mp42"),
            Err(MediaRejected::VideoBytes)
        );
        assert_eq!(
            video_magic_matches("application/pdf", mp4),
            Err(MediaRejected::NotAVideo)
        );
    }

    #[test]
    fn a_real_jpeg_and_a_real_webp_poster_pass_with_their_header_size() {
        let jpeg = encoded(ImageFormat::Jpeg, 320, 180);
        let poster = validate_poster("image/jpeg", &b64(&jpeg)).expect("a jpeg poster");
        assert_eq!(
            (poster.mime, poster.width, poster.height),
            ("image/jpeg", 320, 180)
        );
        assert_eq!(poster.bytes, jpeg);

        let webp = encoded(ImageFormat::WebP, 1280, 720);
        let poster = validate_poster(" IMAGE/WEBP ", &b64(&webp)).expect("a webp poster");
        assert_eq!(
            (poster.mime, poster.width, poster.height),
            ("image/webp", 1280, 720)
        );
    }

    #[test]
    fn a_poster_is_judged_by_its_bytes_and_not_by_its_label() {
        let jpeg = encoded(ImageFormat::Jpeg, 64, 64);
        let png = encoded(ImageFormat::Png, 64, 64);
        let webp = encoded(ImageFormat::WebP, 64, 64);
        let gif = b"GIF89a\x40\x00\x40\x00\x00\x00\x00;".to_vec();
        let html = b"<html><script>alert(1)</script></html>".to_vec();
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'/>".to_vec();
        // twelve bytes of a web page where RIFF….WEBP belongs, then a VP8X tag and a 320 x 180 canvas
        let mut wearing_a_header = b"<html><head>VP8X".to_vec();
        wearing_a_header
            .extend_from_slice(&[10, 0, 0, 0, 0, 0, 0, 0, 0x3F, 0x01, 0x00, 0xB3, 0, 0]);
        assert_eq!(
            validate_poster("image/webp", &b64(&wearing_a_header)),
            Err(MediaRejected::PosterBytes),
            "a web page that carries a WebP chunk tag: only the magic number tells"
        );
        for (what, bytes) in [
            ("png", &png),
            ("gif", &gif),
            ("html", &html),
            ("svg", &svg),
            ("webp", &webp),
        ] {
            assert_eq!(
                validate_poster("image/jpeg", &b64(bytes)),
                Err(MediaRejected::PosterBytes),
                "{what} labelled as a jpeg"
            );
        }
        assert_eq!(
            validate_poster("image/webp", &b64(&jpeg)),
            Err(MediaRejected::PosterBytes),
            "a jpeg labelled as a webp"
        );
        // the label itself must be one of the two
        for label in [
            "image/png",
            "image/gif",
            "image/svg+xml",
            "text/html",
            "",
            "image/jpg",
        ] {
            assert_eq!(
                validate_poster(label, &b64(&jpeg)),
                Err(MediaRejected::PosterMime),
                "{label:?}"
            );
        }
        // nothing at all
        assert_eq!(
            validate_poster("image/jpeg", ""),
            Err(MediaRejected::PosterBytes)
        );
    }

    #[test]
    fn a_jpeg_cut_off_before_its_frame_header_has_no_size_and_is_refused() {
        let jpeg = encoded(ImageFormat::Jpeg, 64, 64);
        // SOI + APP0 only: the size lives in the SOF segment, which is not there
        let cut = &jpeg[..jpeg.len().min(20)];
        assert_eq!(
            validate_poster("image/jpeg", &b64(cut)),
            Err(MediaRejected::PosterDimensions)
        );
        assert_eq!(
            validate_poster("image/jpeg", &b64(&[0xFF, 0xD8, 0xFF])),
            Err(MediaRejected::PosterDimensions)
        );
    }

    #[test]
    fn a_poster_has_a_size_ceiling_in_bytes_and_in_pixels() {
        // 1,281 pixels wide: one over
        let wide = encoded(ImageFormat::Jpeg, 1_281, 16);
        assert_eq!(
            validate_poster("image/jpeg", &b64(&wide)),
            Err(MediaRejected::PosterDimensions)
        );
        let tall = encoded(ImageFormat::Jpeg, 16, 1_281);
        assert_eq!(
            validate_poster("image/jpeg", &b64(&tall)),
            Err(MediaRejected::PosterDimensions)
        );
        // exactly 256 KiB passes the size check (padding after the image is allowed: nothing decodes it)
        let mut full = encoded(ImageFormat::Jpeg, 64, 64);
        full.resize(POSTER_MAX_BYTES, 0);
        assert!(validate_poster("image/jpeg", &b64(&full)).is_ok());
        // one byte more does not
        full.push(0);
        assert_eq!(
            validate_poster("image/jpeg", &b64(&full)),
            Err(MediaRejected::PosterTooLarge)
        );
        // and an encoded string longer than any permitted poster is refused before it is decoded
        assert_eq!(
            validate_poster("image/jpeg", &"A".repeat(POSTER_MAX_BASE64_CHARS + 4)),
            Err(MediaRejected::PosterTooLarge)
        );
    }

    #[test]
    fn the_encoding_is_strict_base64() {
        // the control: the encoder's own output is accepted
        let jpeg = encoded(ImageFormat::Jpeg, 16, 16);
        assert!(validate_poster("image/jpeg", &b64(&jpeg)).is_ok());
        // every one of these is a different dialect or a wrapper, and none is this wire: the
        // alphabet is the standard one, the padding is required, nothing else is allowed in
        let good = b64(&jpeg);
        for (what, bad) in [
            ("trailing newline", format!("{good}\n")),
            ("leading space", format!(" {good}")),
            ("a data: url", format!("data:image/jpeg;base64,{good}")),
            ("the url-safe alphabet", "-_-_".to_string()),
            ("missing padding", "QUI".to_string()),
            ("padding that is too long", "QUJD====".to_string()),
            ("a stray character", "QU*D".to_string()),
        ] {
            assert_eq!(
                validate_poster("image/jpeg", &bad),
                Err(MediaRejected::PosterEncoding),
                "{what}"
            );
        }
    }

    #[test]
    fn media_is_the_uploaders_to_set_on_a_finished_unsent_file_only() {
        let uploader = Uuid::from_u128(1);
        let attachment = |uploader_member_id, status: &str, message_id| Attachment {
            id: Uuid::from_u128(9),
            channel_id: Uuid::from_u128(2),
            uploader_member_id,
            message_id,
            drive_file_id: Some("f".into()),
            name: "clip.mp4".into(),
            mime: "video/mp4".into(),
            size_bytes: 10,
            status: status.into(),
            created_at: chrono::Utc::now(),
        };
        assert!(may_hold_media(
            &attachment(uploader, "complete", None),
            uploader
        ));
        assert!(!may_hold_media(
            &attachment(Uuid::from_u128(2), "complete", None),
            uploader
        ));
        assert!(!may_hold_media(
            &attachment(uploader, "pending", None),
            uploader
        ));
        assert!(!may_hold_media(
            &attachment(uploader, "failed", None),
            uploader
        ));
        assert!(!may_hold_media(
            &attachment(uploader, "complete", Some(Uuid::from_u128(5))),
            uploader
        ));
    }
}
