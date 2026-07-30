//! Session **reattach + replay** (ADR-0139) — the server half.
//!
//! ## What ADR-0139 actually asks the server for
//!
//! D2 rejected server-side scrollback: the PTY ring buffer lives on the host and
//! `connect(ptyID)` replays it before splicing the live stream, so the server
//! still never touches terminal bytes (D10 unchanged, and
//! `docs/security/README.ko.md`'s "실행 내용 미보관" stays true). What the
//! server owes a returning client is therefore not bytes but **the session's
//! durable record**: is it still there, may I attach, and what happened in its
//! thread while I was away.
//!
//! Both halves already exist as measured Swift surfaces, and this module is
//! their composition — no new storage, no new migration:
//!
//! | half | Swift source | ported by |
//! |---|---|---|
//! | session snapshot + attach verdict | `WorkSessionRoutes.list` projection (:2038-2087) + `TerminalAttachRoutes.issue` gate (:209-216) | [`load_session_reattach_state_in_tx`] |
//! | thread replay, oldest-first seq cursor | `MessageRoutes.replies` (:521-620) | [`list_session_events_in_tx`] |
//!
//! ## Why the cursor is `message.seq` and not a timestamp
//!
//! Invariant #3 makes `message.seq` the order source of truth, and
//! `channel_seq`'s row-locked `UPDATE … RETURNING` makes it gapless and
//! strictly increasing per channel. A replay cursor built on it can therefore
//! promise **exactly once, in order, with no gap** across an arbitrary number of
//! pages.
//!
//! A wall-clock cursor cannot promise any of the three. `created_at` is
//! `clock_timestamp()`, so two events written inside the same tick share a
//! value: `created_at > cursor` silently drops every sibling of the row the
//! client stopped on, and `>=` re-delivers it. That is not a theoretical
//! concern here — a tool that emits a burst of ACP events lands several rows in
//! one millisecond, and the visible symptom is a reattached terminal missing a
//! step it never saw. `tests/…/reattach_smoke_pg.rs` pins exactly this by
//! seeding two events with an identical `created_at` and asserting both survive
//! paging.
//!
//! ## ADR-0139 D3: reattach and lineage resume are different words
//!
//! Host alive + `running|idle` → **reattach** (same PTY, host-side replay).
//! Host gone → `orphaned` → **resume** on a new host, with no PTY state carried
//! over and uncommitted work declared lost. [`ReattachVerdict`] is that branch,
//! computed once here so no client re-derives it and no UI puts both behind one
//! button.

use momo_db::PgConnection;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;
use crate::lifecycle::WorkSessionDetail;
use crate::terminal_attach::{validated_binding, RemotePtyBinding};

/// Default replay page size (`MessageRoutes.replies` `?? 50`, :529).
pub const REPLAY_LIMIT_DEFAULT: i64 = 50;
/// Maximum replay page size (Swift `min(max(…, 1), 200)`, :529).
pub const REPLAY_LIMIT_MAX: i64 = 200;

/// Clamp a client-supplied page size to `1..=200`, defaulting to 50 — the Swift
/// clamp byte for byte, so a client cannot widen the page by asking.
pub fn clamp_replay_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(REPLAY_LIMIT_DEFAULT)
        .clamp(1, REPLAY_LIMIT_MAX)
}

/// ADR-0139 D3's branch, decided server-side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReattachVerdict {
    /// The host is alive and the session is `running`/`idle` with a live PTY
    /// binding: "이어서 보기/쓰기".
    Reattach,
    /// The host is gone (`orphaned`): "새 호스트에서 재개" — a *different* act,
    /// with its own REST call and its own loss disclosure.
    ResumeLineage,
    /// Ended, or alive with nothing to attach to. Replay still works; there is
    /// simply no terminal to return to.
    ReplayOnly,
}

/// Everything a returning client needs about the session itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionReattachState {
    pub session: WorkSessionDetail,
    /// `work_session.root_message_id`'s `seq` — the anchor a client pages from
    /// when it holds no cursor of its own.
    pub root_message_seq: i64,
    /// The highest `seq` in this session's thread, or `None` when the card has
    /// no replies yet. A client that already holds this cursor is up to date.
    pub last_event_seq: Option<i64>,
    pub host_revoked: bool,
    /// `work_host.last_seen_at` inside the heartbeat window (`ONLINE_WINDOW`,
    /// 021) — the same column `WorkHostRoutes` publishes as `online`.
    pub host_online: bool,
    /// The stored PTY binding, re-validated on read.
    pub binding: Option<RemotePtyBinding>,
}

impl SessionReattachState {
    /// ADR-0139 D3. Deliberately does **not** consult `host_online`: the ledger
    /// decides whether a reattach is offered, and a heartbeat that has not
    /// landed yet is reported separately (`host_online`) so a client can warn
    /// without the server pretending the session is gone. This mirrors the web
    /// client's measured note that `last_seen_at` is written by exactly one
    /// endpoint and is routinely absent on hosts that are demonstrably relaying.
    pub fn verdict(&self) -> ReattachVerdict {
        match self.session.status.as_str() {
            "running" | "idle" if !self.host_revoked && self.binding.is_some() => {
                ReattachVerdict::Reattach
            }
            "orphaned" => ReattachVerdict::ResumeLineage,
            _ => ReattachVerdict::ReplayOnly,
        }
    }
}

/// The session projection this module reads. Shares
/// [`crate::lifecycle::WorkSessionDetail`]'s columns so the reattach snapshot
/// and the session list can never describe the same row differently, and adds
/// only what the reattach decision needs.
///
/// `observer_grant_count` is `list_work_session_details_in_tx`'s expression
/// verbatim, gating included: a grant counts only while the session is live and
/// `open` on an unrevoked host, and only if its grantee is still an active human
/// in the channel. Copying the gate rather than the bare `count(*)` is the
/// point — two surfaces reporting different observer counts for the same
/// session is exactly the drift this projection exists to prevent.
const REATTACH_COLUMNS: &str = "ws.id, ws.workspace_id, ws.channel_id, ws.member_id, ws.host_id, \
     ws.root_message_id, ws.tool, ws.label, ws.status, ws.observation, \
     CASE \
       WHEN ws.status IN ('running', 'idle') \
        AND ws.observation = 'open' \
        AND h.revoked_at IS NULL \
       THEN ( \
         SELECT count(*) \
           FROM terminal_attach_capability tac \
           JOIN member observer \
             ON observer.id = tac.owner_member_id \
            AND observer.workspace_id = tac.workspace_id \
            AND observer.kind = 'human' \
            AND observer.status = 'active' \
            AND observer.deleted_at IS NULL \
           JOIN membership observer_membership \
             ON observer_membership.workspace_id = tac.workspace_id \
            AND observer_membership.channel_id = ws.channel_id \
            AND observer_membership.member_id = tac.owner_member_id \
            AND observer_membership.left_at IS NULL \
          WHERE tac.work_session_id = ws.id \
            AND tac.mode = 'observer' \
            AND tac.expires_at > clock_timestamp()) \
       ELSE 0 \
     END AS observer_grant_count, \
     (ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL) AS remote_attach_available, \
     floor(extract(epoch from ws.started_at) * 1000)::bigint AS started_at_ms, \
     CASE WHEN ws.ended_at IS NULL THEN NULL \
          ELSE floor(extract(epoch from ws.ended_at) * 1000)::bigint END AS ended_at_ms, \
     ws.exit_code, ws.end_reason, ws.resumed_from_session_id, \
     ws.pty_id, ws.attach_endpoint, \
     root.seq AS root_message_seq, \
     (h.revoked_at IS NOT NULL) AS host_revoked, \
     (h.last_seen_at IS NOT NULL \
      AND h.last_seen_at > clock_timestamp() - make_interval(secs => $3::double precision)) \
       AS host_online, \
     (SELECT max(m.seq) FROM message m \
       WHERE m.channel_id = ws.channel_id AND m.root_id = ws.root_message_id) AS last_event_seq";

/// Read the reattach snapshot. **No row lock**: reattaching is a read, and
/// taking `FOR UPDATE` here would let a returning client block the host that is
/// writing the session's next event.
///
/// `online_window_seconds` is passed in rather than hard-coded so the one
/// definition of "online" stays with the work-host registry
/// (`momo_auth::ONLINE_WINDOW_SECONDS`) instead of being copied into a second
/// crate.
pub async fn load_session_reattach_state_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    online_window_seconds: i64,
) -> Result<Option<SessionReattachState>, T3Error> {
    let sql = format!(
        "SELECT {REATTACH_COLUMNS} \
           FROM work_session ws \
           JOIN message root ON root.id = ws.root_message_id \
           JOIN work_host h \
             ON h.id = ws.host_id \
            AND h.workspace_id = ws.workspace_id \
          WHERE ws.workspace_id = $1 AND ws.id = $2"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(session_id)
        .bind(online_window_seconds as f64)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(None) };

    let pty_id: Option<String> = row.try_get("pty_id")?;
    let attach_endpoint: Option<String> = row.try_get("attach_endpoint")?;
    let session = WorkSessionDetail {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("channel_id")?,
        member_id: row.try_get("member_id")?,
        host_id: row.try_get("host_id")?,
        root_message_id: row.try_get("root_message_id")?,
        tool: row.try_get("tool")?,
        label: row.try_get("label")?,
        status: row.try_get("status")?,
        observation: row.try_get("observation")?,
        observer_grant_count: row.try_get("observer_grant_count")?,
        remote_attach_available: row.try_get("remote_attach_available")?,
        started_at_ms: row.try_get("started_at_ms")?,
        ended_at_ms: row.try_get("ended_at_ms")?,
        exit_code: row.try_get("exit_code")?,
        end_reason: row.try_get("end_reason")?,
        resumed_from_session_id: row.try_get("resumed_from_session_id")?,
    };
    Ok(Some(SessionReattachState {
        session,
        root_message_seq: row.try_get("root_message_seq")?,
        last_event_seq: row.try_get("last_event_seq")?,
        host_revoked: row.try_get("host_revoked")?,
        host_online: row.try_get("host_online")?,
        binding: validated_binding(pty_id.as_deref(), attach_endpoint.as_deref()),
    }))
}

/// One replayed thread row. The projection is `MessageRoutes.replies`'s
/// (:566-583) minus attachments, which no work-session event carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvent {
    pub id: Uuid,
    pub seq: i64,
    pub hlc_ts: i64,
    pub hlc_count: i32,
    pub author_member_id: Uuid,
    pub message_type: String,
    pub body: Option<String>,
    pub props: Value,
    pub state: String,
    pub created_at_ms: i64,
}

/// Replay a session's thread, oldest-first, strictly after `cursor`.
///
/// Two properties are structural rather than conventional:
///
/// * **It cannot read another thread.** The `message` join hangs off the
///   `work_session` row itself (`m.channel_id = ws.channel_id AND m.root_id =
///   ws.root_message_id`), so the session id in the path is the only thing that
///   selects rows. There is no channel or root parameter to point elsewhere.
/// * **It cannot skip or repeat.** `seq > cursor` on a gapless, per-channel
///   monotonic counter, ordered by the same column (module docs).
///
/// Tombstones stay visible (no `deleted_at` filter, matching Swift `replies`)
/// so a returning client converges on deletions instead of keeping a message the
/// author has since removed.
///
/// The caller asks for `limit + 1` semantics itself: this returns at most
/// `limit` rows and the caller pages by the last `seq`. Keeping the `+1`
/// look-ahead out of the domain API means "is there more" is answered by the
/// route in exactly one place (Swift `hasMore`, :617-619).
pub async fn list_session_events_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    cursor: Option<i64>,
    limit: i64,
) -> Result<Vec<SessionEvent>, T3Error> {
    let rows = sqlx::query(
        "SELECT m.id, m.seq, m.hlc_ts, m.hlc_count, m.author_member_id, \
                m.type::text AS message_type, m.body, m.props, m.state::text AS state, \
                floor(extract(epoch from m.created_at) * 1000)::bigint AS created_at_ms \
           FROM work_session ws \
           JOIN message m \
             ON m.channel_id = ws.channel_id \
            AND m.root_id = ws.root_message_id \
          WHERE ws.workspace_id = $1 \
            AND ws.id = $2 \
            AND m.seq > $3 \
          ORDER BY m.seq ASC \
          LIMIT $4",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(cursor.unwrap_or(0))
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;

    rows.iter()
        .map(|row| {
            Ok(SessionEvent {
                id: row.try_get("id")?,
                seq: row.try_get("seq")?,
                hlc_ts: row.try_get("hlc_ts")?,
                hlc_count: row.try_get("hlc_count")?,
                author_member_id: row.try_get("author_member_id")?,
                message_type: row.try_get("message_type")?,
                body: row.try_get("body")?,
                props: row.try_get("props")?,
                state: row.try_get("state")?,
                created_at_ms: row.try_get("created_at_ms")?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(status: &str, host_revoked: bool, bound: bool) -> SessionReattachState {
        SessionReattachState {
            session: WorkSessionDetail {
                id: Uuid::from_u128(1),
                workspace_id: Uuid::from_u128(2),
                channel_id: Uuid::from_u128(3),
                member_id: Uuid::from_u128(4),
                host_id: Uuid::from_u128(5),
                root_message_id: Uuid::from_u128(6),
                tool: "claude".into(),
                label: "run".into(),
                status: status.into(),
                observation: "open".into(),
                observer_grant_count: 0,
                remote_attach_available: bound,
                started_at_ms: 1_700_000_000_000,
                ended_at_ms: None,
                exit_code: None,
                end_reason: None,
                resumed_from_session_id: None,
            },
            root_message_seq: 4,
            last_event_seq: Some(9),
            host_revoked,
            host_online: true,
            binding: bound.then(|| RemotePtyBinding {
                pty_id: "pty".into(),
                attach_endpoint: "wss://host.example/attach".into(),
            }),
        }
    }

    #[test]
    fn replay_limit_clamps_to_the_swift_bounds() {
        assert_eq!(clamp_replay_limit(None), 50);
        assert_eq!(clamp_replay_limit(Some(0)), 1);
        assert_eq!(clamp_replay_limit(Some(-9)), 1);
        assert_eq!(clamp_replay_limit(Some(75)), 75);
        assert_eq!(clamp_replay_limit(Some(10_000)), 200);
    }

    /// ADR-0139 D3: the two acts must never collapse into one answer.
    #[test]
    fn verdict_separates_reattach_from_lineage_resume() {
        assert_eq!(
            state("running", false, true).verdict(),
            ReattachVerdict::Reattach
        );
        assert_eq!(
            state("idle", false, true).verdict(),
            ReattachVerdict::Reattach,
            "idle keeps the PTY — that is the state's whole purpose"
        );
        assert_eq!(
            state("orphaned", false, true).verdict(),
            ReattachVerdict::ResumeLineage,
            "a dead host is a lineage resume, not an attach"
        );
        assert_eq!(
            state("ended", false, true).verdict(),
            ReattachVerdict::ReplayOnly
        );
        assert_eq!(
            state("running", true, true).verdict(),
            ReattachVerdict::ReplayOnly,
            "a revoked host is not attachable, and is not an orphan either"
        );
        assert_eq!(
            state("running", false, false).verdict(),
            ReattachVerdict::ReplayOnly,
            "a live session with no PTY binding has nothing to attach to"
        );
    }

    /// A heartbeat gap must not be allowed to erase a session from the ledger's
    /// point of view — it is reported, never decisive.
    #[test]
    fn verdict_ignores_host_online() {
        let mut offline = state("running", false, true);
        offline.host_online = false;
        assert_eq!(offline.verdict(), ReattachVerdict::Reattach);
    }
}
