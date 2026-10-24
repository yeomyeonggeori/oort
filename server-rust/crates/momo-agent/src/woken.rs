//! A run the doorbell woke the agent for, and nobody collected (ADR-0200 증보 3, #4284).
//!
//! The doorbell reached the agent's receiver (`doorbell_rung` `<edge>_ok` in the run's
//! ledger) and nothing since says the agent took this job or is busy with another one.
//! After [`MOMO_RUN_WOKEN_EXPIRE_MINUTES`](crate) the sweep ends the run as
//! `timed_out{code:"woken_not_collected"}`. This module is the READ side of that decision:
//!
//! * [`woken_uncollected_verdict`] — PURE. One input field per condition of E1, so a table
//!   test can falsify exactly one condition at a time and a sabotage (deleting a condition)
//!   turns exactly its row red. It is the only place the verdict is decided; the notifier's
//!   candidate SQL is a superset and never decides (`momo-outbox` `stalled.rs`).
//! * [`load_woken_agent_facts_in_tx`] — the narrow reads the verdict needs from the agent
//!   side. Every column read here is one the `momo_notifier` role may SELECT (ADR-0200
//!   증보 3 E7; `infra/rust/sql/bootstrap_runtime_roles.sql`): the liveness read lists its
//!   columns instead of reusing [`crate::load_liveness_rows_in_tx`], which also reads
//!   `last_tool_call_at` and `last_tool_error_code`.
//!
//! The job-side facts (claimable by oort's own conditions, another live lease) come from
//! `momo_outbox::lock_woken_job_facts_in_tx`; this crate owns no `outbox` SQL.

use chrono::{DateTime, Duration, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::hosted_liveness::{collected_since, LivenessRow};

/// One field per condition of ADR-0200 증보 3 E1. Built by the sweep from reads taken AFTER
/// the run row and the delivery job row are locked.
#[derive(Debug, Clone)]
pub struct WokenVerdictInput {
    pub now: DateTime<Utc>,
    /// E2: `MOMO_RUN_WOKEN_EXPIRE_MINUTES` (default 30).
    pub expire: Duration,
    /// Re-read from the LOCKED run row: `status = 'queued'`. The candidate SQL is a
    /// snapshot; this is the check that survives a stale one.
    pub run_queued: bool,
    /// The run's ledger has a `claimed` row (an agent took it at some point).
    pub run_claimed: bool,
    /// E1-1: the agent's hosted connection is `active` right now.
    pub connection_active: bool,
    /// E1-3: the delivery job is claimable by oort's own conditions (not the token's).
    pub job_claimable_by_oort: bool,
    /// E1-6 (i): the same agent holds a LIVE lease on another run's job.
    pub other_job_live_lease: bool,
    /// The connection's stored liveness facts (None = never heard from).
    pub liveness: Option<LivenessRow>,
    /// This run's ledger `doorbell_rung` rows whose code is `<edge>_ok` — their times.
    /// `_failed` rows are never passed in (E1-5, acceptance 5).
    pub ring_ok_times: Vec<DateTime<Utc>>,
    /// The latest human "wake again" request on this connection, if any (E1-5).
    pub manual_ring_latest: Option<DateTime<Utc>>,
}

/// E1-4 / E1-5: the time the clock is measured from, or `None` when this run is not a
/// target (no `_ok` ring row left uncollected).
///
/// T is the EARLIEST `_ok` ring row of this run the agent has not collected since
/// ([`collected_since`]) — the first uncollected ring after the last collection evidence.
/// Conversation keeps ringing the bell about once a minute; the latest ring would keep
/// pushing a clock forward forever, so T stays on the first one. Only a person moves it:
/// a "wake again" request later than T moves T to the latest such request.
pub fn woken_clock_start(input: &WokenVerdictInput) -> Option<DateTime<Utc>> {
    let empty = LivenessRow::default();
    let row = input.liveness.as_ref().unwrap_or(&empty);
    let first = input
        .ring_ok_times
        .iter()
        .copied()
        .filter(|ring| !collected_since(*ring, row))
        .min()?;
    Some(match input.manual_ring_latest {
        Some(request) if request > first => request,
        _ => first,
    })
}

/// ADR-0200 증보 3 E1: should this queued run end as `woken_not_collected`?
///
/// Every condition must hold; each is one input. See the ADR for why each exists. In
/// short: the agent was woken, nothing says it took the job or is alive and busy, oort has
/// not refused it, oort could have handed it the job, and the window has passed.
pub fn woken_uncollected_verdict(input: &WokenVerdictInput) -> bool {
    // the locked row, re-read: only a queued run with no claim is ever ended here
    if !input.run_queued || input.run_claimed {
        return false;
    }
    // E1-1: a disconnected connection is the 24-hour rule's and the disconnect cleanup's
    if !input.connection_active {
        return false;
    }
    // E1-3: if oort itself would refuse the job, waiting is oort's fault (24-hour rule)
    if !input.job_claimable_by_oort {
        return false;
    }
    // E1-4 / E1-5: the clock
    let Some(t) = woken_clock_start(input) else {
        return false;
    };
    let empty = LivenessRow::default();
    let row = input.liveness.as_ref().unwrap_or(&empty);
    // E1-2: oort refused the agent after T — the cause may be ours
    if row.last_tool_error_at.is_some_and(|errored| errored > t) {
        return false;
    }
    // E1-6: alive and doing something else
    if input.other_job_live_lease {
        return false;
    }
    if row.last_run_event_at.is_some_and(|event| event >= t) {
        return false;
    }
    if row.last_ping_state.as_deref() == Some("working")
        && row.last_ping_at.is_some_and(|ping| ping >= t)
    {
        return false;
    }
    // E1-7: the window
    input.now - t >= input.expire
}

/// The agent-side facts the verdict needs, read inside the sweep's tenant transaction.
#[derive(Debug, Clone, Default)]
pub struct WokenAgentFacts {
    /// The database clock (`now()`), the same clock that stamped the ring rows — the
    /// verdict never compares a row time against the notifier host's clock.
    pub db_now: Option<DateTime<Utc>>,
    pub run_queued: bool,
    pub run_claimed: bool,
    pub liveness: Option<LivenessRow>,
    pub ring_ok_times: Vec<DateTime<Utc>>,
    pub manual_ring_latest: Option<DateTime<Utc>>,
}

/// The agent's ACTIVE hosted connection, if it has one (E1-1). `ORDER BY id` only makes the
/// choice deterministic; an agent has at most one active connection.
pub async fn active_hosted_connection_id_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT hc.id FROM hosted_agent_connection hc \
          WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 AND hc.status = 'active' \
          ORDER BY hc.id LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(id)
}

/// Read the verdict's agent-side facts for one run. Every table is filtered by
/// `workspace_id`: the ledger has no foreign key (migration 128), so a ring row of another
/// tenant with the same run id must never be seen here (acceptance 12). The liveness and
/// ring tables are joined by the composite `(workspace_id, connection_id)` key.
pub async fn load_woken_agent_facts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    connection_id: Uuid,
) -> Result<WokenAgentFacts, DbError> {
    let db_now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *conn)
        .await?;
    let run_status: Option<String> = sqlx::query_scalar(
        "SELECT status::text FROM agent_run WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    let run_claimed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM agent_run_event c \
                         WHERE c.workspace_id = $1 AND c.run_id = $2 AND c.kind = 'claimed')",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    // `code ~ '_ok$'`: the edge token is closed (`doorbell_rung_code`), `_failed` is out.
    let ring_ok_times: Vec<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT e.created_at FROM agent_run_event e \
          WHERE e.workspace_id = $1 AND e.run_id = $2 \
            AND e.kind = 'doorbell_rung' AND e.code ~ '_ok$' \
          ORDER BY e.created_at, e.seq",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    let manual_ring_latest: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(g.requested_at) FROM hosted_agent_doorbell_ring g \
          WHERE g.workspace_id = $1 AND g.connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_one(&mut *conn)
    .await?;
    let liveness = sqlx::query(
        "SELECT l.last_inbox_read_at, l.last_claim_at, l.last_run_event_at, \
                l.last_ping_at, l.last_ping_state, l.last_tool_error_at \
           FROM hosted_agent_liveness l \
          WHERE l.workspace_id = $1 AND l.connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?
    .map(|row| -> Result<LivenessRow, sqlx::Error> {
        Ok(LivenessRow {
            last_inbox_read_at: row.try_get("last_inbox_read_at")?,
            last_claim_at: row.try_get("last_claim_at")?,
            last_run_event_at: row.try_get("last_run_event_at")?,
            last_ping_at: row.try_get("last_ping_at")?,
            last_ping_state: row.try_get("last_ping_state")?,
            last_tool_error_at: row.try_get("last_tool_error_at")?,
            ..LivenessRow::default()
        })
    })
    .transpose()?;
    Ok(WokenAgentFacts {
        db_now: Some(db_now),
        run_queued: run_status.as_deref() == Some("queued"),
        run_claimed,
        liveness,
        ring_ok_times,
        manual_ring_latest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        // a fixed instant: every row below is arithmetic on it
        DateTime::parse_from_rfc3339("2026-10-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// The baseline: every condition TRUE, the first ring 40 minutes ago, a window of 30.
    fn base() -> WokenVerdictInput {
        WokenVerdictInput {
            now: now(),
            expire: Duration::minutes(30),
            run_queued: true,
            run_claimed: false,
            connection_active: true,
            job_claimable_by_oort: true,
            other_job_live_lease: false,
            liveness: Some(LivenessRow {
                // the agent's last read/claim long before the ring, ping only `idle`
                last_inbox_read_at: Some(now() - Duration::days(5)),
                last_claim_at: Some(now() - Duration::days(6)),
                last_run_event_at: Some(now() - Duration::days(6)),
                last_ping_at: Some(now() - Duration::minutes(1)),
                last_ping_state: Some("idle".into()),
                last_tool_error_at: Some(now() - Duration::days(8)),
                ..LivenessRow::default()
            }),
            ring_ok_times: vec![now() - Duration::minutes(40)],
            manual_ring_latest: None,
        }
    }

    fn t() -> DateTime<Utc> {
        now() - Duration::minutes(40)
    }

    #[test]
    fn the_baseline_run_ends() {
        assert!(woken_uncollected_verdict(&base()));
    }

    /// Acceptance 2, one condition false at a time. Deleting that condition from
    /// `woken_uncollected_verdict` turns its row red (sabotage table in the worker notes).
    #[test]
    fn each_protection_alone_keeps_the_run_alive() {
        type Mutate = fn(&mut WokenVerdictInput);
        let rows: Vec<(&str, Mutate)> = vec![
            ("run is no longer queued", |i| i.run_queued = false),
            ("run already has a claimed row", |i| i.run_claimed = true),
            ("connection is not active", |i| i.connection_active = false),
            ("oort would refuse the job (channel/scope/trial)", |i| {
                i.job_claimable_by_oort = false
            }),
            ("another job holds a live lease", |i| {
                i.other_job_live_lease = true
            }),
            ("the agent read its inbox after the ring", |i| {
                i.liveness.as_mut().unwrap().last_inbox_read_at = Some(t() + Duration::minutes(3));
            }),
            ("the agent claimed after the ring", |i| {
                i.liveness.as_mut().unwrap().last_claim_at = Some(t() + Duration::minutes(3));
            }),
            ("a run event at T", |i| {
                i.liveness.as_mut().unwrap().last_run_event_at = Some(t());
            }),
            ("a working ping after T", |i| {
                let row = i.liveness.as_mut().unwrap();
                row.last_ping_state = Some("working".into());
                row.last_ping_at = Some(t() + Duration::minutes(1));
            }),
            ("oort refused the agent after T", |i| {
                i.liveness.as_mut().unwrap().last_tool_error_at = Some(t() + Duration::minutes(2));
            }),
            ("only 29m59s since T", |i| {
                i.ring_ok_times = vec![now() - Duration::seconds(29 * 60 + 59)];
            }),
            ("a person woke the agent again 10 minutes ago", |i| {
                i.manual_ring_latest = Some(now() - Duration::minutes(10));
            }),
            (
                "no ok ring row at all (cap spent or ledger write failed)",
                |i| {
                    i.ring_ok_times = vec![];
                },
            ),
        ];
        for (name, mutate) in rows {
            let mut input = base();
            mutate(&mut input);
            assert!(
                !woken_uncollected_verdict(&input),
                "RED: `{name}` must keep the run alive, but the verdict ended it"
            );
        }
    }

    /// Acceptance 2, the negative controls: these facts do NOT protect the run. Putting
    /// them into the verdict as protections turns these rows red.
    #[test]
    fn an_expired_lease_a_stale_error_and_an_idle_ping_do_not_protect() {
        // an expired lease is not `other_job_live_lease` — the outbox fact already says so;
        // the verdict has no way to be fooled by `lease_owner` still sitting on the row.
        let mut input = base();
        input.other_job_live_lease = false;
        assert!(woken_uncollected_verdict(&input));
        // a ping that says `idle` after T is not a protection (the incident's grok)
        let mut idle = base();
        let row = idle.liveness.as_mut().unwrap();
        row.last_ping_state = Some("idle".into());
        row.last_ping_at = Some(t() + Duration::minutes(5));
        assert!(woken_uncollected_verdict(&idle));
        // a refusal BEFORE T (the incident's 10-16 `not_authorized`) does not protect
        let mut old_error = base();
        old_error.liveness.as_mut().unwrap().last_tool_error_at = Some(t() - Duration::days(2));
        assert!(woken_uncollected_verdict(&old_error));
        // a working ping from BEFORE T does not protect either
        let mut old_working = base();
        let row = old_working.liveness.as_mut().unwrap();
        row.last_ping_state = Some("working".into());
        row.last_ping_at = Some(t() - Duration::minutes(10));
        assert!(woken_uncollected_verdict(&old_working));
        // a stale run event from before T does not protect
        let mut old_event = base();
        old_event.liveness.as_mut().unwrap().last_run_event_at = Some(t() - Duration::seconds(1));
        assert!(woken_uncollected_verdict(&old_event));
        // never heard from: no liveness row at all still ends
        let mut unknown = base();
        unknown.liveness = None;
        assert!(woken_uncollected_verdict(&unknown));
    }

    #[test]
    fn thirty_minutes_ends_and_twenty_nine_fifty_nine_does_not() {
        let mut at_limit = base();
        at_limit.ring_ok_times = vec![now() - Duration::minutes(30)];
        assert!(woken_uncollected_verdict(&at_limit));
        let mut just_short = base();
        just_short.ring_ok_times = vec![now() - Duration::seconds(29 * 60 + 59)];
        assert!(!woken_uncollected_verdict(&just_short));
        // the window is the input: 10 minutes ends a 15-minute-old ring
        let mut ten = base();
        ten.expire = Duration::minutes(10);
        ten.ring_ok_times = vec![now() - Duration::minutes(15)];
        assert!(woken_uncollected_verdict(&ten));
    }

    /// The 30-second skew, at the verdict: a read 29 s before the ring is a collection,
    /// 31 s before is not.
    #[test]
    fn a_read_just_before_the_ring_is_a_collection_and_thirty_one_seconds_before_is_not() {
        let mut inside = base();
        inside.liveness.as_mut().unwrap().last_inbox_read_at = Some(t() - Duration::seconds(29));
        assert!(
            !woken_uncollected_verdict(&inside),
            "29 s before T = collected"
        );
        let mut outside = base();
        outside.liveness.as_mut().unwrap().last_inbox_read_at = Some(t() - Duration::seconds(31));
        assert!(
            woken_uncollected_verdict(&outside),
            "31 s before T = not collected"
        );
    }

    /// Acceptance 4: conversation keeps ringing; the clock stays on the FIRST uncollected
    /// ring. Sabotage: take the latest ring as T and this goes red.
    #[test]
    fn the_clock_stays_on_the_first_uncollected_ring_while_conversation_keeps_ringing() {
        let mut input = base();
        // a ring every minute for 40 minutes: the last one was 1 minute ago
        input.ring_ok_times = (1..=40).map(|m| now() - Duration::minutes(m)).collect();
        assert_eq!(
            woken_clock_start(&input),
            Some(now() - Duration::minutes(40))
        );
        assert!(woken_uncollected_verdict(&input));
    }

    /// Acceptance 4: a person's "wake again" after T moves T. Sabotage: ignore the request.
    #[test]
    fn a_person_waking_the_agent_again_moves_the_clock() {
        let mut input = base();
        input.manual_ring_latest = Some(now() - Duration::minutes(5));
        assert_eq!(
            woken_clock_start(&input),
            Some(now() - Duration::minutes(5))
        );
        assert!(!woken_uncollected_verdict(&input));
        // 31 minutes after the request it ends again
        input.now = now() + Duration::minutes(26);
        assert!(woken_uncollected_verdict(&input));
        // a request EARLIER than T does not move it
        let mut early = base();
        early.manual_ring_latest = Some(t() - Duration::minutes(5));
        assert_eq!(woken_clock_start(&early), Some(t()));
    }

    /// Acceptance 4/5: after a collection the clock starts from the first ring AFTER it,
    /// and a collection after the last ring leaves nothing to measure.
    #[test]
    fn the_clock_starts_after_the_last_collection() {
        let mut input = base();
        input.ring_ok_times = vec![
            now() - Duration::minutes(50),
            now() - Duration::minutes(45),
            now() - Duration::minutes(5),
        ];
        // the agent read at -44 minutes: the first two rings are collected; T = -5 min
        input.liveness.as_mut().unwrap().last_inbox_read_at = Some(now() - Duration::minutes(44));
        assert_eq!(
            woken_clock_start(&input),
            Some(now() - Duration::minutes(5))
        );
        assert!(!woken_uncollected_verdict(&input));
        // a collection after every ring: not a target
        input.liveness.as_mut().unwrap().last_claim_at = Some(now() - Duration::minutes(1));
        assert_eq!(woken_clock_start(&input), None);
        assert!(!woken_uncollected_verdict(&input));
    }

    /// Acceptance 5: only `_ok` rows are passed in (the loader filters `_failed`), so a run
    /// with no ok row is not a target. A `_failed` row used as T would end this run.
    #[test]
    fn a_failed_ring_alone_is_not_a_target() {
        let mut input = base();
        input.ring_ok_times = vec![];
        assert_eq!(woken_clock_start(&input), None);
        assert!(!woken_uncollected_verdict(&input));
    }
}
