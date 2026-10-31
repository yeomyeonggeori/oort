//! `approval` + `approval_decision` — the human-in-the-loop gate (goal SRV-T1).
//!
//! Ports Swift `ApprovalDecisionRoutes.swift` (the consumer, 1,277 lines) and
//! `AgentWorker/WorkerService.recordApprovalPause` (the producer, :1607-1760).
//!
//! ## Why this module exists at all
//!
//! Before this batch the Rust server had `RunStatus::AwaitingApproval`, two
//! places that *refuse* work when a run is in it
//! (`routes/agent_gateway.rs:276,379`), an `approval` table, an
//! `approval_decision` ledger, and a push notifier that already joins `approval`
//! to build an approval-category notification
//! (`momo_push::judgment` :135-137) — and **not one row could ever exist**,
//! because nothing transitioned a run into that status. The whole axis was a
//! read side with no writer. This module is the writer.
//!
//! ## Ownership, held to the crate's existing line
//!
//! `momo-agent` owns `agent_run` and `usage_ledger` SQL and deliberately owns
//! no `message` and no `outbox` SQL (see the crate docs). Approvals extend that
//! table list to four and change nothing else:
//!
//! * the `approval_request` **message** is `momo_messaging::send_message_in_tx`
//!   (same `channel_seq` bump, same broadcast, invariants #2/#3);
//! * its broadcast row is `momo_outbox::emit_outbox`;
//! * the `resume_approval` **job** is `emit_outbox` too;
//! * the audit row is `momo_db::write_audit`.
//!
//! So every function here takes a `&mut PgConnection` and composes into the
//! caller's transaction: the approval, its message, its broadcast and the run
//! transition commit together or not at all. A half-written approval — a row
//! with no message, or a parked run with no approval — is the one shape that
//! would strand a person, and a single transaction is what makes it
//! unrepresentable.
//!
//! ## The gate an approval must not hold forever
//!
//! `agent.max_concurrent_runs` **defaults to 1** (`001_init.sql:84`) and
//! [`crate::run::live_run_count_in_tx`] counts `awaiting_approval` among the
//! live statuses. So a run parked on a decision nobody makes does not merely
//! linger — it silences that agent completely, for every future run, forever.
//! (A2A's G1 is already immune: it counts only fresh `status='running'` rows and
//! says why at `a2a.rs:343-344`. The HTTP work-run cap is the one that leaks.)
//!
//! Swift only notices expiry **when someone clicks** (`recordExpiredClick`), so
//! an approval nobody ever opens holds the gate indefinitely there. This module
//! closes that:
//!
//! 1. [`NewApproval`] always carries an `expires_at` — [`DEFAULT_TTL_SECONDS`]
//!    when the caller has no better idea. `NULL` is not offered.
//! 2. The same instant is written to `agent_run.deadline_at`, the column
//!    `001_init.sql:284` declared "for timed_out" and which nothing had ever
//!    written.
//! 3. [`expire_overdue_approvals_in_tx`] is a sweep — run by momo-notifier
//!    beside the T3 sweeps — that moves overdue rows to `expired` and their runs
//!    to `timed_out`, **releasing the gate without anyone clicking anything**.
//!
//! One hour is deliberately short. An expired approval is not a lost intent: the
//! person re-asks and the agent re-proposes, costing one round trip. A held gate
//! costs every later run of that agent and shows up as "the agent stopped
//! answering", which is far more expensive to diagnose than to redo.

use chrono::{DateTime, Duration, Utc};
use momo_db::DbError;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::provisioning::ModelSource;

use crate::tools::{ToolCall, ToolGrant};

/// How long a pending approval may hold its agent's concurrency slot.
///
/// See the module docs for why this is an hour and not a day.
pub const DEFAULT_TTL_SECONDS: i64 = 3_600;

/// `approval.payload.resume_model` — Swift `approvalPayload` (:1766-1785).
/// Names the contract the decision route implements: the *same* run is resumed
/// by a *new* `agent_job`, rather than a fresh run inheriting the old one's id.
pub const RESUME_MODEL: &str = "same_run_new_agent_job";

// NOTE: the `outbox.method` this decision enqueues lives in
// `momo_outbox::RESUME_APPROVAL_JOB_METHOD`, not here. This crate deliberately
// does not depend on `momo-outbox` (see the crate docs), and a second copy of
// the string would be a second thing to drift — the claim predicate and the
// producer must agree exactly or the job is enqueued into a lane nothing reads.
// The route layer depends on both crates and is where the two meet.

/// The `status` values `GET …/approvals?status=` accepts (Swift
/// `validatedStatus` :487-497).
pub const LISTABLE_STATUSES: [&str; 5] =
    ["pending", "approved", "rejected", "expired", "cancelled"];

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

/// Everything the producer needs to park a run.
#[derive(Debug, Clone)]
pub struct NewApproval {
    pub run_id: Uuid,
    pub channel_id: Uuid,
    /// The **agent**. `approval.requested_by REFERENCES member(id)` and the
    /// column comment says "the agent" — invariant #5 again: the requester is a
    /// member like any other.
    pub requested_by: Uuid,
    pub action_type: String,
    pub payload: Value,
    pub expires_at: DateTime<Utc>,
}

/// The row the decision path locks, joined with the run facts the resume
/// payload needs (Swift `LockedApproval` :367-405).
#[derive(Debug, Clone)]
pub struct LockedApproval {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub channel_id: Uuid,
    pub requested_by: Uuid,
    pub request_message_id: Option<Uuid>,
    pub action_type: String,
    pub payload: Value,
    pub status: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub agent_model: String,
    /// `agent.model_source` (#3147).
    pub agent_model_source: ModelSource,
    pub run_input: Value,
    pub step_count: i32,
    pub max_steps: i32,
    pub depth: i32,
}

/// One row of the approval inbox (Swift `fetchApprovals` :503-589).
#[derive(Debug, Clone)]
pub struct ApprovalListRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub channel_id: Uuid,
    pub request_message_id: Option<Uuid>,
    pub requested_by: Uuid,
    pub action_type: String,
    pub payload: Value,
    pub status: String,
    pub decided_by: Option<Uuid>,
    pub decided_at: Option<DateTime<Utc>>,
    pub decision_reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    /// ADR-0186 v6 R-f, where the approval lives: its channel is a DM.
    pub is_direct: bool,
    /// ADR-0186 v6 R-f, where the approval lives: the thread its card sits in
    /// (the card message's `root_id`), when it sits in one.
    pub root_id: Option<Uuid>,
    /// ADR-0186 v6 R-f, the card's one-line outcome. Only a settled approval has
    /// one (see [`CARD_OUTCOME_LINE_SQL`]); a pending one is still asking.
    pub result_line: Option<String>,
}

/// A replayed decision, found by `client_decision_id` (Swift `ExistingDecision`
/// :407-439).
#[derive(Debug, Clone)]
pub struct ExistingDecision {
    pub approval_id: Uuid,
    pub decided_by: Uuid,
    pub approve: bool,
    pub receipt: Value,
}

/// A pending approval the sweep found past its deadline.
#[derive(Debug, Clone)]
pub struct OverdueApproval {
    pub id: Uuid,
    pub run_id: Uuid,
    pub channel_id: Uuid,
    pub requested_by: Uuid,
    pub payload: Value,
}

// ---------------------------------------------------------------------------
// producer
// ---------------------------------------------------------------------------

/// Insert the pending approval. The caller writes the `approval_request`
/// message next and calls [`attach_request_message_in_tx`], in the same
/// transaction.
///
/// `expires_at` is not optional — see the module docs.
pub async fn create_pending_approval_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewApproval,
) -> Result<Uuid, DbError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO approval \
           (workspace_id, run_id, channel_id, requested_by, action_type, payload, \
            status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(input.run_id)
    .bind(input.channel_id)
    .bind(input.requested_by)
    .bind(&input.action_type)
    .bind(&input.payload)
    .bind(input.expires_at)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

/// How many `workspace_action` approvals this agent has `pending` and not yet
/// expired — after taking a row lock on the agent's `member` row.
///
/// The lock is the point (ADR-0186 증보 V1-e). A bare `count(*)` followed by an
/// `INSERT` would let several runs of one agent each read "2" and each insert a
/// third, so the ceiling would hold on a quiet system and fail under exactly the
/// concurrent re-calling it exists to stop. `FOR NO KEY UPDATE` serialises
/// proposals of one agent without blocking the `FOR KEY SHARE` a message or
/// approval insert takes on the same `member` row through its foreign key.
///
/// An expired-but-unswept card is not counted: the sweep may lag, and a card
/// nobody can still decide must not lock an agent out of proposing.
///
/// Neither is an in-place 「이 채널에서 쓰기」 card (ADR-0162 증보 5 G2,
/// `payload.origin = "server_in_place"`): the server raised it when a person
/// called the agent, it is not the agent's proposal, and it has its own
/// per-connection ceiling (`in_place_grant`).
pub async fn lock_agent_and_count_pending_workspace_actions_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<i64, DbError> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM member WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(
        count_pending_workspace_actions_in_tx(conn, workspace_id, agent_member_id)
            .await?
            .all,
    )
}

/// What an agent has waiting, as the ceiling counts it (see
/// [`count_pending_workspace_actions_in_tx`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingWorkspaceActions {
    /// Every pending, unexpired `workspace_action` of the agent except server-owned
    /// in-place grant and DM consent cards —
    /// the number [`crate::actions::MAX_PENDING_WORKSPACE_ACTIONS`] caps.
    pub all: i64,
    /// Of those, the ones the agent raised **unasked** (`payload.origin = agent_initiated`,
    /// ADR-0186 증보 v5 U-d: at most [`crate::initiative::MAX_PENDING_INITIATIVE`]).
    pub unasked: i64,
}

/// The **one definition** of "pending" for an agent's ceiling — read with no lock. A person's
/// proposal ([`lock_agent_and_count_pending_workspace_actions_in_tx`], which locks first) and an
/// unasked card (`routes::agent_initiative`, behind its advisory lock) count the same rows the
/// same way, so neither can drift from the other: an unasked card is a `workspace_action` of the
/// agent like any other and takes its place among the three.
pub async fn count_pending_workspace_actions_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<PendingWorkspaceActions, DbError> {
    let (all, unasked): (i64, i64) = sqlx::query_as(
        "SELECT count(*), \
                count(*) FILTER (WHERE payload->>'origin' = 'agent_initiated') \
           FROM approval \
          WHERE workspace_id = $1 AND requested_by = $2 \
            AND action_type = 'workspace_action' AND status = 'pending' \
            AND (expires_at IS NULL OR expires_at > now()) \
            AND payload->>'origin' IS DISTINCT FROM 'server_in_place' \
            AND payload->>'origin' IS DISTINCT FROM 'dm_agent_admission'",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(PendingWorkspaceActions { all, unasked })
}

/// Whether a `workspace_action` of `action_id` is already `pending` against
/// `target_member_id` (the id pinned in `payload.action.pins.target`) — after
/// taking a row lock on the target's `member` row (ADR-0186 증보 V4-M-9). A second
/// rename of the same agent while one waits is a card spam / name-flip race, so
/// the second proposal is refused; the lock is what makes two simultaneous
/// proposals unable to both see "none".
pub async fn lock_target_and_find_pending_action_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    action_id: &str,
    target_member_id: Uuid,
) -> Result<bool, DbError> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM member WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE",
    )
    .bind(workspace_id)
    .bind(target_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM approval \
          WHERE workspace_id = $1 AND action_type = 'workspace_action' \
            AND status = 'pending' AND (expires_at IS NULL OR expires_at > now()) \
            AND payload #>> '{action,id}' = $2 \
            AND payload #>> '{action,pins,target}' = $3)",
    )
    .bind(workspace_id)
    .bind(action_id)
    .bind(target_member_id.to_string())
    .fetch_one(&mut *conn)
    .await?)
}

/// Join the approval to the message that renders it (Swift :1673-1680).
pub async fn attach_request_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
    request_message_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE approval SET request_message_id = $3 \
          WHERE id = $2 AND workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(approval_id)
    .bind(request_message_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/// Swift `isActiveHumanMember` (:604-622).
///
/// This single predicate is also the answer to "can an agent approve its own
/// request?" — **no**, structurally. `approval.requested_by` is the agent, and
/// a decision requires `member.kind = 'human'`, so no agent can decide any
/// approval, its own least of all. There is no separate self-approval rule to
/// port because Swift needs none.
pub async fn is_active_human_member_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM member \
          WHERE id = $1 AND kind = 'human' AND status = 'active' AND deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// Swift `hasActiveChannelMembership` (:624-642) — the decider must be in the
/// room the approval belongs to.
pub async fn is_active_channel_member_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM membership \
          WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL \
          LIMIT 1",
    )
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// An approval's kind, status and payload **without locking it** — for the read-only
/// avatar-preview route. `None` when the id does not exist in the workspace.
pub async fn read_approval_payload_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
) -> Result<Option<(String, String, Value)>, DbError> {
    let row = sqlx::query(
        "SELECT action_type, status::text AS status_label, payload FROM approval \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(approval_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some((
        row.try_get("action_type").map_err(DbError::from)?,
        row.try_get("status_label").map_err(DbError::from)?,
        row.try_get("payload").map_err(DbError::from)?,
    )))
}

/// Swift `lockApproval` (:441-485): `FOR UPDATE OF a`, joined to the run and
/// the agent so one round trip carries everything the decision needs.
///
/// `workspace_id` is bound as a predicate as well as being the transaction's
/// GUC. RLS FORCE already scopes it; binding it again is defence in depth of
/// the kind `routes::shared::workspace_scope` documents — a cross-tenant
/// approval id must be a 404, not a lock on someone else's row.
pub async fn lock_approval_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
) -> Result<Option<LockedApproval>, DbError> {
    let row = sqlx::query(
        "SELECT a.id, a.workspace_id, a.run_id, a.channel_id, a.requested_by, \
                a.request_message_id, a.action_type, a.payload, a.status::text AS status_label, \
                a.expires_at, ag.model AS agent_model, ag.model_source AS agent_model_source, r.input AS run_input, \
                r.step_count, r.max_steps, r.depth \
           FROM approval a \
           JOIN agent_run r ON r.id = a.run_id \
           JOIN agent ag ON ag.member_id = r.agent_member_id AND ag.workspace_id = a.workspace_id \
          WHERE a.id = $2 AND a.workspace_id = $1 \
          FOR UPDATE OF a",
    )
    .bind(workspace_id)
    .bind(approval_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };
    Ok(Some(LockedApproval {
        id: row.try_get("id").map_err(DbError::from)?,
        workspace_id: row.try_get("workspace_id").map_err(DbError::from)?,
        run_id: row.try_get("run_id").map_err(DbError::from)?,
        channel_id: row.try_get("channel_id").map_err(DbError::from)?,
        requested_by: row.try_get("requested_by").map_err(DbError::from)?,
        request_message_id: row.try_get("request_message_id").map_err(DbError::from)?,
        action_type: row.try_get("action_type").map_err(DbError::from)?,
        payload: row.try_get("payload").map_err(DbError::from)?,
        status: row.try_get("status_label").map_err(DbError::from)?,
        expires_at: row.try_get("expires_at").map_err(DbError::from)?,
        agent_model: row.try_get("agent_model").map_err(DbError::from)?,
        agent_model_source: ModelSource::from_column(
            &row.try_get::<String, _>("agent_model_source")
                .map_err(DbError::from)?,
        ),
        run_input: row.try_get("run_input").map_err(DbError::from)?,
        step_count: row.try_get("step_count").map_err(DbError::from)?,
        max_steps: row.try_get("max_steps").map_err(DbError::from)?,
        depth: row.try_get("depth").map_err(DbError::from)?,
    }))
}

/// Who settled an approval and when, as the ledger recorded it (#3771).
///
/// The 409 a late click receives must tell the truth about the **original**
/// decision. It used to stamp the receipt with the second presser and the
/// second press time, so a card approved at 22:52 rendered 「승인 · kwak ·
/// 22:54」 (prod, 2026-10-13). `decided_by` is `NULL` for a system settlement
/// (expiry, cancellation), which is preserved rather than invented.
pub async fn decision_stamp_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
) -> Result<Option<(Option<Uuid>, Option<DateTime<Utc>>)>, DbError> {
    let row = sqlx::query(
        "SELECT decided_by, decided_at FROM approval WHERE id = $1 AND workspace_id = $2",
    )
    .bind(approval_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some((
        row.try_get("decided_by").map_err(DbError::from)?,
        row.try_get("decided_at").map_err(DbError::from)?,
    )))
}

/// Which approvals a read returns, by status (`GET …/approvals?status=`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalStatusFilter {
    /// One status: `pending`, `approved`, `rejected`, `expired` or `cancelled`.
    Only(String),
    /// Every status. ADR-0186 v6 R-f: the inbox 「승인」 칸 reads the five in one stream.
    All,
}

impl ApprovalStatusFilter {
    /// Does the read order by **when the approval last moved** (and so resume from a
    /// [`ApprovalCursor`])? Everything but `pending`, which keeps its deadline order:
    /// the to-decide queue is read soonest-expiry first, and it is bounded by the
    /// `limit` rather than paged.
    pub fn is_time_ordered(&self) -> bool {
        !matches!(self, ApprovalStatusFilter::Only(status) if status == "pending")
    }
}

/// Whose approvals a read returns (`GET …/approvals?scope=`). Both are inside the
/// channels the caller is an active member of: the scope narrows, it never widens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalScope {
    /// Every approval in those channels (the long-standing read; an in-place channel
    /// grant only for a workspace owner/admin).
    Team,
    /// Only what the caller **decided**, **requested** (the author of the run's trigger
    /// message, or the actor of a work run's `agent.work.queued` row: the same two
    /// sources the "running now" read's `scope=mine` uses) or whose **agent they own**
    /// (`agent.owner_human_id`). ADR-0186 v6 R-f, ADR-0199 D5's recipient isolation.
    Mine,
}

/// A keyset position `(when the approval last moved, id)` — the id breaks ties
/// between approvals that moved in the same microsecond. Carried to clients as an
/// opaque token (`routes::approvals`). A position, not a capability: every read that
/// takes one is scoped to the authenticated member, so a forged cursor can only move
/// that member's own page window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApprovalCursor {
    pub at: DateTime<Utc>,
    pub id: Uuid,
}

impl ApprovalCursor {
    /// The position of `row` in the time order: its decision (or expiry or cancellation)
    /// time, and for a pending approval the time it was asked.
    pub fn of(row: &ApprovalListRow) -> ApprovalCursor {
        ApprovalCursor {
            at: row.decided_at.unwrap_or(row.created_at),
            id: row.id,
        }
    }
}

/// One page of the approval inbox.
#[derive(Debug, Clone)]
pub struct ApprovalPage {
    pub rows: Vec<ApprovalListRow>,
    /// `Some` only when a further page exists **and** the read is time-ordered.
    pub next: Option<ApprovalCursor>,
}

/// The card's one-line outcome for a **settled** approval (ADR-0186 v6 R-b/R-f): the
/// explicit `props.result.line`, else the card `body` when the settlement patched the
/// card (a patched card carries a terminal `code`, and its body is then the decision
/// sentence: R-f 「`body`는 `result.line`(없으면 결정 문장)」).
///
/// A card settled before that patch existed has neither, and its body is still the
/// question it asked. A question is not an outcome, so such a card yields nothing
/// instead of a stale 「…해도 될까요?」 beside an 「승인」 chip. Expects the card as `m`.
const CARD_OUTCOME_LINE_SQL: &str = "COALESCE(NULLIF(btrim(m.props #>> '{result,line}'), ''), \
     CASE WHEN jsonb_exists(m.props, 'code') THEN NULLIF(btrim(m.body), '') END)";

/// The longest card sentence a read passes on. The sentences are server-written and
/// short; one that is not is no sentence, so it is dropped rather than cut in half.
pub const CARD_LINE_MAX_CHARS: usize = 300;

/// Trim a card sentence and keep it only if it is a sentence a read may pass on.
pub fn public_card_line(line: Option<String>) -> Option<String> {
    line.map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && line.chars().count() <= CARD_LINE_MAX_CHARS)
}

/// The approval inbox (Swift `fetchApprovals` :503-589), legacy shape: one status,
/// the team scope, no cursor. See [`list_approval_page_in_tx`] for the full read.
pub async fn list_approvals_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    status: &str,
    limit: i64,
) -> Result<Vec<ApprovalListRow>, DbError> {
    Ok(list_approval_page_in_tx(
        conn,
        workspace_id,
        member_id,
        &ApprovalStatusFilter::Only(status.to_string()),
        ApprovalScope::Team,
        None,
        limit,
    )
    .await?
    .rows)
}

/// The approval inbox, read for ADR-0186 v6 R-f.
///
/// The `JOIN membership` is the authorization, not a filter applied afterwards:
/// a person sees exactly the approvals raised in rooms they are still in. A
/// `WHERE` on the workspace alone would have shown every approval in the tenant.
/// Leaving a room hides its approvals at the next read, including the ones the
/// person decided (ADR-0199 D4: visibility is judged again at read time).
///
/// An in-place channel-grant card (ADR-0162 증보 5 G2) is listed under
/// [`ApprovalScope::Team`] only to a workspace owner/admin — the people who can decide
/// it. Everyone else in the room still sees the card in the timeline, without buttons;
/// it is not put in their 「나에게 필요한 일」. Under [`ApprovalScope::Mine`] it is
/// listed like any other approval the person decided, requested or owns the agent of.
///
/// ## Order
///
/// * `pending` — soonest deadline first, then newest asked (the to-decide queue).
/// * anything else — newest first by when the approval last moved
///   (`COALESCE(decided_at, created_at)`), then by id; resumable with `after`. This is
///   a change for a single settled status (`approved`, `rejected`, …), which used to
///   come back in deadline order and so, under a `limit`, returned the *oldest* rows.
///
/// `after` is ignored for a `pending` read (the caller refuses it before asking).
pub async fn list_approval_page_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    status: &ApprovalStatusFilter,
    scope: ApprovalScope,
    after: Option<ApprovalCursor>,
    limit: i64,
) -> Result<ApprovalPage, DbError> {
    let time_ordered = status.is_time_ordered();
    let order = if time_ordered {
        "ORDER BY COALESCE(a.decided_at, a.created_at) DESC, a.id DESC"
    } else {
        "ORDER BY a.expires_at NULLS LAST, a.created_at DESC, a.id DESC"
    };
    let after = if time_ordered { after } else { None };
    let sql = format!(
        "SELECT a.id, a.workspace_id, a.run_id, a.channel_id, a.request_message_id, \
                a.requested_by, a.action_type, a.payload, a.status::text AS status_label, \
                a.decided_by, a.decided_at, a.decision_reason, a.expires_at, a.created_at, \
                (c.kind = 'dm') AS is_direct, m.root_id AS card_root_id, \
                CASE WHEN a.status <> 'pending' THEN {CARD_OUTCOME_LINE_SQL} END AS result_line \
           FROM approval a \
           JOIN membership ms \
             ON ms.workspace_id = a.workspace_id \
            AND ms.channel_id = a.channel_id \
            AND ms.member_id = $2 \
            AND ms.left_at IS NULL \
           JOIN channel c ON c.workspace_id = a.workspace_id AND c.id = a.channel_id \
           LEFT JOIN message m \
             ON m.workspace_id = a.workspace_id AND m.id = a.request_message_id \
            AND m.type = 'approval_request' AND m.deleted_at IS NULL \
          WHERE a.workspace_id = $1 \
            AND ($3::text IS NULL OR a.status = $3::approval_status) \
            AND (($4::boolean = false \
                  AND (a.payload->>'origin' IS DISTINCT FROM 'server_in_place' \
                       OR EXISTS (SELECT 1 FROM workspace_membership wm \
                                   WHERE wm.workspace_id = a.workspace_id \
                                     AND wm.member_id = $2 \
                                     AND wm.role IN ('owner', 'admin')))) \
                 OR ($4::boolean = true \
                     AND (a.decided_by = $2 \
                          OR EXISTS (SELECT 1 FROM agent_run r \
                                      WHERE r.workspace_id = a.workspace_id AND r.id = a.run_id \
                                        AND (EXISTS (SELECT 1 FROM message tm \
                                                      WHERE tm.workspace_id = r.workspace_id \
                                                        AND tm.id = r.trigger_message_id \
                                                        AND tm.author_member_id = $2) \
                                             OR EXISTS (SELECT 1 FROM audit_log al \
                                                         WHERE al.workspace_id = r.workspace_id \
                                                           AND al.run_id = r.id \
                                                           AND al.action = 'agent.work.queued' \
                                                           AND al.actor_member_id = $2))) \
                          OR EXISTS (SELECT 1 FROM agent ag \
                                      WHERE ag.workspace_id = a.workspace_id \
                                        AND ag.member_id = a.requested_by \
                                        AND ag.owner_human_id = $2)))) \
            AND ($5::timestamptz IS NULL \
                 OR (COALESCE(a.decided_at, a.created_at), a.id) < ($5, $6)) \
          {order} \
          LIMIT $7"
    );
    // A time-ordered page reads one row more than it returns: that row is the only
    // way to know a further page exists without a second query that could disagree.
    let fetch = if time_ordered { limit + 1 } else { limit };
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(member_id)
        .bind(match status {
            ApprovalStatusFilter::Only(status) => Some(status.as_str()),
            ApprovalStatusFilter::All => None,
        })
        .bind(matches!(scope, ApprovalScope::Mine))
        .bind(after.map(|cursor| cursor.at))
        .bind(after.map(|cursor| cursor.id).unwrap_or_else(Uuid::nil))
        .bind(fetch)
        .fetch_all(&mut *conn)
        .await?;

    let mut approvals = rows
        .iter()
        .map(|row| {
            Ok(ApprovalListRow {
                id: row.try_get("id")?,
                workspace_id: row.try_get("workspace_id")?,
                run_id: row.try_get("run_id")?,
                channel_id: row.try_get("channel_id")?,
                request_message_id: row.try_get("request_message_id")?,
                requested_by: row.try_get("requested_by")?,
                action_type: row.try_get("action_type")?,
                payload: row.try_get("payload")?,
                status: row.try_get("status_label")?,
                decided_by: row.try_get("decided_by")?,
                decided_at: row.try_get("decided_at")?,
                decision_reason: row.try_get("decision_reason")?,
                expires_at: row.try_get("expires_at")?,
                created_at: row.try_get("created_at")?,
                is_direct: row.try_get("is_direct")?,
                root_id: row.try_get("card_root_id")?,
                result_line: public_card_line(row.try_get("result_line")?),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)?;

    let next = if time_ordered && approvals.len() as i64 > limit {
        approvals.truncate(limit as usize);
        approvals.last().map(ApprovalCursor::of)
    } else {
        None
    };
    Ok(ApprovalPage {
        rows: approvals,
        next,
    })
}

/// What the run progress read says about the approval a run is waiting on, or last
/// asked (ADR-0186 v6 R-f `AgentRunProgress.bundle`). The stored facts only: the
/// route layer judges them for the viewer (`canDecide`, the status as of now).
#[derive(Debug, Clone)]
pub struct RunApprovalFacts {
    pub run_id: Uuid,
    pub approval_id: Uuid,
    pub channel_id: Uuid,
    /// The stored status, not the one the approval reads as at `now`
    /// ([`effective_status`]).
    pub status: String,
    pub action_type: String,
    pub payload: Value,
    pub expires_at: Option<DateTime<Utc>>,
    /// The card's one sentence: the question while pending, the outcome once settled.
    pub line: Option<String>,
}

/// One approval per run, for every run in `run_ids`: the one the run is parked on
/// (the newest `pending`), else the newest of any status. A run with no approval has
/// no entry. Rows are not filtered by who is asking: **the caller must drop the ones
/// in channels the viewer cannot see** (`visible_channels_in_tx`) before it says
/// anything about them.
pub async fn run_approval_facts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_ids: &[Uuid],
) -> Result<Vec<RunApprovalFacts>, DbError> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT DISTINCT ON (a.run_id) \
                a.run_id, a.id, a.channel_id, a.status::text AS status_label, a.action_type, \
                a.payload, a.expires_at, \
                CASE WHEN a.status = 'pending' THEN NULLIF(btrim(m.body), '') \
                     ELSE {CARD_OUTCOME_LINE_SQL} END AS line \
           FROM approval a \
           LEFT JOIN message m \
             ON m.workspace_id = a.workspace_id AND m.id = a.request_message_id \
            AND m.type = 'approval_request' AND m.deleted_at IS NULL \
          WHERE a.workspace_id = $1 AND a.run_id = ANY($2) \
          ORDER BY a.run_id, (a.status = 'pending') DESC, a.created_at DESC, a.id DESC"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(run_ids)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| {
            Ok(RunApprovalFacts {
                run_id: row.try_get("run_id")?,
                approval_id: row.try_get("id")?,
                channel_id: row.try_get("channel_id")?,
                status: row.try_get("status_label")?,
                action_type: row.try_get("action_type")?,
                payload: row.try_get("payload")?,
                expires_at: row.try_get("expires_at")?,
                line: public_card_line(row.try_get("line")?),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Swift `existingDecision` (:414-439) — the idempotency read, `FOR UPDATE` so
/// two replays of the same `client_decision_id` serialize instead of both
/// deciding.
pub async fn existing_decision_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    client_decision_id: Uuid,
) -> Result<Option<ExistingDecision>, DbError> {
    let row = sqlx::query(
        "SELECT approval_id, decided_by, approve, receipt \
           FROM approval_decision \
          WHERE workspace_id = $1 AND client_decision_id = $2 \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(client_decision_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };
    Ok(Some(ExistingDecision {
        approval_id: row.try_get("approval_id").map_err(DbError::from)?,
        decided_by: row.try_get("decided_by").map_err(DbError::from)?,
        approve: row.try_get("approve").map_err(DbError::from)?,
        receipt: row.try_get("receipt").map_err(DbError::from)?,
    }))
}

// ---------------------------------------------------------------------------
// decision writes
// ---------------------------------------------------------------------------

/// Swift's decision `UPDATE` (:240-250).
pub async fn mark_approval_decided_in_tx(
    conn: &mut PgConnection,
    approval_id: Uuid,
    status: &str,
    decided_by: Uuid,
    decided_at: DateTime<Utc>,
    reason: Option<&str>,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE approval \
            SET status = $2::approval_status, decided_by = $3, decided_at = $4, \
                decision_reason = $5 \
          WHERE id = $1 AND status = 'pending'",
    )
    .bind(approval_id)
    .bind(status)
    .bind(decided_by)
    .bind(decided_at)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Record the claim grant on a just-decided approval (ADR-0186 증보 v3 V3-4). Called
/// inside the decision transaction, under the approval row lock the decision already
/// holds; the grant carries ids and a deadline, never a value.
pub async fn grant_secret_claim_in_tx(
    conn: &mut PgConnection,
    approval_id: Uuid,
    grant: &Value,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE approval \
            SET payload = jsonb_set(payload, '{secretClaim}', $2::jsonb, true) \
          WHERE id = $1",
    )
    .bind(approval_id)
    .bind(grant)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Stamp the grant as spent. The caller holds the approval row `FOR UPDATE`
/// ([`lock_approval_in_tx`]) and has just judged the grant `Open`; the `claimedAtMs`
/// guard makes a second stamp affect no row even if that were ever wrong.
pub async fn stamp_secret_claimed_in_tx(
    conn: &mut PgConnection,
    approval_id: Uuid,
    claimed_at_ms: i64,
) -> Result<bool, DbError> {
    let stamped = sqlx::query(
        "UPDATE approval \
            SET payload = jsonb_set(payload, '{secretClaim,claimedAtMs}', to_jsonb($2::bigint), true) \
          WHERE id = $1 AND payload #> '{secretClaim,claimedAtMs}' IS NULL",
    )
    .bind(approval_id)
    .bind(claimed_at_ms)
    .execute(&mut *conn)
    .await?;
    Ok(stamped.rows_affected() == 1)
}

/// Swift `recordExpiredClick`'s approval half (:920-929).
///
/// `decided_by` stays NULL: `approval_decided_ck` allows a decider only for
/// `approved`/`rejected`, and the honest record of an expiry is that **nobody**
/// decided it.
pub async fn mark_approval_expired_in_tx(
    conn: &mut PgConnection,
    approval_id: Uuid,
    decided_at: DateTime<Utc>,
    reason: &str,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE approval \
            SET status = 'expired', decided_at = $2, decision_reason = $3 \
          WHERE id = $1 AND status = 'pending'",
    )
    .bind(approval_id)
    .bind(decided_at)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// The reason a human stop writes onto the approvals it retires
/// (`AgentRunRoutes.swift:517`).
pub const RUN_CANCELLED_DECISION_REASON: &str = "agent run cancelled by human";

/// Retire every approval still waiting on a run a human just stopped — Swift's
/// cancel `UPDATE approval` (`AgentRunRoutes.swift:513-519`).
///
/// Without it a stopped run leaves its approval card `pending`, so the inbox
/// keeps asking a person to decide something that can no longer happen — and an
/// 승인 tap would then try to resume a cancelled run. (That path's
/// `status = 'awaiting_approval'` guard in
/// [`crate::run::requeue_run_from_approval_in_tx`] already refuses, so this is
/// the *second* lock rather than the only one: the first makes the inbox honest,
/// the second makes it safe.)
///
/// `decided_by` stays NULL for the same reason it does on an expiry: nobody
/// decided this approval, the run it belonged to went away. `approval_decided_ck`
/// permits a decider only for `approved`/`rejected`, so naming one here would be
/// refused by the database anyway.
///
/// Returns the approvals actually retired, still locked, so the caller settles
/// their cards and broadcasts in this same transaction. An empty list is ordinary.
pub async fn cancel_pending_approvals_for_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    decided_at: DateTime<Utc>,
) -> Result<Vec<LockedApproval>, DbError> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM approval WHERE workspace_id = $1 AND run_id = $2 \
         AND status = 'pending' ORDER BY id FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut cancelled = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(approval) = lock_approval_in_tx(conn, workspace_id, id).await? else {
            continue;
        };
        let result = sqlx::query(
            "UPDATE approval SET status = 'cancelled', decided_at = $3, decision_reason = $4 \
             WHERE workspace_id = $1 AND id = $2 AND status = 'pending'",
        )
        .bind(workspace_id)
        .bind(id)
        .bind(decided_at)
        .bind(RUN_CANCELLED_DECISION_REASON)
        .execute(&mut *conn)
        .await?;
        if result.rows_affected() == 1 {
            // An `expression.create` card's candidate pictures go with the run (ADR-0186 v8
            // X8-2: reject, expire, cancel and the TTL sweep all reclaim the bytes).
            if approval
                .payload
                .pointer("/action/id")
                .and_then(Value::as_str)
                == Some(crate::actions::ACTION_EXPRESSION_CREATE)
            {
                momo_expressions::action::reclaim_in_tx(conn, workspace_id, id)
                    .await
                    .map_err(|error| match error {
                        momo_expressions::Error::Db(error) => error,
                        other => DbError::Sqlx(sqlx::Error::Protocol(other.to_string())),
                    })?;
            }
            cancelled.push(approval);
        }
    }
    Ok(cancelled)
}

/// Close a card that never had anything to decide: the hosted expression door's **failure card**
/// (ADR-0218 G3.8, #4820 C2b 2부). The approval row is born `pending` in the same transaction (the
/// card is an approval-shaped message, so it needs a real `approval_id`) and is ended here as
/// `cancelled` with no decider — `approval_decided_ck` allows a decider only for
/// `approved`/`rejected`, exactly as for [`cancel_pending_approvals_for_run_in_tx`], whose shape
/// this follows. `reason` is the card's closed code (or, for the door left shut by the operator,
/// the word saying so); it is the value the card's `props.decision_reason` carries too.
///
/// Returns whether the row was still `pending` and is now closed. The row has no drafts, so there
/// is nothing to reclaim.
pub async fn close_failed_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
    decided_at: DateTime<Utc>,
    reason: &str,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE approval SET status = 'cancelled', decided_at = $3, decision_reason = $4 \
          WHERE workspace_id = $1 AND id = $2 AND status = 'pending'",
    )
    .bind(workspace_id)
    .bind(approval_id)
    .bind(decided_at)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// The idempotency ledger row (Swift :277-288).
///
/// `UNIQUE (workspace_id, client_decision_id)` (`004_approval_decision.sql:23`)
/// is what makes a double-tap on a phone safe: the second insert cannot land, so
/// the read above answers it with the first one's receipt.
#[allow(clippy::too_many_arguments)]
pub async fn record_decision_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
    client_decision_id: Uuid,
    decided_by: Uuid,
    approve: bool,
    status: &str,
    reason: Option<&str>,
    receipt: &Value,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO approval_decision \
           (workspace_id, approval_id, client_decision_id, decided_by, approve, \
            status, reason, receipt) \
         VALUES ($1, $2, $3, $4, $5, $6::approval_status, $7, $8)",
    )
    .bind(workspace_id)
    .bind(approval_id)
    .bind(client_decision_id)
    .bind(decided_by)
    .bind(approve)
    .bind(status)
    .bind(reason)
    .bind(receipt)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// the sweep — the half Swift does not have
// ---------------------------------------------------------------------------

/// Pending approvals past their deadline, oldest first.
///
/// `FOR UPDATE OF a SKIP LOCKED` so two notifier replicas divide the work
/// instead of colliding, matching how every other claim in this workspace
/// behaves.
pub async fn overdue_approvals_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    limit: i64,
) -> Result<Vec<OverdueApproval>, DbError> {
    let rows = sqlx::query(
        "SELECT a.id, a.run_id, a.channel_id, a.requested_by, a.payload \
           FROM approval a \
          WHERE a.workspace_id = $1 \
            AND a.status = 'pending' \
            AND a.expires_at IS NOT NULL \
            AND a.expires_at <= now() \
          ORDER BY a.expires_at \
          LIMIT $2 \
          FOR UPDATE OF a SKIP LOCKED",
    )
    .bind(workspace_id)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;

    rows.iter()
        .map(|row| {
            Ok(OverdueApproval {
                id: row.try_get("id")?,
                run_id: row.try_get("run_id")?,
                channel_id: row.try_get("channel_id")?,
                requested_by: row.try_get("requested_by")?,
                payload: row.try_get("payload")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Every workspace that currently has an overdue pending approval.
///
/// The sweep needs this because `app.workspace_id` is bound **per
/// transaction** (invariant #6): there is no cross-tenant scan, so the notifier
/// asks which tenants need visiting and then opens one tenant transaction each.
/// Run with the admin GUC, exactly like the T3 sweep's candidate query.
pub async fn workspaces_with_overdue_approvals(
    conn: &mut PgConnection,
    limit: i64,
) -> Result<Vec<Uuid>, DbError> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT workspace_id \
           FROM approval \
          WHERE status = 'pending' \
            AND expires_at IS NOT NULL \
            AND expires_at <= now() \
          LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// pure payload builders
// ---------------------------------------------------------------------------

/// `approval.payload` — Swift `approvalPayload` (:1766-1785).
///
/// `arguments` is stored as the **string** the provider sent, byte for byte,
/// because that is what the model must be shown again on resume; a re-serialised
/// object would change key order and, for a model, change the input.
///
/// ## `execution` — what the decision is *about*, beyond yes/no (#1114)
///
/// Most approvals answer consent. ADR-0125 D6-A's spawn card answers **where**
/// as well, so a spawn call carries an `execution` object holding the host
/// candidates and the default. It is a separate key rather than something merged
/// into `tool_call` for the reason the paragraph above gives: `tool_call` is the
/// model's utterance, preserved byte for byte, and the candidates are the
/// server's answer to a question the model did not ask.
///
/// `None` for every other tool, so the key is simply absent — a client that
/// never saw one is unaffected.
pub fn approval_payload(
    run_id: Uuid,
    action_type: &str,
    call: &ToolCall,
    raw_arguments: &str,
    tool_grant: Option<&Value>,
    approval_reason: &str,
    execution: Option<&Value>,
) -> Value {
    let mut tool_call = Map::new();
    tool_call.insert("call_id".into(), json!(call.call_id));
    tool_call.insert("name".into(), json!(call.name));
    tool_call.insert("arguments".into(), json!(raw_arguments));
    tool_call.insert("arguments_json".into(), call.arguments.clone());
    if let Some(grant) = tool_grant {
        tool_call.insert("tool_grant".into(), grant.clone());
    }

    let mut payload = Map::new();
    payload.insert("run_id".into(), json!(run_id.to_string()));
    payload.insert("action_type".into(), json!(action_type));
    payload.insert("tool_call".into(), Value::Object(tool_call));
    payload.insert("approval_reason".into(), json!(approval_reason));
    payload.insert("resume_model".into(), json!(RESUME_MODEL));
    if let Some(execution) = execution {
        payload.insert("execution".into(), execution.clone());
    }
    Value::Object(payload)
}

/// The `execution.host_candidates` of a spawn approval, or an empty slice's
/// worth of nothing.
///
/// Read by the decision route to judge a human's host choice against the very
/// list the card offered — the picker and the gate must agree, and the only way
/// to guarantee that is for the gate to read the picker's own answer rather than
/// recomputing one.
pub fn selectable_host_ids(payload: &Value) -> Vec<Uuid> {
    payload
        .get("execution")
        .and_then(|execution| execution.get("host_candidates"))
        .and_then(Value::as_array)
        .map(|candidates| {
            candidates
                .iter()
                .filter(|candidate| {
                    candidate
                        .get("selectable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .filter_map(|candidate| {
                    candidate
                        .get("host_id")
                        .and_then(Value::as_str)
                        .and_then(|raw| Uuid::parse_str(raw).ok())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Does this approval ask a human to choose a host, not just to consent?
pub fn offers_host_choice(payload: &Value) -> bool {
    payload
        .get("execution")
        .and_then(|execution| execution.get("host_candidates"))
        .is_some()
}

/// The host the card pre-selected (`execution.default_host_id`).
pub fn default_execution_host(payload: &Value) -> Option<Uuid> {
    payload
        .get("execution")
        .and_then(|execution| execution.get("default_host_id"))
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

/// `execution.requested_host_id` — the host the request itself named: the
/// REST ledger's `target_host_id`, or the `work.session.spawn` tool's `host_id`
/// argument (`momo_t3::work_control::spawn_execution_object` writes it on both
/// producers). What a rejection is judged against when the card pre-selected
/// nothing.
pub fn requested_execution_host(payload: &Value) -> Option<Uuid> {
    payload
        .get("execution")
        .and_then(|execution| execution.get("requested_host_id"))
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

/// The host a decision about this approval is **about** when its decider picks
/// none: the card's pre-selected host, else the one the request named — and
/// `None` for an approval that asks no host question at all (every approval that
/// is not a spawn).
///
/// This is the one definition of "the card's host". The decision route judges a
/// rejection against it (`approvals::decision_reference_host`, ADR-0188 R0.1 Low
/// 2: a rejection is judged on the card, not the pick), and the push judgment
/// asks it to decide who is worth waking (`momo_push::judge_targets`, ADR-0204
/// D7), so the two cannot name different machines.
pub fn reference_execution_host(payload: &Value) -> Option<Uuid> {
    if !offers_host_choice(payload) {
        return None;
    }
    default_execution_host(payload).or_else(|| requested_execution_host(payload))
}

/// `message.props` for the `approval_request` row — Swift
/// `approvalRequestProps` (:1787-1810).
///
/// The schema's own contract for this type is `{approval_id}`
/// (`001_init.sql:172`); Swift adds the fields a client needs to render the card
/// without a second fetch, and a client that only reads `approval_id` still
/// works. `tool_grant` is deliberately **not** copied in: props are broadcast to
/// everyone in the channel, and the grant is policy provenance, not content.
#[allow(clippy::too_many_arguments)]
pub fn approval_request_props(
    approval_id: Uuid,
    run_id: Uuid,
    channel_id: Uuid,
    action_type: &str,
    call: &ToolCall,
    raw_arguments: &str,
    expires_at: DateTime<Utc>,
    execution: Option<&Value>,
) -> Value {
    let mut props = json!({
        "approval_id": approval_id.to_string(),
        "run_id": run_id.to_string(),
        "channel_id": channel_id.to_string(),
        "action_type": action_type,
        "call_id": call.call_id,
        "tool_name": call.name,
        "title": format!("도구 「{}」 실행", call.name),
        "summary": "실행할 도구를 확인하고 결정해 주세요.",
        "arguments": raw_arguments,
        "status": "pending",
        "expires_at_ms": expires_at.timestamp_millis(),
    });
    // The picker's rows go in `props` as well as in `payload`, because a client
    // renders the card from the broadcast message alone — a props-less card
    // would have to fetch the approval before it could draw a single radio
    // button. Nothing host-local rides along; see `SpawnHostCandidate::to_json`.
    if let (Some(execution), Some(object)) = (execution, props.as_object_mut()) {
        object.insert("execution".into(), execution.clone());
    }
    apply_login_handoff_props(&mut props, call);
    props
}

/// `props.kind` for the login handoff card (LIVE-4).
///
/// A **props** discriminator rather than a new `message_type`: `approval_request`
/// already carries a `kind` split (`resume_offer`), the enum in `schema_v0.sql`
/// is untouchable, and the login handoff really is an approval — same row, same
/// decision REST, same hold. The card that renders it is
/// `packages/momo-core/src/features/timeline/loginHandoffCard.ts`, and
/// `LOGIN_HANDOFF_KIND` there is this string.
pub const LOGIN_HANDOFF_PROPS_KIND: &str = "login_handoff";

/// What the model wrote in `session_id`, after the only reading of it that the
/// rest of the system can act on (LIVE-4 freeze H2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffSessionId {
    /// No `session_id` argument, or a blank one. Also the answer for every tool
    /// that is not the login handoff — this is a question only that card asks.
    Absent,
    /// Present, and not a UUID. The card carries no `session_id` at all.
    Malformed,
    /// Parsed. The card carries `Uuid::to_string()`, which is lower-case and
    /// hyphenated — the same spelling `uuid::text` renders in PostgreSQL.
    Canonical(Uuid),
}

/// Read the handoff card's `session_id` argument, canonically.
///
/// ## Why parsing is not fussiness
///
/// Two readers act on this string and they disagree about spelling. The tool
/// executor parses it (`Uuid::parse_str`, which accepts capitals, braces and the
/// unhyphenated form alike), so the *model* is served whatever it wrote. The
/// boundary stamp does not parse: it compares
/// `message.props->>'session_id' = $2::text` against a `uuid` PostgreSQL
/// renders lower-case and hyphenated
/// (`momo_t3::stamp_control_window_on_cards_in_tx`), because a props key is text
/// and a text join is what a jsonb predicate can index.
///
/// So a model that wrote `A1B2C3D4-…` used to get a card whose stamp matched
/// **zero rows, forever**: 정지 시각 and 재개 시각 never landed, and the card
/// stayed 「개입 대기」 through a window that had opened, closed and lapsed. The
/// fix belongs at the write, not at the join — normalizing here makes one
/// spelling true for every later reader, while a `lower()` on the join would
/// still be wrong for the unhyphenated form and would cost the predicate its
/// index.
///
/// Callers that need to *report* the malformed case (an audit row) get it from
/// the same function that decides the props, so the two can never disagree about
/// whether an id was dropped.
pub fn login_handoff_session_id(call: &ToolCall) -> HandoffSessionId {
    if crate::tools::normalize(&call.name)
        != crate::tools::normalize(crate::tools::WORK_SESSION_LOGIN_HANDOFF)
    {
        return HandoffSessionId::Absent;
    }
    let Some(raw) = call
        .arguments
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return HandoffSessionId::Absent;
    };
    match Uuid::parse_str(raw) {
        Ok(session_id) => HandoffSessionId::Canonical(session_id),
        Err(_) => HandoffSessionId::Malformed,
    }
}

/// `audit_log.action` for a handoff card that lost its deep link (freeze H2).
///
/// Its own row rather than a field on the approval's, because it is a different
/// claim with a different subject: the approval row says a human was asked to
/// consent, and this one says the card that asked them carries no door and
/// names why. Written only when it happened, so its presence is the signal.
pub const AUDIT_LOGIN_HANDOFF_SESSION_ID_DROPPED: &str =
    "approval.login_handoff.session_id_dropped";
/// `detail.schema` for that row.
pub const AUDIT_SCHEMA_LOGIN_HANDOFF_SESSION_ID_DROPPED: &str =
    "momo.approval.login_handoff.session_id_dropped.v1";

/// The audit detail for a dropped handoff `session_id`.
///
/// Carries the raw text, which is new disclosure of nothing: the same string is
/// already in `props.arguments` and in the approval payload this row sits beside
/// (`TOOL_AUDIT_SCHEMA`). Without it the row says a link was dropped and leaves
/// the operator no way to see what the model actually wrote, which is the one
/// question the row exists to answer.
pub fn login_handoff_session_id_dropped_detail(call: &ToolCall) -> Value {
    json!({
        "reason": "session_id is not a uuid",
        "tool_name": call.name,
        "call_id": call.call_id,
        "session_id_raw": call
            .arguments
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    })
}

/// Turn a generic tool-approval card into the login handoff card.
///
/// Three edits, each of which a client would otherwise get wrong:
///
/// * **`kind`** is what makes it this card at all.
/// * **`session_id`** is the deep link's only input. It is taken from the
///   model's arguments rather than resolved here, because the approval is
///   raised before anything validates the id; a card pointing at a session that
///   does not exist opens a detail screen that says so, which is a better
///   failure than a card with no door. It is **normalized** on the way in —
///   see [`login_handoff_session_id`] for why a card whose id is merely
///   *copied* is a card the boundary stamp can never find.
/// * **`title` is REMOVED and `summary` is replaced.** The generic values are
///   English server strings ("Approve work.session.login_handoff", "Review the
///   proposed tool call…") written for a reviewer of a tool call, and this card
///   is read by somebody being asked to go and log in. The title now comes from
///   the client's own copy module (one source per sentence), and the summary is
///   the sentence the agent itself wrote.
///
/// `arguments` stays where it is, opaque as ever: the client's `PARSED_KEYS`
/// allowlist has never rendered it and counts it as withheld instead.
fn apply_login_handoff_props(props: &mut Value, call: &ToolCall) {
    if crate::tools::normalize(&call.name)
        != crate::tools::normalize(crate::tools::WORK_SESSION_LOGIN_HANDOFF)
    {
        return;
    }
    let Some(object) = props.as_object_mut() else {
        return;
    };
    object.insert("kind".into(), json!(LOGIN_HANDOFF_PROPS_KIND));
    object.remove("title");
    match login_handoff_session_id(call) {
        // PostgreSQL's spelling, because PostgreSQL is what compares it.
        HandoffSessionId::Canonical(session_id) => {
            object.insert("session_id".into(), json!(session_id.to_string()));
        }
        // A door that opens onto nothing is worse than no door: the deep link
        // would take a person to a session detail for an id that cannot exist,
        // and the boundary stamp would never find this card either. Both
        // failures are quieter than the absence, so the key goes.
        HandoffSessionId::Malformed | HandoffSessionId::Absent => {
            object.remove("session_id");
        }
    }
    match call
        .arguments
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(reason) => {
            object.insert("summary".into(), json!(reason));
        }
        // No sentence beats a sentence about the wrong thing. The card renders
        // its own waiting copy when the agent supplied no 사유.
        None => {
            object.remove("summary");
        }
    }
}

/// The one-line body of an `approval_request` message (Swift :1618).
pub fn approval_request_body(tool_name: &str) -> String {
    format!("도구 「{tool_name}」을 실행해도 될까요?")
}

/// The receipt a decision returns and stores (Swift `ApprovalDecisionReceiptDTO`).
pub fn decision_receipt(
    approval_id: Uuid,
    status: &str,
    decided_by: Option<Uuid>,
    decided_at: DateTime<Utc>,
    reason: Option<&str>,
) -> Value {
    json!({
        "approvalId": approval_id.to_string(),
        "status": status,
        "decidedBy": decided_by.map(|id| id.to_string()),
        "decidedAtMs": decided_at.timestamp_millis(),
        "decisionReason": reason,
    })
}

/// The audit/broadcast body shared by every decision outcome (Swift
/// `decisionEventPayload` :1092-1112).
pub fn decision_event_payload(
    approval: &LockedApproval,
    status: &str,
    decided_by: Option<Uuid>,
    decided_at: DateTime<Utc>,
    reason: Option<&str>,
) -> Value {
    json!({
        "action": "decided",
        "approval_id": approval.id.to_string(),
        "run_id": approval.run_id.to_string(),
        "channel_id": approval.channel_id.to_string(),
        "requested_by": approval.requested_by.to_string(),
        "action_type": approval.action_type,
        "status": status,
        "payload": approval.payload,
        "decided_by": decided_by.map(|id| id.to_string()),
        "decided_at_ms": decided_at.timestamp_millis(),
        "decision_reason": reason,
    })
}

/// The `agent_job` payload an approved decision enqueues — Swift `resumePayload`
/// (:1114-1151).
///
/// `decided_by` is carried because the tool executes with **the approver's**
/// authority, not the agent's: the human did what they could have done through
/// the REST route themselves, and the executor re-checks it as that member. See
/// the worker's `tool_exec` module for why that is the only model that adds no
/// new authorization policy.
pub fn resume_job_payload(
    workspace_id: Uuid,
    approval: &LockedApproval,
    decided_by: Uuid,
    decision_event: &Value,
    approved_host_id: Option<Uuid>,
) -> Value {
    let payload = approval.payload.as_object();
    let tool_call = payload
        .and_then(|payload| payload.get("tool_call"))
        .and_then(Value::as_object);
    let string = |key: &str| {
        tool_call
            .and_then(|call| call.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    // Swift's MOMO-528 note (:1122-1124): an absent grant must be `null`, never
    // `{}` — an empty object failed the worker's grant decode and killed the
    // resume job outright.
    let tool_grant = tool_call
        .and_then(|call| call.get("tool_grant"))
        .cloned()
        .unwrap_or(Value::Null);

    json!({
        "run_id": approval.run_id.to_string(),
        "workspace_id": workspace_id.to_string(),
        "channel_id": approval.channel_id.to_string(),
        "agent_member_id": approval.requested_by.to_string(),
        "model": approval.agent_model,
        "model_source": approval.agent_model_source.as_str(),
        "prompt": approval
            .run_input
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "resume_from_approval_id": approval.id.to_string(),
        "approved_tool_call": {
            "call_id": string("call_id"),
            "name": if string("name").is_empty() { approval.action_type.clone() } else { string("name") },
            "arguments": tool_call
                .and_then(|call| call.get("arguments_json"))
                .cloned()
                .unwrap_or_else(|| json!({})),
        },
        "approved_by": decided_by.to_string(),
        // ADR-0125 D6-A (#1114). The host the approver chose, carried beside the
        // call rather than written into it: `arguments` is the model's utterance
        // stored byte for byte, and rewriting a field inside it would change
        // what the model is shown it said. A `None` here means the approval
        // asked no host question, and the executor falls back to the argument.
        "approved_host_id": approved_host_id.map(|id| id.to_string()),
        "policy_evidence": tool_grant,
        "approval_decision": decision_event,
        "step_count": approval.step_count,
        "max_steps": approval.max_steps,
        "depth": approval.depth,
    })
}

/// The `approval.decided` realtime envelope (Swift `decisionBroadcastPayload`
/// :1178-1198).
pub fn decision_broadcast_payload(
    cent_channel: &str,
    approval: &LockedApproval,
    status: &str,
    decision_event: &Value,
    decided_at: DateTime<Utc>,
) -> Value {
    json!({
        "channel": cent_channel,
        "data": {
            "type": "approval.decided",
            "v": 1,
            "ts": decided_at.timestamp_millis(),
            "payload": decision_event,
        },
        "idempotency_key": format!(
            "approval-decision:{}:{}:{}",
            approval.id, status, approval.run_id
        ),
    })
}

/// The `props` patch applied to the `approval_request` message once decided
/// (Swift `patchApprovalRequestMessage` :668-693).
///
/// Both `approval_status` and `status` are written because Swift writes both and
/// the mobile client reads one of them; dropping either would leave a decided
/// card still rendering its buttons.
pub fn decided_props_patch(
    status: &str,
    decided_by: Option<Uuid>,
    decided_at: DateTime<Utc>,
    reason: Option<&str>,
) -> Value {
    json!({
        "approval_status": status,
        "status": status,
        "decided_by": decided_by.map(|id| id.to_string()),
        "decided_at_ms": decided_at.timestamp_millis(),
        "decision_reason": reason,
    })
}

/// The deadline a new approval carries.
pub fn default_expires_at(now: DateTime<Utc>, ttl_seconds: i64) -> DateTime<Utc> {
    now + Duration::seconds(ttl_seconds.max(1))
}

/// Has `expires_at` been reached at `now`? **The one definition of "past its
/// deadline" for every reader that answers from the application's clock.**
///
/// The decision route settles a late tap with this predicate, and the status an
/// agent is told on a re-ask ([`effective_status`], ADR-0186 증보 v5 U-f) is read
/// through it too — so the two cannot disagree at the boundary. The instant itself
/// counts as expired (`<=`), exactly as the sweep's SQL (`expires_at <= now()`)
/// and the route have always judged it.
///
/// `now` is a **parameter**, never read here: the caller takes the clock once,
/// and the application's clock is the route's. A re-ask that compared against the
/// database's `now()` instead would call an approval `pending` in the very
/// millisecond the route settles it as `expired` (or the reverse).
pub fn is_overdue(expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    expires_at.is_some_and(|expires| expires <= now)
}

/// The status an approval **reads as** at `now`.
///
/// A `pending` approval whose deadline has passed is `expired` — before the
/// notifier's sweep has written it down. Every other status is returned as stored:
/// the sweep and the decision route are the only writers of `expired`, and a row
/// already settled stays what it was settled as (ADR-0186 증보 v5 U-f: 「만료는
/// 재호출이 파생해서 말한다」 — the expiry is never written to the proposer's inbox,
/// so this derivation is how an agent learns of it).
pub fn effective_status(
    status: &str,
    expires_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> &str {
    if status == "pending" && is_overdue(expires_at, now) {
        "expired"
    } else {
        status
    }
}

/// Swift `validatedStatus` (:487-497).
pub fn validated_status(raw: Option<&str>) -> Option<String> {
    let status = raw.map(|raw| raw.trim().to_lowercase());
    match status.as_deref() {
        None | Some("") | Some("pending") => Some("pending".to_string()),
        Some(other) if LISTABLE_STATUSES.contains(&other) => Some(other.to_string()),
        Some(_) => None,
    }
}

/// `?status=` of the approval list, which also takes `all` (ADR-0186 v6 R-f). `None`
/// when it is neither `all` nor one of [`LISTABLE_STATUSES`]; absent or blank is
/// `pending`, as it always was.
pub fn validated_status_filter(raw: Option<&str>) -> Option<ApprovalStatusFilter> {
    if raw.is_some_and(|raw| raw.trim().eq_ignore_ascii_case("all")) {
        return Some(ApprovalStatusFilter::All);
    }
    validated_status(raw).map(ApprovalStatusFilter::Only)
}

/// `?scope=` of the approval list: `team` (default) or `mine`. `None` for anything else.
pub fn validated_scope(raw: Option<&str>) -> Option<ApprovalScope> {
    match raw.map(|raw| raw.trim().to_lowercase()).as_deref() {
        None | Some("") | Some("team") => Some(ApprovalScope::Team),
        Some("mine") => Some(ApprovalScope::Mine),
        Some(_) => None,
    }
}

/// Swift `validatedLimit` (:499-501): default 100, clamped to `1..=500`.
pub fn validated_limit(raw: Option<&str>) -> i64 {
    raw.and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(100)
        .clamp(1, 500)
}

/// Swift `normalizedReason` (:1019-1024): trimmed, empty becomes absent, capped
/// at 2,000 characters.
pub fn normalized_reason(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(|reason| reason.chars().take(2_000).collect())
}

/// Pull the `tool_grants` projection out of an `agent_job` payload.
pub fn tool_grants_from_payload(payload: &Value) -> Option<Vec<ToolGrant>> {
    payload
        .get("tool_grants")
        .filter(|value| value.is_array())
        .map(ToolGrant::from_json_array)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handoff_call(arguments: Value) -> ToolCall {
        ToolCall {
            call_id: "call_1".to_string(),
            name: crate::tools::WORK_SESSION_LOGIN_HANDOFF.to_string(),
            arguments,
        }
    }

    fn handoff_props(arguments: Value) -> Value {
        approval_request_props(
            Uuid::nil(),
            Uuid::nil(),
            Uuid::nil(),
            crate::tools::ACTION_TYPE_TOOL_CALL,
            &handoff_call(arguments),
            "{}",
            DateTime::<Utc>::from_timestamp(0, 0).expect("epoch"),
            None,
        )
    }

    // ---- LIVE-4 -------------------------------------------------------------

    #[test]
    fn a_login_handoff_card_is_an_approval_card_with_one_extra_word() {
        let props = handoff_props(json!({
            "session_id": "  9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d  ",
            "reason": "  배포 콘솔이 로그인 화면으로 돌아갔습니다.  ",
        }));

        // The discriminator, and the only thing that makes this card that card.
        assert_eq!(props["kind"], json!(LOGIN_HANDOFF_PROPS_KIND));
        // Everything the approval machinery needs is untouched: same row, same
        // decision REST, same hold.
        assert_eq!(props["status"], json!("pending"));
        assert!(props.get("approval_id").is_some());
        assert!(props.get("run_id").is_some());
        assert!(props.get("expires_at_ms").is_some());

        // The deep link's only input, trimmed.
        assert_eq!(
            props["session_id"],
            json!("9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d")
        );
        // The agent's own sentence replaces the generic English summary.
        assert_eq!(
            props["summary"],
            json!("배포 콘솔이 로그인 화면으로 돌아갔습니다.")
        );
        // And the generic English title is GONE: the card's title is the
        // client's own copy, in one place (`loginHandoffCard.ts`).
        assert!(
            props.get("title").is_none(),
            "「Approve work.session.login_handoff」 must never reach a reader"
        );
    }

    #[test]
    fn a_handoff_card_with_nothing_to_say_says_nothing() {
        // A model that omitted both optional-looking arguments must not produce
        // a card carrying the tool-review sentence written for a different
        // reader. No sentence beats a sentence about the wrong thing.
        let props = handoff_props(json!({}));
        assert_eq!(props["kind"], json!(LOGIN_HANDOFF_PROPS_KIND));
        assert!(props.get("summary").is_none());
        assert!(props.get("title").is_none());
        assert!(props.get("session_id").is_none());

        // Whitespace is not a sentence and not an id.
        let blank = handoff_props(json!({ "session_id": "   ", "reason": "  " }));
        assert!(blank.get("summary").is_none());
        assert!(blank.get("session_id").is_none());
    }

    /// LIVE-4 freeze H2 — the id the card carries is the id PostgreSQL compares.
    ///
    /// Red before the fix: the write path only trimmed, so every spelling the
    /// tool executor happily parses (`Uuid::parse_str` takes capitals, braces
    /// and the unhyphenated form) landed in `props` verbatim, while the boundary
    /// stamp joins on `props->>'session_id' = $2::text` against a `uuid`
    /// PostgreSQL renders lower-case and hyphenated. A shouted UUID was a card
    /// the stamp could never find: zero rows, no 정지 시각, no 재개 시각, and the
    /// card stayed 「개입 대기」 through a whole window.
    #[test]
    fn the_card_carries_the_ledger_spelling_of_the_session_id() {
        const CANONICAL: &str = "9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d";
        for written in [
            // What a model actually writes when it echoes a UUID it read
            // somewhere with a different house style.
            "9A1B2C3D-4E5F-4A6B-8C7D-1E2F3A4B5C6D",
            "9a1b2c3d4e5f4a6b8c7d1e2f3a4b5c6d",
            "9A1B2C3D4E5F4A6B8C7D1E2F3A4B5C6D",
            "{9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d}",
            "urn:uuid:9A1B2C3D-4E5F-4A6B-8C7D-1E2F3A4B5C6D",
            "  9A1B2C3D-4E5F-4A6B-8C7D-1E2F3A4B5C6D  ",
        ] {
            let props = handoff_props(json!({ "session_id": written }));
            assert_eq!(
                props["session_id"],
                json!(CANONICAL),
                "「{written}」 must reach the card as the one spelling \
                 `stamp_control_window_on_cards_in_tx` can join on"
            );
        }
    }

    /// …and an id that is not one at all takes no door with it.
    ///
    /// A deep link built from a string no session can have opens a detail screen
    /// for nothing, and the stamp would miss the card anyway. The absence is the
    /// honest render; the *reason* goes to the audit log, which is where a
    /// question about a card that lost its link is answerable.
    #[test]
    fn a_session_id_that_is_not_one_leaves_no_false_door() {
        let call = handoff_call(json!({ "session_id": "the deploy console session" }));
        assert_eq!(login_handoff_session_id(&call), HandoffSessionId::Malformed);

        let props = handoff_props(json!({ "session_id": "the deploy console session" }));
        assert!(
            props.get("session_id").is_none(),
            "a card with a door onto nothing is worse than a card with no door"
        );

        // The audit row's detail names what was dropped and what the model
        // wrote, because 「이 카드에 왜 링크가 없나」 has no other answer.
        let detail = login_handoff_session_id_dropped_detail(&call);
        assert_eq!(
            detail["session_id_raw"],
            json!("the deploy console session")
        );
        assert_eq!(detail["call_id"], json!("call_1"));
        assert!(detail["reason"]
            .as_str()
            .is_some_and(|r| r.contains("uuid")));
    }

    /// The question belongs to this card and no other.
    #[test]
    fn no_other_tool_is_asked_for_a_session_id_it_never_promised() {
        let call = ToolCall {
            call_id: "call_2".to_string(),
            name: "chat.send".to_string(),
            arguments: json!({ "session_id": "NOT-A-UUID" }),
        };
        assert_eq!(
            login_handoff_session_id(&call),
            HandoffSessionId::Absent,
            "normalizing another tool's argument would rewrite props this \
             function has no business reading"
        );
    }

    #[test]
    fn the_credential_argument_never_reaches_the_card_face() {
        // `arguments` is carried for the model's own resume and has never been
        // in the client's rendered allowlist. Whatever a misbehaving model put
        // there stays out of the typed rows and is counted as withheld instead.
        let props = handoff_props(json!({
            "session_id": "9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d",
            "reason": "로그인이 필요합니다.",
        }));
        assert!(props.get("tool_grant").is_none());
        let rendered = [
            props.get("summary"),
            props.get("session_id"),
            props.get("kind"),
        ];
        for value in rendered.into_iter().flatten() {
            assert!(!value.to_string().contains("password"));
        }
    }

    #[test]
    fn every_other_tool_is_untouched_by_the_handoff_overlay() {
        let props = approval_request_props(
            Uuid::nil(),
            Uuid::nil(),
            Uuid::nil(),
            crate::tools::ACTION_TYPE_TOOL_CALL,
            &ToolCall {
                call_id: "call_2".to_string(),
                name: crate::tools::WORK_SESSION_END.to_string(),
                arguments: json!({ "session_id": "x", "reason": "y" }),
            },
            "{}",
            DateTime::<Utc>::from_timestamp(0, 0).expect("epoch"),
            None,
        );
        assert!(props.get("kind").is_none());
        assert_eq!(props["title"], json!("도구 「work.session.end」 실행"));
        assert_eq!(
            props["summary"],
            json!("실행할 도구를 확인하고 결정해 주세요.")
        );
        // The overlay reads `reason` and `session_id` out of the arguments, and
        // it must not do that for a tool that happens to use the same words.
        assert!(props.get("session_id").is_none());
    }

    #[test]
    fn status_and_limit_follow_the_swift_validators() {
        assert_eq!(validated_status(None).as_deref(), Some("pending"));
        assert_eq!(
            validated_status(Some("  APPROVED ")).as_deref(),
            Some("approved")
        );
        assert_eq!(validated_status(Some("bogus")), None);
        // `all` is a read filter, not a status: the old validator still refuses it.
        assert_eq!(validated_status(Some("all")), None);

        assert_eq!(validated_limit(None), 100);
        assert_eq!(validated_limit(Some("0")), 1);
        assert_eq!(validated_limit(Some("9999")), 500);
        assert_eq!(validated_limit(Some("not a number")), 100);
    }

    #[test]
    fn the_read_filters_take_all_and_mine_and_nothing_else() {
        let only = |status: &str| Some(ApprovalStatusFilter::Only(status.to_string()));
        assert_eq!(validated_status_filter(None), only("pending"));
        assert_eq!(validated_status_filter(Some("  ")), only("pending"));
        assert_eq!(
            validated_status_filter(Some("cancelled")),
            only("cancelled")
        );
        assert_eq!(
            validated_status_filter(Some(" ALL ")),
            Some(ApprovalStatusFilter::All)
        );
        for refused in ["settled", "history", "pending,approved", "all-of-them"] {
            assert_eq!(validated_status_filter(Some(refused)), None, "{refused}");
        }

        assert_eq!(validated_scope(None), Some(ApprovalScope::Team));
        assert_eq!(validated_scope(Some("")), Some(ApprovalScope::Team));
        assert_eq!(validated_scope(Some("TEAM")), Some(ApprovalScope::Team));
        assert_eq!(validated_scope(Some(" mine ")), Some(ApprovalScope::Mine));
        for refused in ["everyone", "me", "mine,team"] {
            assert_eq!(validated_scope(Some(refused)), None, "{refused}");
        }

        // Only the to-decide queue keeps its deadline order; everything else is paged by
        // time, and so is the only thing a cursor may be given to.
        assert!(!ApprovalStatusFilter::Only("pending".into()).is_time_ordered());
        for status in ["approved", "rejected", "expired", "cancelled"] {
            assert!(
                ApprovalStatusFilter::Only(status.into()).is_time_ordered(),
                "{status}"
            );
        }
        assert!(ApprovalStatusFilter::All.is_time_ordered());
    }

    #[test]
    fn a_card_sentence_is_passed_on_only_if_it_is_one() {
        assert_eq!(public_card_line(None), None);
        assert_eq!(public_card_line(Some("   ".into())), None);
        assert_eq!(
            public_card_line(Some("  승인됐어요 ".into())).as_deref(),
            Some("승인됐어요")
        );
        let longest = "가".repeat(CARD_LINE_MAX_CHARS);
        assert_eq!(public_card_line(Some(longest.clone())), Some(longest));
        assert_eq!(
            public_card_line(Some("가".repeat(CARD_LINE_MAX_CHARS + 1))),
            None,
            "one over is dropped, not cut"
        );
    }

    #[test]
    fn a_reason_is_trimmed_emptied_and_capped() {
        assert_eq!(normalized_reason(Some("   ")), None);
        assert_eq!(normalized_reason(Some("  ok  ")).as_deref(), Some("ok"));
        let long = "x".repeat(5_000);
        assert_eq!(normalized_reason(Some(&long)).expect("kept").len(), 2_000);
    }

    /// MOMO-528, ported as a test rather than as a comment: an absent grant is
    /// `null`. An empty object is what killed the Swift resume job.
    #[test]
    fn an_absent_grant_resumes_as_null_not_as_an_empty_object() {
        let approval = LockedApproval {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            run_id: Uuid::from_u128(3),
            channel_id: Uuid::from_u128(4),
            requested_by: Uuid::from_u128(5),
            request_message_id: None,
            action_type: "tool_call".into(),
            payload: json!({"tool_call": {"call_id": "c1", "name": "work.session.end"}}),
            status: "pending".into(),
            expires_at: None,
            agent_model: "gpt-4".into(),
            agent_model_source: ModelSource::Agent,
            run_input: json!({"prompt": "clean up"}),
            step_count: 1,
            max_steps: 12,
            depth: 0,
        };
        let payload = resume_job_payload(
            Uuid::from_u128(2),
            &approval,
            Uuid::from_u128(9),
            &json!({"status": "approved"}),
            None,
        );
        assert_eq!(payload["policy_evidence"], Value::Null);
        assert_eq!(payload["approved_tool_call"]["name"], "work.session.end");
        assert_eq!(payload["approved_by"], Uuid::from_u128(9).to_string());
        assert_eq!(payload["prompt"], "clean up");
    }

    /// #2897 (brief §4.5): the job an approval resumes is handed to a runtime,
    /// so it names the run and the call — never a person's runtime facts. An
    /// allowlist, not a denylist: a new key has to be argued for here.
    #[test]
    fn a_resume_payload_carries_only_allowlisted_keys() {
        const ALLOWED_KEYS: &[&str] = &[
            "run_id",
            "workspace_id",
            "channel_id",
            "agent_member_id",
            "model",
            "model_source",
            "prompt",
            "resume_from_approval_id",
            "approved_tool_call",
            "approved_by",
            "approved_host_id",
            "policy_evidence",
            "approval_decision",
            "step_count",
            "max_steps",
            "depth",
        ];
        const ALLOWED_CALL_KEYS: &[&str] = &["call_id", "name", "arguments"];
        let approval = LockedApproval {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            run_id: Uuid::from_u128(3),
            channel_id: Uuid::from_u128(4),
            requested_by: Uuid::from_u128(5),
            request_message_id: Some(Uuid::from_u128(6)),
            action_type: "tool_call".into(),
            payload: json!({"tool_call": {
                "call_id": "c1", "name": "work.session.end",
                "arguments_json": {"x": 1}, "tool_grant": {"g": true}}}),
            status: "pending".into(),
            expires_at: None,
            agent_model: "gpt-4".into(),
            agent_model_source: ModelSource::Agent,
            run_input: json!({"prompt": "clean up"}),
            step_count: 1,
            max_steps: 12,
            depth: 0,
        };
        let payload = resume_job_payload(
            Uuid::from_u128(2),
            &approval,
            Uuid::from_u128(9),
            &json!({"status": "approved"}),
            Some(Uuid::from_u128(10)),
        );
        let object = payload.as_object().expect("object");
        // Anti-vacuity: every key is present, so an emptied builder fails.
        assert_eq!(
            object.len(),
            ALLOWED_KEYS.len(),
            "keys: {:?}",
            object.keys()
        );
        for key in object.keys() {
            assert!(
                ALLOWED_KEYS.contains(&key.as_str()),
                "`{key}` is not an allowed resume job key"
            );
        }
        let call = payload["approved_tool_call"].as_object().expect("call");
        assert_eq!(call.len(), ALLOWED_CALL_KEYS.len(), "{call:?}");
        for key in call.keys() {
            assert!(ALLOWED_CALL_KEYS.contains(&key.as_str()), "`{key}`");
        }
        let wire = payload.to_string();
        for forbidden in [
            "owner_human_id",
            "owner_only",
            "invocation_scope",
            "subscription_harness",
            "hosted_connection",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
        ] {
            assert!(!wire.contains(forbidden), "`{forbidden}` in {wire}");
        }
    }

    /// The G3 budget has to survive the pause, or an approved tool call would
    /// resume with a fresh step allowance and the step cap would stop bounding
    /// the loop.
    #[test]
    fn the_resume_payload_carries_the_step_budget_across_the_pause() {
        let approval = LockedApproval {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            run_id: Uuid::from_u128(3),
            channel_id: Uuid::from_u128(4),
            requested_by: Uuid::from_u128(5),
            request_message_id: None,
            action_type: "tool_call".into(),
            payload: json!({}),
            status: "pending".into(),
            expires_at: None,
            agent_model: "gpt-4".into(),
            agent_model_source: ModelSource::Agent,
            run_input: json!({}),
            step_count: 7,
            max_steps: 12,
            depth: 2,
        };
        let payload = resume_job_payload(
            Uuid::from_u128(2),
            &approval,
            Uuid::from_u128(9),
            &json!({}),
            None,
        );
        assert_eq!(payload["step_count"], 7);
        assert_eq!(payload["max_steps"], 12);
        assert_eq!(payload["depth"], 2);
    }

    /// An expiry has no decider, and `approval_decided_ck` would reject one.
    #[test]
    fn an_expired_receipt_names_nobody() {
        let receipt = decision_receipt(
            Uuid::from_u128(1),
            "expired",
            None,
            DateTime::from_timestamp(0, 0).expect("epoch"),
            Some("deadline passed"),
        );
        assert_eq!(receipt["decidedBy"], Value::Null);
        assert_eq!(receipt["status"], "expired");
    }

    /// ADR-0186 증보 v5 U-f (#4702): a pending approval past its deadline reads as
    /// `expired` before any sweep has written it, and the deadline instant itself is
    /// already past — the same `<=` the decision route and the sweep's SQL use.
    #[test]
    fn a_pending_approval_reads_as_expired_from_the_deadline_instant_on() {
        let deadline = DateTime::from_timestamp(1_000, 0).expect("epoch");
        let just_before = deadline - Duration::milliseconds(1);
        let just_after = deadline + Duration::milliseconds(1);

        assert_eq!(
            effective_status("pending", Some(deadline), just_before),
            "pending"
        );
        assert_eq!(
            effective_status("pending", Some(deadline), deadline),
            "expired"
        );
        assert_eq!(
            effective_status("pending", Some(deadline), just_after),
            "expired"
        );
        assert!(!is_overdue(Some(deadline), just_before));
        assert!(is_overdue(Some(deadline), deadline));
    }

    /// Only `pending` is derived. A settled approval keeps the status it was settled
    /// with even when its deadline is long gone, and one with no deadline never lapses.
    #[test]
    fn only_a_pending_approval_is_derived_to_expired() {
        let long_ago = DateTime::from_timestamp(0, 0).expect("epoch");
        let now = DateTime::from_timestamp(86_400, 0).expect("a day later");
        for settled in ["approved", "rejected", "expired", "cancelled"] {
            assert_eq!(effective_status(settled, Some(long_ago), now), settled);
        }
        assert_eq!(effective_status("pending", None, now), "pending");
        assert!(!is_overdue(None, now));
    }
}
