//! Attachment reclaim — the database half of the sweep that deletes completed
//! attachments no message and no schedule holds (ADR-0151 증보 2, #4443).
//!
//! A file is uploaded before the message that carries it, so some uploads are
//! never carried: a draft the composer lost, a cancelled or failed schedule's
//! files, a file whose message was hard-deleted (`ON DELETE SET NULL`). Nothing
//! collected them (ADR-0208 남는 위험 5), so the archive only grew. The sweep in
//! `momo-notifier` deletes them once they are older than [`UNBOUND_TTL`].
//! This module never talks to Drive itself — the notifier hands in a `delete`
//! closure, so the SQL here is testable without a Drive and the Drive crate stays
//! free of a database dependency (the `avatar_reclaim` split).
//!
//! ## Two steps, two pools
//!
//! 1. [`attachment_reclaim_candidates`] — one cross-tenant **read** on the
//!    notifier's BYPASSRLS pool, ids only, through a column-level `SELECT` grant
//!    that stops short of `drive_file_id`, `name`, `mime` and the uploader.
//! 2. [`reclaim_unbound_attachment_in_tx`] — **one attachment per tenant
//!    transaction** on the RLS-bound `momo_app` pool (`SET LOCAL app.workspace_id`).
//!    It re-reads the row under `FOR UPDATE` and decides again; the candidate list
//!    is a hint, never the authority.
//!
//! ## What is reclaimable — one definition, [`eligible_sql`]
//!
//! `status = 'complete'`, carried by no message (`message_id IS NULL`), held by no
//! schedule (`NOT reserved`), and idle for [`UNBOUND_TTL`] — measured from
//! `GREATEST(created_at, unreserved_at)`, so a file whose schedule was cancelled is
//! a draft for a full TTL from the cancel (ADR-0208 D11 「초안과 같은 상태」).
//! `pending` and `failed` rows are **not** reclaimed here: they never reached the
//! state this sweep is about, and they are a different question (ADR-0151 증보 2,
//! 남는 위험).
//!
//! ## Why `reserved` is a column and not a look at the schedule table
//!
//! A schedule holds its files for up to 120 days. Deleting one would cascade the
//! reservation row away and the schedule would go out without its file. But
//! `scheduled_message_attachment` is owner-scoped under FORCE RLS and sealed from the
//! BYPASSRLS roles (ADR-0208 D3), and binding another member's `app.member_id` is an
//! exception ADR-0208 D14-4 pins to three named functions. So a trigger mirrors the
//! fact onto the `attachment` row (migration 150) and this sweep reads only that.
//!
//! ## Order inside the row transaction
//!
//! lock → decide again → `SAVEPOINT` → **delete the row and write the audit row** →
//! Drive delete → on failure `ROLLBACK TO SAVEPOINT`. The row goes first so that a
//! foreign key that refuses the delete (the huddle transcript columns reference
//! `attachment`) stops the transaction **before** any byte is deleted; the Drive
//! call is last, under the row lock, and a failed call changes nothing, so the next
//! tick retries. A crash between "Drive deleted" and `COMMIT` leaves the row, and the
//! next tick's delete is idempotent (`DriveArchive::delete_file`: an object that is
//! gone is success), after which the row goes.
//!
//! The lock is also the race argument. Binding a file to a message
//! ([`crate::link_attachments_in_tx`]) and reserving it for a schedule
//! ([`crate::scheduled::reserve_attachments_in_tx`]) both take the row `FOR UPDATE`
//! first: either they commit before this sweep's lock — and the re-check sees the
//! message or the reservation — or they wait for it and find the row gone.

use std::time::Duration;

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection, PgPool};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::avatar_reclaim::{DriveDelete, DriveDeleteFuture};

/// How long an unbound completed attachment is kept: 30 days, the retention the inbox
/// and the run-event ledger already use (ADR-0199 D4, ADR-0200 D2). A draft that old
/// is not in anyone's composer; a schedule's file is exempt (`reserved`), so the
/// 120-day schedule horizon does not set this number.
pub const UNBOUND_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// One attachment the sweep may be able to reclaim. Ids only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AttachmentReclaimCandidate {
    pub workspace_id: Uuid,
    pub attachment_id: Uuid,
}

/// What one per-attachment transaction did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentReclaimOutcome {
    /// The row and the Drive object are gone (Drive deleted it, or said it was already
    /// gone), and the audit row was written in the same transaction.
    Reclaimed,
    /// Not (or no longer) reclaimable: a message or a schedule took it, it is younger
    /// than the TTL, it is not `complete`, or the row is gone. Nothing was written.
    SkippedNotEligible,
    /// Drive could not be reached or answered with a transient failure. Nothing was
    /// written; the next tick retries.
    DriveFailed,
    /// Drive permanently refused (the file is not on this archive's drive, or the
    /// stored id is malformed). Nothing was written and the object was left alone —
    /// it is not ours to delete, and deleting the row would forget where it is.
    Refused,
}

/// The one statement fragment that says what is reclaimable, with `ttl` bound at
/// `$ttl_param`. The candidate read and the re-check under the row lock both use it,
/// so they cannot drift apart. `drive_file_id` is deliberately not in it (the notifier
/// is not granted that column, and a `complete` row always has one — CHECK
/// `attachment_drive_file_ck`); the row transaction checks it separately.
pub(crate) fn eligible_sql(ttl_param: u8) -> String {
    format!(
        "a.status = 'complete' AND a.message_id IS NULL AND NOT a.reserved \
         AND GREATEST(a.created_at, COALESCE(a.unreserved_at, a.created_at)) \
             < now() - make_interval(secs => ${ttl_param})"
    )
}

/// The candidate statement: ids only, oldest first.
fn candidate_sql() -> String {
    format!(
        "SELECT a.workspace_id, a.id FROM attachment a WHERE {} \
          ORDER BY a.created_at, a.id LIMIT $2",
        eligible_sql(1)
    )
}

/// Attachments that look reclaimable, oldest first, at most `limit`.
///
/// **Cross-tenant and read-only** — the caller connects as the BYPASSRLS notifier
/// role exactly like the avatar reclaim and the retention sweeps. The answer is a
/// hint: [`reclaim_unbound_attachment_in_tx`] decides again under the row lock.
pub async fn attachment_reclaim_candidates(
    pool: &PgPool,
    limit: i64,
    ttl: Duration,
) -> Result<Vec<AttachmentReclaimCandidate>, DbError> {
    let rows = sqlx::query(&candidate_sql())
        .bind(ttl.as_secs_f64())
        .bind(limit.max(1))
        .fetch_all(pool)
        .await?;
    rows.iter()
        .map(|row| {
            Ok(AttachmentReclaimCandidate {
                workspace_id: row.try_get("workspace_id")?,
                attachment_id: row.try_get("id")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Reclaim one attachment inside the caller's tenant transaction.
///
/// `delete` receives the row's `drive_file_id` and runs **while the row lock is
/// held**, after the row's delete and its audit row are written inside a
/// `SAVEPOINT`. On anything but [`DriveDelete::Deleted`] / [`DriveDelete::Gone`] the
/// savepoint is rolled back, so the transaction commits **no** change and the row is
/// exactly as it was.
pub async fn reclaim_unbound_attachment_in_tx<F>(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    attachment_id: Uuid,
    ttl: Duration,
    delete: F,
) -> Result<AttachmentReclaimOutcome, DbError>
where
    F: for<'a> FnOnce(&'a str) -> DriveDeleteFuture<'a> + Send,
{
    // 1. Lock the row. Everything below is decided after this point.
    let locked =
        sqlx::query("SELECT id FROM attachment WHERE id = $1 AND workspace_id = $2 FOR UPDATE")
            .bind(attachment_id)
            .bind(workspace_id)
            .fetch_optional(&mut *conn)
            .await?;
    if locked.is_none() {
        return Ok(AttachmentReclaimOutcome::SkippedNotEligible);
    }

    // 2. A fresh statement (new snapshot under READ COMMITTED): a bind or a
    //    reservation that committed before our lock is visible here, and one that
    //    arrives now waits on the lock above.
    let row = sqlx::query(&format!(
        "SELECT a.drive_file_id, a.channel_id, a.uploader_member_id, a.mime, a.size_bytes \
           FROM attachment a WHERE a.id = $1 AND a.workspace_id = $3 AND {}",
        eligible_sql(2)
    ))
    .bind(attachment_id)
    .bind(ttl.as_secs_f64())
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(AttachmentReclaimOutcome::SkippedNotEligible);
    };
    let drive_file_id: Option<String> = row.try_get("drive_file_id")?;
    let Some(drive_file_id) = drive_file_id else {
        return Ok(AttachmentReclaimOutcome::SkippedNotEligible);
    };
    let channel_id: Uuid = row.try_get("channel_id")?;
    let uploader: Uuid = row.try_get("uploader_member_id")?;
    let mime: String = row.try_get("mime")?;
    let size_bytes: i64 = row.try_get("size_bytes")?;

    // 3. Delete the row and write its audit row inside a savepoint, so a Drive
    //    failure below can take both back without touching the transaction.
    sqlx::query("SAVEPOINT attachment_reclaim")
        .execute(&mut *conn)
        .await?;
    let deleted = sqlx::query("DELETE FROM attachment WHERE id = $1 AND workspace_id = $2")
        .bind(attachment_id)
        .bind(workspace_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if deleted != 1 {
        sqlx::query("ROLLBACK TO SAVEPOINT attachment_reclaim")
            .execute(&mut *conn)
            .await?;
        return Ok(AttachmentReclaimOutcome::SkippedNotEligible);
    }
    // The clock is not a member, so no actor; `about` is the uploader. No file name, no
    // Drive id: the name is exactly what this deletion is meant to forget.
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "attachment.expired")
            .about_optional(Some(uploader))
            .target("attachment", attachment_id)
            .with_schema(
                "momo.attachment.expired.v1",
                json!({
                    "channel_id": channel_id.to_string(),
                    "reason": "unbound_ttl",
                    "mime": mime,
                    "size_bytes": size_bytes.to_string(),
                }),
            ),
    )
    .await?;

    // 4. Drive, under the lock. Anything but success takes the row delete back.
    match delete(&drive_file_id).await {
        DriveDelete::Deleted | DriveDelete::Gone => Ok(AttachmentReclaimOutcome::Reclaimed),
        DriveDelete::Failed => {
            sqlx::query("ROLLBACK TO SAVEPOINT attachment_reclaim")
                .execute(&mut *conn)
                .await?;
            Ok(AttachmentReclaimOutcome::DriveFailed)
        }
        DriveDelete::Refused => {
            sqlx::query("ROLLBACK TO SAVEPOINT attachment_reclaim")
                .execute(&mut *conn)
                .await?;
            Ok(AttachmentReclaimOutcome::Refused)
        }
    }
}

/// Tally of one tick; counts only (no names, no member ids, no Drive ids).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentReclaimCounts {
    pub reclaimed: u32,
    pub skipped_not_eligible: u32,
    pub drive_failed: u32,
    pub refused: u32,
}

impl AttachmentReclaimCounts {
    pub fn record(&mut self, outcome: AttachmentReclaimOutcome) {
        match outcome {
            AttachmentReclaimOutcome::Reclaimed => self.reclaimed += 1,
            AttachmentReclaimOutcome::SkippedNotEligible => self.skipped_not_eligible += 1,
            AttachmentReclaimOutcome::DriveFailed => self.drive_failed += 1,
            AttachmentReclaimOutcome::Refused => self.refused += 1,
        }
    }

    pub fn add(&mut self, other: &AttachmentReclaimCounts) {
        self.reclaimed += other.reclaimed;
        self.skipped_not_eligible += other.skipped_not_eligible;
        self.drive_failed += other.drive_failed;
        self.refused += other.refused;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The candidate read runs as the BYPASSRLS notifier through a **column** grant
    /// (migration 150, `bootstrap_runtime_roles.sql`). A column this statement names that
    /// the grant does not cover fails in production and passes against the dev roles
    /// (which hold table-level grants) — so the columns it names are pinned here, and
    /// `scripts/tests/test_notifier_role_grants.sh` pins the same list against the
    /// bootstrap.
    #[test]
    fn the_candidate_read_names_only_the_columns_the_notifier_is_granted() {
        const GRANTED: [&str; 7] = [
            "id",
            "workspace_id",
            "status",
            "message_id",
            "reserved",
            "unreserved_at",
            "created_at",
        ];
        let sql = candidate_sql();
        let mut named: Vec<&str> = sql
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
            .filter_map(|token| token.strip_prefix("a."))
            .collect();
        named.sort_unstable();
        named.dedup();
        assert!(
            !named.is_empty(),
            "the statement aliases attachment as `a`: {sql}"
        );
        for column in &named {
            assert!(
                GRANTED.contains(column),
                "the candidate read names `{column}`, which the notifier is not granted: {sql}"
            );
        }
        // …and it uses every granted column, so the grant does not drift wider than
        // the read (the static grants test requires the two lists to agree).
        for column in GRANTED {
            assert!(
                named.contains(&column),
                "`{column}` is granted but not read: {sql}"
            );
        }
    }

    /// The eligibility fragment is the one definition both statements embed; what it
    /// requires is spelled out so a weakened copy cannot slip in.
    #[test]
    fn eligibility_requires_complete_unbound_unreserved_and_idle() {
        let fragment = eligible_sql(1);
        assert!(fragment.contains("a.status = 'complete'"));
        assert!(fragment.contains("a.message_id IS NULL"));
        assert!(fragment.contains("NOT a.reserved"));
        assert!(
            fragment.contains("GREATEST(a.created_at, COALESCE(a.unreserved_at, a.created_at))")
        );
        assert!(candidate_sql().contains(&fragment));
        assert!(!candidate_sql().contains("drive_file_id"));
    }

    #[test]
    fn the_ttl_is_thirty_days() {
        assert_eq!(UNBOUND_TTL.as_secs(), 30 * 24 * 60 * 60);
    }

    #[test]
    fn counts_total_by_outcome() {
        let mut counts = AttachmentReclaimCounts::default();
        for outcome in [
            AttachmentReclaimOutcome::Reclaimed,
            AttachmentReclaimOutcome::Reclaimed,
            AttachmentReclaimOutcome::SkippedNotEligible,
            AttachmentReclaimOutcome::DriveFailed,
            AttachmentReclaimOutcome::Refused,
        ] {
            counts.record(outcome);
        }
        assert_eq!(
            counts,
            AttachmentReclaimCounts {
                reclaimed: 2,
                skipped_not_eligible: 1,
                drive_failed: 1,
                refused: 1,
            }
        );
        let mut total = AttachmentReclaimCounts::default();
        total.add(&counts);
        total.add(&counts);
        assert_eq!(total.reclaimed, 4);
    }
}
