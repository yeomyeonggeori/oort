//! Public-ingress lookups and the receipt ledger (#1265).
//!
//! These statements are the only database the inbound routes are allowed to
//! touch besides the shared message send path. There is **no** `INSERT INTO
//! message` here — a grep of this module (and the HTTP handler) must stay at 0.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::crypto;
use crate::WebhookMode;

/// What a verified native or Slack-compatible installation needs to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngressTarget {
    pub installation_id: Uuid,
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    pub label: String,
    /// Native only. `None` on the Slack-compatible path (the URL token is the
    /// credential; there is no HMAC secret to recompute).
    pub secret_ref: Option<String>,
}

/// A previously committed receipt. Duplicate deliveries return this instead of
/// sending a second message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngressReceipt {
    pub id: Uuid,
    pub message_id: Uuid,
    pub seq: i64,
}

/// Active native installation + currently valid key, or `None` when the
/// caller must see the same 404 as an unknown Slack token.
pub async fn load_native_ingress(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: Uuid,
    key_id: Uuid,
) -> Result<Option<IngressTarget>, DbError> {
    let row = sqlx::query(
        "SELECT wi.channel_id, wi.author_member_id, wi.label, wsk.secret_ref \
           FROM webhook_installation wi \
           JOIN webhook_secret_key wsk \
             ON wsk.workspace_id = wi.workspace_id \
            AND wsk.installation_id = wi.id \
          WHERE wi.id = $1 \
            AND wi.workspace_id = $2 \
            AND wi.mode = 'native' \
            AND wi.revoked_at IS NULL \
            AND wsk.id = $3 \
            AND wsk.mode = 'native' \
            AND wsk.revoked_at IS NULL \
            AND wsk.valid_from <= now() \
            AND (wsk.valid_until IS NULL OR wsk.valid_until > now()) \
          FOR SHARE",
    )
    .bind(installation_id)
    .bind(workspace_id)
    .bind(key_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(IngressTarget {
        installation_id,
        channel_id: row.try_get("channel_id")?,
        author_member_id: row.try_get("author_member_id")?,
        label: row.try_get("label")?,
        secret_ref: Some(row.try_get("secret_ref")?),
    }))
}

/// Active Slack-compatible installation whose stored digest matches `token_hash`.
pub async fn load_slack_ingress(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    token_hash: &str,
) -> Result<Option<IngressTarget>, DbError> {
    let row = sqlx::query(
        "SELECT wi.id, wi.channel_id, wi.author_member_id, wi.label \
           FROM webhook_secret_key wsk \
           JOIN webhook_installation wi \
             ON wi.workspace_id = wsk.workspace_id \
            AND wi.id = wsk.installation_id \
          WHERE wsk.workspace_id = $1 \
            AND wsk.mode = 'slack_compatible' \
            AND wsk.token_hash = $2 \
            AND wsk.revoked_at IS NULL \
            AND wsk.valid_from <= now() \
            AND (wsk.valid_until IS NULL OR wsk.valid_until > now()) \
            AND wi.mode = 'slack_compatible' \
            AND wi.revoked_at IS NULL \
          FOR SHARE",
    )
    .bind(workspace_id)
    .bind(token_hash)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(IngressTarget {
        installation_id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        author_member_id: row.try_get("author_member_id")?,
        label: row.try_get("label")?,
        secret_ref: None,
    }))
}

/// Native replay lookup — `(workspace, installation, delivery_id)`.
pub async fn load_native_receipt(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: Uuid,
    delivery_id: &str,
) -> Result<Option<IngressReceipt>, DbError> {
    let row = sqlx::query(
        "SELECT id, message_id, message_seq \
           FROM webhook_receipt \
          WHERE workspace_id = $1 \
            AND installation_id = $2 \
            AND mode = 'native' \
            AND delivery_id = $3",
    )
    .bind(workspace_id)
    .bind(installation_id)
    .bind(delivery_id)
    .fetch_optional(&mut *conn)
    .await?;
    decode_complete_receipt(row)
}

/// Slack replay lookup — `(workspace, installation, body hash, window)`.
pub async fn load_slack_receipt(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: Uuid,
    body_hash: &str,
    window_start: DateTime<Utc>,
) -> Result<Option<IngressReceipt>, DbError> {
    let row = sqlx::query(
        "SELECT id, message_id, message_seq \
           FROM webhook_receipt \
          WHERE workspace_id = $1 \
            AND installation_id = $2 \
            AND mode = 'slack_compatible' \
            AND body_sha256 = $3 \
            AND dedupe_window_start = $4",
    )
    .bind(workspace_id)
    .bind(installation_id)
    .bind(body_hash)
    .bind(window_start)
    .fetch_optional(&mut *conn)
    .await?;
    decode_complete_receipt(row)
}

fn decode_complete_receipt(
    row: Option<sqlx::postgres::PgRow>,
) -> Result<Option<IngressReceipt>, DbError> {
    let Some(row) = row else {
        return Ok(None);
    };
    let message_id: Option<Uuid> = row.try_get("message_id")?;
    let seq: Option<i64> = row.try_get("message_seq")?;
    match (message_id, seq) {
        (Some(message_id), Some(seq)) => Ok(Some(IngressReceipt {
            id: row.try_get("id")?,
            message_id,
            seq,
        })),
        _ => Ok(None),
    }
}

/// Fields for one `webhook_receipt` insert.
pub struct NewReceipt<'a> {
    pub installation_id: Uuid,
    pub mode: WebhookMode,
    pub delivery_id: Option<&'a str>,
    pub body_hash: &'a str,
    pub dedupe_window_start: Option<DateTime<Utc>>,
    pub client_msg_id: Uuid,
}

/// Insert a receipt row. `None` means a concurrent insert won the unique index.
pub async fn insert_receipt(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: NewReceipt<'_>,
) -> Result<Option<Uuid>, DbError> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO webhook_receipt \
           (workspace_id, installation_id, mode, delivery_id, body_sha256, \
            dedupe_window_start, client_msg_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT DO NOTHING \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(new.installation_id)
    .bind(new.mode.as_db_label())
    .bind(new.delivery_id)
    .bind(new.body_hash)
    .bind(new.dedupe_window_start)
    .bind(new.client_msg_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(id)
}

/// Stamp the message the send path just created onto the receipt.
pub async fn attach_receipt_message(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    receipt_id: Uuid,
    message_id: Uuid,
    seq: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE webhook_receipt \
            SET message_id = $3, message_seq = $4 \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(receipt_id)
    .bind(workspace_id)
    .bind(message_id)
    .bind(seq)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Native HMAC secret for a stored reference, derived from the same master
/// the admin create/rotate path uses (`JWT_HMAC`).
pub fn native_hmac_secret(master_key: &str, secret_ref: &str) -> String {
    crypto::native_secret(master_key, secret_ref)
}
