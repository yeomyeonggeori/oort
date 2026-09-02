//! Read state — the per-(channel, member) read cursor, unread arithmetic, and
//! the mention ledger that feeds it (ADR-0109, B1.2).
//!
//! Ports Swift `ReadStateRoutes.swift` (:22-215) and `ReadStateMentions.swift`
//! (:18-150).
//!
//! ## The cursor is a `seq`, never a clock
//!
//! `read_state.last_read_seq` is a `message.seq` — the same gapless per-channel
//! counter [`crate::message`] hands out — and unread is the *arithmetic*
//! `latest_seq - last_read_seq`. That is the whole design:
//!
//! * `seq` is dense and monotone per channel, so a subtraction is an exact
//!   count. A timestamp cursor cannot count anything without a second query, and
//!   would miscount whenever two messages share a millisecond.
//! * Clocks move backwards (NTP, DST, a client's wall clock). A cursor that
//!   moved backwards would resurrect read messages as unread.
//! * The cursor is clamped to `[current, latest]` and merged with `GREATEST`,
//!   so a stale client cannot rewind a cursor another device already advanced.
//!
//! `d2_b12_2_read_cursor_is_seq_based` in the conformance suite is the red test
//! for exactly this: swap the cursor for a clock and it fails.
//!
//! ## Mentions
//!
//! [`record_mentions_in_tx`] runs in the **same transaction as the message
//! insert** (Swift `MessageRoutes.swift:187`), writing the parsed member ids to
//! the server-owned `message.props.mention_member_ids` and bumping
//! `read_state.mention_count` for each recipient whose cursor is behind the new
//! message. Storing ids (not handles) is what keeps a past mention correct after
//! someone renames themselves.
//!
//! ADR-0148 routes **quotes** through this same pass rather than adding a
//! notification kind beside it: the quoted message's author is appended to the
//! same recipient set an `@handle` produces, so every downstream consumer
//! (badge recount, push judgment) keeps working without being told that
//! quoting exists. See [`record_mentions_in_tx`].
//!
//! **Uppercase is a wire contract, not a style choice.** Swift writes
//! `UUID.uuidString`, which Foundation renders uppercase, into
//! `props.mention_member_ids`, and its recount matches with the same uppercase
//! rendering. Rust's `Uuid::to_string()` is lowercase, so every id this module
//! puts in — or looks for in — that array is explicitly uppercased. Get this
//! wrong and the two servers each count only their own mentions on rows the
//! other wrote (see [`mention_id_token`]).

use chrono::Utc;
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The server-owned `message.props` key holding the save-time mention decision.
/// A client may never supply it (the route strips it before persisting).
pub const MENTION_PROPS_KEY: &str = "mention_member_ids";

/// One channel's read state for one member (Swift `ReadStateDTO`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadState {
    pub channel_id: Uuid,
    pub last_read_seq: i64,
    /// The channel's current head (`channel_seq.last_seq`).
    pub latest_seq: i64,
    pub unread_count: i64,
    pub mention_count: i32,
    /// ADR-0178 D2 mark-unread signal: "unread from this seq onward", or
    /// `None` when the member has left no mark.
    ///
    /// Deliberately **raw**. The server does not fold this into
    /// `unread_count`, and no consumer here composes it with the cursor: D3
    /// puts the composition `min(mark, last_read + 1)` in exactly one
    /// `momo-core` function so that badge, divider, pill and ⌥↑↓ navigation
    /// cannot drift apart by each doing their own arithmetic.
    pub marked_unread_before_seq: Option<i64>,
}

/// Why a read-state advertisement was sent (ADR-0178 D4).
///
/// ## This enum exists because the seq alone cannot tell you
///
/// Before it, `PUT read-state` carried one integer, and three different events
/// produced byte-identical requests: the reader **opening** the channel, a
/// message **arriving** while it stayed open, and a client **flushing** a
/// coalesced cursor on its way out (including the phone's
/// `AppState != active` flush). D4 needs the first to clear a mark and the
/// other two to leave it alone, so the intent has to be *stated*, not inferred.
///
/// Every seq-derived guess was tried and each one breaks a red proof:
///
/// * *"clear when the cursor advanced"* — re-opening a channel whose head has
///   not moved does not advance, so the mark would survive an explicit read;
///   and a message arriving while the channel is open does advance, so the
///   mark would die on arrival.
/// * *"clear when the advertised seq is at or past the mark"* — D3's
///   composition only does work when `mark <= last_read_seq`, so *every* device
///   replaying its own cursor satisfies this. It clears the mark on exactly the
///   stale re-advertisement D4 exists to survive.
///
/// [`ReadIntent::Background`] is the [`Default`] on purpose: an older client
/// (or the retiring Swift server) that has never heard of this field sends
/// nothing, and a mark that lingers is something the reader can undo, while a
/// mark that vanishes silently is the multi-device bug the whole ADR is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReadIntent {
    /// The interaction that *is* viewing the channel: opening it, switching to
    /// it, or pressing an explicit "mark read". Clears the mark (D4).
    ExplicitOpen,
    /// Everything else — auto-advance on arrival, coalesced flush on leave,
    /// app-background transitions, another device replaying its cursor. Never
    /// touches the mark.
    #[default]
    Background,
}

/// What a read-state write does to `marked_unread_before_seq`.
///
/// There is no `Clear` variant, and that is ADR-0178 D5 in the type system:
/// "해제는 별도 동사 없이 D4의 열람 경로가 수행" — the only way to drop a mark is
/// to actually read the channel. A caller cannot spell "unmark" directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MarkUnreadWrite {
    /// Leave the mark exactly as it is.
    #[default]
    Leave,
    /// Set the mark to this seq. Validated against the channel first: a seq
    /// that is in the future, or that never existed here, is rejected rather
    /// than stored (D5).
    Set(i64),
}

/// The three ways a read-state write can end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadCursorOutcome {
    Updated(ReadCursorUpdate),
    /// Not a live member of the channel — Swift's 403. An authorization
    /// outcome, not a failure, so it must not roll the transaction back.
    NotAMember,
    /// [`MarkUnreadWrite::Set`] named a seq this channel has never handed out
    /// (or has not reached yet) — a 400. Returned **before any write**, so the
    /// rejected request leaves nothing behind.
    MarkSeqNotInChannel(i64),
}

/// Outcome of [`update_read_cursor_in_tx`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadCursorUpdate {
    pub state: ReadState,
    /// `true` when this call moved the cursor forward. A mark-only write still
    /// emits a broadcast (`outbox_id` is Some) even when this is false — marking
    /// unread behind an already-advanced cursor is the normal case.
    pub advanced: bool,
    /// The `outbox.id` of the emitted read-state broadcast, or `None` when
    /// neither the cursor nor the mark changed.
    pub outbox_id: Option<i64>,
}

/// The cursor a write actually lands on: never behind where it already is,
/// never ahead of the channel (Swift `ReadStateRoutes.effectiveCursor`).
///
/// The `min(requested, latest)` half is what makes "the client sent a
/// timestamp" harmless-but-visible: the value is clamped to the head instead of
/// being stored as a seq from the future that would hide every later message.
pub fn effective_cursor(current: i64, requested: i64, latest: i64) -> i64 {
    current.max(requested.min(latest))
}

/// Unread = the seq distance to the head, floored at zero (Swift `unreadCount`).
pub fn unread_count(latest: i64, last_read: i64) -> i64 {
    (latest - last_read).max(0)
}

/// The per-member realtime channel a read-state update is published on
/// (Swift `ReadStateRoutes.personalChannel`). Uppercase to match Foundation's
/// `UUID.uuidString`, exactly like [`crate::message::cent_channel`].
pub fn read_state_channel(member_id: Uuid) -> String {
    format!("user:read-state#{}", member_id.to_string().to_uppercase())
}

/// How a member id appears inside `props.mention_member_ids` — Foundation's
/// uppercase `UUID.uuidString`. Both the writer and the recount use this, so the
/// two servers agree on rows either of them wrote.
pub fn mention_id_token(member_id: Uuid) -> String {
    member_id.to_string().to_uppercase()
}

/// Build the `outbox.payload` for a read-state update, matching Swift
/// `ReadStateRoutes.broadcastPayload` (:233-263). No `version` key — a read
/// cursor is not an ordered channel event; its idempotency key carries the seq.
pub fn build_read_state_payload(
    workspace_id: Uuid,
    member_id: Uuid,
    state: &ReadState,
    timestamp_ms: i64,
) -> Value {
    let channel = read_state_channel(member_id);
    let channel_id = state.channel_id.to_string().to_uppercase();
    let data = json!({
        "type": "read_state",
        "v": 1,
        "ts": timestamp_ms,
        "payload": {
            "workspace_id": workspace_id.to_string().to_uppercase(),
            "member_id": member_id.to_string().to_uppercase(),
            "channel_id": channel_id,
            "last_read_seq": state.last_read_seq,
            "latest_seq": state.latest_seq,
            "unread_count": state.unread_count,
            "mention_count": state.mention_count,
            // ADR-0178: the realtime projection carries the same fields the GET
            // projection does. Omitting the mark here would let a second device
            // apply a read-state frame that silently un-marks the channel on
            // that surface until the next full fetch disagreed with it.
            "marked_unread_before_seq": state.marked_unread_before_seq,
        },
    });
    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data,
        version: None,
        // The mark is part of the key because a mark can change while the
        // cursor does not (marking unread behind an already-advanced cursor is
        // the *normal* case). Keyed on the seq alone, that frame would collide
        // with the previous one and be deduped away.
        idempotency_key: Some(format!(
            "{channel}:{channel_id}:{}:{}",
            state.last_read_seq,
            match state.marked_unread_before_seq {
                Some(seq) => seq.to_string(),
                None => "-".to_string(),
            }
        )),
    };
    serde_json::to_value(envelope).expect("read-state payload serializes")
}

fn decode_read_state(row: &sqlx::postgres::PgRow) -> Result<ReadState, sqlx::Error> {
    Ok(ReadState {
        channel_id: row.try_get("channel_id")?,
        last_read_seq: row.try_get("last_read_seq")?,
        latest_seq: row.try_get("latest_seq")?,
        unread_count: row.try_get("unread_count")?,
        mention_count: row.try_get("mention_count")?,
        marked_unread_before_seq: row.try_get("marked_unread_before_seq")?,
    })
}

/// Every channel the member is in, with its cursor, head, unread and mention
/// counts (Swift `ReadStateRoutes.list`, :35-62).
///
/// A channel with no `read_state` row reads as cursor 0 — i.e. everything
/// unread — rather than being omitted, so a client's first sync is complete.
pub async fn list_read_state(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Vec<ReadState>, DbError> {
    let rows = sqlx::query(
        "SELECT c.id AS channel_id, \
                COALESCE(rs.last_read_seq, 0)::bigint AS last_read_seq, \
                COALESCE(cs.last_seq, 0)::bigint AS latest_seq, \
                GREATEST(COALESCE(cs.last_seq, 0) - COALESCE(rs.last_read_seq, 0), 0)::bigint \
                  AS unread_count, \
                COALESCE(rs.mention_count, 0)::int AS mention_count, \
                rs.marked_unread_before_seq \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
           JOIN channel_seq cs \
             ON cs.channel_id = c.id \
            AND cs.workspace_id = $1 \
           LEFT JOIN read_state rs \
             ON rs.channel_id = c.id \
            AND rs.member_id = $2 \
            AND rs.workspace_id = $1 \
          WHERE ms.member_id = $2 \
            AND ms.left_at IS NULL \
          ORDER BY ms.joined_at, c.id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_read_state)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// Advance the caller's read cursor in `channel_id` and re-derive its unread /
/// mention counts, emitting the read-state broadcast in the same transaction.
///
/// Returns `Ok(None)` when the caller is not a live member of the channel
/// (Swift's 403) — an authorization outcome, not a failure, so it must not roll
/// the transaction back.
///
/// This is the pre-ADR-0178 shape, kept because it is the *safe* one: it leaves
/// any mark-unread signal untouched ([`MarkUnreadWrite::Leave`]) and advertises
/// itself as [`ReadIntent::Background`]. Callers that actually know why the
/// cursor moved use [`update_read_cursor_with_intent_in_tx`].
pub async fn update_read_cursor_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    requested_last_read_seq: i64,
) -> Result<Option<ReadCursorUpdate>, DbError> {
    match update_read_cursor_with_intent_in_tx(
        conn,
        workspace_id,
        channel_id,
        member_id,
        requested_last_read_seq,
        MarkUnreadWrite::Leave,
        ReadIntent::Background,
    )
    .await?
    {
        ReadCursorOutcome::Updated(update) => Ok(Some(update)),
        ReadCursorOutcome::NotAMember => Ok(None),
        // Unreachable by construction: validation only runs for
        // `MarkUnreadWrite::Set`, which this wrapper never passes.
        ReadCursorOutcome::MarkSeqNotInChannel(seq) => {
            unreachable!("Leave cannot reject a mark seq ({seq})")
        }
    }
}

/// The full ADR-0178 read-state write: advance the cursor, optionally set the
/// mark-unread signal, and — only for an explicit open — clear it.
///
/// The membership row is taken `FOR UPDATE` first: it is the per-(member,
/// channel) serialization key that exists even before a `read_state` row does,
/// which is what stops two concurrent first-writes from both deciding they
/// advanced the cursor and emitting two broadcasts.
///
/// ## The three writes, and why they are independent
///
/// `last_read_seq` merges with `GREATEST` and never moves backwards (D1). The
/// mark is written by plain assignment and is *not* part of that merge — that
/// independence is the entire mechanism: a stale device replaying an old cursor
/// loses the `GREATEST` race, and because it carries no mark instruction and no
/// explicit-open intent, it also leaves the mark exactly where it was.
///
/// When a request both sets a mark and claims an explicit open, **the set
/// wins.** Setting a mark is a thing a person just did on purpose; clearing is
/// an inference drawn from their having opened the channel. The deliberate act
/// outranks the inference.
#[allow(clippy::too_many_arguments)]
pub async fn update_read_cursor_with_intent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    requested_last_read_seq: i64,
    mark: MarkUnreadWrite,
    intent: ReadIntent,
) -> Result<ReadCursorOutcome, DbError> {
    let head_row = sqlx::query(
        "SELECT cs.last_seq \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
           JOIN channel_seq cs \
             ON cs.channel_id = c.id \
            AND cs.workspace_id = $1 \
          WHERE ms.channel_id = $2 \
            AND ms.member_id = $3 \
            AND ms.left_at IS NULL \
          LIMIT 1 \
          FOR UPDATE OF ms",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(head_row) = head_row else {
        return Ok(ReadCursorOutcome::NotAMember);
    };
    let latest_seq: i64 = head_row.try_get("last_seq").map_err(DbError::from)?;
    let bounded = effective_cursor(0, requested_last_read_seq, latest_seq);

    // D5 validation runs BEFORE the first write, so a rejected mark leaves the
    // cursor untouched too. One `EXISTS` covers both refusals the ADR names:
    // a future seq has no row yet, and a seq this channel never handed out has
    // no row at all. Soft-deleted messages still count — the seq was really
    // issued here, it is a real position in the ordering, and refusing it would
    // turn "someone deleted the message you marked from" into a 400 on a
    // boundary the reader legitimately chose.
    if let MarkUnreadWrite::Set(seq) = mark {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS ( \
               SELECT 1 FROM message \
                WHERE channel_id = $1 AND seq = $2 \
             )",
        )
        .bind(channel_id)
        .bind(seq)
        .fetch_one(&mut *conn)
        .await?;
        if !exists {
            return Ok(ReadCursorOutcome::MarkSeqNotInChannel(seq));
        }
    }

    let previous = sqlx::query(
        "SELECT last_read_seq, marked_unread_before_seq FROM read_state \
          WHERE channel_id = $1 AND member_id = $2 \
          FOR UPDATE",
    )
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let (previous_seq, previous_mark): (i64, Option<i64>) = match previous {
        Some(row) => (
            row.try_get("last_read_seq").map_err(DbError::from)?,
            row.try_get("marked_unread_before_seq")
                .map_err(DbError::from)?,
        ),
        None => (0, None),
    };

    // What this write means for the mark. Note the third arm: `Leave` +
    // `Background` is the overwhelmingly common request and it must be a no-op
    // on this column no matter what seq it carries.
    let next_mark: Option<i64> = match (mark, intent) {
        (MarkUnreadWrite::Set(seq), _) => Some(seq),
        (MarkUnreadWrite::Leave, ReadIntent::ExplicitOpen) => None,
        (MarkUnreadWrite::Leave, ReadIntent::Background) => previous_mark,
    };

    let effective_seq: i64 = sqlx::query_scalar(
        "INSERT INTO read_state \
           (workspace_id, channel_id, member_id, last_read_seq, \
            last_read_at, mention_count, updated_at, marked_unread_before_seq) \
         VALUES ($1, $2, $3, $4, now(), 0, now(), $5) \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET last_read_seq = GREATEST(read_state.last_read_seq, EXCLUDED.last_read_seq), \
                last_read_at = CASE \
                  WHEN EXCLUDED.last_read_seq > read_state.last_read_seq THEN now() \
                  ELSE read_state.last_read_at END, \
                updated_at = CASE \
                  WHEN EXCLUDED.last_read_seq > read_state.last_read_seq \
                    OR EXCLUDED.marked_unread_before_seq IS DISTINCT FROM \
                       read_state.marked_unread_before_seq THEN now() \
                  ELSE read_state.updated_at END, \
                marked_unread_before_seq = EXCLUDED.marked_unread_before_seq \
         RETURNING last_read_seq",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .bind(bounded)
    .bind(next_mark)
    .fetch_one(&mut *conn)
    .await?;

    // Re-derive rather than decrement: the count is "mentions still ahead of my
    // cursor", so recomputing it from the messages themselves cannot drift the
    // way a running total can. `jsonb_exists(x, y)` is the function spelling of
    // the `x ? y` operator Swift uses — identical semantics, no `?` in a string
    // that also carries bind placeholders.
    let mention_count: i32 = sqlx::query_scalar(
        "SELECT count(*)::int \
           FROM message \
          WHERE channel_id = $1 \
            AND seq > $2 \
            AND deleted_at IS NULL \
            AND jsonb_typeof(props->'mention_member_ids') = 'array' \
            AND jsonb_exists(props->'mention_member_ids', $3)",
    )
    .bind(channel_id)
    .bind(effective_seq)
    .bind(mention_id_token(member_id))
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query(
        "UPDATE read_state SET mention_count = $1 \
          WHERE channel_id = $2 AND member_id = $3",
    )
    .bind(mention_count)
    .bind(channel_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;

    let state = ReadState {
        channel_id,
        last_read_seq: effective_seq,
        latest_seq,
        unread_count: unread_count(latest_seq, effective_seq),
        mention_count,
        marked_unread_before_seq: next_mark,
    };

    let advanced = effective_seq > previous_seq;
    // A mark change is worth publishing even when the cursor stood still: it is
    // precisely the case where another device is showing a stale surface.
    let mark_changed = next_mark != previous_mark;
    let outbox_id = if advanced || mark_changed {
        let payload = build_read_state_payload(
            workspace_id,
            member_id,
            &state,
            Utc::now().timestamp_millis(),
        );
        Some(
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::Broadcast,
                "publish",
                &payload,
                Some(member_id),
            )
            .await?,
        )
    } else {
        None
    };

    Ok(ReadCursorOutcome::Updated(ReadCursorUpdate {
        state,
        advanced,
        outbox_id,
    }))
}

/// Record the server's mention decision for a just-inserted message.
///
/// Returns the mentioned member ids (empty when the body mentions nobody). Two
/// writes, both in the caller's transaction:
///   1. `message.props.mention_member_ids` — ids, so a later rename cannot
///      un-mention someone;
///   2. `read_state.mention_count` +1 for each recipient whose cursor is still
///      behind this message (a member who has already read past it is not
///      notified about it).
///
/// Candidates are the channel's live members **except the author** — Swift's
/// `m.id <> author` — so nobody can raise their own badge.
///
/// ## Quoting is naming (ADR-0148 규칙 5)
///
/// `reply_to_id` widens the recipient set by exactly one member: the quoted
/// message's author. It does **not** open a second ledger, a second props key
/// or a second push reason — the quoted author lands in the very same
/// `mention_member_ids` array, so `momo_push::judge_targets` reports `mention`
/// and `update_read_cursor_in_tx` clears the badge without either of them
/// learning that quotes exist. That is the whole point of routing it here: a
/// notification kind is a thing every consumer must be taught, and this one
/// needed teaching nowhere.
///
/// The quoted author still has to clear the same three bars an `@handle`
/// recipient does — an active member, still in the channel, and not the author
/// — because they are read from the same candidate query. Quoting yourself
/// therefore notifies nobody, exactly like mentioning yourself.
#[allow(clippy::too_many_arguments)]
pub async fn record_mentions_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    message_seq: i64,
    author_member_id: Uuid,
    body: Option<&str>,
    reply_to_id: Option<Uuid>,
) -> Result<Vec<Uuid>, DbError> {
    let body = body.filter(|text| !text.is_empty());

    // Resolved before the candidate scan so the loop below stays a single pass.
    // The channel predicate is 규칙 2 restated: a target outside this channel
    // (or outside this tenant, which RLS already hid) names nobody.
    let quoted_author: Option<Uuid> = match reply_to_id {
        Some(reply_to_id) => {
            sqlx::query_scalar(
                "SELECT author_member_id FROM message \
              WHERE id = $1 AND channel_id = $2 \
              LIMIT 1",
            )
            .bind(reply_to_id)
            .bind(channel_id)
            .fetch_optional(&mut *conn)
            .await?
        }
        None => None,
    };

    // A quote with an empty body still names someone, so the early exit tests
    // both inputs rather than the body alone.
    if body.is_none() && quoted_author.is_none() {
        return Ok(Vec::new());
    }

    let rows = sqlx::query(
        "SELECT m.id, m.handle, m.display_name \
           FROM membership ms \
           JOIN member m \
             ON m.id = ms.member_id \
            AND m.workspace_id = $1 \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          WHERE ms.channel_id = $2 \
            AND ms.left_at IS NULL \
            AND m.id <> $3 \
          ORDER BY m.id",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(author_member_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut recipients: Vec<Uuid> = Vec::new();
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(DbError::from)?;
        let handle: String = row.try_get("handle").map_err(DbError::from)?;
        let display_name: String = row.try_get("display_name").map_err(DbError::from)?;
        let named_in_body =
            body.is_some_and(|body| contains_mention(body, &handle, &display_name, id));
        // `||` rather than a second pass: a message that both quotes someone and
        // `@`s them names them once. The list feeds a jsonb array the recount
        // asks membership questions of, and a duplicate id there would let one
        // utterance raise two badges.
        if named_in_body || quoted_author == Some(id) {
            recipients.push(id);
        }
    }
    if recipients.is_empty() {
        return Ok(Vec::new());
    }

    let tokens: Vec<String> = recipients.iter().copied().map(mention_id_token).collect();
    sqlx::query(
        "UPDATE message \
            SET props = jsonb_set(COALESCE(props, '{}'::jsonb), '{mention_member_ids}', \
                                  to_jsonb($1::text[]), true) \
          WHERE id = $2 AND workspace_id = $3 AND channel_id = $4",
    )
    .bind(&tokens)
    .bind(message_id)
    .bind(workspace_id)
    .bind(channel_id)
    .execute(&mut *conn)
    .await?;

    sqlx::query(
        "INSERT INTO read_state \
           (workspace_id, channel_id, member_id, last_read_seq, \
            last_read_at, mention_count, updated_at) \
         SELECT $1, $2, mentioned.member_id, 0, now(), 1, now() \
           FROM unnest($3::uuid[]) AS mentioned(member_id) \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET mention_count = read_state.mention_count \
                  + CASE WHEN read_state.last_read_seq < $4 THEN 1 ELSE 0 END, \
                updated_at = CASE \
                  WHEN read_state.last_read_seq < $4 THEN now() \
                  ELSE read_state.updated_at END",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(&recipients)
    .bind(message_seq)
    .execute(&mut *conn)
    .await?;

    Ok(recipients)
}

/// Whether `text` mentions the member (Swift `ReadStateMentions.containsMention`).
///
/// Three spellings, in Swift's order: `@handle` / `<@handle>` (case-insensitive,
/// because handles are), `@Display Name` / `<@Display Name>` (case-**sensitive**,
/// because display names are free text where case carries meaning), and the raw
/// id `<@uuid>` / `@uuid` (case-insensitive).
///
/// A match must end on a boundary, so `@bob` does not fire on `@bobby`. Only the
/// trailing side is checked — matching Swift — which is what lets `hey@bob` and
/// `(@bob)` both count.
pub fn contains_mention(text: &str, handle: &str, display_name: &str, member_id: Uuid) -> bool {
    let trimmed_handle = handle.trim();
    let trimmed_name = display_name.trim();
    let id = member_id.to_string().to_lowercase();

    if !trimmed_handle.is_empty()
        && (contains_mention_token(text, &format!("@{trimmed_handle}"), true)
            || contains_mention_token(text, &format!("<@{trimmed_handle}>"), true))
    {
        return true;
    }
    if !trimmed_name.is_empty()
        && (contains_mention_token(text, &format!("@{trimmed_name}"), false)
            || contains_mention_token(text, &format!("<@{trimmed_name}>"), false))
    {
        return true;
    }
    contains_mention_token(text, &format!("<@{id}>"), true)
        || contains_mention_token(text, &format!("@{id}"), true)
}

fn contains_mention_token(text: &str, marker: &str, case_insensitive: bool) -> bool {
    let haystack = if case_insensitive {
        text.to_lowercase()
    } else {
        text.to_string()
    };
    let needle = if case_insensitive {
        marker.to_lowercase()
    } else {
        marker.to_string()
    };
    if needle.is_empty() {
        return false;
    }

    let mut search_start = 0usize;
    while let Some(offset) = haystack[search_start..].find(&needle) {
        let end = search_start + offset + needle.len();
        match haystack[end..].chars().next() {
            None => return true,
            Some(next) if is_mention_boundary(next) => return true,
            Some(_) => search_start = end,
        }
    }
    false
}

/// Swift's boundary rule: every scalar of the following character must be
/// non-alphanumeric and neither `_` nor `-`.
fn is_mention_boundary(character: char) -> bool {
    !(character.is_alphanumeric() || character == '_' || character == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_never_rewinds_and_never_overruns_the_head() {
        // A stale device replaying an old cursor cannot un-read messages.
        assert_eq!(effective_cursor(7, 3, 10), 7);
        // A client that guesses too high is clamped to the channel head …
        assert_eq!(effective_cursor(0, 999, 10), 10);
        // … including the case that motivates the clamp: a millisecond
        // timestamp sent where a seq belongs.
        assert_eq!(effective_cursor(0, 1_764_547_200_000, 10), 10);
        assert_eq!(effective_cursor(2, 5, 10), 5);
    }

    #[test]
    fn unread_is_seq_arithmetic_floored_at_zero() {
        assert_eq!(unread_count(10, 4), 6);
        assert_eq!(unread_count(10, 10), 0);
        // Cursor ahead of the head (possible only if a clock ever wrote it)
        // must not report a negative badge.
        assert_eq!(unread_count(10, 12), 0);
    }

    /// The two servers must produce byte-identical ids in `mention_member_ids`;
    /// Foundation renders uppercase, Rust lowercase by default.
    #[test]
    fn mention_ids_are_uppercase_like_foundation() {
        let id = Uuid::from_u128(0x1234_5678_9abc_def0_1234_5678_9abc_def0);
        let token = mention_id_token(id);
        assert_eq!(token, id.to_string().to_uppercase());
        assert_ne!(
            token,
            id.to_string(),
            "lowercase would not match Swift rows"
        );
        assert!(read_state_channel(id).ends_with(&token));
        assert!(read_state_channel(id).starts_with("user:read-state#"));
    }

    #[test]
    fn the_read_state_payload_matches_the_swift_envelope() {
        let ws = Uuid::from_u128(1);
        let member = Uuid::from_u128(2);
        let state = ReadState {
            channel_id: Uuid::from_u128(3),
            last_read_seq: 5,
            latest_seq: 9,
            unread_count: 4,
            mention_count: 2,
            marked_unread_before_seq: None,
        };
        let payload = build_read_state_payload(ws, member, &state, 1234);

        assert_eq!(payload["channel"], json!(read_state_channel(member)));
        assert_eq!(payload["data"]["type"], json!("read_state"));
        assert_eq!(payload["data"]["v"], json!(1));
        assert_eq!(payload["data"]["ts"], json!(1234));
        let inner = &payload["data"]["payload"];
        assert_eq!(inner["last_read_seq"], json!(5));
        assert_eq!(inner["latest_seq"], json!(9));
        assert_eq!(inner["unread_count"], json!(4));
        assert_eq!(inner["mention_count"], json!(2));
        assert!(
            inner.get("marked_unread_before_seq").is_some(),
            "the realtime projection carries the mark key: {inner}"
        );
        assert!(inner["marked_unread_before_seq"].is_null());
        assert_eq!(
            inner["channel_id"],
            json!(state.channel_id.to_string().to_uppercase())
        );
        assert_eq!(
            payload["idempotency_key"],
            json!(format!(
                "{}:{}:5:-",
                read_state_channel(member),
                state.channel_id.to_string().to_uppercase()
            ))
        );
        // A read cursor is not an ordered channel event — Swift emits no
        // `version`, and BroadcastPayload omits a None.
        assert!(payload.get("version").is_none());
    }

    #[test]
    fn a_mark_change_gets_its_own_idempotency_key() {
        let ws = Uuid::from_u128(1);
        let member = Uuid::from_u128(2);
        let unmarked = ReadState {
            channel_id: Uuid::from_u128(3),
            last_read_seq: 5,
            latest_seq: 9,
            unread_count: 4,
            mention_count: 0,
            marked_unread_before_seq: None,
        };
        let marked = ReadState {
            marked_unread_before_seq: Some(3),
            ..unmarked.clone()
        };
        let without = build_read_state_payload(ws, member, &unmarked, 1);
        let with = build_read_state_payload(ws, member, &marked, 1);
        assert_ne!(
            without["idempotency_key"], with["idempotency_key"],
            "a mark behind an unchanged cursor must not collide with the previous frame"
        );
        assert_eq!(
            with["data"]["payload"]["marked_unread_before_seq"],
            json!(3)
        );
        assert_eq!(
            with["data"]["payload"]["unread_count"],
            json!(4),
            "D3: the server projection does not fold the mark into unread_count"
        );
    }

    #[test]
    fn read_intent_defaults_to_background() {
        assert_eq!(ReadIntent::default(), ReadIntent::Background);
        assert_eq!(MarkUnreadWrite::default(), MarkUnreadWrite::Leave);
    }

    #[test]
    fn a_handle_mention_matches_case_insensitively_on_a_boundary() {
        let id = Uuid::from_u128(4);
        assert!(contains_mention(
            "hey @Bob can you look",
            "bob",
            "Bob Kim",
            id
        ));
        assert!(contains_mention("<@bob> ping", "bob", "Bob Kim", id));
        assert!(contains_mention("ends with @bob", "bob", "Bob Kim", id));
        // Prefix of a longer handle must NOT fire.
        assert!(!contains_mention("hi @bobby", "bob", "Bob Kim", id));
        assert!(!contains_mention("hi @bob-ross", "bob", "Bob Kim", id));
    }

    #[test]
    fn a_display_name_mention_is_case_sensitive() {
        let id = Uuid::from_u128(5);
        assert!(contains_mention("cc @Bob Kim", "zzz", "Bob Kim", id));
        assert!(
            !contains_mention("cc @bob kim", "zzz", "Bob Kim", id),
            "display names are free text; lowercasing them would mention the wrong person"
        );
    }

    #[test]
    fn a_raw_id_mention_matches_either_case() {
        let id = Uuid::from_u128(0xabcd);
        assert!(contains_mention(
            &format!("<@{}>", id.to_string().to_uppercase()),
            "",
            "",
            id
        ));
        assert!(contains_mention(&format!("@{id} hi"), "", "", id));
        assert!(!contains_mention("no mention here", "", "", id));
    }

    /// An empty handle/display name must not turn every `@` into a mention.
    #[test]
    fn empty_identity_fields_never_match() {
        let id = Uuid::from_u128(6);
        assert!(!contains_mention("@ hello", "", "", id));
        assert!(!contains_mention("<@> hello", "   ", "  ", id));
    }
}
