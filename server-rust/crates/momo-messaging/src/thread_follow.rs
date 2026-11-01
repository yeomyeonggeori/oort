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
//!
//! ## The read position and `unreadReplyCount` (stage 2, owner 10-31 23:49)
//!
//! A followed thread also remembers **how far its follower has read**: `last_read_reply_seq`
//! (migration 165), the `seq` of the last reply they have seen. The summary under a root then says how
//! many replies are past it (`unread_reply_count`): other people's finished `text` replies with a
//! greater `seq`, not counting the reader's own and not counting deleted ones. Rules, all of them
//! decided in the statements below and nowhere else:
//!
//! * **Only forward.** [`mark_thread_read_in_tx`] sets it to `LEAST(requested, thread head)` and only
//!   when that is greater than what is stored, so a late or stale signal from another device cannot
//!   rewind it and a request past the head cannot mark replies that do not exist yet as read.
//! * **Only a signal moves it** — never a `GET …/replies` (the inbox and the work panels read replies
//!   without anybody looking at them) and never the channel's read cursor (reading the channel does
//!   not show the replies inside its threads). The signal writes no row: with no row there is no
//!   position, and the answer is `following: false`.
//! * **A new row starts where the person already is.** The automatic follow of the **replier** starts
//!   at their own reply (they replied, so they saw the thread up to there); the other automatic
//!   follows (the root's author, the mentioned) start just before the reply that pulled them in, so
//!   that reply is the first unread one; a direct follow (`PUT …/follow`) starts at the thread's
//!   current head ("from now on"). An existing row's position is never changed by following,
//!   unfollowing or a later reply — only by a signal.
//! * **Absent is not zero.** A thread the reader does not follow has no value at all; `Some(0)` means
//!   "follows, nothing new".

use std::collections::HashMap;

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::message::{
    validate_replies_root_in_tx, MessageType, PagedMessage, StoredMessage, ThreadRootInvalid,
};

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
        .bind(message.seq)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The whole automatic follow as one statement, so there is one round trip per reply and one place
/// that states who is eligible.
///
/// `$1` workspace · `$2` channel · `$3` root · `$4` the new reply · `$5` its `seq`, which seeds a new
/// row's read position (the replier: their own reply; everyone else: just before it — see the module
/// docs). The mention arrays are server-owned
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
INSERT INTO thread_follow (workspace_id, channel_id, root_id, member_id, state, last_read_reply_seq) \
SELECT $1, $2, $3, mem.id, 'auto', \
       CASE WHEN mem.id = (SELECT author_member_id FROM reply) \
            THEN $5::bigint ELSE GREATEST($5::bigint - 1, 0) END \
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

/// The three refusals that come before any write, in `getThreadReplies`' guard order: a live member of
/// the channel (a channel that does not exist answers the same), then the root. Returns the channel's
/// kind for the caller that cares about DMs.
async fn guard_thread_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    member_id: Uuid,
) -> Result<Result<String, FollowRefused>, DbError> {
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
    Ok(Ok(channel_kind))
}

/// 「따라가기」 (`follow = true` → `followed`) and 「그만 따라가기」 (`false` → `unfollowed`) for the
/// caller, on the thread rooted at `root_id` in `channel_id`. Returns the effective state after the
/// write: `true` exactly when the caller now follows.
///
/// Guard order (the same as reading the thread): live channel member → the root → DM. Both writes are
/// idempotent and overwrite any state, `auto` and `unfollowed` included — this is the only way back
/// from `unfollowed`. A write that changes nothing leaves the row (and its `updated_at`) alone.
///
/// A **new** row starts its read position at the thread's current head (`thread.last_reply_seq`, `0`
/// for a thread with no replies): following is "from now on", so the replies already there are not
/// "new replies". An existing row keeps its position — only a signal moves it
/// ([`mark_thread_read_in_tx`]).
pub async fn set_thread_follow_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    member_id: Uuid,
    follow: bool,
) -> Result<Result<bool, FollowRefused>, DbError> {
    let channel_kind =
        match guard_thread_in_tx(&mut *conn, workspace_id, channel_id, root_id, member_id).await? {
            Ok(kind) => kind,
            Err(refused) => return Ok(Err(refused)),
        };
    if channel_kind == "dm" {
        return Ok(Err(FollowRefused::NotApplicable));
    }

    let state = if follow {
        STATE_FOLLOWED
    } else {
        STATE_UNFOLLOWED
    };
    sqlx::query(
        "INSERT INTO thread_follow \
           (workspace_id, channel_id, root_id, member_id, state, last_read_reply_seq) \
         VALUES ($1, $2, $3, $4, $5, \
                 COALESCE((SELECT t.last_reply_seq FROM thread t \
                            WHERE t.workspace_id = $1 AND t.root_id = $3), 0)) \
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

// ---------------------------------------------------------------------------
// the read position (stage 2)
// ---------------------------------------------------------------------------

/// One reader's standing in one thread, read together with the unread count so the two cannot
/// disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FollowView {
    /// `auto` or `followed`. A stopped follow keeps its position (a later re-follow does not
    /// resurface what was read) but reports no count.
    pub following: bool,
    /// The `seq` of the last reply the reader has read.
    pub last_read_reply_seq: i64,
    /// Other people's finished, undeleted `text` replies past [`FollowView::last_read_reply_seq`].
    pub unread_reply_count: i64,
}

/// The reader's [`FollowView`] of each of `roots` they have a row for. A root with no entry is a thread
/// they have no row in.
///
/// One statement; the count is a correlated range scan on `message_thread_idx (root_id, seq)` that
/// starts after the reader's position, so its cost is the unread count, not the thread's length. Every
/// predicate names `workspace_id` explicitly (the API role is RLS-bound, but the agent worker's
/// BYPASSRLS role also reaches this module).
pub async fn thread_follow_views_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    roots: &[Uuid],
) -> Result<HashMap<Uuid, FollowView>, DbError> {
    if roots.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT tf.root_id, tf.state, tf.last_read_reply_seq, \
                (SELECT count(*) FROM message r \
                  WHERE r.workspace_id = $1 \
                    AND r.root_id = tf.root_id \
                    AND r.seq > tf.last_read_reply_seq \
                    AND r.author_member_id <> $2 \
                    AND r.type = 'text' \
                    AND r.deleted_at IS NULL)::bigint AS unread \
           FROM thread_follow tf \
          WHERE tf.workspace_id = $1 \
            AND tf.member_id = $2 \
            AND tf.root_id = ANY($3)",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(roots)
    .fetch_all(&mut *conn)
    .await?;
    let mut views = HashMap::with_capacity(rows.len());
    for row in rows {
        let state: String = row.try_get("state")?;
        views.insert(
            row.try_get("root_id")?,
            FollowView {
                following: matches!(state.as_str(), STATE_AUTO | STATE_FOLLOWED),
                last_read_reply_seq: row.try_get("last_read_reply_seq")?,
                unread_reply_count: row.try_get("unread")?,
            },
        );
    }
    Ok(views)
}

/// Fill [`crate::ThreadRollup::unread_reply_count`] on a history page for `viewer`: `Some(n)` under
/// each root they **follow**, nothing under the rest. A page with no thread costs no query.
pub async fn attach_unread_reply_counts(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer: Uuid,
    page: &mut [PagedMessage],
) -> Result<(), DbError> {
    let roots: Vec<Uuid> = page
        .iter()
        .filter(|paged| paged.thread.is_some())
        .map(|paged| paged.message.id)
        .collect();
    if roots.is_empty() {
        return Ok(());
    }
    let views = thread_follow_views_in_tx(&mut *conn, workspace_id, viewer, &roots).await?;
    for paged in page.iter_mut() {
        let Some(rollup) = paged.thread.as_mut() else {
            continue;
        };
        rollup.unread_reply_count = views
            .get(&paged.message.id)
            .filter(|view| view.following)
            .map(|view| view.unread_reply_count);
    }
    Ok(())
}

/// What a read signal leaves behind: the reader's position after the write. For a thread the reader
/// does not follow it is `following: false` with no numbers — the signal wrote nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThreadReadState {
    pub following: bool,
    pub last_read_reply_seq: Option<i64>,
    pub unread_reply_count: Option<i64>,
}

/// 「여기까지 읽었어요」 — move the caller's read position in the thread rooted at `root_id` **forward**
/// to `requested` (a reply `seq`), and answer with where it stands.
///
/// The new position is `LEAST(requested, thread head)` and is written only when it is greater than the
/// stored one (`WHERE … <`), so it never moves backward and never past the last reply that exists. A
/// negative request is read as `0`. It updates a row that is there — whatever its state, so a stopped
/// follow keeps up with what the person reads — and creates none: no row, no position, and the answer
/// is `following: false`.
///
/// Guard order is the thread read's (live channel member → the root), with no DM refusal: a DM has no
/// follow rows, so the signal is simply a no-op there.
pub async fn mark_thread_read_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    member_id: Uuid,
    requested: i64,
) -> Result<Result<ThreadReadState, FollowRefused>, DbError> {
    if let Err(refused) =
        guard_thread_in_tx(&mut *conn, workspace_id, channel_id, root_id, member_id).await?
    {
        return Ok(Err(refused));
    }
    sqlx::query(
        "UPDATE thread_follow tf \
            SET last_read_reply_seq = target.seq \
           FROM (SELECT LEAST($4::bigint, \
                              COALESCE((SELECT t.last_reply_seq FROM thread t \
                                         WHERE t.workspace_id = $1 AND t.root_id = $2), 0)) AS seq) target \
          WHERE tf.workspace_id = $1 \
            AND tf.root_id = $2 \
            AND tf.member_id = $3 \
            AND target.seq > tf.last_read_reply_seq",
    )
    .bind(workspace_id)
    .bind(root_id)
    .bind(member_id)
    .bind(requested.max(0))
    .execute(&mut *conn)
    .await?;

    let views = thread_follow_views_in_tx(&mut *conn, workspace_id, member_id, &[root_id]).await?;
    Ok(Ok(
        match views.get(&root_id).filter(|view| view.following) {
            Some(view) => ThreadReadState {
                following: true,
                last_read_reply_seq: Some(view.last_read_reply_seq),
                unread_reply_count: Some(view.unread_reply_count),
            },
            None => ThreadReadState {
                following: false,
                last_read_reply_seq: None,
                unread_reply_count: None,
            },
        },
    ))
}
