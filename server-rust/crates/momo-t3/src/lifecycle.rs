//! T3 session lifecycle — the **wiring** for enforcement that already exists in
//! PostgreSQL (ADR-0140 D1/D2/D3).
//!
//! Three rules shape every function here, and none of them is re-implemented in
//! Rust:
//!
//! 1. **Serialization.** Every T3 lifecycle transaction opens with
//!    `acquire_t3_lifecycle_lock(cloud_host_id)` (052) before any row lock, then
//!    descends the canonical ladder `workspace_credit → work_cloud_host →
//!    work_host_usage(+interval) → work_session → work_host`.
//!    [`with_t3_lifecycle_tx`] is the only way to obtain a connection for that
//!    work, so "a path that forgot the advisory" is not expressible.
//!    Ports Swift `Cloud/T3LifecycleLock.swift:9-73` + `DB/Database.swift:126-153`.
//! 2. **Legality of a state change.** [`transition_cloud_host_in_tx`] issues a
//!    plain `UPDATE`. `work_cloud_host_transition_guard` (053:68) consults the
//!    `work_cloud_host_transition` table and raises on anything absent from it;
//!    this crate only translates that raise into
//!    [`T3Error::IllegalTransition`]. No allow-list exists in Rust — a second
//!    copy of the transition table is the failure mode ADR-0140 D1-B rejects.
//! 3. **Settlement.** [`terminate_in_tx`] calls `t3_terminate` (058:116) and
//!    does nothing else. There is no settlement SQL in this crate: interval
//!    closing, the single floor, the debit append, the destroy intent and the
//!    host revocation are all inside that one statement, and
//!    `work_host_usage_settlement_guard` (053:86) makes any application-side
//!    shortcut fail rather than be found in review.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use futures::future::BoxFuture;
use momo_db::{PgConnection, PgPool};
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;

// ---------------------------------------------------------------------------
// value types
// ---------------------------------------------------------------------------

/// ADR-0140 D3's canonical settlement reasons — the `work_host_usage_
/// settled_reason_ck` vocabulary (053:12-17) and `t3_terminate`'s guard
/// (058:133-140). Modelled as an enum so an app cannot invent a sixth reason
/// and discover it at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationReason {
    /// The user (or the owning host) ended the session.
    Ended,
    /// ADR-0139 idle timeout swept the session.
    IdleTimeout,
    /// The host stopped answering. ADR-0140 §T3 상시화 2: on the "laptop closed,
    /// continue on phone" path this is the *most common* billing end, not an
    /// exceptional one.
    Orphaned,
    /// The provider reported the instance is gone (ADR-0140 D4 convergence).
    ProviderMissing,
    /// The instance was destroyed.
    Destroyed,
}

impl TerminationReason {
    pub fn as_db_label(self) -> &'static str {
        match self {
            TerminationReason::Ended => "ended",
            TerminationReason::IdleTimeout => "idle_timeout",
            TerminationReason::Orphaned => "orphaned",
            TerminationReason::ProviderMissing => "provider_missing",
            TerminationReason::Destroyed => "destroyed",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        Some(match label {
            "ended" => TerminationReason::Ended,
            "idle_timeout" => TerminationReason::IdleTimeout,
            "orphaned" => TerminationReason::Orphaned,
            "provider_missing" => TerminationReason::ProviderMissing,
            "destroyed" => TerminationReason::Destroyed,
            _ => return None,
        })
    }
}

/// The nine `work_cloud_host.state` values (049:18-23). This enum is a spelling
/// aid for callers and a parser for what the DB returns — **it deliberately
/// carries no notion of which transitions are allowed**. That question is
/// answered by `work_cloud_host_transition` and by nothing else (ADR-0140 D1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudHostState {
    Provisioning,
    Ready,
    Running,
    Pausing,
    Paused,
    Resuming,
    DestroyPending,
    Destroyed,
    Failed,
}

impl CloudHostState {
    pub fn as_db_label(self) -> &'static str {
        match self {
            CloudHostState::Provisioning => "provisioning",
            CloudHostState::Ready => "ready",
            CloudHostState::Running => "running",
            CloudHostState::Pausing => "pausing",
            CloudHostState::Paused => "paused",
            CloudHostState::Resuming => "resuming",
            CloudHostState::DestroyPending => "destroy_pending",
            CloudHostState::Destroyed => "destroyed",
            CloudHostState::Failed => "failed",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        Some(match label {
            "provisioning" => CloudHostState::Provisioning,
            "ready" => CloudHostState::Ready,
            "running" => CloudHostState::Running,
            "pausing" => CloudHostState::Pausing,
            "paused" => CloudHostState::Paused,
            "resuming" => CloudHostState::Resuming,
            "destroy_pending" => CloudHostState::DestroyPending,
            "destroyed" => CloudHostState::Destroyed,
            "failed" => CloudHostState::Failed,
            _ => return None,
        })
    }
}

/// Which rungs of the ADR-0140 D2 ladder a lifecycle transaction needs.
///
/// Stage 0 (the host advisories) is not optional and is always taken first.
/// Stages 1-2 are declared per call because taking a lock you do not need is
/// how the workspace axis (ADR-0140 D2 §"워크스페이스 축") grows contention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct T3LockLadder {
    cloud_host_ids: Vec<Uuid>,
    lock_work_pool: bool,
    lock_workspace_credit: bool,
}

impl T3LockLadder {
    /// One cloud host, no workspace-axis rows.
    pub fn host(cloud_host_id: Uuid) -> Self {
        T3LockLadder {
            cloud_host_ids: vec![cloud_host_id],
            lock_work_pool: false,
            lock_workspace_credit: false,
        }
    }

    /// Several cloud hosts. They are locked in ascending UUID order regardless
    /// of the order given (ADR-0140 D2 잔여 규칙).
    pub fn hosts(cloud_host_ids: impl IntoIterator<Item = Uuid>) -> Self {
        T3LockLadder {
            cloud_host_ids: cloud_host_ids.into_iter().collect(),
            lock_work_pool: false,
            lock_workspace_credit: false,
        }
    }

    /// Also lock `work_pool` (slot admission).
    pub fn with_work_pool(mut self) -> Self {
        self.lock_work_pool = true;
        self
    }

    /// Also lock `workspace_credit`. Required whenever the transaction may
    /// reach `t3_terminate`, which appends a `credit_entry` and therefore ends
    /// up on the same workspace row from the opposite direction (045:122-136).
    pub fn with_workspace_credit(mut self) -> Self {
        self.lock_workspace_credit = true;
        self
    }

    /// Deduplicated, ascending by canonical lowercase UUID text — byte-for-byte
    /// the Swift ordering (`DB/Database.swift:133-135`).
    pub fn ordered_cloud_host_ids(&self) -> Vec<Uuid> {
        let unique: BTreeSet<Uuid> = self.cloud_host_ids.iter().copied().collect();
        let mut ordered: Vec<Uuid> = unique.into_iter().collect();
        ordered.sort_by_key(|id| id.to_string());
        ordered
    }
}

/// One `work_session` row, in the shape the T1/T2/T3 common path needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkSession {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub member_id: Uuid,
    pub host_id: Uuid,
    pub root_message_id: Uuid,
    pub workstream_id: Uuid,
    pub tool: String,
    pub label: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
}

/// The minimum a caller must state to open a session. `workstream_id` is
/// deliberately absent: `work_session_attach_workstream_trg` (055:161) attaches
/// the thread's workstream on insert, and a second app-side copy of that rule
/// would drift from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorkSession {
    pub channel_id: Uuid,
    pub member_id: Uuid,
    pub host_id: Uuid,
    pub root_message_id: Uuid,
    pub tool: String,
    pub label: String,
}

// ---------------------------------------------------------------------------
// the transaction guard
// ---------------------------------------------------------------------------

/// Stage 0 of the ADR-0140 D2 ladder: the host advisories, before anything else
/// in the transaction and in ascending host order.
async fn acquire_host_advisories(
    conn: &mut PgConnection,
    ordered_cloud_host_ids: &[Uuid],
) -> Result<(), T3Error> {
    for cloud_host_id in ordered_cloud_host_ids {
        sqlx::query("SELECT acquire_t3_lifecycle_lock($1)")
            .bind(cloud_host_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Stages 1-2: the workspace axis, then the cloud host rows. Runs after the RLS
/// GUC because every table here is `FORCE ROW LEVEL SECURITY`.
async fn acquire_row_ladder(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    ordered_cloud_host_ids: &[Uuid],
    lock_work_pool: bool,
    lock_workspace_credit: bool,
) -> Result<(), T3Error> {
    if lock_work_pool {
        // Upsert-on-lock: a workspace provisioned outside the 022 backfill has
        // no pool row, and `FOR UPDATE` on nothing locks nothing.
        sqlx::query("INSERT INTO work_pool (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING")
            .bind(workspace_id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("SELECT workspace_id FROM work_pool WHERE workspace_id = $1 FOR UPDATE")
            .bind(workspace_id)
            .fetch_optional(&mut *conn)
            .await?;
    }
    if lock_workspace_credit {
        sqlx::query("SELECT workspace_id FROM workspace_credit WHERE workspace_id = $1 FOR UPDATE")
            .bind(workspace_id)
            .fetch_optional(&mut *conn)
            .await?;
    }
    for cloud_host_id in ordered_cloud_host_ids {
        sqlx::query(
            "SELECT id FROM work_cloud_host \
              WHERE workspace_id = $1 AND id = $2 \
              FOR UPDATE",
        )
        .bind(workspace_id)
        .bind(cloud_host_id)
        .fetch_optional(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Run `body` inside a T3 lifecycle transaction.
///
/// The prelude is not advice, it is the only way in: `body` receives a
/// connection that has already taken the host advisory (statement #1), the
/// tenant GUC, and the requested workspace/cloud-host row locks — in the
/// canonical coarse-to-fine order. A caller cannot reach a T3 row without it
/// because no other function in this crate opens a transaction.
///
/// Delegates to [`momo_db::with_tenant_tx_prelude`] so that
/// `set_config('app.workspace_id', …)` still happens in exactly one place in
/// the whole workspace (invariant #6).
pub async fn with_t3_lifecycle_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    ladder: T3LockLadder,
    body: F,
) -> Result<T, T3Error>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, T3Error>> + Send,
{
    let ordered = ladder.ordered_cloud_host_ids();
    if ordered.is_empty() {
        return Err(T3Error::EmptyLockLadder);
    }
    let advisory_ids = ordered.clone();
    let lock_work_pool = ladder.lock_work_pool;
    let lock_workspace_credit = ladder.lock_workspace_credit;

    momo_db::with_tenant_tx_prelude(
        pool,
        workspace_id,
        move |conn: &mut PgConnection| -> BoxFuture<'_, Result<(), T3Error>> {
            Box::pin(async move { acquire_host_advisories(conn, &advisory_ids).await })
        },
        move |conn: &mut PgConnection| -> BoxFuture<'_, Result<(), T3Error>> {
            Box::pin(async move {
                acquire_row_ladder(
                    conn,
                    workspace_id,
                    &ordered,
                    lock_work_pool,
                    lock_workspace_credit,
                )
                .await
            })
        },
        body,
    )
    .await
}

// ---------------------------------------------------------------------------
// session + cloud host
// ---------------------------------------------------------------------------

const WORK_SESSION_COLUMNS: &str = "id, workspace_id, channel_id, member_id, host_id, \
     root_message_id, workstream_id, tool, label, status, started_at";

fn decode_work_session(row: &sqlx::postgres::PgRow) -> Result<WorkSession, T3Error> {
    Ok(WorkSession {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("channel_id")?,
        member_id: row.try_get("member_id")?,
        host_id: row.try_get("host_id")?,
        root_message_id: row.try_get("root_message_id")?,
        workstream_id: row.try_get("workstream_id")?,
        tool: row.try_get("tool")?,
        label: row.try_get("label")?,
        status: row.try_get("status")?,
        started_at: row.try_get("started_at")?,
    })
}

/// Open a work session. Tier-agnostic on purpose: T1, T2 and T3 sessions are the
/// same row, and T3 adds a billing axis on top (ADR-0140 D1 §"세션·interval
/// 상태는 cloud host에 종속시키지 않는다").
///
/// Not a settlement path and not a cloud-host path: binding the paid host and
/// opening the usage ledger are separate, explicit calls
/// ([`bind_cloud_host_in_tx`], [`crate::billing::start_usage_in_tx`]).
pub async fn create_work_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: NewWorkSession,
) -> Result<WorkSession, T3Error> {
    let sql = format!(
        "INSERT INTO work_session \
           (workspace_id, channel_id, member_id, host_id, root_message_id, tool, label) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         RETURNING {WORK_SESSION_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(new.channel_id)
        .bind(new.member_id)
        .bind(new.host_id)
        .bind(new.root_message_id)
        .bind(&new.tool)
        .bind(&new.label)
        .fetch_one(&mut *conn)
        .await?;
    decode_work_session(&row)
}

/// Read one session inside the current transaction.
pub async fn load_work_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<WorkSession>, T3Error> {
    let sql = format!(
        "SELECT {WORK_SESSION_COLUMNS} FROM work_session \
          WHERE workspace_id = $1 AND id = $2"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode_work_session).transpose()
}

/// Bind a registered `work_host` to its provisioning `work_cloud_host` row and
/// consume the one-shot bootstrap token.
///
/// Ports Swift `Routes/CloudProvisionerRoutes.swift:488-498`. The
/// `provisioning → ready` step is expressed as an ordinary column write and the
/// transition guard validates it; when the provider has not yet answered with a
/// sandbox id the row stays `provisioning`, which the guard treats as a
/// same-state update and lets through.
pub async fn bind_cloud_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
    host_id: Uuid,
) -> Result<CloudHostState, T3Error> {
    let state: Option<String> = sqlx::query_scalar(
        "UPDATE work_cloud_host \
            SET host_id = $3, \
                bootstrap_consumed_at = clock_timestamp(), \
                state = CASE WHEN provider_sandbox_id IS NOT NULL \
                             THEN 'ready' ELSE 'provisioning' END, \
                updated_at = clock_timestamp() \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND host_id IS NULL \
            AND bootstrap_consumed_at IS NULL \
          RETURNING state",
    )
    .bind(workspace_id)
    .bind(cloud_host_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;

    let state = state.ok_or(T3Error::CloudHostNotFound)?;
    CloudHostState::from_db_label(&state)
        .ok_or_else(|| T3Error::CloudHostNotRunnable(state.clone()))
}

/// Declare a cloud host state change.
///
/// This is a plain `UPDATE` on purpose (ADR-0140 D1-A): the caller states where
/// the host is going and `work_cloud_host_transition_guard` decides whether that
/// is legal. Removing the trigger — or adding a row to
/// `work_cloud_host_transition` — changes the answer without a line changing
/// here, which is the property the whole redesign is built on.
pub async fn transition_cloud_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
    to_state: CloudHostState,
) -> Result<CloudHostState, T3Error> {
    let state: Option<String> = sqlx::query_scalar(
        "UPDATE work_cloud_host \
            SET state = $3, updated_at = clock_timestamp() \
          WHERE workspace_id = $1 AND id = $2 \
          RETURNING state",
    )
    .bind(workspace_id)
    .bind(cloud_host_id)
    .bind(to_state.as_db_label())
    .fetch_optional(&mut *conn)
    .await?;

    let state = state.ok_or(T3Error::CloudHostNotFound)?;
    CloudHostState::from_db_label(&state)
        .ok_or_else(|| T3Error::CloudHostNotRunnable(state.clone()))
}

/// Read the current state of a cloud host inside the transaction.
pub async fn cloud_host_state_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
) -> Result<Option<CloudHostState>, T3Error> {
    let state: Option<String> =
        sqlx::query_scalar("SELECT state FROM work_cloud_host WHERE workspace_id = $1 AND id = $2")
            .bind(workspace_id)
            .bind(cloud_host_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(state.as_deref().and_then(CloudHostState::from_db_label))
}

/// Resolve the `work_cloud_host` that owns a session's host, if it is a T3
/// session at all.
///
/// Taken with no row lock, exactly like Swift's `t3CloudHostID`
/// (`Routes/WorkSessionRoutes.swift:425-428`): the id is only needed to *choose*
/// the advisory to acquire, and the lifecycle transaction re-locks the row
/// through the ladder afterwards.
pub async fn resolve_cloud_host_id(
    pool: &PgPool,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    momo_db::with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            sqlx::query_scalar(
                "SELECT ch.id \
                   FROM work_session ws \
                   JOIN work_cloud_host ch \
                     ON ch.workspace_id = ws.workspace_id \
                    AND ch.host_id = ws.host_id \
                  WHERE ws.workspace_id = $1 AND ws.id = $2",
            )
            .bind(workspace_id)
            .bind(session_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(momo_db::DbError::from)
        })
    })
    .await
    .map_err(T3Error::from)
}

// ---------------------------------------------------------------------------
// termination — the one settlement entrypoint
// ---------------------------------------------------------------------------

/// End a T3 session's billing by calling `t3_terminate` (058:116).
///
/// **This function contains no settlement logic and must never gain any.** The
/// single statement closes the open interval, sums exact microseconds, floors
/// once, appends the debit idempotently, writes the durable destroy intent and
/// revokes the host — all under the lock ladder it re-acquires itself. Anything
/// this crate added on top would be a second settlement path, which is the
/// defect ADR-0140 D3 exists to remove.
///
/// Returns `false` when the session has no `work_host_usage` row (a T1/T2
/// session, or a T3 session whose ledger was never opened). Calling it twice is
/// safe by construction: the second call finds `settled_at` set and returns
/// `true` without touching the credit ledger.
pub async fn terminate_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    reason: TerminationReason,
) -> Result<bool, T3Error> {
    let settled: Option<bool> = sqlx::query_scalar("SELECT t3_terminate($1, $2, $3)")
        .bind(workspace_id)
        .bind(session_id)
        .bind(reason.as_db_label())
        .fetch_one(&mut *conn)
        .await?;
    Ok(settled.unwrap_or(false))
}

/// Pool-level termination: resolve the owning cloud host, then run
/// [`terminate_in_tx`] inside a lifecycle transaction that holds the host
/// advisory and the workspace credit row.
///
/// `Ok(false)` means the session is not a T3 session — the caller's own
/// (tier-agnostic) session-ending write is then all that is required.
pub async fn terminate(
    pool: &PgPool,
    workspace_id: Uuid,
    session_id: Uuid,
    reason: TerminationReason,
) -> Result<bool, T3Error> {
    let Some(cloud_host_id) = resolve_cloud_host_id(pool, workspace_id, session_id).await? else {
        return Ok(false);
    };
    with_t3_lifecycle_tx(
        pool,
        workspace_id,
        T3LockLadder::host(cloud_host_id).with_workspace_credit(),
        move |conn| {
            Box::pin(async move { terminate_in_tx(conn, workspace_id, session_id, reason).await })
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn termination_reasons_match_the_db_vocabulary() {
        // The exact five values of work_host_usage_settled_reason_ck (053:14-16).
        let labels: Vec<&str> = [
            TerminationReason::Ended,
            TerminationReason::IdleTimeout,
            TerminationReason::Orphaned,
            TerminationReason::ProviderMissing,
            TerminationReason::Destroyed,
        ]
        .into_iter()
        .map(TerminationReason::as_db_label)
        .collect();
        assert_eq!(
            labels,
            vec![
                "ended",
                "idle_timeout",
                "orphaned",
                "provider_missing",
                "destroyed"
            ]
        );
        for label in labels {
            assert_eq!(
                TerminationReason::from_db_label(label).map(|r| r.as_db_label()),
                Some(label)
            );
        }
        assert!(TerminationReason::from_db_label("settled").is_none());
    }

    #[test]
    fn cloud_host_states_match_the_db_vocabulary() {
        // The nine values of work_cloud_host_state_ck (049:18-23).
        let labels = [
            "provisioning",
            "ready",
            "running",
            "pausing",
            "paused",
            "resuming",
            "destroy_pending",
            "destroyed",
            "failed",
        ];
        for label in labels {
            let state = CloudHostState::from_db_label(label)
                .unwrap_or_else(|| panic!("{label} must be a known cloud host state"));
            assert_eq!(state.as_db_label(), label);
        }
        assert!(CloudHostState::from_db_label("settled").is_none());
    }

    #[test]
    fn ladder_orders_hosts_ascending_and_deduplicates() {
        let high = Uuid::parse_str("ffffffff-0000-7000-8000-000000000000").unwrap();
        let low = Uuid::parse_str("00000000-0000-7000-8000-000000000000").unwrap();
        let ladder = T3LockLadder::hosts([high, low, high]);
        assert_eq!(
            ladder.ordered_cloud_host_ids(),
            vec![low, high],
            "multi-host advisories must be taken in ascending UUID order, once each"
        );
    }

    #[test]
    fn ladder_rungs_are_opt_in() {
        let plain = T3LockLadder::host(Uuid::nil());
        assert!(!plain.lock_work_pool);
        assert!(!plain.lock_workspace_credit);
        let full = T3LockLadder::host(Uuid::nil())
            .with_work_pool()
            .with_workspace_credit();
        assert!(full.lock_work_pool);
        assert!(full.lock_workspace_credit);
    }
}
