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

use momo_db::PgConnection;
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

fn window_from_row(row: &sqlx::postgres::PgRow) -> Result<ControlWindow, T3Error> {
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
        let renewed = renew_control_window_in_tx(conn, workspace_id, existing.id).await?;
        return Ok(Ok(renewed.unwrap_or(existing)));
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

/// Push a standing window's lease out by one full interval, by id.
async fn renew_control_window_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    window_id: Uuid,
) -> Result<Option<ControlWindow>, T3Error> {
    let row = sqlx::query(&format!(
        "UPDATE display_control_window \
            SET lease_expires_at = clock_timestamp() \
                + make_interval(secs => $3::double precision) \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND ended_at IS NULL \
        RETURNING {WINDOW_COLUMNS}"
    ))
    .bind(workspace_id)
    .bind(window_id)
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

/// The session-end arm of the same close, addressed by session across every
/// workspace-scoped caller that ends sessions in bulk.
///
/// Separate from [`close_control_window_in_tx`] only in that it answers a count
/// rather than a row: the lifecycle paths that call it end many sessions at once
/// and have no single window to report.
pub async fn close_control_windows_for_sessions_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_ids: &[Uuid],
) -> Result<u64, T3Error> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let closed = sqlx::query(
        "UPDATE display_control_window \
            SET ended_at = clock_timestamp(), end_reason = 'session_ended' \
          WHERE workspace_id = $1 \
            AND work_session_id = ANY($2) \
            AND ended_at IS NULL",
    )
    .bind(workspace_id)
    .bind(session_ids)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(closed)
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
