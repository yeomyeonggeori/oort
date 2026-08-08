//! Attachments — the `attachment` table's every statement (ADR-0151 D1).
//!
//! Ported from Swift `Routes/AttachmentRoutes.swift` and the attachment half of
//! `Routes/MessageRoutes.swift` (`linkAttachments` :1320-1389, the projections
//! at :440-470 / :585-605 / :1015-1037). The wire is frozen: `docs/api/openapi.yaml`
//! already specifies these three operations and the `attachments` array on a
//! `Message`, so nothing here chooses a shape.
//!
//! ## Why the SQL is in this crate and not in the route module
//!
//! Same rule the rest of the tree follows: `momo-server` owns no SQL. But there
//! is a second reason specific to attachments — **the binding is part of the
//! message's own transaction.** `link_attachments_in_tx` runs between the
//! message insert and the broadcast, so a refused attachment rolls the message
//! back with it and the realtime payload describes the attachments the row
//! actually has. A route-level copy of these statements would be a second write
//! path onto `message` in all but name.
//!
//! ## The lifecycle, and where each transition is enforced
//!
//! ```text
//!  POST …/attachments/uploads      → pending   (create_pending_upload_in_tx)
//!  POST …/attachments/{id}/complete → complete | failed  (settle_upload_in_tx)
//!  POST …/messages { attachmentIds } → message_id set    (link_attachments_in_tx)
//! ```
//!
//! Three properties the DB — not the client — owns:
//!
//! 1. **Only the uploader can complete or bind.** Both statements scope on
//!    `uploader_member_id`, so a member who learns another's attachment id can
//!    neither finish it nor attach it to a message of their own.
//! 2. **An attachment binds to exactly one message.** `message_id IS NULL` is
//!    checked under `FOR UPDATE`, so two concurrent sends cannot both claim it.
//! 3. **Only `complete` rows are ever projected.** Every read filters
//!    `status = 'complete'`, so a pending or failed upload is invisible to
//!    history, to the send echo, and to the realtime rail alike.
//!
//! RLS FORCE (migration 017) is the tenant boundary underneath all of it: every
//! function here takes a connection whose `app.workspace_id` GUC was bound by
//! [`momo_db::with_tenant_tx`], and none of them sets it.

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

/// The 100 MB ceiling. Agrees with `attachment_size_ck` (migration 017), Swift
/// `AttachmentRoutes.maximumSizeBytes`, and `momo_drive::MAX_ATTACHMENT_BYTES`.
pub const MAX_ATTACHMENT_BYTES: i64 = 100 * 1024 * 1024;

/// Swift `linkAttachments`' cap (:1327). A message with more than twenty files
/// is a client bug or an attempt to make one send do twenty row locks.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 20;

/// `name` / `mime` length ceiling — `attachment_name_ck` / `attachment_mime_ck`.
pub const ATTACHMENT_TEXT_MAX_CHARS: usize = 255;

/// One attachment row as the three routes project it (openapi `Attachment`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub uploader_member_id: Uuid,
    pub message_id: Option<Uuid>,
    /// Drive's own identifier. **Never projected onto the wire** — the openapi
    /// `Attachment` schema has no field for it, and ADR-0151 D3 keeps archive
    /// identifiers server-side so the only way to the bytes is the content
    /// proxy.
    pub drive_file_id: Option<String>,
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// The four fields a message carries about each of its attachments (openapi
/// `MessageAttachment`).
///
/// Deliberately not the whole row: `status` is always `complete` by
/// construction, `channelId` is the message's, and the uploader is the author.
/// Projecting them again would be three more chances to disagree.
///
/// `Deserialize` is here for one caller only — [`decode_paged_attachments`],
/// which reads the aggregate SQL built. That makes the SQL's key names and this
/// struct's one contract: rename `sizeBytes` on either side and the page
/// projection fails loudly at decode instead of quietly returning empty arrays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageAttachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
}

/// Why an attachment name or mime was refused (Swift `validatedName` /
/// `validatedMime`, both 400).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AttachmentSpecInvalid {
    #[error("attachment name is invalid")]
    Name,
    #[error("attachment mime is invalid")]
    Mime,
}

/// Trim and validate a file name.
///
/// The rejected characters are the path separators and NUL — not because the
/// name is ever used as a path here (it is not; Drive owns the layout), but
/// because it is echoed back to clients that *will* use it as a download
/// filename.
pub fn validate_attachment_name(raw: &str) -> Result<String, AttachmentSpecInvalid> {
    let value = raw.trim();
    if value.is_empty()
        || value.chars().count() > ATTACHMENT_TEXT_MAX_CHARS
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(AttachmentSpecInvalid::Name);
    }
    Ok(value.to_string())
}

/// Trim, lowercase and validate a media type against Swift's
/// `^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$` (`AttachmentRoutes.swift:465`).
///
/// Lowercasing is part of the contract, not a convenience: the stored value is
/// what `complete` compares Drive's report against, and a case difference would
/// fail a verification that should have passed.
pub fn validate_attachment_mime(raw: &str) -> Result<String, AttachmentSpecInvalid> {
    let value = raw.trim().to_lowercase();
    if value.is_empty() || value.chars().count() > ATTACHMENT_TEXT_MAX_CHARS {
        return Err(AttachmentSpecInvalid::Mime);
    }
    let token = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    let mut parts = value.splitn(2, '/');
    match (parts.next(), parts.next()) {
        (Some(kind), Some(subtype)) if token(kind) && token(subtype) => Ok(value),
        _ => Err(AttachmentSpecInvalid::Mime),
    }
}

const ATTACHMENT_COLS: &str = "id, channel_id, uploader_member_id, message_id, drive_file_id, \
     name, mime, size_bytes, status, created_at";

fn decode_attachment(row: &sqlx::postgres::PgRow) -> Result<Attachment, sqlx::Error> {
    Ok(Attachment {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        uploader_member_id: row.try_get("uploader_member_id")?,
        message_id: row.try_get("message_id")?,
        drive_file_id: row.try_get("drive_file_id")?,
        name: row.try_get("name")?,
        mime: row.try_get("mime")?,
        size_bytes: row.try_get("size_bytes")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
    })
}

/// The attachment surface's channel-membership predicate (Swift
/// `AttachmentRoutes.requireChannelMember`, :371-398).
///
/// **Stricter than [`crate::identity::is_channel_member`], and deliberately so.**
/// That one answers "is there a live membership row"; this one additionally
/// requires the channel to be unarchived, in the named workspace, and the member
/// to be `active` and not soft-deleted. Uploading into an archived channel, or
/// as a suspended member, is exactly the case the extra clauses close — and
/// widening the general predicate to match would change every other route's
/// authorization along with this one.
pub async fn is_attachment_channel_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 \
             FROM channel c \
             JOIN membership ms ON ms.channel_id = c.id \
                               AND ms.member_id = $3 \
                               AND ms.left_at IS NULL \
             JOIN member m ON m.id = ms.member_id \
                          AND m.workspace_id = c.workspace_id \
                          AND m.status = 'active' \
                          AND m.deleted_at IS NULL \
            WHERE c.id = $2 \
              AND c.workspace_id = $1 \
              AND c.archived_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(exists)
}

/// Insert the `pending` row for a resumable session, with its audit record, in
/// the caller's transaction.
///
/// Called **after** the archive session exists, so the row can name the Drive
/// file it is waiting for from the moment it is written — and so a Drive failure
/// leaves no orphan row at all rather than one to reap.
#[allow(clippy::too_many_arguments)]
pub async fn create_pending_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    uploader_member_id: Uuid,
    via_token_id: Option<Uuid>,
    drive_file_id: &str,
    name: &str,
    mime: &str,
    size_bytes: i64,
) -> Result<Uuid, DbError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO attachment \
           (workspace_id, channel_id, uploader_member_id, drive_file_id, \
            name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(uploader_member_id)
    .bind(drive_file_id)
    .bind(name)
    .bind(mime)
    .bind(size_bytes)
    .fetch_one(&mut *conn)
    .await?;

    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "attachment.upload_started")
            .by(uploader_member_id)
            .about_optional(None)
            .target("attachment", id)
            .via_token(via_token_id)
            .with_schema(
                "momo.attachment.upload_started.v1",
                json!({
                    "channel_id": channel_id.to_string(),
                    "name": name,
                    "mime": mime,
                    // A string, like Swift's detail dictionary: an int64 that
                    // round-trips through a JSON reader with a float type would
                    // lose precision at the top of the range.
                    "size_bytes": size_bytes.to_string(),
                }),
            ),
    )
    .await?;
    Ok(id)
}

/// Read one attachment, optionally scoped to its uploader and optionally locked.
///
/// `uploader_member_id` is `Some` for the write-side routes (complete, link) and
/// `None` for the read-side one (content), which is the whole authorization
/// difference between them: **anyone in the channel may download a completed
/// attachment; only the uploader may finish or bind one.**
pub async fn load_attachment_in_tx(
    conn: &mut PgConnection,
    attachment_id: Uuid,
    channel_id: Uuid,
    uploader_member_id: Option<Uuid>,
    for_update: bool,
) -> Result<Option<Attachment>, DbError> {
    let lock = if for_update { " FOR UPDATE" } else { "" };
    let row = match uploader_member_id {
        Some(uploader) => {
            let sql = format!(
                "SELECT {ATTACHMENT_COLS} FROM attachment \
                  WHERE id = $1 AND channel_id = $2 AND uploader_member_id = $3{lock}"
            );
            sqlx::query(&sql)
                .bind(attachment_id)
                .bind(channel_id)
                .bind(uploader)
                .fetch_optional(&mut *conn)
                .await?
        }
        None => {
            let sql = format!(
                "SELECT {ATTACHMENT_COLS} FROM attachment \
                  WHERE id = $1 AND channel_id = $2{lock}"
            );
            sqlx::query(&sql)
                .bind(attachment_id)
                .bind(channel_id)
                .fetch_optional(&mut *conn)
                .await?
        }
    };
    row.as_ref()
        .map(decode_attachment)
        .transpose()
        .map_err(DbError::from)
}

/// Move a pending row to `complete` or `failed`, recording what Drive reported
/// against what was declared.
///
/// **The `failed` write is not a rollback.** Swift commits the transition and
/// *then* answers 409 (`AttachmentRoutes.swift:206-208`), so a mismatch leaves a
/// durable, audited record of the divergence rather than a row that stays
/// `pending` forever and a client that was told "no" with nothing to show for
/// it. This function reproduces that: the caller commits, then decides the
/// status code from `matched`.
#[allow(clippy::too_many_arguments)]
pub async fn settle_upload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    attachment_id: Uuid,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
    matched: bool,
    expected: (&str, i64),
    actual: (&str, i64),
) -> Result<(), DbError> {
    let status = if matched { "complete" } else { "failed" };
    sqlx::query("UPDATE attachment SET status = $2 WHERE id = $1")
        .bind(attachment_id)
        .bind(status)
        .execute(&mut *conn)
        .await?;

    let action = if matched {
        "attachment.upload_completed"
    } else {
        "attachment.upload_failed"
    };
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, action)
            .by(actor_member_id)
            .about_optional(None)
            .target("attachment", attachment_id)
            .via_token(via_token_id)
            .with_schema(
                &format!("momo.{action}.v1"),
                json!({
                    "channel_id": channel_id.to_string(),
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

/// Why an `attachmentIds` binding was refused (Swift `linkAttachments`).
///
/// One variant per Swift `throw`, because the route's status table is keyed on
/// them and a merged variant would merge two statuses — notably the two 403s,
/// which say different things to a client that is debugging.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AttachmentLinkRejected {
    #[error("attachmentIds must not contain duplicates")]
    Duplicate,
    #[error("attachmentIds must contain at most 20 items")]
    TooMany,
    #[error("attachment not found")]
    NotFound,
    #[error("attachment upload is not complete")]
    NotComplete,
    #[error("attachment belongs to another uploader")]
    ForeignUploader,
    #[error("attachment belongs to another channel")]
    ForeignChannel,
    #[error("attachment is already linked")]
    AlreadyLinked,
}

/// Bind completed attachments to a freshly inserted message, in that message's
/// own transaction (Swift `MessageRoutes.linkAttachments`, :1320-1389).
///
/// A rejection travels in the `Ok` half; the **caller must roll back**, because
/// every refusal here has to take the message with it. Swift gets this by
/// throwing out of the transaction closure; the message it refused is never
/// sent, which is the only honest outcome — a message that shipped without the
/// file its author attached is worse than one that failed to send.
///
/// The row lock is what makes rule 2 of the module docs true: `FOR UPDATE`
/// precedes the `message_id IS NULL` check, so of two concurrent sends naming
/// the same attachment exactly one commits and the other is told
/// [`AttachmentLinkRejected::AlreadyLinked`].
/// The two refusals a binding can make **before touching the database**: a
/// duplicate id, and more ids than one message may carry.
///
/// Separated from [`link_attachments_in_tx`] so both are assertable without a
/// connection, and so the ordering is visible: a 21-id request is refused before
/// it takes twenty row locks, and a list naming the same attachment twice is
/// refused before the first lock — which matters, because the second occurrence
/// would otherwise be told the attachment is "already linked" by the request
/// that was linking it.
pub fn validate_attachment_id_list(ids: &[Uuid]) -> Result<(), AttachmentLinkRejected> {
    if ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(AttachmentLinkRejected::TooMany);
    }
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    if !ids.iter().all(|id| seen.insert(*id)) {
        return Err(AttachmentLinkRejected::Duplicate);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn link_attachments_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    uploader_member_id: Uuid,
    via_token_id: Option<Uuid>,
    attachment_ids: &[Uuid],
) -> Result<Result<(), AttachmentLinkRejected>, DbError> {
    if let Err(rejected) = validate_attachment_id_list(attachment_ids) {
        return Ok(Err(rejected));
    }

    for attachment_id in attachment_ids {
        let row = sqlx::query(
            "SELECT status, uploader_member_id, channel_id, message_id \
               FROM attachment WHERE id = $1 FOR UPDATE",
        )
        .bind(attachment_id)
        .fetch_optional(&mut *conn)
        .await?;
        // An id in another tenant is invisible under RLS and lands here as
        // "not found" — the same answer as an id that never existed, so a
        // sender cannot probe for attachments outside their workspace.
        let Some(row) = row else {
            return Ok(Err(AttachmentLinkRejected::NotFound));
        };
        let status: String = row.try_get("status").map_err(DbError::from)?;
        let uploader: Uuid = row.try_get("uploader_member_id").map_err(DbError::from)?;
        let attachment_channel: Uuid = row.try_get("channel_id").map_err(DbError::from)?;
        let existing_message: Option<Uuid> = row.try_get("message_id").map_err(DbError::from)?;

        if status != "complete" {
            return Ok(Err(AttachmentLinkRejected::NotComplete));
        }
        if uploader != uploader_member_id {
            return Ok(Err(AttachmentLinkRejected::ForeignUploader));
        }
        if attachment_channel != channel_id {
            return Ok(Err(AttachmentLinkRejected::ForeignChannel));
        }
        if existing_message.is_some() {
            return Ok(Err(AttachmentLinkRejected::AlreadyLinked));
        }

        sqlx::query("UPDATE attachment SET message_id = $2 WHERE id = $1")
            .bind(attachment_id)
            .bind(message_id)
            .execute(&mut *conn)
            .await?;
        write_audit(
            &mut *conn,
            &AuditEntry::new(workspace_id, "attachment.message_linked")
                .by(uploader_member_id)
                .about_optional(None)
                .target("attachment", *attachment_id)
                .via_token(via_token_id)
                .with_schema(
                    "momo.attachment.message_linked.v1",
                    json!({
                        "channel_id": channel_id.to_string(),
                        "message_id": message_id.to_string(),
                    }),
                ),
        )
        .await?;
    }
    Ok(Ok(()))
}

/// The `attachments` projection for one message, ordered oldest-first.
///
/// `status = 'complete'` is the filter that makes the array safe to hand to a
/// client: a `pending` row names a file that may never arrive, and a `failed`
/// one names bytes that did not match what was declared.
pub async fn message_attachments_in_tx(
    conn: &mut PgConnection,
    message_id: Uuid,
) -> Result<Vec<MessageAttachment>, DbError> {
    let rows = sqlx::query(
        "SELECT id, name, mime, size_bytes FROM attachment \
          WHERE message_id = $1 AND status = 'complete' \
          ORDER BY created_at ASC, id ASC",
    )
    .bind(message_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(MessageAttachment {
                id: row.try_get::<Uuid, _>("id")?.to_string(),
                name: row.try_get("name")?,
                mime: row.try_get("mime")?,
                size_bytes: row.try_get("size_bytes")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// The `LEFT JOIN LATERAL` that carries the same projection through a **page**
/// of messages (Swift `MessageRoutes.swift:455-470`).
///
/// One statement per page whether it holds no attachments or a hundred — the
/// same reasoning as the quote join: reading ids off the rows and then fetching
/// per message would cost one round trip per attached message, and would read
/// them under a different snapshot than the page.
pub(crate) const PAGED_ATTACHMENT_JOIN: &str = "LEFT JOIN LATERAL ( \
       SELECT jsonb_agg( \
                jsonb_build_object( \
                  'id', a.id::text, 'name', a.name, 'mime', a.mime, \
                  'sizeBytes', a.size_bytes \
                ) ORDER BY a.created_at ASC, a.id ASC \
              ) AS items \
         FROM attachment a \
        WHERE a.message_id = m.id AND a.status = 'complete' \
     ) att ON true";

/// The column the join above contributes, aliased for [`decode_paged_attachments`].
pub(crate) const PAGED_ATTACHMENT_COL: &str = "att.items AS attachments_json";

/// Decode the lateral join's aggregate. `NULL` (no attachments) and `[]` both
/// become an empty vector, which the DTO then omits.
pub(crate) fn decode_paged_attachments(
    row: &sqlx::postgres::PgRow,
) -> Result<Vec<MessageAttachment>, sqlx::Error> {
    let items: Option<serde_json::Value> = row.try_get("attachments_json")?;
    let Some(items) = items else {
        return Ok(Vec::new());
    };
    serde_json::from_value::<Vec<MessageAttachment>>(items)
        .map_err(|error| sqlx::Error::Decode(Box::new(error)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_trimmed_and_kept_off_the_filesystem() {
        assert_eq!(
            validate_attachment_name("  보고서.pdf "),
            Ok("보고서.pdf".into())
        );
        for bad in ["", "   ", "a/b.txt", "a\\b.txt", "a\0b"] {
            assert_eq!(
                validate_attachment_name(bad),
                Err(AttachmentSpecInvalid::Name),
                "{bad:?}"
            );
        }
        // The ceiling counts characters, not bytes — a 255-character Korean
        // filename is legal and a 256-character ASCII one is not.
        assert!(validate_attachment_name(&"가".repeat(255)).is_ok());
        assert!(validate_attachment_name(&"a".repeat(256)).is_err());
    }

    #[test]
    fn a_mime_is_lowercased_because_the_stored_value_is_what_drive_is_compared_against() {
        assert_eq!(
            validate_attachment_mime(" IMAGE/PNG "),
            Ok("image/png".into())
        );
        assert_eq!(
            validate_attachment_mime("application/vnd.ms-excel"),
            Ok("application/vnd.ms-excel".into())
        );
        for bad in [
            "",
            "image",
            "image/",
            "/png",
            "image/png; charset=utf-8",
            "image png",
            "image/p*g",
            "image/png/extra",
        ] {
            assert_eq!(
                validate_attachment_mime(bad),
                Err(AttachmentSpecInvalid::Mime),
                "{bad:?}"
            );
        }
    }

    /// The wire keys are camelCase (#1040 규율) and `sizeBytes` is the one that
    /// differs from the column name — a rename here silently empties every file
    /// card in the client.
    #[test]
    fn the_message_attachment_wire_keys_are_camel_case() {
        let json = serde_json::to_value(MessageAttachment {
            id: "11111111-1111-1111-1111-111111111111".into(),
            name: "보고서.pdf".into(),
            mime: "application/pdf".into(),
            size_bytes: 1234,
        })
        .expect("serialize");
        assert_eq!(json["sizeBytes"], 1234);
        assert_eq!(json["name"], "보고서.pdf");
        assert!(json.get("size_bytes").is_none(), "{json}");
        assert!(
            json.get("driveFileId").is_none() && json.get("status").is_none(),
            "an archive identifier must never reach a client: {json}"
        );
    }

    #[test]
    fn a_duplicate_or_oversized_binding_is_refused_before_any_row_is_locked() {
        let id = |n: u128| Uuid::from_u128(n + 1);
        assert_eq!(validate_attachment_id_list(&[]), Ok(()));
        let full: Vec<Uuid> = (0..MAX_ATTACHMENTS_PER_MESSAGE as u128).map(id).collect();
        assert_eq!(validate_attachment_id_list(&full), Ok(()), "20 is allowed");

        let over: Vec<Uuid> = (0..=MAX_ATTACHMENTS_PER_MESSAGE as u128).map(id).collect();
        assert_eq!(
            validate_attachment_id_list(&over),
            Err(AttachmentLinkRejected::TooMany),
            "21 is not — and it is refused before twenty row locks are taken"
        );
        assert_eq!(
            validate_attachment_id_list(&[id(0), id(1), id(0)]),
            Err(AttachmentLinkRejected::Duplicate),
            "a repeated id must not be told it is 'already linked' by the very \
             request that is linking it"
        );
    }

    #[test]
    fn every_link_refusal_has_its_own_sentence() {
        let sentences: Vec<String> = [
            AttachmentLinkRejected::Duplicate,
            AttachmentLinkRejected::TooMany,
            AttachmentLinkRejected::NotFound,
            AttachmentLinkRejected::NotComplete,
            AttachmentLinkRejected::ForeignUploader,
            AttachmentLinkRejected::ForeignChannel,
            AttachmentLinkRejected::AlreadyLinked,
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        let unique: std::collections::HashSet<&String> = sentences.iter().collect();
        assert_eq!(unique.len(), sentences.len(), "{sentences:?}");
        // Swift's exact wording — clients and the send probe read these.
        assert_eq!(
            AttachmentLinkRejected::ForeignUploader.to_string(),
            "attachment belongs to another uploader"
        );
    }

    #[test]
    fn the_page_projection_reads_the_lateral_aggregate_and_hides_incomplete_rows() {
        assert!(PAGED_ATTACHMENT_JOIN.contains("a.status = 'complete'"));
        assert!(PAGED_ATTACHMENT_JOIN.contains("a.message_id = m.id"));
        assert!(PAGED_ATTACHMENT_JOIN.contains("ORDER BY a.created_at ASC, a.id ASC"));
        assert_eq!(PAGED_ATTACHMENT_COL, "att.items AS attachments_json");
        // 'sizeBytes' inside the aggregate is the wire key, not the column —
        // the projection is built in SQL, so this is where that contract lives.
        assert!(PAGED_ATTACHMENT_JOIN.contains("'sizeBytes', a.size_bytes"));
    }

    #[test]
    fn the_ceilings_agree_with_the_check_constraint() {
        assert_eq!(MAX_ATTACHMENT_BYTES, 104_857_600);
        assert_eq!(MAX_ATTACHMENT_BYTES, momo_drive_ceiling());
        assert_eq!(MAX_ATTACHMENTS_PER_MESSAGE, 20);
        assert_eq!(ATTACHMENT_TEXT_MAX_CHARS, 255);
    }

    /// `momo-drive` is not a dependency of this crate (the archive and the
    /// ledger stay apart), so the shared ceiling is restated rather than
    /// imported — and this is where the two are held equal.
    fn momo_drive_ceiling() -> i64 {
        100 * 1024 * 1024
    }
}
