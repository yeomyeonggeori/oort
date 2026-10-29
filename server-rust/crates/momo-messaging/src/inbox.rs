//! The inbox read/write surface over `inbox_item` (ADR-0199 D3~D7, #3681 E2).
//!
//! `inbox_item` rows are written by triggers (migrations 126/127) in the same
//! transaction as the message that causes them. This module owns everything the
//! API does with them afterwards:
//!
//! * [`list_inbox_in_tx`] — newest-first **keyset** page for one member;
//! * [`mark_inbox_item_read_in_tx`] / [`mark_inbox_read_all_in_tx`] — the item's
//!   own `read_at` (never the channel cursor: ADR-0199 D3, one direction);
//! * [`delete_read_inbox_items_in_tx`] — the 30-day retention of **read** items
//!   (the projection only; `message` is never touched).
//!
//! ## Two boundaries, two mechanisms
//!
//! The tenant boundary is RLS FORCE (`ws_isolation`, every caller runs in
//! `with_tenant_tx`). The **member** boundary inside a workspace is a predicate:
//! every statement here binds `member_id` to the *authenticated principal* the
//! route passes in, and no request field names a member. A foreign item id is
//! therefore "no such row", never "forbidden" — the same 404 as an id that never
//! existed, so the route is not an existence oracle.
//!
//! ## Visibility is re-derived at read time (ADR-0199 D4)
//!
//! The projection holds ids and `read_at`, no body. Each page joins `message`,
//! `channel` and `membership` again: a channel the member has left drops out, a
//! deleted message becomes a `deleted` placeholder with no preview, and a
//! muted channel hides its items unless the member's `mention_overrides_mute`
//! lets a mention through (ADR-0124). A quote-reply counts as a mention for
//! this purpose, exactly as it does for the push judgment (ADR-0148 rule 5).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use momo_db::{DbError, PgConnection};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::channel_restriction::ChannelRestriction;
use crate::read_state::read_state_channel;

/// Page size when the caller names none.
pub const INBOX_DEFAULT_LIMIT: i64 = 30;
/// Hard ceiling on one page.
pub const INBOX_MAX_LIMIT: i64 = 100;
/// Read items are kept this long after `read_at` (ADR-0199 D4, owner 2026-10-11).
pub const INBOX_READ_RETENTION_DAYS: i32 = 30;
/// `unreadCount` is capped here (a client shows "1000+"): the count runs on every
/// page, so it must not grow with an unbounded unread backlog.
pub const INBOX_UNREAD_COUNT_CAP: i64 = 1000;
/// Longest preview, in characters.
pub const INBOX_PREVIEW_CHARS: usize = 140;

/// Which items a page / a read-all covers (ADR-0199 D6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InboxFilter {
    #[default]
    All,
    Unread,
    Mention,
    Reply,
    Dm,
    Thread,
}

impl InboxFilter {
    pub fn parse(raw: &str) -> Option<InboxFilter> {
        match raw {
            "all" => Some(InboxFilter::All),
            "unread" => Some(InboxFilter::Unread),
            "mention" => Some(InboxFilter::Mention),
            "reply" => Some(InboxFilter::Reply),
            "dm" => Some(InboxFilter::Dm),
            "thread" => Some(InboxFilter::Thread),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            InboxFilter::All => "all",
            InboxFilter::Unread => "unread",
            InboxFilter::Mention => "mention",
            InboxFilter::Reply => "reply",
            InboxFilter::Dm => "dm",
            InboxFilter::Thread => "thread",
        }
    }

    /// A closed set of static SQL fragments — never request text.
    fn sql(self) -> &'static str {
        match self {
            InboxFilter::All => "TRUE",
            InboxFilter::Unread => "i.read_at IS NULL",
            InboxFilter::Mention => "'mention' = ANY(i.reasons)",
            InboxFilter::Reply => "'reply_to_me' = ANY(i.reasons)",
            InboxFilter::Dm => "'dm' = ANY(i.reasons)",
            InboxFilter::Thread => "'thread_reply' = ANY(i.reasons)",
        }
    }
}

/// Clamp a requested page size into `1..=INBOX_MAX_LIMIT`.
pub fn clamp_inbox_limit(requested: Option<i64>) -> i64 {
    requested
        .unwrap_or(INBOX_DEFAULT_LIMIT)
        .clamp(1, INBOX_MAX_LIMIT)
}

/// A keyset position `(created_at, id)`, carried as an opaque token.
///
/// The token is a position, not a capability: every query that consumes it is
/// scoped to the authenticated member, so a forged or foreign cursor can only
/// move *that member's* own page window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboxCursor {
    pub created_at: DateTime<Utc>,
    pub id: Uuid,
}

impl InboxCursor {
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(format!(
            "{}:{}",
            self.created_at.timestamp_micros(),
            self.id
        ))
    }

    pub fn decode(token: &str) -> Option<InboxCursor> {
        let bytes = URL_SAFE_NO_PAD.decode(token.as_bytes()).ok()?;
        let text = String::from_utf8(bytes).ok()?;
        let (micros, id) = text.split_once(':')?;
        let created_at = DateTime::from_timestamp_micros(micros.parse().ok()?)?;
        // inside PG timestamptz and sane: anything else is a 400, not a bind error
        if !(0..=4_102_444_800).contains(&created_at.timestamp()) {
            return None;
        }
        Some(InboxCursor {
            created_at,
            id: Uuid::parse_str(id).ok()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxChannel {
    pub id: Uuid,
    /// `None` for a DM (the client names it from the participants).
    pub name: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxMessage {
    pub id: Uuid,
    pub seq: i64,
    pub author_member_id: Uuid,
    /// Built at read time from `message.body`; empty when deleted.
    pub preview: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxQuoted {
    pub id: Uuid,
    pub author_member_id: Uuid,
    pub preview: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxItemView {
    pub id: Uuid,
    pub kind: String,
    pub reasons: Vec<String>,
    pub channel: InboxChannel,
    pub message: InboxMessage,
    pub quoted: Option<InboxQuoted>,
    pub root_id: Option<Uuid>,
    pub actor_member_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub read_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxPage {
    pub items: Vec<InboxItemView>,
    pub next_cursor: Option<InboxCursor>,
    /// Unread items the member can currently see, across every filter.
    pub unread_count: i64,
}

/// Collapse whitespace and cut to [`INBOX_PREVIEW_CHARS`] characters.
pub fn make_preview(body: Option<&str>) -> String {
    let collapsed: String = body
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() <= INBOX_PREVIEW_CHARS {
        return collapsed;
    }
    let mut cut: String = collapsed.chars().take(INBOX_PREVIEW_CHARS).collect();
    cut.push('…');
    cut
}

/// The joins + predicate every read of "what this member can see" shares.
/// `$1` workspace, `$2` member, `$3` show-muted.
const VISIBLE_FROM_WHERE: &str = "\
  FROM inbox_item i \
  JOIN membership ms \
    ON ms.channel_id = i.channel_id \
   AND ms.member_id = i.member_id \
   AND ms.left_at IS NULL \
  JOIN channel c ON c.id = i.channel_id \
  JOIN message m ON m.id = i.message_id \
  LEFT JOIN message q ON q.id = m.reply_to_id AND q.channel_id = m.channel_id \
  LEFT JOIN notification_pref np \
    ON np.workspace_id = i.workspace_id \
   AND np.member_id = i.member_id \
   AND np.channel_id = i.channel_id \
  LEFT JOIN notification_rule nr \
    ON nr.workspace_id = i.workspace_id \
   AND nr.member_id = i.member_id \
 WHERE i.workspace_id = $1 \
   AND i.member_id = $2 \
   AND ($3 OR NOT ( \
         np.member_id IS NOT NULL \
         AND (np.muted_until IS NULL OR np.muted_until > now()) \
         AND NOT (i.reasons && ARRAY['mention', 'reply_to_me'] \
                  AND COALESCE(nr.mention_overrides_mute, false)) \
       ))";

/// One newest-first page of the member's inbox.
///
/// `limit` is clamped by the caller ([`clamp_inbox_limit`]). The page asks for
/// `limit + 1` rows; the extra one only decides whether `next_cursor` exists.
pub async fn list_inbox_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    filter: InboxFilter,
    cursor: Option<InboxCursor>,
    limit: i64,
    show_muted: bool,
) -> Result<InboxPage, DbError> {
    list_inbox_within_in_tx(
        conn,
        workspace_id,
        member_id,
        filter,
        cursor,
        limit,
        show_muted,
        ChannelRestriction::Unrestricted,
    )
    .await
}

/// The inbox's channel restriction predicate, or nothing (ADR-0216 D4 · F17, #4660).
///
/// Appended to a statement that already selects through [`VISIBLE_FROM_WHERE`] — whose
/// `membership` join is what keeps a left channel out — so a restriction narrows that
/// visibility to the intersection and can never widen it. `$n` is the next free bind of
/// the statement it joins. Empty for [`ChannelRestriction::Unrestricted`], so every
/// caller that predates developer tokens runs the statement it always ran.
fn restriction_predicate(restriction: ChannelRestriction<'_>, n: u8) -> String {
    match restriction.listed() {
        None => String::new(),
        Some(_) => format!(" AND i.channel_id = ANY(${n}::uuid[])"),
    }
}

/// [`list_inbox_in_tx`], narrowed by a developer token's channel restriction (ADR-0216
/// D4 · R11 · F17, #4660).
///
/// The restriction is an argument of the **statement**, not a filter over its rows: the
/// page's `LIMIT`, its `next_cursor` and the `unread_count` beside it are all computed
/// over the restricted set, so none of the three can disagree with the items (a page
/// filtered afterwards would come back short, page on past the end, and count unread
/// items from channels it does not show). The quoted message of an item is joined with
/// `q.channel_id = m.channel_id`, so it is always from the item's own channel and follows
/// the restriction with it.
///
/// Read-only: a page marks nothing read.
#[allow(clippy::too_many_arguments)]
pub async fn list_inbox_within_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    filter: InboxFilter,
    cursor: Option<InboxCursor>,
    limit: i64,
    show_muted: bool,
    restriction: ChannelRestriction<'_>,
) -> Result<InboxPage, DbError> {
    let sql = format!(
        "SELECT i.id, i.kind, i.reasons, i.channel_id, i.message_id, i.seq, \
                i.actor_member_id, i.created_at, i.read_at, \
                c.kind::text AS channel_kind, c.name AS channel_name, \
                m.author_member_id AS msg_author, m.body AS msg_body, \
                (m.deleted_at IS NOT NULL OR m.state::text = 'deleted') AS msg_deleted, \
                m.root_id AS msg_root_id, \
                q.id AS q_id, q.author_member_id AS q_author, q.body AS q_body, \
                (q.deleted_at IS NOT NULL OR q.state::text = 'deleted') AS q_deleted \
         {VISIBLE_FROM_WHERE} \
           AND {filter_sql} \
           AND ($4::timestamptz IS NULL OR (i.created_at, i.id) < ($4, $5)){restriction_sql} \
         ORDER BY i.created_at DESC, i.id DESC \
         LIMIT $6",
        filter_sql = filter.sql(),
        restriction_sql = restriction_predicate(restriction, 7),
    );
    let mut query = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(member_id)
        .bind(show_muted)
        .bind(cursor.map(|c| c.created_at))
        .bind(cursor.map(|c| c.id).unwrap_or_else(Uuid::nil))
        .bind(limit + 1);
    if let Some(channel_ids) = restriction.listed() {
        query = query.bind(channel_ids);
    }
    let rows = query.fetch_all(&mut *conn).await?;

    let has_more = rows.len() as i64 > limit;
    let mut items = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.iter().take(limit as usize) {
        let msg_deleted: bool = row.try_get("msg_deleted")?;
        let body: Option<String> = row.try_get("msg_body")?;
        let quoted = match row.try_get::<Option<Uuid>, _>("q_id")? {
            Some(id) => {
                let deleted: bool = row.try_get("q_deleted")?;
                let body: Option<String> = row.try_get("q_body")?;
                Some(InboxQuoted {
                    id,
                    author_member_id: row.try_get("q_author")?,
                    preview: if deleted {
                        String::new()
                    } else {
                        make_preview(body.as_deref())
                    },
                    deleted,
                })
            }
            None => None,
        };
        items.push(InboxItemView {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            reasons: row.try_get("reasons")?,
            channel: InboxChannel {
                id: row.try_get("channel_id")?,
                name: row.try_get("channel_name")?,
                kind: row.try_get("channel_kind")?,
            },
            message: InboxMessage {
                id: row.try_get("message_id")?,
                seq: row.try_get("seq")?,
                author_member_id: row.try_get("msg_author")?,
                preview: if msg_deleted {
                    String::new()
                } else {
                    make_preview(body.as_deref())
                },
                deleted: msg_deleted,
            },
            quoted,
            root_id: row.try_get("msg_root_id")?,
            actor_member_id: row.try_get("actor_member_id")?,
            created_at: row.try_get("created_at")?,
            read_at: row.try_get("read_at")?,
        });
    }
    let next_cursor = if has_more {
        items.last().map(|last| InboxCursor {
            created_at: last.created_at,
            id: last.id,
        })
    } else {
        None
    };
    // ADR-0216 F17 — the same restriction as the page, or `unreadCount` would keep counting
    // the channels the page just left out.
    let unread_count =
        inbox_unread_count_within_in_tx(conn, workspace_id, member_id, show_muted, restriction)
            .await?;
    Ok(InboxPage {
        items,
        next_cursor,
        unread_count,
    })
}

/// Unread items the member can currently see (same visibility as the page).
pub async fn inbox_unread_count_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    show_muted: bool,
) -> Result<i64, DbError> {
    inbox_unread_count_within_in_tx(
        conn,
        workspace_id,
        member_id,
        show_muted,
        ChannelRestriction::Unrestricted,
    )
    .await
}

/// [`inbox_unread_count_in_tx`] over a developer token's channel restriction (ADR-0216
/// D4 · F17, #4660): the unread items of the restricted channels the member still
/// belongs to, and nothing else.
pub async fn inbox_unread_count_within_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    show_muted: bool,
    restriction: ChannelRestriction<'_>,
) -> Result<i64, DbError> {
    let sql = format!(
        "SELECT count(*) FROM (SELECT 1 {VISIBLE_FROM_WHERE} AND i.read_at IS NULL{restriction_sql} LIMIT {cap}) capped",
        cap = INBOX_UNREAD_COUNT_CAP + 1,
        restriction_sql = restriction_predicate(restriction, 4),
    );
    let mut query = sqlx::query_scalar(&sql)
        .bind(workspace_id)
        .bind(member_id)
        .bind(show_muted);
    if let Some(channel_ids) = restriction.listed() {
        query = query.bind(channel_ids);
    }
    let count: i64 = query.fetch_one(&mut *conn).await?;
    Ok(count.min(INBOX_UNREAD_COUNT_CAP))
}

/// What a single-item read did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboxItemReadOutcome {
    pub read_at: DateTime<Utc>,
    /// `false` when the item was already read (idempotent replay): `read_at` is
    /// the original one and no event was published.
    pub changed: bool,
    pub outbox_id: Option<i64>,
}

/// Mark one of the caller's own items read. `None` = no such item **for this
/// member** (a stranger's id and a made-up id are indistinguishable).
///
/// `read_at` is filled once and never rewritten. This does not move any channel
/// cursor (ADR-0199 D3).
pub async fn mark_inbox_item_read_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    item_id: Uuid,
) -> Result<Option<InboxItemReadOutcome>, DbError> {
    let row = sqlx::query(
        "WITH cur AS ( \
           SELECT id, read_at AS was FROM inbox_item \
            WHERE id = $1 AND workspace_id = $2 AND member_id = $3 \
              FOR UPDATE) \
         UPDATE inbox_item i \
            SET read_at = COALESCE(i.read_at, GREATEST(now(), i.created_at)) \
           FROM cur \
          WHERE i.id = cur.id \
         RETURNING i.read_at AS read_at, (cur.was IS NULL) AS changed",
    )
    .bind(item_id)
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let read_at: DateTime<Utc> = row.try_get("read_at")?;
    let changed: bool = row.try_get("changed")?;
    let outbox_id = if changed {
        let payload = inbox_event_payload(
            workspace_id,
            member_id,
            "inbox_item.read",
            json!({ "item_id": upper(item_id), "read_at": iso(read_at) }),
            &format!("inbox:{}:read", upper(item_id)),
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
    Ok(Some(InboxItemReadOutcome {
        read_at,
        changed,
        outbox_id,
    }))
}

/// What a read-all did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboxReadAllOutcome {
    pub marked: i64,
    pub outbox_id: Option<i64>,
}

/// Mark every unread item the member can **see** (and that matches `filter`)
/// read. Hidden items (a muted channel, a channel the member left) are not
/// consumed behind their back.
pub async fn mark_inbox_read_all_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    filter: InboxFilter,
    show_muted: bool,
) -> Result<InboxReadAllOutcome, DbError> {
    let sql = format!(
        "UPDATE inbox_item t SET read_at = GREATEST(now(), t.created_at) \
          WHERE t.id IN (SELECT i.id {VISIBLE_FROM_WHERE} \
                           AND i.read_at IS NULL AND {filter_sql}) \
            AND t.workspace_id = $1 AND t.member_id = $2 AND t.read_at IS NULL",
        filter_sql = filter.sql(),
    );
    let marked = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(member_id)
        .bind(show_muted)
        .execute(&mut *conn)
        .await?
        .rows_affected() as i64;
    let outbox_id = if marked > 0 {
        let discriminator: Uuid = sqlx::query_scalar("SELECT uuidv7()")
            .fetch_one(&mut *conn)
            .await?;
        let payload = inbox_event_payload(
            workspace_id,
            member_id,
            "inbox.read_all",
            json!({ "filter": filter.as_str(), "marked": marked, "read_at": iso(Utc::now()) }),
            &format!("inbox:read_all:{}", upper(discriminator)),
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
    Ok(InboxReadAllOutcome { marked, outbox_id })
}

/// Workspaces that have at least one read item past retention (cross-tenant
/// **read**; the caller connects as the BYPASSRLS notifier role).
pub async fn workspaces_with_expired_inbox_items(
    conn: &mut PgConnection,
    limit: i64,
) -> Result<Vec<Uuid>, DbError> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT workspace_id FROM ( \
           SELECT workspace_id FROM inbox_item \
            WHERE read_at IS NOT NULL \
              AND read_at < clock_timestamp() - make_interval(days => $1) \
            LIMIT $2) expired",
    )
    .bind(INBOX_READ_RETENTION_DAYS)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// Delete up to `batch` read items past retention in this workspace. Idempotent:
/// a second run finds nothing more. Unread items are never deleted, and the
/// source `message` is never touched.
pub async fn delete_read_inbox_items_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    batch: i64,
) -> Result<u64, DbError> {
    // MATERIALIZED: a bare `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`
    // may be re-run by the planner and delete more than `n` rows.
    let deleted = sqlx::query(
        "WITH doomed AS MATERIALIZED ( \
           SELECT id FROM inbox_item \
            WHERE workspace_id = $1 \
              AND read_at IS NOT NULL \
              AND read_at < clock_timestamp() - make_interval(days => $2) \
            ORDER BY read_at \
            LIMIT $3 \
              FOR UPDATE SKIP LOCKED) \
         DELETE FROM inbox_item t USING doomed d WHERE t.id = d.id",
    )
    .bind(workspace_id)
    .bind(INBOX_READ_RETENTION_DAYS)
    .bind(batch)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(deleted)
}

fn upper(id: Uuid) -> String {
    id.to_string().to_uppercase()
}

fn iso(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
}

/// The personal-channel envelope shared with the read-state broadcast
/// (ADR-0109 D3): ids and timestamps only, no message content.
pub fn inbox_event_payload(
    workspace_id: Uuid,
    member_id: Uuid,
    event_type: &str,
    mut payload: Value,
    idempotency_suffix: &str,
) -> Value {
    if let Some(object) = payload.as_object_mut() {
        object.insert("workspace_id".into(), json!(upper(workspace_id)));
        object.insert("member_id".into(), json!(upper(member_id)));
    }
    let channel = read_state_channel(member_id);
    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data: json!({
            "type": event_type,
            "v": 1,
            "ts": Utc::now().timestamp_millis(),
            "payload": payload,
        }),
        version: None,
        idempotency_key: Some(format!("{channel}:{idempotency_suffix}")),
    };
    serde_json::to_value(envelope).expect("inbox event payload serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_garbage_does_not_decode() {
        let cursor = InboxCursor {
            created_at: DateTime::from_timestamp_micros(1_760_000_000_123_456).unwrap(),
            id: Uuid::from_u128(7),
        };
        assert_eq!(InboxCursor::decode(&cursor.encode()), Some(cursor));
        assert_eq!(InboxCursor::decode("not base64 !!"), None);
        assert_eq!(InboxCursor::decode(&URL_SAFE_NO_PAD.encode("1:nope")), None);
        assert_eq!(InboxCursor::decode(&URL_SAFE_NO_PAD.encode("nope")), None);
    }

    #[test]
    fn filters_are_a_closed_set() {
        for name in ["all", "unread", "mention", "reply", "dm", "thread"] {
            assert_eq!(InboxFilter::parse(name).unwrap().as_str(), name);
        }
        assert_eq!(InboxFilter::parse("task"), None, "task is a follow-up");
        assert_eq!(InboxFilter::parse("all; DROP TABLE x"), None);
    }

    #[test]
    fn limits_are_clamped() {
        assert_eq!(clamp_inbox_limit(None), 30);
        assert_eq!(clamp_inbox_limit(Some(0)), 1);
        assert_eq!(clamp_inbox_limit(Some(-5)), 1);
        assert_eq!(clamp_inbox_limit(Some(10_000)), 100);
    }

    #[test]
    fn previews_collapse_whitespace_and_cut_by_characters() {
        assert_eq!(make_preview(Some("  안녕\n\n  하세요  ")), "안녕 하세요");
        assert_eq!(make_preview(None), "");
        let long = "가".repeat(300);
        let cut = make_preview(Some(&long));
        assert_eq!(cut.chars().count(), INBOX_PREVIEW_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn the_event_rides_the_members_personal_channel_with_ids_only() {
        let ws = Uuid::from_u128(1);
        let member = Uuid::from_u128(2);
        let payload = inbox_event_payload(
            ws,
            member,
            "inbox_item.read",
            json!({ "item_id": "X", "read_at": "t" }),
            "inbox:X:read",
        );
        assert_eq!(payload["channel"], read_state_channel(member));
        assert_eq!(payload["data"]["type"], "inbox_item.read");
        assert_eq!(payload["data"]["payload"]["item_id"], "X");
        assert_eq!(
            payload["data"]["payload"]["member_id"],
            member.to_string().to_uppercase()
        );
        assert!(payload["idempotency_key"]
            .as_str()
            .unwrap()
            .ends_with(":inbox:X:read"));
        assert!(payload["data"]["payload"].get("body").is_none());
    }
}
