//! T3 active-time accrual — everything `t3_terminate` does **not** own.
//!
//! The division of labour is the whole point of ADR-0140 D3, so it is worth
//! stating precisely:
//!
//! | step | owner |
//! |---|---|
//! | admission (slots, balance > 0) | this module (pre-flight, before any durable intent) |
//! | open the usage row + first `active` interval | this module |
//! | active ⇄ paused interval boundaries | this module (one statement per boundary) |
//! | close the open interval, sum, floor, debit, destroy intent, revoke host | **`t3_terminate` only** (058:204-272) |
//!
//! Two properties are carried by the schema and are *not* re-stated here:
//!
//! * **A paused interval bills zero structurally.** `active_micros` is a
//!   `GENERATED ALWAYS ... STORED` column guarded by `state = 'active'`
//!   (058:59-70). No code in this module subtracts pause time, because there is
//!   nothing to subtract — that is why the property survived three adversarial
//!   review rounds while code-level rules did not.
//! * **One truncation, at settlement.** Intervals store exact microseconds;
//!   `t3_terminate` divides once. This module never rounds.
//!
//! Ports Swift `Cloud/CloudUsageLedger.swift` (`reserveProvisioningSlot` :23,
//! `start` :120, `pause`/`resume` :194-276, `transitionInterval` :343-383).

use chrono::{DateTime, Utc};
use momo_db::PgConnection;
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;

/// What the slot/credit admission check saw. Returned rather than discarded so
/// a route layer can render "3/5 in use" without asking again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmittedSlot {
    pub occupied: i32,
    pub max_active: i32,
    pub member_occupied: i32,
    pub per_member_soft_limit: i32,
    pub balance_micro_usd: i64,
}

/// The ledger rows opened for one paid session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartedUsage {
    pub usage_id: Uuid,
    pub interval_id: Uuid,
    pub unit_rate_micro_usd_second: i64,
}

/// A `work_host_usage` row as the ledger sees it. `settled_*` are `None` until
/// `t3_terminate` runs; `active_micros` is `None` for rows settled before
/// migration 058 (those invoices are never recomputed — 058:38-43).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageSnapshot {
    pub usage_id: Uuid,
    pub session_id: Uuid,
    pub host_id: Uuid,
    pub unit_rate_micro_usd_second: i64,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub active_seconds: Option<i64>,
    pub active_micros: Option<i64>,
    pub settled_at: Option<DateTime<Utc>>,
    pub settled_reason: Option<String>,
}

/// Admission for a new paid host: lock the workspace axis, refuse a workspace
/// with no credit, and refuse one that is at a slot ceiling.
///
/// Deliberately *outside* `t3_terminate`'s remit — that statement debits, it
/// does not decide whether a session may start. Call it inside a lifecycle
/// transaction opened with [`crate::lifecycle::T3LockLadder::with_work_pool`]
/// and [`with_workspace_credit`](crate::lifecycle::T3LockLadder::with_workspace_credit)
/// so the two `FOR UPDATE`s below are re-entrant on rows the ladder already
/// holds, in the ladder's order.
pub async fn reserve_provisioning_slot_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<AdmittedSlot, T3Error> {
    sqlx::query(
        "INSERT INTO work_pool (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING",
    )
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;

    let pool_row = sqlx::query(
        "SELECT max_active, per_member_soft_limit \
           FROM work_pool WHERE workspace_id = $1 FOR UPDATE",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(T3Error::WorkPoolMissing)?;
    let max_active: i32 = pool_row.try_get("max_active")?;
    let per_member_soft_limit: i32 = pool_row.try_get("per_member_soft_limit")?;

    let balance_micro_usd: i64 = sqlx::query_scalar(
        "SELECT balance_micro_usd FROM workspace_credit WHERE workspace_id = $1 FOR UPDATE",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(T3Error::CreditLedgerMissing)?;
    if balance_micro_usd <= 0 {
        return Err(T3Error::InsufficientCredit);
    }

    // Occupancy counts take no row lock (Swift parity): they are an admission
    // heuristic, and the hard "one unsettled usage per host" rule is a partial
    // unique index that no count can talk its way past.
    let usage_row = sqlx::query(
        "SELECT \
           ( SELECT count(*)::int \
               FROM work_session ws \
               JOIN work_host h ON h.id = ws.host_id \
              WHERE ws.workspace_id = $1 \
                AND ws.status IN ('running', 'idle') \
                AND h.type <> 'cloud' ) \
         + ( SELECT count(*)::int \
               FROM work_cloud_host ch \
              WHERE ch.workspace_id = $1 \
                AND ch.state IN ('provisioning', 'ready', 'running', 'paused') ) AS occupied, \
           ( SELECT count(*)::int \
               FROM work_cloud_host ch \
              WHERE ch.workspace_id = $1 \
                AND ch.requester_member_id = $2 \
                AND ch.state IN ('provisioning', 'ready', 'running', 'paused') ) \
             AS member_occupied",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    let occupied: i32 = usage_row.try_get("occupied")?;
    let member_occupied: i32 = usage_row.try_get("member_occupied")?;

    if occupied >= max_active {
        return Err(T3Error::SlotsExhausted {
            occupied,
            max_active,
        });
    }
    if member_occupied >= per_member_soft_limit {
        return Err(T3Error::MemberSlotLimit {
            occupied: member_occupied,
            limit: per_member_soft_limit,
        });
    }

    Ok(AdmittedSlot {
        occupied,
        max_active,
        member_occupied,
        per_member_soft_limit,
        balance_micro_usd,
    })
}

/// Open the active-time ledger for a session that is starting on a cloud host.
///
/// `Ok(None)` means the host is not a cloud host — the T1/T2 path, which has no
/// ledger and shares this call site unchanged.
///
/// The `work_cloud_host` write at the end is an ordinary `state = 'running'`
/// update: from `ready` the transition guard admits it, from `running` it is a
/// same-state metadata update the guard skips (053:53), and from anywhere else
/// the guard refuses — which is why the pre-check below is an early, friendlier
/// error and not the enforcement.
pub async fn start_usage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    host_id: Uuid,
) -> Result<Option<StartedUsage>, T3Error> {
    let cloud_row = sqlx::query(
        "SELECT id, unit_rate_micro_usd_second, state \
           FROM work_cloud_host \
          WHERE workspace_id = $1 AND host_id = $2 \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(cloud_row) = cloud_row else {
        return Ok(None);
    };
    let unit_rate_micro_usd_second: i64 = cloud_row.try_get("unit_rate_micro_usd_second")?;
    let state: String = cloud_row.try_get("state")?;
    if state != "ready" && state != "running" {
        return Err(T3Error::CloudHostNotRunnable(state));
    }

    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT session_id FROM work_host_usage \
          WHERE workspace_id = $1 AND host_id = $2 AND settled_at IS NULL \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    if existing.is_some() {
        return Err(T3Error::HostAlreadyBilling);
    }

    let usage_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_host_usage \
           (session_id, host_id, workspace_id, unit_rate_micro_usd_second) \
         VALUES ($1, $2, $3, $4) \
         RETURNING id",
    )
    .bind(session_id)
    .bind(host_id)
    .bind(workspace_id)
    .bind(unit_rate_micro_usd_second)
    .fetch_one(&mut *conn)
    .await?;

    let interval_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_host_usage_interval (usage_id, workspace_id, state) \
         VALUES ($1, $2, 'active') \
         RETURNING id",
    )
    .bind(usage_id)
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query(
        "UPDATE work_cloud_host \
            SET state = 'running', updated_at = clock_timestamp() \
          WHERE workspace_id = $1 AND host_id = $2",
    )
    .bind(workspace_id)
    .bind(host_id)
    .execute(&mut *conn)
    .await?;

    Ok(Some(StartedUsage {
        usage_id,
        interval_id,
        unit_rate_micro_usd_second,
    }))
}

/// Close the open `active` interval and open a `paused` one. Returns the
/// session that owns the ledger.
pub async fn pause_usage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    session_id: Option<Uuid>,
) -> Result<Uuid, T3Error> {
    let usage = lock_open_usage(conn, workspace_id, host_id, session_id).await?;
    transition_interval(conn, workspace_id, usage.usage_id, "active", "paused").await?;
    Ok(usage.session_id)
}

/// Close the open `paused` interval and open an `active` one.
pub async fn resume_usage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    session_id: Option<Uuid>,
) -> Result<Uuid, T3Error> {
    let usage = lock_open_usage(conn, workspace_id, host_id, session_id).await?;
    transition_interval(conn, workspace_id, usage.usage_id, "paused", "active").await?;
    Ok(usage.session_id)
}

/// Current credit balance for the workspace, no lock. For display; admission
/// uses [`reserve_provisioning_slot_in_tx`], which locks.
pub async fn workspace_credit_balance_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<i64>, T3Error> {
    let balance: Option<i64> = sqlx::query_scalar(
        "SELECT balance_micro_usd FROM workspace_credit WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(balance)
}

/// Read the ledger row for one session.
pub async fn usage_snapshot_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<UsageSnapshot>, T3Error> {
    let row = sqlx::query(
        "SELECT id, session_id, host_id, unit_rate_micro_usd_second, started_at, ended_at, \
                active_seconds, active_micros, settled_at, settled_reason \
           FROM work_host_usage \
          WHERE workspace_id = $1 AND session_id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(UsageSnapshot {
        usage_id: row.try_get("id")?,
        session_id: row.try_get("session_id")?,
        host_id: row.try_get("host_id")?,
        unit_rate_micro_usd_second: row.try_get("unit_rate_micro_usd_second")?,
        started_at: row.try_get("started_at")?,
        ended_at: row.try_get("ended_at")?,
        active_seconds: row.try_get("active_seconds")?,
        active_micros: row.try_get("active_micros")?,
        settled_at: row.try_get("settled_at")?,
        settled_reason: row.try_get("settled_reason")?,
    }))
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

struct OpenUsage {
    usage_id: Uuid,
    session_id: Uuid,
}

async fn lock_open_usage(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    session_id: Option<Uuid>,
) -> Result<OpenUsage, T3Error> {
    let row = sqlx::query(
        "SELECT id, session_id FROM work_host_usage \
          WHERE workspace_id = $1 \
            AND host_id = $2 \
            AND ($3::uuid IS NULL OR session_id = $3::uuid) \
            AND settled_at IS NULL \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(host_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(T3Error::NoOpenUsage)?;
    Ok(OpenUsage {
        usage_id: row.try_get("id")?,
        session_id: row.try_get("session_id")?,
    })
}

/// One statement, one boundary timestamp (Swift `CloudUsageLedger.swift:343-383`).
///
/// Closing the old interval and opening the new one in two statements left an
/// unbilled seam between them — invisible while every interval was floored to a
/// whole second, real once migration 058 bills exact microseconds. The new
/// interval starts at the instant the previous one ended, so a pause round trip
/// loses nothing and overlaps nothing. An empty `closed` CTE means another
/// writer moved first: nothing is inserted and the caller gets a conflict.
async fn transition_interval(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    usage_id: Uuid,
    expected: &str,
    next: &str,
) -> Result<Uuid, T3Error> {
    let interval_id: Option<Uuid> = sqlx::query_scalar(
        "WITH closed AS ( \
            UPDATE work_host_usage_interval \
               SET ended_at = clock_timestamp() \
             WHERE usage_id = $1 \
               AND state = $3::text \
               AND ended_at IS NULL \
            RETURNING ended_at \
         ) \
         INSERT INTO work_host_usage_interval \
           (usage_id, workspace_id, state, started_at) \
         SELECT $1::uuid, $2::uuid, $4::text, closed.ended_at \
           FROM closed \
         RETURNING id",
    )
    .bind(usage_id)
    .bind(workspace_id)
    .bind(expected)
    .bind(next)
    .fetch_optional(&mut *conn)
    .await?;
    interval_id.ok_or(T3Error::IntervalStateConflict)
}
