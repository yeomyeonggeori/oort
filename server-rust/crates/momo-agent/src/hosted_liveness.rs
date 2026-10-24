//! Is the hosted agent alive RIGHT NOW? (ADR-0200 D4, #3742)
//!
//! `hosted_agent_connection.status = 'active'` only says a token was proved once
//! (2026-10-10 in the incident). It says nothing about whether the runtime on the
//! other end is up. This module keeps the facts that do:
//!
//! * the **work** signals — the agent read its inbox, claimed a job, reported a
//!   run event — each written, throttled, by the Agent Port tool that did it;
//! * the **ping** — `oort_ping`, "I am alive", which proves a runtime is up and
//!   never that it takes work (kept on its own columns so the derived state can
//!   tell `alive_idle` from `responsive`);
//! * the last refused tool call with a closed code (for the human debugging
//!   "Agent Port unavailable").
//!
//! [`derive_liveness`] is pure and is the ONLY place the labels are decided.
//! The doorbell result and "is there work waiting" are inputs the route layer
//! reads from `momo-webhook` / `momo-outbox` (this crate owns neither table).
//!
//! Every write is throttled to one per column per 30 seconds inside the single
//! statement (`WHERE column < now() - 30s`), so a polling agent costs almost no
//! writes, and a throttled call is not an error.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Which work signals one successful tool call refreshes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Touch {
    pub inbox_read: bool,
    pub claim: bool,
    pub run_event: bool,
}

/// The `state` an `oort_ping` carries. Closed; nothing free-form is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PingState {
    Idle,
    Working,
}

impl PingState {
    pub fn as_db(self) -> &'static str {
        match self {
            PingState::Idle => "idle",
            PingState::Working => "working",
        }
    }

    pub fn from_wire(raw: &str) -> Option<PingState> {
        match raw {
            "idle" => Some(PingState::Idle),
            "working" => Some(PingState::Working),
            _ => None,
        }
    }
}

/// A successful tool call: `last_tool_call_at`, plus the work signals it earned.
/// Resolved by the caller's token, so it can only ever write the caller's own
/// active connection (a token that is not an active connection's current one
/// matches no row and writes nothing).
pub async fn record_tool_success_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    token_id: Uuid,
    touch: Touch,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO hosted_agent_liveness AS l \
            (workspace_id, connection_id, agent_member_id, \
             last_tool_call_at, last_inbox_read_at, last_claim_at, last_run_event_at) \
         SELECT hc.workspace_id, hc.id, hc.agent_member_id, now(), \
                CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END, \
                CASE WHEN $6 THEN now() END \
           FROM hosted_agent_connection hc \
          WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 \
            AND hc.active_token_id = $3 AND hc.status = 'active' \
         ON CONFLICT (workspace_id, connection_id) DO UPDATE SET \
            last_tool_call_at = CASE \
                WHEN l.last_tool_call_at IS NULL \
                  OR l.last_tool_call_at < now() - interval '30 seconds' \
                  OR l.last_tool_error_at > l.last_tool_call_at \
                THEN now() ELSE l.last_tool_call_at END, \
            last_inbox_read_at = CASE \
                WHEN $4 AND (l.last_inbox_read_at IS NULL \
                  OR l.last_inbox_read_at < now() - interval '30 seconds') \
                THEN now() ELSE l.last_inbox_read_at END, \
            last_claim_at = CASE \
                WHEN $5 AND (l.last_claim_at IS NULL \
                  OR l.last_claim_at < now() - interval '30 seconds') \
                THEN now() ELSE l.last_claim_at END, \
            last_run_event_at = CASE \
                WHEN $6 AND (l.last_run_event_at IS NULL \
                  OR l.last_run_event_at < now() - interval '30 seconds') \
                THEN now() ELSE l.last_run_event_at END, \
            updated_at = now() \
          WHERE l.last_tool_call_at IS NULL \
             OR l.last_tool_call_at < now() - interval '30 seconds' \
             OR l.last_tool_error_at > l.last_tool_call_at \
             OR ($4 AND (l.last_inbox_read_at IS NULL \
                  OR l.last_inbox_read_at < now() - interval '30 seconds')) \
             OR ($5 AND (l.last_claim_at IS NULL \
                  OR l.last_claim_at < now() - interval '30 seconds')) \
             OR ($6 AND (l.last_run_event_at IS NULL \
                  OR l.last_run_event_at < now() - interval '30 seconds'))",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(token_id)
    .bind(touch.inbox_read)
    .bind(touch.claim)
    .bind(touch.run_event)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `oort_ping`: record "alive" on THIS connection, at most once per 30 seconds.
/// `Ok(true)` = recorded, `Ok(false)` = throttled (not an error — a retry loop
/// must never be taught that the limit exists by failing).
pub async fn record_ping_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    agent_member_id: Uuid,
    state: PingState,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "INSERT INTO hosted_agent_liveness AS l \
            (workspace_id, connection_id, agent_member_id, last_ping_at, last_ping_state) \
         VALUES ($1, $2, $3, now(), $4) \
         ON CONFLICT (workspace_id, connection_id) DO UPDATE SET \
            last_ping_at = now(), last_ping_state = $4, updated_at = now() \
          WHERE l.last_ping_at IS NULL \
             OR l.last_ping_at < now() - interval '30 seconds'",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(state.as_db())
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// A refused tool call, by closed code (`unavailable`, `not_authorized`, …), on the
/// caller's own active connection. Throttled like everything else here — EXCEPT that a
/// refusal arriving after the previous one was already resolved by an accepted call is a
/// new fact and is always written (otherwise a flapping "unavailable" would read as fine).
pub async fn record_tool_error_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    token_id: Uuid,
    code: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO hosted_agent_liveness AS l \
            (workspace_id, connection_id, agent_member_id, last_tool_error_at, last_tool_error_code) \
         SELECT hc.workspace_id, hc.id, hc.agent_member_id, now(), $4 \
           FROM hosted_agent_connection hc \
          WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 \
            AND hc.active_token_id = $3 AND hc.status = 'active' \
         ON CONFLICT (workspace_id, connection_id) DO UPDATE SET \
            last_tool_error_at = now(), last_tool_error_code = $4, updated_at = now() \
          WHERE l.last_tool_error_at IS NULL \
             OR l.last_tool_error_at < now() - interval '30 seconds' \
             OR l.last_tool_error_code IS DISTINCT FROM $4 \
             OR l.last_tool_error_at <= l.last_tool_call_at",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(token_id)
    .bind(code)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The stored facts of one connection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LivenessRow {
    pub last_inbox_read_at: Option<DateTime<Utc>>,
    pub last_claim_at: Option<DateTime<Utc>>,
    pub last_run_event_at: Option<DateTime<Utc>>,
    pub last_ping_at: Option<DateTime<Utc>>,
    pub last_ping_state: Option<String>,
    pub last_tool_call_at: Option<DateTime<Utc>>,
    pub last_tool_error_at: Option<DateTime<Utc>>,
    pub last_tool_error_code: Option<String>,
}

/// The rows for these connections, keyed by connection id. A connection that has
/// never been heard from has no row.
pub async fn load_liveness_rows_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_ids: &[Uuid],
) -> Result<HashMap<Uuid, LivenessRow>, DbError> {
    if connection_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT connection_id, last_inbox_read_at, last_claim_at, last_run_event_at, \
                last_ping_at, last_ping_state, last_tool_call_at, last_tool_error_at, \
                last_tool_error_code \
           FROM hosted_agent_liveness \
          WHERE workspace_id = $1 AND connection_id = ANY($2)",
    )
    .bind(workspace_id)
    .bind(connection_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_connection = HashMap::with_capacity(rows.len());
    for row in &rows {
        by_connection.insert(
            row.try_get::<Uuid, _>("connection_id")?,
            LivenessRow {
                last_inbox_read_at: row.try_get("last_inbox_read_at")?,
                last_claim_at: row.try_get("last_claim_at")?,
                last_run_event_at: row.try_get("last_run_event_at")?,
                last_ping_at: row.try_get("last_ping_at")?,
                last_ping_state: row.try_get("last_ping_state")?,
                last_tool_call_at: row.try_get("last_tool_call_at")?,
                last_tool_error_at: row.try_get("last_tool_error_at")?,
                last_tool_error_code: row.try_get("last_tool_error_code")?,
            },
        );
    }
    Ok(by_connection)
}

/// What a member who shares a channel with a hosted agent may ask about it: the
/// agent's hosted connection (id and whether it is active) — or `None` when the
/// agent has no hosted connection, or the viewer shares no channel with it. The two
/// are the same answer, so the route is no probe for "is that agent hosted".
pub async fn liveness_target_for_viewer_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    viewer_member_id: Uuid,
) -> Result<Option<(Uuid, bool)>, DbError> {
    let row = sqlx::query(
        "SELECT hc.id, (hc.status = 'active') AS active \
           FROM hosted_agent_connection hc \
          WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 \
            AND EXISTS ( \
                  SELECT 1 FROM membership mine \
                    JOIN membership theirs \
                      ON theirs.workspace_id = mine.workspace_id \
                     AND theirs.channel_id = mine.channel_id \
                     AND theirs.member_id = $2 AND theirs.left_at IS NULL \
                   WHERE mine.workspace_id = $1 AND mine.member_id = $3 \
                     AND mine.left_at IS NULL) \
          ORDER BY (hc.status = 'active') DESC, hc.created_at DESC \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(viewer_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.map(|row| Ok((row.try_get("id")?, row.try_get("active")?)))
        .transpose()
}

/// ADR-0200 D4 derived state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivenessState {
    /// The connection is not `active` (pairing, expired, disconnected): no claim.
    Inactive,
    /// The last refused call is newer than the last success.
    Error,
    /// The doorbell rang, the grace passed, work is waiting, and nothing was taken.
    WokenNotCollected,
    /// Claimable work has waited longer than the responsive window and nothing has been
    /// claimed since — whatever else the agent is doing (reading the inbox, pinging). The
    /// doorbell is not required: an agent that polls but never takes the job is the case.
    /// Only for an agent that has spoken inside the quiet window: one that has gone
    /// silent altogether is `unresponsive`, which says more than "work is waiting".
    WorkWaiting,
    /// A work signal within the responsive window.
    Responsive,
    /// A ping within the window but no work signal: alive, takes no work.
    AliveIdle,
    /// Some signal, older than the responsive window.
    Quiet,
    /// No signal inside the quiet window, or never.
    Unresponsive,
}

impl LivenessState {
    pub fn as_wire(self) -> &'static str {
        match self {
            LivenessState::Inactive => "inactive",
            LivenessState::Error => "error",
            LivenessState::WokenNotCollected => "woken_not_collected",
            LivenessState::WorkWaiting => "work_waiting",
            LivenessState::Responsive => "responsive",
            LivenessState::AliveIdle => "alive_idle",
            LivenessState::Quiet => "quiet",
            LivenessState::Unresponsive => "unresponsive",
        }
    }
}

/// Windows for [`derive_liveness`]. Defaults are ADR-0200 D4: a 15-minute routine
/// plus slack is "responsive", twice the 30-minute lease is "unresponsive".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LivenessThresholds {
    pub responsive: Duration,
    pub quiet: Duration,
    pub woken_grace: Duration,
}

impl Default for LivenessThresholds {
    fn default() -> Self {
        LivenessThresholds {
            responsive: Duration::minutes(20),
            quiet: Duration::minutes(60),
            woken_grace: Duration::minutes(5),
        }
    }
}

/// The doorbell's last result for the connection (read from `momo-webhook`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DoorbellFact {
    pub last_fired_at: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
}

impl DoorbellFact {
    /// `ok_200`-style: the receiver answered 2xx. "Received", never "processed".
    fn rang_ok(&self) -> bool {
        self.last_status
            .as_deref()
            .is_some_and(|status| status.starts_with("ok_2"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Liveness {
    pub state: LivenessState,
    /// The newest of every signal: work, ping, and any accepted call.
    pub last_signal_at: Option<DateTime<Utc>>,
    /// The newest work signal (inbox read, claim, run event).
    pub last_work_signal_at: Option<DateTime<Utc>>,
    pub last_ping_at: Option<DateTime<Utc>>,
    pub last_ping_state: Option<String>,
    pub last_tool_error_at: Option<DateTime<Utc>>,
    pub last_tool_error_code: Option<String>,
}

/// The skew allowance in [`collected_since`]: a ring is timestamped AFTER its HTTP
/// response returns, so an agent that woke instantly can have read its inbox a moment
/// before the stamp.
pub const COLLECTED_SKEW_SECONDS: i64 = 30;

/// ONE definition of "the agent collected since the doorbell rang at `t`" (ADR-0200
/// 증보 3 E1-4, E8): its newest inbox read or claim is at or after `t − 30 s`. D4's
/// `woken_not_collected` label and the sweep's `woken_uncollected_verdict` both call
/// this — they differ only in WHICH ring time they pass (D4: the connection's last fire;
/// the sweep: this run's first uncollected ring row).
pub fn collected_since(t: DateTime<Utc>, row: &LivenessRow) -> bool {
    [row.last_inbox_read_at, row.last_claim_at]
        .into_iter()
        .flatten()
        .max()
        .is_some_and(|read| read >= t - Duration::seconds(COLLECTED_SKEW_SECONDS))
}

/// Decide the label. Order matters and is the ADR's:
/// inactive, then error, then woken-not-collected and work-waiting (alive but not
/// taking work is the headline even when a ping or an inbox read is fresh), then
/// responsive, alive-idle, quiet, unresponsive.
///
/// `waiting_since` is when the oldest claimable job was queued (`None` = nothing waits).
pub fn derive_liveness(
    now: DateTime<Utc>,
    connection_active: bool,
    row: Option<&LivenessRow>,
    doorbell: &DoorbellFact,
    waiting_since: Option<DateTime<Utc>>,
    thresholds: &LivenessThresholds,
) -> Liveness {
    let empty = LivenessRow::default();
    let row = row.unwrap_or(&empty);
    let work = [
        row.last_inbox_read_at,
        row.last_claim_at,
        row.last_run_event_at,
    ]
    .into_iter()
    .flatten()
    .max();
    // Any accepted call is a sign of life (a runtime that only reads a conversation is
    // up); only a WORK signal makes it `responsive`, only a ping makes it `alive_idle`.
    let signal = [work, row.last_ping_at, row.last_tool_call_at]
        .into_iter()
        .flatten()
        .max();
    let within =
        |at: Option<DateTime<Utc>>, window: Duration| at.is_some_and(|at| now - at <= window);

    let state = if !connection_active {
        LivenessState::Inactive
    } else if row
        .last_tool_error_at
        .is_some_and(|errored| signal.is_none_or(|ok| errored > ok))
    {
        LivenessState::Error
    } else if waiting_since.is_some()
        && doorbell.rang_ok()
        && doorbell
            .last_fired_at
            .is_some_and(|fired| now - fired >= thresholds.woken_grace)
        && doorbell
            .last_fired_at
            .is_some_and(|fired| !collected_since(fired, row))
    {
        LivenessState::WokenNotCollected
    } else if within(signal, thresholds.quiet)
        && waiting_since.is_some_and(|queued| {
            now - queued >= thresholds.responsive
                && row.last_claim_at.is_none_or(|claimed| claimed < queued)
        })
    {
        LivenessState::WorkWaiting
    } else if within(work, thresholds.responsive) {
        LivenessState::Responsive
    } else if within(row.last_ping_at, thresholds.responsive) {
        LivenessState::AliveIdle
    } else if within(signal, thresholds.quiet) {
        LivenessState::Quiet
    } else {
        LivenessState::Unresponsive
    };

    Liveness {
        state,
        last_signal_at: signal,
        last_work_signal_at: work,
        last_ping_at: row.last_ping_at,
        last_ping_state: row.last_ping_state.clone(),
        last_tool_error_at: row.last_tool_error_at,
        last_tool_error_code: row.last_tool_error_code.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes_ago: i64) -> Option<DateTime<Utc>> {
        Some(Utc::now() - Duration::minutes(minutes_ago))
    }

    fn derive(row: &LivenessRow, doorbell: &DoorbellFact, waiting: bool) -> LivenessState {
        // a job that has waited 11 minutes (inside the responsive window)
        let waiting_since = waiting.then(|| Utc::now() - Duration::minutes(11));
        derive_liveness(
            Utc::now(),
            true,
            Some(row),
            doorbell,
            waiting_since,
            &LivenessThresholds::default(),
        )
        .state
    }

    #[test]
    fn never_heard_from_is_unresponsive_not_connected_and_not_alive() {
        let state = derive_liveness(
            Utc::now(),
            true,
            None,
            &DoorbellFact::default(),
            None,
            &LivenessThresholds::default(),
        )
        .state;
        assert_eq!(state, LivenessState::Unresponsive);
    }

    #[test]
    fn an_inactive_connection_claims_nothing() {
        let row = LivenessRow {
            last_claim_at: at(1),
            ..Default::default()
        };
        let state = derive_liveness(
            Utc::now(),
            false,
            Some(&row),
            &DoorbellFact::default(),
            None,
            &LivenessThresholds::default(),
        )
        .state;
        assert_eq!(state, LivenessState::Inactive);
    }

    #[test]
    fn a_work_signal_makes_it_responsive_and_ages_into_quiet_then_unresponsive() {
        let mut row = LivenessRow {
            last_inbox_read_at: at(3),
            ..Default::default()
        };
        assert_eq!(
            derive(&row, &DoorbellFact::default(), false),
            LivenessState::Responsive
        );
        row.last_inbox_read_at = at(30);
        assert_eq!(
            derive(&row, &DoorbellFact::default(), false),
            LivenessState::Quiet
        );
        row.last_inbox_read_at = at(90);
        assert_eq!(
            derive(&row, &DoorbellFact::default(), false),
            LivenessState::Unresponsive
        );
    }

    /// The reason ping is a separate column pair: a runtime that pings but never
    /// reads its inbox is alive and NOT taking work, and says so.
    #[test]
    fn a_ping_alone_is_alive_idle_never_responsive() {
        let row = LivenessRow {
            last_ping_at: at(1),
            last_ping_state: Some("idle".into()),
            ..Default::default()
        };
        assert_eq!(
            derive(&row, &DoorbellFact::default(), false),
            LivenessState::AliveIdle
        );
        let aged = LivenessRow {
            last_ping_at: at(30),
            ..Default::default()
        };
        assert_eq!(
            derive(&aged, &DoorbellFact::default(), false),
            LivenessState::Quiet
        );
    }

    #[test]
    fn a_fresh_work_signal_beats_a_ping() {
        let row = LivenessRow {
            last_ping_at: at(1),
            last_claim_at: at(2),
            ..Default::default()
        };
        assert_eq!(
            derive(&row, &DoorbellFact::default(), false),
            LivenessState::Responsive
        );
    }

    /// 2026-10-13: the doorbell answered ok_200, the routine could not reach the
    /// Agent Port, and the run waited 11 minutes. Alive-looking pings must not hide it.
    #[test]
    fn rung_waiting_and_not_collected_is_the_headline_even_with_a_fresh_ping() {
        let doorbell = DoorbellFact {
            last_fired_at: at(11),
            last_status: Some("ok_200".into()),
        };
        let row = LivenessRow {
            last_ping_at: at(1),
            last_inbox_read_at: at(40),
            ..Default::default()
        };
        assert_eq!(
            derive(&row, &doorbell, true),
            LivenessState::WokenNotCollected
        );
        // no work waiting: not an alarm
        assert_eq!(derive(&row, &doorbell, false), LivenessState::AliveIdle);
        // the agent took something after the bell: it collected
        let collected = LivenessRow {
            last_claim_at: at(2),
            ..row.clone()
        };
        assert_eq!(
            derive(&collected, &doorbell, true),
            LivenessState::Responsive
        );
        // inside the grace period: not yet
        let fresh_bell = DoorbellFact {
            last_fired_at: at(2),
            last_status: Some("ok_200".into()),
        };
        assert_ne!(
            derive(&row, &fresh_bell, true),
            LivenessState::WokenNotCollected
        );
        // a bell the receiver rejected is not a bell that "woke" anything
        let failed = DoorbellFact {
            last_fired_at: at(11),
            last_status: Some("http_500".into()),
        };
        assert_ne!(
            derive(&row, &failed, true),
            LivenessState::WokenNotCollected
        );
    }

    /// ADR-0200 증보 3 E8: the shared comparison carries the 30-second skew allowance into
    /// D4 as well — a read 29 s BEFORE the ring counts as collected, 31 s before does not.
    #[test]
    fn d4_reads_the_shared_collected_since_with_its_thirty_second_skew() {
        let now = Utc::now();
        let fired = now - Duration::minutes(11);
        let doorbell = DoorbellFact {
            last_fired_at: Some(fired),
            last_status: Some("ok_200".into()),
        };
        let state = |read: DateTime<Utc>| {
            let row = LivenessRow {
                last_inbox_read_at: Some(read),
                ..Default::default()
            };
            derive_liveness(
                now,
                true,
                Some(&row),
                &doorbell,
                Some(now - Duration::minutes(11)),
                &LivenessThresholds::default(),
            )
            .state
        };
        assert_ne!(
            state(fired - Duration::seconds(29)),
            LivenessState::WokenNotCollected
        );
        assert_eq!(
            state(fired - Duration::seconds(31)),
            LivenessState::WokenNotCollected
        );
    }

    #[test]
    fn collected_since_compares_the_newest_read_or_claim_against_t_minus_thirty_seconds() {
        let t = Utc::now();
        let row = |read: Option<DateTime<Utc>>, claim: Option<DateTime<Utc>>| LivenessRow {
            last_inbox_read_at: read,
            last_claim_at: claim,
            ..Default::default()
        };
        assert!(collected_since(
            t,
            &row(Some(t + Duration::seconds(1)), None)
        ));
        assert!(collected_since(
            t,
            &row(Some(t - Duration::seconds(29)), None)
        ));
        assert!(collected_since(
            t,
            &row(None, Some(t - Duration::seconds(30)))
        ));
        assert!(!collected_since(
            t,
            &row(Some(t - Duration::seconds(31)), None)
        ));
        // the newer of the two decides
        assert!(collected_since(
            t,
            &row(
                Some(t - Duration::minutes(5)),
                Some(t - Duration::seconds(10))
            )
        ));
        // nothing ever read or claimed: not collected
        assert!(!collected_since(t, &row(None, None)));
        // a run event and a ping are NOT collection
        let busy = LivenessRow {
            last_run_event_at: Some(t),
            last_ping_at: Some(t),
            ..Default::default()
        };
        assert!(!collected_since(t, &busy));
    }

    /// A refusal is `error` only until the next accepted call of ANY kind: the throttle on
    /// the work columns must not keep a recovered agent red for 30 seconds.
    #[test]
    fn any_accepted_call_after_a_refusal_ends_the_error() {
        let row = LivenessRow {
            last_tool_error_at: at(2),
            last_tool_error_code: Some("unavailable".into()),
            last_tool_call_at: at(1),
            ..Default::default()
        };
        assert_eq!(
            derive(&row, &DoorbellFact::default(), false),
            LivenessState::Quiet
        );
    }

    /// Review M3: an agent that polls (or pings) but never takes the job is not
    /// "responsive" for long. Work that has waited past the responsive window and was not
    /// claimed since it was queued is the headline — with no doorbell involved.
    #[test]
    fn claimable_work_that_waited_past_the_window_beats_a_fresh_poll_and_a_fresh_ping() {
        let now = Utc::now();
        let row = LivenessRow {
            last_inbox_read_at: at(1),
            last_ping_at: at(1),
            last_claim_at: at(300),
            ..Default::default()
        };
        let waited = |minutes: i64| {
            derive_liveness(
                now,
                true,
                Some(&row),
                &DoorbellFact::default(),
                Some(now - Duration::minutes(minutes)),
                &LivenessThresholds::default(),
            )
            .state
        };
        assert_eq!(waited(25), LivenessState::WorkWaiting);
        // inside the window it is still just a polling agent
        assert_eq!(waited(10), LivenessState::Responsive);
        // a claim AFTER the job was queued means it was taken, not ignored
        let claimed = LivenessRow {
            last_claim_at: at(2),
            ..row.clone()
        };
        let state = derive_liveness(
            now,
            true,
            Some(&claimed),
            &DoorbellFact::default(),
            Some(now - Duration::minutes(25)),
            &LivenessThresholds::default(),
        )
        .state;
        assert_eq!(state, LivenessState::Responsive);
    }

    /// Re-review M-A: silence outranks waiting work — a dead agent is "no response", not
    /// "work is waiting".
    #[test]
    fn an_agent_silent_past_the_quiet_window_is_unresponsive_not_work_waiting() {
        let now = Utc::now();
        let row = LivenessRow {
            last_inbox_read_at: at(120),
            ..Default::default()
        };
        let state = derive_liveness(
            now,
            true,
            Some(&row),
            &DoorbellFact::default(),
            Some(now - Duration::minutes(90)),
            &LivenessThresholds::default(),
        )
        .state;
        assert_eq!(state, LivenessState::Unresponsive);
    }

    /// The quiet-window edge, both sides (re-review Low-1).
    #[test]
    fn the_quiet_window_edge_decides_work_waiting_versus_unresponsive() {
        let now = Utc::now();
        let state_with_signal_minutes_ago = |minutes: i64| {
            let row = LivenessRow {
                last_inbox_read_at: Some(now - Duration::minutes(minutes)),
                ..Default::default()
            };
            derive_liveness(
                now,
                true,
                Some(&row),
                &DoorbellFact::default(),
                Some(now - Duration::minutes(90)),
                &LivenessThresholds::default(),
            )
            .state
        };
        assert_eq!(
            state_with_signal_minutes_ago(59),
            LivenessState::WorkWaiting
        );
        assert_eq!(
            state_with_signal_minutes_ago(61),
            LivenessState::Unresponsive
        );
    }

    #[test]
    fn a_refusal_newer_than_the_last_success_is_an_error() {
        let row = LivenessRow {
            last_inbox_read_at: at(10),
            last_tool_error_at: at(2),
            last_tool_error_code: Some("unavailable".into()),
            ..Default::default()
        };
        assert_eq!(
            derive(&row, &DoorbellFact::default(), false),
            LivenessState::Error
        );
        let recovered = LivenessRow {
            last_inbox_read_at: at(1),
            ..row
        };
        assert_eq!(
            derive(&recovered, &DoorbellFact::default(), false),
            LivenessState::Responsive
        );
    }
}
