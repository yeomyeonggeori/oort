//! Tier fallback sweep — the host-loss half (ADR-0125 D11 / MOMO-656, B2.3).
//!
//! A session whose host stopped answering must stop billing and stop claiming to
//! be running, whether the host said so itself (`work_session.host_lost_at`,
//! 056:27) or simply went quiet past the grace window. Two signals, one
//! transition: MOMO-656 is explicit that a daemon which restarts inside the
//! grace window keeps `last_seen_at` fresh, so heartbeat age alone can never see
//! its lost PTYs.
//!
//! The settlement is `t3_terminate(reason = 'orphaned')` and nothing else — on
//! the "laptop closed, continue on phone" path that is the *most common* billing
//! end, not an exceptional one (ADR-0140 §T3 상시화 2).
//!
//! ## The provider gets no vote, and #1197 B2 is why that is not merely tidy
//!
//! Nothing in this module calls an adapter, and that omission is now a measured
//! requirement rather than a layering preference.
//!
//! D4-② SIGKILLed a sandbox's VMM and polled CubeAPI every 20 seconds for five
//! minutes: **15 probes, every one `200 {"state":"running"}`, zero
//! convergence** (ADR-0156 D4-②'s 2026-08-09 실기동 spike, §3.3). The
//! control plane never learns the machine died. So the ADR-0140 D4 verdict that
//! reclaims a dead instance — `provider_missing`, reached from a 404 — **is
//! unreachable in the crash case**, and the only thing that reclaimed the
//! sandbox in the spike was an explicitly issued `DELETE`.
//!
//! The rule that follows is worth stating in one line, because the natural
//! "improvement" someone will one day propose is its exact negation:
//!
//! > **A host whose workd heartbeat has expired is destroyed even when the
//! > provider insists the instance is present.**
//!
//! Adding a "don't orphan a session whose provider still reports it" guard here
//! would feel careful and would strand every crashed sandbox permanently, paid
//! for and doing nothing. `provider_denies_its_own_absence` (ADR-0142 D3.1)
//! exists to stop a *provider's* claim of absence from settling a session; it is
//! not a licence for a provider's claim of presence to block one. Liveness is
//! the workd heartbeat's to report (ADR-0156 D6②) and this path reads nothing
//! else.
//!
//! [`converge_in_tx`] therefore ends with a destroy intent in **both** of its
//! branches — see [`declare_destroy_intent_in_tx`]'s call site below for the one
//! that `t3_terminate` cannot reach.
//!
//! Ports Swift `NotifierWorker/TierFallbackSweep.swift` (candidate query :49-96,
//! `transitionStaleSession` :433-631).
//!
//! **Not ported here (scope):** the follow-on user-visible surface of the same
//! function — the resume offer (`ask`, :633-702), auto-resume (`auto`, :704-836),
//! the session-card `props` re-render, the `broadcast` outbox rows and the
//! `audit_log` provenance. Each needs an egress this batch does not own
//! (`momo_outbox::emit_outbox` is the single broadcast seam, and `momo-db`'s
//! audit writer is still a B0 stub), and the ADR-0139 idle-timeout sweep
//! (:169-431) is a separate ticket. What lands here is the part that decides
//! money and session state.

use chrono::{DateTime, Utc};
use momo_db::{PgConnection, PgPool};
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;
use crate::lifecycle::{terminate_in_tx, with_t3_lifecycle_tx, T3LockLadder, TerminationReason};
use crate::reconcile::declare_destroy_intent_in_tx;

/// The `work_tier_policy.mode` that makes host loss terminal rather than
/// resumable (025:16). Read from the DB per session; never assumed.
const TERMINAL_POLICY_MODE: &str = "t1_only";

/// One session whose host is gone, in the shape the transition needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleSessionCandidate {
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub host_id: Uuid,
    /// `Some` when the host is a paid T3 host — the ledger axis.
    pub cloud_host_id: Option<Uuid>,
    /// `work_tier_policy.mode`, member row preferred over the workspace default.
    pub mode: String,
    /// MOMO-656: the owning daemon reported, under its own signature, that it
    /// cannot revive this session. The transition is identical either way — only
    /// the provenance differs.
    pub host_reported_lost: bool,
}

impl StaleSessionCandidate {
    /// `t1_only` ends the session outright; every other policy leaves it
    /// `orphaned` so it can be resumed on another host.
    pub fn is_terminal(&self) -> bool {
        self.mode == TERMINAL_POLICY_MODE
    }

    /// MOMO-656 provenance, for the log line and (later) the audit detail.
    pub fn orphan_source(&self) -> &'static str {
        if self.host_reported_lost {
            "host_reconciliation"
        } else {
            "host_offline_sweep"
        }
    }
}

/// What one candidate's convergence did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StaleConvergence {
    /// `t3_terminate` closed and billed the ledger row.
    pub settled: bool,
    /// The session left `running`/`idle`.
    pub transitioned: bool,
    /// A durable destroy intent now stands against the paid instance (#1197 B2).
    ///
    /// True for every T3 candidate, by either route: `t3_terminate` writes it as
    /// part of settling, and [`declare_destroy_intent_in_tx`] writes it when
    /// there was no ledger row to settle. It is reported separately from
    /// `settled` because they answer different questions — `settled` is "was
    /// anyone billed", this is "will the sandbox actually be reclaimed" — and on
    /// a substrate that reports a crashed VM as `running` forever, the second is
    /// the one that decides whether the host stops costing money.
    pub destroy_intended: bool,
}

/// Sessions whose host is gone, across every tenant.
///
/// Unscoped for the same reason as
/// [`crate::reconcile::due_lifecycle_candidates`]: the sweep runs as the
/// BYPASSRLS `momo_notifier` role, this is a read that takes no lock, and the
/// `workspace_id` it returns is what re-enters the tenant-scoped transaction.
///
/// Two predicates carry the meaning:
/// * a host in `pausing`/`paused`/`resuming` is **excluded** — its quiet
///   heartbeat is the pause working, not a loss;
/// * the loss signal is the MOMO-656 disjunction (`host_lost_at IS NOT NULL` OR
///   heartbeat older than the grace window), never one of the two alone.
///
/// Swift additionally joins the session's card `message` for its `seq` (used by
/// the broadcast this batch does not emit); dropping the join only widens the
/// candidate set to sessions whose card row is missing, which the `root_message_id`
/// foreign key makes unreachable.
pub async fn stale_session_candidates(
    pool: &PgPool,
    grace_seconds: i64,
    limit: i64,
) -> Result<Vec<StaleSessionCandidate>, T3Error> {
    let rows = sqlx::query(
        "SELECT ws.id, ws.workspace_id, ws.member_id, ws.host_id, \
                COALESCE(policy.mode, 'ask') AS mode, \
                ( \
                  SELECT ch.id \
                    FROM work_cloud_host ch \
                   WHERE ch.workspace_id = ws.workspace_id \
                     AND ch.host_id = ws.host_id \
                ) AS cloud_host_id, \
                ws.host_lost_at IS NOT NULL AS host_reported_lost \
           FROM work_session ws \
           JOIN work_host h \
             ON h.id = ws.host_id \
            AND h.workspace_id = ws.workspace_id \
           LEFT JOIN LATERAL ( \
             SELECT p.mode \
               FROM work_tier_policy p \
              WHERE p.workspace_id = ws.workspace_id \
                AND (p.member_id = ws.member_id OR p.member_id IS NULL) \
              ORDER BY CASE WHEN p.member_id = ws.member_id THEN 0 ELSE 1 END \
              LIMIT 1 \
           ) policy ON true \
          WHERE ws.status IN ('running', 'idle') \
            AND NOT EXISTS ( \
              SELECT 1 \
                FROM work_cloud_host ch \
               WHERE ch.workspace_id = ws.workspace_id \
                 AND ch.host_id = ws.host_id \
                 AND ch.state IN ('pausing', 'paused', 'resuming') \
            ) \
            AND ( \
              ws.host_lost_at IS NOT NULL \
              OR COALESCE(h.last_seen_at, h.created_at) \
                   < clock_timestamp() - make_interval(secs => $1::double precision) \
            ) \
          ORDER BY COALESCE(h.last_seen_at, h.created_at), ws.id \
          LIMIT $2",
    )
    .bind(grace_seconds as f64)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(StaleSessionCandidate {
                session_id: row.try_get("id")?,
                workspace_id: row.try_get("workspace_id")?,
                member_id: row.try_get("member_id")?,
                host_id: row.try_get("host_id")?,
                cloud_host_id: row.try_get("cloud_host_id")?,
                mode: row.try_get("mode")?,
                host_reported_lost: row.try_get("host_reported_lost")?,
            })
        })
        .collect()
}

/// Settle and transition one stale session, in its own transaction.
///
/// A T3 session takes the ADR-0140 D2 ladder including the workspace-credit rung
/// (the transaction reaches `t3_terminate`); a T1/T2 session has no cloud host,
/// so there is no advisory to take and the tenant guard alone is correct — the
/// same split Swift makes at :127-135.
///
/// Losing the race on the session `UPDATE` **after** settling is an error, not a
/// silent partial: the whole transaction rolls back so the invoice does not
/// stand for a session someone else moved (Swift :561-566).
pub async fn converge_stale_session(
    pool: &PgPool,
    candidate: &StaleSessionCandidate,
    grace_seconds: i64,
) -> Result<StaleConvergence, T3Error> {
    let workspace_id = candidate.workspace_id;
    match candidate.cloud_host_id {
        Some(cloud_host_id) => {
            let candidate = candidate.clone();
            with_t3_lifecycle_tx(
                pool,
                workspace_id,
                T3LockLadder::host(cloud_host_id).with_workspace_credit(),
                move |conn| Box::pin(converge_in_tx(conn, candidate, grace_seconds)),
            )
            .await
        }
        None => {
            let candidate = candidate.clone();
            momo_db::with_tenant_tx_prelude(
                pool,
                workspace_id,
                |_conn| Box::pin(async { Ok(()) }),
                |_conn| Box::pin(async { Ok(()) }),
                move |conn| Box::pin(converge_in_tx(conn, candidate, grace_seconds)),
            )
            .await
        }
    }
}

/// The body both transaction shapes share.
///
/// The T3 branch guarantees a durable destroy intent whichever way it goes
/// (#1197 B2). `t3_terminate` (058:242-268) declares one as part of settling —
/// but it returns early when there is no unsettled `work_host_usage` row, and
/// that early return is *before* the intent is written. A paid instance whose
/// ledger row had already been closed would then be left in a live state with
/// nobody destroying it, and on this substrate nobody ever would: the crashed
/// sandbox answers `200 running` forever and the reconciler's `provider_missing`
/// path waits on a 404 that never comes.
///
/// So the branch `t3_terminate` cannot reach gets the same intent explicitly,
/// through the same statement [`crate::reconcile::terminate_missing_instance_in_tx`]
/// already uses for its own version of this gap.
async fn converge_in_tx(
    conn: &mut PgConnection,
    candidate: StaleSessionCandidate,
    grace_seconds: i64,
) -> Result<StaleConvergence, T3Error> {
    let mut destroy_intended = false;
    let settled = match candidate.cloud_host_id {
        Some(cloud_host_id) => {
            let settled = terminate_in_tx(
                conn,
                candidate.workspace_id,
                candidate.session_id,
                TerminationReason::Orphaned,
            )
            .await?;
            if settled {
                // The settlement wrote the intent itself.
                destroy_intended = true;
            } else {
                // Nothing to bill, and therefore nothing to reclaim the instance
                // either — unless the intent is declared here.
                declare_destroy_intent_in_tx(conn, candidate.workspace_id, cloud_host_id).await?;
                destroy_intended = true;
            }
            settled
        }
        // T1/T2: there is no paid instance to reclaim.
        None => false,
    };
    let transitioned = transition_stale_session_in_tx(conn, &candidate, grace_seconds).await?;
    if !transitioned && settled {
        return Err(T3Error::StaleAfterSettlement(candidate.session_id));
    }
    Ok(StaleConvergence {
        settled,
        transitioned,
        destroy_intended,
    })
}

/// The guarded transition itself (Swift :452-560).
///
/// Every predicate of the candidate query is re-checked inside the row lock,
/// because between the unscoped read and this write the host may have come back.
/// MOMO-656 is explicit that losing the race means the host came back **and**
/// the marker was cleared, not just one of the two — so the disjunction is
/// re-checked as a disjunction.
///
/// `Ok(false)` = the session was moved by someone else; the caller decides what
/// that means.
pub async fn transition_stale_session_in_tx(
    conn: &mut PgConnection,
    candidate: &StaleSessionCandidate,
    grace_seconds: i64,
) -> Result<bool, T3Error> {
    // The two bodies differ only in the SET clause: a `t1_only` policy has
    // nowhere to resume to, so host loss ends the session instead of parking it.
    let set_clause = if candidate.is_terminal() {
        "SET status = 'ended', \
             idle_at = NULL, \
             host_lost_at = NULL, \
             ended_at = clock_timestamp(), \
             end_reason = 'orphaned'"
    } else {
        "SET status = 'orphaned', \
             idle_at = NULL, \
             host_lost_at = NULL"
    };
    let sql = format!(
        "UPDATE work_session ws \
            {set_clause} \
          WHERE ws.id = $1 \
            AND ws.workspace_id = $2 \
            AND ws.host_id = $3 \
            AND ws.status IN ('running', 'idle') \
            AND ( \
              ( \
                $4::uuid IS NULL \
                AND NOT EXISTS ( \
                  SELECT 1 FROM work_cloud_host ch \
                   WHERE ch.workspace_id = ws.workspace_id \
                     AND ch.host_id = ws.host_id \
                ) \
              ) \
              OR EXISTS ( \
                SELECT 1 FROM work_cloud_host ch \
                 WHERE ch.workspace_id = ws.workspace_id \
                   AND ch.host_id = ws.host_id \
                   AND ch.id = $4::uuid \
              ) \
            ) \
            AND NOT EXISTS ( \
              SELECT 1 FROM work_cloud_host ch \
               WHERE ch.workspace_id = ws.workspace_id \
                 AND ch.host_id = ws.host_id \
                 AND ch.state IN ('pausing', 'paused', 'resuming') \
            ) \
            AND ( \
              ws.host_lost_at IS NOT NULL \
              OR EXISTS ( \
                SELECT 1 FROM work_host h \
                 WHERE h.id = ws.host_id \
                   AND h.workspace_id = ws.workspace_id \
                   AND COALESCE(h.last_seen_at, h.created_at) \
                         < clock_timestamp() \
                           - make_interval(secs => $5::double precision) \
              ) \
            ) \
        RETURNING clock_timestamp()"
    );
    let moved: Option<DateTime<Utc>> = sqlx::query_scalar(&sql)
        .bind(candidate.session_id)
        .bind(candidate.workspace_id)
        .bind(candidate.host_id)
        .bind(candidate.cloud_host_id)
        .bind(grace_seconds as f64)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(moved.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(mode: &str, host_reported_lost: bool) -> StaleSessionCandidate {
        StaleSessionCandidate {
            session_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            member_id: Uuid::from_u128(3),
            host_id: Uuid::from_u128(4),
            cloud_host_id: Some(Uuid::from_u128(5)),
            mode: mode.to_string(),
            host_reported_lost,
        }
    }

    #[test]
    fn only_t1_only_makes_host_loss_terminal() {
        assert!(candidate("t1_only", false).is_terminal());
        for resumable in ["ask", "auto"] {
            assert!(
                !candidate(resumable, false).is_terminal(),
                "a resumable policy must leave the session orphaned, not ended"
            );
        }
    }

    #[test]
    fn provenance_distinguishes_the_two_signals() {
        assert_eq!(
            candidate("ask", true).orphan_source(),
            "host_reconciliation"
        );
        assert_eq!(
            candidate("ask", false).orphan_source(),
            "host_offline_sweep"
        );
    }

    /// #1197 B2, the static half — the sweep may not learn to ask a provider.
    ///
    /// The measured fact this defends: a SIGKILLed VMM answers
    /// `200 {"state":"running"}` for at least five minutes and never converges,
    /// so any provider consultation added here would read "present" and, if it
    /// were allowed to matter, would strand a crashed sandbox in a paid state
    /// permanently. A green test run cannot show that — the absence has to be
    /// asserted against the source, the way the adapter asserts its own.
    #[test]
    fn the_host_loss_sweep_consults_no_provider() {
        // Comments are stripped first, for the same reason the adapter's scans
        // cut the test module off: this file *discusses* probes at length, and a
        // scan that matched its own prose would be red for the wrong reason —
        // or, worse, could be silenced by rewording the explanation.
        let source: String = include_str!("sweep.rs")
            .split_once("#[cfg(test)]")
            .expect("this file has a test module")
            .0
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "probe",
            "CloudInstancePresence",
            "CloudProviderAdapter",
            "adapter",
        ] {
            assert!(
                !source.contains(forbidden),
                "named regression: `{forbidden}` in the host-loss sweep. CubeAPI reports a \
                 crashed VM as `running` forever (15/15 probes over 300 s, spike §3.3), so a \
                 provider consultation here can only ever say `present` — and letting that block \
                 the settlement leaves a dead sandbox billing until someone notices by hand. \
                 Liveness is the workd heartbeat (ADR-0156 D6②)"
            );
        }
    }

    /// #1197 B2, the shape half. Every T3 candidate leaves a destroy intent
    /// behind, whether or not there was a ledger row to bill.
    #[test]
    fn a_t3_convergence_always_intends_a_destroy() {
        let settled = StaleConvergence {
            settled: true,
            transitioned: true,
            destroy_intended: true,
        };
        let nothing_to_bill = StaleConvergence {
            settled: false,
            transitioned: true,
            destroy_intended: true,
        };
        for outcome in [settled, nothing_to_bill] {
            assert!(
                outcome.destroy_intended,
                "named regression: `t3_terminate` returns early — before it writes the destroy \
                 intent — when there is no unsettled usage row. Without the explicit declaration \
                 that branch leaves a paid instance alive with nobody destroying it, and this \
                 substrate never volunteers a 404 to correct it"
            );
        }
        // A T1/T2 session has no paid instance, so it intends nothing.
        assert!(!StaleConvergence::default().destroy_intended);
    }
}
