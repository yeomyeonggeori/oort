//! Member avatar media — the `member_avatar_media` table's every statement
//! (ADR-0161 증보 2026-10-01, #3277).
//!
//! This is `workspace_avatar.rs` re-aimed at a member. Same transport (ADR-0151:
//! bytes bypass this server going up via a Drive resumable session, proxied
//! coming down after an authorization check), same lifecycle
//! (`pending → complete | failed`), same tenant boundary (RLS FORCE, migration
//! 111). What differs, each a decision of the amendment:
//!
//! * **The binding is the uploader.** Every function that writes takes the
//!   *caller's* member id and nothing else — there is no "target member"
//!   parameter anywhere in this module's write surface. Self-only is therefore
//!   structural, and migration 111's composite FK makes a pointer at someone
//!   else's media unrepresentable even if a caller were wrong.
//! * **The mime is an allow-list**, not `image/*`: PNG, JPEG, WebP, GIF. SVG is
//!   refused (a document that can carry script, served inline from this origin).
//! * **The bytes are sniffed.** The declared mime and the Drive-reported mime are
//!   both client-supplied; [`sniff_image_mime`] reads the file's magic number so
//!   `complete` can refuse a payload whose first bytes are not the image it
//!   claims to be.

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::workspace_avatar::AvatarSpecInvalid;

/// The mimes a member avatar may carry. Agrees with `member_avatar_mime_ck`
/// (migration 111).
pub const MEMBER_AVATAR_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// How many leading bytes [`sniff_image_mime`] needs (WebP: `RIFF` + size +
/// `WEBP`).
pub const IMAGE_SNIFF_PREFIX_BYTES: usize = 12;

/// How many leading bytes `complete` reads to find the dimensions. PNG, GIF and
/// WebP keep them in the first 30 bytes; a JPEG's SOF marker can sit behind
/// EXIF/ICC/XMP segments (each up to 64 KiB), so the window is generous. A JPEG
/// whose SOF is not inside it is "unparsable" and refused.
pub const IMAGE_HEADER_PREFIX_BYTES: usize = 256 * 1024;

/// The decode-bomb ceiling: a width or height above this is refused. 4096² is
/// 64 MiB of RGBA once decoded — a 5 MiB file may not cost a client more.
pub const MAX_MEMBER_AVATAR_DIMENSION: u32 = 4096;

/// Upload sessions one member may open per hour, whatever became of them
/// (`pending`, `failed` and `complete` all count). The gate and the row it
/// reserves share one transaction behind a member-row lock, so a burst cannot
/// overshoot.
pub const MAX_MEMBER_AVATAR_UPLOADS_PER_HOUR: i64 = 20;

const MEMBER_AVATAR_COLS: &str = "id, workspace_id, member_id, drive_file_id, \
                                  name, mime, size_bytes, status, created_at";

/// One member-avatar media row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberAvatarMedia {
    pub id: Uuid,
    pub workspace_id: Uuid,
    /// The owner — the only member who may complete or point at this row.
    pub member_id: Uuid,
    /// Drive's own identifier. Never projected onto the wire (ADR-0151 D3).
    pub drive_file_id: Option<String>,
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Trim, lower-case, and check a member avatar mime against the allow-list.
pub fn validate_member_avatar_mime(raw: &str) -> Result<String, AvatarSpecInvalid> {
    let value = raw.trim().to_ascii_lowercase();
    // `image/jpg` is not a registered type but browsers' file pickers never
    // produce it; refusing keeps the stored set equal to the CHECK.
    if MEMBER_AVATAR_MIMES.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(AvatarSpecInvalid::Mime)
    }
}

/// The image type a byte prefix actually is, by magic number — or `None`.
///
/// Only the four allow-listed formats are recognised, so "sniffed" and
/// "allowed" are the same set by construction.
pub fn sniff_image_mime(prefix: &[u8]) -> Option<&'static str> {
    if prefix.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if prefix.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if prefix.len() >= 12 && &prefix[0..4] == b"RIFF" && &prefix[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Pixel dimensions read from the header bytes alone (no decoding), or `None`
/// when they are absent, truncated or not parsable — which `complete` treats as
/// a refusal, never as "fine".
///
/// `mime` is the (already sniffed) type, so each format's parser only ever sees
/// its own bytes. A zero dimension is `None`.
pub fn image_dimensions(mime: &str, bytes: &[u8]) -> Option<(u32, u32)> {
    let (w, h) = match mime {
        "image/png" => png_dimensions(bytes)?,
        "image/gif" => gif_dimensions(bytes)?,
        "image/webp" => webp_dimensions(bytes)?,
        "image/jpeg" => jpeg_dimensions(bytes)?,
        _ => return None,
    };
    (w > 0 && h > 0).then_some((w, h))
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn le16(b: &[u8]) -> u32 {
    u32::from(u16::from_le_bytes([b[0], b[1]]))
}

fn le24(b: &[u8]) -> u32 {
    u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16)
}

/// PNG: the first chunk must be `IHDR` (length 13), width/height big-endian at 16/20.
fn png_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || &b[12..16] != b"IHDR" || be32(&b[8..12]) != 13 {
        return None;
    }
    Some((be32(&b[16..20]), be32(&b[20..24])))
}

/// GIF: the logical screen descriptor, little-endian u16 at 6/8. (Frame count is
/// not checked — that needs a walk of the whole file; see the ADR's out-of-scope
/// note. The 5 MiB file cap bounds the frame count.)
fn gif_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 10 {
        return None;
    }
    Some((le16(&b[6..8]), le16(&b[8..10])))
}

/// WebP: `RIFF`…`WEBP` then one of `VP8 ` (lossy), `VP8L` (lossless), `VP8X`
/// (extended — the canvas size).
fn webp_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 25 {
        return None;
    }
    // VP8X and VP8 need 30 bytes; VP8L needs 25.
    let at_least_30 = b.len() >= 30;
    match &b[12..16] {
        b"VP8X" if at_least_30 => Some((le24(&b[24..27]) + 1, le24(&b[27..30]) + 1)),
        b"VP8L" => {
            if b[20] != 0x2F {
                return None;
            }
            let bits = u32::from_le_bytes([b[21], b[22], b[23], b[24]]);
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        }
        b"VP8 " if at_least_30 => {
            // frame tag (3 bytes) at 20, start code 9D 01 2A at 23, then two
            // little-endian u16 with the top two bits of each reserved for scale.
            if b[23..26] != [0x9D, 0x01, 0x2A] {
                return None;
            }
            Some((le16(&b[26..28]) & 0x3FFF, le16(&b[28..30]) & 0x3FFF))
        }
        _ => None,
    }
}

/// JPEG: walk the marker segments to the first start-of-frame (any SOFn except
/// DHT/JPG/DAC), height then width big-endian.
fn jpeg_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    if !b.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2;
    loop {
        // Skip fill bytes: a marker is 0xFF followed by a non-0xFF, non-0 byte.
        while *b.get(i)? == 0xFF && *b.get(i + 1)? == 0xFF {
            i += 1;
        }
        if *b.get(i)? != 0xFF {
            return None;
        }
        let marker = *b.get(i + 1)?;
        i += 2;
        match marker {
            0x00 => return None,
            // standalone markers carry no length
            0x01 | 0xD0..=0xD7 => continue,
            // SOS / EOI before any frame header: there is no size to read
            0xD9 | 0xDA => return None,
            _ => {}
        }
        let len = usize::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]));
        if len < 2 {
            return None;
        }
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            if len < 7 {
                return None;
            }
            let height = u32::from(u16::from_be_bytes([*b.get(i + 3)?, *b.get(i + 4)?]));
            let width = u32::from(u16::from_be_bytes([*b.get(i + 5)?, *b.get(i + 6)?]));
            return Some((width, height));
        }
        i += len;
    }
}

fn decode_member_avatar(row: &sqlx::postgres::PgRow) -> Result<MemberAvatarMedia, sqlx::Error> {
    Ok(MemberAvatarMedia {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        member_id: row.try_get("member_id")?,
        drive_file_id: row.try_get("drive_file_id")?,
        name: row.try_get("name")?,
        mime: row.try_get("mime")?,
        size_bytes: row.try_get("size_bytes")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
    })
}

/// Reserve one upload session for the caller, or `None` if they have opened
/// [`MAX_MEMBER_AVATAR_UPLOADS_PER_HOUR`] in the last hour (any status).
///
/// The count and the INSERT share this transaction behind a lock on the
/// caller's own `member` row, so two concurrent requests serialize here and a
/// burst cannot exceed the limit. The row is written as `failed` (the one
/// status allowed without a `drive_file_id`) — a *reservation*: if the Drive
/// session that follows never happens, the row stays `failed`, still counts
/// against the limit, and there is no orphan Drive object to reap. A
/// successful session promotes it with [`activate_member_avatar_upload_in_tx`].
/// `member_id` is the caller: this module cannot reserve for anyone else.
pub async fn reserve_member_avatar_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    name: &str,
    mime: &str,
    size_bytes: i64,
) -> Result<Option<Uuid>, DbError> {
    sqlx::query("SELECT 1 FROM member WHERE id = $1 AND workspace_id = $2 FOR UPDATE")
        .bind(member_id)
        .bind(workspace_id)
        .fetch_optional(&mut *conn)
        .await?;
    let recent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM member_avatar_media \
          WHERE workspace_id = $1 AND member_id = $2 \
            AND created_at > now() - interval '1 hour'",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    if recent >= MAX_MEMBER_AVATAR_UPLOADS_PER_HOUR {
        return Ok(None);
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO member_avatar_media \
           (workspace_id, member_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, 'failed') \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(name)
    .bind(mime)
    .bind(size_bytes)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Some(id))
}

/// Promote a reservation to `pending` once Drive has issued the session, and
/// write the audit record. A no-op error (`false`) if the row is not this
/// caller's unactivated reservation.
#[allow(clippy::too_many_arguments)]
pub async fn activate_member_avatar_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    media_id: Uuid,
    via_token_id: Option<Uuid>,
    drive_file_id: &str,
    name: &str,
    mime: &str,
    size_bytes: i64,
) -> Result<bool, DbError> {
    let promoted = sqlx::query(
        "UPDATE member_avatar_media SET status = 'pending', drive_file_id = $4 \
          WHERE id = $1 AND workspace_id = $2 AND member_id = $3 \
            AND status = 'failed' AND drive_file_id IS NULL",
    )
    .bind(media_id)
    .bind(workspace_id)
    .bind(member_id)
    .bind(drive_file_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if promoted == 0 {
        return Ok(false);
    }
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "member.avatar_upload_started")
            .by(member_id)
            .target("member", member_id)
            .via_token(via_token_id)
            .with_schema(
                "momo.member.avatar_upload_started.v1",
                json!({
                    "media_id": media_id.to_string(),
                    "name": name,
                    "mime": mime,
                    "size_bytes": size_bytes.to_string(),
                }),
            ),
    )
    .await?;
    Ok(true)
}

/// Read one of **the caller's own** media rows, optionally locked. A media id
/// that belongs to another member is simply absent here — the self-only guard of
/// `complete`.
pub async fn load_own_member_avatar_media_in_tx(
    conn: &mut PgConnection,
    media_id: Uuid,
    workspace_id: Uuid,
    member_id: Uuid,
    for_update: bool,
) -> Result<Option<MemberAvatarMedia>, DbError> {
    let lock = if for_update { " FOR UPDATE" } else { "" };
    let sql = format!(
        "SELECT {MEMBER_AVATAR_COLS} FROM member_avatar_media \
          WHERE id = $1 AND workspace_id = $2 AND member_id = $3{lock}"
    );
    let row = sqlx::query(&sql)
        .bind(media_id)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_member_avatar)
        .transpose()
        .map_err(DbError::from)
}

/// A member's *current* avatar media, if set and complete — what the content
/// proxy serves. Joined through `member.avatar_media_id` so a replaced or removed
/// avatar's old row is never served, and filtered to a live member.
pub async fn read_current_member_avatar_media_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<MemberAvatarMedia>, DbError> {
    let sql = "SELECT a.id, a.workspace_id, a.member_id, a.drive_file_id, \
                      a.name, a.mime, a.size_bytes, a.status, a.created_at \
                 FROM member_avatar_media a \
                 JOIN member m ON m.avatar_media_id = a.id AND m.id = a.member_id \
                WHERE m.id = $2 AND m.workspace_id = $1 \
                  AND m.deleted_at IS NULL AND a.status = 'complete'";
    let row = sqlx::query(sql)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_member_avatar)
        .transpose()
        .map_err(DbError::from)
}

/// Move a pending avatar to `complete` or `failed`, and on success re-point **the
/// caller's own** member row at it. The `failed` write is not a rollback: it
/// commits an audited record of the divergence and the caller answers 409 after.
#[allow(clippy::too_many_arguments)]
pub async fn settle_member_avatar_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    media_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    matched: bool,
    expected: (&str, i64),
    actual: (&str, i64),
) -> Result<(), DbError> {
    let status = if matched { "complete" } else { "failed" };
    sqlx::query("UPDATE member_avatar_media SET status = $2 WHERE id = $1")
        .bind(media_id)
        .bind(status)
        .execute(&mut *conn)
        .await?;

    if matched {
        // The re-point: the single act of "replace my avatar". `m.id = $1` is the
        // caller; the composite FK additionally rejects a media row that is not
        // this member's.
        sqlx::query(
            "UPDATE member SET avatar_media_id = $2, updated_at = now() \
              WHERE id = $1 AND workspace_id = $3",
        )
        .bind(member_id)
        .bind(media_id)
        .bind(workspace_id)
        .execute(&mut *conn)
        .await?;
    }

    let action = if matched {
        "member.avatar_updated"
    } else {
        "member.avatar_upload_failed"
    };
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, action)
            .by(member_id)
            .target("member", member_id)
            .via_token(via_token_id)
            .with_schema(
                &format!("momo.{action}.v1"),
                json!({
                    "media_id": media_id.to_string(),
                    "expected_mime": expected.0,
                    "actual_mime": actual.0,
                    "expected_size_bytes": expected.1.to_string(),
                    "actual_size_bytes": actual.1.to_string(),
                }),
            ),
    )
    .await?;
    Ok(())
}

/// Clear the caller's own avatar pointer. Returns whether there was one.
/// Idempotent — a second call is a no-op and writes no audit row. The old media
/// row stays for the Drive-reclaim job (same as workspace avatars).
pub async fn clear_own_member_avatar_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
) -> Result<bool, DbError> {
    let previous: Option<Uuid> = sqlx::query_scalar(
        "UPDATE member m SET avatar_media_id = NULL, updated_at = now() \
          FROM (SELECT id, avatar_media_id FROM member \
                 WHERE id = $1 AND workspace_id = $2 FOR UPDATE) old \
         WHERE m.id = old.id AND old.avatar_media_id IS NOT NULL \
         RETURNING old.avatar_media_id",
    )
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(previous) = previous else {
        return Ok(false);
    };
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "member.avatar_removed")
            .by(member_id)
            .target("member", member_id)
            .via_token(via_token_id)
            .with_schema(
                "momo.member.avatar_removed.v1",
                json!({ "media_id": previous.to_string() }),
            ),
    )
    .await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_raster_mimes_pass_and_svg_does_not() {
        for ok in ["image/png", "IMAGE/JPEG", " image/webp ", "image/gif"] {
            assert!(validate_member_avatar_mime(ok).is_ok(), "{ok:?}");
        }
        for bad in [
            "image/svg+xml",
            "image/jpg",
            "image/heic",
            "image/",
            "application/pdf",
            "text/html",
            "",
        ] {
            assert_eq!(
                validate_member_avatar_mime(bad),
                Err(AvatarSpecInvalid::Mime),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_magic_number_decides_not_the_declaration() {
        assert_eq!(
            sniff_image_mime(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_mime(b"GIF89a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"GIF87a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\x24\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        // Not images — including the two a hostile upload would most like to be.
        assert_eq!(
            sniff_image_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"),
            None
        );
        assert_eq!(sniff_image_mime(b"<!doctype html><script>"), None);
        assert_eq!(sniff_image_mime(b"%PDF-1.7"), None);
        assert_eq!(sniff_image_mime(b"RIFF\x24\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_image_mime(b""), None);
        assert_eq!(
            sniff_image_mime(b"\x89PNG"),
            None,
            "a truncated header is not a PNG"
        );
    }

    // ---- dimensions: one fixture builder per format, so each format's oversize
    // case is a real header, not a mocked number.

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v
    }

    fn gif(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v.extend_from_slice(&[0, 0, 0]);
        v
    }

    fn webp_vp8x(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"RIFF\x1a\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        v.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
        v.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
        v
    }

    fn webp_vp8l(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"RIFF\x1a\0\0\0WEBPVP8L\x05\0\0\0\x2f".to_vec();
        let bits = (w - 1) | ((h - 1) << 14);
        v.extend_from_slice(&bits.to_le_bytes());
        v.push(0);
        v
    }

    fn webp_vp8(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"RIFF\x1a\0\0\0WEBPVP8 \x0a\0\0\0\x10\x02\0\x9d\x01\x2a".to_vec();
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v
    }

    fn jpeg(w: u16, h: u16, sof: u8, leading_segment: usize) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        if leading_segment > 0 {
            // an APPn segment (EXIF-sized) in front of the frame header
            v.extend_from_slice(&[0xFF, 0xE1]);
            v.extend_from_slice(&((leading_segment + 2) as u16).to_be_bytes());
            v.extend(std::iter::repeat_n(0u8, leading_segment));
        }
        v.extend_from_slice(&[0xFF, sof, 0, 17, 8]);
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        v
    }

    #[test]
    fn every_format_reports_its_dimensions() {
        assert_eq!(
            image_dimensions("image/png", &png(640, 480)),
            Some((640, 480))
        );
        assert_eq!(
            image_dimensions("image/gif", &gif(320, 200)),
            Some((320, 200))
        );
        assert_eq!(
            image_dimensions("image/webp", &webp_vp8x(1024, 768)),
            Some((1024, 768))
        );
        assert_eq!(
            image_dimensions("image/webp", &webp_vp8l(300, 200)),
            Some((300, 200))
        );
        assert_eq!(
            image_dimensions("image/webp", &webp_vp8(256, 128)),
            Some((256, 128))
        );
        assert_eq!(
            image_dimensions("image/jpeg", &jpeg(800, 600, 0xC0, 0)),
            Some((800, 600))
        );
        assert_eq!(
            image_dimensions("image/jpeg", &jpeg(800, 600, 0xC2, 0)),
            Some((800, 600))
        );
        // a JPEG whose SOF sits behind a 40 KB EXIF segment is still found
        assert_eq!(
            image_dimensions("image/jpeg", &jpeg(800, 600, 0xC0, 40_000)),
            Some((800, 600))
        );
    }

    #[test]
    fn oversize_headers_are_reported_as_oversize_for_each_format() {
        let over = MAX_MEMBER_AVATAR_DIMENSION + 1;
        let big = |d: Option<(u32, u32)>| {
            let (w, h) = d.expect("parsable");
            w > MAX_MEMBER_AVATAR_DIMENSION || h > MAX_MEMBER_AVATAR_DIMENSION
        };
        assert!(big(image_dimensions("image/png", &png(over, 10))));
        assert!(big(image_dimensions("image/png", &png(u32::MAX, u32::MAX))));
        assert!(big(image_dimensions("image/gif", &gif(u16::MAX, 10))));
        assert!(big(image_dimensions("image/webp", &webp_vp8x(over, 10))));
        assert!(big(image_dimensions(
            "image/webp",
            &webp_vp8x(16_777_216, 16_777_216)
        )));
        assert!(big(image_dimensions("image/webp", &webp_vp8l(over, 10))));
        assert!(big(image_dimensions("image/webp", &webp_vp8(16_383, 10))));
        assert!(big(image_dimensions(
            "image/jpeg",
            &jpeg(10, u16::MAX, 0xC0, 0)
        )));
        assert!(big(image_dimensions(
            "image/jpeg",
            &jpeg(over as u16, 10, 0xC2, 0)
        )));
        // and the boundary itself is fine
        let edge = MAX_MEMBER_AVATAR_DIMENSION;
        assert_eq!(
            image_dimensions("image/png", &png(edge, edge)),
            Some((edge, edge))
        );
    }

    #[test]
    fn unparsable_or_truncated_headers_have_no_dimensions() {
        let full = png(10, 10);
        assert_eq!(
            image_dimensions("image/png", &full[..20]),
            None,
            "truncated IHDR"
        );
        let mut not_ihdr = png(10, 10);
        not_ihdr[12..16].copy_from_slice(b"IDAT");
        assert_eq!(image_dimensions("image/png", &not_ihdr), None);
        assert_eq!(
            image_dimensions("image/png", &png(0, 10)),
            None,
            "zero is not a size"
        );
        assert_eq!(image_dimensions("image/gif", b"GIF89a\x01"), None);
        assert_eq!(
            image_dimensions("image/webp", b"RIFF\x1a\0\0\0WEBPVP8X"),
            None
        );
        assert_eq!(
            image_dimensions(
                "image/webp",
                b"RIFF\x1a\0\0\0WEBPXXXX\0\0\0\0\0\0\0\0\0\0\0\0\0\0"
            ),
            None
        );
        assert_eq!(
            image_dimensions("image/jpeg", &[0xFF, 0xD8]),
            None,
            "no SOF at all"
        );
        // SOS before any SOF: nothing to read
        assert_eq!(
            image_dimensions("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xDA, 0, 4, 0, 0]),
            None
        );
        // a frame header past the end of the window
        let mut late = jpeg(10, 10, 0xC0, 0);
        late.truncate(6);
        assert_eq!(image_dimensions("image/jpeg", &late), None);
        assert_eq!(image_dimensions("image/svg+xml", b"<svg/>"), None);
    }
}
