//! Message-level removal: delete derived rows and plant a tombstone so the
//! worker will not recreate them (ADR-0170 D4).

use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use serde_json::json;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::store::{cent_channel, load_message, MessageRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoveOutcome {
    pub changed: bool,
    pub seq: i64,
    pub channel_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RemoveRefused {
    #[error("message not found")]
    NotFound,
    #[error("only the author may remove unfurls")]
    NotAuthor,
}

pub async fn remove_unfurls_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    actor_id: Uuid,
) -> Result<Result<RemoveOutcome, RemoveRefused>, DbError> {
    let Some(message) = load_message(conn, message_id).await? else {
        return Ok(Err(RemoveRefused::NotFound));
    };
    if message.author_member_id != actor_id {
        return Ok(Err(RemoveRefused::NotAuthor));
    }
    let deleted: u64 = sqlx::query("DELETE FROM message_unfurl WHERE message_id = $1")
        .bind(message_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    sqlx::query(
        "INSERT INTO message_unfurl_tombstone (workspace_id, message_id, removed_by) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (message_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(actor_id)
    .execute(&mut *conn)
    .await?;
    let changed = deleted > 0;
    if changed {
        emit_removed(conn, workspace_id, &message).await?;
    }
    Ok(Ok(RemoveOutcome {
        changed,
        seq: message.seq,
        channel_id: message.channel_id,
    }))
}

async fn emit_removed(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message: &MessageRef,
) -> Result<(), DbError> {
    let channel = cent_channel(workspace_id, message.channel_id);
    let payload = json!({
        "channel": channel,
        "data": {
            "type": "message.unfurl.removed",
            "v": 1,
            "ts": chrono::Utc::now().timestamp_millis(),
            "seq": message.seq,
            "payload": {
                "message_id": message.id,
                "channel_id": message.channel_id,
            }
        },
        "idempotency_key": format!(
            "{channel}:message.unfurl.removed:{}",
            message.id
        )
    });
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(message.channel_id),
    )
    .await?;
    Ok(())
}

/// Used by the list/remove routes to confirm the caller can see the message.
pub async fn message_channel(
    conn: &mut PgConnection,
    message_id: Uuid,
) -> Result<Option<(Uuid, Uuid)>, DbError> {
    let row = sqlx::query(
        "SELECT channel_id, author_member_id FROM message \
          WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(message_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| (row.get("channel_id"), row.get("author_member_id"))))
}
