//! Server-owned approval settlement (ADR-0186 v6 R-b; ADR-0204 addendum 6).
//! Call only after winning the pending approval transition, in that same tenant
//! transaction. Message SQL stays here; approval SQL stays in momo-agent.

use momo_db::{DbError, PgConnection};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

/// Patch the existing card, publish its full row, and optionally enqueue the
/// requester's outcome notification. No new message or channel sequence is made.
pub async fn settle_approval_card_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    patch: &Value,
    body: &str,
    notify_requester: bool,
) -> Result<bool, DbError> {
    let row = sqlx::query(
        "UPDATE message \
            SET props = (COALESCE(props, '{}'::jsonb) || $3) - 'last_attempt', body = $4 \
          WHERE workspace_id = $1 AND id = $2 AND type = 'approval_request' \
            AND deleted_at IS NULL \
          RETURNING channel_id, author_member_id, run_id",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(patch)
    .bind(body)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(false) };
    crate::emit_message_edited_in_tx(conn, workspace_id, message_id).await?;
    let has_trigger = if notify_requester {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM agent_run \
              WHERE workspace_id = $1 AND id = $2 AND trigger_message_id IS NOT NULL)",
        )
        .bind(workspace_id)
        .bind(row.get::<Option<Uuid>, _>("run_id"))
        .fetch_one(&mut *conn)
        .await?
    } else {
        false
    };
    if has_trigger {
        momo_outbox::emit_approval_settled_push_candidate(
            &mut *conn,
            workspace_id,
            message_id,
            row.get("channel_id"),
            row.get("author_member_id"),
        )
        .await?;
    }
    Ok(true)
}
