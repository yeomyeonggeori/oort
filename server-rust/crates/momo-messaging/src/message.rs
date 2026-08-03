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
//!
//! **B1.2** adds one step *between* 2 and 3, and only for the REST send path
//! ([`send_message_with_mentions_in_tx`]): the mention pass
//! ([`crate::read_state::record_mentions_in_tx`]). It sits there because Swift's
//! broadcast payload carries `props.mention_member_ids`
//! (`MessageRoutes.swift:184-201, 253-259`) — building the payload first would
//! publish a message whose mention decision the DB row already contradicts. The
//! spine's own statement is unchanged; the step is a composition, which is why
//! [`send_message_in_tx`] and every non-REST producer behave exactly as in B1.

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
    /// The message this one **points at** (ADR-0148).
    ///
    /// Not a second spelling of [`Self::root_id`]: `root_id` is *belonging*
    /// ("this message is part of that conversation"), `reply_to_id` is *aim*
    /// ("this message quotes that one"). A message may carry both — quoting one
    /// particular reply from inside its own thread is the ordinary case — so
    /// nothing here treats them as exclusive.
    pub reply_to_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    /// When the author last rewrote the body (`NULL` = never edited).
    ///
    /// B11: projected because Swift's history projects `m.edited_at` /
    /// `m.deleted_at` on every row (`MessageRoutes.swift:391-393`) and a client
    /// that cannot see them has no way to draw "(수정됨)" or a tombstone after a
    /// reload — the edit would look like the original text, and the deletion
    /// would look like a hole in `seq`.
    pub edited_at: Option<DateTime<Utc>>,
    /// Soft-delete stamp. The row stays, `body` is NULL'd; see
    /// [`crate::interaction::delete_message_in_tx`].
    pub deleted_at: Option<DateTime<Utc>>,
}

/// The reply rollup a client draws as "3 replies" under a root message
/// (`thread`, `001_init.sql:202`; Swift `ThreadRollupDTO`, `DTOs.swift:186-197`).
///
/// Only ever present for a **root** message with at least one reply: a reply
/// carries no rollup of its own (momo threads are one level, like Slack's), and
/// a root with `reply_count = 0` carries none either, because the badge's
/// absence is what "no thread here" looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThreadRollup {
    pub reply_count: i32,
    pub last_reply_seq: i64,
    pub last_reply_at_ms: i64,
}

/// Swift `MessageRoutes.threadRollup` (:990-1006): all three parts or nothing.
/// A `reply_count` without a `last_reply_seq` is a half-written rollup, and
/// emitting it would put a badge on a thread a client cannot then open.
fn thread_rollup(
    reply_count: Option<i32>,
    last_reply_seq: Option<i64>,
    last_reply_at_ms: Option<i64>,
) -> Option<ThreadRollup> {
    match (reply_count, last_reply_seq, last_reply_at_ms) {
        (Some(reply_count), Some(last_reply_seq), Some(last_reply_at_ms)) if reply_count > 0 => {
            Some(ThreadRollup {
                reply_count,
                last_reply_seq,
                last_reply_at_ms,
            })
        }
        _ => None,
    }
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
    /// The rollup for THIS message's own thread, present only when it is a root
    /// that already has replies (Swift computes it for `rootID == nil` only,
    /// `MessageRoutes.swift:326-333`). A reply never reports the thread it just
    /// joined here — the `thread.updated` broadcast does that.
    pub thread: Option<ThreadRollup>,
}

/// The `message.*` column list shared by insert-RETURNING and read queries, so a
/// single [`decode_stored`] reads every row shape.
const STORED_COLS: &str = "id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
     author_member_id, type::text AS message_type, state::text AS state, body, props, \
     root_id, reply_to_id, created_at, edited_at, deleted_at";

/// [`decode_stored`] for the sibling modules that project the same columns with
/// extras beside them (`interaction::INTERACTION_COLS`). Crate-private: the
/// column list and the decoder are one contract, and a caller outside this crate
/// has no way to honour it.
pub(crate) fn decode_stored_row(row: &sqlx::postgres::PgRow) -> Result<StoredMessage, sqlx::Error> {
    decode_stored(row)
}

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
        reply_to_id: row.try_get("reply_to_id")?,
        created_at: row.try_get("created_at")?,
        edited_at: row.try_get("edited_at")?,
        deleted_at: row.try_get("deleted_at")?,
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
///
/// **`reply_to_id` travels as an id and never as a rendered quote** (ADR-0148
/// 규칙 3). An outbox row is written once and replayed forever; embedding the
/// quoted body here would mint exactly the snapshot the ADR forbids — a copy
/// that keeps saying what the original said after it was edited, and keeps
/// saying anything at all after it was deleted. The resolved quote is a *read*
/// projection ([`PagedMessage::reply_to`]), rebuilt from the live row on every
/// fetch.
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
    reply_to_id: Option<Uuid>,
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
    message_payload.insert("reply_to_id".into(), json!(reply_to_id));
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

/// Whether a send maintains the `thread` rollup (B4.1). Private for the same
/// reason as [`MentionPolicy`]: the caller chooses by picking an entry point.
///
/// **Measured, and the reason the spine keeps `Skip`:** in the Swift server the
/// only `INSERT INTO thread` in the whole codebase is inside
/// `MessageRoutes.send` (`MessageRoutes.swift:215`). The non-REST producers —
/// work-session event cards, gateway completions — write messages that *do*
/// carry a `root_id` and deliberately do **not** bump the rollup, because a
/// session's event log is not a conversation someone replied to. Making the
/// spine maintain the rollup would put a "1,283 replies" badge on every work
/// session card. So this is Swift parity, not a shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThreadPolicy {
    /// The B1 spine's behaviour, unchanged: no rollup write, no `thread.updated`
    /// publication, no rollup on the response.
    Skip,
    /// Swift `MessageRoutes.send`: bump the root's rollup, publish
    /// `thread.updated` beside the reply, and answer a root send with its own
    /// current rollup.
    Maintain,
}

/// Whether a send parses `@mentions` out of its body before broadcasting
/// (B1.2). Private because it is an internal composition detail: callers choose
/// by picking [`send_message_in_tx`] or [`send_message_with_mentions_in_tx`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MentionPolicy {
    /// The B1 spine's behaviour, unchanged: no mention parsing. Used by the
    /// non-REST producers (work-session cards, gateway completions) whose Swift
    /// counterparts also decide mentions separately.
    Skip,
    /// Swift `MessageRoutes.send` (:184-201): on a first insert of a `text`
    /// message, parse mentions, write them to the server-owned props, bump the
    /// recipients' `mention_count` — and only then build the broadcast, so the
    /// realtime payload carries the mention decision the DB row now holds.
    Record,
}

/// Steps 1+2 of the spine: row-locked seq bump and idempotent insert, in one
/// statement. Returns the stored row and whether it was a dedup hit.
///
/// Split out of [`send_message_in_tx`] (B1.2) so a caller can interleave work
/// between the insert and the broadcast — specifically the mention pass, which
/// must run *before* the payload is built because Swift's payload carries
/// `props.mention_member_ids`. The statement itself is byte-for-byte the B1 one.
async fn insert_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewMessage,
) -> Result<(StoredMessage, bool), DbError> {
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

    Ok((message, deduped))
}

/// Step 3 (+ the optional B1.2 mention pass): finish a send by enqueuing the
/// broadcast through the single outbox egress, on the same connection and
/// therefore inside the same transaction as the insert.
///
/// A deduped retry emits nothing and records no mentions: the message it
/// returns already exists, so re-running either would double-count a badge and
/// double-publish a message the client has seen.
async fn finish_send_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    mut message: StoredMessage,
    deduped: bool,
    mentions: MentionPolicy,
    threads: ThreadPolicy,
) -> Result<SentMessage, DbError> {
    if deduped {
        // A retry still reports the root's rollup: the caller asked "what is
        // this message", and the answer includes the thread hanging under it,
        // whether or not this particular call created anything.
        let thread = own_thread_rollup(&mut *conn, &message, threads).await?;
        return Ok(SentMessage {
            message,
            deduped,
            outbox_id: None,
            thread,
        });
    }

    if mentions == MentionPolicy::Record && message.message_type == MessageType::Text {
        let recipients = crate::read_state::record_mentions_in_tx(
            &mut *conn,
            workspace_id,
            message.channel_id,
            message.id,
            message.seq,
            message.author_member_id,
            message.body.as_deref(),
            // ADR-0148 규칙 5 — being quoted is being named. The quoted author
            // joins the same recipient set an `@handle` produces, so the badge,
            // the unread arithmetic and the push reason are all the *existing*
            // mention path rather than a sixth notification kind.
            message.reply_to_id,
        )
        .await?;
        if !recipients.is_empty() {
            // Mirror the DB row the statement above just wrote, so the payload
            // built below describes what was persisted (Swift's
            // `responsePropsJSON`) rather than what was requested.
            let tokens: Vec<Value> = recipients
                .iter()
                .copied()
                .map(|id| json!(crate::read_state::mention_id_token(id)))
                .collect();
            match message.props.as_object_mut() {
                Some(object) => {
                    object.insert(
                        crate::read_state::MENTION_PROPS_KEY.into(),
                        Value::Array(tokens),
                    );
                }
                None => {
                    message.props = json!({
                        crate::read_state::MENTION_PROPS_KEY: Value::Array(tokens),
                    });
                }
            }
        }
    }

    // The rollup is bumped BEFORE the broadcast is enqueued, so the
    // `thread.updated` row that follows describes a `thread` row that already
    // exists in this transaction — and so a rolled-back reply takes its rollup
    // increment with it. Swift's order exactly (`MessageRoutes.swift:209-281`).
    let updated_thread = match (threads, message.root_id) {
        (ThreadPolicy::Maintain, Some(root_id)) => Some(
            bump_thread_rollup_in_tx(
                &mut *conn,
                workspace_id,
                message.channel_id,
                root_id,
                message.seq,
                message.created_at,
                message.author_member_id,
            )
            .await?,
        ),
        _ => None,
    };

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
        message.reply_to_id,
        &message.props,
    );
    let outbox_id = emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(message.channel_id),
    )
    .await?;

    // Additive second publication on the same channel, same partition key, so
    // the relay keeps it behind the reply it describes.
    if let (Some(root_id), Some(rollup)) = (message.root_id, updated_thread) {
        let thread_payload =
            build_thread_updated_payload(workspace_id, message.channel_id, root_id, &rollup);
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &thread_payload,
            Some(message.channel_id),
        )
        .await?;
    }

    let thread = own_thread_rollup(&mut *conn, &message, threads).await?;
    Ok(SentMessage {
        message,
        deduped,
        outbox_id: Some(outbox_id),
        thread,
    })
}

/// The rollup a send answers with: the message's OWN thread, and only when the
/// message is a root (Swift `responseThread`, :326-333).
async fn own_thread_rollup(
    conn: &mut PgConnection,
    message: &StoredMessage,
    threads: ThreadPolicy,
) -> Result<Option<ThreadRollup>, DbError> {
    match (threads, message.root_id) {
        (ThreadPolicy::Maintain, None) => fetch_thread_rollup_in_tx(conn, message.id).await,
        _ => Ok(None),
    }
}

/// The write-path spine, running on a caller-supplied connection so it composes
/// inside one tenant transaction with other domain writes. See the module docs
/// for the invariant-by-invariant walkthrough.
pub async fn send_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewMessage,
) -> Result<SentMessage, DbError> {
    let (message, deduped) = insert_message_in_tx(conn, workspace_id, input).await?;
    finish_send_in_tx(
        conn,
        workspace_id,
        message,
        deduped,
        MentionPolicy::Skip,
        ThreadPolicy::Skip,
    )
    .await
}

/// The REST send path's spine (B1.2): [`send_message_in_tx`] plus the mention
/// pass, with an optional provenance assertion — one function because Swift's
/// `MessageRoutes.send` is one path, and because the three steps have an order
/// that must not be re-arranged by a caller:
///
/// 1. **insert** — assigns `seq` and `message.id`;
/// 2. **provenance** (when signed) — verified over the props **as inserted**, so
///    a client can sign what it sent. Recording after the mention pass would
///    make every mentioning message fail verification, since no client can
///    predict the ids the server is about to add;
/// 3. **mentions, then the thread rollup, then broadcast** — the payload carries
///    `props.mention_member_ids` exactly like Swift's, so a realtime client
///    highlights a mention without a second fetch; and when the send is a reply,
///    the root's rollup is bumped first so the `thread.updated` publication
///    committed beside the reply describes a row that already exists.
///
/// The caller must have validated the `root_id` (see
/// [`validate_thread_root_in_tx`]) before calling this: the rollup bump takes
/// the root's row lock and would happily create one for a root in another
/// channel.
///
/// A rejected signature travels in the `Ok` half (see [`ProvenanceRejected`]);
/// the caller must roll the transaction back so a refused assertion cannot leave
/// the message behind as if it had been sent unsigned.
pub async fn send_message_with_mentions_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewMessage,
    signature: Option<&MessageSignature>,
) -> Result<Result<SentMessage, ProvenanceRejected>, DbError> {
    if let Some(signature) = signature {
        if input.client_msg_id.is_none() {
            return Ok(Err(ProvenanceRejected::MissingClientMsgId));
        }
        if signature.signer_member_id != input.author_member_id {
            return Ok(Err(ProvenanceRejected::SignerIsNotAuthor));
        }
    }

    let (message, deduped) = insert_message_in_tx(conn, workspace_id, input).await?;

    if let Some(signature) = signature {
        // `client_msg_id` was checked above; the stored row is the digest's
        // subject, so re-read it from the message rather than the request.
        let client_msg_id = match client_msg_id_of(&mut *conn, &message).await? {
            Some(id) => id,
            None => return Ok(Err(ProvenanceRejected::MissingClientMsgId)),
        };
        if let Err(rejected) =
            record_message_provenance(&mut *conn, workspace_id, &message, client_msg_id, signature)
                .await?
        {
            return Ok(Err(rejected));
        }
    }

    let sent = finish_send_in_tx(
        conn,
        workspace_id,
        message,
        deduped,
        MentionPolicy::Record,
        ThreadPolicy::Maintain,
    )
    .await?;
    Ok(Ok(sent))
}

/// The stored row's `client_msg_id` — the value the provenance digest binds.
///
/// Read back from the row rather than taken from the request because on a
/// deduped retry the *stored* message is the assertion's subject, and its key is
/// the one already in the unique index.
async fn client_msg_id_of(
    conn: &mut PgConnection,
    message: &StoredMessage,
) -> Result<Option<Uuid>, DbError> {
    let id: Option<Uuid> = sqlx::query_scalar("SELECT client_msg_id FROM message WHERE id = $1")
        .bind(message.id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(id)
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
    match record_message_provenance(conn, workspace_id, &sent.message, client_msg_id, signature)
        .await?
    {
        Ok(()) => Ok(Ok(sent)),
        Err(rejected) => Ok(Err(rejected)),
    }
}

/// Verify one signature over a stored message and write the provenance sidecar.
///
/// Canonical props = the **stored** jsonb, serialized compactly with sorted keys
/// (`serde_json::Map` is a `BTreeMap` in this build, and jsonb already
/// normalizes key order), so the digest describes the row rather than the
/// request. Shared by [`send_signed_message_in_tx`] and
/// [`send_message_with_mentions_in_tx`] so the two signed paths cannot drift
/// into signing different bytes.
async fn record_message_provenance(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message: &StoredMessage,
    client_msg_id: Uuid,
    signature: &MessageSignature,
) -> Result<Result<(), ProvenanceRejected>, DbError> {
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
        Ok(_) => Ok(Ok(())),
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

/// Shallow-merge a patch into a stored message's `props` (Swift
/// `ApprovalDecisionRoutes.patchApprovalRequestMessage` :668-693).
///
/// Lives here because it is `message` SQL and this crate is where that lives —
/// `momo-agent` owns the `approval` row and deliberately owns no message
/// statement, so an approval decision that needs to re-render its card comes
/// through this door rather than growing a second `UPDATE message` elsewhere.
///
/// `||` is a **shallow** merge on purpose: the patch replaces the keys it names
/// and leaves every other key the producer wrote (`tool_name`, `arguments`,
/// `call_id`, …) untouched. A whole-object replace would blank the card.
///
/// Deliberately emits **no** broadcast. The decided card is announced by the
/// `approval.decided` envelope on the channel, which already carries every
/// decision field a client needs; a second realtime event for one fact is how
/// two envelopes come to claim the same channel version.
pub async fn patch_message_props_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    patch: &Value,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE message \
            SET props = COALESCE(props, '{}'::jsonb) || $3 \
          WHERE id = $2 AND workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(patch)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() > 0)
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

/// A history row plus the reply rollup that rides with it (Swift's history
/// `LEFT JOIN thread`, `MessageRoutes.swift:397-398`).
///
/// The rollup travels on the page rather than behind a second request because
/// the alternative is one round trip per visible root message just to decide
/// whether to draw a badge — the "2-hop closure" the web client's `Message`
/// type is written against (`clients/web/src/lib/api.ts:165-171`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PagedMessage {
    pub message: StoredMessage,
    /// Present only for a root message with replies.
    pub thread: Option<ThreadRollup>,
    /// The quoted message, resolved (ADR-0148 규칙 3). Present whenever
    /// [`StoredMessage::reply_to_id`] is set — a tombstoned target still
    /// resolves, as a tombstone.
    pub reply_to: Option<QuotedMessage>,
}

/// The quoted message a client draws above a reply (ADR-0148 규칙 3/4).
///
/// **A reference, resolved at read time — never a snapshot.** Nothing is copied
/// into the quoting message's own row, so an edit of the original changes every
/// quote of it on the next fetch and a deletion turns every quote of it into a
/// tombstone. Persisting the quoted text would create a copy that outlives the
/// author's decision to delete, which is precisely what the ADR refuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotedMessage {
    pub id: Uuid,
    pub seq: i64,
    pub author_member_id: Uuid,
    pub message_type: MessageType,
    /// `NULL` on a tombstone, because [`crate::interaction::delete_message_in_tx`]
    /// NULLs the column. The quote block therefore has nothing to render but
    /// "삭제된 메시지" — the deletion is enforced by the absence of the text, not
    /// by a client agreeing to hide it.
    pub body: Option<String>,
    pub state: String,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    /// 규칙 4 — the quoted message *itself* quotes something. A **marker, not a
    /// second level**: expanding the inner quote would grow one step of a
    /// staircase per hop, so the id is deliberately not projected here. A client
    /// draws "↳ 인용" and stops.
    pub quotes_another: bool,
}

/// The history/replies column list with the rollup join attached. Column names
/// are unqualified in the result set, so [`decode_stored`] reads it unchanged.
const PAGED_COLS: &str = "m.id, m.workspace_id, m.channel_id, m.seq, m.hlc_ts, m.hlc_count, \
     m.author_member_id, m.type::text AS message_type, m.state::text AS state, m.body, m.props, \
     m.root_id, m.reply_to_id, m.created_at, m.edited_at, m.deleted_at, \
     t.reply_count, t.last_reply_seq, \
     CASE WHEN t.last_reply_at IS NULL THEN NULL \
          ELSE floor(extract(epoch from t.last_reply_at) * 1000)::bigint \
     END AS last_reply_at_ms, \
     q.id AS quote_id, q.seq AS quote_seq, q.author_member_id AS quote_author_member_id, \
     q.type::text AS quote_message_type, q.state::text AS quote_state, q.body AS quote_body, \
     q.edited_at AS quote_edited_at, q.deleted_at AS quote_deleted_at, \
     (q.reply_to_id IS NOT NULL) AS quote_quotes_another";

/// The join predicate. `m.root_id IS NULL` is not redundant with
/// `t.root_id = m.id`: a reply's id could in principle key its own `thread` row,
/// and this clause is what keeps momo threads one level deep in the projection
/// as well as in the write path.
const PAGED_THREAD_JOIN: &str =
    "LEFT JOIN thread t ON t.root_id = m.id AND m.root_id IS NULL AND t.reply_count > 0";

/// The quote join (ADR-0148 §3-2).
///
/// **This is the whole N+1 answer.** The alternative — reading `reply_to_id` off
/// each row and then fetching the targets — costs one round trip per quoted
/// message, so a 100-row page of an argument would issue 100 extra queries. A
/// `LEFT JOIN` costs the same one query whether the page contains no quotes or
/// a hundred, and it reads the target through the *same* snapshot as the page,
/// so a quote cannot show a version of the original that never coexisted with
/// the reply.
///
/// `q.channel_id = m.channel_id` restates 규칙 2 in the read path. The write
/// path already refuses a cross-channel target
/// ([`validate_quote_target_in_tx`]), so this predicate is not what keeps the
/// rule — it is what keeps a *pre-existing* or hand-written row from projecting
/// a message the reader may have no right to see.
const PAGED_QUOTE_JOIN: &str =
    "LEFT JOIN message q ON q.id = m.reply_to_id AND q.channel_id = m.channel_id";

fn decode_quoted(row: &sqlx::postgres::PgRow) -> Result<Option<QuotedMessage>, sqlx::Error> {
    // A NULL `quote_id` is the join finding nothing: either the row carries no
    // `reply_to_id` at all, or it points outside this channel (which the write
    // path refuses). Both render as "no quote" rather than as a broken one.
    let Some(id): Option<Uuid> = row.try_get("quote_id")? else {
        return Ok(None);
    };
    let type_label: String = row.try_get("quote_message_type")?;
    let message_type = MessageType::from_db_label(&type_label).ok_or_else(|| {
        sqlx::Error::Decode(format!("unknown quoted message_type '{type_label}'").into())
    })?;
    Ok(Some(QuotedMessage {
        id,
        seq: row.try_get("quote_seq")?,
        author_member_id: row.try_get("quote_author_member_id")?,
        message_type,
        body: row.try_get("quote_body")?,
        state: row.try_get("quote_state")?,
        edited_at: row.try_get("quote_edited_at")?,
        deleted_at: row.try_get("quote_deleted_at")?,
        quotes_another: row.try_get("quote_quotes_another")?,
    }))
}

fn decode_paged(row: &sqlx::postgres::PgRow) -> Result<PagedMessage, sqlx::Error> {
    Ok(PagedMessage {
        message: decode_stored(row)?,
        thread: thread_rollup(
            row.try_get("reply_count")?,
            row.try_get("last_reply_seq")?,
            row.try_get("last_reply_at_ms")?,
        ),
        reply_to: decode_quoted(row)?,
    })
}

/// The history page's statement, as a value.
///
/// Split out of [`list_channel_page`] so the shape of the read is assertable
/// without a database — specifically, that both the rollup and the quote are
/// resolved **inside this one statement**. See
/// `one_page_is_one_statement_however_many_quotes_it_holds`.
fn channel_page_sql(cursor: HistoryCursor) -> String {
    let (predicate, order) = match cursor {
        HistoryCursor::Newest => ("", "DESC"),
        HistoryCursor::Before(_) => ("AND m.seq < $3 ", "DESC"),
        HistoryCursor::After(_) => ("AND m.seq > $3 ", "ASC"),
    };
    format!(
        "SELECT {PAGED_COLS} FROM message m {PAGED_THREAD_JOIN} {PAGED_QUOTE_JOIN} \
          WHERE m.channel_id = $1 {predicate}\
          ORDER BY m.seq {order} \
          LIMIT $2"
    )
}

/// The thread-replies page's statement, as a value — same reason as
/// [`channel_page_sql`].
fn thread_replies_sql() -> String {
    format!(
        "SELECT {PAGED_COLS} FROM message m {PAGED_THREAD_JOIN} {PAGED_QUOTE_JOIN} \
          WHERE m.channel_id = $1 AND m.root_id = $2 AND m.seq > $3 \
          ORDER BY m.seq ASC \
          LIMIT $4"
    )
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
) -> Result<Vec<PagedMessage>, DbError> {
    let sql = channel_page_sql(cursor);
    let mut query = sqlx::query(&sql).bind(channel_id).bind(limit);
    match cursor {
        HistoryCursor::Newest => {}
        HistoryCursor::Before(seq) | HistoryCursor::After(seq) => query = query.bind(seq),
    }
    let rows = query.fetch_all(&mut *conn).await?;
    rows.iter()
        .map(decode_paged)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// threads (B4.1 — Swift `MessageRoutes.replies` + the send's rootId branch)
// ---------------------------------------------------------------------------

/// Why a `rootId` was refused (Swift `MessageRoutes.swift:109-121` and
/// `validateRepliesRoot`, :976-984).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ThreadRootInvalid {
    /// No such message **in this channel**. Deliberately indistinguishable from
    /// a root that exists in another channel: making those two answers differ
    /// would turn the send endpoint into a cross-channel existence oracle for
    /// anyone who can post anywhere in the workspace.
    #[error("thread root not found")]
    NotFound,
    /// The root is a tombstone. Replying under a deleted message would resurrect
    /// a conversation the author ended.
    #[error("thread root is deleted")]
    Deleted,
    /// The root is itself a reply. momo threads are one level (Slack's model):
    /// allowing a second level would make "the thread" ambiguous for every
    /// reader and every rollup.
    #[error("thread root must be a top-level message")]
    NotTopLevel,
}

/// What a `rootId` actually resolves to in a channel. One read, two different
/// questions asked of it — see [`validate_thread_root_in_tx`] (writing) and
/// [`validate_replies_root_in_tx`] (reading).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadRootState {
    /// No such message in this channel.
    Missing,
    /// It exists but is a tombstone.
    Deleted,
    /// It exists but is itself a reply.
    Reply,
    /// A live top-level message.
    Live,
}

/// Why a `replyToId` was refused (ADR-0148 규칙 2).
///
/// Deliberately **not** [`ThreadRootInvalid`] with one arm unused: the two
/// devices refuse different things, and sharing a type would invite a later
/// reader to conclude that whatever `root_id` rejects `reply_to_id` rejects too.
/// The difference that matters is the arm that is *absent* here — a quote target
/// is allowed to be a reply.
///
/// **Each arm carries its own sentence, and the sentence is English** — the
/// packet asked for Korean, the exemplar it named
/// (`routes::messages::thread_root_rejection` → "thread root not found") is
/// English, and so is every one of the 317 `ApiError` sentences this server
/// serves. A single Korean rejection beside them would be a new shape, not a
/// neighbour; the deviation is recorded in the PR body for the orchestrator to
/// settle in one pass over the whole vocabulary rather than one endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum QuoteTargetInvalid {
    /// No such message **in this channel** — 규칙 2. A target in another channel
    /// is answered identically to one that does not exist, for the same reason
    /// [`ThreadRootInvalid::NotFound`] is: distinguishing them would turn the
    /// send endpoint into a cross-channel existence oracle. Cross-*tenant* never
    /// reaches this decision at all: the row is invisible under RLS, so it
    /// resolves as missing.
    #[error("quoted message not found in this channel")]
    NotFound,
    /// The target is a tombstone. Quoting a message whose author already
    /// retracted it would re-point at what they withdrew — and since the body is
    /// gone, the quote could only ever render as "삭제된 메시지", which is not a
    /// quote anyone chose to make.
    ///
    /// The read path is deliberately looser (see [`QuotedMessage`]): a quote
    /// made while the target was alive keeps resolving after the target dies.
    /// Ending a message stops new quotes of it; it does not rewrite the ones
    /// already made.
    #[error("a deleted message cannot be quoted")]
    Deleted,
}

/// The **write** side's reading of a quote target (ADR-0148 규칙 2).
///
/// Reuses [`thread_root_state_in_tx`] — one read, a third question asked of it —
/// and answers that question differently in exactly one place:
/// [`ThreadRootState::Reply`] is **accepted**. 규칙 1 says a message may carry
/// `root_id` and `reply_to_id` at once, and the ADR's own example is quoting one
/// particular reply from inside its thread; refusing a reply here would forbid
/// the case the feature was asked for.
pub async fn validate_quote_target_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    reply_to_id: Uuid,
) -> Result<Result<(), QuoteTargetInvalid>, DbError> {
    Ok(
        match thread_root_state_in_tx(conn, channel_id, reply_to_id).await? {
            ThreadRootState::Live | ThreadRootState::Reply => Ok(()),
            ThreadRootState::Missing => Err(QuoteTargetInvalid::NotFound),
            ThreadRootState::Deleted => Err(QuoteTargetInvalid::Deleted),
        },
    )
}

/// Resolve a `rootId` inside the caller's transaction. The channel predicate is
/// the non-disclosure boundary; see [`ThreadRootInvalid::NotFound`].
///
/// `Deleted` outranks `Reply` because that is Swift's check order
/// (`MessageRoutes.swift:115-120`) and the two can co-occur.
pub async fn thread_root_state_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    root_id: Uuid,
) -> Result<ThreadRootState, DbError> {
    let row = sqlx::query(
        "SELECT state::text AS state, deleted_at, root_id \
           FROM message \
          WHERE id = $1 AND channel_id = $2 \
          LIMIT 1",
    )
    .bind(root_id)
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(ThreadRootState::Missing);
    };
    let state: String = row.try_get("state")?;
    let deleted_at: Option<DateTime<Utc>> = row.try_get("deleted_at")?;
    let parent_root: Option<Uuid> = row.try_get("root_id")?;
    Ok(if state == "deleted" || deleted_at.is_some() {
        ThreadRootState::Deleted
    } else if parent_root.is_some() {
        ThreadRootState::Reply
    } else {
        ThreadRootState::Live
    })
}

/// The **write** side's reading of a root: a reply may only be attached to a
/// live top-level message (Swift `MessageRoutes.send`, :95-121).
pub async fn validate_thread_root_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    root_id: Uuid,
) -> Result<Result<(), ThreadRootInvalid>, DbError> {
    Ok(
        match thread_root_state_in_tx(conn, channel_id, root_id).await? {
            ThreadRootState::Live => Ok(()),
            ThreadRootState::Missing => Err(ThreadRootInvalid::NotFound),
            ThreadRootState::Deleted => Err(ThreadRootInvalid::Deleted),
            ThreadRootState::Reply => Err(ThreadRootInvalid::NotTopLevel),
        },
    )
}

/// The **read** side's reading of the same root, and it is deliberately looser:
/// a tombstoned root still has legible replies (Swift `validateRepliesRoot`,
/// :976-984, checks existence and top-level-ness and nothing else). Deleting a
/// root ends the conversation; it does not erase what was said under it.
pub async fn validate_replies_root_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    root_id: Uuid,
) -> Result<Result<(), ThreadRootInvalid>, DbError> {
    Ok(
        match thread_root_state_in_tx(conn, channel_id, root_id).await? {
            ThreadRootState::Live | ThreadRootState::Deleted => Ok(()),
            ThreadRootState::Missing => Err(ThreadRootInvalid::NotFound),
            ThreadRootState::Reply => Err(ThreadRootInvalid::NotTopLevel),
        },
    )
}

/// Increment a root's rollup and return the post-increment state (Swift's
/// `INSERT INTO thread … ON CONFLICT (root_id) DO UPDATE`, :213-239).
///
/// `ON CONFLICT DO UPDATE` takes the root row's lock, which is what makes
/// concurrent replies serialize: two simultaneous replies cannot both read
/// `reply_count = 4` and both write 5. `participant_ids` is appended only when
/// the author is new to the thread, so it stays a set without a second read.
async fn bump_thread_rollup_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    reply_seq: i64,
    reply_at: DateTime<Utc>,
    author_member_id: Uuid,
) -> Result<ThreadRollup, DbError> {
    let row = sqlx::query(
        "INSERT INTO thread \
           (root_id, workspace_id, channel_id, reply_count, last_reply_seq, \
            last_reply_at, participant_ids) \
         VALUES ($1, $2, $3, 1, $4, $5, ARRAY[$6]::uuid[]) \
         ON CONFLICT (root_id) DO UPDATE \
           SET reply_count = thread.reply_count + 1, \
               last_reply_seq = EXCLUDED.last_reply_seq, \
               last_reply_at = EXCLUDED.last_reply_at, \
               participant_ids = CASE \
                 WHEN EXCLUDED.participant_ids[1] = ANY(thread.participant_ids) \
                   THEN thread.participant_ids \
                 ELSE array_append(thread.participant_ids, EXCLUDED.participant_ids[1]) \
               END \
         RETURNING reply_count, last_reply_seq, \
                   floor(extract(epoch from last_reply_at) * 1000)::bigint AS last_reply_at_ms",
    )
    .bind(root_id)
    .bind(workspace_id)
    .bind(channel_id)
    .bind(reply_seq)
    .bind(reply_at)
    .bind(author_member_id)
    .fetch_one(&mut *conn)
    .await?;

    thread_rollup(
        row.try_get("reply_count")?,
        row.try_get("last_reply_seq")?,
        row.try_get("last_reply_at_ms")?,
    )
    .ok_or_else(|| {
        DbError::from(sqlx::Error::Decode(
            "thread rollup update returned an incomplete row".into(),
        ))
    })
}

/// The current rollup for one root, or `None` when it has no replies.
pub async fn fetch_thread_rollup_in_tx(
    conn: &mut PgConnection,
    root_id: Uuid,
) -> Result<Option<ThreadRollup>, DbError> {
    let row = sqlx::query(
        "SELECT reply_count, last_reply_seq, \
                floor(extract(epoch from last_reply_at) * 1000)::bigint AS last_reply_at_ms \
           FROM thread \
          WHERE root_id = $1 AND reply_count > 0 \
          LIMIT 1",
    )
    .bind(root_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(thread_rollup(
        row.try_get("reply_count")?,
        row.try_get("last_reply_seq")?,
        row.try_get("last_reply_at_ms")?,
    ))
}

/// The additive `thread.updated` publication committed beside a reply (Swift
/// `threadUpdatedPayload`, :2889-2924).
///
/// **No `version` key, deliberately.** The rollup reuses the reply's own seq,
/// and Centrifugo silently drops a publish whose version is not strictly greater
/// than the channel's stored version — which the reply's `message.new` has
/// already claimed. Idempotency therefore rides on the key alone.
pub fn build_thread_updated_payload(
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    rollup: &ThreadRollup,
) -> Value {
    let channel = cent_channel(workspace_id, channel_id);
    let data = json!({
        "type": "thread.updated",
        "v": 1,
        "ts": rollup.last_reply_at_ms,
        "seq": rollup.last_reply_seq,
        "payload": {
            "channel_id": channel_id.to_string().to_uppercase(),
            "root_id": root_id.to_string().to_uppercase(),
            "reply_count": rollup.reply_count,
            "last_reply_seq": rollup.last_reply_seq,
            "last_reply_at": rollup.last_reply_at_ms,
        },
    });
    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data,
        version: None,
        idempotency_key: Some(format!(
            "{channel}:thread.updated:{}:{}",
            root_id.to_string().to_uppercase(),
            rollup.last_reply_seq
        )),
    };
    serde_json::to_value(envelope).expect("thread.updated payload serializes")
}

/// Default replies page size (Swift `?? 50`).
pub const REPLIES_LIMIT_DEFAULT: i64 = 50;
/// Maximum replies page size (Swift `min(max(…, 1), 200)`).
pub const REPLIES_LIMIT_MAX: i64 = 200;

/// Clamp a replies page size to `1..=200`, defaulting to 50.
pub fn clamp_replies_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(REPLIES_LIMIT_DEFAULT)
        .clamp(1, REPLIES_LIMIT_MAX)
}

/// A malformed `?cursor=` (Swift `repliesCursor`, :967-975).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("cursor must be a non-negative message seq")]
pub struct RepliesCursorInvalid;

/// Parse `?cursor=`. **Strict, unlike `limit`** — and the asymmetry is Swift's,
/// for a reason: a bad page size has a safe default, a bad cursor does not.
/// Silently restarting from 0 would replay a whole thread as if it were new.
pub fn parse_replies_cursor(raw: Option<&str>) -> Result<Option<i64>, RepliesCursorInvalid> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match trimmed.parse::<i64>() {
        Ok(cursor) if cursor >= 0 => Ok(Some(cursor)),
        _ => Err(RepliesCursorInvalid),
    }
}

/// One oldest-first page of a thread's replies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadReplyPage {
    pub messages: Vec<PagedMessage>,
    /// The seq to pass as the next `?cursor=`, or `None` at the end of the
    /// thread. Present only when a further page exists — it is computed by
    /// over-reading one row, never by guessing from `messages.len() == limit`.
    pub next_cursor: Option<i64>,
}

/// Read one ascending page of `root_id`'s replies (Swift `MessageRoutes.replies`
/// SQL, :564-617). The caller must have validated the root
/// ([`validate_thread_root_in_tx`]) and the caller's channel membership.
///
/// Ascending, unlike history: a thread is read from its beginning, because its
/// first reply is the one that gives the rest their context.
pub async fn list_thread_replies(
    conn: &mut PgConnection,
    channel_id: Uuid,
    root_id: Uuid,
    cursor: Option<i64>,
    limit: i64,
) -> Result<ThreadReplyPage, DbError> {
    // Over-read by one: "is there more" must be a fact, not an inference from a
    // full page (a thread with exactly `limit` replies would otherwise advertise
    // a next page that is empty).
    let sql = thread_replies_sql();
    let rows = sqlx::query(&sql)
        .bind(channel_id)
        .bind(root_id)
        .bind(cursor.unwrap_or(0))
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await?;

    let has_more = rows.len() as i64 > limit;
    let messages: Vec<PagedMessage> = rows
        .iter()
        .take(limit as usize)
        .map(decode_paged)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)?;
    let next_cursor = if has_more {
        messages.last().map(|paged| paged.message.seq)
    } else {
        None
    };
    Ok(ThreadReplyPage {
        messages,
        next_cursor,
    })
}

// ---------------------------------------------------------------------------
// the agent context window (MOMO-302, consumed by B5.2's mention routing)
// ---------------------------------------------------------------------------

/// How long a projected body may be before it is elided (Swift
/// `recentMessageBody` :1928-1932). Characters, not bytes — a Korean history
/// window must not be cut mid-codepoint.
const CONTEXT_BODY_MAX_CHARS: usize = 2_000;

/// The same-channel history window an agent turn is assembled from — Swift
/// `MessageRoutes.loadRecentMessages` (:1753-1858) and
/// `recentMessageProjection` (:1865-1893).
///
/// It lives in this crate because it is a **`message` read**, and this crate owns
/// every `message` statement (`momo-agent` deliberately owns none). It returns
/// the wire projection rather than a domain struct for the same reason
/// [`build_broadcast_payload`] does: the shape is a contract with a consumer
/// outside this process (`momo_agent_worker::payload::RecentMessage`), so it is
/// built once, here, instead of being re-assembled by every caller.
///
/// ## Two rules the ordering encodes
///
/// * **A thread is the session boundary.** When the trigger sits inside a
///   thread, the root and its replies are taken first and only the leftover
///   budget is filled from the channel — otherwise a busy channel would push the
///   conversation the agent was actually asked about out of its own window.
/// * **The window is replayed oldest-first.** Rows are selected `DESC` (so the
///   `LIMIT` keeps the *newest* N) and then sorted `ASC`, because a chat
///   completion reads a transcript forwards.
///
/// `type='system'` and deleted messages are excluded: a system line is momo
/// talking to the user, not a turn in the conversation.
pub async fn agent_context_window_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    trigger_message_id: Uuid,
    max_messages: i64,
) -> Result<Vec<Value>, DbError> {
    if max_messages <= 0 {
        return Ok(Vec::new());
    }
    let root_id: Option<Uuid> =
        sqlx::query_scalar("SELECT root_id FROM message WHERE id = $1 AND channel_id = $2 LIMIT 1")
            .bind(trigger_message_id)
            .bind(channel_id)
            .fetch_optional(&mut *conn)
            .await?
            .flatten();

    const CONTEXT_COLS: &str = "m.seq, m.id, m.author_member_id, mem.kind::text AS author_kind, \
         mem.display_name, m.type::text AS message_type, m.body, m.props";
    const CONTEXT_FILTER: &str = "m.type <> 'system' AND m.state <> 'deleted' \
         AND m.deleted_at IS NULL";

    let mut rows = Vec::new();
    match root_id {
        Some(root_id) => {
            let thread_sql = format!(
                "SELECT {CONTEXT_COLS} FROM message m \
                   JOIN member mem ON mem.id = m.author_member_id \
                  WHERE m.channel_id = $1 AND (m.root_id = $2 OR m.id = $2) \
                    AND {CONTEXT_FILTER} \
                  ORDER BY m.seq DESC LIMIT $3"
            );
            let thread_rows = sqlx::query(&thread_sql)
                .bind(channel_id)
                .bind(root_id)
                .bind(max_messages)
                .fetch_all(&mut *conn)
                .await?;
            let remaining = max_messages - thread_rows.len() as i64;
            rows.extend(thread_rows);
            if remaining > 0 {
                let fill_sql = format!(
                    "SELECT {CONTEXT_COLS} FROM message m \
                       JOIN member mem ON mem.id = m.author_member_id \
                      WHERE m.channel_id = $1 AND m.id <> $2 \
                        AND m.root_id IS DISTINCT FROM $2 \
                        AND {CONTEXT_FILTER} \
                      ORDER BY m.seq DESC LIMIT $3"
                );
                rows.extend(
                    sqlx::query(&fill_sql)
                        .bind(channel_id)
                        .bind(root_id)
                        .bind(remaining)
                        .fetch_all(&mut *conn)
                        .await?,
                );
            }
        }
        None => {
            let sql = format!(
                "SELECT {CONTEXT_COLS} FROM message m \
                   JOIN member mem ON mem.id = m.author_member_id \
                  WHERE m.channel_id = $1 AND {CONTEXT_FILTER} \
                  ORDER BY m.seq DESC LIMIT $2"
            );
            rows.extend(
                sqlx::query(&sql)
                    .bind(channel_id)
                    .bind(max_messages)
                    .fetch_all(&mut *conn)
                    .await?,
            );
        }
    }

    // Dedupe by id (a thread row wins over its channel-fill twin), then replay
    // oldest-first.
    let mut seen: Vec<Uuid> = Vec::with_capacity(rows.len());
    let mut ordered: Vec<(i64, Value)> = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(DbError::from)?;
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        let seq: i64 = row.try_get("seq").map_err(DbError::from)?;
        let message_type: String = row.try_get("message_type").map_err(DbError::from)?;
        let body: Option<String> = row.try_get("body").map_err(DbError::from)?;
        let props: Value = row.try_get("props").map_err(DbError::from)?;
        let author_member_id: Uuid = row.try_get("author_member_id").map_err(DbError::from)?;
        let author_kind: String = row.try_get("author_kind").map_err(DbError::from)?;
        let author_display: String = row.try_get("display_name").map_err(DbError::from)?;
        ordered.push((
            seq,
            json!({
                "message_id": id.to_string().to_uppercase(),
                "channel_id": channel_id.to_string().to_uppercase(),
                "seq": seq,
                "author_member_id": author_member_id.to_string().to_uppercase(),
                "author_kind": author_kind,
                "author_display": author_display,
                "type": message_type,
                "body": context_message_body(&message_type, body.as_deref(), &props),
                "source_id": format!("msg_{}", id.to_string().to_uppercase()),
            }),
        ));
    }
    ordered.sort_by_key(|(seq, _)| *seq);
    Ok(ordered.into_iter().map(|(_, value)| value).collect())
}

/// The G2 counter: how many auto replies this agent has made since a human last
/// spoke in the channel (B7.2).
///
/// Swift `LoopGuards.loadSnapshot` (:202-222), ported query-for-query. It lives
/// here for the same reason [`agent_context_window_in_tx`] does — it is a
/// `message` read, and `momo-agent` owns none — and the caller
/// (`momo_agent::evaluate_a2a_spawn`) takes the number as an argument.
///
/// Four semantics are encoded in the predicate rather than in the caller, and
/// each one is a decision:
///
/// * **a human utterance resets the counter — structurally.** There is no
///   stored counter to reset: the count is bounded to `seq > last_human_seq`,
///   so "사람 개입 리셋" (§3.4) cannot be missed by a writer that forgot to
///   zero a column;
/// * **one count per run**, not per message (`DISTINCT run_id`), so an agent
///   that answers in three parts has taken one turn, not three. A message
///   without a `run_id` falls back to its own id, which counts it once;
/// * **only `type='text'` counts.** `tool_call`/`tool_result` are turn plumbing,
///   and `system` is excluded deliberately: the guard-trip notice this very gate
///   writes is a system line, and counting it would let a trip amplify itself;
/// * **other agents neither count nor reset.** In an A→B→A→B chain each agent
///   trips at its own cap, which is what makes the gate hold for a round-robin
///   the way it holds for a single runaway.
pub async fn agent_auto_reply_streak_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    agent_member_id: Uuid,
) -> Result<i32, DbError> {
    let streak: i32 = sqlx::query_scalar(
        "WITH last_human AS ( \
             SELECT COALESCE(max(m.seq), 0) AS seq \
               FROM message m \
               JOIN member mem ON mem.id = m.author_member_id \
              WHERE m.channel_id = $1 \
                AND m.deleted_at IS NULL \
                AND mem.kind = 'human' \
         ) \
         SELECT count(DISTINCT COALESCE(m.run_id::text, m.id::text))::int \
           FROM message m, last_human h \
          WHERE m.channel_id = $1 \
            AND m.deleted_at IS NULL \
            AND m.author_member_id = $2 \
            AND m.type = 'text' \
            AND m.seq > h.seq",
    )
    .bind(channel_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(streak)
}

/// Render a display body for the window — Swift `recentMessageBody` (:1898-1934).
///
/// Structured types carry their payload in `props` with `body = NULL`, so they
/// collapse to a terse summary rather than projecting an **empty** chat turn:
/// several OpenAI-compatible endpoints reject a message with empty `content`,
/// which would fail the whole turn over a tool call that happened to be in the
/// window. Raw `props` JSON is never put into the transcript.
pub fn context_message_body(message_type: &str, body: Option<&str>, props: &Value) -> String {
    let prop_str = |key: &str| {
        props
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    match message_type {
        "tool_call" => match prop_str("name") {
            Some(name) => format!("[tool_call: {name}]"),
            None => "[tool_call]".to_string(),
        },
        "tool_result" => "[tool_result]".to_string(),
        "diff" => match prop_str("path") {
            Some(path) => format!("[diff: {path}]"),
            None => "[diff]".to_string(),
        },
        "artifact" => match prop_str("title") {
            Some(title) => format!("[artifact: {title}]"),
            None => "[artifact]".to_string(),
        },
        "approval_request" => "[approval_request]".to_string(),
        _ => {
            let text = body.unwrap_or_default();
            if text.chars().count() > CONTEXT_BODY_MAX_CHARS {
                let mut truncated: String = text.chars().take(CONTEXT_BODY_MAX_CHARS).collect();
                truncated.push('…');
                truncated
            } else {
                text.to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A structured message must never project as empty content: several
    /// OpenAI-compatible gateways answer 400 for an empty `content`, so one tool
    /// call in the window would otherwise fail the whole turn.
    #[test]
    fn structured_types_summarize_instead_of_projecting_nothing() {
        assert_eq!(
            context_message_body("tool_call", None, &json!({"name": "read_file"})),
            "[tool_call: read_file]"
        );
        assert_eq!(
            context_message_body("tool_call", None, &json!({})),
            "[tool_call]"
        );
        assert_eq!(
            context_message_body("tool_result", None, &json!({})),
            "[tool_result]"
        );
        assert_eq!(
            context_message_body("diff", None, &json!({"path": "src/lib.rs"})),
            "[diff: src/lib.rs]"
        );
        assert_eq!(
            context_message_body("artifact", None, &json!({"title": "plan"})),
            "[artifact: plan]"
        );
        assert_eq!(
            context_message_body("approval_request", None, &json!({})),
            "[approval_request]"
        );
        for rendered in [
            context_message_body("tool_call", None, &json!({"secret": "sk-live"})),
            context_message_body("diff", None, &json!({"patch": "sk-live"})),
        ] {
            assert!(
                !rendered.contains("sk-live"),
                "raw props must not reach the transcript: {rendered}"
            );
        }
    }

    /// The elision is by CHARACTER: a byte cut would split a Korean codepoint.
    #[test]
    fn a_long_text_body_is_elided_by_characters() {
        let long = "가".repeat(CONTEXT_BODY_MAX_CHARS + 5);
        let rendered = context_message_body("text", Some(&long), &json!({}));
        assert_eq!(rendered.chars().count(), CONTEXT_BODY_MAX_CHARS + 1);
        assert!(rendered.ends_with('…'));

        assert_eq!(
            context_message_body("text", Some("안녕"), &json!({})),
            "안녕"
        );
        assert_eq!(context_message_body("text", None, &json!({})), "");
    }

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
        assert_eq!(inner["reply_to_id"], Value::Null);
        // Empty props are omitted, matching Swift.
        assert!(inner.get("props").is_none());
    }

    /// **The realtime wire carries the quote's ADDRESS, never its text**
    /// (ADR-0148 규칙 3).
    ///
    /// An outbox row is written once and replayed to every late subscriber, so
    /// a rendered quote embedded here would be a snapshot: still quoting the
    /// pre-edit text after an edit, and still quoting a deleted message after
    /// its author deleted it. Put a body in this payload and this test goes red.
    #[test]
    fn the_broadcast_carries_the_quote_id_and_no_copy_of_it() {
        let quoted = Uuid::from_u128(0xbeef);
        let payload = build_broadcast_payload(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            9,
            MessageType::Text,
            Some("그건 아니지"),
            Uuid::from_u128(4),
            1234,
            0,
            None,
            Some(quoted),
            &json!({}),
        );
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["reply_to_id"], json!(quoted));
        // Nothing here may describe the quoted message beyond its id.
        for forbidden in ["reply_to", "quote", "quoted_body", "reply_to_body"] {
            assert!(
                inner.get(forbidden).is_none(),
                "the realtime payload must not snapshot the quoted message: {payload}"
            );
        }
    }

    /// 규칙 1 — the two devices are independent, so a message may carry both.
    /// A payload that dropped one when the other was present would make
    /// "quoting a reply inside its own thread" unrepresentable on the wire.
    #[test]
    fn a_message_can_broadcast_a_thread_root_and_a_quote_at_once() {
        let root = Uuid::from_u128(0xaaa);
        let quoted = Uuid::from_u128(0xbbb);
        let payload = build_broadcast_payload(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            9,
            MessageType::Text,
            Some("이 답글 말이야"),
            Uuid::from_u128(4),
            1234,
            0,
            Some(root),
            Some(quoted),
            &json!({}),
        );
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["root_id"], json!(root));
        assert_eq!(inner["reply_to_id"], json!(quoted));
    }

    #[test]
    fn replies_limit_clamps_and_the_cursor_refuses_garbage() {
        assert_eq!(clamp_replies_limit(None), REPLIES_LIMIT_DEFAULT);
        assert_eq!(clamp_replies_limit(Some(0)), 1);
        assert_eq!(clamp_replies_limit(Some(10_000)), REPLIES_LIMIT_MAX);

        assert_eq!(parse_replies_cursor(None), Ok(None));
        assert_eq!(parse_replies_cursor(Some("  ")), Ok(None));
        assert_eq!(parse_replies_cursor(Some(" 12 ")), Ok(Some(12)));
        assert_eq!(parse_replies_cursor(Some("0")), Ok(Some(0)));
        // A bad cursor has no safe default: restarting from 0 would replay the
        // whole thread as new.
        assert_eq!(parse_replies_cursor(Some("-1")), Err(RepliesCursorInvalid));
        assert_eq!(
            parse_replies_cursor(Some("nope")),
            Err(RepliesCursorInvalid)
        );
    }

    /// A half-written rollup must not produce a badge a client cannot open.
    #[test]
    fn a_rollup_needs_all_three_parts_and_a_reply() {
        assert_eq!(
            thread_rollup(Some(2), Some(9), Some(1_700_000_000_000)),
            Some(ThreadRollup {
                reply_count: 2,
                last_reply_seq: 9,
                last_reply_at_ms: 1_700_000_000_000,
            })
        );
        assert_eq!(thread_rollup(Some(0), Some(9), Some(1)), None);
        assert_eq!(thread_rollup(None, Some(9), Some(1)), None);
        assert_eq!(thread_rollup(Some(2), None, Some(1)), None);
        assert_eq!(thread_rollup(Some(2), Some(9), None), None);
    }

    #[test]
    fn every_thread_root_rejection_keeps_its_own_sentence() {
        assert_eq!(
            ThreadRootInvalid::NotFound.to_string(),
            "thread root not found",
            "the web routing probe matches this sentence by shape (404) — see \
             docs/planning/2026-08-01-b4-contract-diff.md §4.1"
        );
        assert_eq!(
            ThreadRootInvalid::Deleted.to_string(),
            "thread root is deleted"
        );
        assert_eq!(
            ThreadRootInvalid::NotTopLevel.to_string(),
            "thread root must be a top-level message"
        );
    }

    /// **The N+1 answer, pinned without a database** (ADR-0148 §3-2).
    ///
    /// Both read paths resolve the quote inside the page's own statement, so a
    /// page of 100 quoting messages issues the same one query a page of none
    /// does. The assertions are deliberately about *structure*: delete the join
    /// — which is what anyone reaching for a per-row lookup would do first —
    /// and this goes red before the per-row fetch is even written.
    #[test]
    fn one_page_is_one_statement_however_many_quotes_it_holds() {
        let statements = [
            channel_page_sql(HistoryCursor::Newest),
            channel_page_sql(HistoryCursor::Before(5)),
            channel_page_sql(HistoryCursor::After(5)),
            thread_replies_sql(),
        ];
        for sql in &statements {
            assert!(
                sql.contains("LEFT JOIN message q ON q.id = m.reply_to_id"),
                "the quote must be resolved by the page's own join: {sql}"
            );
            assert!(
                sql.contains("q.channel_id = m.channel_id"),
                "규칙 2 must hold in the read path too: {sql}"
            );
            assert_eq!(
                sql.matches("SELECT").count(),
                1,
                "a page is ONE statement — a second SELECT here is a second round \
                 trip in disguise: {sql}"
            );
            assert!(
                !sql.contains(';'),
                "a page must not be a statement batch: {sql}"
            );
            // The quoted row's own quote is projected as a boolean and never as
            // an id — 규칙 4's "marker, not a second layer" begins here.
            assert!(
                sql.contains("(q.reply_to_id IS NOT NULL) AS quote_quotes_another"),
                "the second layer is a marker: {sql}"
            );
            assert!(
                !sql.contains("q.reply_to_id AS"),
                "projecting the inner target's id invites the staircase 규칙 4 \
                 forbids: {sql}"
            );
        }
    }

    /// Each refusal keeps its own sentence, and the two say different things —
    /// "there is no such message here" and "that message is gone" are different
    /// problems with different fixes.
    #[test]
    fn every_quote_target_rejection_keeps_its_own_sentence() {
        assert_eq!(
            QuoteTargetInvalid::NotFound.to_string(),
            "quoted message not found in this channel"
        );
        assert_eq!(
            QuoteTargetInvalid::Deleted.to_string(),
            "a deleted message cannot be quoted"
        );
        assert_ne!(
            QuoteTargetInvalid::NotFound.to_string(),
            QuoteTargetInvalid::Deleted.to_string()
        );
        // A quote refusal must never read as a thread refusal: the web send
        // probe reads refusals by shape, and the two devices are separate.
        for quote in [QuoteTargetInvalid::NotFound, QuoteTargetInvalid::Deleted] {
            for root in [
                ThreadRootInvalid::NotFound,
                ThreadRootInvalid::Deleted,
                ThreadRootInvalid::NotTopLevel,
            ] {
                assert_ne!(quote.to_string(), root.to_string());
            }
        }
    }

    #[test]
    fn thread_updated_payload_matches_swift_envelope() {
        let ws = Uuid::from_u128(1);
        let ch = Uuid::from_u128(2);
        let root = Uuid::from_u128(3);
        let rollup = ThreadRollup {
            reply_count: 4,
            last_reply_seq: 11,
            last_reply_at_ms: 1_700_000_000_123,
        };
        let payload = build_thread_updated_payload(ws, ch, root, &rollup);

        assert_eq!(payload["channel"], json!(cent_channel(ws, ch)));
        assert_eq!(payload["data"]["type"], json!("thread.updated"));
        assert_eq!(payload["data"]["v"], json!(1));
        assert_eq!(payload["data"]["seq"], json!(11));
        assert_eq!(payload["data"]["ts"], json!(1_700_000_000_123_i64));
        assert_eq!(payload["data"]["payload"]["reply_count"], json!(4));
        assert_eq!(payload["data"]["payload"]["last_reply_seq"], json!(11));
        assert_eq!(
            payload["data"]["payload"]["last_reply_at"],
            json!(1_700_000_000_123_i64)
        );
        assert_eq!(
            payload["data"]["payload"]["root_id"],
            json!(root.to_string().to_uppercase()),
            "Swift writes `rootID.uuidString`, which is uppercase"
        );
        // The reply's own message.new already claimed this seq as the channel
        // version; re-claiming it would make Centrifugo drop the publish.
        assert!(
            payload.get("version").is_none(),
            "thread.updated must carry no version: {payload}"
        );
        assert_eq!(
            payload["idempotency_key"],
            json!(format!(
                "{}:thread.updated:{}:11",
                cent_channel(ws, ch),
                root.to_string().to_uppercase()
            ))
        );
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
            None,
            &json!({"mention_member_ids": ["x"]}),
        );
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["body"], Value::Null);
        assert_eq!(inner["props"]["mention_member_ids"], json!(["x"]));
    }
}
