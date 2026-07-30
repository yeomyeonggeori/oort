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
use momo_wire::{
    record_provenance, EntityRef, MessageContent, ProvenanceError, SignedAction, Signer,
    ENTITY_MESSAGE,
};
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::error::{MessagingError, ProvenanceRejected};

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

/// A provenance assertion accompanying a message send (ADR-0146).
///
/// `signer_pubkey_b64` is the key **the server resolved** for `signer_member_id`
/// — never one the request supplied. A client-supplied key verifies its own
/// signature and proves nothing, so the resolution step is where the trust
/// actually lives; see [`crate::identity::resolve_member_signing_key`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageSignature {
    pub signer_member_id: Uuid,
    /// Base64 32-byte Ed25519 public key, from the registry.
    pub signer_pubkey_b64: String,
    /// Base64 64-byte Ed25519 signature over the
    /// `momo.provenance.message.v1` bytes.
    pub signature_b64: String,
}

/// Send a message **with** an actor signature, recording provenance in the same
/// transaction as the write (ADR-0146 §범위 1).
///
/// This is additive, and deliberately a second function rather than a parameter
/// on [`send_message_in_tx`]: the unsigned path is byte-for-byte unchanged, so
/// "unsigned actions keep working" is a property of the code shape rather than
/// of a branch someone has to keep correct.
///
/// ## Two-stage, in order
///
/// 1. The actor signed *content* — channel, author, `client_msg_id`, type, body
///    and props — before this server assigned anything.
/// 2. The write happens (or dedups). Only now does `message.id` exist.
/// 3. `record_provenance` re-derives the stage-1 bytes **from the stored row**,
///    verifies the signature over them, and writes the sidecar keyed by that
///    `message.id`. Deriving from the stored row rather than from the request is
///    what makes the digest describe what was actually persisted: a client that
///    signed over props the server strips fails here, visibly.
///
/// A deduped retry still records: the assertion is about the same message, and
/// `action_signature_signature_uniq` collapses the repeat to one row.
///
/// Rejections travel in the `Ok` half (see [`ProvenanceRejected`]) so this fits
/// the `with_tenant_tx` closure. The caller must roll the transaction back on a
/// rejection — that is what stops a refused signature from leaving the message
/// behind as if it had been sent unsigned.
pub async fn send_signed_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewMessage,
    signature: &MessageSignature,
) -> Result<Result<SentMessage, ProvenanceRejected>, DbError> {
    let Some(client_msg_id) = input.client_msg_id else {
        return Ok(Err(ProvenanceRejected::MissingClientMsgId));
    };
    if signature.signer_member_id != input.author_member_id {
        return Ok(Err(ProvenanceRejected::SignerIsNotAuthor));
    }

    let sent = send_message_in_tx(conn, workspace_id, input).await?;
    let message = &sent.message;

    // Canonical props = the STORED jsonb, serialized compactly with sorted keys
    // (`serde_json::Map` is a `BTreeMap` in this build, and jsonb already
    // normalizes key order), so the digest describes the row rather than the
    // request.
    let props_json = serde_json::to_string(&message.props).map_err(|error| {
        DbError::from(sqlx::Error::Decode(
            format!("stored props are not serializable: {error}").into(),
        ))
    })?;
    let action = SignedAction::Message(MessageContent {
        workspace_id,
        channel_id: message.channel_id,
        author_member_id: message.author_member_id,
        client_msg_id,
        message_type: message.message_type.as_db_label(),
        body: message.body.as_deref(),
        props_json: &props_json,
    });

    match record_provenance(
        conn,
        workspace_id,
        &EntityRef::new(ENTITY_MESSAGE, message.id),
        &Signer::member(&signature.signer_pubkey_b64, signature.signer_member_id),
        &signature.signature_b64,
        &action,
    )
    .await
    {
        Ok(_) => Ok(Ok(sent)),
        Err(ProvenanceError::SignatureRejected { .. }) => {
            Ok(Err(ProvenanceRejected::SignatureRejected))
        }
        Err(ProvenanceError::Db(error)) => Err(DbError::from(error)),
    }
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

/// Look a message up by the idempotency triple, without writing anything
/// (B2.6).
///
/// This is the read half of the `(channel_id, author_member_id, client_msg_id)`
/// unique index that [`send_message_in_tx`] writes against — the same predicate,
/// so a caller can ask *"has this idempotency key already produced a message?"*
/// **before** deciding whether a send is legal, instead of learning it from the
/// send's `deduped` flag afterwards.
///
/// The gateway completion needs exactly that ordering (Swift
/// `AgentGatewayRoutes.existingFinalMessage`, :1305-1326): on an already-terminal
/// run it must *replay* the final message when one exists and *refuse* with a 409
/// when one does not. Calling [`send_message_in_tx`] first would insert one in
/// the second case, silently turning a cancelled run into a completed one.
///
/// `deleted_at` is deliberately **not** filtered: the row still occupies the
/// unique index, so pretending it is absent would let a caller "re-send" into a
/// constraint violation.
pub async fn find_client_message_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    author_member_id: Uuid,
    client_msg_id: Uuid,
) -> Result<Option<StoredMessage>, DbError> {
    let sql = format!(
        "SELECT {STORED_COLS} FROM message \
          WHERE channel_id = $1 AND author_member_id = $2 AND client_msg_id = $3 \
          LIMIT 1"
    );
    let row = sqlx::query(&sql)
        .bind(channel_id)
        .bind(author_member_id)
        .bind(client_msg_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_stored)
        .transpose()
        .map_err(DbError::from)
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

/// Which page of a channel's history to read (Swift `MessageRoutes.history`
/// cursors, `MessageRoutes.swift:363-370`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryCursor {
    /// No cursor — newest messages first (`ORDER BY seq DESC`).
    Newest,
    /// `before=<seq>`: strictly older messages, newest-first.
    Before(i64),
    /// `after=<seq>`: the realtime-recovery backfill — strictly newer messages
    /// in ASCENDING order. Takes precedence over `before` when both are given
    /// (Swift checks `after` first).
    After(i64),
}

impl HistoryCursor {
    /// Resolve the `before`/`after` query pair the way Swift does: `after` wins.
    pub fn from_query(before: Option<i64>, after: Option<i64>) -> Self {
        match (after, before) {
            (Some(after), _) => HistoryCursor::After(after),
            (None, Some(before)) => HistoryCursor::Before(before),
            (None, None) => HistoryCursor::Newest,
        }
    }
}

/// Default history page size (Swift `?? 50`).
pub const HISTORY_LIMIT_DEFAULT: i64 = 50;
/// Maximum history page size (Swift `min(max(…, 1), 200)`).
pub const HISTORY_LIMIT_MAX: i64 = 200;

/// Clamp a client-supplied page size to `1..=200`, defaulting to 50 — byte-for-
/// byte the Swift clamp so a client cannot widen the page by asking.
pub fn clamp_history_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(HISTORY_LIMIT_DEFAULT)
        .clamp(1, HISTORY_LIMIT_MAX)
}

/// Read one page of a channel's history with Swift's ordering and cursor
/// semantics ([`HistoryCursor`]).
///
/// Differs from [`list_messages`] in exactly the ways the REST contract
/// requires: newest-first by default, seq-cursor paging, and **tombstones stay
/// visible** (no `deleted_at IS NULL` filter) so a client that reconnects
/// converges on deletions instead of silently keeping a deleted message.
pub async fn list_channel_page(
    conn: &mut PgConnection,
    channel_id: Uuid,
    cursor: HistoryCursor,
    limit: i64,
) -> Result<Vec<StoredMessage>, DbError> {
    let (predicate, order) = match cursor {
        HistoryCursor::Newest => ("", "DESC"),
        HistoryCursor::Before(_) => ("AND seq < $3 ", "DESC"),
        HistoryCursor::After(_) => ("AND seq > $3 ", "ASC"),
    };
    let sql = format!(
        "SELECT {STORED_COLS} FROM message \
          WHERE channel_id = $1 {predicate}\
          ORDER BY seq {order} \
          LIMIT $2"
    );
    let mut query = sqlx::query(&sql).bind(channel_id).bind(limit);
    match cursor {
        HistoryCursor::Newest => {}
        HistoryCursor::Before(seq) | HistoryCursor::After(seq) => query = query.bind(seq),
    }
    let rows = query.fetch_all(&mut *conn).await?;
    rows.iter()
        .map(decode_stored)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_cursor_prefers_after_over_before() {
        assert_eq!(
            HistoryCursor::from_query(Some(10), Some(3)),
            HistoryCursor::After(3),
            "backfill (after) takes precedence, matching Swift"
        );
        assert_eq!(
            HistoryCursor::from_query(Some(10), None),
            HistoryCursor::Before(10)
        );
        assert_eq!(HistoryCursor::from_query(None, None), HistoryCursor::Newest);
    }

    #[test]
    fn history_limit_clamps_to_swift_bounds() {
        assert_eq!(clamp_history_limit(None), 50);
        assert_eq!(clamp_history_limit(Some(0)), 1);
        assert_eq!(clamp_history_limit(Some(-5)), 1);
        assert_eq!(clamp_history_limit(Some(75)), 75);
        assert_eq!(clamp_history_limit(Some(10_000)), 200);
    }

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
