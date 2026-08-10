//! Workspace avatar media — the `workspace_avatar_media` table's every statement
//! (ADR-0161 D5).
//!
//! This is the attachment lifecycle (`attachment.rs`) re-aimed at a workspace.
//! The transport primitive is the same one ADR-0151 froze — bytes bypass this
//! server going up (a Drive resumable session), the server proxies them coming
//! down after an authorization check — so nothing here invents a second storage
//! backend. Three things differ, and each is an ADR-0161 D5 decision:
//!
//! 1. **The binding is a workspace, not a channel + message.** There is no
//!    `channel_id`; instead `workspace.avatar_media_id` points at the one
//!    completed media row that is the current avatar.
//! 2. **A completed avatar is mutable.** `settle` does not only flip the media
//!    row to `complete`; it moves the workspace pointer to it, so replacing an
//!    avatar is a new completed row and a re-point (the old row's Drive bytes are
//!    reaped by a later job, D5 "교체 회수").
//! 3. **The read scope is wider.** The route gates `content` on
//!    `active_workspace_role(...).is_some()` — any workspace member, not a
//!    channel member — because the rail renders the avatar for everyone. This
//!    module owns only the tenant-scoped SQL; RLS FORCE (migration 067) is the
//!    boundary underneath, and none of these functions sets `app.workspace_id`.

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

/// 5 MiB. Agrees with `workspace_avatar_size_ck` (migration 067). An avatar is a
/// small tile in the rail; the attachment ceiling (100 MB) has no reason here.
pub const MAX_WORKSPACE_AVATAR_BYTES: i64 = 5 * 1024 * 1024;

/// `name` / `mime` length ceiling — the `_name_ck` / `_mime_ck` bounds.
pub const WORKSPACE_AVATAR_TEXT_MAX_CHARS: usize = 255;

const AVATAR_COLS: &str = "id, workspace_id, uploader_member_id, drive_file_id, \
                           name, mime, size_bytes, status, created_at";

/// One avatar-media row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarMedia {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub uploader_member_id: Uuid,
    /// Drive's own identifier. Never projected onto the wire (ADR-0151 D3): the
    /// only path to the bytes is the content proxy.
    pub drive_file_id: Option<String>,
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Why an avatar name or mime was refused (both 400).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AvatarSpecInvalid {
    #[error("avatar name is invalid")]
    Name,
    #[error("avatar mime must be an image type")]
    Mime,
}

/// Trim and validate a file name — the attachment name rule verbatim: the value
/// is echoed back as a download-style filename, so path separators and NUL are
/// refused even though Drive owns the layout.
pub fn validate_avatar_name(raw: &str) -> Result<String, AvatarSpecInvalid> {
    let value = raw.trim();
    if value.is_empty()
        || value.chars().count() > WORKSPACE_AVATAR_TEXT_MAX_CHARS
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(AvatarSpecInvalid::Name);
    }
    Ok(value.to_string())
}

/// Trim, lower-case, and validate an avatar mime. Unlike an attachment (any
/// mime), an avatar must be `image/<subtype>`: the content proxy streams these
/// bytes into a rail `<img>`, so a non-image here is bytes rendered as an image.
/// The `workspace_avatar_mime_ck` DB check (`mime LIKE 'image/%'`) is the
/// backstop; this is the front one, and it also fixes the exact subtype shape.
pub fn validate_avatar_mime(raw: &str) -> Result<String, AvatarSpecInvalid> {
    let value = raw.trim().to_ascii_lowercase();
    let Some(subtype) = value.strip_prefix("image/") else {
        return Err(AvatarSpecInvalid::Mime);
    };
    let subtype_ok = !subtype.is_empty()
        && subtype
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'));
    if !subtype_ok || value.chars().count() > WORKSPACE_AVATAR_TEXT_MAX_CHARS {
        return Err(AvatarSpecInvalid::Mime);
    }
    Ok(value)
}

fn decode_avatar(row: &sqlx::postgres::PgRow) -> Result<AvatarMedia, sqlx::Error> {
    Ok(AvatarMedia {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        uploader_member_id: row.try_get("uploader_member_id")?,
        drive_file_id: row.try_get("drive_file_id")?,
        name: row.try_get("name")?,
        mime: row.try_get("mime")?,
        size_bytes: row.try_get("size_bytes")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
    })
}

/// Insert the `pending` row for a resumable avatar session, with its audit
/// record. Called **after** the Drive session exists, so the row names the file
/// it is waiting for from the moment it is written and a Drive failure leaves no
/// orphan (attachment.rs's rule).
#[allow(clippy::too_many_arguments)]
pub async fn create_pending_avatar_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    uploader_member_id: Uuid,
    via_token_id: Option<Uuid>,
    drive_file_id: &str,
    name: &str,
    mime: &str,
    size_bytes: i64,
) -> Result<Uuid, DbError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO workspace_avatar_media \
           (workspace_id, uploader_member_id, drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(uploader_member_id)
    .bind(drive_file_id)
    .bind(name)
    .bind(mime)
    .bind(size_bytes)
    .fetch_one(&mut *conn)
    .await?;

    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "workspace.avatar_upload_started")
            .by(uploader_member_id)
            .target("workspace", workspace_id)
            .via_token(via_token_id)
            .with_schema(
                "momo.workspace.avatar_upload_started.v1",
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

/// Read one avatar-media row by id, optionally scoped to its uploader and
/// optionally locked.
///
/// `uploader_member_id` is `Some` for the write path (complete) and `None` for
/// reads. This mirrors `load_attachment_in_tx`: only the uploader can finish the
/// upload they started, so a member who learns another's media id can do nothing
/// with it.
pub async fn load_avatar_media_in_tx(
    conn: &mut PgConnection,
    media_id: Uuid,
    workspace_id: Uuid,
    uploader_member_id: Option<Uuid>,
    for_update: bool,
) -> Result<Option<AvatarMedia>, DbError> {
    let lock = if for_update { " FOR UPDATE" } else { "" };
    let row = match uploader_member_id {
        Some(uploader) => {
            let sql = format!(
                "SELECT {AVATAR_COLS} FROM workspace_avatar_media \
                  WHERE id = $1 AND workspace_id = $2 AND uploader_member_id = $3{lock}"
            );
            sqlx::query(&sql)
                .bind(media_id)
                .bind(workspace_id)
                .bind(uploader)
                .fetch_optional(&mut *conn)
                .await?
        }
        None => {
            let sql = format!(
                "SELECT {AVATAR_COLS} FROM workspace_avatar_media \
                  WHERE id = $1 AND workspace_id = $2{lock}"
            );
            sqlx::query(&sql)
                .bind(media_id)
                .bind(workspace_id)
                .fetch_optional(&mut *conn)
                .await?
        }
    };
    row.as_ref()
        .map(decode_avatar)
        .transpose()
        .map_err(DbError::from)
}

/// The workspace's current avatar media, if one is set and complete. The content
/// proxy reads this: `workspace.avatar_media_id` → the row, filtered to
/// `complete` so a pointer left dangling by a half-finished replacement never
/// serves bytes.
pub async fn read_current_avatar_media_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<AvatarMedia>, DbError> {
    // Columns are qualified with `a.` here: `workspace` also has `id` and
    // `workspace_id`, so an unqualified list would be ambiguous across the join.
    let sql = "SELECT a.id, a.workspace_id, a.uploader_member_id, a.drive_file_id, \
                      a.name, a.mime, a.size_bytes, a.status, a.created_at \
                 FROM workspace_avatar_media a \
                 JOIN workspace w ON w.avatar_media_id = a.id \
                WHERE w.id = $1 AND a.status = 'complete'";
    let row = sqlx::query(sql)
        .bind(workspace_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_avatar)
        .transpose()
        .map_err(DbError::from)
}

/// Move a pending avatar to `complete` or `failed`, and on success re-point the
/// workspace at it.
///
/// Like `settle_upload_in_tx`, the `failed` write is not a rollback: it commits a
/// durable, audited record of the divergence, and the caller answers 409 after.
/// The one addition over the attachment version is the `UPDATE workspace SET
/// avatar_media_id` on a match — that single re-point is the whole "replace the
/// avatar" act, and it is why a completed avatar is mutable where an attachment
/// is not.
#[allow(clippy::too_many_arguments)]
pub async fn settle_avatar_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    media_id: Uuid,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
    matched: bool,
    expected: (&str, i64),
    actual: (&str, i64),
) -> Result<(), DbError> {
    let status = if matched { "complete" } else { "failed" };
    sqlx::query("UPDATE workspace_avatar_media SET status = $2 WHERE id = $1")
        .bind(media_id)
        .bind(status)
        .execute(&mut *conn)
        .await?;

    if matched {
        // The re-point. A completed avatar is what the workspace now shows; the
        // previous media row is left for the Drive-reclaim job (D5).
        sqlx::query("UPDATE workspace SET avatar_media_id = $2, updated_at = now() WHERE id = $1")
            .bind(workspace_id)
            .bind(media_id)
            .execute(&mut *conn)
            .await?;
    }

    let action = if matched {
        "workspace.avatar_updated"
    } else {
        "workspace.avatar_upload_failed"
    };
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, action)
            .by(actor_member_id)
            .target("workspace", workspace_id)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_trimmed_and_path_separators_are_refused() {
        assert_eq!(validate_avatar_name("  logo.png  ").expect("ok"), "logo.png");
        for bad in ["", "  ", "a/b.png", "a\\b.png", "a\0b"] {
            assert_eq!(validate_avatar_name(bad), Err(AvatarSpecInvalid::Name), "{bad:?}");
        }
        assert_eq!(
            validate_avatar_name(&"a".repeat(256)),
            Err(AvatarSpecInvalid::Name)
        );
    }

    #[test]
    fn only_image_mimes_are_accepted() {
        for ok in ["image/png", "IMAGE/JPEG", " image/webp ", "image/svg+xml"] {
            assert!(validate_avatar_mime(ok).is_ok(), "{ok:?}");
        }
        assert_eq!(validate_avatar_mime("image/png").expect("lower"), "image/png");
        assert_eq!(validate_avatar_mime("IMAGE/JPEG").expect("lower"), "image/jpeg");
        // Not an image, or not a mime at all: the content proxy would stream
        // these into a rail <img>, so they are refused before Drive is touched.
        for bad in ["application/pdf", "text/html", "image/", "png", "image", ""] {
            assert_eq!(validate_avatar_mime(bad), Err(AvatarSpecInvalid::Mime), "{bad:?}");
        }
    }
}
