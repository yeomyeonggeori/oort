//! ADR-0140 D4 — the durable-intent reconciliation surface (batch B2.3).
//!
//! The provider call deliberately happens **outside** PostgreSQL, so the work
//! splits into three steps and this module owns the two that touch the database:
//!
//! 1. **claim** — [`claim_lifecycle_intent`] takes the ladder and calls
//!    `t3_claim_lifecycle_operation` (057:188), which bumps the version (the
//!    stale-response marker), counts the attempt and pushes the next claim out
//!    by `t3_lifecycle_backoff`. The claim *is* the retry schedule; nothing here
//!    reimplements a backoff.
//! 2. *(the caller calls the provider, keyed by the durable operation id.)*
//! 3. **apply** — [`apply_convergence_to_intent`] retakes the ladder,
//!    revalidates `(operation_id, version, state)` through
//!    `t3_lifecycle_intent_is_current` (057:154) and only then writes. A response
//!    that fails revalidation is discarded: it is an answer to a question nobody
//!    is asking any more.
//!
//! Two properties are structural rather than conventional:
//!
//! * **No settlement SQL.** The terminal path calls
//!   [`crate::lifecycle::terminate_in_tx`] → `t3_terminate`, and nothing else.
//! * **No transition allow-list.** Every state change is a plain `UPDATE` that
//!   `work_cloud_host_transition_guard` (053:68) judges.
//!
//! Ports Swift `NotifierWorker/CloudLifecycleReconciler.swift` (`claim` :99-156,
//! `reconcile` :158-316, `confirm` :319-391, `terminate` :395-504).
//!
//! **Not ported here (scope):** the `provisioning` create-completion branch
//! (:506-559). It converges a managed `create`, needs the bootstrap-token +
//! public-URL material, and the Rust REST surface provisions BYOC only (B2.2) —
//! so there is no managed create for it to finish yet.

use futures::future::BoxFuture;
use momo_db::{PgConnection, PgPool};
use momo_provider::CloudInstanceRef;
use sqlx::Row;
use uuid::Uuid;

use crate::billing::{pause_usage_in_tx, resume_usage_in_tx};
use crate::convergence::{CloudLifecycleConvergence, CloudLifecyclePhase};
use crate::error::T3Error;
use crate::lifecycle::{
    terminate_in_tx, transition_cloud_host_in_tx, with_t3_lifecycle_tx, CloudHostState,
    T3LockLadder, TerminationReason,
};

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

/// One `work_cloud_host` row whose durable intent is due for another attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleCandidate {
    pub cloud_host_id: Uuid,
    pub workspace_id: Uuid,
}

/// Rows whose intent is claimable now, across every tenant.
///
/// Read with **no tenant GUC**, which is legitimate for exactly one caller: the
/// reconciliation worker connects as the BYPASSRLS `momo_notifier` role
/// (`bootstrap_roles.sql:33`) precisely because a durable intent must converge
/// whichever workspace it belongs to. It is a read, it takes no lock, and the
/// `workspace_id` it returns is what re-enters the tenant-scoped ladder in
/// [`claim_lifecycle_intent`] — so the unscoped step can only *propose* work.
///
/// Ports the `*ing` branch of Swift's candidate query
/// (`CloudLifecycleReconciler.swift:48-64`); `claim_delay_seconds` is its
/// `interval '5 seconds'`, and the index that serves it is
/// `work_cloud_host_lifecycle_due_idx` (057:245).
pub async fn due_lifecycle_candidates(
    pool: &PgPool,
    claim_delay_seconds: i64,
    limit: i64,
) -> Result<Vec<LifecycleCandidate>, T3Error> {
    let rows = sqlx::query(
        "SELECT id, workspace_id \
           FROM work_cloud_host \
          WHERE state IN ('pausing', 'resuming', 'destroy_pending') \
            AND COALESCE( \
                  lifecycle_operation_next_attempt_at, \
                  lifecycle_operation_started_at \
                    + make_interval(secs => $1::double precision) \
                ) <= clock_timestamp() \
          ORDER BY updated_at, id \
          LIMIT $2",
    )
    .bind(claim_delay_seconds as f64)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(LifecycleCandidate {
                cloud_host_id: row.try_get("id")?,
                workspace_id: row.try_get("workspace_id")?,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// the claim
// ---------------------------------------------------------------------------

/// One claimed durable intent, as `t3_claim_lifecycle_operation` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedIntent {
    pub cloud_host_id: Uuid,
    pub workspace_id: Uuid,
    pub host_id: Option<Uuid>,
    pub provider: String,
    pub provider_sandbox_id: Option<String>,
    pub state: String,
    pub operation_id: Option<Uuid>,
    pub operation_kind: Option<String>,
    /// Bumped by the claim. Any provider response quoting an older version
    /// belongs to an attempt that has been superseded.
    pub version: i64,
    pub attempts: i32,
    /// The intent outlived its bound (057:37-40): stop waiting, ask for the fact.
    pub deadline_exceeded: bool,
    pub requested_display_name: Option<String>,
}

/// A claimed intent that is complete enough to act on.
///
/// Swift guards the same four things inline
/// (`CloudLifecycleReconciler.swift:171-175`); making them non-optional here
/// means the convergence path cannot be written against a half-formed intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionableIntent {
    pub cloud_host_id: Uuid,
    pub workspace_id: Uuid,
    pub host_id: Uuid,
    pub phase: CloudLifecyclePhase,
    pub instance: CloudInstanceRef,
    pub operation_id: Uuid,
    pub version: i64,
    pub attempts: i32,
    pub deadline_exceeded: bool,
}

impl ActionableIntent {
    /// ADR-0140 D4 ② — the provider call is keyed by the durable operation, so a
    /// retry cannot double-act on the provider.
    pub fn idempotency_key(&self) -> String {
        self.operation_id.to_string()
    }
}

impl ClaimedIntent {
    /// `None` when the row cannot be converged against a provider: no phase, no
    /// sandbox handle, no durable operation, or no bound host.
    pub fn actionable(&self) -> Option<ActionableIntent> {
        Some(ActionableIntent {
            cloud_host_id: self.cloud_host_id,
            workspace_id: self.workspace_id,
            host_id: self.host_id?,
            phase: CloudLifecyclePhase::from_db_label(&self.state)?,
            instance: CloudInstanceRef {
                provider_id: self.provider.clone(),
                instance_id: self.provider_sandbox_id.clone()?,
            },
            operation_id: self.operation_id?,
            version: self.version,
            attempts: self.attempts,
            deadline_exceeded: self.deadline_exceeded,
        })
    }
}

/// Claim one candidate's durable intent (057:188).
///
/// The function takes the ADR-0140 D2 ladder first
/// ([`with_t3_lifecycle_tx`]) and the claim statement re-asserts the host
/// advisory itself, so two reconciler instances racing the same row serialize on
/// the advisory and exactly one of them gets a row back — the other's
/// `next_attempt_at` predicate no longer holds.
///
/// `Ok(None)` = another instance got there first, or the row left the claimable
/// state between the candidate scan and the claim.
pub async fn claim_lifecycle_intent(
    pool: &PgPool,
    candidate: LifecycleCandidate,
    claim_delay_seconds: i64,
) -> Result<Option<ClaimedIntent>, T3Error> {
    let LifecycleCandidate {
        cloud_host_id,
        workspace_id,
    } = candidate;
    with_t3_lifecycle_tx(
        pool,
        workspace_id,
        T3LockLadder::host(cloud_host_id),
        move |conn| {
            Box::pin(async move {
                claim_lifecycle_operation_in_tx(conn, cloud_host_id, claim_delay_seconds).await
            })
        },
    )
    .await
}

/// The claim statement itself, for a caller that already holds the ladder.
pub async fn claim_lifecycle_operation_in_tx(
    conn: &mut PgConnection,
    cloud_host_id: Uuid,
    claim_delay_seconds: i64,
) -> Result<Option<ClaimedIntent>, T3Error> {
    let row = sqlx::query(
        "SELECT workspace_id, host_id, provider, provider_sandbox_id, state, \
                lifecycle_operation_id, lifecycle_operation_kind, \
                lifecycle_operation_version, lifecycle_operation_attempts, \
                deadline_exceeded, requested_display_name \
           FROM t3_claim_lifecycle_operation( \
                  $1, make_interval(secs => $2::double precision))",
    )
    .bind(cloud_host_id)
    .bind(claim_delay_seconds as f64)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(ClaimedIntent {
        cloud_host_id,
        workspace_id: row.try_get("workspace_id")?,
        host_id: row.try_get("host_id")?,
        provider: row.try_get("provider")?,
        provider_sandbox_id: row.try_get("provider_sandbox_id")?,
        state: row.try_get("state")?,
        operation_id: row.try_get("lifecycle_operation_id")?,
        operation_kind: row.try_get("lifecycle_operation_kind")?,
        version: row.try_get("lifecycle_operation_version")?,
        attempts: row.try_get("lifecycle_operation_attempts")?,
        deadline_exceeded: row.try_get("deadline_exceeded")?,
        requested_display_name: row.try_get("requested_display_name")?,
    }))
}

/// ADR-0140 D4 ③'s stale-response guard (057:154). Locks the cloud host row and
/// reports whether the intent a provider response was issued for is still the
/// current one. The row lock it takes is held for the rest of the transaction,
/// which is what lets the writes that follow key on identity alone.
pub async fn lifecycle_intent_is_current_in_tx(
    conn: &mut PgConnection,
    cloud_host_id: Uuid,
    operation_id: Uuid,
    version: i64,
    expected_state: &str,
) -> Result<bool, T3Error> {
    let current: Option<bool> =
        sqlx::query_scalar("SELECT t3_lifecycle_intent_is_current($1, $2, $3, $4)")
            .bind(cloud_host_id)
            .bind(operation_id)
            .bind(version)
            .bind(expected_state)
            .fetch_one(&mut *conn)
            .await?;
    Ok(current.unwrap_or(false))
}

// ---------------------------------------------------------------------------
// applying a convergence
// ---------------------------------------------------------------------------

/// What [`apply_convergence_to_intent`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppliedConvergence {
    /// The operation's promised state was reached.
    Confirmed(CloudHostState),
    /// The operation was abandoned; the host fell back to the factual state.
    Reverted(CloudHostState),
    /// `t3_terminate` ran (or the ledger was already settled) and the host is
    /// out of service. `settled` mirrors that statement's own answer.
    Terminated { settled: bool },
    /// Revalidation failed: the response belongs to a superseded intent.
    StaleDiscarded,
    /// Nothing to do — [`CloudLifecycleConvergence::Retry`], or a phase with no
    /// revert state.
    Skipped,
}

/// ADR-0140 D4 ③ — ladder first, then revalidate, then confirm.
///
/// The workspace-credit rung is taken **only** for a terminate, because that is
/// the only convergence that reaches `t3_terminate` (which appends a
/// `credit_entry` and therefore arrives at the workspace row from the opposite
/// direction, 045:122-136). Taking a lock the transaction does not need is how
/// the workspace axis grows contention (ADR-0140 D2).
pub async fn apply_convergence_to_intent(
    pool: &PgPool,
    intent: &ActionableIntent,
    convergence: CloudLifecycleConvergence,
) -> Result<AppliedConvergence, T3Error> {
    if convergence == CloudLifecycleConvergence::Retry {
        // The claim already recorded the attempt and pushed the next one out by
        // `t3_lifecycle_backoff`. Nothing to write: the durable intent *is* the
        // retry.
        return Ok(AppliedConvergence::Skipped);
    }

    let ladder = if convergence == CloudLifecycleConvergence::Terminate {
        T3LockLadder::host(intent.cloud_host_id).with_workspace_credit()
    } else {
        T3LockLadder::host(intent.cloud_host_id)
    };
    let intent = intent.clone();
    let workspace_id = intent.workspace_id;

    with_t3_lifecycle_tx(pool, workspace_id, ladder, move |conn| {
        Box::pin(async move {
            let current = lifecycle_intent_is_current_in_tx(
                conn,
                intent.cloud_host_id,
                intent.operation_id,
                intent.version,
                intent.phase.as_db_label(),
            )
            .await?;
            if !current {
                return Ok(AppliedConvergence::StaleDiscarded);
            }
            match convergence {
                CloudLifecycleConvergence::Terminate => {
                    let settled = terminate_missing_instance_in_tx(
                        conn,
                        workspace_id,
                        intent.cloud_host_id,
                        intent.host_id,
                    )
                    .await?;
                    Ok(AppliedConvergence::Terminated { settled })
                }
                CloudLifecycleConvergence::Revert => {
                    match revert_lifecycle_operation_in_tx(
                        conn,
                        workspace_id,
                        intent.cloud_host_id,
                        intent.phase,
                    )
                    .await?
                    {
                        Some(state) => Ok(AppliedConvergence::Reverted(state)),
                        None => Ok(AppliedConvergence::Skipped),
                    }
                }
                CloudLifecycleConvergence::Confirm => {
                    let state = confirm_lifecycle_operation_in_tx(
                        conn,
                        workspace_id,
                        intent.cloud_host_id,
                        intent.host_id,
                        intent.phase,
                    )
                    .await?;
                    Ok(AppliedConvergence::Confirmed(state))
                }
                CloudLifecycleConvergence::Retry => Ok(AppliedConvergence::Skipped),
            }
        }) as BoxFuture<'_, Result<AppliedConvergence, T3Error>>
    })
    .await
}

/// Advance the ledger and the host to the state the operation promised
/// (Swift `confirm` :319-391).
///
/// The ledger boundary is [`pause_usage_in_tx`] / [`resume_usage_in_tx`] — one
/// statement, one boundary timestamp, no seam (058 bills exact microseconds). A
/// host with no open usage row simply has no boundary to move: the state change
/// still applies, exactly as Swift's empty `usage` CTE does.
pub async fn confirm_lifecycle_operation_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
    host_id: Uuid,
    phase: CloudLifecyclePhase,
) -> Result<CloudHostState, T3Error> {
    match phase {
        CloudLifecyclePhase::Pausing => {
            if let Some(session_id) = open_usage_session_in_tx(conn, workspace_id, host_id).await? {
                pause_usage_in_tx(conn, workspace_id, host_id, Some(session_id)).await?;
                mark_session_idle_in_tx(conn, workspace_id, session_id).await?;
            }
        }
        CloudLifecyclePhase::Resuming => {
            if let Some(session_id) = open_usage_session_in_tx(conn, workspace_id, host_id).await? {
                resume_usage_in_tx(conn, workspace_id, host_id, Some(session_id)).await?;
                mark_session_running_in_tx(conn, workspace_id, session_id).await?;
            }
        }
        CloudLifecyclePhase::DestroyPending => {}
    }
    let state =
        transition_cloud_host_in_tx(conn, workspace_id, cloud_host_id, phase.confirmed_state())
            .await?;
    clear_lifecycle_next_attempt_in_tx(conn, workspace_id, cloud_host_id).await?;
    if phase == CloudLifecyclePhase::DestroyPending {
        revoke_work_host_in_tx(conn, workspace_id, host_id).await?;
    }
    Ok(state)
}

/// Abandon the operation (Swift `case .revert` :287-307).
///
/// **Nothing in the ledger moves.** A pause that never happened left the active
/// interval open, so billing simply never stopped — the outcome ADR-0140 D4 asks
/// for, reached by doing nothing rather than by compensating.
///
/// `Ok(None)` for `destroy_pending`, which has no revert state by design.
pub async fn revert_lifecycle_operation_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
    phase: CloudLifecyclePhase,
) -> Result<Option<CloudHostState>, T3Error> {
    let Some(revert_state) = phase.revert_state() else {
        return Ok(None);
    };
    let state =
        transition_cloud_host_in_tx(conn, workspace_id, cloud_host_id, revert_state).await?;
    clear_lifecycle_next_attempt_in_tx(conn, workspace_id, cloud_host_id).await?;
    Ok(Some(state))
}

/// The instance is provably gone: settle through the single statement, then take
/// the host out of service (Swift `terminate` :395-504).
///
/// Returns `t3_terminate`'s own answer — `false` when there was no unsettled
/// ledger row to close, in which case the durable destroy intent is declared
/// explicitly so the host still leaves service.
pub async fn terminate_missing_instance_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
    host_id: Uuid,
) -> Result<bool, T3Error> {
    let settled = match open_usage_session_in_tx(conn, workspace_id, host_id).await? {
        Some(session_id) => {
            // The ONLY settlement call: interval close, single floor, debit,
            // destroy intent and host revocation all live inside t3_terminate.
            terminate_in_tx(
                conn,
                workspace_id,
                session_id,
                TerminationReason::ProviderMissing,
            )
            .await?
        }
        None => {
            declare_destroy_intent_in_tx(conn, workspace_id, cloud_host_id).await?;
            false
        }
    };
    transition_cloud_host_in_tx(conn, workspace_id, cloud_host_id, CloudHostState::Destroyed)
        .await?;
    clear_lifecycle_next_attempt_in_tx(conn, workspace_id, cloud_host_id).await?;
    retire_missing_work_host_in_tx(conn, workspace_id, host_id).await?;
    Ok(settled)
}

/// Declare the durable destroy intent for a host with no ledger row to settle
/// (Swift :437-452). `t3_terminate` writes the same intent for the settled path;
/// this is the branch that statement never reaches.
pub async fn declare_destroy_intent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
) -> Result<bool, T3Error> {
    let moved = sqlx::query(
        "UPDATE work_cloud_host \
            SET state = 'destroy_pending', \
                lifecycle_operation_kind = 'destroy', \
                lifecycle_operation_version = lifecycle_operation_version + 1, \
                updated_at = clock_timestamp() \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND state <> 'destroy_pending'",
    )
    .bind(workspace_id)
    .bind(cloud_host_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(moved == 1)
}

/// The session that owns this host's unsettled `work_host_usage` row, or `None`.
///
/// A **read**, not a settlement: it names the row `t3_terminate` will close. The
/// `FOR UPDATE` is Swift's (:401-411) and is the `usage → session` rung of the
/// ladder, taken here rather than a statement later so nothing can open a second
/// ledger row between the answer and the convergence that uses it.
pub async fn open_usage_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    let session_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT session_id FROM work_host_usage \
          WHERE workspace_id = $1 AND host_id = $2 AND settled_at IS NULL \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(session_id)
}

/// The operation is over, so the retry marker it scheduled is meaningless. A
/// no-op on `state`, therefore invisible to the transition guard.
pub async fn clear_lifecycle_next_attempt_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
) -> Result<(), T3Error> {
    sqlx::query(
        "UPDATE work_cloud_host \
            SET lifecycle_operation_next_attempt_at = NULL, \
                updated_at = clock_timestamp() \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(cloud_host_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A confirmed destroy takes the host out of service (Swift :380-390).
pub async fn revoke_work_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<(), T3Error> {
    sqlx::query(
        "UPDATE work_host \
            SET revoked_at = COALESCE(revoked_at, clock_timestamp()) \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(host_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A host whose instance is provably gone is revoked **and** backdated
/// (Swift :469-478).
///
/// The `- interval '100 years'` is not cosmetic: it is what makes the tier
/// fallback sweep see the host as unreachable on its very next pass, so the
/// session's user-visible orphan path runs from the same signal a real
/// disappearance would produce.
pub async fn retire_missing_work_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<(), T3Error> {
    sqlx::query(
        "UPDATE work_host \
            SET revoked_at = COALESCE(revoked_at, clock_timestamp()), \
                last_seen_at = clock_timestamp() - interval '100 years' \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(host_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A confirmed pause parks the session (Swift :357-365, `status = 'idle'`).
async fn mark_session_idle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<(), T3Error> {
    sqlx::query(
        "UPDATE work_session \
            SET status = 'idle', idle_at = clock_timestamp() \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A confirmed resume un-parks it (`status = 'running'`, `idle_at = NULL`).
async fn mark_session_running_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<(), T3Error> {
    sqlx::query(
        "UPDATE work_session \
            SET status = 'running', idle_at = NULL \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claimed(state: &str, sandbox: Option<&str>, operation: Option<Uuid>) -> ClaimedIntent {
        ClaimedIntent {
            cloud_host_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            host_id: Some(Uuid::from_u128(3)),
            provider: "mock-a".to_string(),
            provider_sandbox_id: sandbox.map(str::to_string),
            state: state.to_string(),
            operation_id: operation,
            operation_kind: Some("pause".to_string()),
            version: 7,
            attempts: 2,
            deadline_exceeded: false,
            requested_display_name: None,
        }
    }

    #[test]
    fn an_actionable_intent_needs_all_four_facts() {
        let operation = Uuid::from_u128(9);
        let intent = claimed("pausing", Some("mock-a-1"), Some(operation))
            .actionable()
            .expect("a complete pausing intent is actionable");
        assert_eq!(intent.phase, CloudLifecyclePhase::Pausing);
        assert_eq!(intent.instance.provider_id, "mock-a");
        assert_eq!(intent.instance.instance_id, "mock-a-1");
        assert_eq!(intent.idempotency_key(), operation.to_string());

        // A row with no sandbox handle has nothing to call the provider about.
        assert!(claimed("pausing", None, Some(operation))
            .actionable()
            .is_none());
        // A row with no durable operation has no idempotency key, so a retry
        // could double-act on the provider.
        assert!(claimed("pausing", Some("mock-a-1"), None)
            .actionable()
            .is_none());
        // A row in a settled state carries no in-flight operation at all.
        assert!(claimed("running", Some("mock-a-1"), Some(operation))
            .actionable()
            .is_none());
        let mut unbound = claimed("pausing", Some("mock-a-1"), Some(operation));
        unbound.host_id = None;
        assert!(unbound.actionable().is_none());
    }
}
