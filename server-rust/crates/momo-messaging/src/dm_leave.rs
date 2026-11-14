//! 1:1 「대화 나가기」 — the requester's own read floor in a person-to-person DM
//! (ADR-0177 증보 2026-11-14 D14~D18, #5822).
//!
//! Leaving changes no participation and no message. It raises **one number**,
//! `membership.history_from_seq` (migration 180): "this member reads this channel from here on".
//! The `message` read policy `dm_leave_history_floor` (same migration) compares every row against it
//! for the request's human requester (`app.requester_member_id`, bound by `momo_db::tenant`), so
//! history, threads, search, pins, reactions, the inbox join, attachments and push fetches are all
//! closed by that one predicate instead of by a filter on each path (D17).
//!
//! This module holds the pieces of the D16 transaction that belong to the messaging domain. The
//! order they run in is the route's (`momo-server` `routes::dm_leave`), because one step — the
//! pending agent admission — belongs to the server crate:
//!
//! 1. [`dm_leave_participant_in_tx`] — is the requester a live participant of an unarchived DM? (404
//!    otherwise, before anything else is read or locked, so a probe learns nothing about a room it
//!    is not in.)
//! 2. [`lock_and_classify_in_tx`] — `channel_seq` row first, then the `membership` rows (the send
//!    path's order, ADR-0221 D9), and the D20 scope judgment (409 outside it).
//! 3. [`clear_own_items_below_in_tx`] — the requester's schedules in this channel, and their
//!    reminders, thread follows and inbox items on messages below the new floor. **Before** the
//!    floor moves: reminders and follows find their message through a `message` join, which the
//!    policy hides once the floor is up.
//! 4. [`raise_history_floor_in_tx`] — `GREATEST(existing, new)`; never lowered.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::owner_scope::{bind_owner_guc, clear_owner_guc};
use crate::scheduled::{cancel_channel_schedules_in_tx, ScheduleActor};

/// The D20 judgment, taken under the D16 locks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DmLeaveClass {
    /// Not an unarchived DM the requester is a live participant of.
    NotFound,
    /// A DM the requester is in, but not a person-to-person 1:1 (an agent seat, a group DM, an
    /// admitted room, or no live counterpart). The route answers 409 `dm_leave_unavailable`.
    Unavailable,
    /// In scope. `last_seq` is the channel head read under the `channel_seq` row lock; `floor` is
    /// the requester's current `history_from_seq` (`None` = full history).
    Eligible { last_seq: i64, floor: Option<i64> },
}

/// The floor a leave stores (D16): `LEAST(seenSeq, head) + 1`, never below what is already stored.
/// `seen_seq` is validated `>= 0` by the route; the head clamp keeps a future `seenSeq` from hiding
/// the next message that arrives.
pub fn next_history_floor(seen_seq: i64, last_seq: i64, existing: Option<i64>) -> i64 {
    let proposed = seen_seq.min(last_seq).max(0) + 1;
    existing.map_or(proposed, |current| current.max(proposed))
}

/// What the requester's own clean-up removed (D16-1). Counts are rows, read back from the
/// statements themselves.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DmLeaveCleanup {
    pub cancelled_schedules: usize,
    pub reminders: u64,
    pub thread_follows: u64,
    pub inbox_items: u64,
}

/// Is `channel_id` an unarchived DM the member is a live participant of? No lock: this is only the
/// gate that decides between 404 and going on. [`lock_and_classify_in_tx`] re-reads under locks.
pub async fn dm_leave_participant_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT c.id \
           FROM channel c \
           JOIN membership ms \
             ON ms.channel_id = c.id \
            AND ms.workspace_id = $1 \
            AND ms.member_id = $3 \
            AND ms.left_at IS NULL \
          WHERE c.id = $2 \
            AND c.workspace_id = $1 \
            AND c.kind = 'dm' \
            AND c.archived_at IS NULL",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.is_some())
}

/// Lock the requester's open schedules in this room (`pending`, `failed`) **before** the
/// `channel_seq` row. Sending a schedule — 「지금 보내기」 or the background loop — locks the schedule
/// row and then `channel_seq`; the leave cancels those rows after `channel_seq`, so without this the
/// two take the same pair of locks in opposite orders and deadlock. Taken here, a send that already
/// holds a row makes the leave wait for it, and a send that comes later waits for the leave (or, for
/// the loop's `SKIP LOCKED`, passes the row by). Owner-scoped table: bound and cleared like the
/// clean-up below.
pub async fn lock_own_open_schedules_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<(), DbError> {
    bind_owner_guc(conn, member_id).await?;
    sqlx::query(
        "SELECT id FROM scheduled_message \
          WHERE workspace_id = $1 AND author_member_id = $2 AND channel_id = $3 \
            AND status IN ('pending', 'failed') \
          ORDER BY id \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await?;
    clear_owner_guc(conn).await?;
    Ok(())
}

/// Take the D16 locks — the `channel_seq` row `FOR UPDATE`, then the live `membership` rows
/// `FOR SHARE` — and judge the D20 scope under them.
///
/// In scope: `kind = 'dm'`, not archived, a `dm_key` with neither the `group:` nor the `admitted:`
/// prefix, exactly two live participants, both `member.kind = 'human'`, the requester one of them.
/// A suspended counterpart still has a participation row and is in scope (D20).
pub async fn lock_and_classify_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<DmLeaveClass, DbError> {
    let head = sqlx::query(
        "SELECT cs.last_seq, c.dm_key \
           FROM channel_seq cs \
           JOIN channel c \
             ON c.id = cs.channel_id \
            AND c.workspace_id = $1 \
          WHERE cs.channel_id = $2 \
            AND cs.workspace_id = $1 \
            AND c.kind = 'dm' \
            AND c.archived_at IS NULL \
          FOR UPDATE OF cs",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(head) = head else {
        return Ok(DmLeaveClass::NotFound);
    };
    let last_seq: i64 = head.try_get("last_seq")?;
    let dm_key: Option<String> = head.try_get("dm_key")?;

    let seats = sqlx::query(
        "SELECT ms.member_id, m.kind::text AS kind, ms.history_from_seq \
           FROM membership ms \
           JOIN member m \
             ON m.id = ms.member_id \
            AND m.workspace_id = ms.workspace_id \
          WHERE ms.workspace_id = $1 \
            AND ms.channel_id = $2 \
            AND ms.left_at IS NULL \
          ORDER BY ms.member_id \
          FOR SHARE OF ms",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await?;
    let mine = seats
        .iter()
        .find(|row| row.try_get::<Uuid, _>("member_id").ok() == Some(member_id));
    let Some(mine) = mine else {
        return Ok(DmLeaveClass::NotFound);
    };
    let floor: Option<i64> = mine.try_get("history_from_seq")?;

    let prefixed = dm_key
        .as_deref()
        .is_some_and(|key| key.starts_with("group:") || key.starts_with("admitted:"));
    let all_human = seats
        .iter()
        .all(|row| row.try_get::<String, _>("kind").ok().as_deref() == Some("human"));
    if prefixed || seats.len() != 2 || !all_human {
        return Ok(DmLeaveClass::Unavailable);
    }
    Ok(DmLeaveClass::Eligible { last_seq, floor })
}

/// D16-1 — the requester's own things in this channel, cleared **before** the floor moves.
///
/// * Schedules: every `pending`/`failed` schedule of the requester **in this channel** is cancelled
///   (body erased, attachments released, one audit row each with `cause = dm_left`). Schedules in
///   other channels are untouched.
/// * Reminders and thread follows on messages with `seq < floor`: found through a `message` join —
///   which is why this runs while those messages are still readable in this transaction.
/// * Inbox items with `seq < floor` (the table carries the seq).
///
/// The owner-scoped tables (`message_reminder`, `scheduled_message`) read `app.member_id`, so the
/// transaction speaks as the requester for these statements and is unbound again afterwards
/// (`owner_scope`'s bind/clear pair). The requester value (`app.requester_member_id`) is a
/// different setting and is not touched.
pub async fn clear_own_items_below_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    floor: i64,
    actor: ScheduleActor,
) -> Result<DmLeaveCleanup, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let cancelled =
        cancel_channel_schedules_in_tx(conn, workspace_id, member_id, channel_id, actor).await?;
    let reminders = sqlx::query(
        "DELETE FROM message_reminder r \
          USING message m \
          WHERE r.workspace_id = $1 \
            AND r.channel_id = $2 \
            AND r.member_id = $3 \
            AND m.id = r.message_id \
            AND m.channel_id = r.channel_id \
            AND m.seq < $4",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .bind(floor)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    let thread_follows = sqlx::query(
        "DELETE FROM thread_follow tf \
          USING message m \
          WHERE tf.workspace_id = $1 \
            AND tf.channel_id = $2 \
            AND tf.member_id = $3 \
            AND m.id = tf.root_id \
            AND m.channel_id = tf.channel_id \
            AND m.seq < $4",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .bind(floor)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    let inbox_items = sqlx::query(
        "DELETE FROM inbox_item \
          WHERE workspace_id = $1 \
            AND channel_id = $2 \
            AND member_id = $3 \
            AND seq < $4",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .bind(floor)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    clear_owner_guc(conn).await?;
    Ok(DmLeaveCleanup {
        cancelled_schedules: cancelled.len(),
        reminders,
        thread_follows,
        inbox_items,
    })
}

/// D16-3 — store `GREATEST(existing, floor)` on the requester's own membership row and return what
/// is stored. Only ever raises: a late retransmit cannot lower it, and there is no API that does.
pub async fn raise_history_floor_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    floor: i64,
) -> Result<i64, DbError> {
    let stored: i64 = sqlx::query_scalar(
        "UPDATE membership \
            SET history_from_seq = GREATEST(COALESCE(history_from_seq, 0), $4) \
          WHERE workspace_id = $1 \
            AND channel_id = $2 \
            AND member_id = $3 \
            AND left_at IS NULL \
          RETURNING history_from_seq",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .bind(floor)
    .fetch_one(&mut *conn)
    .await?;
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_floor_is_one_past_what_the_client_saw_clamped_by_the_head() {
        // seen below the head: a message that arrived during the confirm stays above the floor.
        assert_eq!(next_history_floor(5, 6, None), 6);
        // seen past the head (a bogus value) is clamped: the next message stays visible.
        assert_eq!(next_history_floor(99, 6, None), 7);
        // an empty conversation still records a floor (the D18 3a test needs a non-null value).
        assert_eq!(next_history_floor(0, 0, None), 1);
    }

    #[test]
    fn the_floor_never_moves_down() {
        assert_eq!(next_history_floor(3, 10, Some(8)), 8);
        assert_eq!(next_history_floor(9, 10, Some(8)), 10);
        assert_eq!(next_history_floor(9, 10, Some(10)), 10);
    }
}
