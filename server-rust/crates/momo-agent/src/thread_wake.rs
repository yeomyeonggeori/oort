//! ADR-0162 증보 5 W1~W2 (#3851, 성재 결재 「깨우기 (추천)」 2026-10-15) — the
//! reads behind "a human's plain reply in a thread an agent opened wakes that
//! agent".
//!
//! Like [`crate::dm`], this module owns **no `INSERT`**: it answers two
//! questions inside the send transaction and the route layer
//! (`routes::agent_mentions`) composes the run, the job and the audit row on the
//! same single write path a mention uses.
//!
//! 1. [`load_thread_wake_target_in_tx`] — *who opened this thread, and may this
//!    author wake them?* The author must be `member.kind = 'human'` in the
//!    roster. The caller has already refused an agent **credential**; this is
//!    the roster half of the same doubled gate the DM rule uses, because two
//!    agents waking each other through a thread would be an unbounded loop that
//!    no A2A cap is watching.
//! 2. [`find_unclaimed_thread_run_in_tx`] — *is there already a turn for this
//!    agent in this thread that nobody has picked up?* W2's 합치기: the new reply
//!    is then read with that turn's recent conversation instead of starting a
//!    second one.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// `agent_job.payload.wake_reason`, projected to the Agent Port as
/// `work.wakeReason`, and the run's `input.addressing` label (W2). The inbox
/// event keeps its existing `agent_job` kind so deployed routines do not break.
pub const THREAD_REPLY_WAKE_REASON: &str = "thread_reply";

/// Who opened the thread `root_id`, as W1 defines it, **if** `author_member_id`
/// may wake them.
///
/// * the thread's root message was written by an agent → that agent;
/// * otherwise the thread's **first reply** was written by an agent → that agent
///   (a human called an agent at channel level and the agent answered in a
///   thread under it).
///
/// Only `type = 'text'` messages count, and never a server-composed notice in
/// an agent's name (`props ? 'notice_thread_key'`, ADR-0193 / #2871): a "this
/// agent cannot answer here" line is not the agent having answered there.
///
/// "First reply" is read strictly **before the trigger** (`id <>`, `seq <`).
/// The trigger is already inserted in this transaction; it is a person's
/// message, so counting it could never name an agent — the bound is there so
/// the question asked is exactly "who answered first before this reply", not
/// because a different answer would wake anyone.
///
/// `None` when the author is not a human in the roster, when the root is not a
/// top-level message of this channel, or when no agent opened the thread.
pub async fn load_thread_wake_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    trigger_message_id: Uuid,
    trigger_message_seq: i64,
    author_member_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let row = sqlx::query(
        "SELECT \
           COALESCE((SELECT m.kind::text = 'human' FROM member m \
                      WHERE m.workspace_id = $1 AND m.id = $6), false) AS author_is_human, \
           (SELECT r.author_member_id FROM message r \
              JOIN member m ON m.workspace_id = r.workspace_id AND m.id = r.author_member_id \
             WHERE r.workspace_id = $1 AND r.channel_id = $2 AND r.id = $3 \
               AND r.root_id IS NULL \
               AND r.type = 'text' AND NOT (r.props ? 'notice_thread_key') \
               AND m.kind = 'agent') AS root_agent, \
           (SELECT CASE WHEN m.kind = 'agent' THEN f.author_member_id END \
              FROM message f \
              JOIN member m ON m.workspace_id = f.workspace_id AND m.id = f.author_member_id \
             WHERE f.workspace_id = $1 AND f.channel_id = $2 AND f.root_id = $3 \
               AND f.id <> $4 AND f.seq < $5 \
               AND f.type = 'text' AND NOT (f.props ? 'notice_thread_key') \
             ORDER BY f.seq ASC LIMIT 1) AS first_reply_agent",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(root_id)
    .bind(trigger_message_id)
    .bind(trigger_message_seq)
    .bind(author_member_id)
    .fetch_one(&mut *conn)
    .await?;
    let author_is_human: bool = row.try_get("author_is_human").map_err(DbError::from)?;
    if !author_is_human {
        return Ok(None);
    }
    let root_agent: Option<Uuid> = row.try_get("root_agent").map_err(DbError::from)?;
    let first_reply_agent: Option<Uuid> =
        row.try_get("first_reply_agent").map_err(DbError::from)?;
    Ok(root_agent.or(first_reply_agent))
}

/// A queued run of `agent_member_id` whose trigger message is in the thread
/// `root_id` (the root itself or any reply in it) **and whose job no consumer
/// has picked up yet** — W2's 「수령 전」.
///
/// "Picked up" is read off the job row, not the run, because the two consumers
/// record it differently: the managed worker moves the row to `processing`, a
/// gateway / Agent Port claim leaves it `pending` and writes a lease. A job that
/// is `pending` with no lease owner has been taken by nobody, so the reply will
/// still be in the conversation the claim reads. Any other state means the turn
/// is underway and the new reply needs a turn of its own.
pub async fn find_unclaimed_thread_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT r.id FROM agent_run r \
           JOIN message tm ON tm.workspace_id = r.workspace_id AND tm.id = r.trigger_message_id \
          WHERE r.workspace_id = $1 AND r.agent_member_id = $2 AND r.channel_id = $3 \
            AND r.status = 'queued' \
            AND COALESCE(tm.root_id, tm.id) = $4 \
            AND EXISTS (SELECT 1 FROM outbox o \
                         WHERE o.workspace_id = r.workspace_id \
                           AND o.kind = 'agent_job' \
                           AND o.partition_key = r.agent_member_id \
                           AND o.status = 'pending' \
                           AND o.lease_owner IS NULL \
                           AND upper(o.payload->>'run_id') = upper(r.id::text)) \
          ORDER BY r.created_at DESC LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(channel_id)
    .bind(root_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found)
}
