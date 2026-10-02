//! Avatar Drive reclaim (#3284, ADR-0161 D5 + 증보 2).
//!
//! A replaced, removed, `failed` or abandoned-`pending` avatar leaves its Drive
//! object behind (the media rows are never deleted by the request path). The
//! reclaim sweep in `momo-notifier` deletes those objects. This module is the
//! database half; it never talks to Drive itself — the notifier hands in a
//! `delete` closure, so the SQL here is testable without a Drive and the Drive
//! crate stays free of a database dependency.
//!
//! ## Split (same as `approval_sweep` / `huddle_sweep`)
//!
//! 1. [`avatar_reclaim_candidates`] — one cross-tenant **read** on the notifier's
//!    BYPASSRLS pool (the only way to learn which tenants have work). It returns
//!    ids, never a file id or a name.
//! 2. [`reclaim_avatar_media_in_tx`] — **one media row per tenant transaction**
//!    on an RLS-bound pool (`SET LOCAL app.workspace_id`).
//!
//! ## Never delete a current avatar
//!
//! Inside the tenant transaction the row is locked (`FOR UPDATE`) **first**, and
//! only then, in a fresh statement, is "is it current?" asked. A concurrent
//! complete/replace (`settle_*_upload_in_tx`) writes the media row before it
//! moves the pointer, so it either blocks on this lock until the reclaim has
//! decided (and then finds the row `failed`, which it refuses), or commits first
//! and the reclaim sees the pointer and skips. A pointer UPDATE to a row we hold
//! `FOR UPDATE` blocks on the FK's key-share lock for the same reason. The Drive
//! call happens **inside** that lock; a failed call rolls back and changes
//! nothing, so the next tick retries it.
//!
//! The row is **marked** (`drive_reclaimed_at`), never deleted: deleting a
//! current member row would silently clear the pointer (`ON DELETE SET NULL`),
//! and the upload-rate limit counts recent rows of any status.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

/// A `pending` upload older than this is abandoned. Longer than the 1 h upload
/// capability lifetime (`momo_drive::UPLOAD_SESSION_TTL`);
/// a client that completes after this is refused (the row is `failed`).
pub const PENDING_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Which avatar table a candidate lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AvatarKind {
    Member,
    Workspace,
}

impl AvatarKind {
    fn table(self) -> &'static str {
        match self {
            AvatarKind::Member => "member_avatar_media",
            AvatarKind::Workspace => "workspace_avatar_media",
        }
    }

    /// The statement that is true iff some owner row points at `$1`.
    fn is_current_sql(self) -> &'static str {
        match self {
            AvatarKind::Member => "SELECT EXISTS (SELECT 1 FROM member WHERE avatar_media_id = $1)",
            AvatarKind::Workspace => {
                "SELECT EXISTS (SELECT 1 FROM workspace WHERE avatar_media_id = $1)"
            }
        }
    }
}

/// One media row the sweep may be able to reclaim. Ids only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ReclaimCandidate {
    pub workspace_id: Uuid,
    pub kind: AvatarKind,
    pub media_id: Uuid,
}

/// Why a row was reclaimed — the count the sweep logs and audits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReclaimReason {
    /// `complete`, and no member/workspace points at it any more.
    Replaced,
    /// `failed` with a Drive object (a rejected completion).
    Failed,
    /// `pending` past [`PENDING_TTL`]; the row is marked `failed` too.
    ExpiredPending,
}

/// What one per-row transaction did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReclaimOutcome {
    /// The Drive object is gone (deleted, or Drive said it was already gone).
    Reclaimed(ReclaimReason),
    /// Somebody points at it. Nothing was touched.
    SkippedCurrent,
    /// Not (or no longer) reclaimable: already reclaimed, still-young pending,
    /// no Drive file, or the row is gone.
    SkippedNotEligible,
    /// Drive could not be reached or answered with a transient failure. Nothing
    /// was written; the next tick retries.
    DriveFailed,
    /// Drive permanently refused (the file is not on this archive's drive, or
    /// the stored id is malformed). The row is marked so it stops being retried
    /// — it must not starve newer candidates — but the object is **not** ours
    /// to delete and was left alone.
    Refused,
}

/// How a `delete` closure ended. `Gone` (Drive 404 / already deleted) and
/// `Deleted` are both success; `Failed` keeps the row a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveDelete {
    Deleted,
    Gone,
    Failed,
    /// A permanent refusal; see [`ReclaimOutcome::Refused`].
    Refused,
}

pub type DriveDeleteFuture<'a> = Pin<Box<dyn Future<Output = DriveDelete> + Send + 'a>>;

fn candidate_sql(kind: AvatarKind) -> String {
    let (table, owner) = match kind {
        AvatarKind::Member => ("member_avatar_media", "member"),
        AvatarKind::Workspace => ("workspace_avatar_media", "workspace"),
    };
    format!(
        "SELECT a.workspace_id, a.id FROM {table} a \
          WHERE a.drive_file_id IS NOT NULL AND a.drive_reclaimed_at IS NULL \
            AND ( (a.status = 'pending' AND a.created_at < now() - make_interval(secs => $1)) \
               OR a.status = 'failed' \
               OR (a.status = 'complete' \
                   AND NOT EXISTS (SELECT 1 FROM {owner} o WHERE o.avatar_media_id = a.id)) ) \
          ORDER BY a.created_at, a.id LIMIT $2"
    )
}

/// Rows that look reclaimable, oldest first, at most `limit` per table.
///
/// **Cross-tenant and read-only** — the caller connects as the BYPASSRLS
/// notifier role exactly like the approval and huddle sweeps. The answer is a
/// hint: [`reclaim_avatar_media_in_tx`] re-decides under the row lock.
pub async fn avatar_reclaim_candidates(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<ReclaimCandidate>, DbError> {
    let mut out = Vec::new();
    for kind in [AvatarKind::Member, AvatarKind::Workspace] {
        let rows = sqlx::query(&candidate_sql(kind))
            .bind(PENDING_TTL.as_secs_f64())
            .bind(limit.max(1))
            .fetch_all(pool)
            .await?;
        for row in rows {
            out.push(ReclaimCandidate {
                workspace_id: row.try_get("workspace_id")?,
                kind,
                media_id: row.try_get("id")?,
            });
        }
    }
    Ok(out)
}

/// Reclaim one media row inside the caller's tenant transaction.
///
/// `delete` receives the row's `drive_file_id` and runs **while the row lock is
/// held**. On [`DriveDelete::Failed`] nothing is written.
pub async fn reclaim_avatar_media_in_tx<F>(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    kind: AvatarKind,
    media_id: Uuid,
    delete: F,
) -> Result<ReclaimOutcome, DbError>
where
    F: for<'a> FnOnce(&'a str) -> DriveDeleteFuture<'a> + Send,
{
    let table = kind.table();

    // 1. Lock the row. Everything below is decided after this point.
    let locked = sqlx::query(&format!(
        "SELECT drive_file_id FROM {table} WHERE id = $1 AND workspace_id = $2 FOR UPDATE"
    ))
    .bind(media_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(locked) = locked else {
        return Ok(ReclaimOutcome::SkippedNotEligible);
    };
    let drive_file_id: Option<String> = locked.try_get("drive_file_id")?;
    let Some(drive_file_id) = drive_file_id else {
        return Ok(ReclaimOutcome::SkippedNotEligible);
    };

    // 2. Fresh statements (new snapshot under READ COMMITTED): the lock above
    //    makes a concurrent settle wait, and a settle that committed before it
    //    is visible here.
    let current: bool = sqlx::query_scalar(kind.is_current_sql())
        .bind(media_id)
        .fetch_one(&mut *conn)
        .await?;
    if current {
        return Ok(ReclaimOutcome::SkippedCurrent);
    }
    let state = sqlx::query(&format!(
        "SELECT status, drive_reclaimed_at IS NOT NULL AS reclaimed, \
                created_at < now() - make_interval(secs => $2) AS stale \
           FROM {table} WHERE id = $1"
    ))
    .bind(media_id)
    .bind(PENDING_TTL.as_secs_f64())
    .fetch_one(&mut *conn)
    .await?;
    let status: String = state.try_get("status")?;
    let reclaimed: bool = state.try_get("reclaimed")?;
    let stale: bool = state.try_get("stale")?;
    if reclaimed {
        return Ok(ReclaimOutcome::SkippedNotEligible);
    }
    let reason = match status.as_str() {
        "complete" => ReclaimReason::Replaced,
        "failed" => ReclaimReason::Failed,
        "pending" if stale => ReclaimReason::ExpiredPending,
        _ => return Ok(ReclaimOutcome::SkippedNotEligible),
    };

    // 3. Drive, under the lock. Failure changes nothing.
    let mut refused = false;
    match delete(&drive_file_id).await {
        DriveDelete::Deleted | DriveDelete::Gone => {}
        DriveDelete::Failed => return Ok(ReclaimOutcome::DriveFailed),
        DriveDelete::Refused => refused = true,
    }

    // 4. Mark. A reclaimed `pending` row is also `failed`, so a late completion
    //    is refused instead of pointing at a deleted file.
    sqlx::query(&format!(
        "UPDATE {table} \
            SET drive_reclaimed_at = now(), \
                status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END \
          WHERE id = $1 AND workspace_id = $2 AND drive_reclaimed_at IS NULL"
    ))
    .bind(media_id)
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;
    if refused {
        return Ok(ReclaimOutcome::Refused);
    }
    Ok(ReclaimOutcome::Reclaimed(reason))
}

/// Refuse a write pool whose role is a superuser or BYPASSRLS: the reclaim's
/// writes must be filtered by the tenant policies like a request's, so the GUC
/// the tenant transaction sets is binding rather than decorative.
pub async fn ensure_write_pool_rls_bound(pool: &PgPool) -> Result<(), DbError> {
    let row = sqlx::query(
        "SELECT (rolsuper OR rolbypassrls) AS bypasses \
           FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(pool)
    .await?;
    if row.try_get::<bool, _>("bypasses")? {
        return Err(DbError::from(sqlx::Error::Protocol(
            "avatar reclaim write pool connects as a role that bypasses RLS".into(),
        )));
    }
    Ok(())
}

/// Per-workspace tally of one tick; counts only (no names, no member ids).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReclaimCounts {
    pub replaced: u32,
    pub failed: u32,
    pub expired_pending: u32,
    pub skipped_current: u32,
    pub skipped_not_eligible: u32,
    pub drive_failed: u32,
    pub refused: u32,
}

impl ReclaimCounts {
    pub fn record(&mut self, outcome: ReclaimOutcome) {
        match outcome {
            ReclaimOutcome::Reclaimed(ReclaimReason::Replaced) => self.replaced += 1,
            ReclaimOutcome::Reclaimed(ReclaimReason::Failed) => self.failed += 1,
            ReclaimOutcome::Reclaimed(ReclaimReason::ExpiredPending) => self.expired_pending += 1,
            ReclaimOutcome::SkippedCurrent => self.skipped_current += 1,
            ReclaimOutcome::SkippedNotEligible => self.skipped_not_eligible += 1,
            ReclaimOutcome::DriveFailed => self.drive_failed += 1,
            ReclaimOutcome::Refused => self.refused += 1,
        }
    }

    pub fn reclaimed(&self) -> u32 {
        self.replaced + self.failed + self.expired_pending
    }

    pub fn add(&mut self, other: &ReclaimCounts) {
        self.replaced += other.replaced;
        self.failed += other.failed;
        self.expired_pending += other.expired_pending;
        self.skipped_current += other.skipped_current;
        self.skipped_not_eligible += other.skipped_not_eligible;
        self.drive_failed += other.drive_failed;
        self.refused += other.refused;
    }
}

/// Write the workspace's audit row for a tick that reclaimed something. Actor
/// NULL — the clock is not a member. Counts only: no file name, no Drive id,
/// no member id.
pub async fn write_reclaim_audit(
    pool: &PgPool,
    workspace_id: Uuid,
    counts: ReclaimCounts,
) -> Result<(), DbError> {
    // A tick that only hit permanent refusals still audits: a stored id that
    // names a foreign drive (or fails the id alphabet) is the outcome most worth
    // seeing.
    if counts.reclaimed() == 0 && counts.refused == 0 {
        return Ok(());
    }
    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "avatar.drive_reclaimed").with_schema(
                    "momo.avatar.drive_reclaimed.v1",
                    json!({
                        "replaced": counts.replaced,
                        "failed": counts.failed,
                        "expired_pending": counts.expired_pending,
                        "refused": counts.refused,
                    }),
                ),
            )
            .await
            .map(|_| ())
        })
    })
    .await
}
