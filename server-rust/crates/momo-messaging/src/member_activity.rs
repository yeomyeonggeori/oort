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

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::identity::active_workspace_role;

/// A beat newer than this does not rewrite the row. Far below the 30 s window the judgment reads,
/// so the skipped write cannot make a present user look absent.
pub const ACTIVITY_MIN_REFRESH_SECS: i64 = 5;

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
/// before the write.
pub async fn touch_member_activity_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<ActivityOutcome, DbError> {
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
