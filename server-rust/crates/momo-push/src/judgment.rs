//! Judgment v0 — **the** single place notification judgment lives (ux-bible P9).
//!
//! Port of `NotifierService.judgeTargets` / `unreadBadge`
//! (`NotifierService.swift:324-478`).
//!
//! The 011 trigger is deliberately unconditional: it records that activity
//! happened, never who should hear about it. Deciding *who* is this module's
//! job and nowhere else's — that separation is the Slack activity/delivery
//! lesson ADR-0120 D3 encodes.
//!
//! ## What is decided here
//!
//! * **DM** — every message in a `dm` channel notifies the other active members.
//! * **Mention** — from `message.props.mention_member_ids`, the server-recomputed
//!   projection persisted at insert time. Judgment **never re-parses the body**;
//!   it never even reads it.
//! * **Approval request** — an `approval_request` message notifies the humans
//!   who can decide it, excluding the requesting agent.
//! * **Resume offer** — the owning member of the orphaned session.
//! * **Work complete (`work_session_idle`, ADR-0120 부록 A, #3341)** — only the
//!   member who started the session, only when the turn ran at least
//!   [`WORK_COMPLETE_MIN_RAN_MS`], only once per turn, only when they have not
//!   just been reading that channel ([`WORK_COMPLETE_FOREGROUND_WINDOW_SECS`]),
//!   and only while `notification_rule.work_complete_push` is on. An idle card
//!   that fails any of these selects NO reason — it must never fall through to
//!   `dm`, which would push the card's own text to a DM peer.
//! * **Mute (ADR-0124)** — the per-channel `notification_pref` row suppresses
//!   every reason, mentions and approvals included. Read at judgment time; no
//!   cache.
//! * **DND / mention-exception (ADR-0124 증보 1)** — the per-member,
//!   workspace-global `notification_rule` row. `dnd` suppresses every reason for
//!   that member (it sits ABOVE channel mute — DND wins even over a mention
//!   exception). `mention_overrides_mute` lets a `reason='mention'` candidate
//!   through a channel this member muted, and only a mention: it modifies the
//!   018 mute, it does not undo it for DMs or approvals.
//! * **Pause expiry (ADR-0124 증보 2)** — `notification_rule.dnd_until`. A pause
//!   suppresses only while `dnd_until IS NULL OR dnd_until > now()`, compared
//!   HERE at judgment time. There is no sweeper: an expired pause row simply
//!   stops matching. Declared DND reaches this SQL only through that same
//!   column — the presence write sets the pause in its own transaction
//!   (「묶어」), so judgment still reads one ledger and never `member`.
//!
//! Reason precedence per member is `approval_request > mention > dm`, expressed
//! by the `CASE` arm order below. Suppression precedence across the two ledgers
//! is `dnd > channel-mute(with mention exception) > deliver`, expressed by the
//! `WHERE` clause: absence of a `notification_rule` row is `dnd=false,
//! mention_overrides_mute=false`, which is the pre-증보 behaviour exactly.
//!
//! ## What is *not* read
//!
//! `message.body` appears nowhere in these statements. A target carries ids,
//! enum labels and a count — there is no column here that could carry prose.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::dispatch::{category_for, PushCategory, PushReason};

/// A work turn must have run at least this long (ms) to earn a 「작업 끝남」 push
/// (성재 2026-10-02: 「1분 이상」; ADR-0120 부록 A). Measured per turn at the
/// idle transition and stamped on the card as `props.ran_ms`.
pub const WORK_COMPLETE_MIN_RAN_MS: i64 = 60_000;

/// The "app is not in the foreground" heuristic (ADR-0120 부록 A-8). The server
/// has no foreground signal, so a person is treated as looking at the session
/// when their read cursor in its channel advanced within this many seconds
/// before the idle card, or already covers the card.
pub const WORK_COMPLETE_FOREGROUND_WINDOW_SECS: f64 = 30.0;

/// One (member, active token) pair to notify, with the reason that selected it.
#[derive(Debug, Clone)]
pub struct JudgedTarget {
    pub member_id: Uuid,
    pub token_id: Uuid,
    pub device_id: Uuid,
    pub device_platform: String,
    pub apns_token: String,
    pub apns_env: String,
    pub apns_topic: String,
    pub reason: PushReason,
    pub thread_id: Uuid,
    pub category: PushCategory,
    pub approval_id: Option<Uuid>,
}

/// Resolve who to notify for one committed message, and on which active tokens.
///
/// One statement against committed state. A member with no active token
/// contributes no row, so agents (which never have devices) drop out naturally
/// — and `mem.kind = 'human'` is a second, defensive filter against schema
/// drift (review #424 L1).
pub async fn judge_targets(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
) -> Result<Vec<JudgedTarget>, DbError> {
    let rows = sqlx::query(
        "WITH msg AS ( \
           SELECT m.id, m.channel_id, m.author_member_id, \
                  m.type::text AS message_type, \
                  COALESCE(m.props->'mention_member_ids', '[]'::jsonb) AS mention_ids, \
                  m.props->>'kind' AS props_kind, \
                  m.props->>'owner_member_id' AS owner_member_id, \
                  m.props->>'session_id' AS session_id, \
                  m.props->'turn_started_ms' AS turn_started_ms, \
                  CASE WHEN jsonb_typeof(m.props->'ran_ms') = 'number' \
                       THEN (m.props->>'ran_ms')::numeric END AS ran_ms, \
                  m.seq, \
                  m.created_at, \
                  m.root_id, \
                  c.kind::text AS channel_kind \
             FROM message m \
             JOIN channel c ON c.id = m.channel_id \
            WHERE m.id = $2 \
              AND m.workspace_id = $1 \
         ), \
         recipients AS ( \
           SELECT ms.member_id, \
                  CASE \
                    WHEN (SELECT props_kind FROM msg) = 'resume_offer' \
                         AND lower(mem.id::text) = lower((SELECT owner_member_id FROM msg)) \
                      THEN 'resume_offer' \
                    WHEN (SELECT props_kind FROM msg) = 'work_session_idle' THEN \
                      CASE WHEN lower(mem.id::text) = lower((SELECT owner_member_id FROM msg)) \
                            AND mem.id = (SELECT author_member_id FROM msg) \
                            AND (SELECT message_type FROM msg) = 'system' \
                            AND COALESCE((SELECT ran_ms FROM msg), 0) >= $3::bigint \
                            AND EXISTS ( \
                              SELECT 1 FROM work_session ws \
                               WHERE ws.workspace_id = $1 \
                                 AND lower(ws.id::text) = lower((SELECT session_id FROM msg)) \
                                 AND ws.member_id = mem.id \
                                 AND ws.root_message_id = (SELECT root_id FROM msg) \
                            ) \
                            AND NOT EXISTS ( \
                              SELECT 1 FROM message prior \
                               WHERE prior.workspace_id = $1 \
                                 AND prior.channel_id = (SELECT channel_id FROM msg) \
                                 AND prior.seq < (SELECT seq FROM msg) \
                                 AND prior.props->>'kind' = 'work_session_idle' \
                                 AND prior.props->>'session_id' = (SELECT session_id FROM msg) \
                                 AND prior.props->'turn_started_ms' = (SELECT turn_started_ms FROM msg) \
                            ) \
                            AND NOT EXISTS ( \
                              SELECT 1 FROM read_state seen \
                               WHERE seen.workspace_id = $1 \
                                 AND seen.channel_id = (SELECT channel_id FROM msg) \
                                 AND seen.member_id = mem.id \
                                 AND seen.last_read_seq > 0 \
                                 AND ( seen.last_read_seq >= (SELECT seq FROM msg) \
                                       OR seen.last_read_at >= (SELECT created_at FROM msg) \
                                            - make_interval(secs => $4::double precision) ) \
                            ) \
                        THEN 'work_session_idle' END \
                    WHEN (SELECT message_type FROM msg) = 'approval_request' \
                         AND mem.kind = 'human' THEN 'approval_request' \
                    WHEN EXISTS ( \
                      SELECT 1 FROM jsonb_array_elements_text((SELECT mention_ids FROM msg)) t(v) \
                       WHERE lower(t.v) = lower(ms.member_id::text) \
                    ) THEN 'mention' \
                    WHEN (SELECT channel_kind FROM msg) = 'dm' THEN 'dm' \
                    ELSE NULL \
                  END AS reason \
             FROM membership ms \
             JOIN member mem \
               ON mem.id = ms.member_id \
              AND mem.workspace_id = $1 \
              AND mem.status = 'active' \
              AND mem.deleted_at IS NULL \
              AND mem.kind = 'human' \
            WHERE ms.channel_id = (SELECT channel_id FROM msg) \
              AND ms.workspace_id = $1 \
              AND ms.left_at IS NULL \
              AND ( \
                ms.member_id <> (SELECT author_member_id FROM msg) \
                OR (SELECT props_kind FROM msg) IN ('resume_offer', 'work_session_idle') \
              ) \
         ) \
         SELECT r.member_id, \
                t.id AS token_id, \
                d.id AS device_id, \
                d.platform::text AS platform, \
                t.apns_token, \
                t.env::text AS env, \
                t.topic, \
                r.reason, \
                COALESCE((SELECT root_id FROM msg), (SELECT channel_id FROM msg)) AS thread_id, \
                (SELECT message_type FROM msg) AS message_type, \
                (SELECT props_kind FROM msg) AS props_kind, \
                a.id AS approval_id \
           FROM recipients r \
           JOIN push_token t \
             ON t.member_id = r.member_id \
            AND t.workspace_id = $1 \
            AND t.invalidated_at IS NULL \
           JOIN device d \
             ON d.id = t.device_id \
            AND d.workspace_id = $1 \
           LEFT JOIN notification_pref np \
             ON np.workspace_id = $1 \
            AND np.channel_id = (SELECT channel_id FROM msg) \
            AND np.member_id = r.member_id \
           LEFT JOIN notification_rule nr \
             ON nr.workspace_id = $1 \
            AND nr.member_id = r.member_id \
           LEFT JOIN approval a \
             ON a.workspace_id = $1 \
            AND a.request_message_id = $2 \
          WHERE r.reason IS NOT NULL \
            AND NOT ( \
              COALESCE(nr.dnd, false) \
              AND (nr.dnd_until IS NULL OR nr.dnd_until > now()) \
            ) \
            AND NOT (r.reason = 'work_session_idle' AND NOT COALESCE(nr.work_complete_push, true)) \
            AND ( \
              np.member_id IS NULL \
              OR (np.muted_until IS NOT NULL AND np.muted_until <= now()) \
              OR (r.reason = 'mention' AND COALESCE(nr.mention_overrides_mute, false)) \
            ) \
          ORDER BY r.member_id, t.id",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(WORK_COMPLETE_MIN_RAN_MS)
    .bind(WORK_COMPLETE_FOREGROUND_WINDOW_SECS)
    .fetch_all(&mut *conn)
    .await?;

    let mut targets = Vec::with_capacity(rows.len());
    for row in rows {
        let reason_label: String = row.get("reason");
        let Some(reason) = PushReason::from_db(&reason_label) else {
            // An unknown reason means the judgment SQL and this enum drifted.
            // Dropping the target silently would be a lost notification, so
            // treat it as a decode failure and let the candidate retry.
            return Err(DbError::Sqlx(sqlx::Error::Decode(
                format!("unknown push reason from judgment: {reason_label}").into(),
            )));
        };
        let message_type: String = row.get("message_type");
        let props_kind: Option<String> = row.get("props_kind");
        let category = category_for(&message_type, props_kind.as_deref(), reason);

        targets.push(JudgedTarget {
            member_id: row.get("member_id"),
            token_id: row.get("token_id"),
            device_id: row.get("device_id"),
            device_platform: row.get("platform"),
            apns_token: row.get("apns_token"),
            apns_env: row.get("env"),
            apns_topic: row.get("topic"),
            reason,
            thread_id: row.get("thread_id"),
            category,
            // An approval id is meaningful only for the approval category —
            // the relay and the NSE both reject the pair otherwise.
            approval_id: if category == PushCategory::Approval {
                row.get("approval_id")
            } else {
                None
            },
        });
    }
    Ok(targets)
}

/// The ADR-0109 badge: the server-owned unread projection summed across every
/// active channel membership.
///
/// Deliberately the same `channel_seq`/`read_state` formula as
/// `GET /read-state` — clients and the notifier never derive unread from a
/// local message cache, so the number on the app icon and the number in the app
/// cannot disagree.
pub async fn unread_badge(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<i64, DbError> {
    let badge: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(GREATEST( \
                  COALESCE(cs.last_seq, 0) - COALESCE(rs.last_read_seq, 0), \
                  0 \
                )), 0)::bigint \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
           JOIN channel_seq cs \
             ON cs.channel_id = c.id \
            AND cs.workspace_id = $1 \
           LEFT JOIN read_state rs \
             ON rs.channel_id = ms.channel_id \
            AND rs.member_id = ms.member_id \
            AND rs.workspace_id = $1 \
          WHERE ms.workspace_id = $1 \
            AND ms.member_id = $2 \
            AND ms.left_at IS NULL",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(badge.unwrap_or(0))
}
