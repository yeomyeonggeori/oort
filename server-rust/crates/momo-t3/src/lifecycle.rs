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

/// Open a work session under a caller-chosen id (B2.2).
///
/// Swift allocates the session id before the row exists (`SELECT uuidv7()`,
/// `WorkSessionRoutes.swift:217-221`) because the *card message* has to carry it:
/// the system message's `client_msg_id` and its `props.session_id` are the
/// session id, and the session's `root_message_id` is that message. One of the
/// two rows must therefore know the other's id first, and Swift chose the
/// session's. [`create_work_session_in_tx`] (DB-defaulted id) stays for callers
/// with no such ordering constraint.
pub async fn create_work_session_with_id_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    new: NewWorkSession,
) -> Result<WorkSession, T3Error> {
    let sql = format!(
        "INSERT INTO work_session \
           (id, workspace_id, channel_id, member_id, host_id, root_message_id, tool, label, \
            started_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \
                 COALESCE((SELECT created_at FROM message WHERE id = $6), clock_timestamp())) \
         RETURNING {WORK_SESSION_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(session_id)
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

// ---------------------------------------------------------------------------
// the REST projection (B2.2)
// ---------------------------------------------------------------------------

/// A session in the shape the wire DTO needs (`WorkSessionDTO`,
/// `WorkSessionRoutes.swift:57-75`), added in B2.2.
///
/// Separate from [`WorkSession`] on purpose: [`WorkSession`] is the *domain*
/// row the lifecycle reasons about, this is a read projection that also carries
/// the two computed columns the DTO promises (`observerGrantCount`,
/// `remoteAttachAvailable`) and epoch-millisecond timestamps computed in SQL, so
/// the route re-derives nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkSessionDetail {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub member_id: Uuid,
    pub host_id: Uuid,
    pub root_message_id: Uuid,
    pub tool: String,
    pub label: String,
    pub status: String,
    pub observation: String,
    pub observer_grant_count: i64,
    pub remote_attach_available: bool,
    /// LIVE-1: the display half of the same question — is there a screen to
    /// watch? `remote_attach_available`'s exact twin, and deliberately a
    /// **separate** boolean: a session can have a PTY and no screen (every
    /// pre-LIVE-1 session), and a client that folded the two would offer 관전
    /// on a session with nothing to render.
    pub remote_display_available: bool,
    /// LIVE-5a: when a person currently holds this session's keyboard, the
    /// moment they took it (epoch ms). `None` means nobody does.
    ///
    /// ## The SoT decision LIVE-4 deferred to here
    ///
    /// Three surfaces describe a control window, and LIVE-4 froze the question
    /// of which one a reload should believe:
    ///
    /// 1. the `work.session.control` envelope — **transport**, and the hard
    ///    invariant says Centrifugo is transport only. A client that learned
    ///    정지 시각 by listening forgets it on refresh.
    /// 2. the login-handoff card's `control_*` props — a **derived copy**, and
    ///    deliberately a narrow one: it is stamped onto pending handoff cards
    ///    only, so a control window opened for any other reason stamps nothing
    ///    and the session surface would show nothing.
    /// 3. `display_control_window` — the ledger, written in the same
    ///    transaction as the grant, one open row per session by unique index.
    ///
    /// **(3) is the source of truth and the other two are projections of it.**
    /// So the session surface reads the ledger rather than either copy, and it
    /// reads it *here* — inside the same projection that already answers every
    /// other question about a session — rather than as a second query at the
    /// route, because a second query is a second snapshot and that is how a
    /// session renders 「사람이 조작 중」 next to a resumed agent.
    ///
    /// ## …and why it is in the bare `RETURNING` too
    ///
    /// The other half of the freeze. A `RETURNING` projection describes the row
    /// a write just produced, and a control window is a different row — so the
    /// cheap answer was to leave the constant `NULL` there, the way
    /// `observer_grant_count` leaves a constant `0`. That answer is wrong for
    /// this field and right for that one, and the difference is what the value
    /// is used for: nobody acts on an observer count, while `ended` arriving
    /// from `end_work_session_in_tx` with `control_started_at_ms: NULL` would be
    /// a client told the keyboard was free by the very write that closed the
    /// window — a race it cannot detect and cannot re-read its way out of. The
    /// lease clock lives in the subquery, so every projection is answering the
    /// same question at the same instant, and the drift guard in
    /// `crate::reattach` makes a fifth reader that forgets impossible to merge.
    pub control_started_at_ms: Option<i64>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_code: Option<i32>,
    pub end_reason: Option<String>,
    pub resumed_from_session_id: Option<Uuid>,
}

/// The two availability predicates, aliased `ws`, written **once**.
///
/// They used to be spelled out in each of the three projections
/// ([`detail_columns`], [`crate::reattach`]'s `REATTACH_COLUMNS`, and the
/// session list). LIVE-1 had to add a second predicate beside the first in every
/// one of them, which is exactly the shape that lands in two of three and is
/// discovered later as "the list says 관전 가능, the detail says no". Hoisting
/// them makes the drift unrepresentable, and
/// `every_projection_publishes_both_availability_columns` still checks the
/// composed statements in case a fourth reader is written by hand.
pub(crate) const WS_ATTACH_AVAILABILITY: &str =
    "(ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL) AS remote_attach_available, \
     (ws.display_id IS NOT NULL AND ws.display_endpoint IS NOT NULL) AS remote_display_available";

/// The same pair for a bare `RETURNING`, where no alias is in scope.
const BARE_ATTACH_AVAILABILITY: &str =
    "(pty_id IS NOT NULL AND attach_endpoint IS NOT NULL) AS remote_attach_available, \
     (display_id IS NOT NULL AND display_endpoint IS NOT NULL) AS remote_display_available";

/// The standing control window's 정지 시각, aliased `ws` — LIVE-5a's durable
/// projection ([`WorkSessionDetail::control_started_at_ms`] carries the SoT
/// argument).
///
/// The predicate is `display_control_window_active_idx`'s partial condition
/// verbatim, so this reads an index containing only **open** windows — a set
/// bounded by the number of people typing into a live screen right now, not by
/// the table's history. `LIMIT 1` is belt and braces over
/// `display_control_window_open_uniq`, which already makes a second row
/// unrepresentable.
///
/// The lease clause is what makes this answer 「지금」 rather than 「언젠가」: a
/// window whose producer died reads as absent here for the same
/// `lease_expires_at > clock_timestamp()` reason
/// [`crate::display_control::active_control_window_in_tx`] does, so the session
/// surface and the agent's refusal never disagree about who holds the keyboard.
/// It is a pure read — reconciling the lapse is a write, and a projection that
/// wrote would put a second author on rows the close paths own.
pub(crate) const WS_CONTROL_PROJECTION: &str =
    "(SELECT floor(extract(epoch from dcw.started_at) * 1000)::bigint \
        FROM display_control_window dcw \
       WHERE dcw.workspace_id = ws.workspace_id \
         AND dcw.work_session_id = ws.id \
         AND dcw.ended_at IS NULL \
         AND dcw.lease_expires_at > clock_timestamp() \
       LIMIT 1) AS control_started_at_ms";

/// [`WS_CONTROL_PROJECTION`] for a bare `RETURNING`, where the table name is the
/// only qualifier in scope.
const BARE_CONTROL_PROJECTION: &str =
    "(SELECT floor(extract(epoch from dcw.started_at) * 1000)::bigint \
        FROM display_control_window dcw \
       WHERE dcw.workspace_id = work_session.workspace_id \
         AND dcw.work_session_id = work_session.id \
         AND dcw.ended_at IS NULL \
         AND dcw.lease_expires_at > clock_timestamp() \
       LIMIT 1) AS control_started_at_ms";

/// The DTO projection without the observer-grant subquery — used by every
/// single-row read and every `RETURNING`, exactly as Swift does
/// (`0::bigint AS observer_grant_count`, :268/:493/:555).
fn detail_columns() -> String {
    format!(
        "ws.id, ws.workspace_id, ws.channel_id, ws.member_id, ws.host_id, \
         ws.root_message_id, ws.tool, ws.label, ws.status, ws.observation, \
         0::bigint AS observer_grant_count, \
         {WS_ATTACH_AVAILABILITY}, \
         {WS_CONTROL_PROJECTION}, \
         floor(extract(epoch from ws.started_at) * 1000)::bigint AS started_at_ms, \
         CASE WHEN ws.ended_at IS NULL THEN NULL \
              ELSE floor(extract(epoch from ws.ended_at) * 1000)::bigint END AS ended_at_ms, \
         ws.exit_code, ws.end_reason, ws.resumed_from_session_id"
    )
}

/// Same projection for a bare `RETURNING` (no `ws` alias available).
fn detail_returning() -> String {
    format!(
        "id, workspace_id, channel_id, member_id, host_id, \
         root_message_id, tool, label, status, observation, \
         0::bigint AS observer_grant_count, \
         {BARE_ATTACH_AVAILABILITY}, \
         {BARE_CONTROL_PROJECTION}, \
         floor(extract(epoch from started_at) * 1000)::bigint AS started_at_ms, \
         CASE WHEN ended_at IS NULL THEN NULL \
              ELSE floor(extract(epoch from ended_at) * 1000)::bigint END AS ended_at_ms, \
         exit_code, end_reason, resumed_from_session_id"
    )
}

/// Exposed so [`crate::reattach`]'s drift guard reads the composed statement
/// this crate actually issues, rather than a copy of it written for the test.
#[cfg(test)]
pub(crate) fn detail_columns_for_test() -> String {
    detail_columns()
}

/// See [`detail_columns_for_test`].
#[cfg(test)]
pub(crate) fn detail_returning_for_test() -> String {
    detail_returning()
}

fn decode_detail(row: &sqlx::postgres::PgRow) -> Result<WorkSessionDetail, T3Error> {
    Ok(WorkSessionDetail {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("channel_id")?,
        member_id: row.try_get("member_id")?,
        host_id: row.try_get("host_id")?,
        root_message_id: row.try_get("root_message_id")?,
        tool: row.try_get("tool")?,
        label: row.try_get("label")?,
        status: row.try_get("status")?,
        observation: row.try_get("observation")?,
        observer_grant_count: row.try_get("observer_grant_count")?,
        remote_attach_available: row.try_get("remote_attach_available")?,
        remote_display_available: row.try_get("remote_display_available")?,
        control_started_at_ms: row.try_get("control_started_at_ms")?,
        started_at_ms: row.try_get("started_at_ms")?,
        ended_at_ms: row.try_get("ended_at_ms")?,
        exit_code: row.try_get("exit_code")?,
        end_reason: row.try_get("end_reason")?,
        resumed_from_session_id: row.try_get("resumed_from_session_id")?,
    })
}

/// One session plus its card message's `seq`, locked for a lifecycle write
/// (`FOR UPDATE OF ws`, `WorkSessionRoutes.swift:488-504`).
///
/// The `seq` comes back with the row because the lifecycle broadcast carries it
/// (`lifecyclePayload`, :2148) — re-reading it after the update would race the
/// same channel's next message.
pub async fn lock_work_session_detail_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<(WorkSessionDetail, i64)>, T3Error> {
    let columns = detail_columns();
    let sql = format!(
        "SELECT {columns}, root.seq AS root_seq \
           FROM work_session ws \
           JOIN message root ON root.id = ws.root_message_id \
          WHERE ws.workspace_id = $1 AND ws.id = $2 \
          FOR UPDATE OF ws"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let seq: i64 = row.try_get("root_seq")?;
    Ok(Some((decode_detail(&row)?, seq)))
}

/// Authorization pre-flight for the T3 end path (`WorkSessionRoutes.swift:444-457`):
/// owner, host and channel **without** taking the session row lock, because
/// `t3_terminate` owns the `usage → session` rungs and must reach them after the
/// shared prelude already holds `credit → cloud host`.
pub async fn work_session_scope_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<(Uuid, Uuid, Uuid)>, T3Error> {
    let row = sqlx::query(
        "SELECT member_id, host_id, channel_id FROM work_session \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some((
        row.try_get("member_id")?,
        row.try_get("host_id")?,
        row.try_get("channel_id")?,
    )))
}

/// End a session's **ledger-independent** lifecycle: the tier-agnostic
/// `status = 'ended'` write (`WorkSessionRoutes.swift:543-562`).
///
/// This is emphatically **not** settlement. On a T3 session the caller has
/// already run [`terminate_in_tx`] (the only statement allowed to touch
/// `settled_at`) inside the same transaction; this write is what a T1/T2 session
/// does too, and it carries no billing meaning at all.
///
/// `Ok(None)` means the row was not in `('running','idle')` — someone else moved
/// it first, which Swift answers with 409 rather than a silent no-op.
pub async fn end_work_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    exit_code: Option<i32>,
) -> Result<Option<WorkSessionDetail>, T3Error> {
    let returning = detail_returning();
    let sql = format!(
        "UPDATE work_session \
            SET status = 'ended', \
                idle_at = NULL, \
                ended_at = clock_timestamp(), \
                exit_code = COALESCE($3, exit_code), \
                end_reason = NULL \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND status IN ('running', 'idle') \
        RETURNING {returning}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(session_id)
        .bind(exit_code)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode_detail).transpose()
}

/// Host-signed idle/running write (`WorkSessionRoutes.transitionToolLifecycle`
/// :820-890). `Ok(None)` = the CAS missed (status was not the expected
/// predecessor) → 409.
pub async fn transition_tool_lifecycle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    target_status: &str,
    exit_code: Option<i32>,
) -> Result<Option<WorkSessionDetail>, T3Error> {
    let returning = detail_returning();
    let sql = if target_status == "idle" {
        format!(
            "UPDATE work_session \
                SET status = 'idle', \
                    idle_at = clock_timestamp(), \
                    exit_code = $3, \
                    ended_at = NULL, \
                    end_reason = NULL \
              WHERE workspace_id = $1 \
                AND id = $2 \
                AND status = 'running' \
            RETURNING {returning}"
        )
    } else {
        format!(
            "UPDATE work_session \
                SET status = 'running', \
                    idle_at = NULL, \
                    ended_at = NULL, \
                    end_reason = NULL \
              WHERE workspace_id = $1 \
                AND id = $2 \
                AND status = 'idle' \
            RETURNING {returning}"
        )
    };
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(session_id)
        .bind(exit_code)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode_detail).transpose()
}

/// The channel-scoped session list (`WorkSessionRoutes.list` :2038-2087).
///
/// A function rather than a `const` so
/// [`WS_ATTACH_AVAILABILITY`] can be interpolated — the list is the third reader
/// of the same two predicates, and the one most likely to be forgotten because
/// it is the only one that spells its projection out inline.
///
/// The `observer_grant_count` subquery is deliberately **kind-blind**
/// (`tac.mode = 'observer'` with no `kind` clause): a teammate watching the
/// screen is a teammate watching. See
/// [`crate::terminal_attach::active_observer_capability_count_in_tx`], which
/// counts the same set, for why one number rather than two.
pub(crate) fn list_columns() -> String {
    format!(
        "ws.id, ws.workspace_id, ws.channel_id, ws.member_id, ws.host_id, \
                      ws.root_message_id, ws.tool, ws.label, ws.status, ws.observation, \
                      CASE \
                        WHEN ws.status IN ('running', 'idle') \
                         AND ws.observation = 'open' \
                         AND h.revoked_at IS NULL \
                        THEN ( \
                          SELECT count(*) \
                            FROM terminal_attach_capability tac \
                            JOIN member observer \
                              ON observer.id = tac.owner_member_id \
                             AND observer.workspace_id = tac.workspace_id \
                             AND observer.kind = 'human' \
                             AND observer.status = 'active' \
                             AND observer.deleted_at IS NULL \
                            JOIN membership observer_membership \
                              ON observer_membership.workspace_id = tac.workspace_id \
                             AND observer_membership.channel_id = ws.channel_id \
                             AND observer_membership.member_id = tac.owner_member_id \
                             AND observer_membership.left_at IS NULL \
                           WHERE tac.work_session_id = ws.id \
                             AND tac.mode = 'observer' \
                             AND tac.expires_at > clock_timestamp()) \
                        ELSE 0 \
                      END AS observer_grant_count, \
                      {WS_ATTACH_AVAILABILITY}, \
                      {WS_CONTROL_PROJECTION}, \
                      floor(extract(epoch from ws.started_at) * 1000)::bigint AS started_at_ms, \
                      CASE WHEN ws.ended_at IS NULL THEN NULL \
                           ELSE floor(extract(epoch from ws.ended_at) * 1000)::bigint END \
                        AS ended_at_ms, \
                      ws.exit_code, ws.end_reason, ws.resumed_from_session_id"
    )
}

/// The `membership` join is the authorization: a caller sees a session only in
/// a channel they are still a member of, and the observer-grant count is
/// computed under the same predicate rather than trusted from the caller.
pub async fn list_work_session_details_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    active_only: bool,
) -> Result<Vec<WorkSessionDetail>, T3Error> {
    let columns = list_columns();
    let sql = format!(
        "SELECT {columns} \
                 FROM work_session ws \
                 JOIN channel c ON c.id = ws.channel_id \
                 JOIN work_host h \
                   ON h.id = ws.host_id \
                  AND h.workspace_id = ws.workspace_id \
                 JOIN membership ms \
                   ON ms.channel_id = ws.channel_id \
                  AND ms.member_id = $2 \
                  AND ms.left_at IS NULL \
                WHERE ws.workspace_id = $1 \
                  AND c.archived_at IS NULL \
                  AND (NOT $3 OR ws.status IN ('running', 'idle')) \
                ORDER BY ws.started_at DESC, ws.id DESC \
                LIMIT 200"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(member_id)
        .bind(active_only)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter().map(decode_detail).collect()
}

/// The workspace has this tool registered **and enabled**
/// (`WorkToolProfileRoutes.requireEnabled` :255-275, called by every spawn).
///
/// A `FOR SHARE` rather than a plain read: the profile must not be disabled
/// between the check and the session insert in the same transaction. The row is
/// seeded for every workspace by `momo_seed_work_tool_profiles`
/// (029:115-158, and on every owner/admin membership insert), so this gate
/// answers "did an admin turn it off", not "was it ever set up".
pub async fn work_tool_is_enabled_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    tool_key: &str,
) -> Result<bool, T3Error> {
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM work_tool_profile \
          WHERE workspace_id = $1 AND tool_key = $2 AND enabled \
          FOR SHARE",
    )
    .bind(workspace_id)
    .bind(tool_key)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// Active membership of the channel a session lives in
/// (`WorkSessionRoutes.requireChannelMember` :2435-2466).
///
/// Wider than `momo_messaging::is_channel_member` on purpose, and the extra
/// predicates are the point: the channel must not be archived and the member
/// must still be `active`/not soft-deleted. A session is a durable, *billable*
/// attachment to a thread, so it is gated on the thread still being alive.
pub async fn is_active_channel_member_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, T3Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM channel c \
           JOIN membership ms \
             ON ms.workspace_id = c.workspace_id \
            AND ms.channel_id = c.id \
            AND ms.member_id = $3 \
            AND ms.left_at IS NULL \
           JOIN member m \
             ON m.id = ms.member_id \
            AND m.workspace_id = c.workspace_id \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          WHERE c.workspace_id = $1 \
            AND c.id = $2 \
            AND c.archived_at IS NULL \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// The successor row of a resume (`WorkSessionRoutes.resume` :1884-1903): same
/// thread, same tool/label, new host, `resumed_from_session_id` set.
///
/// `workstream_id` is deliberately not passed even though Swift passes it: the
/// successor shares the source's `root_message_id`, so
/// `work_session_attach_workstream_trg` (055:161) resolves the *same* workstream
/// from the same thread. Passing it would be a second copy of that rule.
#[allow(clippy::too_many_arguments)]
pub async fn create_resumed_work_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    source: &WorkSessionDetail,
    member_id: Uuid,
    target_host_id: Uuid,
) -> Result<WorkSessionDetail, T3Error> {
    let returning = detail_returning();
    let sql = format!(
        "INSERT INTO work_session \
           (id, workspace_id, channel_id, member_id, host_id, root_message_id, \
            tool, label, status, observation, resumed_from_session_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10) \
         RETURNING {returning}"
    );
    let row = sqlx::query(&sql)
        .bind(session_id)
        .bind(workspace_id)
        .bind(source.channel_id)
        .bind(member_id)
        .bind(target_host_id)
        .bind(source.root_message_id)
        .bind(&source.tool)
        .bind(&source.label)
        .bind(&source.observation)
        .bind(source.id)
        .fetch_one(&mut *conn)
        .await?;
    decode_detail(&row)
}

/// Close the orphaned source of a resume with `end_reason = 'resumed'`
/// (:1916-1934). `Ok(None)` → someone else moved it → 409.
pub async fn mark_work_session_resumed_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<WorkSessionDetail>, T3Error> {
    let returning = detail_returning();
    let sql = format!(
        "UPDATE work_session \
            SET status = 'ended', \
                ended_at = clock_timestamp(), \
                exit_code = NULL, \
                end_reason = 'resumed' \
          WHERE workspace_id = $1 AND id = $2 AND status = 'orphaned' \
        RETURNING {returning}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode_detail).transpose()
}

/// Re-render the session card in place (`UPDATE message SET props`, :576-579).
///
/// The card is the session's user-visible surface and its `props` mirror the
/// session row; leaving them stale would make a re-rendered history show a
/// finished session as still running. This is the **only** `message` write in
/// this crate and it touches exactly the one row the session already owns
/// (`work_session.root_message_id`), never the message body, seq or author.
pub async fn update_session_card_props_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    root_message_id: Uuid,
    props_json: &str,
) -> Result<(), T3Error> {
    sqlx::query("UPDATE message SET props = $3::jsonb WHERE workspace_id = $1 AND id = $2")
        .bind(workspace_id)
        .bind(root_message_id)
        .bind(props_json)
        .execute(&mut *conn)
        .await?;
    Ok(())
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

// ---------------------------------------------------------------------------
// the two wire shapes a work session renders as
//
// These moved here from `momo-server`'s `routes::work_sessions` when goal
// SRV-T1 gave work-session control a **second** caller (the agent's
// `work.session.end` tool, executed by momo-agent-worker after a human
// approval). They are pure and they were private; leaving them private would
// have meant the worker growing its own copy, and two builders for one card is
// how a session ends in the database while the timeline still shows it running.
//
// They stay in `momo-t3` rather than in a shared route helper because the card
// and the lifecycle envelope describe a *work session*, and this crate is what a
// work session is.
// ---------------------------------------------------------------------------

/// The session card's `message.props` (Swift `WorkSessionRoutes.cardProps`).
#[allow(clippy::too_many_arguments)]
pub fn card_props(
    session_id: Uuid,
    tool: &str,
    label: &str,
    status: &str,
    ended_at_ms: Option<i64>,
    exit_code: Option<i32>,
    end_reason: Option<&str>,
    resumed_from_session_id: Option<Uuid>,
) -> serde_json::Value {
    let mut props = serde_json::Map::new();
    props.insert("kind".into(), serde_json::json!("work_session"));
    props.insert(
        "session_id".into(),
        serde_json::json!(session_id.to_string()),
    );
    props.insert("tool".into(), serde_json::json!(tool));
    props.insert("label".into(), serde_json::json!(label));
    props.insert("status".into(), serde_json::json!(status));
    if let Some(ended_at_ms) = ended_at_ms {
        props.insert("ended_at".into(), serde_json::json!(ended_at_ms));
    }
    if let Some(exit_code) = exit_code {
        props.insert("exit_code".into(), serde_json::json!(exit_code));
    }
    if let Some(end_reason) = end_reason {
        props.insert("end_reason".into(), serde_json::json!(end_reason));
    }
    if let Some(source) = resumed_from_session_id {
        props.insert(
            "resumed_from_session_id".into(),
            serde_json::json!(source.to_string()),
        );
    }
    serde_json::Value::Object(props)
}

/// The `work.session.started` / `work.session.ended` broadcast envelope
/// (Swift `lifecyclePayload`, :2115-2156).
///
/// Takes the Centrifugo channel as a string so this crate does not have to
/// depend on `momo-messaging` for `cent_channel` — the caller already knows it.
///
/// Deliberately carries **no** `version`: the card's `message.new` owns this seq
/// and has already advanced the channel version, so a second envelope claiming
/// the same version would make the relay skip one of them.
pub fn lifecycle_payload(
    cent_channel: &str,
    event_type: &str,
    session: &WorkSessionDetail,
    root_message_seq: i64,
) -> serde_json::Value {
    let is_ended = event_type == "work.session.ended";
    let timestamp = if is_ended {
        session.ended_at_ms.unwrap_or(session.started_at_ms)
    } else {
        session.started_at_ms
    };

    let mut payload = serde_json::Map::new();
    payload.insert(
        "session_id".into(),
        serde_json::json!(session.id.to_string()),
    );
    payload.insert(
        "channel_id".into(),
        serde_json::json!(session.channel_id.to_string()),
    );
    payload.insert(
        "root_message_id".into(),
        serde_json::json!(session.root_message_id.to_string()),
    );
    payload.insert(
        "member_id".into(),
        serde_json::json!(session.member_id.to_string()),
    );
    payload.insert(
        "host_id".into(),
        serde_json::json!(session.host_id.to_string()),
    );
    payload.insert("tool".into(), serde_json::json!(session.tool));
    payload.insert("label".into(), serde_json::json!(session.label));
    if is_ended {
        if let Some(ended_at_ms) = session.ended_at_ms {
            payload.insert("ended_at".into(), serde_json::json!(ended_at_ms));
        }
        if let Some(exit_code) = session.exit_code {
            payload.insert("exit_code".into(), serde_json::json!(exit_code));
        }
        if let Some(end_reason) = &session.end_reason {
            payload.insert("end_reason".into(), serde_json::json!(end_reason));
        }
    } else {
        payload.insert(
            "started_at".into(),
            serde_json::json!(session.started_at_ms),
        );
    }
    if let Some(source) = session.resumed_from_session_id {
        payload.insert(
            "resumed_from_session_id".into(),
            serde_json::json!(source.to_string()),
        );
    }

    serde_json::json!({
        "channel": cent_channel,
        "data": {
            "type": event_type,
            "v": 1,
            "ts": timestamp,
            "seq": root_message_seq,
            "payload": serde_json::Value::Object(payload),
        },
        "idempotency_key": format!("{cent_channel}:{event_type}:{}", session.id),
    })
}

/// Swift `toolLifecyclePayload` (`WorkSessionRoutes.swift:2158-2193`) — idle /
/// resumed-to-running envelopes. Distinct from [`lifecycle_payload`]: the
/// discriminator is part of the idempotency key so two transitions of the same
/// session do not collapse onto one outbox row.
pub fn tool_lifecycle_payload(
    cent_channel: &str,
    event_type: &str,
    session: &WorkSessionDetail,
    seq: i64,
    timestamp_ms: i64,
    idempotency_discriminator: &str,
) -> serde_json::Value {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "session_id".into(),
        serde_json::json!(session.id.to_string()),
    );
    payload.insert(
        "channel_id".into(),
        serde_json::json!(session.channel_id.to_string()),
    );
    payload.insert(
        "root_message_id".into(),
        serde_json::json!(session.root_message_id.to_string()),
    );
    payload.insert(
        "member_id".into(),
        serde_json::json!(session.member_id.to_string()),
    );
    payload.insert(
        "host_id".into(),
        serde_json::json!(session.host_id.to_string()),
    );
    payload.insert("status".into(), serde_json::json!(session.status));
    if let Some(exit_code) = session.exit_code {
        payload.insert("exit_code".into(), serde_json::json!(exit_code));
    }
    if event_type == "work.session.idle" {
        payload.insert("idle_at".into(), serde_json::json!(timestamp_ms));
    } else {
        payload.insert("resumed_at".into(), serde_json::json!(timestamp_ms));
    }

    serde_json::json!({
        "channel": cent_channel,
        "data": {
            "type": event_type,
            "v": 1,
            "ts": timestamp_ms,
            "seq": seq,
            "payload": serde_json::Value::Object(payload),
        },
        "idempotency_key": format!(
            "{cent_channel}:{event_type}:{}:{idempotency_discriminator}",
            session.id
        ),
    })
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
