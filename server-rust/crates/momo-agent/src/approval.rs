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
                a.expires_at, ag.model AS agent_model, r.input AS run_input, \
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
        run_input: row.try_get("run_input").map_err(DbError::from)?,
        step_count: row.try_get("step_count").map_err(DbError::from)?,
        max_steps: row.try_get("max_steps").map_err(DbError::from)?,
        depth: row.try_get("depth").map_err(DbError::from)?,
    }))
}

/// The approval inbox (Swift `fetchApprovals` :503-589).
///
/// The `JOIN membership` is the authorization, not a filter applied afterwards:
/// a person sees exactly the approvals raised in rooms they are still in. A
/// `WHERE` on the workspace alone would have shown every approval in the tenant.
pub async fn list_approvals_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    status: &str,
    limit: i64,
) -> Result<Vec<ApprovalListRow>, DbError> {
    let rows = sqlx::query(
        "SELECT a.id, a.workspace_id, a.run_id, a.channel_id, a.request_message_id, \
                a.requested_by, a.action_type, a.payload, a.status::text AS status_label, \
                a.decided_by, a.decided_at, a.decision_reason, a.expires_at, a.created_at \
           FROM approval a \
           JOIN membership ms \
             ON ms.channel_id = a.channel_id \
            AND ms.member_id = $2 \
            AND ms.left_at IS NULL \
          WHERE a.workspace_id = $1 \
            AND a.status = $3::approval_status \
          ORDER BY a.expires_at NULLS LAST, a.created_at DESC \
          LIMIT $4",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(status)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;

    rows.iter()
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
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE approval \
            SET status = $2::approval_status, decided_by = $3, decided_at = $4, \
                decision_reason = $5 \
          WHERE id = $1",
    )
    .bind(approval_id)
    .bind(status)
    .bind(decided_by)
    .bind(decided_at)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(())
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
pub fn approval_payload(
    run_id: Uuid,
    action_type: &str,
    call: &ToolCall,
    raw_arguments: &str,
    tool_grant: Option<&Value>,
    approval_reason: &str,
) -> Value {
    let mut tool_call = Map::new();
    tool_call.insert("call_id".into(), json!(call.call_id));
    tool_call.insert("name".into(), json!(call.name));
    tool_call.insert("arguments".into(), json!(raw_arguments));
    tool_call.insert("arguments_json".into(), call.arguments.clone());
    if let Some(grant) = tool_grant {
        tool_call.insert("tool_grant".into(), grant.clone());
    }

    json!({
        "run_id": run_id.to_string(),
        "action_type": action_type,
        "tool_call": Value::Object(tool_call),
        "approval_reason": approval_reason,
        "resume_model": RESUME_MODEL,
    })
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
) -> Value {
    json!({
        "approval_id": approval_id.to_string(),
        "run_id": run_id.to_string(),
        "channel_id": channel_id.to_string(),
        "action_type": action_type,
        "call_id": call.call_id,
        "tool_name": call.name,
        "title": format!("Approve {}", call.name),
        "summary": "Review the proposed tool call before momo executes it.",
        "arguments": raw_arguments,
        "status": "pending",
        "expires_at_ms": expires_at.timestamp_millis(),
    })
}

/// The one-line body of an `approval_request` message (Swift :1618).
pub fn approval_request_body(tool_name: &str) -> String {
    format!("Approval required: {tool_name}")
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

/// Swift `validatedStatus` (:487-497).
pub fn validated_status(raw: Option<&str>) -> Option<String> {
    let status = raw.map(|raw| raw.trim().to_lowercase());
    match status.as_deref() {
        None | Some("") | Some("pending") => Some("pending".to_string()),
        Some(other) if LISTABLE_STATUSES.contains(&other) => Some(other.to_string()),
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

    #[test]
    fn status_and_limit_follow_the_swift_validators() {
        assert_eq!(validated_status(None).as_deref(), Some("pending"));
        assert_eq!(
            validated_status(Some("  APPROVED ")).as_deref(),
            Some("approved")
        );
        assert_eq!(validated_status(Some("bogus")), None);

        assert_eq!(validated_limit(None), 100);
        assert_eq!(validated_limit(Some("0")), 1);
        assert_eq!(validated_limit(Some("9999")), 500);
        assert_eq!(validated_limit(Some("not a number")), 100);
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
        );
        assert_eq!(payload["policy_evidence"], Value::Null);
        assert_eq!(payload["approved_tool_call"]["name"], "work.session.end");
        assert_eq!(payload["approved_by"], Uuid::from_u128(9).to_string());
        assert_eq!(payload["prompt"], "clean up");
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
}
