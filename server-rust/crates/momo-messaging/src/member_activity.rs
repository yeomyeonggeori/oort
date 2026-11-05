//! Member activity — the heartbeat behind "a web or desktop client of mine is in use"
//! (ADR-0206 D4, #4497).
//!
//! A web or desktop client that is in front **and** was used in the last five minutes `PUT`s a
//! beat every ≤ 20 s; this stamps `member_activity.seen_at = now()` for (workspace, caller). The
//! push judgment's tail (`momo_push::refine_targets`) reads a `seen_at` inside its 30 s window as
//! "my desktop is active" and holds the caller's *phone* pushes for their `phoneDelaySecs`. The phone
//! never sends this (an app in front is silenced by the OS itself).
//!
//! The row is a volatile signal: no trigger, no outbox, no broadcast, and **no read API** — the
//! owner is the bearer and nobody else can ask. The write is skipped when the stored stamp is under
//! [`ACTIVITY_MIN_REFRESH_SECS`] old, so a chatty client costs a no-op `UPDATE … WHERE` instead of a
//! row rewrite per beat (the same cap as `channel_viewing`).
//!
//! That no-op still takes the row's lock (`ON CONFLICT DO UPDATE` locks the conflicting row before it
//! looks at its `WHERE`), so one member's burst of beats queues on one row, and every queued request
//! holds a pool connection while it waits. The wait is therefore **bounded**
//! ([`ACTIVITY_LOCK_WAIT_SECS`], `lock_timeout` local to the caller's transaction): a beat that cannot
//! get the row in time fails with `55P03` and the route answers a retryable 503 — nothing was written,
//! and the next beat is at most 20 s away anyway (#5353, the #4497 review's L-2).

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::identity::active_workspace_role;

/// A beat newer than this does not rewrite the row. Far below the 30 s window the judgment reads,
/// so the skipped write cannot make a present user look absent.
pub const ACTIVITY_MIN_REFRESH_SECS: i64 = 5;

/// How long one beat waits for a lock (the member's `member_activity` row, or the `member` row the
/// foreign key looks at) before it gives up with `55P03`. Three seconds, the same bound a device
/// registration and a scheduled-message request wait on theirs: far above what a healthy beat holds a
/// lock for (a sub-millisecond statement), far below the pool's own patience.
pub const ACTIVITY_LOCK_WAIT_SECS: u64 = 3;

/// Outcome of a beat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityOutcome {
    /// Recorded (or already fresh enough).
    Recorded,
    /// Not an active member of this workspace (suspended, deleted, or no membership). Writes nothing.
    NotAnActiveMember,
}

/// Stamp the caller as "in use". The caller must be an active member of `workspace_id`.
///
/// The membership check and the write share the caller's transaction, and the refusal returns
/// before the write. Every lock this transaction waits for is a bounded wait
/// ([`ACTIVITY_LOCK_WAIT_SECS`]); losing that wait is a `55P03` the caller turns into a retry.
pub async fn touch_member_activity_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<ActivityOutcome, DbError> {
    // First, so that the statement below and any lock the foreign key takes are bounded. Local to
    // the transaction (`is_local = true`): it ends with it and leaks nothing onto the pooled
    // connection.
    sqlx::query("SELECT set_config('lock_timeout', $1, true)")
        .bind(format!("{ACTIVITY_LOCK_WAIT_SECS}s"))
        .execute(&mut *conn)
        .await?;
    if active_workspace_role(conn, workspace_id, member_id)
        .await?
        .is_none()
    {
        return Ok(ActivityOutcome::NotAnActiveMember);
    }
    sqlx::query(
        "INSERT INTO member_activity (workspace_id, member_id, seen_at) \
         VALUES ($1, $2, now()) \
         ON CONFLICT (workspace_id, member_id) DO UPDATE \
            SET seen_at = now() \
          WHERE member_activity.seen_at < now() - make_interval(secs => $3::double precision)",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(ACTIVITY_MIN_REFRESH_SECS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(ActivityOutcome::Recorded)
}
