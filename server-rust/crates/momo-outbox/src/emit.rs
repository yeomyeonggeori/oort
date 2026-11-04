//! The single outbox-insert chokepoint. No other file in the workspace may
//! contain an outbox `INSERT` — enforced by review + the grep in the B0 PR body.

use serde_json::Value;
use sqlx::PgExecutor;
use uuid::Uuid;

/// The complete `outbox_kind` enum, in the order the migrations create the
/// labels: `broadcast`/`agent_job` (`001_init.sql:412`), `push_candidate`
/// (`011_push_notifier.sql:42`), `webhook_delivery`
/// (`033_event_subscription.sql:11`), `push_system`
/// (`170_notification_diagnostics_test_push.sql`). Rendered to the exact DB label by
/// [`OutboxKind::as_db_label`].
///
/// Each label is one consumer's feed and the claim `WHERE` clauses exclude
/// each other by construction (`011_push_notifier.sql:8-13`): the relay claims
/// `broadcast` **only** ([`crate::relay::claim_broadcast_batch`]), the
/// AgentWorker/gateway `agent_job`, the NotifierWorker `push_candidate` (and, in a second
/// drain, `push_system`), the webhook consumer `webhook_delivery`. Adding a variant here
/// therefore does not widen what the relay drains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxKind {
    /// SoT → Centrifugo fan-out for a channel (`partition_key = channel_id`).
    Broadcast,
    /// Agent invocation job (`partition_key = agent_member_id`, per-agent
    /// serialization at claim time).
    AgentJob,
    /// Push-notification candidate, consumed by the NotifierWorker.
    ///
    /// **Three writers emit this kind, and no others.**
    ///
    /// 1. The `push_candidate_enqueue_trg` AFTER INSERT trigger on `message`
    ///    (`011_push_notifier.sql:47-69`) — one per message, inside the transaction of
    ///    the insert. That is what makes the candidate impossible to lose and
    ///    impossible to observe before its message commits (ADR-0120 D3). An
    ///    [`emit_outbox`] call for this kind next to a message *insert* would be a
    ///    *duplicate* candidate, not a missing one.
    /// 2. [`crate::push::emit_stream_closed_push_candidate`], called by
    ///    `momo_messaging::stream_message_body_in_tx` in the transaction of the write that
    ///    ENDS a streamed message — a final write on an open stream (`streaming: true →
    ///    false`) or on one a retried turn froze and never reopened, and never a
    ///    provisional freeze between its attempts — ADR-0204 증보 1 D8-a (#3987). A
    ///    streamed answer is born unfinished, so the trigger judges it at its birth; the
    ///    end is the moment it becomes the answer, and no INSERT happens then, so the
    ///    trigger is silent. That is the one second writer the ADR allows, and why this is
    ///    not an invitation to enqueue arbitrary candidates.
    /// 3. [`crate::push::emit_approval_settled_push_candidate`], in the approval
    ///    card's settlement transaction (ADR-0204 addendum 6 D6-5, the D8-a
    ///    exception). It replaces the retired outcome lines' requester push.
    ///
    /// The variant exists so the Rust enum is a faithful mirror of the DB enum and so
    /// consumers can name the label.
    PushCandidate,
    /// Outbound webhook delivery.
    WebhookDelivery,
    /// A push that names no message (ADR-0206 D15, #4341): today the test notification a member
    /// sends to their own devices, later a scheduled message that failed for a system reason.
    /// The row is id-only (`momo.push_system.v1`: reason, member id, an optional channel id, a
    /// reference id and the collapse id the producer chose) and is consumed by the notifier's
    /// second push drain.
    ///
    /// **Writers (and no others):** [`crate::push::emit_push_system`], inside the transaction of
    /// the write that earns the push — the test route's rate-limit window and `last_test_id` for
    /// the test notification. `push_candidate` gains no writer from this kind: it is a different
    /// feed with its own claim, so a push that names no message never runs through judgment.
    PushSystem,
}

impl OutboxKind {
    /// The `text` label matching the `outbox_kind` Postgres enum.
    pub fn as_db_label(self) -> &'static str {
        match self {
            OutboxKind::Broadcast => "broadcast",
            OutboxKind::AgentJob => "agent_job",
            OutboxKind::PushCandidate => "push_candidate",
            OutboxKind::WebhookDelivery => "webhook_delivery",
            OutboxKind::PushSystem => "push_system",
        }
    }
}

/// Insert one pending outbox row — the ONLY sanctioned way to enqueue an
/// egress. Call this inside the same tenant transaction as the domain write
/// (via `momo_db::with_tenant_tx`) so the domain row and its outbox row commit
/// or roll back atomically (invariant #3). Returns the new `outbox.id`.
///
/// Column set mirrors the Swift inline inserts (e.g. `AgentRunRoutes.swift:159`):
/// `(workspace_id, kind, status, method, payload, partition_key)` with status
/// fixed to `'pending'` — this chokepoint only ever creates pending work.
pub async fn emit_outbox<'e, E>(
    executor: E,
    workspace_id: Uuid,
    kind: OutboxKind,
    method: &str,
    payload: &Value,
    partition_key: Option<Uuid>,
) -> Result<i64, sqlx::Error>
where
    E: PgExecutor<'e>,
{
    // The one and only outbox insert in the codebase.
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO outbox \
           (workspace_id, kind, status, method, payload, partition_key) \
         VALUES ($1, $2::outbox_kind, 'pending', $3, $4, $5) \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(kind.as_db_label())
    .bind(method)
    .bind(payload)
    .bind(partition_key)
    .fetch_one(executor)
    .await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_labels_match_enum() {
        assert_eq!(OutboxKind::Broadcast.as_db_label(), "broadcast");
        assert_eq!(OutboxKind::AgentJob.as_db_label(), "agent_job");
        assert_eq!(OutboxKind::PushCandidate.as_db_label(), "push_candidate");
        assert_eq!(
            OutboxKind::WebhookDelivery.as_db_label(),
            "webhook_delivery"
        );
        assert_eq!(OutboxKind::PushSystem.as_db_label(), "push_system");
    }

    /// The Rust enum must cover the DB enum completely: the conformance test
    /// `migration_runner_applies_all_59_and_matches_schema` asserts the five
    /// labels exist in Postgres, and this asserts the same five are nameable
    /// here. A label present in exactly one of the two lists is the drift this
    /// pair exists to catch (`push_candidate` was missing until B1.6).
    #[test]
    fn every_db_label_has_a_variant() {
        let labels: Vec<&str> = [
            OutboxKind::Broadcast,
            OutboxKind::AgentJob,
            OutboxKind::PushCandidate,
            OutboxKind::WebhookDelivery,
            OutboxKind::PushSystem,
        ]
        .iter()
        .map(|kind| kind.as_db_label())
        .collect();
        assert_eq!(
            labels,
            vec![
                "broadcast",
                "agent_job",
                "push_candidate",
                "webhook_delivery",
                "push_system"
            ],
            "must equal enum_range(NULL::outbox_kind) after 001/011/033/170"
        );
    }
}
