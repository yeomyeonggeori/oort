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
//!
//! ## The channel total and its signal (#5667, ADR-0124 증보 4)
//!
//! The read-state projection (`GET …/read-state`) carries, per channel line,
//! `followed_unread_reply_count`: the **sum of the per-thread count above over the threads the reader
//! follows in that channel** ([`followed_unread_by_channel_in_tx`]). It is the same rule row for row —
//! other people's undeleted `text` replies past the position, following = `auto`/`followed` — and a
//! conformance test keeps it equal to the sum of the per-thread numbers. A channel the reader has left or that is archived has no
//! projection line, so its threads count nowhere.
//!
//! When that total can change, the reader's personal channel (`user:read-state#<MEMBER>`, the read-state
//! broadcast's channel) gets a `followed_unread.updated` frame through the outbox, in the same
//! transaction. The frame carries ids only (workspace, member, channel, root) and means "read the
//! projection again" — like the inbox signals, it is never a number a client must fold in order:
//!
//! * **a new reply** — every follower of that thread except its author, who is still a live member of
//!   the (non-archived) channel ([`signal_followers_of_reply_in_tx`], right after the automatic follow so
//!   the people it just pulled in are included);
//! * **the reader read the thread** — the signal moved the position of a row they follow;
//! * **follow / stop following** — the write changed the row's state.
//!
//! The inbox's `inbox_item.created` is not a substitute: its `thread_reply` recipients are the root's
//! author and the thread's writers (migration 126), so a direct follower or a person only mentioned
//! earlier gets no item for the next reply, and reading a thread does not read its inbox items.

use std::collections::HashMap;

use chrono::Utc;
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
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
///
/// A write that changed the row (a new row, or a state that differs) puts a `followed_unread.updated`
/// frame on the caller's personal channel (#5667): stopping removes the thread's unread replies from
/// the channel total, and following again brings back what is still unread. A no-op write sends
/// nothing.
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
    // RETURNING yields a row only when the statement inserted or really updated one (the `DO UPDATE …
    // WHERE` skips a same-state write). `updated_at` (this transaction's `now()`) tells one change from
    // the next in the frame's idempotency key.
    let changed: Option<i64> = sqlx::query_scalar(
        "INSERT INTO thread_follow \
           (workspace_id, channel_id, root_id, member_id, state, last_read_reply_seq) \
         VALUES ($1, $2, $3, $4, $5, \
                 COALESCE((SELECT t.last_reply_seq FROM thread t \
                            WHERE t.workspace_id = $1 AND t.root_id = $3), 0)) \
         ON CONFLICT (root_id, member_id) DO UPDATE \
            SET state = EXCLUDED.state, updated_at = now() \
          WHERE thread_follow.state IS DISTINCT FROM EXCLUDED.state \
         RETURNING (extract(epoch FROM updated_at) * 1000000)::bigint",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(root_id)
    .bind(member_id)
    .bind(state)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(changed_at_us) = changed {
        emit_followed_unread_in_tx(
            &mut *conn,
            workspace_id,
            member_id,
            channel_id,
            root_id,
            &format!("f:{}:{state}:{changed_at_us}", upper(root_id)),
        )
        .await?;
    }
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
///
/// When the position of a row the caller **follows** moved, the caller's personal channel gets a
/// `followed_unread.updated` frame (#5667) so their other devices re-read the channel total. A request
/// that moved nothing, and a stopped follow (which counts nowhere), send nothing.
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
    let moved = sqlx::query(
        "UPDATE thread_follow tf \
            SET last_read_reply_seq = target.seq \
           FROM (SELECT LEAST($4::bigint, \
                              COALESCE((SELECT t.last_reply_seq FROM thread t \
                                         WHERE t.workspace_id = $1 AND t.root_id = $2), 0)) AS seq) target \
          WHERE tf.workspace_id = $1 \
            AND tf.root_id = $2 \
            AND tf.member_id = $3 \
            AND target.seq > tf.last_read_reply_seq \
         RETURNING tf.state, tf.last_read_reply_seq",
    )
    .bind(workspace_id)
    .bind(root_id)
    .bind(member_id)
    .bind(requested.max(0))
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(row) = moved {
        let state: String = row.try_get("state")?;
        let position: i64 = row.try_get("last_read_reply_seq")?;
        if matches!(state.as_str(), STATE_AUTO | STATE_FOLLOWED) {
            // The position only moves forward, so (root, position) names this change once.
            emit_followed_unread_in_tx(
                &mut *conn,
                workspace_id,
                member_id,
                channel_id,
                root_id,
                &format!("r:{}:{position}", upper(root_id)),
            )
            .await?;
        }
    }

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

// ---------------------------------------------------------------------------
// the channel total and its signal (#5667, ADR-0124 증보 4)
// ---------------------------------------------------------------------------

/// The `type` of the personal-channel frame that says "this channel's followed-thread total may have
/// changed — read `GET …/read-state` again". Ids only, never a number.
pub const FOLLOWED_UNREAD_FRAME_TYPE: &str = "followed_unread.updated";

/// `followed_unread_reply_count` for every channel in which `member_id` follows a thread with something
/// unread: channel → the sum, over the threads they follow there (`auto` / `followed`), of other
/// people's undeleted `text` replies past their position. The per-thread term is
/// [`thread_follow_views_in_tx`]'s `unread`, word for word.
///
/// A channel with no entry is `0`. Channels the member has left are still in the map; the caller (the
/// projection) only has lines for live, unarchived memberships, so they count nowhere.
///
/// One statement: the member's rows through `thread_follow_member_idx (member_id)`, then per row the
/// same correlated range scan on `message_thread_idx (root_id, seq)` the thread summary uses, starting
/// after the position — the cost is the member's follow rows plus their unread replies, not the
/// threads' lengths. `workspace_id` is named explicitly (the projection's role is RLS-bound, but a
/// BYPASSRLS caller must not read another tenant's rows either).
pub async fn followed_unread_by_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<HashMap<Uuid, i64>, DbError> {
    let rows = sqlx::query(
        "SELECT tf.channel_id, \
                COALESCE(sum((SELECT count(*) FROM message r \
                               WHERE r.workspace_id = $1 \
                                 AND r.root_id = tf.root_id \
                                 AND r.seq > tf.last_read_reply_seq \
                                 AND r.author_member_id <> $2 \
                                 AND r.type = 'text' \
                                 AND r.deleted_at IS NULL)), 0)::bigint AS followed_unread \
           FROM thread_follow tf \
          WHERE tf.workspace_id = $1 \
            AND tf.member_id = $2 \
            AND tf.state IN ('auto', 'followed') \
          GROUP BY tf.channel_id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut totals = HashMap::with_capacity(rows.len());
    for row in rows {
        totals.insert(row.try_get("channel_id")?, row.try_get("followed_unread")?);
    }
    Ok(totals)
}

/// The new-reply half of the signal: after a counted `text` reply (the automatic follow's own guard —
/// `thread_counted` is `ThreadPolicy::Maintain` at the call site), every follower of the thread except
/// the reply's author gets a `followed_unread.updated` frame. Called after [`auto_follow_in_tx`], so
/// the root's author and the mentioned people that reply just pulled in are among them, and after the
/// reply's own `message.new` / `thread.updated` rows, so the relay (which drains by outbox id) never
/// delivers these personal frames ahead of the reply itself.
///
/// Only a **live member of the channel**, and only while the channel is not archived: a person who
/// left (or was removed from) a private channel keeps their follow rows but must not learn that it is
/// active, and neither has a projection line to re-read. One frame per follower per reply, with the
/// reply's id in the idempotency key (a retried send never gets here — it returns before the call).
/// Every predicate names `workspace_id`: the agent worker's BYPASSRLS role also reaches this.
pub(crate) async fn signal_followers_of_reply_in_tx(
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
    let followers: Vec<Uuid> = sqlx::query_scalar(
        "SELECT tf.member_id \
           FROM thread_follow tf \
           JOIN membership ms \
             ON ms.workspace_id = $1 \
            AND ms.channel_id = tf.channel_id \
            AND ms.member_id = tf.member_id \
            AND ms.left_at IS NULL \
           JOIN channel c \
             ON c.id = tf.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
          WHERE tf.workspace_id = $1 \
            AND tf.root_id = $2 \
            AND tf.channel_id = $3 \
            AND tf.state IN ('auto', 'followed') \
            AND tf.member_id <> $4 \
          ORDER BY tf.member_id",
    )
    .bind(workspace_id)
    .bind(root_id)
    .bind(message.channel_id)
    .bind(message.author_member_id)
    .fetch_all(&mut *conn)
    .await?;
    let cause = format!("m:{}", upper(message.id));
    for follower in followers {
        emit_followed_unread_in_tx(
            &mut *conn,
            workspace_id,
            follower,
            message.channel_id,
            root_id,
            &cause,
        )
        .await?;
    }
    Ok(())
}

/// Build the `outbox.payload` of a `followed_unread.updated` frame for `member_id`'s personal channel
/// (the read-state broadcast's channel, [`crate::read_state::read_state_channel`]). Ids uppercase like
/// the `read_state` frame. No `version` (not an ordered channel event).
///
/// `cause` makes the idempotency key unique per change — `m:<reply>`, `r:<root>:<position>` or
/// `f:<root>:<state>:<µs>` — so a second change is never deduplicated as a replay of the first.
pub fn build_followed_unread_payload(
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    cause: &str,
    timestamp_ms: i64,
) -> Value {
    let channel = crate::read_state::read_state_channel(member_id);
    let channel_token = upper(channel_id);
    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data: json!({
            "type": FOLLOWED_UNREAD_FRAME_TYPE,
            "v": 1,
            "ts": timestamp_ms,
            "payload": {
                "workspace_id": upper(workspace_id),
                "member_id": upper(member_id),
                "channel_id": channel_token,
                "root_id": upper(root_id),
            },
        }),
        version: None,
        idempotency_key: Some(format!("{channel}:followed-unread:{channel_token}:{cause}")),
    };
    serde_json::to_value(envelope).expect("followed-unread payload serializes")
}

async fn emit_followed_unread_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    cause: &str,
) -> Result<(), DbError> {
    let payload = build_followed_unread_payload(
        workspace_id,
        member_id,
        channel_id,
        root_id,
        cause,
        Utc::now().timestamp_millis(),
    );
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(member_id),
    )
    .await?;
    Ok(())
}

fn upper(id: Uuid) -> String {
    id.to_string().to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frame rides the read-state broadcast's personal channel, carries ids only (no count — a
    /// client re-reads the projection), and its key changes with the cause.
    #[test]
    fn the_followed_unread_frame_is_ids_only_on_the_personal_channel() {
        let (ws, member, channel, root) = (
            Uuid::from_u128(0xa),
            Uuid::from_u128(0xb),
            Uuid::from_u128(0xc),
            Uuid::from_u128(0xd),
        );
        let payload = build_followed_unread_payload(ws, member, channel, root, "r:X:7", 42);
        assert_eq!(
            payload["channel"],
            json!(crate::read_state::read_state_channel(member))
        );
        assert_eq!(payload["data"]["type"], json!("followed_unread.updated"));
        assert_eq!(payload["data"]["ts"], json!(42));
        let body = payload["data"]["payload"]
            .as_object()
            .expect("payload object");
        let mut keys: Vec<&str> = body.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["channel_id", "member_id", "root_id", "workspace_id"],
            "ids only — no number a client would have to order"
        );
        assert_eq!(body["channel_id"], json!(upper(channel)));
        assert!(payload.get("version").is_none() || payload["version"].is_null());
        let other = build_followed_unread_payload(ws, member, channel, root, "r:X:8", 42);
        assert_ne!(
            payload["idempotency_key"], other["idempotency_key"],
            "a second change must not be deduplicated as a replay of the first"
        );
    }
}
