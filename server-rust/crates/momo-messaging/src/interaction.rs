//! Message interactions — edit, delete, react, **pin** (B11; Swift
//! `MessageRoutes.swift:626-936`, "MOMO-478" — pin is 이슈 #1112, Rust-only).
//!
//! Everything here mutates a message that **already has a seq**, and that single
//! fact is what shapes the module:
//!
//! 1. **No interaction consumes a `seq` (invariant #4, gapless).** Not one
//!    statement below touches `channel_seq`; the edit/delete `UPDATE`s carry no
//!    seq column and the reaction writes do not touch `message` at all. Every
//!    broadcast reuses the **target message's own** seq, exactly as Swift does
//!    (`messageInteractionPayload` passes `message.seq`,
//!    `reactionInteractionPayload` passes the locked row's `seq`). A new seq per
//!    reaction would make a 👍 look like an unread message to every cursor in the
//!    workspace.
//! 2. **…which is why the broadcasts carry no `version`.** Centrifugo drops a
//!    publish whose version is not strictly greater than the channel's stored
//!    one, and the target's own `message.new` already claimed that number. Swift
//!    documents this at `MessageRoutes.swift:1231-1234`; the `thread.updated`
//!    payload ([`crate::build_thread_updated_payload`]) omits it for the same
//!    reason. Idempotency rides on the key alone.
//! 3. **Single write path (invariant #3).** The realtime notification is an
//!    [`momo_outbox::emit_outbox`] row on the caller's connection — the same
//!    transaction as the mutation it describes. This crate never calls
//!    Centrifugo; `momo-relay` drains the outbox (invariant #2).
//! 4. **RLS FORCE (invariant #6).** Nothing here opens a connection. Every entry
//!    point takes a `&mut PgConnection` already inside `momo_db::with_tenant_tx`,
//!    so `reaction`/`message` reads and writes are tenant-scoped by the GUC, and
//!    a message id from another workspace simply does not exist
//!    ([`InteractionRefused::NotFound`]).
//! 5. **Agent = member, no branch (invariant #5).** The only identity these
//!    functions know is a `member.id`. An agent edits, deletes and reacts through
//!    the identical statements a human does; there is no `member_kind` predicate
//!    anywhere in this file, and that absence is the invariant.
//!
//! ## The guard order is Swift's, deliberately
//!
//! `lock → membership → authorship → state`. It is not the cheapest order (the
//! membership read could be skipped for a message that does not exist), but it
//! is the one that answers **404 before 403**: reversing them would tell a
//! non-member whether a given message id exists in a channel they cannot read.
//! The row lock is taken first so two concurrent edits of the same message
//! serialize rather than interleave.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::identity::is_channel_member;
use crate::message::{cent_channel, StoredMessage};

/// The per-message reaction cap (Swift `MessageRoutes.swift:845`, `count < 200`).
///
/// Counted across **all** emoji on the message, not per emoji: the cost this
/// bounds is the row count a snapshot has to project, and that does not care
/// which emoji the rows carry.
pub const MESSAGE_REACTION_LIMIT: i64 = 200;

/// Maximum emoji length (Swift `emoji.count <= 32`).
///
/// Swift counts **grapheme clusters** and this counts **scalar values**, which
/// is never more permissive: a grapheme is one or more scalars, so
/// `chars().count() <= 32` implies `graphemes <= 32`. The bound only ever
/// rejects a subset of what Swift rejects — never the reverse — and 32 scalars
/// still clears the longest emoji anyone sends (a 4-person ZWJ family is 7).
pub const REACTION_EMOJI_MAX_CHARS: usize = 32;

/// The per-channel pin cap (이슈 #1112; migration `062_message_pin.sql`).
///
/// **The trigger in 062 is the authority**; this constant only exists so the
/// domain can refuse with a 409 before Postgres refuses with a 23514. The two
/// must agree — a change here without a migration would turn a friendly refusal
/// back into a raw constraint error.
///
/// Why 100 rather than the reaction cap's 200: the bound is on a *read* surface.
/// A channel's pins are projected into the channel header on every cold load,
/// whereas 200 reactions sit on one message nobody has to scan. 100 is Slack's
/// own per-channel limit and the length a header list can still be read at.
pub const CHANNEL_PIN_LIMIT: i64 = 100;

/// Why an emoji path segment was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReactionEmojiInvalid {
    #[error("emoji must not be empty")]
    Empty,
    #[error("emoji must contain at most 32 characters")]
    TooLong,
    /// **Additive to Swift** (B11 packet §2-1, "제어문자 배제"). Swift accepts a
    /// control character as an emoji; it would then be stored, echoed to every
    /// client and used as a rendering key. Refusing it is a strict narrowing of
    /// the accepted set, so no emoji any client sends today stops working.
    #[error("emoji must not contain control characters")]
    ControlCharacter,
}

/// Validate a reaction emoji, returning it **unchanged**.
///
/// Untrimmed on purpose: Swift checks emptiness against the *trimmed* string but
/// persists the raw one (`MessageRoutes.emojiParameter`, :1295-1305), so `" 👍"`
/// and `"👍"` are two different reactions on both servers. Trimming here would
/// silently merge rows the macOS client already stores apart.
pub fn validate_reaction_emoji(raw: &str) -> Result<&str, ReactionEmojiInvalid> {
    if raw.trim().is_empty() {
        return Err(ReactionEmojiInvalid::Empty);
    }
    if raw.chars().any(char::is_control) {
        return Err(ReactionEmojiInvalid::ControlCharacter);
    }
    if raw.chars().count() > REACTION_EMOJI_MAX_CHARS {
        return Err(ReactionEmojiInvalid::TooLong);
    }
    Ok(raw)
}

/// Why an interaction was refused, with the client-facing sentence Swift uses.
///
/// Each variant owns its wording so the route layer only maps status codes — one
/// vocabulary, and a rename cannot drift between the two servers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InteractionRefused {
    #[error("message not found")]
    NotFound,
    #[error("not a member of this channel")]
    NotAMember,
    #[error("only the message author may edit")]
    NotAuthorForEdit,
    #[error("only the message author may delete")]
    NotAuthorForDelete,
    #[error("deleted messages cannot be edited")]
    EditDeleted,
    #[error("deleted messages cannot receive reactions")]
    ReactDeleted,
    #[error("message reaction limit reached")]
    ReactionLimit,
    #[error("message body must not be empty")]
    EmptyBody,
    /// Pinning a tombstone would put an empty row in the channel header that
    /// nobody can open. Unpinning one is allowed — see [`set_pin_in_tx`].
    #[error("deleted messages cannot be pinned")]
    PinDeleted,
    #[error("channel pin limit reached")]
    PinLimit,
}

/// The row-locked message an interaction is about to act on (Swift
/// `LockedMessage`, :940-946).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockedMessage {
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    pub seq: i64,
    pub state: String,
    pub deleted_at: Option<DateTime<Utc>>,
}

impl LockedMessage {
    /// Both halves of "deleted", because both are written and either alone is a
    /// half-tombstone: Swift's own guards read `state == "deleted" ||
    /// deletedAt != nil` every time.
    pub fn is_deleted(&self) -> bool {
        self.state == "deleted" || self.deleted_at.is_some()
    }
}

/// `SELECT … FOR UPDATE` the message an interaction targets.
///
/// No channel or workspace predicate: RLS FORCE already confines the read to the
/// transaction's tenant, so a foreign message id returns no row and the caller
/// answers 404 — the same non-disclosure `ThreadRootInvalid::NotFound` relies on.
pub async fn lock_message_in_tx(
    conn: &mut PgConnection,
    message_id: Uuid,
) -> Result<Option<LockedMessage>, DbError> {
    let row = sqlx::query(
        "SELECT channel_id, author_member_id, seq, state::text AS state, deleted_at \
           FROM message \
          WHERE id = $1 \
          FOR UPDATE",
    )
    .bind(message_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(LockedMessage {
        channel_id: row.try_get("channel_id")?,
        author_member_id: row.try_get("author_member_id")?,
        seq: row.try_get("seq")?,
        state: row.try_get("state")?,
        deleted_at: row.try_get("deleted_at")?,
    }))
}

/// The full `message` projection an interaction answers with.
///
/// [`StoredMessage`] plus the two columns the send path deliberately omits
/// (`run_id`, `client_msg_id`): Swift's `loadMessageProjection` (:1100-1136)
/// carries both in the `message.edited` broadcast, and a realtime consumer that
/// loses `client_msg_id` cannot match the edit against its own optimistic row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractionMessage {
    pub message: StoredMessage,
    pub run_id: Option<Uuid>,
    pub client_msg_id: Option<Uuid>,
}

/// The `message.*` columns an interaction returns, shared by the edit/delete
/// `RETURNING` clauses and the re-read of an already-deleted row.
const INTERACTION_COLS: &str = "id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
     author_member_id, type::text AS message_type, state::text AS state, body, props, \
     root_id, reply_to_id, created_at, edited_at, deleted_at, run_id, client_msg_id";

fn decode_interaction(row: &sqlx::postgres::PgRow) -> Result<InteractionMessage, sqlx::Error> {
    Ok(InteractionMessage {
        message: crate::message::decode_stored_row(row)?,
        run_id: row.try_get("run_id")?,
        client_msg_id: row.try_get("client_msg_id")?,
    })
}

/// Epoch milliseconds, the unit every `*_at_ms` wire key carries.
fn ms(at: Option<DateTime<Utc>>) -> Option<i64> {
    at.map(|at| at.timestamp_millis())
}

/// Build the outbox envelope shared by every interaction broadcast (Swift
/// `encodeInteractionPayload`, :1215-1239).
///
/// **No `version`** — see the module docs, point 2. The idempotency key carries a
/// fresh UUID exactly like Swift's, so two edits of the same message at the same
/// seq are two distinct publications rather than one silently deduped.
fn interaction_envelope(
    workspace_id: Uuid,
    channel_id: Uuid,
    event_type: &str,
    timestamp_ms: i64,
    seq: i64,
    payload: Value,
) -> Value {
    let channel = cent_channel(workspace_id, channel_id);
    let envelope = BroadcastPayload {
        idempotency_key: Some(format!(
            "{channel}:{event_type}:{}",
            Uuid::new_v4().to_string().to_uppercase()
        )),
        data: json!({
            "type": event_type,
            "v": 1,
            "ts": timestamp_ms,
            "seq": seq,
            "payload": payload,
        }),
        channel,
        version: None,
    };
    serde_json::to_value(envelope).expect("interaction payload serializes")
}

/// The `message.edited` payload: the whole message, snake_case (Swift
/// `messageInteractionPayload`, :1143-1176).
///
/// `props` is present even when empty — unlike `message.new`, which omits it.
/// That asymmetry is Swift's and it is the right way round: a `message.new`
/// without `props` has none, while an *edit* that omitted `props` would be
/// indistinguishable from an edit that cleared them.
pub fn build_message_edited_payload(workspace_id: Uuid, projection: &InteractionMessage) -> Value {
    let message = &projection.message;
    let edited_at_ms = ms(message.edited_at);
    let deleted_at_ms = ms(message.deleted_at);
    let mut payload = Map::new();
    payload.insert("id".into(), json!(message.id));
    payload.insert("channel_id".into(), json!(message.channel_id));
    payload.insert("seq".into(), json!(message.seq));
    payload.insert("hlc_ts".into(), json!(message.hlc_ts));
    payload.insert("hlc_count".into(), json!(message.hlc_count));
    payload.insert("author_member_id".into(), json!(message.author_member_id));
    payload.insert("type".into(), json!(message.message_type.as_db_label()));
    payload.insert("state".into(), json!(message.state));
    payload.insert("body".into(), json!(message.body));
    payload.insert(
        "props".into(),
        match message.props.as_object() {
            Some(object) => Value::Object(object.clone()),
            None => Value::Object(Map::new()),
        },
    );
    payload.insert("root_id".into(), json!(message.root_id));
    // ADR-0148: the id only. An edit re-publishes the whole message, and a
    // rendered quote inside it would be the snapshot 규칙 3 forbids — frozen at
    // edit time, on every client, forever.
    payload.insert("reply_to_id".into(), json!(message.reply_to_id));
    payload.insert("run_id".into(), json!(projection.run_id));
    payload.insert("client_msg_id".into(), json!(projection.client_msg_id));
    payload.insert(
        "created_at_ms".into(),
        json!(message.created_at.timestamp_millis()),
    );
    payload.insert("edited_at_ms".into(), json!(edited_at_ms));
    payload.insert("deleted_at_ms".into(), json!(deleted_at_ms));

    interaction_envelope(
        workspace_id,
        message.channel_id,
        "message.edited",
        // Swift: editedAtMs ?? deletedAtMs ?? hlcTs.
        edited_at_ms.or(deleted_at_ms).unwrap_or(message.hlc_ts),
        message.seq,
        Value::Object(payload),
    )
}

/// The `message.deleted` payload: the id and nothing else (Swift
/// `deleteInteractionPayload`, :1178-1191).
///
/// A tombstone must not re-broadcast the body it just erased — that would put
/// the deleted text back on every connected client's wire.
pub fn build_message_deleted_payload(workspace_id: Uuid, projection: &InteractionMessage) -> Value {
    let message = &projection.message;
    interaction_envelope(
        workspace_id,
        message.channel_id,
        "message.deleted",
        ms(message.deleted_at).unwrap_or(message.hlc_ts),
        message.seq,
        json!({ "message_id": message.id }),
    )
}

/// Which way a reaction moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReactionAction {
    Added,
    Removed,
}

impl ReactionAction {
    /// The wire token, and also the `reaction.<action>` event suffix.
    pub fn as_wire_label(self) -> &'static str {
        match self {
            ReactionAction::Added => "added",
            ReactionAction::Removed => "removed",
        }
    }
}

/// The reaction delta a mutation answers with (Swift `ReactionDeltaDTO`).
///
/// **The ids are uppercase**, because Swift builds this DTO from
/// `UUID.uuidString` rather than from a `::text` cast — see
/// [`ReactionDelta::message_id_wire`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactionDelta {
    pub action: ReactionAction,
    pub message_id: Uuid,
    pub member_id: Uuid,
    pub emoji: String,
    /// The target's seq, reused by the broadcast (never a new one).
    pub seq: i64,
    pub channel_id: Uuid,
    /// `false` when the row was already in the requested state — a duplicate
    /// PUT or a DELETE of a reaction that was not there. The call still
    /// **succeeds** (idempotent), but it broadcasts and audits nothing, because
    /// nothing changed.
    pub changed: bool,
}

impl ReactionDelta {
    /// The `messageId` **as Swift spells it on the wire: uppercase.**
    ///
    /// Swift's `ReactionDeltaDTO` and the reaction snapshot are the only message
    /// projections built from `UUID.uuidString` (uppercase) instead of a
    /// Postgres `id::text` cast (lowercase) — every other message id in the API
    /// is lowercase. It is an inconsistency, and it is reproduced here rather
    /// than fixed because the shipped macOS client parses these into `UUID`
    /// (case-insensitive) while a string-keyed client would break the moment the
    /// two servers disagreed. Clients that key by string must compare ids
    /// case-insensitively; `clients/web` normalises on ingest.
    pub fn message_id_wire(&self) -> String {
        self.message_id.to_string().to_uppercase()
    }

    /// The `memberId` on the wire — uppercase, for the same reason.
    pub fn member_id_wire(&self) -> String {
        self.member_id.to_string().to_uppercase()
    }
}

/// The `reaction.added` / `reaction.removed` payload (Swift
/// `reactionInteractionPayload`, :1193-1213).
///
/// `ts` is wall-clock now, not the message's: the message did not change, the
/// reaction happened now. `seq` is still the message's — see the module docs.
pub fn build_reaction_payload(workspace_id: Uuid, delta: &ReactionDelta) -> Value {
    interaction_envelope(
        workspace_id,
        delta.channel_id,
        &format!("reaction.{}", delta.action.as_wire_label()),
        Utc::now().timestamp_millis(),
        delta.seq,
        json!({
            "action": delta.action.as_wire_label(),
            "message_id": delta.message_id_wire(),
            "member_id": delta.member_id_wire(),
            "emoji": delta.emoji,
        }),
    )
}

/// Shared prologue: lock the target and run the membership gate.
///
/// Returns the refusal rather than the row when either fails, so all four entry
/// points below run the identical order (see the module docs).
async fn lock_and_authorize(
    conn: &mut PgConnection,
    message_id: Uuid,
    actor_member_id: Uuid,
) -> Result<Result<LockedMessage, InteractionRefused>, DbError> {
    let Some(locked) = lock_message_in_tx(&mut *conn, message_id).await? else {
        return Ok(Err(InteractionRefused::NotFound));
    };
    if !is_channel_member(&mut *conn, locked.channel_id, actor_member_id).await? {
        return Ok(Err(InteractionRefused::NotAMember));
    }
    Ok(Ok(locked))
}

/// `PATCH /v1/workspaces/{ws}/messages/{id}` — rewrite a message's body.
///
/// Author-only, and the check is here rather than in the route because it is a
/// *domain* rule: an admin cannot rewrite what someone else said, and a
/// permission model that let them would make every quoted message deniable.
/// `state` becomes `'edited'` and `edited_at` is stamped with `clock_timestamp()`
/// — the statement's own wall clock, not the transaction's start, so two edits in
/// one transaction do not report the same instant.
///
/// The body is validated **before** the write (non-blank, Swift's
/// `trimmingCharacters(…).isEmpty` check) but stored **untrimmed**, exactly as
/// Swift stores `dto.body`: leading whitespace can be meaningful (a code block),
/// and the guard only exists to stop an edit from silently becoming a deletion.
pub async fn edit_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    actor_member_id: Uuid,
    body: &str,
) -> Result<Result<InteractionMessage, InteractionRefused>, DbError> {
    if body.trim().is_empty() {
        return Ok(Err(InteractionRefused::EmptyBody));
    }
    let locked = match lock_and_authorize(&mut *conn, message_id, actor_member_id).await? {
        Ok(locked) => locked,
        Err(refused) => return Ok(Err(refused)),
    };
    if locked.author_member_id != actor_member_id {
        return Ok(Err(InteractionRefused::NotAuthorForEdit));
    }
    if locked.is_deleted() {
        return Ok(Err(InteractionRefused::EditDeleted));
    }

    let sql = format!(
        "UPDATE message \
            SET body = $2, state = 'edited', edited_at = clock_timestamp() \
          WHERE id = $1 \
        RETURNING {INTERACTION_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(message_id)
        .bind(body)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(Err(InteractionRefused::NotFound));
    };
    let projection = decode_interaction(&row)?;

    let payload = build_message_edited_payload(workspace_id, &projection);
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(projection.message.channel_id),
    )
    .await?;
    Ok(Ok(projection))
}

/// Outcome of [`delete_message_in_tx`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedMessage {
    pub message: InteractionMessage,
    /// `true` when the message was **already** a tombstone. Swift returns the
    /// existing projection and records nothing (`MessageRoutes.swift:730-734`):
    /// deleting twice is idempotent, and a second `message.deleted` broadcast
    /// would only tell every client something it already applied.
    pub already_deleted: bool,
}

/// `DELETE /v1/workspaces/{ws}/messages/{id}` — soft delete.
///
/// **Soft**, and that is the whole design: the row keeps its `id` and its `seq`,
/// `body` becomes NULL and `state` becomes `'deleted'`. A hard delete would
/// punch a hole in a channel's gapless seq (invariant #4) and leave every client
/// that had already read past it unable to tell a deletion from a lost message.
/// History deliberately keeps projecting tombstones for the same reason
/// (`list_channel_page` has no `deleted_at IS NULL` filter).
///
/// The message's reactions are deleted with it (Swift :770-773). They annotate a
/// body that no longer exists, and leaving them would let the snapshot report
/// counts for text nobody can read.
pub async fn delete_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    actor_member_id: Uuid,
) -> Result<Result<DeletedMessage, InteractionRefused>, DbError> {
    let locked = match lock_and_authorize(&mut *conn, message_id, actor_member_id).await? {
        Ok(locked) => locked,
        Err(refused) => return Ok(Err(refused)),
    };
    if locked.author_member_id != actor_member_id {
        return Ok(Err(InteractionRefused::NotAuthorForDelete));
    }

    if locked.is_deleted() {
        let sql = format!("SELECT {INTERACTION_COLS} FROM message WHERE id = $1");
        let row = sqlx::query(&sql)
            .bind(message_id)
            .fetch_optional(&mut *conn)
            .await?;
        let Some(row) = row else {
            return Ok(Err(InteractionRefused::NotFound));
        };
        return Ok(Ok(DeletedMessage {
            message: decode_interaction(&row)?,
            already_deleted: true,
        }));
    }

    let sql = format!(
        "UPDATE message \
            SET state = 'deleted', body = NULL, deleted_at = clock_timestamp() \
          WHERE id = $1 \
        RETURNING {INTERACTION_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(message_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(Err(InteractionRefused::NotFound));
    };
    let projection = decode_interaction(&row)?;

    sqlx::query("DELETE FROM reaction WHERE message_id = $1")
        .bind(message_id)
        .execute(&mut *conn)
        .await?;

    // …and its pin, for the same reason (이슈 #1112). A tombstone left pinned
    // would hold a slot against `CHANNEL_PIN_LIMIT` and draw an empty row in the
    // channel header. **No `message.unpinned` is published**: the client already
    // receives `message.deleted` for this id and drops the pin on it, so a second
    // frame would describe the same event twice.
    sqlx::query("DELETE FROM message_pin WHERE message_id = $1")
        .bind(message_id)
        .execute(&mut *conn)
        .await?;

    let payload = build_message_deleted_payload(workspace_id, &projection);
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(projection.message.channel_id),
    )
    .await?;
    Ok(Ok(DeletedMessage {
        message: projection,
        already_deleted: false,
    }))
}

/// `PUT`/`DELETE …/messages/{id}/reactions/{emoji}` — toggle one member's
/// reaction.
///
/// **Idempotent by construction.** Adding a reaction that already exists is a
/// success that changes nothing: the pre-read plus `ON CONFLICT
/// (message_id, member_id, emoji) DO NOTHING` means a duplicate PUT can never
/// surface the unique-violation as a 500, which is the failure mode a
/// double-tapped emoji produces in practice. Removing one that is not there is
/// the same shape.
///
/// Note the asymmetry on a tombstone: **adding** is refused, **removing** is
/// allowed. Swift's guard is `if adding, row.state == "deleted" …`
/// (:823-825), and it is right — a member must be able to withdraw a reaction
/// from a message whose author deleted it (in practice the delete already
/// removed the rows, so this only ever runs against a message tombstoned by an
/// older code path).
///
/// Author-agnostic on purpose: anyone in the channel may react. There is no
/// authorship gate here at all, and no agent branch either — an agent member
/// reacts through this exact statement (invariant #5).
pub async fn set_reaction_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    member_id: Uuid,
    emoji: &str,
    action: ReactionAction,
) -> Result<Result<ReactionDelta, InteractionRefused>, DbError> {
    let locked = match lock_and_authorize(&mut *conn, message_id, member_id).await? {
        Ok(locked) => locked,
        Err(refused) => return Ok(Err(refused)),
    };
    if action == ReactionAction::Added && locked.is_deleted() {
        return Ok(Err(InteractionRefused::ReactDeleted));
    }

    let changed = match action {
        ReactionAction::Added => {
            let existing: Option<i32> = sqlx::query_scalar(
                "SELECT 1 FROM reaction \
                  WHERE message_id = $1 AND member_id = $2 AND emoji = $3 \
                  LIMIT 1",
            )
            .bind(message_id)
            .bind(member_id)
            .bind(emoji)
            .fetch_optional(&mut *conn)
            .await?;
            if existing.is_some() {
                false
            } else {
                let count: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM reaction WHERE message_id = $1")
                        .bind(message_id)
                        .fetch_one(&mut *conn)
                        .await?;
                if count >= MESSAGE_REACTION_LIMIT {
                    return Ok(Err(InteractionRefused::ReactionLimit));
                }
                let inserted: Option<Uuid> = sqlx::query_scalar(
                    "INSERT INTO reaction (workspace_id, message_id, member_id, emoji) \
                     VALUES ($1, $2, $3, $4) \
                     ON CONFLICT (message_id, member_id, emoji) DO NOTHING \
                     RETURNING id",
                )
                .bind(workspace_id)
                .bind(message_id)
                .bind(member_id)
                .bind(emoji)
                .fetch_optional(&mut *conn)
                .await?;
                inserted.is_some()
            }
        }
        ReactionAction::Removed => {
            let removed: Option<Uuid> = sqlx::query_scalar(
                "DELETE FROM reaction \
                  WHERE message_id = $1 AND member_id = $2 AND emoji = $3 \
                RETURNING id",
            )
            .bind(message_id)
            .bind(member_id)
            .bind(emoji)
            .fetch_optional(&mut *conn)
            .await?;
            removed.is_some()
        }
    };

    let delta = ReactionDelta {
        action,
        message_id,
        member_id,
        emoji: emoji.to_string(),
        seq: locked.seq,
        channel_id: locked.channel_id,
        changed,
    };
    if changed {
        let payload = build_reaction_payload(workspace_id, &delta);
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &payload,
            Some(locked.channel_id),
        )
        .await?;
    }
    Ok(Ok(delta))
}

/// `message id -> emoji -> member ids`, the cold-load projection (Swift
/// `reactionSnapshot`, :901-936).
///
/// Tombstoned messages are excluded: their reactions were deleted with them, so
/// a row here would be a leftover from an older code path, and reporting it
/// would draw a count on a message whose body is gone.
///
/// `BTreeMap`/sorted members rather than a hash map so the response is
/// byte-stable — the same request twice produces the same body, which is what
/// makes it cacheable and diffable. Swift gets the same ordering from its
/// `ORDER BY r.message_id, r.emoji, r.member_id`.
pub type ReactionSnapshot = BTreeMap<String, BTreeMap<String, Vec<String>>>;

/// Read a channel's whole reaction snapshot. Membership is the caller's gate
/// (the route runs it inside the same transaction), matching every other
/// channel-scoped read in this crate.
pub async fn channel_reaction_snapshot(
    conn: &mut PgConnection,
    channel_id: Uuid,
) -> Result<ReactionSnapshot, DbError> {
    let rows = sqlx::query(
        "SELECT r.message_id, r.emoji, r.member_id \
           FROM reaction r \
           JOIN message m ON m.id = r.message_id \
          WHERE m.channel_id = $1 \
            AND m.deleted_at IS NULL \
            AND m.state <> 'deleted' \
          ORDER BY r.message_id, r.emoji, r.member_id",
    )
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut snapshot: ReactionSnapshot = BTreeMap::new();
    for row in &rows {
        let message_id: Uuid = row.try_get("message_id")?;
        let emoji: String = row.try_get("emoji")?;
        let member_id: Uuid = row.try_get("member_id")?;
        snapshot
            .entry(message_id.to_string().to_uppercase())
            .or_default()
            .entry(emoji)
            .or_default()
            .push(member_id.to_string().to_uppercase());
    }
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// PIN (이슈 #1112) — reaction's shape, one axis different
// ---------------------------------------------------------------------------

/// Which way a pin moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinAction {
    Pinned,
    Unpinned,
}

impl PinAction {
    /// The wire token, and also the `message.<action>` event suffix.
    pub fn as_wire_label(self) -> &'static str {
        match self {
            PinAction::Pinned => "pinned",
            PinAction::Unpinned => "unpinned",
        }
    }
}

/// One entry of a channel's pin list — the pin **and enough of the message to
/// draw it**.
///
/// The message half is here rather than left to a second read because the
/// surface this feeds is a header list of messages that are, by definition, not
/// the ones on screen: a pin is most useful for a message scrolled far away, so
/// a projection that carried only ids would force a lookup that misses.
///
/// The same struct is what [`build_pin_payload`] puts on the wire, which is the
/// point — a client that applies `message.pinned` ends up with byte-identical
/// state to one that re-read the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedMessage {
    pub message_id: Uuid,
    pub channel_id: Uuid,
    /// The pinned message's own seq. The pin does not mint one — see the module
    /// docs, point 1.
    pub seq: i64,
    pub author_member_id: Uuid,
    pub message_type: String,
    pub state: String,
    /// `None` only for a row an older code path tombstoned without sweeping its
    /// pin; [`channel_pins`] filters those out.
    pub body: Option<String>,
    pub created_at: DateTime<Utc>,
    pub pinned_by: Uuid,
    pub pinned_at: DateTime<Utc>,
}

impl PinnedMessage {
    /// The wire object, snake_case like every other broadcast payload.
    ///
    /// **Ids are lowercase here**, unlike the reaction wire. That uppercase is a
    /// Swift `uuidString` legacy the reaction path reproduces for the shipped
    /// macOS client ([`ReactionDelta::message_id_wire`]); pin is a new surface
    /// with no client to keep compatible, so it uses the same lowercase form as
    /// every other message id in the API.
    fn to_wire(&self) -> Value {
        json!({
            "message_id": self.message_id,
            "channel_id": self.channel_id,
            "seq": self.seq,
            "author_member_id": self.author_member_id,
            "type": self.message_type,
            "state": self.state,
            "body": self.body,
            "created_at_ms": self.created_at.timestamp_millis(),
            "pinned_by": self.pinned_by,
            "pinned_at_ms": self.pinned_at.timestamp_millis(),
        })
    }
}

/// The pin delta a mutation answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinDelta {
    pub action: PinAction,
    pub message_id: Uuid,
    pub channel_id: Uuid,
    /// The pinned message's seq, reused by the broadcast (never a new one).
    pub seq: i64,
    /// `false` when the row was already in the requested state — a duplicate PUT
    /// or a DELETE of a pin that was not there. The call still **succeeds**
    /// (idempotent), but it broadcasts and audits nothing.
    pub changed: bool,
    /// The list entry, on an effective pin only. `None` for an unpin (there is
    /// nothing left to draw) and for a no-op.
    pub pinned: Option<PinnedMessage>,
}

/// The `message.pinned` / `message.unpinned` payload.
///
/// `ts` is wall-clock now, not the message's: the message did not change, the
/// pin happened now. `seq` is still the message's — see the module docs.
///
/// `message.pinned` carries the whole list entry so a header list can insert it
/// without re-reading; `message.unpinned` carries the id alone, because removal
/// needs no projection and re-broadcasting a body on the way out would be the
/// mistake [`build_message_deleted_payload`] avoids.
pub fn build_pin_payload(workspace_id: Uuid, delta: &PinDelta) -> Value {
    let payload = match (&delta.pinned, delta.action) {
        (Some(pinned), PinAction::Pinned) => pinned.to_wire(),
        _ => json!({
            "message_id": delta.message_id,
            "channel_id": delta.channel_id,
        }),
    };
    interaction_envelope(
        workspace_id,
        delta.channel_id,
        &format!("message.{}", delta.action.as_wire_label()),
        Utc::now().timestamp_millis(),
        delta.seq,
        payload,
    )
}

/// The `message`/`message_pin` columns a pin list entry is decoded from.
const PIN_COLS: &str = "p.message_id, p.channel_id, p.pinned_by, p.pinned_at, \
     m.seq, m.author_member_id, m.type::text AS message_type, m.state::text AS state, \
     m.body, m.created_at";

fn decode_pin(row: &sqlx::postgres::PgRow) -> Result<PinnedMessage, sqlx::Error> {
    Ok(PinnedMessage {
        message_id: row.try_get("message_id")?,
        channel_id: row.try_get("channel_id")?,
        seq: row.try_get("seq")?,
        author_member_id: row.try_get("author_member_id")?,
        message_type: row.try_get("message_type")?,
        state: row.try_get("state")?,
        body: row.try_get("body")?,
        created_at: row.try_get("created_at")?,
        pinned_by: row.try_get("pinned_by")?,
        pinned_at: row.try_get("pinned_at")?,
    })
}

/// `PUT`/`DELETE …/messages/{id}/pin` — pin or unpin a message in its channel.
///
/// **A pin is the channel's fact, not the pinner's.** `message_pin` is unique on
/// `message_id` alone (not on `(message, member)` the way `reaction` is), so two
/// people pinning the same message produce one header row, and **any** channel
/// member may unpin — including one who did not pin it. Requiring the pinner
/// would strand every pin whose author left the workspace, and a pin is not
/// property. `pinned_by` records where it came from; it grants nothing.
///
/// **Idempotent by construction**, exactly like [`set_reaction_in_tx`]: the
/// insert is `ON CONFLICT (message_id) DO NOTHING` and the delete reports
/// whether a row was there. A double-tapped "고정하기" is a 200, never a
/// unique-violation 500.
///
/// Note the asymmetry on a tombstone, and it is the reaction path's: **pinning**
/// a deleted message is refused, **unpinning** one is allowed. The delete sweep
/// normally removes the row already, so the unpin branch only ever runs against
/// a pin left by an older code path — and a member must be able to clear it.
///
/// **The channel advisory is what makes the cap real.** The message row lock
/// [`lock_and_authorize`] takes serializes two pins *of the same message*, which
/// is not the race the cap has: two members pinning two *different* messages
/// would both read `count = 99` and both insert. The advisory is keyed on the
/// channel — the axis the cap is counted on — and is taken only on the insert
/// branch, so an unpin never waits behind a pin. The trigger in migration 062
/// remains the authority; this only ensures the friendly 409 is the one callers
/// actually see.
pub async fn set_pin_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    member_id: Uuid,
    action: PinAction,
) -> Result<Result<PinDelta, InteractionRefused>, DbError> {
    let locked = match lock_and_authorize(&mut *conn, message_id, member_id).await? {
        Ok(locked) => locked,
        Err(refused) => return Ok(Err(refused)),
    };
    if action == PinAction::Pinned && locked.is_deleted() {
        return Ok(Err(InteractionRefused::PinDeleted));
    }

    let mut pinned_entry = None;
    let changed = match action {
        PinAction::Pinned => {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
                .bind(format!("message_pin:{}", locked.channel_id))
                .execute(&mut *conn)
                .await?;

            let existing: Option<i32> =
                sqlx::query_scalar("SELECT 1 FROM message_pin WHERE message_id = $1 LIMIT 1")
                    .bind(message_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            if existing.is_some() {
                false
            } else {
                let count: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM message_pin WHERE channel_id = $1")
                        .bind(locked.channel_id)
                        .fetch_one(&mut *conn)
                        .await?;
                if count >= CHANNEL_PIN_LIMIT {
                    return Ok(Err(InteractionRefused::PinLimit));
                }
                let sql = format!(
                    "WITH inserted AS ( \
                       INSERT INTO message_pin (workspace_id, channel_id, message_id, pinned_by) \
                       VALUES ($1, $2, $3, $4) \
                       ON CONFLICT (message_id) DO NOTHING \
                       RETURNING message_id, channel_id, pinned_by, pinned_at \
                     ) \
                     SELECT {PIN_COLS} FROM inserted p JOIN message m ON m.id = p.message_id"
                );
                let row = sqlx::query(&sql)
                    .bind(workspace_id)
                    .bind(locked.channel_id)
                    .bind(message_id)
                    .bind(member_id)
                    .fetch_optional(&mut *conn)
                    .await?;
                match row {
                    Some(row) => {
                        pinned_entry = Some(decode_pin(&row)?);
                        true
                    }
                    None => false,
                }
            }
        }
        PinAction::Unpinned => {
            let removed: Option<Uuid> =
                sqlx::query_scalar("DELETE FROM message_pin WHERE message_id = $1 RETURNING id")
                    .bind(message_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            removed.is_some()
        }
    };

    let delta = PinDelta {
        action,
        message_id,
        channel_id: locked.channel_id,
        seq: locked.seq,
        changed,
        pinned: pinned_entry,
    };
    if changed {
        let payload = build_pin_payload(workspace_id, &delta);
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &payload,
            Some(locked.channel_id),
        )
        .await?;
    }
    Ok(Ok(delta))
}

/// `GET …/channels/{ch}/pins` — a channel's pin list, newest pin first.
///
/// Membership is the caller's gate (the route runs it in the same transaction),
/// matching every other channel-scoped read in this crate.
///
/// Tombstones are excluded for the same reason the reaction snapshot excludes
/// them: the delete path sweeps the pin, so a surviving row is a leftover, and
/// drawing it would put a header entry on text nobody can read.
///
/// `pinned_at DESC` — the order the channel index is built on, and the one a
/// header list wants: the thing someone just pinned is the thing being talked
/// about.
pub async fn channel_pins(
    conn: &mut PgConnection,
    channel_id: Uuid,
) -> Result<Vec<PinnedMessage>, DbError> {
    let sql = format!(
        "SELECT {PIN_COLS} \
           FROM message_pin p \
           JOIN message m ON m.id = p.message_id \
          WHERE p.channel_id = $1 \
            AND m.deleted_at IS NULL \
            AND m.state <> 'deleted' \
          ORDER BY p.pinned_at DESC, p.message_id"
    );
    let rows = sqlx::query(&sql)
        .bind(channel_id)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| decode_pin(row).map_err(DbError::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(seq: i64) -> StoredMessage {
        StoredMessage {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            seq,
            hlc_ts: 1_700_000_000_000,
            hlc_count: 0,
            author_member_id: Uuid::from_u128(5),
            message_type: crate::message::MessageType::Text,
            state: "edited".into(),
            body: Some("after".into()),
            props: Value::Object(Map::new()),
            root_id: None,
            reply_to_id: Some(Uuid::from_u128(9)),
            created_at: DateTime::from_timestamp_millis(1_700_000_000_000).expect("timestamp"),
            edited_at: DateTime::from_timestamp_millis(1_700_000_777_000),
            deleted_at: None,
        }
    }

    fn projection(seq: i64) -> InteractionMessage {
        InteractionMessage {
            message: stored(seq),
            run_id: None,
            client_msg_id: Some(Uuid::from_u128(9)),
        }
    }

    /// **The invariant this whole module exists under.** Every interaction
    /// broadcast reuses the target's seq — a reaction is not a message and must
    /// not advance any cursor.
    #[test]
    fn every_interaction_broadcast_reuses_the_targets_seq() {
        let workspace = Uuid::from_u128(2);
        let edited = build_message_edited_payload(workspace, &projection(41));
        assert_eq!(edited["data"]["seq"], json!(41));

        let mut deleted_projection = projection(41);
        deleted_projection.message.deleted_at = DateTime::from_timestamp_millis(1_700_000_888_000);
        let deleted = build_message_deleted_payload(workspace, &deleted_projection);
        assert_eq!(deleted["data"]["seq"], json!(41));

        let delta = ReactionDelta {
            action: ReactionAction::Added,
            message_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(5),
            emoji: "👍".into(),
            seq: 41,
            channel_id: Uuid::from_u128(3),
            changed: true,
        };
        assert_eq!(
            build_reaction_payload(workspace, &delta)["data"]["seq"],
            json!(41)
        );
    }

    /// A `version` would be silently dropped by Centrifugo (the target's own
    /// `message.new` already claimed that number), so the edit would never
    /// reach a connected client.
    #[test]
    fn no_interaction_broadcast_carries_a_version() {
        let workspace = Uuid::from_u128(2);
        for payload in [
            build_message_edited_payload(workspace, &projection(7)),
            build_message_deleted_payload(workspace, &projection(7)),
            build_reaction_payload(
                workspace,
                &ReactionDelta {
                    action: ReactionAction::Removed,
                    message_id: Uuid::from_u128(1),
                    member_id: Uuid::from_u128(5),
                    emoji: "🎉".into(),
                    seq: 7,
                    channel_id: Uuid::from_u128(3),
                    changed: true,
                },
            ),
        ] {
            assert!(
                payload.get("version").is_none(),
                "a versioned interaction publish is dropped by Centrifugo: {payload}"
            );
            assert!(
                payload["idempotency_key"].as_str().is_some(),
                "idempotency rides on the key alone: {payload}"
            );
        }
    }

    /// A tombstone must not put the erased body back on the wire.
    #[test]
    fn the_delete_payload_carries_only_the_id() {
        let payload = build_message_deleted_payload(Uuid::from_u128(2), &projection(3));
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["message_id"], json!(Uuid::from_u128(1)));
        assert_eq!(
            inner.as_object().expect("object").len(),
            1,
            "the deleted body must not travel with its own tombstone: {inner}"
        );
    }

    /// `message.edited` keeps `props` even when empty — an omitted `props` on an
    /// edit is indistinguishable from an edit that cleared them.
    #[test]
    fn the_edit_payload_always_carries_props() {
        let payload = build_message_edited_payload(Uuid::from_u128(2), &projection(3));
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["props"], json!({}));
        assert_eq!(inner["state"], json!("edited"));
        assert_eq!(inner["body"], json!("after"));
        assert_eq!(inner["edited_at_ms"], json!(1_700_000_777_000_i64));
        assert_eq!(inner["deleted_at_ms"], Value::Null);
        assert_eq!(
            payload["data"]["ts"],
            json!(1_700_000_777_000_i64),
            "ts is the edit's own instant, not the original hlc"
        );
    }

    /// Swift builds the reaction ids from `UUID.uuidString`, which is uppercase,
    /// unlike every `id::text` elsewhere in the API. Reproduced deliberately —
    /// see [`ReactionDelta::message_id_wire`].
    #[test]
    fn reaction_ids_are_uppercase_like_swifts_uuidstring() {
        let delta = ReactionDelta {
            action: ReactionAction::Added,
            message_id: Uuid::from_u128(0x1234_5678_9abc_def0),
            member_id: Uuid::from_u128(0x0fed_cba9_8765_4321),
            emoji: "✅".into(),
            seq: 1,
            channel_id: Uuid::from_u128(3),
            changed: true,
        };
        let wire = delta.message_id_wire();
        assert_eq!(wire, wire.to_uppercase());
        assert_eq!(wire, delta.message_id.to_string().to_uppercase());
        let payload = build_reaction_payload(Uuid::from_u128(2), &delta);
        assert_eq!(payload["data"]["type"], json!("reaction.added"));
        assert_eq!(payload["data"]["payload"]["action"], json!("added"));
        assert_eq!(payload["data"]["payload"]["message_id"], json!(wire));
        assert_eq!(payload["data"]["payload"]["emoji"], json!("✅"));
    }

    /// The Centrifugo channel string is the one Swift publishes on, uppercase
    /// on both halves, or the relay fans the edit out to nobody.
    #[test]
    fn the_broadcast_channel_matches_the_message_channel() {
        let workspace = Uuid::from_u128(2);
        let payload = build_message_edited_payload(workspace, &projection(3));
        assert_eq!(
            payload["channel"],
            json!(cent_channel(workspace, Uuid::from_u128(3)))
        );
        assert!(payload["idempotency_key"]
            .as_str()
            .expect("key")
            .contains(":message.edited:"));
    }

    #[test]
    fn emoji_validation_matches_swift_and_adds_the_control_char_rule() {
        assert_eq!(validate_reaction_emoji("👍"), Ok("👍"));
        // Untrimmed on the way through: Swift stores the raw segment.
        assert_eq!(validate_reaction_emoji(" 👍"), Ok(" 👍"));
        assert_eq!(validate_reaction_emoji(":shipit:"), Ok(":shipit:"));

        assert_eq!(
            validate_reaction_emoji(""),
            Err(ReactionEmojiInvalid::Empty)
        );
        assert_eq!(
            validate_reaction_emoji("   "),
            Err(ReactionEmojiInvalid::Empty)
        );
        assert_eq!(
            validate_reaction_emoji(&"a".repeat(33)),
            Err(ReactionEmojiInvalid::TooLong)
        );
        assert_eq!(
            validate_reaction_emoji(&"a".repeat(32)),
            Ok("a".repeat(32).as_str())
        );
        // Additive to Swift, and a strict narrowing.
        assert_eq!(
            validate_reaction_emoji("\u{7}"),
            Err(ReactionEmojiInvalid::ControlCharacter)
        );
        assert_eq!(
            validate_reaction_emoji("👍\n"),
            Err(ReactionEmojiInvalid::ControlCharacter)
        );
    }

    /// Both columns are written on a delete and either alone is a
    /// half-tombstone, so both must read as deleted.
    #[test]
    fn a_message_is_deleted_by_either_half_of_the_tombstone() {
        let base = LockedMessage {
            channel_id: Uuid::from_u128(3),
            author_member_id: Uuid::from_u128(5),
            seq: 1,
            state: "sent".into(),
            deleted_at: None,
        };
        assert!(!base.is_deleted());
        assert!(LockedMessage {
            state: "deleted".into(),
            ..base.clone()
        }
        .is_deleted());
        assert!(LockedMessage {
            deleted_at: DateTime::from_timestamp_millis(1),
            ..base
        }
        .is_deleted());
    }

    /// Each refusal keeps its own sentence: "you may not edit this" and "this is
    /// deleted" are different problems with different fixes.
    #[test]
    fn every_refusal_has_its_own_sentence() {
        let sentences: Vec<String> = [
            InteractionRefused::NotFound,
            InteractionRefused::NotAMember,
            InteractionRefused::NotAuthorForEdit,
            InteractionRefused::NotAuthorForDelete,
            InteractionRefused::EditDeleted,
            InteractionRefused::ReactDeleted,
            InteractionRefused::ReactionLimit,
            InteractionRefused::EmptyBody,
        ]
        .into_iter()
        .map(|refused| refused.to_string())
        .collect();
        let mut unique = sentences.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), sentences.len(), "{sentences:?}");
        // The wordings a shipped client may already match on.
        assert_eq!(
            InteractionRefused::NotAMember.to_string(),
            "not a member of this channel"
        );
        assert_eq!(
            InteractionRefused::NotFound.to_string(),
            "message not found"
        );
    }
}
