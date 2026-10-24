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
//! * `woken_not_collected` (ADR-0200 증보 3, #4284) — the doorbell reached the agent
//!   (`doorbell_rung` `<edge>_ok` in the run's ledger) and, `woken_expire_seconds` later,
//!   nothing says the agent took the job or is busy. The candidate read below is only a
//!   SUPERSET (queued, never claimed, an `_ok` ring row, old enough); the verdict is
//!   `momo_agent::woken_uncollected_verdict`, run by the sweep on the locked rows.
//!
//! This module lives beside the delivery job it reads (the lease is columns on an
//! `outbox` row); it only READS `agent_run`. The write — ending the run — is
//! `momo_agent::end_stalled_run_in_tx`, composed by the sweep in one tenant transaction.

use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// ADR-0200 증보 3 E2: the default `woken_not_collected` window and its clamp.
pub const DEFAULT_WOKEN_EXPIRE_MINUTES: i64 = 30;
pub const MIN_WOKEN_EXPIRE_MINUTES: i64 = 10;
pub const MAX_WOKEN_EXPIRE_MINUTES: i64 = 1440;

/// `MOMO_RUN_WOKEN_EXPIRE_MINUTES` → seconds, clamped to 10..=1440 (a value outside the
/// range uses the boundary, never the default).
pub fn woken_expire_seconds_from_minutes(minutes: i64) -> i64 {
    minutes.clamp(MIN_WOKEN_EXPIRE_MINUTES, MAX_WOKEN_EXPIRE_MINUTES) * 60
}

/// The grace periods, in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallPolicy {
    pub lease_grace_seconds: i64,
    pub unclaimed_seconds: i64,
    /// ADR-0200 증보 3 E2: how long after the first uncollected doorbell the run is ended
    /// (`MOMO_RUN_WOKEN_EXPIRE_MINUTES`, 30 min = two 15-minute sweeps).
    pub woken_expire_seconds: i64,
}

impl Default for StallPolicy {
    fn default() -> Self {
        StallPolicy {
            lease_grace_seconds: 2 * 3600,
            unclaimed_seconds: 24 * 3600,
            woken_expire_seconds: DEFAULT_WOKEN_EXPIRE_MINUTES * 60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallKind {
    LeaseAbandoned,
    UnclaimedExpired,
    /// ADR-0200 증보 3: woken by the doorbell, never collected.
    WokenNotCollected,
}

impl StallKind {
    /// The closed machine code written to `agent_run.error.code` and the ledger.
    pub fn code(self) -> &'static str {
        match self {
            StallKind::LeaseAbandoned => "lease_abandoned",
            StallKind::UnclaimedExpired => "unclaimed_expired",
            StallKind::WokenNotCollected => "woken_not_collected",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StalledRun {
    pub run_id: Uuid,
    pub channel_id: Uuid,
    pub agent_member_id: Uuid,
    pub kind: StallKind,
    /// ADR-0200 증보 3 E4: the server's own welcome run (`input.welcome_kind` or a
    /// `welcome:` idempotency key). Nobody asked for it, so nobody is told it ended.
    pub is_welcome: bool,
    /// The run's ledger has a `claimed` row — an agent took it, so a terminal frame has a
    /// badge to clear even for a welcome run (which has no start frame of its own).
    pub claimed: bool,
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
            AND o.kind = 'agent_job' AND o.status IN ('pending', 'processing') \
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

/// `is_welcome` / `claimed` for a candidate row `r` (ADR-0200 증보 3 E4). The welcome
/// discriminator is the run's own marker — NOT "no trigger message" (a Work run has none
/// either, and it is a thing a person asked for).
const WELCOME_AND_CLAIMED_COLUMNS: &str = "\
  (r.input ? 'welcome_kind' OR COALESCE(r.idempotency_key, '') LIKE 'welcome:%') AS is_welcome, \
  EXISTS (SELECT 1 FROM agent_run_event c \
           WHERE c.workspace_id = r.workspace_id AND c.run_id = r.id \
             AND c.kind = 'claimed') AS claimed";

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
                {WELCOME_AND_CLAIMED_COLUMNS}, \
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
                is_welcome: row.try_get("is_welcome")?,
                claimed: row.try_get("claimed")?,
                kind: if abandoned {
                    StallKind::LeaseAbandoned
                } else {
                    StallKind::UnclaimedExpired
                },
            })
        })
        .collect()
}

/// ADR-0200 증보 3 E1 — the woken-not-collected CANDIDATE read: a superset of what the
/// verdict accepts. `$1` workspace (NULL = every tenant), `$2` window seconds.
///
/// Why a superset: the verdict's T is the time of one of THIS run's `_ok` ring rows (or a
/// later manual ring), and a ring row is written after the run exists, so
/// `now - created_at >= now - T >= window` for every run the verdict can accept. Nothing
/// here decides; `woken_uncollected_verdict` does, on the locked rows. `code ~ '_ok$'` —
/// not `LIKE '%_ok'`, where `_` is a wildcard.
const WOKEN_CANDIDATES_FROM_WHERE: &str = "\
  FROM agent_run r \
 WHERE ($1::uuid IS NULL OR r.workspace_id = $1) \
   AND r.status = 'queued' \
   AND agent_run_event_is_hosted(r.workspace_id, r.agent_member_id) \
   AND r.created_at <= now() - make_interval(secs => $2::float8) \
   AND NOT EXISTS (SELECT 1 FROM agent_run_event c \
                    WHERE c.workspace_id = r.workspace_id AND c.run_id = r.id \
                      AND c.kind = 'claimed') \
   AND EXISTS (SELECT 1 FROM agent_run_event e \
                WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id \
                  AND e.kind = 'doorbell_rung' AND e.code ~ '_ok$')";

/// Workspaces with at least one woken-not-collected candidate (cross-tenant **read**).
pub async fn workspaces_with_woken_candidates(
    conn: &mut PgConnection,
    policy: StallPolicy,
    limit: i64,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let sql = format!(
        "SELECT DISTINCT workspace_id FROM ( \
           SELECT r.workspace_id {WOKEN_CANDIDATES_FROM_WHERE} LIMIT $3) candidates"
    );
    sqlx::query_scalar(&sql)
        .bind(Option::<Uuid>::None)
        .bind(policy.woken_expire_seconds as f64)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await
}

/// Up to `limit` woken candidates of one workspace, ROW-LOCKED (`FOR UPDATE OF r SKIP
/// LOCKED`), oldest first. Each is `kind = WokenNotCollected` only as a CANDIDATE: the
/// caller must still get a `true` verdict before ending it.
pub async fn lock_woken_candidates_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    policy: StallPolicy,
    limit: i64,
) -> Result<Vec<StalledRun>, sqlx::Error> {
    let sql = format!(
        "SELECT r.id, r.channel_id, r.agent_member_id, \
                GREATEST(r.created_at, r.updated_at) AS last_activity_at, \
                {WELCOME_AND_CLAIMED_COLUMNS} \
         {WOKEN_CANDIDATES_FROM_WHERE} \
          ORDER BY r.created_at ASC \
          LIMIT $3 \
            FOR UPDATE OF r SKIP LOCKED"
    );
    let rows = sqlx::query(&sql)
        .bind(Some(workspace_id))
        .bind(policy.woken_expire_seconds as f64)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| {
            Ok(StalledRun {
                run_id: row.try_get("id")?,
                channel_id: row.try_get("channel_id")?,
                agent_member_id: row.try_get("agent_member_id")?,
                last_activity_at: row.try_get("last_activity_at")?,
                is_welcome: row.try_get("is_welcome")?,
                claimed: row.try_get("claimed")?,
                kind: StallKind::WokenNotCollected,
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
          WHERE o.workspace_id = $1 AND o.kind = 'agent_job' \
            AND o.status IN ('pending', 'processing') \
            AND lower(o.payload->>'run_id') = lower($2::text) \
          ORDER BY o.id \
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
        assert_eq!(StallKind::WokenNotCollected.code(), "woken_not_collected");
    }

    #[test]
    fn the_woken_window_defaults_to_thirty_minutes_and_clamps_to_its_range() {
        assert_eq!(StallPolicy::default().woken_expire_seconds, 1800);
        // outside the range the BOUNDARY is used, not the default
        assert_eq!(woken_expire_seconds_from_minutes(1), 10 * 60);
        assert_eq!(woken_expire_seconds_from_minutes(0), 10 * 60);
        assert_eq!(woken_expire_seconds_from_minutes(-5), 10 * 60);
        assert_eq!(woken_expire_seconds_from_minutes(10), 10 * 60);
        assert_eq!(woken_expire_seconds_from_minutes(30), 30 * 60);
        assert_eq!(woken_expire_seconds_from_minutes(1440), 1440 * 60);
        assert_eq!(woken_expire_seconds_from_minutes(99_999), 1440 * 60);
    }

    #[test]
    fn the_candidate_read_matches_the_ok_suffix_not_a_like_wildcard() {
        // `_` is a single-character wildcard in LIKE: `LIKE '%_ok'` would match "xok".
        assert!(WOKEN_CANDIDATES_FROM_WHERE.contains("e.code ~ '_ok$'"));
        assert!(!WOKEN_CANDIDATES_FROM_WHERE.contains("LIKE"));
    }

    #[test]
    fn the_defaults_are_two_hours_and_a_day() {
        let policy = StallPolicy::default();
        assert_eq!(policy.lease_grace_seconds, 7200);
        assert_eq!(policy.unclaimed_seconds, 86_400);
    }
}
