//! Channel viewing — the presence heartbeat behind "are they looking at this channel"
//! (ADR-0204 증보 3, #4018).
//!
//! A client that has a channel on screen `PUT`s a heartbeat every few seconds; this stamps
//! `channel_viewing.seen_at = now()` for (channel, caller). The push judgment treats a
//! `seen_at` inside its 30 s window as "looking", which a read cursor cannot say for a
//! stream (a stream spends no `seq`, so the cursor stands still while someone watches).
//!
//! The row is a volatile signal: no trigger, no outbox, no broadcast. The write is skipped
//! when the stored stamp is under [`VIEWING_MIN_REFRESH_SECS`] old, so a chatty client costs a
//! no-op `UPDATE ... WHERE` instead of a row rewrite per beat.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// A beat newer than this does not rewrite the row. Far below the 30 s window the judgment
/// reads, so the skipped write cannot make a present reader look absent.
pub const VIEWING_MIN_REFRESH_SECS: i64 = 5;

/// Outcome of a heartbeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewingOutcome {
    /// Recorded (or already fresh enough).
    Recorded,
    /// Not a live member of this (unarchived) channel. Writes nothing.
    NotAMember,
}

/// Stamp the caller as looking at `channel_id`. The caller must be a live member.
pub async fn touch_channel_viewing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<ViewingOutcome, DbError> {
    let member: Option<(Uuid,)> = sqlx::query_as(
        "SELECT ms.member_id \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
          WHERE ms.workspace_id = $1 \
            AND ms.channel_id = $2 \
            AND ms.member_id = $3 \
            AND ms.left_at IS NULL",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    if member.is_none() {
        return Ok(ViewingOutcome::NotAMember);
    }
    sqlx::query(
        "INSERT INTO channel_viewing (workspace_id, channel_id, member_id, seen_at) \
         VALUES ($1, $2, $3, now()) \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET seen_at = now() \
          WHERE channel_viewing.seen_at < now() - make_interval(secs => $4::double precision)",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .bind(VIEWING_MIN_REFRESH_SECS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(ViewingOutcome::Recorded)
}
