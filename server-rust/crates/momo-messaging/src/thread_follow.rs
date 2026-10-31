//! Thread following — who hears about new replies in a thread (ADR-0206 증보 1, #4889).
//!
//! One `thread_follow` row per (thread root, member) with the state `auto` / `followed` /
//! `unfollowed` (migration 164). **Following = `auto` or `followed`; no row = not following.**
//! This module owns every statement that touches the table. Nothing here decides who is *notified*
//! — that is the push judgment's `thread_reply` arm (stage 2) — it only keeps the ledger the arm will
//! read.
//!
//! ## Two writers, one merge table (증보 1 F1)
//!
//! | write                      | no row     | `auto`       | `followed`   | `unfollowed` |
//! |----------------------------|------------|--------------|--------------|--------------|
//! | automatic (send tx)        | `auto`     | unchanged    | unchanged    | **unchanged**|
//! | direct follow (PUT)        | `followed` | `followed`   | unchanged    | `followed`   |
//! | stop following (DELETE)    | `unfollowed`| `unfollowed`| `unfollowed` | unchanged    |
//!
//! The automatic write is `INSERT … ON CONFLICT (root_id, member_id) DO NOTHING`, so the rule "what a
//! person turned off stays off until they turn it on" is one SQL clause and a race with a concurrent
//! unfollow cannot reorder it (the unique key makes one side wait). The direct writes are
//! `DO UPDATE`.
//!
//! ## The automatic follow (F2)
//!
//! [`auto_follow_in_tx`] is called **once** from `finish_send_in_tx`, inside the send transaction,
//! after the dedupe return — a retried send never reaches it, so a retry cannot undo an unfollow. It
//! runs only for a `text` message that the thread machinery counts (`ThreadPolicy::Maintain`, the
//! same match that bumps the rollup): work-session event cards and every line the notifier writes are
//! `Skip`, which is also what keeps `momo_notifier` (table-scoped grants, none on this table) out of
//! this write by construction.
//!
//! Candidates, in one statement: the replier, the root's author, whoever the reply's recorded
//! mentions name, and whoever the root's recorded mentions name. Each is kept only if they are a live
//! human member of this channel and the channel is not a DM. Every predicate carries `workspace_id`
//! explicitly because `momo_worker` (the agent worker's role, which also reaches this write) is
//! BYPASSRLS and the tenant GUC protects nothing there.
//!
//! The mentions are read from the message rows themselves (`props.mention_member_ids`), which the REST
//! send's mention pass wrote earlier in the same transaction. Mentions are recorded on the REST path
//! only (`MentionPolicy::Record`), so an `@` in a line the agent worker writes follows nobody — the
//! same meaning a mention has today.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::message::{validate_replies_root_in_tx, MessageType, StoredMessage, ThreadRootInvalid};

/// `thread_follow.state` — written by the automatic follow.
pub const STATE_AUTO: &str = "auto";
/// `thread_follow.state` — the person pressed 「따라가기」.
pub const STATE_FOLLOWED: &str = "followed";
/// `thread_follow.state` — the person pressed 「그만 따라가기」. Nothing automatic leaves it.
pub const STATE_UNFOLLOWED: &str = "unfollowed";

/// Why a follow / unfollow was refused. The order the variants are produced in is the guard order of
/// `getThreadReplies` (membership, then the root), with the DM rule last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowRefused {
    /// The caller is not a live member of the channel — or the channel does not exist, which the
    /// route answers with the same bytes (a channel is not enumerable by following in it).
    NotAMember,
    /// The root is not a top-level message of this channel (absent, in another channel, or itself a
    /// reply). A deleted root is **not** refused: its replies stay readable, so its follow state
    /// stays settable.
    Root(ThreadRootInvalid),
    /// A DM channel: every message already notifies as `dm`, so following has no meaning there.
    NotApplicable,
}

/// The automatic follow (증보 1 F2). `thread_counted` is `threads == ThreadPolicy::Maintain` at the
/// call site — the private enum stays private to `message.rs`.
///
/// A no-op unless the message is a `text` reply of a counted thread; on a real reply it inserts at
/// most `2 + mentions` rows and never changes an existing one.
pub(crate) async fn auto_follow_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message: &StoredMessage,
    thread_counted: bool,
) -> Result<(), DbError> {
    if !thread_counted || message.message_type != MessageType::Text {
        return Ok(());
    }
    let Some(root_id) = message.root_id else {
        return Ok(());
    };
    sqlx::query(AUTO_FOLLOW_SQL)
        .bind(workspace_id)
        .bind(message.channel_id)
        .bind(root_id)
        .bind(message.id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The whole automatic follow as one statement, so there is one round trip per reply and one place
/// that states who is eligible.
///
/// `$1` workspace · `$2` channel · `$3` root · `$4` the new reply. The mention arrays are server-owned
/// (`MENTION_PROPS_KEY`), but a malformed element must not turn a send into an error, so a token is
/// cast only after it matched the UUID shape (`CASE` fixes the order; a bare `WHERE` would not).
const AUTO_FOLLOW_SQL: &str = "\
WITH reply AS ( \
  SELECT m.author_member_id, \
         CASE WHEN jsonb_typeof(m.props->'mention_member_ids') = 'array' \
              THEN m.props->'mention_member_ids' ELSE '[]'::jsonb END AS mention_ids \
    FROM message m \
   WHERE m.id = $4 AND m.workspace_id = $1 AND m.channel_id = $2 \
), \
root AS ( \
  SELECT m.author_member_id, \
         CASE WHEN jsonb_typeof(m.props->'mention_member_ids') = 'array' \
              THEN m.props->'mention_member_ids' ELSE '[]'::jsonb END AS mention_ids \
    FROM message m \
   WHERE m.id = $3 AND m.workspace_id = $1 AND m.channel_id = $2 AND m.root_id IS NULL \
), \
named AS ( \
  SELECT author_member_id AS member_id FROM reply \
  UNION SELECT author_member_id FROM root \
  UNION SELECT CASE WHEN t.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
                    THEN t.v::uuid END \
          FROM reply, jsonb_array_elements_text(reply.mention_ids) AS t(v) \
  UNION SELECT CASE WHEN t.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
                    THEN t.v::uuid END \
          FROM root, jsonb_array_elements_text(root.mention_ids) AS t(v) \
) \
INSERT INTO thread_follow (workspace_id, channel_id, root_id, member_id, state) \
SELECT $1, $2, $3, mem.id, 'auto' \
  FROM named n \
  JOIN member mem \
    ON mem.id = n.member_id \
   AND mem.workspace_id = $1 \
   AND mem.kind = 'human' \
   AND mem.status = 'active' \
   AND mem.deleted_at IS NULL \
  JOIN membership ms \
    ON ms.workspace_id = $1 \
   AND ms.channel_id = $2 \
   AND ms.member_id = mem.id \
   AND ms.left_at IS NULL \
  JOIN channel c \
    ON c.id = $2 \
   AND c.workspace_id = $1 \
   AND c.kind::text <> 'dm' \
ON CONFLICT (root_id, member_id) DO NOTHING";

/// 「따라가기」 (`follow = true` → `followed`) and 「그만 따라가기」 (`false` → `unfollowed`) for the
/// caller, on the thread rooted at `root_id` in `channel_id`. Returns the effective state after the
/// write: `true` exactly when the caller now follows.
///
/// Guard order (the same as reading the thread): live channel member → the root → DM. Both writes are
/// idempotent and overwrite any state, `auto` and `unfollowed` included — this is the only way back
/// from `unfollowed`. A write that changes nothing leaves the row (and its `updated_at`) alone.
pub async fn set_thread_follow_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    member_id: Uuid,
    follow: bool,
) -> Result<Result<bool, FollowRefused>, DbError> {
    let channel_kind: Option<String> = sqlx::query_scalar(
        "SELECT c.kind::text \
           FROM membership ms \
           JOIN channel c ON c.id = ms.channel_id AND c.workspace_id = $1 \
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
    let Some(channel_kind) = channel_kind else {
        return Ok(Err(FollowRefused::NotAMember));
    };
    if let Err(invalid) = validate_replies_root_in_tx(&mut *conn, channel_id, root_id).await? {
        return Ok(Err(FollowRefused::Root(invalid)));
    }
    if channel_kind == "dm" {
        return Ok(Err(FollowRefused::NotApplicable));
    }

    let state = if follow {
        STATE_FOLLOWED
    } else {
        STATE_UNFOLLOWED
    };
    sqlx::query(
        "INSERT INTO thread_follow (workspace_id, channel_id, root_id, member_id, state) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (root_id, member_id) DO UPDATE \
            SET state = EXCLUDED.state, updated_at = now() \
          WHERE thread_follow.state IS DISTINCT FROM EXCLUDED.state",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(root_id)
    .bind(member_id)
    .bind(state)
    .execute(&mut *conn)
    .await?;
    Ok(Ok(follow))
}

/// Does `member_id` follow the thread rooted at `root_id`? (`auto` or `followed`; no row and
/// `unfollowed` are both "no".) Read in the same transaction as the page it annotates.
pub async fn is_following_thread_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    root_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state FROM thread_follow \
          WHERE workspace_id = $1 AND root_id = $2 AND member_id = $3",
    )
    .bind(workspace_id)
    .bind(root_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(matches!(
        state.as_deref(),
        Some(STATE_AUTO) | Some(STATE_FOLLOWED)
    ))
}
