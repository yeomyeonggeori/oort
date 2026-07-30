//! The single outbox-insert chokepoint. No other file in the workspace may
//! contain an outbox `INSERT` — enforced by review + the grep in the B0 PR body.

use serde_json::Value;
use sqlx::PgExecutor;
use uuid::Uuid;

/// The `outbox_kind` enum values (`001_init.sql:412`, plus `webhook_delivery`
/// added by a later migration and consumed by the relay claim). Rendered to the
/// exact DB label by [`OutboxKind::as_db_label`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxKind {
    /// SoT → Centrifugo fan-out for a channel (`partition_key = channel_id`).
    Broadcast,
    /// Agent invocation job (`partition_key = agent_member_id`, per-agent
    /// serialization at claim time).
    AgentJob,
    /// Outbound webhook delivery.
    WebhookDelivery,
}

impl OutboxKind {
    /// The `text` label matching the `outbox_kind` Postgres enum.
    pub fn as_db_label(self) -> &'static str {
        match self {
            OutboxKind::Broadcast => "broadcast",
            OutboxKind::AgentJob => "agent_job",
            OutboxKind::WebhookDelivery => "webhook_delivery",
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
        assert_eq!(
            OutboxKind::WebhookDelivery.as_db_label(),
            "webhook_delivery"
        );
    }
}
