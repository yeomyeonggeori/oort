//! Message write path — the spine of the messenger (D1 §3, D2 #1/#3/#4/#5).
//!
//! [`send_message_in_tx`] is the whole invariant story in one function, and it
//! mirrors Swift `MessageRoutes.swift:123-282` step for step:
//!
//! 1. **gapless seq (invariant #4).** A single statement row-locks the channel's
//!    `channel_seq` row (`UPDATE channel_seq SET last_seq = last_seq + 1 …
//!    RETURNING`) and inserts the message with that seq in the same statement.
//!    The row lock serializes concurrent sends to one channel, so seqs are
//!    contiguous; `message_seq_uniq UNIQUE(channel_id, seq)` (`001_init.sql:184`)
//!    is the DB backstop if anyone ever swaps the lock for a non-serial scheme.
//! 2. **idempotency.** `ON CONFLICT (channel_id, author_member_id, client_msg_id)
//!    DO NOTHING` makes a retried send a no-op; on a 0-row insert we re-select the
//!    prior row and return its original seq (exactly-once *effect*). A retry emits
//!    no second broadcast.
//! 3. **single write path + atomicity (invariant #3).** The broadcast is enqueued
//!    through [`momo_outbox::emit_outbox`] — the workspace's only sanctioned
//!    outbox egress — on the *same* connection/transaction as the message insert.
//!    This crate contains no `INSERT INTO outbox` of its own. Roll the
//!    transaction back and the message and its outbox row vanish together.
//! 4. **PG = SoT (invariant #1).** Everything above writes to Postgres only. This
//!    crate never calls Centrifugo; fan-out is `momo-relay`'s job draining the
//!    outbox (invariant #2, out of scope here).
//! 5. **agent = member (invariant #5).** `author_member_id` is any `member.id`,
//!    human or agent alike — there is no agent branch in this path.
//!
//! [`send_message`] wraps the spine in [`momo_db::with_tenant_tx`], the sole RLS
//! GUC seam (invariant #6). The `*_in_tx` seam is public so a route layer can
//! compose several domain writes in one transaction.

use chrono::{DateTime, Utc};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::error::MessagingError;

/// `message_type` enum (`001_init.sql:15`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageType {
    Text,
    ToolCall,
    ToolResult,
    Diff,
    Artifact,
    ApprovalRequest,
    System,
}

impl MessageType {
    pub fn as_db_label(self) -> &'static str {
        match self {
            MessageType::Text => "text",
            MessageType::ToolCall => "tool_call",
            MessageType::ToolResult => "tool_result",
            MessageType::Diff => "diff",
            MessageType::Artifact => "artifact",
            MessageType::ApprovalRequest => "approval_request",
            MessageType::System => "system",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "text" => Some(MessageType::Text),
            "tool_call" => Some(MessageType::ToolCall),
            "tool_result" => Some(MessageType::ToolResult),
            "diff" => Some(MessageType::Diff),
            "artifact" => Some(MessageType::Artifact),
            "approval_request" => Some(MessageType::ApprovalRequest),
            "system" => Some(MessageType::System),
            _ => None,
        }
    }
}

/// A message to write. `props` defaults to an empty object; `hlc_ts`/`hlc_count`
/// default to a fresh wall-clock stamp with logical counter 0 (single-node HLC,
/// matching `MessageRoutes.swift:50-54`). `client_msg_id` drives idempotency —
/// two sends with the same `(channel, author, client_msg_id)` collapse to one
/// message. A `None` `client_msg_id` disables dedup (Postgres treats NULLs as
/// distinct, matching the Swift behaviour).
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    pub message_type: MessageType,
    pub body: Option<String>,
    pub props: Value,
    pub root_id: Option<Uuid>,
    pub reply_to_id: Option<Uuid>,
    pub client_msg_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub hlc_ts: Option<i64>,
    pub hlc_count: Option<i32>,
}

impl NewMessage {
    /// A plain text message with default props/HLC and no threading.
    pub fn text(channel_id: Uuid, author_member_id: Uuid, body: impl Into<String>) -> Self {
        NewMessage {
            channel_id,
            author_member_id,
            message_type: MessageType::Text,
            body: Some(body.into()),
            props: json!({}),
            root_id: None,
            reply_to_id: None,
            client_msg_id: None,
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        }
    }

    /// Set the idempotency key.
    pub fn with_client_msg_id(mut self, client_msg_id: Uuid) -> Self {
        self.client_msg_id = Some(client_msg_id);
        self
    }
}

/// A persisted message row (`message`, `001_init.sql:155`). Minimal projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub seq: i64,
    pub hlc_ts: i64,
    pub hlc_count: i32,
    pub author_member_id: Uuid,
    pub message_type: MessageType,
    pub state: String,
    pub body: Option<String>,
    pub props: Value,
    pub root_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

/// Outcome of [`send_message`] / [`send_message_in_tx`].
#[derive(Debug, Clone)]
pub struct SentMessage {
    pub message: StoredMessage,
    /// `true` when the send hit the idempotency guard and returned an existing
    /// message rather than inserting a new one (no broadcast emitted).
    pub deduped: bool,
    /// The `outbox.id` of the broadcast enqueued for this send, or `None` on a
    /// deduped retry (which emits nothing).
    pub outbox_id: Option<i64>,
}

/// The `message.*` column list shared by insert-RETURNING and read queries, so a
/// single [`decode_stored`] reads every row shape.
const STORED_COLS: &str = "id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
     author_member_id, type::text AS message_type, state::text AS state, body, props, \
     root_id, created_at";

fn decode_stored(row: &sqlx::postgres::PgRow) -> Result<StoredMessage, sqlx::Error> {
    let type_label: String = row.try_get("message_type")?;
    let message_type = MessageType::from_db_label(&type_label).ok_or_else(|| {
        sqlx::Error::Decode(format!("unknown message_type '{type_label}'").into())
    })?;
    Ok(StoredMessage {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("channel_id")?,
        seq: row.try_get("seq")?,
        hlc_ts: row.try_get("hlc_ts")?,
        hlc_count: row.try_get("hlc_count")?,
        author_member_id: row.try_get("author_member_id")?,
        message_type,
        state: row.try_get("state")?,
        body: row.try_get("body")?,
        props: row.try_get("props")?,
        root_id: row.try_get("root_id")?,
        created_at: row.try_get("created_at")?,
    })
}

/// The Centrifugo channel string for a workspace's channel, byte-for-byte with
/// Swift `MessageRoutes.swift:246` (`ch:ws<WORKSPACE>.<CHANNEL>`, uppercase UUIDs
/// — Foundation `UUID.uuidString` is uppercase). Relay/client subscribe to this;
/// the outbox payload carries it so the relay publishes verbatim.
pub fn cent_channel(workspace_id: Uuid, channel_id: Uuid) -> String {
    format!(
        "ch:ws{}.{}",
        workspace_id.to_string().to_uppercase(),
        channel_id.to_string().to_uppercase()
    )
}

/// Build the `outbox.payload` for a broadcast, matching the envelope Swift emits
/// (`MessageRoutes.broadcastPayload`, :2927-2975):
/// `{channel, data:{type:"message.new", v:1, ts, seq, payload:{…}}, version:seq,
/// idempotency_key:"<channel>:<seq>"}`. Reuses the shared [`BroadcastPayload`]
/// DTO so the server and the relay/workd consumers can never drift.
#[allow(clippy::too_many_arguments)]
pub fn build_broadcast_payload(
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    seq: i64,
    message_type: MessageType,
    body: Option<&str>,
    author_member_id: Uuid,
    hlc_ts: i64,
    hlc_count: i32,
    root_id: Option<Uuid>,
    props: &Value,
) -> Value {
    let channel = cent_channel(workspace_id, channel_id);

    let mut message_payload = Map::new();
    message_payload.insert("id".into(), json!(message_id));
    message_payload.insert("channel_id".into(), json!(channel_id));
    message_payload.insert("seq".into(), json!(seq));
    message_payload.insert("type".into(), json!(message_type.as_db_label()));
    message_payload.insert("body".into(), json!(body));
    message_payload.insert("author_member_id".into(), json!(author_member_id));
    message_payload.insert("hlc_ts".into(), json!(hlc_ts));
    message_payload.insert("hlc_count".into(), json!(hlc_count));
    message_payload.insert("root_id".into(), json!(root_id));
    // Swift only carries props when non-empty.
    if let Some(obj) = props.as_object() {
        if !obj.is_empty() {
            message_payload.insert("props".into(), Value::Object(obj.clone()));
        }
    }

    let data = json!({
        "type": "message.new",
        "v": 1,
        "ts": hlc_ts,
        "seq": seq,
        "payload": Value::Object(message_payload),
    });

    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data,
        version: Some(seq),
        idempotency_key: Some(format!("{channel}:{seq}")),
    };
    // Infallible: BroadcastPayload is a plain struct of JSON-native fields.
    serde_json::to_value(envelope).expect("broadcast payload serializes")
}

/// The write-path spine, running on a caller-supplied connection so it composes
/// inside one tenant transaction with other domain writes. See the module docs
/// for the invariant-by-invariant walkthrough.
pub async fn send_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewMessage,
) -> Result<SentMessage, DbError> {
    let hlc_ts = input
        .hlc_ts
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    let hlc_count = input.hlc_count.unwrap_or(0);

    // Step 1+2: row-lock seq bump + idempotent insert in one statement.
    let insert_sql = format!(
        "WITH bumped AS ( \
           UPDATE channel_seq \
              SET last_seq = last_seq + 1 \
            WHERE channel_id = $1 \
           RETURNING last_seq AS seq \
         ) \
         INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, \
            type, body, props, root_id, reply_to_id, client_msg_id, run_id) \
         SELECT $2, $1, b.seq, $3, $4, $5, $6::message_type, $7, $8, $9, $10, $11, $12 \
           FROM bumped b \
         ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING \
         RETURNING {STORED_COLS}"
    );
    let inserted = sqlx::query(&insert_sql)
        .bind(input.channel_id)
        .bind(workspace_id)
        .bind(hlc_ts)
        .bind(hlc_count)
        .bind(input.author_member_id)
        .bind(input.message_type.as_db_label())
        .bind(&input.body)
        .bind(&input.props)
        .bind(input.root_id)
        .bind(input.reply_to_id)
        .bind(input.client_msg_id)
        .bind(input.run_id)
        .fetch_optional(&mut *conn)
        .await?;

    let (message, deduped) = match inserted {
        Some(row) => (decode_stored(&row)?, false),
        None => {
            // 0 rows → idempotency hit: re-select the prior message and return
            // its original seq (exactly-once effect). Only reachable with a
            // non-NULL client_msg_id (NULL never conflicts).
            let select_sql = format!(
                "SELECT {STORED_COLS} FROM message \
                  WHERE channel_id = $1 AND author_member_id = $2 AND client_msg_id = $3"
            );
            let existing = sqlx::query(&select_sql)
                .bind(input.channel_id)
                .bind(input.author_member_id)
                .bind(input.client_msg_id)
                .fetch_optional(&mut *conn)
                .await?;
            match existing {
                Some(row) => (decode_stored(&row)?, true),
                // No prior row and no insert → the channel_seq row was absent
                // (unknown channel). Surface as a not-found DB error.
                None => return Err(DbError::from(sqlx::Error::RowNotFound)),
            }
        }
    };

    // Step 3: enqueue the broadcast through the single outbox egress, same tx.
    // Skipped on a deduped retry so a resend never double-broadcasts.
    let outbox_id = if deduped {
        None
    } else {
        let payload = build_broadcast_payload(
            workspace_id,
            message.channel_id,
            message.id,
            message.seq,
            message.message_type,
            message.body.as_deref(),
            message.author_member_id,
            message.hlc_ts,
            message.hlc_count,
            message.root_id,
            &message.props,
        );
        let id = emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &payload,
            Some(message.channel_id),
        )
        .await?;
        Some(id)
    };

    Ok(SentMessage {
        message,
        deduped,
        outbox_id,
    })
}

/// Send a message: the spine wrapped in the tenant transaction (sole RLS GUC
/// seam). Commits on success; a mid-flight error rolls back the message *and* its
/// outbox row together (invariant #3).
pub async fn send_message(
    pool: &PgPool,
    workspace_id: Uuid,
    input: NewMessage,
) -> Result<SentMessage, MessagingError> {
    let sent = with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move { send_message_in_tx(conn, workspace_id, input).await })
    })
    .await?;
    Ok(sent)
}

/// List a channel's live messages in ascending `seq` order (the authoritative
/// per-channel order), capped at `limit`.
pub async fn list_messages(
    conn: &mut PgConnection,
    channel_id: Uuid,
    limit: i64,
) -> Result<Vec<StoredMessage>, DbError> {
    let sql = format!(
        "SELECT {STORED_COLS} FROM message \
          WHERE channel_id = $1 AND deleted_at IS NULL \
          ORDER BY seq ASC \
          LIMIT $2"
    );
    let rows = sqlx::query(&sql)
        .bind(channel_id)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(decode_stored)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_type_labels_round_trip() {
        for ty in [
            MessageType::Text,
            MessageType::ToolCall,
            MessageType::ToolResult,
            MessageType::Diff,
            MessageType::Artifact,
            MessageType::ApprovalRequest,
            MessageType::System,
        ] {
            assert_eq!(MessageType::from_db_label(ty.as_db_label()), Some(ty));
        }
        assert_eq!(MessageType::from_db_label("nope"), None);
    }

    #[test]
    fn cent_channel_matches_swift_uppercase_format() {
        let ws = Uuid::from_u128(0x0000_1111_2222_3333_4444_5555_6666_7777);
        let ch = Uuid::from_u128(0x8888_9999_aaaa_bbbb_cccc_dddd_eeee_ffff);
        let got = cent_channel(ws, ch);
        assert_eq!(
            got,
            format!(
                "ch:ws{}.{}",
                ws.to_string().to_uppercase(),
                ch.to_string().to_uppercase()
            )
        );
        assert!(got.starts_with("ch:ws"));
        // Uppercase parity with Foundation UUID.uuidString.
        assert_eq!(got, got.to_uppercase().replace("CH:WS", "ch:ws"));
    }

    #[test]
    fn broadcast_payload_matches_swift_envelope() {
        let ws = Uuid::from_u128(1);
        let ch = Uuid::from_u128(2);
        let msg = Uuid::from_u128(3);
        let author = Uuid::from_u128(4);
        let payload = build_broadcast_payload(
            ws,
            ch,
            msg,
            7,
            MessageType::Text,
            Some("hello"),
            author,
            1234,
            0,
            None,
            &json!({}),
        );

        // Envelope shape (BroadcastPayload).
        assert_eq!(payload["channel"], json!(cent_channel(ws, ch)));
        assert_eq!(payload["version"], json!(7));
        assert_eq!(
            payload["idempotency_key"],
            json!(format!("{}:7", cent_channel(ws, ch)))
        );

        // data envelope (L4 §5.2).
        assert_eq!(payload["data"]["type"], json!("message.new"));
        assert_eq!(payload["data"]["v"], json!(1));
        assert_eq!(payload["data"]["ts"], json!(1234));
        assert_eq!(payload["data"]["seq"], json!(7));

        // inner message payload.
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["id"], json!(msg));
        assert_eq!(inner["channel_id"], json!(ch));
        assert_eq!(inner["seq"], json!(7));
        assert_eq!(inner["type"], json!("text"));
        assert_eq!(inner["body"], json!("hello"));
        assert_eq!(inner["author_member_id"], json!(author));
        assert_eq!(inner["hlc_ts"], json!(1234));
        assert_eq!(inner["hlc_count"], json!(0));
        assert_eq!(inner["root_id"], Value::Null);
        // Empty props are omitted, matching Swift.
        assert!(inner.get("props").is_none());
    }

    #[test]
    fn broadcast_payload_carries_nonempty_props() {
        let payload = build_broadcast_payload(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            1,
            MessageType::System,
            None,
            Uuid::from_u128(4),
            9,
            0,
            None,
            &json!({"mention_member_ids": ["x"]}),
        );
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["body"], Value::Null);
        assert_eq!(inner["props"]["mention_member_ids"], json!(["x"]));
    }
}
