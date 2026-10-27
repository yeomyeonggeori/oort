//! Attachment reclaim — the database half of the sweep that deletes completed
//! attachments no message and no schedule holds (ADR-0151 증보 2, #4443).
//!
//! A file is uploaded before the message that carries it, so some uploads are
//! never carried: a draft the composer lost, a cancelled or failed schedule's
//! files, a file whose message was hard-deleted (`ON DELETE SET NULL`). Nothing
//! collected them (ADR-0208 남는 위험 5), so the archive only grew. Two runners
//! delete them once they are older than [`UNBOUND_TTL`] — `momo-notifier` for a
//! Google Drive, `momo-server` for the local volume only the api process can open
//! — and **both are off until an operator sets `MOMO_ATTACHMENT_RECLAIM=1`**
//! ([`delete_switch_is_on`]). Switched off they still look, and write one line
//! with how many files and bytes they *would* delete ([`dry_run_line`]).
//! This module never talks to Drive itself — the runner hands in an
//! [`AttachmentDeleter`], so the SQL here is testable without a Drive and the Drive
//! crate stays free of a database dependency (the `avatar_reclaim` split).
//!
//! ## One definition of "may be deleted" — [`eligible_sql`]
//!
//! A file may be deleted only when **nothing at all points at it**. The references
//! were enumerated, not assumed (#4443 `references.md`, kept in the PR body and in
//! ADR-0151 증보 2):
//!
//! * `status = 'complete'` — `pending` and `failed` rows never reached the state
//!   this sweep is about (ADR-0151 증보 2, 남는 위험);
//! * `message_id IS NULL` — no message carries it (the one writer is
//!   `attachment.rs` `link_attachments_in_tx`);
//! * `NOT reserved` — no schedule holds it (migration 150: a trigger mirrors the
//!   owner-scoped `scheduled_message_attachment`, which this sweep cannot see, onto
//!   the row);
//! * idle for [`UNBOUND_TTL`] from `GREATEST(created_at, unreserved_at)`, so a file
//!   whose schedule was cancelled is a draft for a full TTL from the cancel
//!   (ADR-0208 D11 「초안과 같은 상태」);
//! * [`NO_OTHER_HOLD_SQL`] — no `huddle_transcription_*` row names it (a foreign key
//!   would refuse the delete anyway; the predicate says it first, so the refusal is
//!   never what stops it) and no avatar media row names the same Drive object.
//!
//! Anything the server cannot know about — a client's open composer tray — is
//! memory only (`draftStore.ts`), and the 30 days cover it.
//!
//! ## Two steps, and only the first is cross-tenant
//!
//! 1. [`workspaces_with_reclaim_candidates`] — one cross-tenant **read** on the
//!    notifier's BYPASSRLS pool that answers **workspace ids and nothing else**,
//!    through a column-level `SELECT` grant that stops short of `id`, `drive_file_id`,
//!    `name`, `mime`, `size_bytes`, the uploader and the channel. It is a hint: it may
//!    name a workspace whose files turn out to be held by something it cannot see.
//! 2. [`sweep_workspace`] / [`tally_workspace`] — everything else, **per workspace,
//!    on the RLS-bound `momo_app` pool** (`SET LOCAL app.workspace_id`): the listing
//!    with the *full* predicate, the count and bytes a dry run reports, and one
//!    transaction per file ([`reclaim_unbound_attachment_in_tx`]) that locks the row
//!    and decides again. The api process has no cross-tenant read at all
//!    (`workspace` is FORCE-RLS on `app.workspace_id`, so `momo_app` without the GUC
//!    sees zero rows); it runs step 2 for the workspaces whose **uploads it has served
//!    since it started** (`momo-server` `attachment_reclaim`, [`ReclaimScope::TouchedByThisProcess`])
//!    and needs no new privilege. The price is coverage: a workspace nobody has uploaded to
//!    since the last restart is not looked at until somebody does.
//!
//! Because the listing uses the full predicate, a file something else holds can never
//! sit at the front of the window and starve the rest.
//!
//! ## Order inside the row transaction
//!
//! lock → decide again → `SAVEPOINT` → **delete the row and write the audit row** →
//! Drive delete → on failure `ROLLBACK TO SAVEPOINT`. The row goes first so that a
//! foreign key that refuses the delete stops the transaction **before** any byte is
//! deleted; the Drive call is last, under the row lock, and a failed call changes
//! nothing, so the next tick retries. A crash between "Drive deleted" and `COMMIT`
//! leaves the row, and the next tick's delete is idempotent (an object that is gone
//! is success), after which the row goes.
//!
//! The lock is also the race argument. Binding a file to a message
//! ([`crate::link_attachments_in_tx`]) and reserving it for a schedule
//! ([`crate::scheduled::reserve_attachments_in_tx`]) both take the row `FOR UPDATE`
//! first: either they commit before this sweep's lock — and the re-check sees the
//! message or the reservation — or they wait for it and find the row gone.

use std::sync::Arc;
use std::time::Duration;

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::avatar_reclaim::{DriveDelete, DriveDeleteFuture};

/// How long an unbound completed attachment is kept: 30 days, the retention the inbox
/// and the run-event ledger already use (ADR-0199 D4, ADR-0200 D2), and the mobile
/// composer's own draft lifetime (`DRAFT_TTL_MS`). A draft that old is not in anyone's
/// composer; a schedule's file is exempt (`reserved`), so the 120-day schedule horizon
/// does not set this number. A resumable upload session lives at most a week and
/// `created_at` is the session start, so a *completed* file has at least 23 days.
pub const UNBOUND_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Workspaces one cross-tenant read may name per tick. Each is a handful of small
/// transactions; the batch (files per tick) is what bounds the Drive calls.
pub const MAX_WORKSPACES_PER_TICK: i64 = 100;

/// A tick stops after this many Drive failures in a row, so a Drive that keeps timing
/// out does not hold it for `batch x timeout`.
pub const MAX_CONSECUTIVE_DRIVE_FAILURES: u32 = 3;

/// The one definition of "an operator turned the delete on": `MOMO_ATTACHMENT_RECLAIM`
/// is **exactly `1`**. This job deletes files an operator cannot get back, so it ships
/// off, and anything but the one spelling — `true`, `yes`, `on`, ` 1`, `01`, empty, a
/// typo — leaves it off (the dry-run line says so). Both runners call this and nothing
/// else decides.
pub fn delete_switch_is_on(raw: Option<&str>) -> bool {
    raw == Some("1")
}

/// The part of the definition that uses only columns the BYPASSRLS notifier is granted
/// (`workspace_id`, `status`, `message_id`, `reserved`, `unreserved_at`, `created_at`),
/// with `ttl` bound at `$ttl_param`. The cross-tenant read uses this alone.
pub(crate) fn eligible_core_sql(ttl_param: u8) -> String {
    format!(
        "a.status = 'complete' AND a.message_id IS NULL AND NOT a.reserved \
         AND GREATEST(a.created_at, COALESCE(a.unreserved_at, a.created_at)) \
             < now() - make_interval(secs => ${ttl_param})"
    )
}

/// What **no other row** may hold, for rows that pass [`eligible_core_sql`]. It reads
/// tables and columns the notifier is not granted, so only a tenant-bound transaction
/// evaluates it. Every line is a reference kind in the #4443 reference table:
///
/// * `huddle_transcription_job.merged_transcript_attachment_id` and
///   `huddle_transcription_track.source_attachment_id` / `transcript_attachment_id`
///   (046) — foreign keys with no cascade;
/// * a member or workspace avatar media row that names the **same Drive object**
///   (`drive_file_id`) — a separate table with its own object today, so this is the
///   "two rows, one object" case the delete would break for the other row.
pub(crate) const NO_OTHER_HOLD_SQL: &str = "\
     NOT EXISTS (SELECT 1 FROM huddle_transcription_job j \
                  WHERE j.workspace_id = a.workspace_id \
                    AND j.merged_transcript_attachment_id = a.id) \
 AND NOT EXISTS (SELECT 1 FROM huddle_transcription_track t \
                  WHERE t.workspace_id = a.workspace_id \
                    AND (t.source_attachment_id = a.id OR t.transcript_attachment_id = a.id)) \
 AND NOT EXISTS (SELECT 1 FROM member_avatar_media m \
                  WHERE m.workspace_id = a.workspace_id AND m.drive_file_id = a.drive_file_id) \
 AND NOT EXISTS (SELECT 1 FROM workspace_avatar_media w \
                  WHERE w.workspace_id = a.workspace_id AND w.drive_file_id = a.drive_file_id)";

/// The full definition of "may be deleted": [`eligible_core_sql`] and
/// [`NO_OTHER_HOLD_SQL`]. The per-workspace listing, the dry-run tally and the
/// re-check under the row lock all use this one fragment, so they cannot drift apart.
/// `drive_file_id` is not tested for `NULL` (a `complete` row always has one — CHECK
/// `attachment_drive_file_ck`); the row transaction checks it separately.
pub(crate) fn eligible_sql(ttl_param: u8) -> String {
    format!("{} AND {NO_OTHER_HOLD_SQL}", eligible_core_sql(ttl_param))
}

/// The cross-tenant statement: workspace ids, the ones with the oldest candidates first.
fn workspaces_sql() -> String {
    format!(
        "SELECT a.workspace_id FROM attachment a WHERE {} \
          GROUP BY a.workspace_id ORDER BY min(a.created_at), a.workspace_id LIMIT $2",
        eligible_core_sql(1)
    )
}

/// The re-check under the row lock: the **full** definition ([`eligible_sql`]) on the one row,
/// read in a fresh statement after `FOR UPDATE`. Everything the listing decided is decided
/// again here, so a hold that appeared since the listing is seen — including the holds only a
/// tenant-bound statement can see (the huddle rows, an avatar object).
fn recheck_sql() -> String {
    format!(
        "SELECT a.drive_file_id, a.channel_id, a.uploader_member_id, a.mime, a.size_bytes \
           FROM attachment a WHERE a.id = $1 AND a.workspace_id = $3 AND {}",
        eligible_sql(2)
    )
}

/// The per-workspace listing: attachment ids, oldest first.
fn candidate_ids_sql() -> String {
    format!(
        "SELECT a.id FROM attachment a WHERE a.workspace_id = $3 AND {} \
          ORDER BY a.created_at, a.id LIMIT $2",
        eligible_sql(1)
    )
}

/// The per-workspace dry-run tally: how many files and bytes the delete would take.
fn tally_sql() -> String {
    format!(
        "SELECT count(*)::bigint AS candidates, COALESCE(sum(a.size_bytes), 0)::bigint AS bytes \
           FROM attachment a WHERE a.workspace_id = $2 AND {}",
        eligible_sql(1)
    )
}

/// Workspaces that *may* hold something reclaimable, the ones with the oldest candidate
/// first, at most `limit`.
///
/// **Cross-tenant, read-only, ids only** — the caller connects as the BYPASSRLS notifier
/// role exactly like the avatar reclaim and the retention sweeps. The answer is a hint
/// ([`sweep_workspace`] and [`tally_workspace`] decide with the full predicate under the
/// tenant's own policies); a workspace named here may turn out to have nothing to delete.
pub async fn workspaces_with_reclaim_candidates(
    pool: &PgPool,
    limit: i64,
    ttl: Duration,
) -> Result<Vec<Uuid>, DbError> {
    let rows = sqlx::query(&workspaces_sql())
        .bind(ttl.as_secs_f64())
        .bind(limit.max(1))
        .fetch_all(pool)
        .await?;
    rows.iter()
        .map(|row| row.try_get("workspace_id"))
        .collect::<Result<Vec<Uuid>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// The attachments of one workspace that may be deleted now, oldest first, at most
/// `limit` — the **full** predicate, so a file something else holds is not in the list.
/// The caller's tenant transaction supplies the workspace; the statement repeats it.
pub async fn reclaim_candidate_ids_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    limit: i64,
    ttl: Duration,
) -> Result<Vec<Uuid>, DbError> {
    let rows = sqlx::query(&candidate_ids_sql())
        .bind(ttl.as_secs_f64())
        .bind(limit.max(1))
        .bind(workspace_id)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| row.try_get("id"))
        .collect::<Result<Vec<Uuid>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// How many files and bytes a delete would take out of one workspace right now.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReclaimTally {
    pub candidates: i64,
    pub bytes: i64,
}

impl ReclaimTally {
    pub fn add(&mut self, other: &ReclaimTally) {
        self.candidates += other.candidates;
        self.bytes += other.bytes;
    }
}

/// [`ReclaimTally`] of one workspace, inside the caller's tenant transaction. The same
/// predicate the delete uses, over **all** of the workspace's files, not one batch.
pub async fn reclaim_tally_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    ttl: Duration,
) -> Result<ReclaimTally, DbError> {
    let row = sqlx::query(&tally_sql())
        .bind(ttl.as_secs_f64())
        .bind(workspace_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(ReclaimTally {
        candidates: row.try_get("candidates")?,
        bytes: row.try_get("bytes")?,
    })
}

/// What one per-attachment transaction did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentReclaimOutcome {
    /// The row and the Drive object are gone (Drive deleted it, or said it was already
    /// gone), and the audit row was written in the same transaction.
    Reclaimed,
    /// Not (or no longer) reclaimable: a message or a schedule took it, something else
    /// holds it, it is younger than the TTL, it is not `complete`, or the row is gone.
    /// Nothing was written.
    SkippedNotEligible,
    /// Drive could not be reached or answered with a transient failure. Nothing was
    /// written; the next tick retries.
    DriveFailed,
    /// Drive permanently refused (the file is not on this archive's drive, or the
    /// stored id is malformed). Nothing was written and the object was left alone —
    /// it is not ours to delete, and deleting the row would forget where it is.
    Refused,
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
    let row = sqlx::query(&recheck_sql())
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

/// What deletes the Drive object. The notifier implements it over Google Drive, the api
/// process over the local volume; each classifies its own archive's answers into
/// [`DriveDelete`] (an object that is already gone is success).
pub trait AttachmentDeleter: Send + Sync {
    /// Delete the object `drive_file_id` names. Runs under the row lock, so it should
    /// answer within a bounded time.
    fn delete<'a>(&'a self, drive_file_id: &'a str) -> DriveDeleteFuture<'a>;

    /// The archive said it is not configured at all: every further call would fail the
    /// same way, so the tick stops.
    fn unavailable(&self) -> bool {
        false
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

/// What one workspace's delete pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceSweep {
    pub counts: AttachmentReclaimCounts,
    /// Per-file transactions that failed in the database (a foreign key, a timeout…).
    pub db_errors: u32,
    /// Files the listing returned. `0` means nothing here is deletable right now.
    pub listed: u32,
    /// The tick should stop: the Drive keeps failing, or is not configured at all.
    pub stop: bool,
}

/// Delete up to `budget` of one workspace's reclaimable files, one tenant transaction per
/// file. `consecutive_failures` is the tick's running count of Drive failures in a row
/// (shared across workspaces); the pass stops when it reaches
/// [`MAX_CONSECUTIVE_DRIVE_FAILURES`].
///
/// `Err` only when the listing itself could not run; a file's own failure is counted in
/// [`WorkspaceSweep::db_errors`] and the pass goes on.
pub async fn sweep_workspace(
    write_pool: &PgPool,
    workspace_id: Uuid,
    ttl: Duration,
    budget: i64,
    deleter: &Arc<dyn AttachmentDeleter>,
    consecutive_failures: &mut u32,
) -> Result<WorkspaceSweep, DbError> {
    let ids = with_tenant_tx(write_pool, workspace_id, move |conn| {
        Box::pin(async move { reclaim_candidate_ids_in_tx(conn, workspace_id, budget, ttl).await })
    })
    .await?;
    let mut sweep = WorkspaceSweep {
        listed: u32::try_from(ids.len()).unwrap_or(u32::MAX),
        ..WorkspaceSweep::default()
    };

    for attachment_id in ids {
        if *consecutive_failures >= MAX_CONSECUTIVE_DRIVE_FAILURES || deleter.unavailable() {
            sweep.stop = true;
            break;
        }
        let deleter = Arc::clone(deleter);
        let result = with_tenant_tx(write_pool, workspace_id, move |conn| {
            Box::pin(async move {
                reclaim_unbound_attachment_in_tx(
                    conn,
                    workspace_id,
                    attachment_id,
                    ttl,
                    move |file_id| Box::pin(async move { deleter.delete(file_id).await }),
                )
                .await
            })
        })
        .await;
        match result {
            Ok(outcome) => {
                sweep.counts.record(outcome);
                if outcome == AttachmentReclaimOutcome::DriveFailed {
                    *consecutive_failures += 1;
                } else {
                    *consecutive_failures = 0;
                }
            }
            Err(_) => sweep.db_errors += 1,
        }
    }
    Ok(sweep)
}

/// [`ReclaimTally`] of one workspace on the RLS-bound pool, in its own tenant
/// transaction. Writes nothing.
pub async fn tally_workspace(
    write_pool: &PgPool,
    workspace_id: Uuid,
    ttl: Duration,
) -> Result<ReclaimTally, DbError> {
    with_tenant_tx(write_pool, workspace_id, move |conn| {
        Box::pin(async move { reclaim_tally_in_tx(conn, workspace_id, ttl).await })
    })
    .await
}

/// Where a tick's list of workspaces came from. It decides what the dry-run line's numbers
/// *mean*, so the line names it ([`dry_run_line`]) — an operator who compares the line with
/// `infra/rust/sql/attachment_reclaim_check.sql` must know whether the line was allowed to see
/// every workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReclaimScope {
    /// The notifier: one cross-tenant read ([`workspaces_with_reclaim_candidates`]) names the
    /// workspaces that may hold a candidate, at most [`MAX_WORKSPACES_PER_TICK`] a tick (the
    /// ones with the oldest candidate first). A tick that looked at exactly that many may have
    /// left others unlooked-at.
    AllWorkspaces,
    /// The api process on the local volume: it has **no** cross-tenant read (a `momo_app`
    /// connection without `app.workspace_id` sees no `workspace` row at all, and a new
    /// `SECURITY DEFINER` to enumerate them was not made), so it looks only at the workspaces
    /// whose uploads it has served since it started. A workspace nobody has uploaded to since
    /// the last restart is not looked at until somebody does.
    TouchedByThisProcess,
}

impl ReclaimScope {
    fn as_str(self) -> &'static str {
        match self {
            ReclaimScope::AllWorkspaces => "all",
            ReclaimScope::TouchedByThisProcess => "touched",
        }
    }
}

/// What one tick did. Counts only (no names, no member ids, no Drive ids).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AttachmentReclaimStats {
    /// Workspaces the tick examined (listed or counted a candidate in) — see
    /// [`ReclaimScope`] for which workspaces it was allowed to look at.
    pub looked_at: usize,
    /// Of those, the ones that had at least one file to delete (or, switched off, to count).
    pub workspaces: usize,
    pub counts: AttachmentReclaimCounts,
    /// Per-file or per-workspace transactions that failed in the database.
    pub db_errors: u32,
    /// The workspaces behind `db_errors` (at most [`MAX_REPORTED_FAILED_WORKSPACES`]): a UUID
    /// names no person, and "which workspace is failing" is what an operator needs.
    pub failed_workspaces: Vec<Uuid>,
    /// Set on a switched-off tick: the files and bytes the delete would take. `None` when the
    /// delete ran.
    pub dry_run: Option<ReclaimTally>,
}

/// How many failing workspace ids one tick reports.
pub const MAX_REPORTED_FAILED_WORKSPACES: usize = 20;

impl AttachmentReclaimStats {
    fn record_failure(&mut self, workspace_id: Uuid, db_errors: u32) {
        self.db_errors += db_errors;
        if self.failed_workspaces.len() < MAX_REPORTED_FAILED_WORKSPACES
            && !self.failed_workspaces.contains(&workspace_id)
        {
            self.failed_workspaces.push(workspace_id);
        }
    }
}

/// One tick's work over `workspaces`, on the **RLS-bound** write pool — the part both runners
/// share (the notifier over a Google Drive, the api process over the local volume), so the two
/// cannot decide "what may be deleted" or "what the dry run counts" differently.
///
/// `deleter = None` is the switched-off tick: every workspace is counted with the delete's own
/// predicate ([`tally_workspace`]) and nothing is written. `Some(deleter)` deletes up to
/// `batch` files in total, workspace by workspace, and stops early after
/// [`MAX_CONSECUTIVE_DRIVE_FAILURES`] failures in a row or when the archive says it is not
/// configured at all. The caller has already checked that `write_pool` is RLS-bound
/// ([`crate::avatar_reclaim::ensure_write_pool_rls_bound`]).
pub async fn reclaim_pass(
    write_pool: &PgPool,
    workspaces: Vec<Uuid>,
    ttl: Duration,
    batch: i64,
    deleter: Option<&Arc<dyn AttachmentDeleter>>,
) -> AttachmentReclaimStats {
    let mut stats = AttachmentReclaimStats::default();

    let Some(deleter) = deleter else {
        let mut total = ReclaimTally::default();
        for workspace_id in workspaces {
            stats.looked_at += 1;
            match tally_workspace(write_pool, workspace_id, ttl).await {
                Ok(tally) => {
                    if tally.candidates > 0 {
                        stats.workspaces += 1;
                    }
                    total.add(&tally);
                }
                Err(_) => stats.record_failure(workspace_id, 1),
            }
        }
        stats.dry_run = Some(total);
        return stats;
    };

    let mut budget = batch.max(1);
    // A Drive that keeps failing (timeouts, 5xx) must not hold the tick for
    // batch x timeout: stop after a few consecutive failures.
    let mut consecutive_drive_failures = 0u32;
    for workspace_id in workspaces {
        if budget <= 0 {
            break;
        }
        stats.looked_at += 1;
        match sweep_workspace(
            write_pool,
            workspace_id,
            ttl,
            budget,
            deleter,
            &mut consecutive_drive_failures,
        )
        .await
        {
            Ok(sweep) => {
                if sweep.listed > 0 {
                    stats.workspaces += 1;
                }
                stats.counts.add(&sweep.counts);
                if sweep.db_errors > 0 {
                    stats.record_failure(workspace_id, sweep.db_errors);
                }
                budget -= i64::from(sweep.listed);
                if sweep.stop {
                    break;
                }
            }
            Err(_) => stats.record_failure(workspace_id, 1),
        }
    }
    stats
}

/// The line a switched-off tick writes. Fixed text, because an operator compares its
/// numbers with `infra/rust/sql/attachment_reclaim_check.sql` before turning the delete
/// on. `candidates` and `bytes` are what the enabled sweep would delete from the
/// `looked_at` workspaces the tick examined (every file the full predicate allows, not one
/// batch), `workspaces` of which had at least one. `scope` says which workspaces the tick was
/// allowed to look at ([`ReclaimScope`]): the line can only be **at most** what the check SQL
/// counts over the whole database, never more. Counts only — no name, no id.
pub fn dry_run_line(
    scope: ReclaimScope,
    looked_at: usize,
    workspaces: usize,
    tally: &ReclaimTally,
) -> String {
    format!(
        "attachment reclaim dry-run: delete_enabled=false scope={} looked_at={looked_at} \
         workspaces={workspaces} candidates={} bytes={} \
         (nothing is deleted; MOMO_ATTACHMENT_RECLAIM=1 turns the delete on)",
        scope.as_str(),
        tally.candidates,
        tally.bytes
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cross-tenant read runs as the BYPASSRLS notifier through a **column** grant
    /// (migration 150, `bootstrap_runtime_roles.sql`). A column this statement names that
    /// the grant does not cover fails in production and passes against the dev roles
    /// (which hold table-level grants) — so the columns it names are pinned here, and
    /// `scripts/tests/test_notifier_role_grants.sh` pins the same list against the
    /// bootstrap.
    #[test]
    fn the_cross_tenant_read_names_only_the_columns_the_notifier_is_granted() {
        const GRANTED: [&str; 6] = [
            "workspace_id",
            "status",
            "message_id",
            "reserved",
            "unreserved_at",
            "created_at",
        ];
        let sql = workspaces_sql();
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
                "the cross-tenant read names `{column}`, which the notifier is not granted: {sql}"
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
        // It reads one relation, and none of the tables only the tenant pool may see.
        for table in [
            "huddle_",
            "avatar_media",
            "scheduled_message",
            "drive_file_id",
        ] {
            assert!(
                !sql.contains(table),
                "the cross-tenant read must not touch `{table}`: {sql}"
            );
        }
        assert!(
            !sql.contains("a.id"),
            "the cross-tenant read answers workspace ids only: {sql}"
        );
    }

    /// The core fragment is what the notifier can evaluate; what it requires is spelled
    /// out so a weakened copy cannot slip in.
    #[test]
    fn eligibility_requires_complete_unbound_unreserved_and_idle() {
        let fragment = eligible_core_sql(1);
        assert!(fragment.contains("a.status = 'complete'"));
        assert!(fragment.contains("a.message_id IS NULL"));
        assert!(fragment.contains("NOT a.reserved"));
        assert!(
            fragment.contains("GREATEST(a.created_at, COALESCE(a.unreserved_at, a.created_at))")
        );
        assert!(workspaces_sql().contains(&fragment));
    }

    /// The full fragment adds every reference the notifier cannot see, and the listing,
    /// the tally and the re-check all embed it — the three cannot drift apart.
    #[test]
    fn the_full_definition_adds_every_other_hold_and_every_statement_embeds_it() {
        let full = eligible_sql(1);
        assert!(full.starts_with(&eligible_core_sql(1)));
        for hold in [
            "FROM huddle_transcription_job j",
            "j.merged_transcript_attachment_id = a.id",
            "FROM huddle_transcription_track t",
            "t.source_attachment_id = a.id",
            "t.transcript_attachment_id = a.id",
            "FROM member_avatar_media m",
            "FROM workspace_avatar_media w",
            "m.drive_file_id = a.drive_file_id",
            "w.drive_file_id = a.drive_file_id",
        ] {
            assert!(full.contains(hold), "missing `{hold}` in {full}");
        }
        assert_eq!(
            full.matches("NOT EXISTS").count(),
            4,
            "four reference kinds, four NOT EXISTS: {full}"
        );
        assert!(candidate_ids_sql().contains(&full));
        assert!(tally_sql().contains(&full));
        // Every per-workspace statement repeats the workspace (RLS is not the only fence).
        assert!(candidate_ids_sql().contains("a.workspace_id = $3"));
        assert!(tally_sql().contains("a.workspace_id = $2"));
        // The cross-tenant statement does not carry the full predicate (it could not run).
        assert!(!workspaces_sql().contains("NOT EXISTS"));
    }

    /// The operator compares the sweep's dry-run line with `infra/rust/sql/attachment_reclaim_check.sql`,
    /// so the SQL's candidate predicate must be the sweep's predicate **word for word** — only the
    /// bound TTL is spelled out as a number. A change to one term in either place fails here, and
    /// the PG suite then checks that the two count the same files.
    #[test]
    fn the_operators_check_sql_embeds_the_sweeps_predicate_word_for_word() {
        let sql = include_str!("../../../../infra/rust/sql/attachment_reclaim_check.sql");
        let normalize = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
        let wanted = eligible_sql(1).replace("$1", &UNBOUND_TTL.as_secs().to_string());
        assert!(
            normalize(sql).contains(&normalize(&wanted)),
            "the check SQL's `cand` predicate drifted from `eligible_sql`:\n  wanted: {}\n",
            normalize(&wanted)
        );
        // The TTL it names is the sweep's.
        assert!(sql.contains(&format!("make_interval(secs => {})", UNBOUND_TTL.as_secs())));
        // A read-only statement: no write verb appears in the code, once comments and the text
        // inside string literals (which says things like "turning the delete on") are removed.
        let mut code = String::new();
        for line in sql
            .lines()
            .filter(|line| !line.trim_start().starts_with("--"))
        {
            let mut in_literal = false;
            for c in line.chars() {
                if c == '\'' {
                    in_literal = !in_literal;
                } else if !in_literal {
                    code.push(c);
                }
            }
            code.push('\n');
        }
        let words: Vec<String> = code
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .filter(|word| !word.is_empty())
            .map(str::to_uppercase)
            .collect();
        for verb in [
            "INSERT", "UPDATE", "DELETE", "TRUNCATE", "ALTER", "DROP", "CREATE", "GRANT", "REVOKE",
            "COPY",
        ] {
            assert!(
                !words.iter().any(|word| word == verb),
                "the check SQL must not contain {verb} outside comments and string literals"
            );
        }
        assert!(words.windows(3).any(|w| w == ["BEGIN", "READ", "ONLY"]));
        assert!(words.iter().any(|word| word == "ROLLBACK"));
    }

    /// The statement that decides **after the row lock** is the full definition, not the part
    /// the notifier could evaluate: a hold that only a tenant-bound statement can see (a huddle
    /// row, an avatar object) must still stop the delete when it appears between the listing and
    /// the lock. The PG suite proves the behaviour; this pins the text the behaviour rests on.
    #[test]
    fn the_recheck_under_the_lock_embeds_the_full_definition_for_one_row() {
        let sql = recheck_sql();
        assert!(sql.contains(&eligible_sql(2)), "{sql}");
        assert!(
            sql.contains("NOT EXISTS"),
            "the full definition has its NOT EXISTS terms: {sql}"
        );
        assert!(
            sql.contains("a.id = $1 AND a.workspace_id = $3"),
            "one row, in its workspace: {sql}"
        );
        assert_ne!(sql, eligible_core_sql(2), "not the core part alone");
    }

    #[test]
    fn the_ttl_is_thirty_days() {
        assert_eq!(UNBOUND_TTL.as_secs(), 30 * 24 * 60 * 60);
    }

    /// The delete ships off. Exactly the one spelling `1` turns it on: this job deletes
    /// files an operator cannot get back, so a near miss must not.
    #[test]
    fn only_exactly_one_turns_the_delete_on() {
        assert!(delete_switch_is_on(Some("1")));
        for off in [
            None,
            Some(""),
            Some(" "),
            Some("0"),
            Some("11"),
            Some("01"),
            Some(" 1"),
            Some("1 "),
            Some("true"),
            Some("TRUE"),
            Some("yes"),
            Some("on"),
            Some("enable"),
            Some("one"),
        ] {
            assert!(!delete_switch_is_on(off), "{off:?} must leave it off");
        }
    }

    /// What the operator reads on every switched-off tick: fixed text with the three
    /// numbers they compare against the check SQL, and the instruction that turns it on.
    #[test]
    fn the_dry_run_line_carries_the_numbers_an_operator_compares() {
        let tally = ReclaimTally {
            candidates: 12,
            bytes: 3405,
        };
        assert_eq!(
            dry_run_line(ReclaimScope::AllWorkspaces, 5, 3, &tally),
            "attachment reclaim dry-run: delete_enabled=false scope=all looked_at=5 workspaces=3 \
             candidates=12 bytes=3405 \
             (nothing is deleted; MOMO_ATTACHMENT_RECLAIM=1 turns the delete on)"
        );
        // The api process on the local volume can only look at what it has served; the line
        // says so, because that is the number's meaning (never more than the check SQL's).
        assert_eq!(
            dry_run_line(ReclaimScope::TouchedByThisProcess, 1, 1, &tally),
            "attachment reclaim dry-run: delete_enabled=false scope=touched looked_at=1 \
             workspaces=1 candidates=12 bytes=3405 \
             (nothing is deleted; MOMO_ATTACHMENT_RECLAIM=1 turns the delete on)"
        );
    }

    #[test]
    fn a_failing_workspace_is_reported_once_and_the_list_is_bounded() {
        let mut stats = AttachmentReclaimStats::default();
        let one = Uuid::from_u128(1);
        stats.record_failure(one, 2);
        stats.record_failure(one, 1);
        assert_eq!(stats.db_errors, 3, "every failure is counted");
        assert_eq!(
            stats.failed_workspaces,
            vec![one],
            "a workspace is named once"
        );
        for n in 2..(MAX_REPORTED_FAILED_WORKSPACES as u128 + 10) {
            stats.record_failure(Uuid::from_u128(n), 1);
        }
        assert_eq!(
            stats.failed_workspaces.len(),
            MAX_REPORTED_FAILED_WORKSPACES
        );
        assert_eq!(
            stats.db_errors,
            3 + (MAX_REPORTED_FAILED_WORKSPACES as u32 + 8)
        );
    }

    #[test]
    fn tallies_add_up() {
        let mut total = ReclaimTally::default();
        total.add(&ReclaimTally {
            candidates: 2,
            bytes: 10,
        });
        total.add(&ReclaimTally {
            candidates: 5,
            bytes: 7,
        });
        assert_eq!(
            total,
            ReclaimTally {
                candidates: 7,
                bytes: 17
            }
        );
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
