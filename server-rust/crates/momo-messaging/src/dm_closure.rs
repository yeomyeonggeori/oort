//! DM closure — a member's own "I closed this DM" fact (ADR-0177 증보 D6·D7, #4227).
//!
//! Closing a DM used to be a per-device `localStorage` ledger, so another device showed it again and
//! a reinstall forgot it. This is the server copy: one `dm_closure` row per (member, channel) holding
//! a **watermark**, `closed_at_seq` — "I closed this having seen up to here". Whether the DM is
//! visible is a comparison the client makes between that watermark and the channel's
//! `latest_readable_seq` (both ride the `GET read-state` projection, D8); nothing here decides it.
//!
//! ## The watermark is the client's, clamped by the head (D7)
//!
//! The write stores `GREATEST(existing, LEAST(seenSeq, channel_seq.last_seq))`:
//!
//! * `seenSeq` comes from the client — the `latest_seq` it was looking at — **not** the server's
//!   `last_seq` at the moment the request lands. A message that arrived between the projection and
//!   this `PUT` has a seq above `seenSeq`, so it is not buried (a server-time watermark would bury it,
//!   ADR review High-1).
//! * `LEAST(.., last_seq)` keeps a bogus or future `seenSeq` from passing the head: a watermark above
//!   the head would hide the next message that arrives.
//! * `GREATEST(existing, ..)` makes the write monotone, so a retransmitted older `PUT` cannot lower the
//!   watermark and a late one cannot erase a later message's visibility. Two identical `PUT`s leave the
//!   same row.
//!
//! Accepted limit (ADR D7): a delayed `PUT` that is processed after the user's `DELETE` (reopen) closes
//! the DM again. A person reopening fixes it and no record is lost.
//!
//! ## Which DMs, and what a refusal looks like
//!
//! Only a **DM** (`channel.kind = 'dm'`), **not archived**, that the caller is a **live participant**
//! of. Everything else — a public channel the caller is in, a DM they are not part of, an archived DM,
//! an id that names nothing — is the same [`DmClosureOutcome::NotFound`], so the answer never tells
//! someone whether another member's DM exists. The check and the write share one transaction and the
//! refusal returns before the first write.
//!
//! ## Member boundary
//!
//! RLS (`ws_isolation`) separates workspaces only. Every statement here — and the projection join in
//! [`crate::read_state`] — carries `member_id = <requester>` as a query predicate (084: the member
//! boundary is the route's, the tenant boundary is the policy's). Removing that predicate from the
//! `DELETE` would let one member reopen everyone's DM; the conformance test closes the same DM as two
//! members and reopens as one.
//!
//! No outbox row, no event (ADR D10): the writing device already has the new state, other devices
//! converge on their next read-state projection.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// What a closure write did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DmClosureOutcome {
    /// Applied. A `DELETE` of a DM that was never closed is also applied: the end state is the one the
    /// caller asked for.
    Applied,
    /// Not a live DM of the caller (wrong kind, archived, not a participant, or no such channel). One
    /// answer for all of them so a probe learns nothing about another member's DMs.
    NotFound,
}

/// Is `channel_id` an unarchived DM the member is a live participant of?
async fn is_closable_dm(
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

/// Close the DM for `member_id`, having seen up to `seen_seq` (D7). `seen_seq` must be `>= 0` — the
/// route refuses a negative one with a 400 before opening a transaction, and the table's
/// `CHECK (closed_at_seq >= 0)` is the backstop.
pub async fn close_dm_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    seen_seq: i64,
) -> Result<DmClosureOutcome, DbError> {
    if !is_closable_dm(conn, workspace_id, channel_id, member_id).await? {
        return Ok(DmClosureOutcome::NotFound);
    }
    // `COALESCE(.., 0)`: `LEAST` ignores NULL, so a missing `channel_seq` row would otherwise let an
    // unclamped `seenSeq` through. Every channel has the row; the clamp must not depend on it.
    sqlx::query(
        "INSERT INTO dm_closure (workspace_id, member_id, channel_id, closed_at_seq) \
         SELECT $1, $3, $2, \
                LEAST($4::bigint, COALESCE( \
                  (SELECT cs.last_seq FROM channel_seq cs \
                    WHERE cs.channel_id = $2 AND cs.workspace_id = $1), 0)) \
         ON CONFLICT (member_id, channel_id) DO UPDATE \
            SET closed_at_seq = GREATEST(dm_closure.closed_at_seq, EXCLUDED.closed_at_seq), \
                closed_at = CASE WHEN EXCLUDED.closed_at_seq > dm_closure.closed_at_seq \
                                 THEN now() ELSE dm_closure.closed_at END",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .bind(seen_seq)
    .execute(&mut *conn)
    .await?;
    Ok(DmClosureOutcome::Applied)
}

/// Reopen the DM for `member_id`: drop the caller's own closure row (D7). No row is fine.
pub async fn reopen_dm_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<DmClosureOutcome, DbError> {
    if !is_closable_dm(conn, workspace_id, channel_id, member_id).await? {
        return Ok(DmClosureOutcome::NotFound);
    }
    sqlx::query(
        "DELETE FROM dm_closure \
          WHERE workspace_id = $1 \
            AND channel_id = $2 \
            AND member_id = $3",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    Ok(DmClosureOutcome::Applied)
}
