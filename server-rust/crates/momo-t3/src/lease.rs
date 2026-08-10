//! Instance lease renewal — the ledger half of #1197 H1.
//!
//! ## Why this module exists at all
//!
//! Every substrate before CubeSandbox kept an instance alive until momo said
//! otherwise. CubeSandbox does not: `timeout` is an **absolute TTL from
//! creation**, and D4-② could not move it with a detail GET, a list GET, an SDK
//! exec, a 60 s in-sandbox CPU burn, or outbound HTTPS from the sandbox — five
//! stimuli, zero milliseconds (ADR-0156 D4-②'s 2026-08-09 실기동 spike, §4).
//! Only one explicit renewal call moves it.
//!
//! So a paid session doing real work is deleted on the substrate's clock unless
//! momo actively says otherwise, and saying so is what this module schedules.
//!
//! ## The withholding is the feature
//!
//! It would be simpler to renew every live instance unconditionally. That would
//! also throw away the only automatic reclaim path momo has.
//!
//! D4-② SIGKILLed a sandbox's VMM and then asked CubeAPI about it every 20
//! seconds for five minutes: **15 probes, 15 × `200 {"state":"running"}`, zero
//! convergence.** The control plane never notices. `provider_missing` — the
//! ADR-0140 D4 verdict that reclaims a dead instance — is reached from a 404
//! that will never arrive, and the sandbox bills forever. The only thing that
//! reclaimed it was an explicitly issued `DELETE`.
//!
//! That gives the ledger two levers against a crash, and this module is the
//! second:
//!
//! 1. `momo_t3::sweep` sees the workd heartbeat expire and settles the session,
//!    which declares the durable `destroy_pending` intent that the reconciler
//!    then drives to an actual `DELETE`. Active, prompt, and requires momo to be
//!    running.
//! 2. **This module stops renewing that host's lease.** Passive, bounded by one
//!    lease, and requires momo to be *not* running — which is precisely the case
//!    lever 1 cannot cover.
//!
//! Hence [`renewable_lease_candidates`] excludes exactly what
//! [`crate::sweep::stale_session_candidates`] includes. A host momo has given up
//! on is a host momo stops paying to keep alive, and the substrate reaps it
//! about a lease later whether momo is there to watch or not.
//!
//! ## What a renewal is not
//!
//! It is not a lifecycle transition. It writes no row, takes no advisory, claims
//! no durable intent, and invents no state — ADR-0140 D4's vocabulary is
//! untouched by design (#1197 B2's "새 상태 발명 금지"). A renewal is momo
//! telling a substrate that momo is still here.

use momo_db::PgPool;
use momo_provider::CloudInstanceRef;
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;

/// The `work_cloud_host` states whose instance is alive and worth keeping alive.
///
/// `paused` and the two transitional states are **in** the list, and that is
/// load bearing in the opposite direction from everything else here: a paused
/// sandbox is a memory snapshot on the substrate's disk with a lease ticking
/// against it exactly like a running one's, and its workd is frozen so no
/// heartbeat arrives. Withhold renewal from it and every pause would die at one
/// lease, taking ADR-0141's 24 h paused→hibernate window with it.
///
/// `provisioning` is absent because it has no instance yet; `destroy_pending`,
/// `destroyed` and `failed` are absent because renewing them would pay to keep
/// alive something momo has already decided to end.
const RENEWABLE_STATES: [&str; 5] = ["ready", "running", "pausing", "paused", "resuming"];

/// One instance whose lease momo intends to keep renewing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseRenewalCandidate {
    pub cloud_host_id: Uuid,
    pub workspace_id: Uuid,
    /// The provider handle. The worker resolves an adapter from this and asks
    /// its capabilities whether a lease exists at all — it never reads the id.
    pub instance: CloudInstanceRef,
    /// `work_cloud_host.state`, for the log line only.
    pub state: String,
}

/// One page of instances that should still be kept alive, across every tenant.
///
/// Unscoped for the same reason as [`crate::reconcile::due_lifecycle_candidates`]
/// and [`crate::sweep::stale_session_candidates`]: the renewal loop runs as the
/// BYPASSRLS `momo_notifier` role, this is a read that takes no lock, and it can
/// only *propose* work — the renewal it proposes touches no database row at all.
///
/// Three predicates carry the meaning, and the third is the one to read twice:
///
/// * the host is in a [`RENEWABLE_STATES`] state and has a provider handle;
/// * it is not already destroyed, failed, or under a destroy intent;
/// * **either it is paused/transitioning, or its workd heartbeat is fresh.**
///
/// That last disjunction is the exact complement of the sweep's exclusion. A
/// `running` host whose daemon has gone quiet past the grace window produces no
/// candidate here and *does* produce one there: momo simultaneously stops
/// renewing its lease and starts settling its session. If momo survives, lever 1
/// destroys it in seconds; if momo does not, the lease expires and the substrate
/// destroys it. There is no ordering between the two in which the instance
/// survives, which is the property a crashed VM's permanent `running` reply
/// takes away from every other mechanism.
///
/// ## Why this pages, and why that is not a performance concern
///
/// `after` is a keyset cursor over `id`; the caller walks it to exhaustion every
/// tick ([`crate::lease::renewal_pages`] describes the contract). A plain
/// `LIMIT` would be a **starvation bug with a body count**, and the reason is
/// specific to this loop:
///
/// the reconciler's claim writes `lifecycle_operation_next_attempt_at` and the
/// sweep's transition moves the session out of the candidate set, so in both
/// cases acting on a row *removes it from the next query*. A renewal writes
/// nothing at all — deliberately, it is not a lifecycle transition — so the
/// ordering is identical on every tick. With a bare `LIMIT n`, hosts `n+1..`
/// would never be renewed once, and would be deleted by the substrate one lease
/// later while perfectly healthy. The batch size is an operator's throughput
/// knob everywhere else in this worker; here it would have been a silent cap on
/// how many sessions momo can keep alive.
pub async fn renewable_lease_candidates(
    pool: &PgPool,
    grace_seconds: i64,
    limit: i64,
    after: Option<Uuid>,
) -> Result<Vec<LeaseRenewalCandidate>, T3Error> {
    let rows = sqlx::query(
        "SELECT ch.id, ch.workspace_id, ch.provider, ch.provider_sandbox_id, ch.state \
           FROM work_cloud_host ch \
           LEFT JOIN work_host h \
             ON h.id = ch.host_id \
            AND h.workspace_id = ch.workspace_id \
          WHERE ch.state = ANY($1) \
            AND ch.provider_sandbox_id IS NOT NULL \
            AND ( \
              ch.state IN ('pausing', 'paused', 'resuming') \
              OR ( \
                h.id IS NOT NULL \
                AND COALESCE(h.last_seen_at, h.created_at) \
                      >= clock_timestamp() - make_interval(secs => $2::double precision) \
              ) \
            ) \
            AND ($4::uuid IS NULL OR ch.id > $4::uuid) \
          ORDER BY ch.id \
          LIMIT $3",
    )
    .bind(RENEWABLE_STATES.as_slice())
    .bind(grace_seconds as f64)
    .bind(limit)
    .bind(after)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(LeaseRenewalCandidate {
                cloud_host_id: row.try_get("id")?,
                workspace_id: row.try_get("workspace_id")?,
                instance: CloudInstanceRef {
                    provider_id: row.try_get("provider")?,
                    instance_id: row.try_get("provider_sandbox_id")?,
                },
                state: row.try_get("state")?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The complement property, asserted against the two SQL fragments rather
    /// than trusted to review — the sweep and the renewal must never both claim
    /// a host, and must never both ignore one.
    #[test]
    fn the_renewable_states_are_alive_and_not_yet_condemned() {
        for alive in RENEWABLE_STATES {
            assert!(
                !matches!(alive, "destroy_pending" | "destroyed" | "failed"),
                "named regression: renewing {alive} pays to keep alive an instance momo has \
                 already decided to end"
            );
        }
        for parked in ["pausing", "paused", "resuming"] {
            assert!(
                RENEWABLE_STATES.contains(&parked),
                "named regression: a paused sandbox's lease ticks exactly like a running one's, \
                 and its workd is frozen so no heartbeat arrives. Drop {parked} from this list \
                 and every pause dies at one lease, taking ADR-0141's 24 h paused->hibernate \
                 window with it"
            );
        }
        assert!(
            !RENEWABLE_STATES.contains(&"provisioning"),
            "a host being provisioned has no instance handle to renew"
        );
    }

    /// The query must be a keyset walk, not a bare `LIMIT` (#1197 H1).
    ///
    /// Named regression, asserted against the SQL because the failure it
    /// prevents is invisible in a green test run and lethal in production: a
    /// renewal writes nothing, so acting on a row does not remove it from the
    /// next query the way the reconciler's claim and the sweep's transition do.
    /// A bare `LIMIT n` would therefore return the same first `n` hosts forever
    /// and let hosts `n+1..` be deleted by the substrate one lease later while
    /// perfectly healthy.
    #[test]
    fn the_candidate_walk_cannot_starve_hosts_past_the_batch_size() {
        let source = include_str!("lease.rs")
            .split_once("#[cfg(test)]")
            .expect("this file has a test module")
            .0;
        assert!(
            source.contains("ch.id > $4::uuid"),
            "named regression: the candidate read must page by keyset. Without the cursor the \
             ordering is identical on every tick — a renewal writes nothing — so every host past \
             the batch size is never renewed and dies at one lease while healthy"
        );
        assert!(
            source.contains("ORDER BY ch.id"),
            "the cursor and the ordering must be the same column, or a page can skip rows"
        );
    }
}
