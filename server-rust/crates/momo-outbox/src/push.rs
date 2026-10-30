//! The `push_candidate` consumer feed (ADR-0120 D3, batch P2).
//!
//! Ports the claim + startup sweep from
//! `workers/NotifierWorker/.../NotifierService.swift:117-230`. It lives in
//! `momo-outbox` for the same reason [`relay`](crate::relay) and
//! [`gateway`](crate::gateway) do: these statements touch the `outbox` table,
//! and this crate is its sole owner (invariant #3). The notifier binary owns the
//! loop; it owns none of this SQL.
//!
//! **Feed exclusivity.** The four consumers partition `outbox` by
//! `(kind, method)` and can never drain each other:
//!
//! | consumer | `kind` | `method` |
//! |---|---|---|
//! | [`relay::claim_broadcast_batch`](crate::relay::claim_broadcast_batch) | `broadcast` | any |
//! | [`gateway::claim_gateway_jobs_in_tx`](crate::gateway::claim_gateway_jobs_in_tx) | `agent_job` | `gateway` |
//! | [`agent_job::claim_agent_job_batch`](crate::agent_job::claim_agent_job_batch) | `agent_job` | `publish` |
//! | [`claim_push_candidate_batch`] | `push_candidate` | any |
//!
//! The rows are produced by **three** writers, each in the same transaction as the
//! write that earns the candidate — which is what makes a candidate impossible to
//! lose and impossible to observe before its source commits:
//!
//! 1. the `push_candidate_enqueue_trg` AFTER INSERT trigger on `message`
//!    (`011_push_notifier.sql:47-69`): one per message, unconditional;
//! 2. the write that ENDS a streamed message — `momo_messaging::stream_message_body_in_tx`
//!    on a final write that is not provisional, over a stream that is open (`streaming:
//!    true → false`) or that a retried turn froze for a retry and never reopened
//!    (`provisional: true`, which the ending replaces) — through
//!    [`emit_stream_closed_push_candidate`] (ADR-0204 증보 1 D8-a, #3987): one more,
//!    because a streamed answer is *born* unfinished and the trigger fires only at its
//!    birth. Same payload shape plus `source: "stream_closed"`; the
//!    notifier judges these two sources from the message. A person whose push for the message has already settled is
//!    skipped when the second candidate is judged (`collapse_id` and the dispatch-log
//!    unique index); a push that was only attempted and failed is retried, not duplicated.
//!
//! 3. approval-card settlement (ADR-0204 addendum 6 D6-5), with
//!    `source: "approval_settled"`. Judgment reads this source to select only the
//!    requester, with its own collapse key, rather than asking approvers again.
//!
//! No other code emits this kind without an Accepted ADR.

use serde_json::{json, Value};
use sqlx::{PgExecutor, PgPool};
use uuid::Uuid;

use crate::emit::{emit_outbox, OutboxKind};

/// `payload.schema` of every `push_candidate` row, whichever of the three writers made it.
pub const PUSH_CANDIDATE_SCHEMA: &str = "momo.push_candidate.v1";

/// `payload.source` of the candidate a streamed message's closing write enqueues. The
/// trigger's rows do not carry the key.
pub const PUSH_CANDIDATE_SOURCE_STREAM_CLOSED: &str = "stream_closed";

pub const PUSH_CANDIDATE_SOURCE_APPROVAL_SETTLED: &str = "approval_settled";

/// The third producer authorized by ADR-0204 addendum 6 D6-5. Id-only, like
/// the insert and stream-close producers. The caller won the pending transition.
pub async fn emit_approval_settled_push_candidate<'e, E>(
    executor: E,
    workspace_id: Uuid,
    message_id: Uuid,
    channel_id: Uuid,
    author_member_id: Uuid,
) -> Result<i64, sqlx::Error>
where
    E: PgExecutor<'e>,
{
    emit_outbox(
        executor,
        workspace_id,
        OutboxKind::PushCandidate,
        "notify",
        &json!({
            "schema": PUSH_CANDIDATE_SCHEMA,
            "message_id": message_id,
            "channel_id": channel_id,
            "author_member_id": author_member_id,
            "message_type": "approval_request",
            "source": PUSH_CANDIDATE_SOURCE_APPROVAL_SETTLED,
        }),
        Some(channel_id),
    )
    .await
}

/// The payload of the candidate a stream's closing write enqueues: the trigger's
/// (`011_push_notifier.sql:47-69`) — ids and the message type label, never a body —
/// plus `source`.
pub fn stream_closed_candidate_payload(
    message_id: Uuid,
    channel_id: Uuid,
    author_member_id: Uuid,
    message_type: &str,
) -> Value {
    json!({
        "schema": PUSH_CANDIDATE_SCHEMA,
        "message_id": message_id,
        "channel_id": channel_id,
        "author_member_id": author_member_id,
        "message_type": message_type,
        "source": PUSH_CANDIDATE_SOURCE_STREAM_CLOSED,
    })
}

/// Enqueue the candidate for a streamed message that has just been closed (ADR-0204 증보 1
/// D8-a, #3987). Call it **inside the transaction of the closing write** — the candidate
/// then commits or rolls back with the close, exactly as the trigger's does with the
/// insert. Same row shape as the trigger's (`method = 'notify'`, `partition_key =
/// channel_id`); returns the new `outbox.id`.
///
/// The caller owns the question "did the answer just end?": the candidate is for the end of a
/// streamed answer and for nothing else — a final write that is not provisional, on a stream
/// that was open or frozen for a retry. Not a slice, not a second final write on a block
/// that is already closed, not a message that never streamed, and not a provisional freeze
/// (the close a retried turn leaves between two attempts, which the next attempt reopens or
/// the turn's terminal close ends).
pub async fn emit_stream_closed_push_candidate<'e, E>(
    executor: E,
    workspace_id: Uuid,
    message_id: Uuid,
    channel_id: Uuid,
    author_member_id: Uuid,
    message_type: &str,
) -> Result<i64, sqlx::Error>
where
    E: PgExecutor<'e>,
{
    emit_outbox(
        executor,
        workspace_id,
        OutboxKind::PushCandidate,
        "notify",
        &stream_closed_candidate_payload(message_id, channel_id, author_member_id, message_type),
        Some(channel_id),
    )
    .await
}

/// A claimed `push_candidate` row, flipped to `processing`.
///
/// `workspace_id` rides along because the notifier is a BYPASSRLS consumer with
/// no tenant predicate on the claim: it learns the tenant *from the row*, then
/// re-enters RLS scope per candidate.
#[derive(Debug, Clone)]
pub struct ClaimedPushCandidate {
    pub id: i64,
    pub attempts: i32,
    pub workspace_id: uuid::Uuid,
    pub payload: String,
}

/// Claim up to `batch_size` pending `push_candidate` rows and flip them to
/// `processing` in one statement.
///
/// `FOR UPDATE SKIP LOCKED` makes the claim loss-free and keeps two notifier
/// instances off the same row — the same arbitration the relay and agent worker
/// use. `kind = 'push_candidate'` is the mutual-exclusion boundary.
pub async fn claim_push_candidate_batch(
    pool: &PgPool,
    batch_size: i64,
) -> Result<Vec<ClaimedPushCandidate>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i64, i32, uuid::Uuid, String)>(
        "WITH claimed AS ( \
             SELECT id FROM outbox \
              WHERE kind = 'push_candidate' \
                AND status = 'pending' \
                AND available_at <= now() \
              ORDER BY id \
              FOR UPDATE SKIP LOCKED \
              LIMIT $1 \
         ) \
         UPDATE outbox o \
            SET status = 'processing', attempts = o.attempts + 1 \
           FROM claimed c \
          WHERE o.id = c.id \
          RETURNING o.id, o.attempts, o.workspace_id, o.payload::text",
    )
    .bind(batch_size)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(
        |(id, attempts, workspace_id, payload)| ClaimedPushCandidate {
            id,
            attempts,
            workspace_id,
            payload,
        },
    )
    .collect();
    Ok(rows)
}

/// Return `push_candidate` rows stuck in `processing` to `pending`, once per
/// boot, before the drain loop starts. Returns how many were reclaimed.
///
/// A crash between claim and settle would otherwise strand a candidate forever.
/// This is safe *only* because dispatch is idempotent (the 011 partial unique
/// index on `push_dispatch_log`): a reclaimed candidate re-runs judgment and
/// skips every already-settled target.
///
/// Scoped strictly to `kind='push_candidate'` — the relay and agent worker own
/// their own recovery and must never be swept by this.
pub async fn reclaim_stuck_push_candidates(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE outbox \
            SET status = 'pending', available_at = now() \
          WHERE kind = 'push_candidate' \
            AND status = 'processing'",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The candidate's keys are the trigger's (`011_push_notifier.sql:52-60`) plus
    /// `source`. The notifier decodes only `message_id` and `channel_id`, but the other
    /// ids and the type label are part of the row's shape for anyone reading the feed —
    /// and a body, a name or any text must not be among them (ADR-0120 D2: id-only).
    #[test]
    fn the_close_candidate_has_the_triggers_shape_plus_its_source() {
        let (message, channel, author) =
            (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let payload = stream_closed_candidate_payload(message, channel, author, "text");
        let mut keys: Vec<&str> = payload
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "author_member_id",
                "channel_id",
                "message_id",
                "message_type",
                "schema",
                "source"
            ]
        );
        assert_eq!(payload["schema"], PUSH_CANDIDATE_SCHEMA);
        assert_eq!(payload["source"], PUSH_CANDIDATE_SOURCE_STREAM_CLOSED);
        assert_eq!(payload["message_id"], message.to_string());
        assert_eq!(payload["channel_id"], channel.to_string());
        assert_eq!(payload["author_member_id"], author.to_string());
        assert_eq!(payload["message_type"], "text");
    }
}
