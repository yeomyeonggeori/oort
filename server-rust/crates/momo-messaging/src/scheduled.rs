//! Scheduled messages — every `scheduled_message` statement (ADR-0208, #4214).
//!
//! A scheduled message is a person's own row: they write it now, the server sends it
//! at `send_at` through the canonical send ([`crate::message`]) even when none of
//! their devices is on. This module owns the rows and what happens to them; **it does
//! not send** — the composition that calls the canonical send (membership, thread
//! root, mention → agent run) lives in `momo-server` next to `route_agent_mentions_in_tx`
//! (ADR-0208 D4/D5), and its caller closes the row here.
//!
//! ## Where the invariants live
//!
//! * **Owner-scoped FORCE RLS** (migration 145): a row is visible only to its author,
//!   and every statement here first binds `app.member_id` ([`bind_owner_guc`]). A wrong
//!   binding does not error, it matches **zero rows** — so every transition below
//!   returns `Option<ScheduledMessage>` and its caller treats `None` as the invariant
//!   violation it is.
//! * **Four states, no `sending`** (D7): `pending` → `sent | failed | cancelled`, and a
//!   `failed` row can come back to `pending`. The row's CHECK constraint pins the shape
//!   of each state (a finished row carries no body).
//! * **Every transition leaves an event and an audit row in the same transaction**
//!   (D12, D13): [`record_transition_in_tx`] is the single place that does it, and
//!   neither carries the body.
//! * **The three lifecycle hooks** ([`hold_member_schedules_in_tx`],
//!   [`hold_lineage_schedules_in_tx`], [`cancel_member_schedules_in_tx`]) are the only
//!   functions that bind somebody else's owner scope (D14 point 4; see
//!   [`crate::owner_scope`]).

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use std::collections::HashMap;
use uuid::Uuid;

use crate::attachment::{validate_attachment_id_list, AttachmentLinkRejected, MessageAttachment};
use crate::inbox::inbox_event_payload;
use crate::owner_scope::{bind_foreign_owner_guc, bind_owner_guc, restore_owner_guc};

/// D10 — at most this many `pending` rows per member per workspace.
pub const SCHEDULE_PENDING_LIMIT: i64 = 50;
/// D2 — the earliest a schedule may be set: this long after the server's now.
pub const SCHEDULE_MIN_LEAD_SECONDS: i64 = 60;
/// D2 — the latest: Slack's `chat.scheduleMessage` ceiling.
pub const SCHEDULE_MAX_LEAD_DAYS: i64 = 120;
/// D9 — a `pending` row cannot be edited inside its last 30 seconds.
pub const SCHEDULE_EDIT_LOCK_SECONDS: i64 = 30;
/// D14 — a sent or cancelled row is a body-less tombstone for this long.
pub const SCHEDULE_DONE_RETENTION_DAYS: i32 = 7;
/// D14 — a failed row keeps its body for this long.
pub const SCHEDULE_FAILED_RETENTION_DAYS: i32 = 30;
/// D10 / D11 — a schedule holds at most as many attachments as one message may carry; the cap is
/// the send path's own, so a schedule that was accepted cannot be refused for it when it fires.
pub const SCHEDULE_ATTACHMENT_LIMIT: usize = crate::attachment::MAX_ATTACHMENTS_PER_MESSAGE;

/// The event the author's other devices read (D12). Ids, status and time only.
pub const SCHEDULE_EVENT_TYPE: &str = "scheduled_message.updated";

const SCHEDULE_COLS: &str = "id, workspace_id, channel_id, author_member_id, root_id, body, \
     send_at, status, failure_reason, attempts, next_attempt_at, sent_message_id, sent_at, \
     client_request_id, armed_session_id, rev, created_at, updated_at";

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/// `scheduled_message.status` (D3). There is deliberately no `sending`: the send and the
/// status change are one transaction, so it would never be committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledStatus {
    Pending,
    Sent,
    Failed,
    Cancelled,
}

impl ScheduledStatus {
    pub fn as_db_label(self) -> &'static str {
        match self {
            ScheduledStatus::Pending => "pending",
            ScheduledStatus::Sent => "sent",
            ScheduledStatus::Failed => "failed",
            ScheduledStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "pending" => Some(ScheduledStatus::Pending),
            "sent" => Some(ScheduledStatus::Sent),
            "failed" => Some(ScheduledStatus::Failed),
            "cancelled" => Some(ScheduledStatus::Cancelled),
            _ => None,
        }
    }
}

/// `scheduled_message.failure_reason` — the closed set of D8, owned by the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScheduleFailure {
    /// A sign-in ended (password change/reset, suspension, device unlinked, refresh reuse): held, not sent.
    SessionsEnded,
    /// The author is suspended or removed at send time (the safety net behind the hold).
    AuthorInactive,
    /// The grace window passed without a single attempt.
    Missed,
    /// At least one attempt was made and the grace window passed while errors continued
    /// (or the schedule id collided with another message's `clientMsgId`).
    SendError,
    /// The author left the channel or conversation.
    NotMember,
    /// The thread root is deleted or gone.
    RootUnavailable,
    /// An attachment is missing or was used elsewhere.
    AttachmentUnavailable,
    /// A policy the canonical send adds later.
    NotAllowed,
}

impl ScheduleFailure {
    /// The wire / column value. Also the `error.code` of a refused send-now (409).
    pub fn as_code(self) -> &'static str {
        match self {
            ScheduleFailure::SessionsEnded => "sessions_ended",
            ScheduleFailure::AuthorInactive => "author_inactive",
            ScheduleFailure::Missed => "missed",
            ScheduleFailure::SendError => "send_error",
            ScheduleFailure::NotMember => "not_member",
            ScheduleFailure::RootUnavailable => "root_unavailable",
            ScheduleFailure::AttachmentUnavailable => "attachment_unavailable",
            ScheduleFailure::NotAllowed => "not_allowed",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "sessions_ended" => Some(ScheduleFailure::SessionsEnded),
            "author_inactive" => Some(ScheduleFailure::AuthorInactive),
            "missed" => Some(ScheduleFailure::Missed),
            "send_error" => Some(ScheduleFailure::SendError),
            "not_member" => Some(ScheduleFailure::NotMember),
            "root_unavailable" => Some(ScheduleFailure::RootUnavailable),
            "attachment_unavailable" => Some(ScheduleFailure::AttachmentUnavailable),
            "not_allowed" => Some(ScheduleFailure::NotAllowed),
            _ => None,
        }
    }

    /// Every reason, for a test that wants the whole closed set.
    pub const ALL: [ScheduleFailure; 8] = [
        ScheduleFailure::SessionsEnded,
        ScheduleFailure::AuthorInactive,
        ScheduleFailure::Missed,
        ScheduleFailure::SendError,
        ScheduleFailure::NotMember,
        ScheduleFailure::RootUnavailable,
        ScheduleFailure::AttachmentUnavailable,
        ScheduleFailure::NotAllowed,
    ];
}

/// One `scheduled_message` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledMessage {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    pub root_id: Option<Uuid>,
    /// `None` once the row is sent or cancelled (D14).
    pub body: Option<String>,
    pub send_at: DateTime<Utc>,
    pub status: ScheduledStatus,
    pub failure_reason: Option<ScheduleFailure>,
    pub attempts: i32,
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub sent_message_id: Option<Uuid>,
    pub sent_at: Option<DateTime<Utc>>,
    pub client_request_id: Uuid,
    pub armed_session_id: Option<Uuid>,
    pub rev: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ScheduledMessage {
    pub fn send_at_ms(&self) -> i64 {
        self.send_at.timestamp_millis()
    }

    /// `sendAtMs` minus the 30-second edit lock; a hint for clients, the server decides.
    pub fn editable_until_ms(&self) -> i64 {
        self.send_at_ms() - SCHEDULE_EDIT_LOCK_SECONDS * 1000
    }
}

fn decode_schedule(row: &PgRow) -> Result<ScheduledMessage, sqlx::Error> {
    let status_label: String = row.try_get("status")?;
    let status = ScheduledStatus::from_db_label(&status_label).ok_or_else(|| {
        sqlx::Error::Decode(format!("unknown scheduled_message status '{status_label}'").into())
    })?;
    let failure_reason = match row.try_get::<Option<String>, _>("failure_reason")? {
        None => None,
        Some(code) => Some(ScheduleFailure::from_code(&code).ok_or_else(|| {
            sqlx::Error::Decode(format!("unknown scheduled_message failure_reason '{code}'").into())
        })?),
    };
    Ok(ScheduledMessage {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("channel_id")?,
        author_member_id: row.try_get("author_member_id")?,
        root_id: row.try_get("root_id")?,
        body: row.try_get("body")?,
        send_at: row.try_get("send_at")?,
        status,
        failure_reason,
        attempts: row.try_get("attempts")?,
        next_attempt_at: row.try_get("next_attempt_at")?,
        sent_message_id: row.try_get("sent_message_id")?,
        sent_at: row.try_get("sent_at")?,
        client_request_id: row.try_get("client_request_id")?,
        armed_session_id: row.try_get("armed_session_id")?,
        rev: row.try_get("rev")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// the time window (D2)
// ---------------------------------------------------------------------------

/// Why a requested send time was refused. Both are 400 with a code (`send_at_too_soon` —
/// the past included — and `send_at_too_far`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SendAtInvalid {
    #[error("sendAtMs must be at least 60 seconds from now")]
    TooSoon,
    #[error("sendAtMs must be within 120 days from now")]
    TooFar,
}

impl SendAtInvalid {
    pub fn code(self) -> &'static str {
        match self {
            SendAtInvalid::TooSoon => "send_at_too_soon",
            SendAtInvalid::TooFar => "send_at_too_far",
        }
    }
}

/// `sendAtMs` → a time inside the window `[now + 60 s, now + 120 days]`. `now` is the
/// **database** clock ([`db_now_in_tx`]), injected so a test can freeze it.
pub fn validate_send_at(
    send_at_ms: i64,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, SendAtInvalid> {
    // A value chrono cannot even represent is as far in the past or the future as a
    // value can be.
    let Some(send_at) = DateTime::from_timestamp_millis(send_at_ms) else {
        return Err(if send_at_ms < 0 {
            SendAtInvalid::TooSoon
        } else {
            SendAtInvalid::TooFar
        });
    };
    if send_at < now + chrono::Duration::seconds(SCHEDULE_MIN_LEAD_SECONDS) {
        return Err(SendAtInvalid::TooSoon);
    }
    if send_at > now + chrono::Duration::days(SCHEDULE_MAX_LEAD_DAYS) {
        return Err(SendAtInvalid::TooFar);
    }
    Ok(send_at)
}

/// The database's now. Every comparison of D2/D7/D9 is made against this clock, never a
/// replica's (the replicas' skew is not a thing a schedule may depend on).
pub async fn db_now_in_tx(conn: &mut PgConnection) -> Result<DateTime<Utc>, DbError> {
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *conn)
        .await?;
    Ok(now)
}

/// Whether a `pending` row is inside its last [`SCHEDULE_EDIT_LOCK_SECONDS`] (or past
/// due): an edit is then 409 `scheduled_too_late` (D9).
pub fn is_edit_locked(send_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    send_at <= now + chrono::Duration::seconds(SCHEDULE_EDIT_LOCK_SECONDS)
}

/// The backoff before attempt number `attempts` (1-based, counted **including** the one
/// being scheduled): 5 s · 15 s · 45 s · 2 min · 5 min, then every 5 min (D7).
pub fn backoff_seconds(attempts: i32) -> i64 {
    match attempts {
        i32::MIN..=1 => 5,
        2 => 15,
        3 => 45,
        4 => 120,
        _ => 300,
    }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/// The row a `clientRequestId` already created (D9: the lookup is the first thing a
/// create does, before any validation).
pub async fn find_schedule_by_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    client_request_id: Uuid,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "SELECT {SCHEDULE_COLS} FROM scheduled_message \
          WHERE workspace_id = $1 AND author_member_id = $2 AND client_request_id = $3"
    ))
    .bind(workspace_id)
    .bind(member_id)
    .bind(client_request_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(decode_schedule).transpose()?)
}

/// One of the caller's own rows. `None` for another member's row and for a missing one
/// alike (RLS makes them the same answer).
pub async fn get_own_schedule_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    schedule_id: Uuid,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "SELECT {SCHEDULE_COLS} FROM scheduled_message \
          WHERE id = $1 AND workspace_id = $2 AND author_member_id = $3"
    ))
    .bind(schedule_id)
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(decode_schedule).transpose()?)
}

/// [`get_own_schedule_in_tx`] with the row lock a state change needs (`FOR UPDATE`). A
/// request waits for the scheduler's lock up to the caller's `lock_timeout` (3 s → 409
/// `scheduled_busy`); the scheduler never waits (`SKIP LOCKED`).
pub async fn lock_own_schedule_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    schedule_id: Uuid,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "SELECT {SCHEDULE_COLS} FROM scheduled_message \
          WHERE id = $1 AND workspace_id = $2 AND author_member_id = $3 FOR UPDATE"
    ))
    .bind(schedule_id)
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(decode_schedule).transpose()?)
}

/// `GET …/scheduled-messages?status=` (D3 / openapi): `open` is `pending` plus `failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleListFilter {
    Open,
    Pending,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("status must be open, pending or failed")]
pub struct ScheduleFilterInvalid;

impl ScheduleListFilter {
    pub fn parse(raw: Option<&str>) -> Result<Self, ScheduleFilterInvalid> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("open") => Ok(ScheduleListFilter::Open),
            Some("pending") => Ok(ScheduleListFilter::Pending),
            Some("failed") => Ok(ScheduleListFilter::Failed),
            Some(_) => Err(ScheduleFilterInvalid),
        }
    }

    fn statuses(self) -> Vec<&'static str> {
        match self {
            ScheduleListFilter::Open => vec!["pending", "failed"],
            ScheduleListFilter::Pending => vec!["pending"],
            ScheduleListFilter::Failed => vec!["failed"],
        }
    }
}

pub const SCHEDULE_LIST_LIMIT_DEFAULT: i64 = 50;
pub const SCHEDULE_LIST_LIMIT_MAX: i64 = 100;

pub fn clamp_schedule_list_limit(requested: Option<i64>) -> i64 {
    match requested {
        Some(value) if value > 0 => value.min(SCHEDULE_LIST_LIMIT_MAX),
        _ => SCHEDULE_LIST_LIMIT_DEFAULT,
    }
}

/// The caller's own rows, soonest first, keyset-paged over `(send_at, id)`.
pub async fn list_own_schedules_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    filter: ScheduleListFilter,
    channel_id: Option<Uuid>,
    after: Option<(DateTime<Utc>, Uuid)>,
    limit: i64,
) -> Result<Vec<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let statuses: Vec<String> = filter.statuses().iter().map(|s| s.to_string()).collect();
    let (after_at, after_id) = match after {
        Some((at, id)) => (Some(at), Some(id)),
        None => (None, None),
    };
    let rows = sqlx::query(&format!(
        "SELECT {SCHEDULE_COLS} FROM scheduled_message \
          WHERE workspace_id = $1 AND author_member_id = $2 \
            AND status = ANY($3) \
            AND ($4::uuid IS NULL OR channel_id = $4) \
            AND ($5::timestamptz IS NULL OR (send_at, id) > ($5, $6)) \
          ORDER BY send_at ASC, id ASC \
          LIMIT $7"
    ))
    .bind(workspace_id)
    .bind(member_id)
    .bind(&statuses)
    .bind(channel_id)
    .bind(after_at)
    .bind(after_id)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_schedule)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// The reserved attachments of a page of rows, in the order they were reserved.
pub async fn schedule_attachments_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<MessageAttachment>>, DbError> {
    let mut out: HashMap<Uuid, Vec<MessageAttachment>> = HashMap::new();
    if schedule_ids.is_empty() {
        return Ok(out);
    }
    bind_owner_guc(conn, member_id).await?;
    let rows = sqlx::query(
        "SELECT sa.scheduled_message_id, a.id, a.name, a.mime, a.size_bytes \
           FROM scheduled_message_attachment sa \
           JOIN attachment a ON a.id = sa.attachment_id \
          WHERE sa.scheduled_message_id = ANY($1) \
          ORDER BY sa.scheduled_message_id, sa.position",
    )
    .bind(schedule_ids)
    .fetch_all(&mut *conn)
    .await?;
    for row in &rows {
        let schedule: Uuid = row.try_get("scheduled_message_id")?;
        out.entry(schedule).or_default().push(MessageAttachment {
            id: row.try_get::<Uuid, _>("id")?.to_string(),
            name: row.try_get("name")?,
            mime: row.try_get("mime")?,
            size_bytes: row.try_get("size_bytes")?,
        });
    }
    Ok(out)
}

/// The attachment ids a schedule holds, in reservation order — what the send binds.
pub async fn reserved_attachment_ids_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
) -> Result<Vec<Uuid>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT attachment_id FROM scheduled_message_attachment \
          WHERE scheduled_message_id = $1 ORDER BY position",
    )
    .bind(schedule_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(ids)
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/// Serialize this member's creates and re-arms in this workspace (D10). It is taken
/// **before** the `clientRequestId` lookup, not only before the count: two concurrent
/// retries of one create would otherwise both miss the lookup and one would die on
/// the UNIQUE index instead of answering with the first row.
pub async fn lock_member_schedules_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(format!("scheduled_message:{workspace_id}:{member_id}"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// How many `pending` rows the member holds (the cap of D10 counts nothing else: a
/// `failed` row does not hold a slot).
pub async fn count_pending_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<i64, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM scheduled_message \
          WHERE workspace_id = $1 AND author_member_id = $2 AND status = 'pending'",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count)
}

/// What a create writes.
#[derive(Debug, Clone)]
pub struct NewSchedule {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    pub root_id: Option<Uuid>,
    /// Empty for an attachment-only schedule; never `NULL` while the row is open.
    pub body: String,
    pub send_at: DateTime<Utc>,
    pub client_request_id: Uuid,
    pub armed_session_id: Option<Uuid>,
}

/// Insert the row (`pending`, `rev` 0). The caller has judged the request, taken the
/// member lock and reserved the attachments in this same transaction.
pub async fn insert_schedule_in_tx(
    conn: &mut PgConnection,
    new: &NewSchedule,
) -> Result<ScheduledMessage, DbError> {
    bind_owner_guc(conn, new.author_member_id).await?;
    let row = sqlx::query(&format!(
        "INSERT INTO scheduled_message \
           (workspace_id, channel_id, author_member_id, root_id, body, send_at, \
            client_request_id, armed_session_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         RETURNING {SCHEDULE_COLS}"
    ))
    .bind(new.workspace_id)
    .bind(new.channel_id)
    .bind(new.author_member_id)
    .bind(new.root_id)
    .bind(&new.body)
    .bind(new.send_at)
    .bind(new.client_request_id)
    .bind(new.armed_session_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(decode_schedule(&row)?)
}

/// Why a reservation was refused (D11): the send's own binding rules, plus "another
/// schedule already holds it".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReserveRejected {
    Link(AttachmentLinkRejected),
    Reserved,
}

/// Judge `attachment_ids` with the **same predicates** the canonical binding applies
/// (`link_attachments_in_tx`: complete, uploaded by the author, same channel, not yet on
/// a message, no duplicate, at most 20), then take the reservation. The row lock
/// (`FOR UPDATE`) is the binding's too, so a concurrent REST send that names the same
/// file serializes with this.
///
/// The send re-judges all of it when it fires; this is the early answer, not the
/// authority (D11).
pub async fn reserve_attachments_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    author_member_id: Uuid,
    schedule_id: Uuid,
    attachment_ids: &[Uuid],
) -> Result<Result<(), ReserveRejected>, DbError> {
    if let Err(rejected) = validate_attachment_id_list(attachment_ids) {
        return Ok(Err(ReserveRejected::Link(rejected)));
    }
    bind_owner_guc(conn, author_member_id).await?;
    for (position, attachment_id) in attachment_ids.iter().enumerate() {
        let row = sqlx::query(
            "SELECT status, uploader_member_id, channel_id, message_id \
               FROM attachment WHERE id = $1 FOR UPDATE",
        )
        .bind(attachment_id)
        .fetch_optional(&mut *conn)
        .await?;
        let Some(row) = row else {
            return Ok(Err(ReserveRejected::Link(AttachmentLinkRejected::NotFound)));
        };
        let status: String = row.try_get("status")?;
        let uploader: Uuid = row.try_get("uploader_member_id")?;
        let attachment_channel: Uuid = row.try_get("channel_id")?;
        let linked: Option<Uuid> = row.try_get("message_id")?;
        if status != "complete" {
            return Ok(Err(ReserveRejected::Link(
                AttachmentLinkRejected::NotComplete,
            )));
        }
        if uploader != author_member_id {
            return Ok(Err(ReserveRejected::Link(
                AttachmentLinkRejected::ForeignUploader,
            )));
        }
        if attachment_channel != channel_id {
            return Ok(Err(ReserveRejected::Link(
                AttachmentLinkRejected::ForeignChannel,
            )));
        }
        if linked.is_some() {
            return Ok(Err(ReserveRejected::Link(
                AttachmentLinkRejected::AlreadyLinked,
            )));
        }
        let taken = sqlx::query(
            "INSERT INTO scheduled_message_attachment \
               (scheduled_message_id, workspace_id, member_id, attachment_id, position) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (attachment_id) DO NOTHING",
        )
        .bind(schedule_id)
        .bind(workspace_id)
        .bind(author_member_id)
        .bind(attachment_id)
        .bind(position as i32)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        if taken == 0 {
            return Ok(Err(ReserveRejected::Reserved));
        }
    }
    Ok(Ok(()))
}

// ---------------------------------------------------------------------------
// transitions — each one records its event and its audit row
// ---------------------------------------------------------------------------

/// Who a transition is attributed to in the audit trail (D13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleActor {
    /// A person acting through a request: the audit row names them and the token.
    Member {
        member_id: Uuid,
        via_token_id: Option<Uuid>,
    },
    /// The scheduler or a lifecycle hook: a clock is not a member, so the audit row
    /// has no actor and `about` is the author (`avatar_reclaim.rs` precedent).
    System,
}

/// The five audit verbs of D13.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleAudit {
    Created,
    Updated,
    Cancelled,
    Sent,
    Failed,
}

impl ScheduleAudit {
    pub fn action(self) -> &'static str {
        match self {
            ScheduleAudit::Created => "scheduled_message.created",
            ScheduleAudit::Updated => "scheduled_message.updated",
            ScheduleAudit::Cancelled => "scheduled_message.cancelled",
            ScheduleAudit::Sent => "scheduled_message.sent",
            ScheduleAudit::Failed => "scheduled_message.failed",
        }
    }

    fn schema(self) -> &'static str {
        match self {
            ScheduleAudit::Created => "momo.scheduled_message.created.v1",
            ScheduleAudit::Updated => "momo.scheduled_message.updated.v1",
            ScheduleAudit::Cancelled => "momo.scheduled_message.cancelled.v1",
            ScheduleAudit::Sent => "momo.scheduled_message.sent.v1",
            ScheduleAudit::Failed => "momo.scheduled_message.failed.v1",
        }
    }
}

fn upper(id: Uuid) -> String {
    id.to_string().to_uppercase()
}

/// The `scheduled_message.updated` frame (D12): ids, status and time. **No body, no
/// attachment name** — a client re-reads the list for those.
pub fn schedule_event_payload(row: &ScheduledMessage) -> Value {
    let mut payload = json!({
        "scheduled_message_id": upper(row.id),
        "channel_id": upper(row.channel_id),
        "status": row.status.as_db_label(),
        "send_at_ms": row.send_at_ms(),
        "rev": row.rev,
    });
    if let Some(object) = payload.as_object_mut() {
        if let Some(reason) = row.failure_reason {
            object.insert("failure_reason".into(), json!(reason.as_code()));
        }
        if let Some(sent) = row.sent_message_id {
            object.insert("sent_message_id".into(), json!(upper(sent)));
        }
    }
    inbox_event_payload(
        row.workspace_id,
        row.author_member_id,
        SCHEDULE_EVENT_TYPE,
        payload,
        // `rev` is the tail, so a row that changes twice is two frames and a replay of
        // one is the same frame.
        &format!("scheduled:{}:{}", upper(row.id), row.rev),
    )
}

/// The audit `detail` of one transition: ids, enum values and milliseconds only
/// (D13). `extra` carries the one-off keys (`lateMs`, `via`).
fn audit_detail(row: &ScheduledMessage, extra: Value) -> Value {
    let mut detail = json!({
        "channelId": row.channel_id,
        "sendAtMs": row.send_at_ms(),
    });
    if let Some(object) = detail.as_object_mut() {
        if let Some(armed) = row.armed_session_id {
            object.insert("armedSessionId".into(), json!(armed));
        }
        if let Some(reason) = row.failure_reason {
            object.insert("failureReason".into(), json!(reason.as_code()));
        }
        if let Some(sent) = row.sent_message_id {
            object.insert("sentMessageId".into(), json!(sent));
        }
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    detail
}

/// Emit the event on the author's personal channel and write the audit row, in the
/// caller's transaction (D12, D13). Every function below that changes a row calls this
/// and nothing else does — a transition without its event or its audit row is a bug a
/// test can name.
pub async fn record_transition_in_tx(
    conn: &mut PgConnection,
    row: &ScheduledMessage,
    audit: ScheduleAudit,
    actor: ScheduleActor,
    extra: Value,
) -> Result<(), DbError> {
    emit_outbox(
        &mut *conn,
        row.workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &schedule_event_payload(row),
        Some(row.author_member_id),
    )
    .await?;
    let entry = AuditEntry::new(row.workspace_id, audit.action())
        .target("scheduled_message", row.id)
        .with_schema(audit.schema(), audit_detail(row, extra));
    let entry = match actor {
        ScheduleActor::Member {
            member_id,
            via_token_id,
        } => entry.by(member_id).via_token(via_token_id),
        ScheduleActor::System => entry.about(row.author_member_id),
    };
    write_audit(conn, &entry).await?;
    Ok(())
}

/// `create` — the row is written by [`insert_schedule_in_tx`]; this is its event and audit.
pub async fn record_created_in_tx(
    conn: &mut PgConnection,
    row: &ScheduledMessage,
    actor: ScheduleActor,
) -> Result<(), DbError> {
    record_transition_in_tx(conn, row, ScheduleAudit::Created, actor, json!({})).await
}

/// `PATCH` on a `pending` row: the text and/or the time. The session lineage moves only
/// when the **text** changed (D14: it records who last wrote the content; a time-only
/// edit is not that).
pub async fn edit_pending_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    body: Option<&str>,
    send_at: Option<DateTime<Utc>>,
    armed_session_id: Option<Uuid>,
    actor: ScheduleActor,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE scheduled_message \
            SET body = COALESCE($2, body), \
                send_at = COALESCE($3, send_at), \
                armed_session_id = CASE WHEN $2::text IS NOT NULL THEN $4 ELSE armed_session_id END, \
                rev = rev + 1, updated_at = now() \
          WHERE id = $1 AND author_member_id = $5 AND status = 'pending' \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(schedule_id)
    .bind(body)
    .bind(send_at)
    .bind(armed_session_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let row = decode_schedule(&row)?;
    record_transition_in_tx(conn, &row, ScheduleAudit::Updated, actor, json!({})).await?;
    Ok(Some(row))
}

/// `PATCH {body}` on a `failed` row: the text changes and the row stays failed (D9).
pub async fn edit_failed_body_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    body: &str,
    armed_session_id: Option<Uuid>,
    actor: ScheduleActor,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE scheduled_message \
            SET body = $2, armed_session_id = $3, rev = rev + 1, updated_at = now() \
          WHERE id = $1 AND author_member_id = $4 AND status = 'failed' \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(schedule_id)
    .bind(body)
    .bind(armed_session_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let row = decode_schedule(&row)?;
    record_transition_in_tx(conn, &row, ScheduleAudit::Updated, actor, json!({})).await?;
    Ok(Some(row))
}

/// `PATCH {sendAtMs}` on a `failed` row re-arms it (D9): `pending` again, a clean slate
/// (`attempts`, reason, backoff), and the session lineage moves to the requester (D14: a
/// re-arm is the author vouching for the content again).
pub async fn rearm_failed_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    body: Option<&str>,
    send_at: DateTime<Utc>,
    armed_session_id: Option<Uuid>,
    actor: ScheduleActor,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE scheduled_message \
            SET status = 'pending', failure_reason = NULL, attempts = 0, next_attempt_at = NULL, \
                body = COALESCE($2, body), send_at = $3, armed_session_id = $4, \
                rev = rev + 1, updated_at = now() \
          WHERE id = $1 AND author_member_id = $5 AND status = 'failed' \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(schedule_id)
    .bind(body)
    .bind(send_at)
    .bind(armed_session_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let row = decode_schedule(&row)?;
    record_transition_in_tx(conn, &row, ScheduleAudit::Updated, actor, json!({})).await?;
    Ok(Some(row))
}

/// Free the attachments a schedule holds (the files stay, like a draft's).
async fn release_reservations_in_tx(
    conn: &mut PgConnection,
    schedule_ids: &[Uuid],
) -> Result<(), DbError> {
    if schedule_ids.is_empty() {
        return Ok(());
    }
    sqlx::query("DELETE FROM scheduled_message_attachment WHERE scheduled_message_id = ANY($1)")
        .bind(schedule_ids)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

const CANCEL_SET: &str = "status = 'cancelled', body = NULL, failure_reason = NULL, \
     next_attempt_at = NULL, rev = rev + 1, updated_at = now()";

/// `DELETE` and the scheduler's deleted-workspace close: `pending` or `failed` →
/// `cancelled`, body erased, attachments released (D14).
pub async fn cancel_schedule_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    actor: ScheduleActor,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE scheduled_message SET {CANCEL_SET} \
          WHERE id = $1 AND author_member_id = $2 AND status IN ('pending', 'failed') \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(schedule_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let row = decode_schedule(&row)?;
    release_reservations_in_tx(conn, &[row.id]).await?;
    record_transition_in_tx(conn, &row, ScheduleAudit::Cancelled, actor, json!({})).await?;
    Ok(Some(row))
}

/// The send went out: `sent`, body erased, attachments released (they are on the
/// message now). Called inside the send transaction, after the canonical send returned.
pub async fn mark_sent_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    sent_message_id: Uuid,
    actor: ScheduleActor,
    via: Option<&str>,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE scheduled_message \
            SET status = 'sent', body = NULL, failure_reason = NULL, next_attempt_at = NULL, \
                sent_message_id = $3, sent_at = now(), rev = rev + 1, updated_at = now() \
          WHERE id = $1 AND author_member_id = $2 AND status IN ('pending', 'failed') \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(schedule_id)
    .bind(member_id)
    .bind(sent_message_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let row = decode_schedule(&row)?;
    release_reservations_in_tx(conn, &[row.id]).await?;
    let late_ms = row
        .sent_at
        .map(|sent_at| (sent_at - row.send_at).num_milliseconds().max(0))
        .unwrap_or(0);
    let mut extra = json!({ "lateMs": late_ms });
    if let (Some(via), Some(object)) = (via, extra.as_object_mut()) {
        object.insert("via".into(), json!(via));
    }
    record_transition_in_tx(conn, &row, ScheduleAudit::Sent, actor, extra).await?;
    Ok(Some(row))
}

/// The send could not go out: `failed` with a reason, body kept so the author can
/// re-arm, send now or copy it (D8). A refused send-now on a `failed` row changes the
/// reason, so both open states are accepted.
pub async fn mark_failed_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    reason: ScheduleFailure,
    actor: ScheduleActor,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE scheduled_message \
            SET status = 'failed', failure_reason = $3, next_attempt_at = NULL, \
                rev = rev + 1, updated_at = now() \
          WHERE id = $1 AND author_member_id = $2 AND status IN ('pending', 'failed') \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(schedule_id)
    .bind(member_id)
    .bind(reason.as_code())
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let row = decode_schedule(&row)?;
    record_transition_in_tx(conn, &row, ScheduleAudit::Failed, actor, json!({})).await?;
    Ok(Some(row))
}

// ---------------------------------------------------------------------------
// the scheduler's two transactions
// ---------------------------------------------------------------------------

/// A `pending` row the scheduler's decision transaction locked, and whether its grace
/// window is over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueDecision {
    pub row: ScheduledMessage,
    pub past_grace: bool,
}

/// Decision transaction, step 1: lock the row **if it is still due** (`SKIP LOCKED`: a
/// request holding it, or another replica, is a reason to skip, not to wait). `None` when
/// it is gone, no longer `pending`, no longer due, or locked by someone else.
pub async fn lock_due_for_decision_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    grace_seconds: i64,
) -> Result<Option<DueDecision>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "SELECT {SCHEDULE_COLS}, \
                (send_at + make_interval(secs => $3::double precision) < now()) AS past_grace \
           FROM scheduled_message \
          WHERE id = $1 AND author_member_id = $2 AND status = 'pending' \
            AND send_at <= now() \
            AND (next_attempt_at IS NULL OR next_attempt_at <= now()) \
            FOR UPDATE SKIP LOCKED"
    ))
    .bind(schedule_id)
    .bind(member_id)
    .bind(grace_seconds as f64)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(DueDecision {
        past_grace: row.try_get("past_grace")?,
        row: decode_schedule(&row)?,
    }))
}

/// Decision transaction, step 4: this is an attempt. Raise `attempts` by one and push
/// `next_attempt_at` out by the backoff, then commit **before** sending. **This is the
/// only statement that raises `attempts`** (D7): it makes "which attempt was this" a
/// fact in the database, and it makes a row whose send panics or hangs back off instead
/// of holding the tick. Returns the new `attempts`.
pub async fn begin_attempt_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    previous_attempts: i32,
) -> Result<Option<i32>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let next = previous_attempts.saturating_add(1);
    let attempts: Option<i32> = sqlx::query_scalar(
        "UPDATE scheduled_message \
            SET attempts = attempts + 1, \
                next_attempt_at = now() + make_interval(secs => $3::double precision) \
          WHERE id = $1 AND author_member_id = $2 AND status = 'pending' AND attempts = $4 \
          RETURNING attempts",
    )
    .bind(schedule_id)
    .bind(member_id)
    .bind(backoff_seconds(next) as f64)
    .bind(previous_attempts)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(attempts)
}

/// Send transaction, step 1: lock **the attempt the decision transaction just
/// recorded** (`attempts = $k`). A cancel, a send-now or a re-arm that got in between
/// changed the row, and this finds nothing.
pub async fn lock_attempt_for_send_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
    attempts: i32,
) -> Result<Option<ScheduledMessage>, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "SELECT {SCHEDULE_COLS} FROM scheduled_message \
          WHERE id = $1 AND author_member_id = $2 AND status = 'pending' AND attempts = $3 \
            FOR UPDATE SKIP LOCKED"
    ))
    .bind(schedule_id)
    .bind(member_id)
    .bind(attempts)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(decode_schedule).transpose()?)
}

// ---------------------------------------------------------------------------
// the tick's cross-tenant lists (D6) and the retention sweep (D14)
// ---------------------------------------------------------------------------

/// One entry of `momo_schedule_private.due_scheduled_messages` /
/// `expired_scheduled_messages`: three ids, nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduleRef {
    pub workspace_id: Uuid,
    pub scheduled_message_id: Uuid,
    pub author_member_id: Uuid,
}

fn decode_ref(row: &PgRow) -> Result<ScheduleRef, sqlx::Error> {
    Ok(ScheduleRef {
        workspace_id: row.try_get("workspace_id")?,
        scheduled_message_id: row.try_get("scheduled_message_id")?,
        author_member_id: row.try_get("author_member_id")?,
    })
}

/// The due schedules across tenants (D6): at most 25 per workspace, workspaces
/// interleaved, `limit` rows in all. **Call it on a plain connection, outside any tenant
/// transaction** — that connection may have run one before (its `app.workspace_id` is
/// then `''`), which is the case the policy's `NULLIF` exists for.
pub async fn due_schedules(
    conn: &mut PgConnection,
    limit: i32,
) -> Result<Vec<ScheduleRef>, DbError> {
    let rows = sqlx::query(
        "SELECT workspace_id, scheduled_message_id, author_member_id \
           FROM momo_schedule_private.due_scheduled_messages($1)",
    )
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_ref)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// Rows past retention (sent/cancelled 7 days, failed 30 days), across tenants.
pub async fn expired_schedules(
    conn: &mut PgConnection,
    limit: i32,
) -> Result<Vec<ScheduleRef>, DbError> {
    let rows = sqlx::query(
        "SELECT workspace_id, scheduled_message_id, author_member_id \
           FROM momo_schedule_private.expired_scheduled_messages($1)",
    )
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_ref)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// Delete one row past retention, in its author's own transaction (`momo_app`, RLS
/// bound: there is no cross-tenant write). The age is judged again here, so a row
/// that was touched since the list was made survives.
pub async fn purge_expired_schedule_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    schedule_id: Uuid,
) -> Result<bool, DbError> {
    bind_owner_guc(conn, member_id).await?;
    let deleted = sqlx::query(
        "DELETE FROM scheduled_message \
          WHERE id = $1 AND author_member_id = $2 \
            AND ((status IN ('sent', 'cancelled') \
                  AND updated_at < now() - make_interval(days => $3)) \
              OR (status = 'failed' \
                  AND updated_at < now() - make_interval(days => $4)))",
    )
    .bind(schedule_id)
    .bind(member_id)
    .bind(SCHEDULE_DONE_RETENTION_DAYS)
    .bind(SCHEDULE_FAILED_RETENTION_DAYS)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(deleted == 1)
}

// ---------------------------------------------------------------------------
// the three lifecycle hooks (D14) — the only functions that bind another's owner scope
// ---------------------------------------------------------------------------

/// What a lifecycle hook changed, row by row.
pub type HeldSchedules = Vec<ScheduledMessage>;

/// A member's every sign-in ended (password change or reset, suspension, removal,
/// leaving): their **pending schedules and every failed row** are held as `failed` +
/// `sessions_ended` (D14 point 1). Held, not cancelled: a legitimate schedule is not
/// lost silently, and a schedule planted by a stolen session does not go out on its
/// own after the account is recovered — the author re-reads it and re-arms it or sends
/// it now. Every failed row is held whatever its reason, because the server lets a failed
/// row be sent now or re-armed with one click and the original reason is judged again
/// when it is.
///
/// The transaction holds **only the workspace GUC**, so this binds the member's owner
/// scope, does the work, and puts the previous scope back.
pub async fn hold_member_schedules_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<HeldSchedules, DbError> {
    let restore = bind_foreign_owner_guc(conn, member_id).await?;
    let rows = sqlx::query(&format!(
        "UPDATE scheduled_message \
            SET status = 'failed', failure_reason = 'sessions_ended', next_attempt_at = NULL, \
                rev = rev + 1, updated_at = now() \
          WHERE workspace_id = $1 AND author_member_id = $2 \
            AND (status = 'pending' \
                 OR (status = 'failed' AND failure_reason IS DISTINCT FROM 'sessions_ended')) \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(workspace_id)
    .bind(member_id)
    .fetch_all(&mut *conn)
    .await?;
    let held = decode_all(&rows)?;
    for row in &held {
        record_transition_in_tx(
            conn,
            row,
            ScheduleAudit::Failed,
            ScheduleActor::System,
            json!({}),
        )
        .await?;
    }
    restore_owner_guc(conn, restore).await?;
    Ok(held)
}

/// One sign-in lineage ended by a device being unlinked or a refresh token being
/// reused (D14 point 2): the schedules whose content **that lineage last wrote**
/// (`armed_session_id`) are held, as above. A logout never calls this — arming a
/// message and signing out is what the feature is for.
pub async fn hold_lineage_schedules_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
) -> Result<HeldSchedules, DbError> {
    let restore = bind_foreign_owner_guc(conn, member_id).await?;
    let rows = sqlx::query(&format!(
        "UPDATE scheduled_message \
            SET status = 'failed', failure_reason = 'sessions_ended', next_attempt_at = NULL, \
                rev = rev + 1, updated_at = now() \
          WHERE workspace_id = $1 AND author_member_id = $2 AND armed_session_id = $3 \
            AND (status = 'pending' \
                 OR (status = 'failed' AND failure_reason IS DISTINCT FROM 'sessions_ended')) \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(workspace_id)
    .bind(member_id)
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    let held = decode_all(&rows)?;
    for row in &held {
        record_transition_in_tx(
            conn,
            row,
            ScheduleAudit::Failed,
            ScheduleActor::System,
            json!({}),
        )
        .await?;
    }
    restore_owner_guc(conn, restore).await?;
    Ok(held)
}

/// A member was removed or left the workspace (D14 point 3): every pending and failed
/// schedule is **cancelled** — body erased, attachments released. A person who is no
/// longer in the workspace has nobody to re-read the held row, so holding it would only
/// keep their text around.
pub async fn cancel_member_schedules_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<HeldSchedules, DbError> {
    let restore = bind_foreign_owner_guc(conn, member_id).await?;
    let rows = sqlx::query(&format!(
        "UPDATE scheduled_message SET {CANCEL_SET} \
          WHERE workspace_id = $1 AND author_member_id = $2 AND status IN ('pending', 'failed') \
          RETURNING {SCHEDULE_COLS}"
    ))
    .bind(workspace_id)
    .bind(member_id)
    .fetch_all(&mut *conn)
    .await?;
    let cancelled = decode_all(&rows)?;
    let ids: Vec<Uuid> = cancelled.iter().map(|row| row.id).collect();
    release_reservations_in_tx(conn, &ids).await?;
    for row in &cancelled {
        record_transition_in_tx(
            conn,
            row,
            ScheduleAudit::Cancelled,
            ScheduleActor::System,
            json!({}),
        )
        .await?;
    }
    restore_owner_guc(conn, restore).await?;
    Ok(cancelled)
}

fn decode_all(rows: &[PgRow]) -> Result<Vec<ScheduledMessage>, DbError> {
    rows.iter()
        .map(decode_schedule)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: i64) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(ms).expect("time")
    }

    #[test]
    fn the_failure_reasons_are_the_closed_set_of_eight() {
        assert_eq!(ScheduleFailure::ALL.len(), 8);
        for reason in ScheduleFailure::ALL {
            assert_eq!(ScheduleFailure::from_code(reason.as_code()), Some(reason));
        }
        assert_eq!(ScheduleFailure::from_code("channel_archived"), None);
    }

    #[test]
    fn the_four_statuses_round_trip_and_there_is_no_sending() {
        for status in [
            ScheduledStatus::Pending,
            ScheduledStatus::Sent,
            ScheduledStatus::Failed,
            ScheduledStatus::Cancelled,
        ] {
            assert_eq!(
                ScheduledStatus::from_db_label(status.as_db_label()),
                Some(status)
            );
        }
        assert_eq!(ScheduledStatus::from_db_label("sending"), None);
        assert_eq!(ScheduledStatus::from_db_label("canceled"), None);
    }

    #[test]
    fn the_send_window_is_sixty_seconds_to_a_hundred_twenty_days_on_the_database_clock() {
        let now = at(1_800_000_000_000);
        assert_eq!(
            validate_send_at(now.timestamp_millis() + 59_999, now),
            Err(SendAtInvalid::TooSoon)
        );
        assert!(validate_send_at(now.timestamp_millis() + 60_000, now).is_ok());
        let max = 120 * 24 * 3600 * 1000;
        assert!(validate_send_at(now.timestamp_millis() + max, now).is_ok());
        assert_eq!(
            validate_send_at(now.timestamp_millis() + max + 1, now),
            Err(SendAtInvalid::TooFar)
        );
        // The past, and a value no clock can show, are both "too soon" / "too far".
        assert_eq!(
            validate_send_at(now.timestamp_millis() - 1, now),
            Err(SendAtInvalid::TooSoon)
        );
        assert_eq!(validate_send_at(i64::MIN, now), Err(SendAtInvalid::TooSoon));
        assert_eq!(validate_send_at(i64::MAX, now), Err(SendAtInvalid::TooFar));
        assert_eq!(SendAtInvalid::TooSoon.code(), "send_at_too_soon");
        assert_eq!(SendAtInvalid::TooFar.code(), "send_at_too_far");
    }

    #[test]
    fn the_edit_lock_is_the_last_thirty_seconds() {
        let now = at(1_800_000_000_000);
        assert!(!is_edit_locked(
            now + chrono::Duration::milliseconds(30_001),
            now
        ));
        assert!(is_edit_locked(now + chrono::Duration::seconds(30), now));
        assert!(is_edit_locked(now, now), "due is locked");
        assert!(
            is_edit_locked(now - chrono::Duration::seconds(5), now),
            "overdue is locked"
        );
    }

    #[test]
    fn the_backoff_is_five_fifteen_forty_five_two_minutes_five_minutes_then_five_forever() {
        let schedule: Vec<i64> = (1..=8).map(backoff_seconds).collect();
        assert_eq!(schedule, vec![5, 15, 45, 120, 300, 300, 300, 300]);
        assert_eq!(backoff_seconds(0), 5);
        assert_eq!(backoff_seconds(i32::MAX), 300);
    }

    #[test]
    fn the_list_filter_is_a_closed_set_and_defaults_to_open() {
        assert_eq!(
            ScheduleListFilter::parse(None),
            Ok(ScheduleListFilter::Open)
        );
        assert_eq!(
            ScheduleListFilter::parse(Some("")),
            Ok(ScheduleListFilter::Open)
        );
        assert_eq!(
            ScheduleListFilter::parse(Some("failed")),
            Ok(ScheduleListFilter::Failed)
        );
        assert!(ScheduleListFilter::parse(Some("sent")).is_err());
        assert!(ScheduleListFilter::parse(Some("cancelled")).is_err());
        assert_eq!(clamp_schedule_list_limit(None), 50);
        assert_eq!(clamp_schedule_list_limit(Some(0)), 50);
        assert_eq!(clamp_schedule_list_limit(Some(7)), 7);
        assert_eq!(clamp_schedule_list_limit(Some(10_000)), 100);
    }

    fn row(status: ScheduledStatus) -> ScheduledMessage {
        ScheduledMessage {
            id: Uuid::from_u128(0xabc),
            workspace_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            author_member_id: Uuid::from_u128(3),
            root_id: None,
            body: Some("secret body text".into()),
            send_at: at(1_800_000_000_000),
            status,
            failure_reason: None,
            attempts: 0,
            next_attempt_at: None,
            sent_message_id: None,
            sent_at: None,
            client_request_id: Uuid::from_u128(4),
            armed_session_id: Some(Uuid::from_u128(5)),
            rev: 3,
            created_at: at(1_799_000_000_000),
            updated_at: at(1_799_000_000_000),
        }
    }

    /// D12 — the frame rides the author's personal channel, names ids and times, and
    /// carries nothing the author wrote.
    #[test]
    fn the_event_rides_the_personal_channel_with_ids_only() {
        let mut failed = row(ScheduledStatus::Failed);
        failed.failure_reason = Some(ScheduleFailure::SessionsEnded);
        let frame = schedule_event_payload(&failed);
        let text = frame.to_string();
        assert!(!text.contains("secret body text"), "no body: {text}");
        assert!(!text.contains("body"), "no body key at all: {text}");
        assert_eq!(
            frame["channel"],
            format!("user:read-state#{}", upper(failed.author_member_id))
        );
        let data = &frame["data"];
        assert_eq!(data["type"], SCHEDULE_EVENT_TYPE);
        assert_eq!(data["v"], 1);
        let payload = &data["payload"];
        assert_eq!(payload["status"], "failed");
        assert_eq!(payload["failure_reason"], "sessions_ended");
        assert_eq!(payload["rev"], 3);
        assert_eq!(payload["send_at_ms"], 1_800_000_000_000_i64);
        assert_eq!(payload["scheduled_message_id"], upper(failed.id));
        assert_eq!(payload["channel_id"], upper(failed.channel_id));
        assert_eq!(payload["workspace_id"], upper(failed.workspace_id));
        assert_eq!(payload["member_id"], upper(failed.author_member_id));
        assert!(payload.get("sent_message_id").is_none());
        assert_eq!(
            frame["idempotency_key"],
            format!(
                "user:read-state#{}:scheduled:{}:3",
                upper(failed.author_member_id),
                upper(failed.id)
            )
        );

        let mut sent = row(ScheduledStatus::Sent);
        sent.body = None;
        sent.sent_message_id = Some(Uuid::from_u128(9));
        let frame = schedule_event_payload(&sent);
        assert_eq!(
            frame["data"]["payload"]["sent_message_id"],
            upper(Uuid::from_u128(9))
        );
    }

    #[test]
    fn the_audit_detail_is_ids_enums_and_milliseconds_only() {
        let mut failed = row(ScheduledStatus::Failed);
        failed.failure_reason = Some(ScheduleFailure::Missed);
        let detail = audit_detail(&failed, json!({ "lateMs": 1234 }));
        let text = detail.to_string();
        assert!(!text.contains("secret body text"), "{text}");
        let keys: std::collections::BTreeSet<&str> = detail
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "armedSessionId",
                "channelId",
                "failureReason",
                "lateMs",
                "sendAtMs"
            ]
            .into_iter()
            .collect()
        );
    }
}
