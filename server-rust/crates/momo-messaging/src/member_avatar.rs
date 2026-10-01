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

/// Insert the `pending` row for a resumable avatar session, with its audit
/// record. Called **after** the Drive session exists (a Drive failure leaves no
/// orphan row). `member_id` is the caller: this module has no way to write a row
/// for anyone else.
#[allow(clippy::too_many_arguments)]
pub async fn create_pending_member_avatar_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    drive_file_id: &str,
    name: &str,
    mime: &str,
    size_bytes: i64,
) -> Result<Uuid, DbError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO member_avatar_media \
           (workspace_id, member_id, drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(drive_file_id)
    .bind(name)
    .bind(mime)
    .bind(size_bytes)
    .fetch_one(&mut *conn)
    .await?;

    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "member.avatar_upload_started")
            .by(member_id)
            .target("member", member_id)
            .via_token(via_token_id)
            .with_schema(
                "momo.member.avatar_upload_started.v1",
                json!({
                    "media_id": id.to_string(),
                    "name": name,
                    "mime": mime,
                    "size_bytes": size_bytes.to_string(),
                }),
            ),
    )
    .await?;
    Ok(id)
}

/// How many upload sessions the caller opened in the last ten minutes without
/// finishing them. The route's spam brake: there is no per-member request
/// limiter in front of authenticated routes (only per-IP ones on join/claim),
/// and each session costs a Drive round trip and a row.
pub async fn count_recent_pending_member_avatar_uploads_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<i64, DbError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM member_avatar_media \
          WHERE workspace_id = $1 AND member_id = $2 AND status = 'pending' \
            AND created_at > now() - interval '10 minutes'",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count)
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
}
