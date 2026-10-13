//! Hosted runs whose agent has gone quiet (ADR-0200 D1-4, #3744) — the READ side of
//! the stall sweep.
//!
//! A hosted agent that claimed a job and never came back leaves its run `running` (or
//! `queued` with a dead lease) forever: nothing reaps an expired lease (ADR-0162 증보 3
//! 부록 A), `deadline_at` is only ever written by the approval path, and the display
//! cannot honestly say more than "lease not renewed". The sweep ends such a run with an
//! explicit, closed fact — never a client guess:
//!
//! * `lease_abandoned` — the run has no live way to hear from its agent any more and has
//!   had no event for `lease_grace`: EITHER the delivery job's lease expired that long ago
//!   and nobody re-claimed it, OR there is no pending delivery job at all (a disconnect or a
//!   credential revoke settles the job and leaves the run — the commonest ghost; with no
//!   job no agent can report on it). `agent_run.updated_at` is touched by every run event,
//!   so a re-claim, a renewal or any report within the grace period makes the run fresh
//!   again and it is left alone.
//! * `unclaimed_expired` — a queued run nobody took for `unclaimed` (default 24 h, counted
//!   from the later of its creation and its last update, so a run re-queued after an
//!   approval does not inherit its old age).
//!
//! This module lives beside the delivery job it reads (the lease is columns on an
//! `outbox` row); it only READS `agent_run`. The write — ending the run — is
//! `momo_agent::end_stalled_run_in_tx`, composed by the sweep in one tenant transaction.

use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The two grace periods, in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallPolicy {
    pub lease_grace_seconds: i64,
    pub unclaimed_seconds: i64,
}

impl Default for StallPolicy {
    fn default() -> Self {
        StallPolicy {
            lease_grace_seconds: 2 * 3600,
            unclaimed_seconds: 24 * 3600,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallKind {
    LeaseAbandoned,
    UnclaimedExpired,
}

impl StallKind {
    /// The closed machine code written to `agent_run.error.code` and the ledger.
    pub fn code(self) -> &'static str {
        match self {
            StallKind::LeaseAbandoned => "lease_abandoned",
            StallKind::UnclaimedExpired => "unclaimed_expired",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StalledRun {
    pub run_id: Uuid,
    pub channel_id: Uuid,
    pub agent_member_id: Uuid,
    pub kind: StallKind,
    /// The later of the run's creation and last update — how long it has been silent.
    pub last_activity_at: chrono::DateTime<chrono::Utc>,
}

/// The one definition of "stalled". `$1` workspace (NULL = every tenant, the notifier's
/// cross-tenant candidate read), `$2` lease grace seconds, `$3` unclaimed seconds.
const STALLED_FROM_WHERE: &str = "\
  FROM agent_run r \
  LEFT JOIN LATERAL ( \
         SELECT o.id, o.lease_owner, o.lease_expires_at \
           FROM outbox o \
          WHERE o.workspace_id = r.workspace_id \
            AND o.kind = 'agent_job' AND o.method = 'gateway' AND o.status = 'pending' \
            AND o.partition_key = r.agent_member_id \
            AND lower(o.payload->>'run_id') = lower(r.id::text) \
          ORDER BY o.id DESC LIMIT 1 \
       ) j ON true \
 WHERE ($1::uuid IS NULL OR r.workspace_id = $1) \
   AND r.status IN ('queued', 'running') \
   AND agent_run_event_is_hosted(r.workspace_id, r.agent_member_id) \
   AND ( \
        (j.lease_owner IS NOT NULL \
          AND j.lease_expires_at < now() - make_interval(secs => $2::float8) \
          AND r.updated_at < now() - make_interval(secs => $2::float8)) \
     OR (j.id IS NULL \
          AND r.updated_at < now() - make_interval(secs => $2::float8)) \
     OR (j.id IS NOT NULL AND j.lease_owner IS NULL AND r.status = 'queued' \
          AND GREATEST(r.created_at, r.updated_at) < now() - make_interval(secs => $3::float8)) \
       )";

/// Workspaces that have at least one stalled hosted run (cross-tenant **read**; the
/// caller connects as the BYPASSRLS notifier role).
pub async fn workspaces_with_stalled_hosted_runs(
    conn: &mut PgConnection,
    policy: StallPolicy,
    limit: i64,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let sql = format!(
        "SELECT DISTINCT workspace_id FROM ( \
           SELECT r.workspace_id {STALLED_FROM_WHERE} LIMIT $4) stalled"
    );
    sqlx::query_scalar(&sql)
        .bind(Option::<Uuid>::None)
        .bind(policy.lease_grace_seconds as f64)
        .bind(policy.unclaimed_seconds as f64)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await
}

/// Up to `limit` stalled hosted runs of one workspace, each ROW-LOCKED (`FOR UPDATE OF r
/// SKIP LOCKED`) so a report arriving from the agent while the sweep decides serializes
/// behind it (and sees a finished run), and a run an agent is reporting on right now is
/// skipped. Oldest first.
pub async fn lock_stalled_hosted_runs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    policy: StallPolicy,
    limit: i64,
) -> Result<Vec<StalledRun>, sqlx::Error> {
    let sql = format!(
        "SELECT r.id, r.channel_id, r.agent_member_id, \
                GREATEST(r.created_at, r.updated_at) AS last_activity_at, \
                NOT (j.id IS NOT NULL AND j.lease_owner IS NULL) AS lease_abandoned \
         {STALLED_FROM_WHERE} \
          ORDER BY r.created_at ASC \
          LIMIT $4 \
            FOR UPDATE OF r SKIP LOCKED"
    );
    let rows = sqlx::query(&sql)
        .bind(Some(workspace_id))
        .bind(policy.lease_grace_seconds as f64)
        .bind(policy.unclaimed_seconds as f64)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| {
            let abandoned: bool = row.try_get("lease_abandoned")?;
            Ok(StalledRun {
                run_id: row.try_get("id")?,
                channel_id: row.try_get("channel_id")?,
                agent_member_id: row.try_get("agent_member_id")?,
                last_activity_at: row.try_get("last_activity_at")?,
                kind: if abandoned {
                    StallKind::LeaseAbandoned
                } else {
                    StallKind::UnclaimedExpired
                },
            })
        })
        .collect()
}

/// Lock the run's pending delivery job(s) and report whether any of them holds a LIVE
/// lease right now. The stall sweep calls this after it has locked the run and before it
/// ends it: the candidate read is a snapshot, and an agent may have re-claimed the job
/// between the snapshot and the run lock (a claim locks the job row, never the run). With
/// the job row locked here, a claim that arrives afterwards waits for the sweep's
/// transaction and finds a finished run.
pub async fn pending_job_has_live_lease_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT (o.lease_owner IS NOT NULL AND o.lease_expires_at > now()) AS live \
           FROM outbox o \
          WHERE o.workspace_id = $1 AND o.kind = 'agent_job' AND o.method = 'gateway' \
            AND o.status = 'pending' AND lower(o.payload->>'run_id') = lower($2::text) \
            FOR UPDATE OF o",
    )
    .bind(workspace_id)
    .bind(run_id.to_string())
    .fetch_all(&mut *conn)
    .await?;
    let mut live = false;
    for row in &rows {
        live |= row.try_get::<bool, _>("live")?;
    }
    Ok(live)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_codes_are_the_adrs_closed_vocabulary() {
        assert_eq!(StallKind::LeaseAbandoned.code(), "lease_abandoned");
        assert_eq!(StallKind::UnclaimedExpired.code(), "unclaimed_expired");
    }

    #[test]
    fn the_defaults_are_two_hours_and_a_day() {
        let policy = StallPolicy::default();
        assert_eq!(policy.lease_grace_seconds, 7200);
        assert_eq!(policy.unclaimed_seconds, 86_400);
    }
}
