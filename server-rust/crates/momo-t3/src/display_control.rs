//! The **control window** ledger — ADR-0004 증보 3's boundary, as rows.
//!
//! [`crate::terminal_attach`] mints the grant that lets a person type into a
//! live screen. This module is the other half of that act: while such a grant is
//! live, something must be TRUE about the rest of the system, and 076's
//! `display_control_window` is where that something is written down.
//!
//! ## What a window is
//!
//! A window opens when the session owner is minted a `display`/`controller`
//! capability and closes by exactly three routes, all of them here:
//!
//! | close | reason | who causes it |
//! |---|---|---|
//! | explicit return | `returned` | the person, over REST |
//! | lease lapse | `expired` | nobody — the producer stopped re-validating |
//! | session end | `session_ended` | the session's own lifecycle |
//!
//! All three are idempotent, and all three are **writes**: a window that is
//! merely stale-by-clock still gets its row closed with a reason, because
//! `정지 시각·재개 시각` (증보 3 D3) are facts an agent is entitled to learn and
//! a row that never says when it ended cannot tell anyone.
//!
//! `session_ended` is written by every route in `routes::work_sessions` that
//! takes a session away from underneath a keyboard — the end, the idempotent
//! 재종료 of a session something else already ended, and the resume that retires
//! a source session — through one shared arm so that "the agent resumed" is one
//! statement whichever of them caused it. The **bulk** lifecycle paths (the
//! offline sweep and `t3_terminate`) deliberately do not close windows: they
//! settle many sessions at once with no channel to announce into, and the lease
//! is the backstop that closes their windows with `expired` within one interval.
//! That is a ruled deviation and not an oversight, which is why there is no
//! session-array closer here for them to call.
//!
//! ## What a window is FOR
//!
//! One predicate, read by one caller that matters:
//! [`active_control_window_in_tx`], consulted by
//! `routes::work_controls::create` before an agent may act on the session at
//! all. That is 증보 3 D3's "기술적으로 차단" — not a policy sentence but a
//! refusal on the only server path an agent has to a work session.
//!
//! ## What a window deliberately cannot hold
//!
//! Keystrokes, frames, screenshots, a password, a 2FA code. 076 has no column
//! that could, and this module has no function that would. 증보 3 D2 makes the
//! user's credentials non-ingressing to transcript, audit, Memory Plane and
//! Context Packet alike, and the way that is guaranteed here is by there being
//! nowhere to put them. What this ledger knows is **who, when, and why it
//! ended**.
//!
//! ## Why the lease is not the capability's expiry
//!
//! 076's header carries the full argument. The short form: a capability's
//! `expires_at` bounds *dialling*, and a live stream re-validates with
//! `stream: true`, which skips that clause on purpose. Reading control liveness
//! off it would resume the agent sixty seconds into a login still in progress.
//! The lease here is renewed by that same re-validation
//! ([`renew_control_window_lease_in_tx`]), so control stays open exactly as long
//! as a producer keeps saying the stream is.

use momo_db::{DbError, PgConnection};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;

/// How long a control window stands on one renewal.
///
/// The producer re-validates every 30 seconds (`terminal_attach`'s module
/// header), so this is three missed re-validations. The number is a tradeoff
/// with a named safe side: too short and a person loses control mid-password on
/// one dropped poll; too long and an agent stays blocked after the person walked
/// away. Blocking the agent is the recoverable failure — it costs a stall, while
/// the other direction costs exactly the capture 증보 3 D3 forbids — so this is
/// generous relative to the poll and short relative to a human's patience.
pub const CONTROL_WINDOW_LEASE_SECONDS: i64 = 90;

/// `display_control_window.end_reason`, 076's closed vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlWindowEndReason {
    /// The person handed control back (explicit REST).
    Returned,
    /// The lease lapsed — the producer stopped re-validating.
    Expired,
    /// The work session ended underneath the window.
    SessionEnded,
}

impl ControlWindowEndReason {
    pub fn as_db_label(self) -> &'static str {
        match self {
            ControlWindowEndReason::Returned => "returned",
            ControlWindowEndReason::Expired => "expired",
            ControlWindowEndReason::SessionEnded => "session_ended",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "returned" => Some(ControlWindowEndReason::Returned),
            "expired" => Some(ControlWindowEndReason::Expired),
            "session_ended" => Some(ControlWindowEndReason::SessionEnded),
            _ => None,
        }
    }
}

/// A window, as every caller here reads it.
///
/// Timestamps are milliseconds because that is what every envelope and audit
/// detail in this workspace carries, and rendering them in PostgreSQL keeps one
/// clock in the story — the same reason `issue_attach_capability_in_tx` lets the
/// database compute `expires_at`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlWindow {
    pub id: Uuid,
    pub work_session_id: Uuid,
    pub grantee_member_id: Uuid,
    pub started_at_ms: i64,
    pub lease_expires_at_ms: i64,
    /// `None` while the window stands.
    pub ended_at_ms: Option<i64>,
    pub end_reason: Option<ControlWindowEndReason>,
}

/// The column list every read below shares, so one row shape cannot drift into
/// two.
const WINDOW_COLUMNS: &str = "id, work_session_id, grantee_member_id, \
     floor(extract(epoch from started_at) * 1000)::bigint AS started_at_ms, \
     floor(extract(epoch from lease_expires_at) * 1000)::bigint AS lease_expires_at_ms, \
     floor(extract(epoch from ended_at) * 1000)::bigint AS ended_at_ms, \
     end_reason";

/// Decode to the row shape, in the error type sqlx speaks.
///
/// Split from [`window_from_row`] so the sweep-facing readers below can answer
/// in [`DbError`] without a `T3Error` → `DbError` conversion that does not exist
/// and should not: a decode failure is not an ADR-0140 enforcement point, and
/// [`crate::error::classify_pg`] would have nothing to say about it.
fn decode_window(row: &sqlx::postgres::PgRow) -> Result<ControlWindow, sqlx::Error> {
    let reason: Option<String> = row.try_get("end_reason")?;
    Ok(ControlWindow {
        id: row.try_get("id")?,
        work_session_id: row.try_get("work_session_id")?,
        grantee_member_id: row.try_get("grantee_member_id")?,
        started_at_ms: row.try_get("started_at_ms")?,
        lease_expires_at_ms: row.try_get("lease_expires_at_ms")?,
        ended_at_ms: row.try_get("ended_at_ms")?,
        end_reason: reason
            .as_deref()
            .and_then(ControlWindowEndReason::from_db_label),
    })
}

fn window_from_row(row: &sqlx::postgres::PgRow) -> Result<ControlWindow, T3Error> {
    Ok(decode_window(row)?)
}

/// Close every window on this session whose lease has lapsed.
///
/// Called before every read that matters, so the ledger is reconciled **by use**
/// rather than by a timer — the pattern
/// `sweep_spent_observer_capabilities_in_tx` already establishes for this
/// family of rows. Doing it as a write rather than letting the predicate simply
/// return "not active" is the point: an agent asking why it was blocked, and an
/// operator reading the boundary events back, both need the row to say when the
/// window ended and why.
pub async fn expire_lapsed_control_windows_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Vec<ControlWindow>, T3Error> {
    let rows = sqlx::query(&format!(
        "UPDATE display_control_window \
            SET ended_at = clock_timestamp(), end_reason = 'expired' \
          WHERE workspace_id = $1 \
            AND work_session_id = $2 \
            AND ended_at IS NULL \
            AND lease_expires_at <= clock_timestamp() \
        RETURNING {WINDOW_COLUMNS}"
    ))
    .bind(workspace_id)
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(window_from_row).collect()
}

/// The predicate the agent's run path is refused by.
///
/// **Does not reconcile.** Callers that can afford a write call
/// [`expire_lapsed_control_windows_in_tx`] first; this one is deliberately a
/// pure read that already excludes a lapsed lease, so a caller who forgets the
/// sweep gets the right answer about *now* and only loses the history row.
/// Fail-closed is not a concern in that direction: a lapsed window reads as
/// inactive either way, and an unlapsed one reads as active either way.
pub async fn active_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<ControlWindow>, T3Error> {
    let row = sqlx::query(&format!(
        "SELECT {WINDOW_COLUMNS} \
           FROM display_control_window \
          WHERE workspace_id = $1 \
            AND work_session_id = $2 \
            AND ended_at IS NULL \
            AND lease_expires_at > clock_timestamp() \
          LIMIT 1"
    ))
    .bind(workspace_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(window_from_row).transpose()
}

/// Open a window for a freshly minted controller grant.
///
/// The caller holds `FOR UPDATE` on the session row
/// (`lock_attach_target_in_tx`), so two people racing to take control serialize
/// here and the second sees the first's row rather than colliding with
/// `display_control_window_open_uniq`. Returning `Err(existing)` rather than
/// silently joining somebody else's window is deliberate: control is a person's
/// act, and two people typing into one screen is a state 076's unique index
/// exists to make unrepresentable.
///
/// Re-opening by the **same** grantee is idempotent — it renews and returns the
/// standing window. That is the shape a client retry has, and minting a second
/// row for it would make "정지 시각" ambiguous for the agent.
///
/// ## Why the re-open REBINDS the window instead of only renewing it
///
/// Every issue mints a **new** capability row (`issue_attach_capability_in_tx`
/// inserts unconditionally), and the only renewal a live stream has is keyed by
/// `capability_id` ([`renew_control_window_lease_in_tx`]). So a window left
/// pointing at the *previous* grant is a window no producer can keep alive: the
/// client that timed out and re-dialled now holds token B, the row still names
/// token A, B's re-validation matches nothing, and the person is told
/// `input_enabled: false` while the lease starves to death 90 seconds into the
/// login they are still typing. That is the failure ADR-0004 증보 3 D3 exists to
/// prevent, arriving by the one door a retry always opens.
///
/// Moving `capability_id` onto the new grant is therefore the fix and also the
/// invariant: **the newest grant, and only the newest grant, holds the
/// keyboard.** Token A's renewal now matches zero rows, which is the correct
/// consequence and not a casualty — a bearer the client has already replaced
/// must not be able to hold input open, and `input_enabled: false` for A is the
/// same sentence the return path relies on.
///
/// The window's `id` and `started_at` do **not** move. It is the same window —
/// the person never let go — so 정지 시각 keeps its value and no new boundary
/// event is owed.
pub async fn open_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    grantee_member_id: Uuid,
    capability_id: Uuid,
) -> Result<Result<ControlWindow, ControlWindow>, T3Error> {
    expire_lapsed_control_windows_in_tx(conn, workspace_id, session_id).await?;

    if let Some(existing) = active_control_window_in_tx(conn, workspace_id, session_id).await? {
        if existing.grantee_member_id != grantee_member_id {
            return Ok(Err(existing));
        }
        let rebound =
            rebind_control_window_in_tx(conn, workspace_id, existing.id, capability_id).await?;
        return Ok(Ok(rebound.unwrap_or(existing)));
    }

    let row = sqlx::query(&format!(
        "INSERT INTO display_control_window \
           (workspace_id, work_session_id, grantee_member_id, capability_id, lease_expires_at) \
         VALUES ($1, $2, $3, $4, \
                 clock_timestamp() + make_interval(secs => $5::double precision)) \
         RETURNING {WINDOW_COLUMNS}"
    ))
    .bind(workspace_id)
    .bind(session_id)
    .bind(grantee_member_id)
    .bind(capability_id)
    .bind(CONTROL_WINDOW_LEASE_SECONDS as f64)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Ok(window_from_row(&row)?))
}

/// Move a standing window onto the grant that was just minted for it, and push
/// its lease out by one full interval.
///
/// Both halves are one statement because they are one fact: the producer that
/// will keep this window alive from now on is the one holding the new bearer,
/// and a rebind without a renewal would hand it a lease already most of the way
/// spent. `ended_at IS NULL` keeps a closed window closed — a re-open racing a
/// return must mint a fresh row through the INSERT arm rather than resurrect
/// this one, or `end_reason` would be a lie about a window that never ended.
async fn rebind_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    window_id: Uuid,
    capability_id: Uuid,
) -> Result<Option<ControlWindow>, T3Error> {
    let row = sqlx::query(&format!(
        "UPDATE display_control_window \
            SET capability_id = $3, \
                lease_expires_at = clock_timestamp() \
                + make_interval(secs => $4::double precision) \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND ended_at IS NULL \
        RETURNING {WINDOW_COLUMNS}"
    ))
    .bind(workspace_id)
    .bind(window_id)
    .bind(capability_id)
    .bind(CONTROL_WINDOW_LEASE_SECONDS as f64)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(window_from_row).transpose()
}

/// Renew the window a **re-validating producer** is keeping alive.
///
/// Keyed by the capability the producer presented, not by the session, so a
/// stale bearer for a window that has already closed and reopened under someone
/// else cannot hold the new window open. This is the only renewal path a live
/// stream has, and it is what makes the lease mean "the producer still says this
/// stream is up".
///
/// Because the key is the capability, a **superseded** bearer answers `None`
/// here too: a re-open by the same person rebinds the window to the grant that
/// re-open minted ([`open_control_window_in_tx`]), and the bearer the client
/// replaced stops renewing from that moment. That is the intent — the newest
/// grant holds the keyboard, and `input_enabled` goes false for the old one on
/// its next re-validation, exactly as it does after a return.
pub async fn renew_control_window_lease_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    capability_id: Uuid,
) -> Result<Option<ControlWindow>, T3Error> {
    let row = sqlx::query(&format!(
        "UPDATE display_control_window \
            SET lease_expires_at = clock_timestamp() \
                + make_interval(secs => $3::double precision) \
          WHERE workspace_id = $1 \
            AND capability_id = $2 \
            AND ended_at IS NULL \
        RETURNING {WINDOW_COLUMNS}"
    ))
    .bind(workspace_id)
    .bind(capability_id)
    .bind(CONTROL_WINDOW_LEASE_SECONDS as f64)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(window_from_row).transpose()
}

/// Close whatever window stands on this session.
///
/// Idempotent by construction: `ended_at IS NULL` in the predicate means a
/// second call updates nothing and answers `None`, which every caller treats as
/// success. That is what makes the return route safe to retry and the
/// session-end path safe to run on a session that never had a window.
pub async fn close_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    reason: ControlWindowEndReason,
) -> Result<Option<ControlWindow>, T3Error> {
    let row = sqlx::query(&format!(
        "UPDATE display_control_window \
            SET ended_at = clock_timestamp(), end_reason = $3 \
          WHERE workspace_id = $1 \
            AND work_session_id = $2 \
            AND ended_at IS NULL \
        RETURNING {WINDOW_COLUMNS}"
    ))
    .bind(workspace_id)
    .bind(session_id)
    .bind(reason.as_db_label())
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(window_from_row).transpose()
}

// ---------------------------------------------------------------------------
// the close, for the two callers that are not a route (#1425)
//
// A lapse is the one close nobody performs. LIVE-3 announced it from wherever it
// happened to be detected — a route reading the ledger — which was enough while
// the only consequence was a gate that reads `NOT EXISTS`. It stopped being
// enough the moment a window started **parking runs**: a run parked by a window
// whose producer then died is resumed by whoever next reads that session, and on
// the agent's own path there is no such reader. `work_controls::create` judges
// the run's eligibility *above* the window sweep, so a parked run is refused
// before it can reach the statement that would have freed it.
//
// So the lapse needs an author that runs whether or not anybody looks — the same
// argument, in the same shape, that `momo-notifier`'s approval sweep is built on
// — and that author needs the two reads below plus the payload builder the
// routes use, so that "the agent resumed" is one envelope with one shape
// wherever it is written.
// ---------------------------------------------------------------------------

/// `audit_log.action` for a control window closing (ADR-0004 증보 3).
pub const AUDIT_ACTION_CONTROL_CLOSED: &str = "work.display_control.closed";
/// `detail.schema` for that row.
pub const AUDIT_SCHEMA_CONTROL_CLOSED: &str = "momo.work.display_control.closed.v1";

/// The `work.session.control` envelope — the **boundary event**, and the only
/// thing about a control window that leaves this workspace.
///
/// ADR-0004 증보 3 D3 names exactly what an agent may learn while a person is
/// typing: 정지 시각, 재개 시각, and that the intervention finished. This
/// carries those three and nothing more. There is no frame here, no keystroke,
/// no endpoint and no bearer — the same count-only discipline
/// `routes::terminal_attach::observer_payload` keeps for 관전자 수, one boundary
/// over.
///
/// `grantee` is deliberately absent. Who is at the keyboard is a fact for the
/// audit log, which is scoped to people who may read it; the broadcast goes to
/// every member of the channel, and "someone has control" is all any of them —
/// or the agent — needs in order to behave correctly.
///
/// Takes the Centrifugo channel as a **string** rather than building it from
/// ids, because `cent_channel` belongs to `momo-messaging` and this crate has no
/// business growing a dependency on the message spine to render one field. Both
/// callers already hold the channel for the `emit_outbox` beside this.
pub fn control_window_payload(channel: &str, window: &ControlWindow, open: bool) -> Value {
    let state = if open { "opened" } else { "closed" };
    let timestamp_ms = window.ended_at_ms.unwrap_or(window.started_at_ms);
    let mut payload = json!({
        "session_id": window.work_session_id.to_string(),
        "state": state,
        "started_at": window.started_at_ms,
    });
    if let Some(ended_at_ms) = window.ended_at_ms {
        payload["ended_at"] = json!(ended_at_ms);
    }
    if let Some(reason) = window.end_reason {
        payload["end_reason"] = json!(reason.as_db_label());
    }
    json!({
        "channel": channel,
        "data": {
            "type": "work.session.control",
            "v": 1,
            "ts": timestamp_ms,
            "payload": payload,
        },
        // Keyed by window AND state so the open and the close are two distinct
        // events, and a retried close is one.
        "idempotency_key": format!("{channel}:work.session.control:{}:{state}", window.id),
    })
}

/// The newest window on this session, open or closed (LIVE-4).
///
/// Distinct from [`active_control_window_in_tx`], which asks the enforcement
/// question ("may the agent act right now") and therefore only ever returns a
/// window whose lease still stands. This one asks the **history** question that
/// 증보 3 D3 entitles an agent to: what happened to the person's intervention.
/// A closed window is the whole point of the read, so a predicate that filtered
/// it out would answer every real call with `None`.
///
/// It does **not** reconcile a lapsed lease first, and that is deliberate: the
/// caller is a tool executor reporting a boundary that has already been settled
/// by whichever close path ran, and a read that writes would put a second author
/// on rows the close paths own.
pub async fn latest_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<ControlWindow>, DbError> {
    let sql = format!(
        "SELECT {WINDOW_COLUMNS} \
           FROM display_control_window \
          WHERE workspace_id = $1 \
            AND work_session_id = $2 \
          ORDER BY started_at DESC \
          LIMIT 1"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
    // `decode_window` rather than `window_from_row`: this reader answers in
    // `DbError` for the reason that split exists (see `decode_window`), so the
    // agent worker can call it without a conversion that has no meaning.
    Ok(row.as_ref().map(decode_window).transpose()?)
}

/// Stamp a window's boundary facts onto the login handoff cards still waiting on
/// this session (LIVE-4).
///
/// ## Why the card and not only the envelope
///
/// [`control_window_payload`] already broadcasts the same three facts, and a
/// client watching the channel sees them the moment they happen. What it does
/// not survive is a reload: Centrifugo is transport, the ledger is the source of
/// truth (하드 불변식), and a card that only knows 정지 시각 because it happened
/// to be listening is a card that forgets. So the durable copy goes onto the row
/// the reader is looking at, exactly as `update_session_card_props_in_tx` keeps
/// the session card's props in step with the session.
///
/// ## Why the scope is this narrow
///
/// The predicate is three clauses deep on purpose. Only `approval_request` rows,
/// only rows whose `props.kind` is the caller's discriminator, and only rows
/// whose approval is **still pending** — a settled handoff has already told its
/// story and must not be rewritten by a later window on the same session. The
/// `props ||` merge adds keys and touches nothing else; body, seq, author and
/// every other prop are untouched.
///
/// Takes the props kind as a `&str` for the same reason
/// [`control_window_payload`] takes the channel as one: the vocabulary belongs
/// to `momo_agent::approval`, and this crate has no business depending on the
/// agent crate to write three numbers.
///
/// Returns how many cards were stamped, which is almost always zero — most
/// control windows have nothing to do with a login handoff.
pub async fn stamp_control_window_on_cards_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    props_kind: &str,
    window: &ControlWindow,
) -> Result<u64, DbError> {
    let mut facts = json!({ "control_started_at_ms": window.started_at_ms });
    if let Some(ended_at_ms) = window.ended_at_ms {
        facts["control_ended_at_ms"] = json!(ended_at_ms);
    }
    if let Some(reason) = window.end_reason {
        facts["control_end_reason"] = json!(reason.as_db_label());
    }
    let updated = sqlx::query(
        "UPDATE message m \
            SET props = m.props || $4::jsonb \
          WHERE m.workspace_id = $1 \
            AND m.type = 'approval_request' \
            AND m.props->>'kind' = $3 \
            AND m.props->>'session_id' = $2::text \
            AND EXISTS ( \
                  SELECT 1 FROM approval a \
                   WHERE a.workspace_id = m.workspace_id \
                     AND a.request_message_id = m.id \
                     AND a.status = 'pending')",
    )
    .bind(workspace_id)
    .bind(window.work_session_id)
    .bind(props_kind)
    .bind(&facts)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected())
}

/// A window this sweep closed, with the channel its boundary event goes to.
///
/// `channel_id` is not on `display_control_window` — it is the session's, joined
/// here rather than looked up afterwards so a closed window and the channel that
/// must hear about it cannot come apart across two statements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LapsedControlWindow {
    pub window: ControlWindow,
    pub channel_id: Uuid,
}

/// Every workspace that currently has a control window past its lease.
///
/// The sweep needs this because `app.workspace_id` is bound **per transaction**
/// (invariant #6): there is no cross-tenant scan, so the notifier asks which
/// tenants need visiting and then opens one tenant transaction each. Run with
/// the admin GUC, exactly like the T3 lifecycle sweep's candidate query and the
/// approval sweep's.
///
/// The predicate matches `display_control_window_active_idx`'s partial
/// condition, so this reads an index that contains only **open** windows — a set
/// bounded by the number of people typing into a live screen right now, not by
/// the table's history.
pub async fn workspaces_with_lapsed_control_windows(
    conn: &mut PgConnection,
    limit: i64,
) -> Result<Vec<Uuid>, DbError> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT workspace_id \
           FROM display_control_window \
          WHERE ended_at IS NULL \
            AND lease_expires_at <= clock_timestamp() \
          LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// Close every lapsed window in this workspace, whatever session it stands on.
///
/// [`expire_lapsed_control_windows_in_tx`]'s workspace-wide twin. The two are
/// separate statements rather than one with an optional session clause because
/// the session-scoped one is called on the hot path of a request that already
/// knows which session it is about, and an `IS NULL OR =` predicate there would
/// cost that path its index for a caller it does not have.
///
/// One statement, not a read followed by an update, so two sweeps racing settle
/// on the row lock: whichever gets there second sees `ended_at IS NOT NULL` and
/// returns nothing, and every consequence below is therefore written exactly
/// once per window.
pub async fn expire_lapsed_control_windows_for_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    limit: i64,
) -> Result<Vec<LapsedControlWindow>, DbError> {
    let rows = sqlx::query(&format!(
        "WITH lapsed AS ( \
           SELECT id FROM display_control_window \
            WHERE workspace_id = $1 \
              AND ended_at IS NULL \
              AND lease_expires_at <= clock_timestamp() \
            ORDER BY lease_expires_at \
            LIMIT $2 \
            FOR UPDATE SKIP LOCKED \
         ), closed AS ( \
           UPDATE display_control_window \
              SET ended_at = clock_timestamp(), end_reason = 'expired' \
            WHERE workspace_id = $1 \
              AND ended_at IS NULL \
              AND id IN (SELECT id FROM lapsed) \
           RETURNING {WINDOW_COLUMNS} \
         ) \
         SELECT closed.*, ws.channel_id \
           FROM closed \
           JOIN work_session ws ON ws.id = closed.work_session_id"
    ))
    .bind(workspace_id)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(LapsedControlWindow {
                window: decode_window(row)?,
                channel_id: row.try_get("channel_id")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_reasons_match_the_check_constraint_vocabulary() {
        for reason in [
            ControlWindowEndReason::Returned,
            ControlWindowEndReason::Expired,
            ControlWindowEndReason::SessionEnded,
        ] {
            assert_eq!(
                ControlWindowEndReason::from_db_label(reason.as_db_label()),
                Some(reason),
                "076 allows exactly these three"
            );
        }
        assert!(ControlWindowEndReason::from_db_label("revoked").is_none());
        assert!(ControlWindowEndReason::from_db_label("Returned").is_none());
    }

    /// The lease is not the capability TTL, and this is the assertion that says
    /// so rather than a comment that can be skimmed. If someone ever "tidies"
    /// the lease to reuse `CAPABILITY_TTL_SECONDS`, a live stream's control
    /// window starts lapsing inside the person's login (076's header).
    #[test]
    fn the_lease_outlives_the_dial_window_it_is_not() {
        // A `const` block so the relationship is checked when the crate is
        // COMPILED, not when the suite is run — the two numbers are constants,
        // and a constant that must stand in a fixed relation to another is
        // better guarded by the compiler than by a test somebody may filter out.
        const {
            assert!(
                CONTROL_WINDOW_LEASE_SECONDS > crate::terminal_attach::CAPABILITY_TTL_SECONDS,
                "a control window keyed to the 60s dial TTL would reopen the agent's \
                 screen access mid-login — ADR-0004 증보 3 D3"
            );
        }
        // And the second relation, against the producer's re-validation period:
        // the lease must survive more than one missed poll, or a single dropped
        // re-validation takes the keyboard away mid-password. 30s is the period
        // the template spec declares (`signalling.revalidateSeconds`).
        const PRODUCER_REVALIDATE_SECONDS: i64 = 30;
        const {
            assert!(
                CONTROL_WINDOW_LEASE_SECONDS >= PRODUCER_REVALIDATE_SECONDS * 3,
                "a lease shorter than three re-validations makes one dropped poll \
                 look like a person who walked away"
            );
        }
    }
}
