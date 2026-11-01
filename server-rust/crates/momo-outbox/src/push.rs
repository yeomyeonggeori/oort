//! The `push_candidate` consumer feed (ADR-0120 D3, batch P2) and, beside it, the `push_system`
//! feed (ADR-0206 D15, #4341: pushes that name no message — see the bottom of this file).
//!
//! Ports the claim + startup sweep from
//! `workers/NotifierWorker/.../NotifierService.swift:117-230`. It lives in
//! `momo-outbox` for the same reason [`relay`](crate::relay) and
//! [`gateway`](crate::gateway) do: these statements touch the `outbox` table,
//! and this crate is its sole owner (invariant #3). The notifier binary owns the
//! loop; it owns none of this SQL.
//!
//! **Feed exclusivity.** The consumers partition `outbox` by
//! `(kind, method)` and can never drain each other:
//!
//! | consumer | `kind` | `method` |
//! |---|---|---|
//! | [`relay::claim_broadcast_batch`](crate::relay::claim_broadcast_batch) | `broadcast` | any |
//! | [`gateway::claim_gateway_jobs_in_tx`](crate::gateway::claim_gateway_jobs_in_tx) | `agent_job` | `gateway` |
//! | [`agent_job::claim_agent_job_batch`](crate::agent_job::claim_agent_job_batch) | `agent_job` | `publish` |
//! | [`claim_push_candidate_batch`] | `push_candidate` | any |
//! | [`claim_push_system_batch`] | `push_system` | any |
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

// ---------------------------------------------------------------------------
// push_system — a push that names no message (ADR-0206 D15, #4341)
// ---------------------------------------------------------------------------

/// `payload.schema` of every `push_system` row.
pub const PUSH_SYSTEM_SCHEMA: &str = "momo.push_system.v1";

/// The longest collapse id a producer may put on a `push_system` row: the APNs
/// `apns-collapse-id` header and the push relay both stop at 64 bytes.
pub const PUSH_SYSTEM_COLLAPSE_ID_MAX_BYTES: usize = 64;

/// Why a `push_system` row exists. A closed set: a label this build does not know decodes to an
/// error and the consumer parks the row as `failed` instead of guessing what to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushSystemReason {
    /// A member pressed 「시험 알림」 (`POST …/notification-diagnostics/test`). It bypasses the push
    /// judgment on purpose: the question it answers is whether the delivery path works at all.
    TestNotification,
}

impl PushSystemReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PushSystemReason::TestNotification => "test_notification",
        }
    }

    pub fn from_label(raw: &str) -> Option<Self> {
        match raw {
            "test_notification" => Some(PushSystemReason::TestNotification),
            _ => None,
        }
    }
}

/// What a `push_system` row says, decoded. Ids and labels only — there is no field that could
/// hold a body, a name or a channel title, and [`PushSystemPayload::decode`] refuses a payload
/// that carries one more key than [`push_system_payload`] writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSystemPayload {
    pub reason: PushSystemReason,
    /// The one member this push is for. The consumer sends to this member's active tokens and to
    /// nobody else's.
    pub member_id: Uuid,
    /// The channel the push is about, when it has one. The test notification has none.
    pub channel_id: Option<Uuid>,
    /// What the push refers to (the test's id). Appears only in the collapse id.
    pub ref_id: Uuid,
    /// The APNs collapse id **the producer chose**. The consumer uses it verbatim: a collapse id the
    /// consumer made up from its own clock would differ between a retry and the first try, and the
    /// dispatch log's unique key could no longer stop a second send.
    pub collapse_id: String,
}

/// Why a `push_system` payload could not be read. Never retryable: a payload that does not decode
/// now will not decode later, so the consumer settles the row `failed`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PushSystemDecodeError {
    #[error("push_system payload is not the expected JSON object: {0}")]
    Malformed(String),
    #[error("push_system payload schema is not {PUSH_SYSTEM_SCHEMA}")]
    Schema,
    #[error("push_system reason is not one this build knows")]
    UnknownReason,
    #[error("push_system collapse id is empty, too long or not printable ASCII")]
    CollapseId,
}

impl PushSystemPayload {
    /// Decode one claimed row's payload. The key set is checked exactly (ADR-0120 D2: a body or a
    /// name must not be able to ride along on this feed either).
    pub fn decode(raw: &str) -> Result<Self, PushSystemDecodeError> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            schema: String,
            reason: String,
            member_id: Uuid,
            #[serde(default)]
            channel_id: Option<Uuid>,
            ref_id: Uuid,
            collapse_id: String,
        }
        let wire: Wire = serde_json::from_str(raw)
            .map_err(|error| PushSystemDecodeError::Malformed(error.to_string()))?;
        if wire.schema != PUSH_SYSTEM_SCHEMA {
            return Err(PushSystemDecodeError::Schema);
        }
        let reason = PushSystemReason::from_label(&wire.reason)
            .ok_or(PushSystemDecodeError::UnknownReason)?;
        if wire.collapse_id.is_empty()
            || wire.collapse_id.len() > PUSH_SYSTEM_COLLAPSE_ID_MAX_BYTES
            || !wire.collapse_id.chars().all(|c| c.is_ascii_graphic())
        {
            return Err(PushSystemDecodeError::CollapseId);
        }
        Ok(PushSystemPayload {
            reason,
            member_id: wire.member_id,
            channel_id: wire.channel_id,
            ref_id: wire.ref_id,
            collapse_id: wire.collapse_id,
        })
    }
}

/// The payload of one `push_system` row: ids and labels, never a body, a name or a title.
/// `channel_id` is omitted (not `null`) when the push has no channel.
pub fn push_system_payload(
    reason: PushSystemReason,
    member_id: Uuid,
    channel_id: Option<Uuid>,
    ref_id: Uuid,
    collapse_id: &str,
) -> Value {
    let mut payload = json!({
        "schema": PUSH_SYSTEM_SCHEMA,
        "reason": reason.as_str(),
        "member_id": member_id,
        "ref_id": ref_id,
        "collapse_id": collapse_id,
    });
    if let (Some(channel_id), Some(object)) = (channel_id, payload.as_object_mut()) {
        object.insert("channel_id".to_string(), json!(channel_id));
    }
    payload
}

/// Enqueue one `push_system` row (ADR-0206 D15). Call it **inside the transaction of the write
/// that earns the push** — the test route's, which holds the member's `notification_rule` row
/// locked — so the row commits or rolls back with the rate-limit counter beside it. Same row shape
/// as the other push feed (`method = 'notify'`); there is no ordering key, so `partition_key` is
/// NULL. Returns the new `outbox.id`.
pub async fn emit_push_system<'e, E>(
    executor: E,
    workspace_id: Uuid,
    reason: PushSystemReason,
    member_id: Uuid,
    channel_id: Option<Uuid>,
    ref_id: Uuid,
    collapse_id: &str,
) -> Result<i64, sqlx::Error>
where
    E: PgExecutor<'e>,
{
    emit_outbox(
        executor,
        workspace_id,
        OutboxKind::PushSystem,
        "notify",
        &push_system_payload(reason, member_id, channel_id, ref_id, collapse_id),
        None,
    )
    .await
}

/// A claimed `push_system` row, flipped to `processing`. Same shape and same reason for carrying
/// `workspace_id` as [`ClaimedPushCandidate`]: the notifier is a BYPASSRLS consumer, learns the
/// tenant from the row, then re-enters RLS scope for everything after the claim.
#[derive(Debug, Clone)]
pub struct ClaimedPushSystem {
    pub id: i64,
    pub attempts: i32,
    pub workspace_id: uuid::Uuid,
    pub payload: String,
}

/// Claim up to `batch_size` pending `push_system` rows and flip them to `processing` in one
/// statement. `kind = 'push_system'` is the mutual-exclusion boundary: this claim never takes a
/// `push_candidate` (or any other kind), and [`claim_push_candidate_batch`] never takes this one.
pub async fn claim_push_system_batch(
    pool: &PgPool,
    batch_size: i64,
) -> Result<Vec<ClaimedPushSystem>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i64, i32, uuid::Uuid, String)>(
        "WITH claimed AS ( \
             SELECT id FROM outbox \
              WHERE kind = 'push_system' \
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
    .map(|(id, attempts, workspace_id, payload)| ClaimedPushSystem {
        id,
        attempts,
        workspace_id,
        payload,
    })
    .collect();
    Ok(rows)
}

/// Return `push_system` rows stuck in `processing` to `pending`, once per boot, before the drain
/// loop starts. Safe for the same reason as [`reclaim_stuck_push_candidates`]: the dispatch is
/// claimed in `push_dispatch_log` first, so a reclaimed row skips every target already settled.
/// Scoped strictly to `kind='push_system'`.
pub async fn reclaim_stuck_push_system(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE outbox \
            SET status = 'pending', available_at = now() \
          WHERE kind = 'push_system' \
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

    /// ADR-0206 D15: the payload is ids and labels, and the key set is exactly this one. A body, a
    /// display name or a channel title has no key to ride on, and `decode` refuses one more.
    #[test]
    fn the_push_system_payload_is_id_only_and_decodes_back() {
        let (member, channel, reference) =
            (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let collapse = format!("t:{}", reference.hyphenated());
        let without_channel = push_system_payload(
            PushSystemReason::TestNotification,
            member,
            None,
            reference,
            &collapse,
        );
        let mut keys: Vec<&str> = without_channel
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["collapse_id", "member_id", "reason", "ref_id", "schema"],
            "a push with no channel has no channel_id key (omitted, not null)"
        );
        assert_eq!(without_channel["schema"], PUSH_SYSTEM_SCHEMA);
        assert_eq!(without_channel["reason"], "test_notification");

        let decoded = PushSystemPayload::decode(&without_channel.to_string()).expect("decodes");
        assert_eq!(
            decoded,
            PushSystemPayload {
                reason: PushSystemReason::TestNotification,
                member_id: member,
                channel_id: None,
                ref_id: reference,
                collapse_id: collapse.clone(),
            }
        );

        let with_channel = push_system_payload(
            PushSystemReason::TestNotification,
            member,
            Some(channel),
            reference,
            &collapse,
        );
        assert_eq!(with_channel["channel_id"], channel.to_string());
        assert_eq!(
            PushSystemPayload::decode(&with_channel.to_string())
                .expect("decodes")
                .channel_id,
            Some(channel)
        );
    }

    /// The decoder is as closed as the writer: a payload with a name, a body or a title next to
    /// the ids is refused (it is `Malformed`), an unknown reason is its own error so the consumer
    /// parks the row, and a collapse id the relay would refuse never reaches the relay.
    #[test]
    fn the_push_system_decoder_refuses_what_the_writer_never_writes() {
        let ok = |extra: &str, reason: &str, collapse: &str| {
            format!(
                r#"{{"schema":"momo.push_system.v1","reason":"{reason}",
                    "member_id":"0198f0a2-1234-7abc-8def-0123456789ab",
                    "ref_id":"0198f0a2-1234-7abc-8def-0123456789cd",
                    "collapse_id":"{collapse}"{extra}}}"#
            )
        };
        assert!(PushSystemPayload::decode(&ok("", "test_notification", "t:x")).is_ok());
        for extra in [
            r#","display_name":"Kim""#,
            r#","body":"hello""#,
            r#","channel_name":"general""#,
        ] {
            assert!(
                matches!(
                    PushSystemPayload::decode(&ok(extra, "test_notification", "t:x")),
                    Err(PushSystemDecodeError::Malformed(_))
                ),
                "a payload with {extra} must be refused"
            );
        }
        assert_eq!(
            PushSystemPayload::decode(&ok("", "scheduled_failed", "t:x")),
            Err(PushSystemDecodeError::UnknownReason),
            "this slice knows one reason; the next slice's label is not guessed at"
        );
        assert_eq!(
            PushSystemPayload::decode(&ok("", "test_notification", "")),
            Err(PushSystemDecodeError::CollapseId)
        );
        let too_long = "t".repeat(PUSH_SYSTEM_COLLAPSE_ID_MAX_BYTES + 1);
        assert_eq!(
            PushSystemPayload::decode(&ok("", "test_notification", &too_long)),
            Err(PushSystemDecodeError::CollapseId)
        );
        assert_eq!(
            PushSystemPayload::decode(&ok("", "test_notification", "t: x")),
            Err(PushSystemDecodeError::CollapseId),
            "a space is not an APNs-header-safe character"
        );
        let other_schema = ok("", "test_notification", "t:x").replace("push_system", "push_other");
        assert_eq!(
            PushSystemPayload::decode(&other_schema),
            Err(PushSystemDecodeError::Schema)
        );
        assert!(matches!(
            PushSystemPayload::decode("not json"),
            Err(PushSystemDecodeError::Malformed(_))
        ));
    }
}
