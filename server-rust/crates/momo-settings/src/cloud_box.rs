//! Personal cloud box — the server's side of the lifecycle (migration 118,
//! ADR-0197 M1, 성재 결재 2026-10-03).
//!
//! ## What the server holds (D10 「서버에 남는 것」)
//!
//! A box **row** (state, limits, timestamps), a closed **control queue** the
//! runner polls outbound, and **audit** rows. No credentials, no host key, no
//! pairing code, no terminal content: those columns do not exist.
//!
//! ## The lifecycle table (D3, D10) — one function, [`next_state`]
//!
//! ```text
//! (none)        --create (owner)-------------> creating
//! creating      --RunnerReady----------------> running
//! creating      --RunnerCreateFailed---------> deleted     (reason create_failed)
//! running       --RunnerIdle-----------------> idle
//! idle          --RunnerActive---------------> running
//! running|idle  --Owner/AdminStop--------------> stopped
//! idle          --SystemIdleStop-------------> stopped     (30 min unattended, M6 sweeper)
//! stopped       --OwnerStart-----------------> running
//! creating|running|idle|stopped
//!               --Owner/AdminDelete, SystemMemberRemoved--> deleting
//! stopped       --SystemExpire (30 d)--------> deleting
//! deleting      --RunnerDeleted--------------> deleted     (tombstone stays)
//! deleting      --RunnerDeleteFailed---------> delete_failed
//! delete_failed --Owner/Admin/System retry-----> deleting
//! deleted       -- terminal
//! ```
//!
//! The same pairs are enforced again by `cloud_box_transition_guard` in the
//! database; the PG suite checks all 49 `(from, to)` pairs against this table.
//!
//! ## Who may do what (D6)
//!
//! * **Owner only**: create, start, keep-awake. Content-adjacent controls.
//! * **Owner or workspace admin**: stop, delete (resource management, D3 last bullet).
//! * **Admin may also**: list. An admin never creates, starts or attaches, and
//!   this module has no event named `AdminStart`.
//! * **Runner / system**: the rest. A route cannot construct a runner event.
//!
//! The statements here take a caller-supplied tenant transaction. Authorization
//! (is this caller the owner or an admin) is the route's decision, made before the
//! event is built; the table above is the structural rule that cannot be bypassed.

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Audit schema every `cloud_box.*` row carries.
pub const CLOUD_BOX_AUDIT_SCHEMA: &str = "momo.cloud_box.audit.v1";

/// 워크스페이스 동시 켜짐 상한(D3 결재 기록).
pub const MAX_CONCURRENT_BOXES: i64 = 5;
/// 박스 한도 기본값 = 상한(D3: 1 vCPU, 2GB, 10GB, PID 512).
pub const DEFAULT_CPU_MILLIS: i32 = 1000;
pub const DEFAULT_MEMORY_MB: i32 = 2048;
pub const DEFAULT_DISK_GB: i32 = 10;
pub const DEFAULT_PIDS: i32 = 512;
/// 유휴 30분, 정지 30일 뒤 삭제, 「계속 켜 둠」 최대 12시간(D3). Column defaults mirror these.
pub const DEFAULT_IDLE_MINUTES: i32 = 30;
pub const DEFAULT_STOPPED_DELETE_DAYS: i32 = 30;
pub const DEFAULT_KEEP_AWAKE_MAX_HOURS: i32 = 12;

// ---------------------------------------------------------------------------
// states, events, the table
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BoxState {
    Creating,
    Running,
    Idle,
    Stopped,
    Deleting,
    DeleteFailed,
    Deleted,
}

impl BoxState {
    pub const ALL: [BoxState; 7] = [
        BoxState::Creating,
        BoxState::Running,
        BoxState::Idle,
        BoxState::Stopped,
        BoxState::Deleting,
        BoxState::DeleteFailed,
        BoxState::Deleted,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BoxState::Creating => "creating",
            BoxState::Running => "running",
            BoxState::Idle => "idle",
            BoxState::Stopped => "stopped",
            BoxState::Deleting => "deleting",
            BoxState::DeleteFailed => "delete_failed",
            BoxState::Deleted => "deleted",
        }
    }

    pub fn parse(label: &str) -> Option<BoxState> {
        BoxState::ALL
            .into_iter()
            .find(|state| state.as_str() == label)
    }

    /// States that hold a slot of the workspace's concurrent-on cap (D3).
    pub fn counts_toward_cap(self) -> bool {
        matches!(
            self,
            BoxState::Creating | BoxState::Running | BoxState::Idle
        )
    }
}

/// Every way a box's state can move, with the actor built into the name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BoxEvent {
    RunnerReady,
    RunnerCreateFailed,
    RunnerIdle,
    RunnerActive,
    OwnerStart,
    OwnerStop,
    AdminStop,
    SystemIdleStop,
    OwnerDelete,
    AdminDelete,
    SystemExpire,
    SystemMemberRemoved,
    OwnerRetryDelete,
    AdminRetryDelete,
    SystemRetryDelete,
    RunnerDeleted,
    RunnerDeleteFailed,
}

/// The lifecycle verbs the runner may be asked to execute (D2). A closed list:
/// there is no `exec`, `cp`, `commit`, `export` or `snapshot`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlVerb {
    Create,
    Start,
    Stop,
    Delete,
    Status,
}

impl ControlVerb {
    pub const ALL: [ControlVerb; 5] = [
        ControlVerb::Create,
        ControlVerb::Start,
        ControlVerb::Stop,
        ControlVerb::Delete,
        ControlVerb::Status,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ControlVerb::Create => "create",
            ControlVerb::Start => "start",
            ControlVerb::Stop => "stop",
            ControlVerb::Delete => "delete",
            ControlVerb::Status => "status",
        }
    }
}

impl BoxEvent {
    pub const ALL: [BoxEvent; 17] = [
        BoxEvent::RunnerReady,
        BoxEvent::RunnerCreateFailed,
        BoxEvent::RunnerIdle,
        BoxEvent::RunnerActive,
        BoxEvent::OwnerStart,
        BoxEvent::OwnerStop,
        BoxEvent::AdminStop,
        BoxEvent::SystemIdleStop,
        BoxEvent::OwnerDelete,
        BoxEvent::AdminDelete,
        BoxEvent::SystemExpire,
        BoxEvent::SystemMemberRemoved,
        BoxEvent::OwnerRetryDelete,
        BoxEvent::AdminRetryDelete,
        BoxEvent::SystemRetryDelete,
        BoxEvent::RunnerDeleted,
        BoxEvent::RunnerDeleteFailed,
    ];

    /// `owner`, `admin`, `runner` or `system` — what the audit row calls the actor.
    pub fn actor_role(self) -> &'static str {
        match self {
            BoxEvent::OwnerStart
            | BoxEvent::OwnerStop
            | BoxEvent::OwnerDelete
            | BoxEvent::OwnerRetryDelete => "owner",
            BoxEvent::AdminStop | BoxEvent::AdminDelete | BoxEvent::AdminRetryDelete => "admin",
            BoxEvent::RunnerReady
            | BoxEvent::RunnerCreateFailed
            | BoxEvent::RunnerIdle
            | BoxEvent::RunnerActive
            | BoxEvent::RunnerDeleted
            | BoxEvent::RunnerDeleteFailed => "runner",
            BoxEvent::SystemIdleStop
            | BoxEvent::SystemExpire
            | BoxEvent::SystemMemberRemoved
            | BoxEvent::SystemRetryDelete => "system",
        }
    }

    /// The audit action suffix: `cloud_box.<name>`.
    pub fn audit_name(self) -> &'static str {
        match self {
            BoxEvent::RunnerReady => "ready",
            BoxEvent::RunnerCreateFailed => "create_failed",
            BoxEvent::RunnerIdle => "idle",
            BoxEvent::RunnerActive => "active",
            BoxEvent::OwnerStart => "started",
            BoxEvent::OwnerStop | BoxEvent::AdminStop | BoxEvent::SystemIdleStop => "stopped",
            BoxEvent::OwnerDelete
            | BoxEvent::AdminDelete
            | BoxEvent::SystemExpire
            | BoxEvent::SystemMemberRemoved => "delete_requested",
            BoxEvent::OwnerRetryDelete
            | BoxEvent::AdminRetryDelete
            | BoxEvent::SystemRetryDelete => "delete_retried",
            BoxEvent::RunnerDeleted => "deleted",
            BoxEvent::RunnerDeleteFailed => "delete_failed",
        }
    }

    /// The `closed_reason` an event writes when it opens a deletion.
    fn closed_reason(self) -> Option<&'static str> {
        match self {
            BoxEvent::OwnerDelete => Some("owner_delete"),
            BoxEvent::AdminDelete => Some("admin_delete"),
            BoxEvent::SystemExpire => Some("stopped_expired"),
            BoxEvent::SystemMemberRemoved => Some("member_removed"),
            BoxEvent::RunnerCreateFailed => Some("create_failed"),
            _ => None,
        }
    }

    /// The control the runner must receive for this event (none for what the
    /// runner itself reports).
    pub fn control_verb(self) -> Option<ControlVerb> {
        match self {
            BoxEvent::OwnerStart => Some(ControlVerb::Start),
            BoxEvent::OwnerStop | BoxEvent::AdminStop | BoxEvent::SystemIdleStop => {
                Some(ControlVerb::Stop)
            }
            BoxEvent::OwnerDelete
            | BoxEvent::AdminDelete
            | BoxEvent::SystemExpire
            | BoxEvent::SystemMemberRemoved
            | BoxEvent::OwnerRetryDelete
            | BoxEvent::AdminRetryDelete
            | BoxEvent::SystemRetryDelete => Some(ControlVerb::Delete),
            _ => None,
        }
    }

    /// Does this event take a slot of the concurrent-on cap?
    fn takes_slot(self) -> bool {
        matches!(self, BoxEvent::OwnerStart)
    }

    /// Is `from` already where this event would leave the box? A repeated
    /// request answers 200 with the current state rather than a conflict.
    pub fn is_already_done(self, from: BoxState) -> bool {
        match self {
            BoxEvent::OwnerStart => matches!(from, BoxState::Running | BoxState::Idle),
            BoxEvent::OwnerStop | BoxEvent::AdminStop => from == BoxState::Stopped,
            BoxEvent::OwnerDelete | BoxEvent::AdminDelete => {
                matches!(from, BoxState::Deleting | BoxState::Deleted)
            }
            _ => false,
        }
    }
}

/// The lifecycle table. `None` = the event is not allowed in that state.
pub fn next_state(from: BoxState, event: BoxEvent) -> Option<BoxState> {
    use BoxEvent as E;
    use BoxState as S;
    match (from, event) {
        (S::Creating, E::RunnerReady) => Some(S::Running),
        (S::Creating, E::RunnerCreateFailed) => Some(S::Deleted),
        (S::Running, E::RunnerIdle) => Some(S::Idle),
        (S::Idle, E::RunnerActive) => Some(S::Running),
        (S::Stopped, E::OwnerStart) => Some(S::Running),
        (S::Running | S::Idle, E::OwnerStop | E::AdminStop) => Some(S::Stopped),
        (S::Idle, E::SystemIdleStop) => Some(S::Stopped),
        (
            S::Creating | S::Running | S::Idle | S::Stopped,
            E::OwnerDelete | E::AdminDelete | E::SystemMemberRemoved,
        ) => Some(S::Deleting),
        (S::Stopped, E::SystemExpire) => Some(S::Deleting),
        (S::DeleteFailed, E::OwnerRetryDelete | E::AdminRetryDelete | E::SystemRetryDelete) => {
            Some(S::Deleting)
        }
        (S::Deleting, E::RunnerDeleted) => Some(S::Deleted),
        (S::Deleting, E::RunnerDeleteFailed) => Some(S::DeleteFailed),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

/// A box as every response and audit row may describe it. Nothing here is a
/// secret; there is no secret column to select.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoxInfo {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub state: BoxState,
    pub closed_reason: Option<String>,
    pub cpu_millis: i32,
    pub memory_mb: i32,
    pub disk_gb: i32,
    pub pids: i32,
    pub idle_minutes: i32,
    pub stopped_delete_days: i32,
    pub keep_awake_max_hours: i32,
    pub created_at_ms: i64,
    pub state_changed_at_ms: i64,
    pub idle_since_ms: Option<i64>,
    pub stopped_at_ms: Option<i64>,
    pub keep_awake_until_ms: Option<i64>,
    pub last_attached_at_ms: Option<i64>,
    pub deleted_at_ms: Option<i64>,
}

fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::bigint")
}

fn box_columns() -> String {
    format!(
        "id, workspace_id, member_id, state, closed_reason, cpu_millis, memory_mb, disk_gb, \
         pids, idle_minutes, stopped_delete_days, keep_awake_max_hours, {}, {}, {}, {}, {}, {}, {}",
        ms("created_at"),
        ms("state_changed_at"),
        ms("idle_since"),
        ms("stopped_at"),
        ms("keep_awake_until"),
        ms("last_attached_at"),
        ms("deleted_at"),
    )
}

fn box_from_row(row: &PgRow) -> Result<BoxInfo, DbError> {
    let state: String = row.try_get(3)?;
    Ok(BoxInfo {
        id: row.try_get(0)?,
        workspace_id: row.try_get(1)?,
        member_id: row.try_get(2)?,
        state: BoxState::parse(&state).ok_or_else(|| {
            DbError::Sqlx(sqlx::Error::Decode(
                format!("unknown cloud_box state {state}").into(),
            ))
        })?,
        closed_reason: row.try_get(4)?,
        cpu_millis: row.try_get(5)?,
        memory_mb: row.try_get(6)?,
        disk_gb: row.try_get(7)?,
        pids: row.try_get(8)?,
        idle_minutes: row.try_get(9)?,
        stopped_delete_days: row.try_get(10)?,
        keep_awake_max_hours: row.try_get(11)?,
        created_at_ms: row.try_get(12)?,
        state_changed_at_ms: row.try_get(13)?,
        idle_since_ms: row.try_get(14)?,
        stopped_at_ms: row.try_get(15)?,
        keep_awake_until_ms: row.try_get(16)?,
        last_attached_at_ms: row.try_get(17)?,
        deleted_at_ms: row.try_get(18)?,
    })
}

/// The limits a `create` control carries — the only payload a control has (D2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxLimits {
    pub cpu_millis: i32,
    pub memory_mb: i32,
    pub disk_gb: i32,
    pub pids: i32,
}

impl Default for BoxLimits {
    fn default() -> Self {
        BoxLimits {
            cpu_millis: DEFAULT_CPU_MILLIS,
            memory_mb: DEFAULT_MEMORY_MB,
            disk_gb: DEFAULT_DISK_GB,
            pids: DEFAULT_PIDS,
        }
    }
}

/// One control as the runner reads it. The whole of it: verb, box, and (for
/// `create`) the four limits. There is no field for an image, a command, a mount,
/// a network profile or an env var.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlInfo {
    pub id: Uuid,
    pub seq: i64,
    pub box_id: Uuid,
    pub verb: String,
    pub limits: Option<BoxLimits>,
    pub attempts: i32,
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

async fn lock_capacity(conn: &mut PgConnection, workspace_id: Uuid) -> Result<(), DbError> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('momo.cloud_box.cap:' || $1::text, 0))",
    )
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn live_slots(conn: &mut PgConnection, workspace_id: Uuid) -> Result<i64, DbError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cloud_box \
          WHERE workspace_id = $1 AND state IN ('creating', 'running', 'idle')",
    )
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count)
}

pub async fn find_box_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
) -> Result<Option<BoxInfo>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {} FROM cloud_box WHERE workspace_id = $1 AND id = $2",
        box_columns()
    ))
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(box_from_row).transpose()
}

/// The member's one live box (anything but a `deleted` tombstone), if any.
pub async fn find_live_box_for_member_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<BoxInfo>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {} FROM cloud_box \
          WHERE workspace_id = $1 AND member_id = $2 AND state <> 'deleted'",
        box_columns()
    ))
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(box_from_row).transpose()
}

/// Every live box of the workspace (the admin's resource list).
pub async fn list_live_boxes_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<BoxInfo>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {} FROM cloud_box WHERE workspace_id = $1 AND state <> 'deleted' \
          ORDER BY created_at DESC, id DESC",
        box_columns()
    ))
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(box_from_row).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateOutcome {
    Created(BoxInfo),
    /// The owner is not an active human of this workspace.
    OwnerNotHuman,
    /// The member already has a live box (one box per member, D1).
    AlreadyHasBox,
    /// The workspace's concurrent-on cap is reached (D3 「자리가 없어요」).
    NoCapacity,
}

fn audit_detail(info: &BoxInfo, from: Option<BoxState>, role: &str) -> serde_json::Value {
    json!({
        "box_id": info.id.to_string(),
        "owner_member_id": info.member_id.to_string(),
        "from": from.map(BoxState::as_str),
        "to": info.state.as_str(),
        "actor_role": role,
        "reason": info.closed_reason,
    })
}

async fn audit_box(
    conn: &mut PgConnection,
    info: &BoxInfo,
    action: &str,
    from: Option<BoxState>,
    actor: Option<Uuid>,
    role: &str,
    via_token: Option<Uuid>,
) -> Result<(), DbError> {
    let mut entry = AuditEntry::new(info.workspace_id, action)
        .about(info.member_id)
        .target("cloud_box", info.id)
        .via_token(via_token)
        .with_schema(CLOUD_BOX_AUDIT_SCHEMA, audit_detail(info, from, role));
    entry.actor_member_id = actor;
    write_audit(conn, &entry).await?;
    Ok(())
}

/// Insert a control. `false` = a control is already in flight for the box.
async fn enqueue_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
    verb: ControlVerb,
    limits: Option<BoxLimits>,
    requested_by: Option<Uuid>,
) -> Result<bool, DbError> {
    sqlx::query("SAVEPOINT cloud_box_control")
        .execute(&mut *conn)
        .await?;
    let inserted = sqlx::query(
        "INSERT INTO cloud_box_control \
           (workspace_id, box_id, verb, cpu_millis, memory_mb, disk_gb, pids, requested_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(workspace_id)
    .bind(box_id)
    .bind(verb.as_str())
    .bind(limits.map(|l| l.cpu_millis))
    .bind(limits.map(|l| l.memory_mb))
    .bind(limits.map(|l| l.disk_gb))
    .bind(limits.map(|l| l.pids))
    .bind(requested_by)
    .execute(&mut *conn)
    .await;
    match inserted {
        Ok(_) => {
            sqlx::query("RELEASE SAVEPOINT cloud_box_control")
                .execute(&mut *conn)
                .await?;
            Ok(true)
        }
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            sqlx::query("ROLLBACK TO SAVEPOINT cloud_box_control")
                .execute(&mut *conn)
                .await?;
            sqlx::query("RELEASE SAVEPOINT cloud_box_control")
                .execute(&mut *conn)
                .await?;
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}

/// A newer request supersedes controls the runner has not taken yet (and ones
/// whose lease ran out): stop-then-start must not queue behind a stale stop.
async fn supersede_stale_controls(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE cloud_box_control SET status = 'cancelled', completed_at = now() \
          WHERE workspace_id = $1 AND box_id = $2 \
            AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < now()))",
    )
    .bind(workspace_id)
    .bind(box_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Create the member's box and queue the runner's `create`. One transaction: the
/// row, the control and the audit row commit together or not at all.
pub async fn create_box_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    limits: BoxLimits,
    via_token: Option<Uuid>,
) -> Result<CreateOutcome, DbError> {
    let owner: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM member \
          WHERE id = $1 AND workspace_id = $2 AND kind = 'human' \
            AND status = 'active' AND deleted_at IS NULL",
    )
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    if owner.is_none() {
        return Ok(CreateOutcome::OwnerNotHuman);
    }
    lock_capacity(conn, workspace_id).await?;
    if find_live_box_for_member_in_tx(conn, workspace_id, member_id)
        .await?
        .is_some()
    {
        return Ok(CreateOutcome::AlreadyHasBox);
    }
    if live_slots(conn, workspace_id).await? >= MAX_CONCURRENT_BOXES {
        return Ok(CreateOutcome::NoCapacity);
    }
    sqlx::query("SAVEPOINT cloud_box_create")
        .execute(&mut *conn)
        .await?;
    let inserted = sqlx::query(&format!(
        "INSERT INTO cloud_box (workspace_id, member_id, cpu_millis, memory_mb, disk_gb, pids) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING {}",
        box_columns()
    ))
    .bind(workspace_id)
    .bind(member_id)
    .bind(limits.cpu_millis)
    .bind(limits.memory_mb)
    .bind(limits.disk_gb)
    .bind(limits.pids)
    .fetch_one(&mut *conn)
    .await;
    let row = match inserted {
        Ok(row) => {
            sqlx::query("RELEASE SAVEPOINT cloud_box_create")
                .execute(&mut *conn)
                .await?;
            row
        }
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            // The advisory lock makes this unreachable between two requests of one
            // workspace; the unique index is still the fact, and a unique violation
            // is the answer if anything else ever races it.
            sqlx::query("ROLLBACK TO SAVEPOINT cloud_box_create")
                .execute(&mut *conn)
                .await?;
            sqlx::query("RELEASE SAVEPOINT cloud_box_create")
                .execute(&mut *conn)
                .await?;
            return Ok(CreateOutcome::AlreadyHasBox);
        }
        Err(error) => return Err(error.into()),
    };
    let info = box_from_row(&row)?;
    enqueue_in_tx(
        conn,
        workspace_id,
        info.id,
        ControlVerb::Create,
        Some(limits),
        Some(member_id),
    )
    .await?;
    audit_box(
        conn,
        &info,
        "cloud_box.created",
        None,
        Some(member_id),
        "owner",
        via_token,
    )
    .await?;
    Ok(CreateOutcome::Created(info))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied {
        before: BoxState,
        info: BoxInfo,
    },
    NotFound,
    /// The event is not in the lifecycle table for the box's current state.
    Illegal {
        from: BoxState,
        info: BoxInfo,
    },
    /// Starting would exceed the workspace's concurrent-on cap.
    NoCapacity,
    /// The runner has not finished the previous control for this box.
    ControlInFlight,
}

/// Apply one lifecycle event under the box's row lock. Queues the runner control
/// the event implies and writes the audit row in the same transaction.
pub async fn apply_event_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
    event: BoxEvent,
    actor: Option<Uuid>,
    via_token: Option<Uuid>,
) -> Result<ApplyOutcome, DbError> {
    if event.takes_slot() {
        lock_capacity(conn, workspace_id).await?;
    }
    let locked = sqlx::query(&format!(
        "SELECT {} FROM cloud_box WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        box_columns()
    ))
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = locked else {
        return Ok(ApplyOutcome::NotFound);
    };
    let current = box_from_row(&row)?;
    let before = current.state;
    let Some(next) = next_state(before, event) else {
        return Ok(ApplyOutcome::Illegal {
            from: before,
            info: current,
        });
    };
    if event.takes_slot()
        && !before.counts_toward_cap()
        && live_slots(conn, workspace_id).await? >= MAX_CONCURRENT_BOXES
    {
        return Ok(ApplyOutcome::NoCapacity);
    }
    if let Some(verb) = event.control_verb() {
        supersede_stale_controls(conn, workspace_id, box_id).await?;
        if !enqueue_in_tx(conn, workspace_id, box_id, verb, None, actor).await? {
            return Ok(ApplyOutcome::ControlInFlight);
        }
    }
    let updated = sqlx::query(&format!(
        "UPDATE cloud_box SET \
            state = $3, \
            closed_reason = CASE WHEN $3 IN ('deleting', 'delete_failed', 'deleted') \
                                 THEN COALESCE($4, closed_reason) ELSE NULL END, \
            idle_since = CASE WHEN $3 = 'idle' THEN now() END, \
            stopped_at = CASE WHEN $3 = 'stopped' THEN now() END, \
            keep_awake_until = CASE WHEN $3 IN ('running', 'idle') THEN keep_awake_until END, \
            deleted_at = CASE WHEN $3 = 'deleted' THEN now() END, \
            last_attached_at = CASE WHEN $5 THEN now() ELSE last_attached_at END, \
            state_changed_at = now(), updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 \
          RETURNING {}",
        box_columns()
    ))
    .bind(workspace_id)
    .bind(box_id)
    .bind(next.as_str())
    .bind(event.closed_reason())
    .bind(event == BoxEvent::RunnerActive)
    .fetch_one(&mut *conn)
    .await?;
    let info = box_from_row(&updated)?;
    audit_box(
        conn,
        &info,
        &format!("cloud_box.{}", event.audit_name()),
        Some(before),
        actor,
        event.actor_role(),
        via_token,
    )
    .await?;
    Ok(ApplyOutcome::Applied { before, info })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeepAwakeOutcome {
    Set(BoxInfo),
    NotFound,
    /// Only a running or idle box can be kept awake.
    NotRunning(BoxState),
    /// More than the box's `keep_awake_max_hours`.
    TooLong {
        max_hours: i32,
    },
}

/// 「계속 켜 둠」 (D3): the owner turns it on for up to `keep_awake_max_hours`
/// (12 by default); `None` turns it off. The runner extends it only while a device
/// is attached — that rule is the runner's (M2); the server stores the deadline.
pub async fn set_keep_awake_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
    hours: Option<i32>,
    actor: Uuid,
    via_token: Option<Uuid>,
) -> Result<KeepAwakeOutcome, DbError> {
    let locked = sqlx::query(&format!(
        "SELECT {} FROM cloud_box WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        box_columns()
    ))
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = locked else {
        return Ok(KeepAwakeOutcome::NotFound);
    };
    let current = box_from_row(&row)?;
    if !matches!(current.state, BoxState::Running | BoxState::Idle) {
        return Ok(KeepAwakeOutcome::NotRunning(current.state));
    }
    if let Some(hours) = hours {
        if hours < 1 || hours > current.keep_awake_max_hours {
            return Ok(KeepAwakeOutcome::TooLong {
                max_hours: current.keep_awake_max_hours,
            });
        }
    }
    let updated = sqlx::query(&format!(
        "UPDATE cloud_box SET \
            keep_awake_until = CASE WHEN $3::int IS NULL THEN NULL \
                                    ELSE now() + make_interval(hours => $3::int) END, \
            updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 RETURNING {}",
        box_columns()
    ))
    .bind(workspace_id)
    .bind(box_id)
    .bind(hours)
    .fetch_one(&mut *conn)
    .await?;
    let info = box_from_row(&updated)?;
    audit_box(
        conn,
        &info,
        if hours.is_some() {
            "cloud_box.keep_awake_set"
        } else {
            "cloud_box.keep_awake_cleared"
        },
        Some(current.state),
        Some(actor),
        "owner",
        via_token,
    )
    .await?;
    Ok(KeepAwakeOutcome::Set(info))
}

// ---------------------------------------------------------------------------
// the runner's side of the queue (tenant-scoped; the HTTP door is M2's)
// ---------------------------------------------------------------------------

/// Hand the runner up to `limit` controls, oldest first: `pending` ones and ones
/// whose lease ran out. Runs inside a tenant transaction — one runner serves one
/// workspace (D2), so polling needs no cross-tenant role.
pub async fn claim_controls_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    limit: i64,
    lease_seconds: i64,
) -> Result<Vec<ControlInfo>, DbError> {
    let rows = sqlx::query(
        "WITH next AS ( \
           SELECT id FROM cloud_box_control \
            WHERE workspace_id = $1 \
              AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < now())) \
            ORDER BY seq \
            LIMIT $2 \
            FOR UPDATE SKIP LOCKED) \
         UPDATE cloud_box_control c SET status = 'claimed', claimed_at = now(), \
                lease_expires_at = now() + make_interval(secs => $3::int), \
                attempts = c.attempts + 1 \
           FROM next WHERE c.id = next.id \
         RETURNING c.id, c.seq, c.box_id, c.verb, c.cpu_millis, c.memory_mb, c.disk_gb, \
                   c.pids, c.attempts",
    )
    .bind(workspace_id)
    .bind(limit.clamp(1, 50))
    .bind(lease_seconds.clamp(5, 3600))
    .fetch_all(&mut *conn)
    .await?;
    let mut controls = rows
        .iter()
        .map(|row| -> Result<ControlInfo, DbError> {
            let cpu: Option<i32> = row.try_get(4)?;
            let memory: Option<i32> = row.try_get(5)?;
            let disk: Option<i32> = row.try_get(6)?;
            let pids: Option<i32> = row.try_get(7)?;
            Ok(ControlInfo {
                id: row.try_get(0)?,
                seq: row.try_get(1)?,
                box_id: row.try_get(2)?,
                verb: row.try_get(3)?,
                limits: match (cpu, memory, disk, pids) {
                    (Some(cpu_millis), Some(memory_mb), Some(disk_gb), Some(pids)) => {
                        Some(BoxLimits {
                            cpu_millis,
                            memory_mb,
                            disk_gb,
                            pids,
                        })
                    }
                    _ => None,
                },
                attempts: row.try_get(8)?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    controls.sort_by_key(|control| control.seq);
    Ok(controls)
}

/// The runner reports a claimed control done (`ok`) or failed. `false` = the
/// control is not claimed (already finished, cancelled, or unknown).
pub async fn complete_control_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
    ok: bool,
) -> Result<bool, DbError> {
    let done = sqlx::query(
        "UPDATE cloud_box_control SET status = $3, result_code = $4, completed_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'claimed'",
    )
    .bind(workspace_id)
    .bind(control_id)
    .bind(if ok { "done" } else { "failed" })
    .bind(if ok { "ok" } else { "failed" })
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The whole table, written out. Every `(state, event)` not here must be refused.
    const ALLOWED: &[(BoxState, BoxEvent, BoxState)] = &[
        (BoxState::Creating, BoxEvent::RunnerReady, BoxState::Running),
        (
            BoxState::Creating,
            BoxEvent::RunnerCreateFailed,
            BoxState::Deleted,
        ),
        (BoxState::Running, BoxEvent::RunnerIdle, BoxState::Idle),
        (BoxState::Idle, BoxEvent::RunnerActive, BoxState::Running),
        (BoxState::Stopped, BoxEvent::OwnerStart, BoxState::Running),
        (BoxState::Running, BoxEvent::OwnerStop, BoxState::Stopped),
        (BoxState::Idle, BoxEvent::OwnerStop, BoxState::Stopped),
        (BoxState::Running, BoxEvent::AdminStop, BoxState::Stopped),
        (BoxState::Idle, BoxEvent::AdminStop, BoxState::Stopped),
        (BoxState::Idle, BoxEvent::SystemIdleStop, BoxState::Stopped),
        (
            BoxState::Creating,
            BoxEvent::OwnerDelete,
            BoxState::Deleting,
        ),
        (BoxState::Running, BoxEvent::OwnerDelete, BoxState::Deleting),
        (BoxState::Idle, BoxEvent::OwnerDelete, BoxState::Deleting),
        (BoxState::Stopped, BoxEvent::OwnerDelete, BoxState::Deleting),
        (
            BoxState::Creating,
            BoxEvent::AdminDelete,
            BoxState::Deleting,
        ),
        (BoxState::Running, BoxEvent::AdminDelete, BoxState::Deleting),
        (BoxState::Idle, BoxEvent::AdminDelete, BoxState::Deleting),
        (BoxState::Stopped, BoxEvent::AdminDelete, BoxState::Deleting),
        (
            BoxState::Creating,
            BoxEvent::SystemMemberRemoved,
            BoxState::Deleting,
        ),
        (
            BoxState::Running,
            BoxEvent::SystemMemberRemoved,
            BoxState::Deleting,
        ),
        (
            BoxState::Idle,
            BoxEvent::SystemMemberRemoved,
            BoxState::Deleting,
        ),
        (
            BoxState::Stopped,
            BoxEvent::SystemMemberRemoved,
            BoxState::Deleting,
        ),
        (
            BoxState::Stopped,
            BoxEvent::SystemExpire,
            BoxState::Deleting,
        ),
        (
            BoxState::DeleteFailed,
            BoxEvent::OwnerRetryDelete,
            BoxState::Deleting,
        ),
        (
            BoxState::DeleteFailed,
            BoxEvent::AdminRetryDelete,
            BoxState::Deleting,
        ),
        (
            BoxState::DeleteFailed,
            BoxEvent::SystemRetryDelete,
            BoxState::Deleting,
        ),
        (
            BoxState::Deleting,
            BoxEvent::RunnerDeleted,
            BoxState::Deleted,
        ),
        (
            BoxState::Deleting,
            BoxEvent::RunnerDeleteFailed,
            BoxState::DeleteFailed,
        ),
    ];

    #[test]
    fn every_state_event_pair_matches_the_written_table() {
        let allowed: HashSet<(BoxState, BoxEvent)> = ALLOWED
            .iter()
            .map(|(from, event, _)| (*from, *event))
            .collect();
        assert_eq!(allowed.len(), ALLOWED.len(), "duplicate row in the table");
        let mut seen_allowed = 0;
        for from in BoxState::ALL {
            for event in BoxEvent::ALL {
                let got = next_state(from, event);
                let want = ALLOWED
                    .iter()
                    .find(|(f, e, _)| *f == from && *e == event)
                    .map(|(_, _, to)| *to);
                assert_eq!(
                    got, want,
                    "{from:?} --{event:?}--> expected {want:?}, table says {got:?}"
                );
                seen_allowed += usize::from(got.is_some());
            }
        }
        assert_eq!(seen_allowed, ALLOWED.len());
        assert_eq!(BoxState::ALL.len() * BoxEvent::ALL.len(), 7 * 17);
    }

    #[test]
    fn deleted_is_terminal_and_nothing_leaves_it() {
        for event in BoxEvent::ALL {
            assert_eq!(next_state(BoxState::Deleted, event), None, "{event:?}");
        }
    }

    #[test]
    fn only_the_owner_can_start_and_no_admin_event_starts() {
        let starters: Vec<_> = BoxEvent::ALL
            .into_iter()
            .filter(|event| {
                BoxState::ALL.into_iter().any(|from| {
                    next_state(from, *event) == Some(BoxState::Running) && from == BoxState::Stopped
                })
            })
            .collect();
        assert_eq!(starters, vec![BoxEvent::OwnerStart]);
        for event in BoxEvent::ALL {
            if event.actor_role() == "admin" {
                assert!(
                    matches!(
                        event,
                        BoxEvent::AdminStop | BoxEvent::AdminDelete | BoxEvent::AdminRetryDelete
                    ),
                    "an admin event outside D3/D6 resource management: {event:?}"
                );
            }
        }
    }

    #[test]
    fn every_event_with_a_control_names_one_of_the_five_verbs() {
        let verbs: HashSet<&str> = ControlVerb::ALL.iter().map(|v| v.as_str()).collect();
        assert_eq!(
            verbs,
            HashSet::from(["create", "start", "stop", "delete", "status"])
        );
        for event in BoxEvent::ALL {
            if let Some(verb) = event.control_verb() {
                assert!(verbs.contains(verb.as_str()));
            }
        }
    }

    #[test]
    fn state_labels_round_trip() {
        for state in BoxState::ALL {
            assert_eq!(BoxState::parse(state.as_str()), Some(state));
        }
        assert_eq!(BoxState::parse("starting"), None);
    }

    #[test]
    fn defaults_are_the_adr_limits() {
        let limits = BoxLimits::default();
        assert_eq!(
            (
                limits.cpu_millis,
                limits.memory_mb,
                limits.disk_gb,
                limits.pids
            ),
            (1000, 2048, 10, 512)
        );
        assert_eq!(MAX_CONCURRENT_BOXES, 5);
        assert_eq!(
            (
                DEFAULT_IDLE_MINUTES,
                DEFAULT_STOPPED_DELETE_DAYS,
                DEFAULT_KEEP_AWAKE_MAX_HOURS
            ),
            (30, 30, 12)
        );
    }
}
