//! The approval inbox and the decision endpoint (goal SRV-T1).
//!
//! Ports Swift `ApprovalDecisionRoutes.swift` (1,277 lines), all three routes:
//!
//! ```text
//! GET  /v1/workspaces/{ws}/approvals?status=&limit=       list
//! POST /v1/workspaces/{ws}/approvals/{approval}/decision  decideByApproval
//! POST /v1/agent-runs/{run}/approval-decisions            decideByRun (compat)
//! ```
//!
//! ## Who may decide
//!
//! Two predicates, both Swift's, both checked before any write:
//!
//! 1. **an active human member** (`member.kind='human' AND status='active' AND
//!    deleted_at IS NULL`, Swift :604-622);
//! 2. **an active member of the approval's channel** (Swift :624-642).
//!
//! The first is also the whole answer to "can an agent approve its own
//! request?". `approval.requested_by` is the agent; deciding requires
//! `kind='human'`; so no agent can decide any approval, and the self-approval
//! case needs no separate rule. Swift has none either — this is why.
//!
//! The list route applies the same pair, but as a `JOIN membership` inside the
//! query rather than as a filter afterwards: a person's inbox is exactly the
//! approvals raised in rooms they are still in.
//!
//! ## The five outcomes, and why each is the status it is
//!
//! | condition | status | Swift |
//! |---|---|---|
//! | replay of the same `client_decision_id`, same decider + same verdict | 200, the original receipt | :118-123 |
//! | replay with a *different* verdict | 409 `idempotency_conflict` | :124-133 |
//! | not a human / not in the channel | 403 | :141-148, :179-186 |
//! | approval already decided | 409, carrying the status it already has | :187-195 |
//! | deadline passed | 409, and the approval is *settled* as expired | :198-221 |
//!
//! The expiry arm is the one worth reading twice: a click that arrives late does
//! not merely fail, it **finishes** the approval — marks it `expired`, moves the
//! run to `timed_out`, records the ledger row and broadcasts — so the gate is
//! released by the very request that was too late. That is Swift's behaviour and
//! it is kept, but it is no longer the *only* thing that releases the gate: see
//! `momo_agent::approval`'s sweep, because an approval nobody ever clicks would
//! otherwise hold an agent's only concurrency slot forever.
//!
//! ## Transaction shape
//!
//! One `agent_tenant_tx` per decision. Inside it the approval row is locked
//! `FOR UPDATE`, every rejection is returned through
//! [`DbRejectable`](crate::routes::shared::DbRejectable) **before the first
//! write**, and on the write path the approval update, the card patch, the
//! ledger row, the audit row, the run transition, the resume job (or the
//! rejection's `tool_result` message) and the broadcast all commit together.
//!
//! Nothing here contains `outbox` or `message` SQL: the job and the broadcasts
//! are `momo_outbox::emit_outbox`, the rejection's `tool_result` is
//! `momo_messaging::send_message_in_tx` (so it takes a real `channel_seq` bump
//! like any other message), and the card patch is
//! `momo_messaging::patch_message_props_in_tx`.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use chrono::Utc;
use momo_agent::approval::{
    decided_props_patch, decision_broadcast_payload, decision_event_payload, decision_receipt,
    existing_decision_in_tx, is_active_channel_member_in_tx, is_active_human_member_in_tx,
    list_approvals_in_tx, lock_approval_in_tx, mark_approval_decided_in_tx,
    mark_approval_expired_in_tx, normalized_reason, record_decision_in_tx, resume_job_payload,
    validated_limit, validated_status, ApprovalListRow, LockedApproval,
};
use momo_agent::tools::{ToolResult, TOOL_AUDIT_SCHEMA};
use momo_agent::{end_parked_run_in_tx, requeue_run_from_approval_in_tx, RunStatus};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_messaging::{
    cent_channel, patch_message_props_in_tx, send_message_in_tx, MessageType, NewMessage,
};
use momo_outbox::{emit_outbox, OutboxKind, RESUME_APPROVAL_JOB_METHOD};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::dto::{
    ApprovalDecisionReceipt, ApprovalDecisionRequest, ApprovalDto, ApprovalListQuery,
    ApprovalListResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, emit_terminal_agent_status, epoch_ms, path_uuid,
    settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// The body of the `tool_result` a rejection appends (Swift :847).
const REJECTED_TOOL_RESULT_BODY: &str = "Tool call rejected by human approval.";

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/// `GET /v1/workspaces/{ws}/approvals` (Swift `list`, :22-54).
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ApprovalListQuery>,
) -> Result<Json<ApprovalListResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let status = validated_status(query.status.as_deref()).ok_or_else(|| {
        ApiError::bad_request("status must be pending, approved, rejected, expired, or cancelled")
    })?;
    let limit = validated_limit(query.limit.as_deref());
    let member_id = principal.member_id;

    let outcome: DbRejectable<Vec<ApprovalListRow>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_human_member_in_tx(conn, member_id).await? {
                    return Ok(Err(ApiError::forbidden(
                        "not an active human workspace member",
                    )));
                }
                Ok(Ok(list_approvals_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &status,
                    limit,
                )
                .await?))
            })
        })
        .await;

    let approvals = settle_db("approvals.list", outcome)?;
    Ok(Json(ApprovalListResponse {
        approvals: approvals.iter().map(approval_dto).collect(),
    }))
}

fn approval_dto(row: &ApprovalListRow) -> ApprovalDto {
    ApprovalDto {
        id: row.id.to_string(),
        workspace_id: row.workspace_id.to_string(),
        run_id: row.run_id.to_string(),
        channel_id: row.channel_id.to_string(),
        request_message_id: row.request_message_id.map(|id| id.to_string()),
        requested_by: row.requested_by.to_string(),
        action_type: row.action_type.clone(),
        payload: row.payload.clone(),
        status: row.status.clone(),
        decided_by: row.decided_by.map(|id| id.to_string()),
        decided_at_ms: row.decided_at.map(epoch_ms),
        decision_reason: row.decision_reason.clone(),
        expires_at_ms: row.expires_at.map(epoch_ms),
        created_at_ms: epoch_ms(row.created_at),
    }
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/approvals/{approval}/decision` (Swift
/// `decideByApproval`, :56-75).
pub async fn decide_by_approval(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, approval)): Path<(String, String)>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let approval_id = path_uuid(&approval, "invalid approval id")?;
    // Swift `validateBodyApprovalID` (:1026-1030): the body must agree with the
    // path, so a client cannot decide one approval while its telemetry records
    // another.
    if request.approval_id != approval_id {
        return Err(ApiError::bad_request("approval_id does not match path"));
    }
    decide(state, principal, workspace_id, approval_id, None, request).await
}

/// `POST /v1/agent-runs/{run}/approval-decisions` (Swift `decideByRun`,
/// :77-94) — the compatibility route.
///
/// The workspace comes from the credential rather than the path, exactly as
/// Swift does: this route has no `{ws}` segment, and inventing one would be a
/// second way to name a tenant.
pub async fn decide_by_run(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(run): Path<String>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let run_id = path_uuid(&run, "invalid run id")?;
    let workspace_id = principal.workspace_id;
    let approval_id = request.approval_id;
    decide(
        state,
        principal,
        workspace_id,
        approval_id,
        Some(run_id),
        request,
    )
    .await
}

/// A settled decision: the receipt plus the status it answers with.
struct Decision {
    receipt: Value,
    status: StatusCode,
}

impl Decision {
    fn ok(receipt: Value) -> Decision {
        Decision {
            receipt,
            status: StatusCode::OK,
        }
    }
}

async fn decide(
    state: AppState,
    principal: Principal,
    workspace_id: Uuid,
    approval_id: Uuid,
    route_run_id: Option<Uuid>,
    request: ApprovalDecisionRequest,
) -> Result<impl IntoResponse, ApiError> {
    let reason = normalized_reason(request.reason.as_deref());
    let approve = request.approve;
    let client_decision_id = request.client_decision_id;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let outcome: DbRejectable<Decision> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            decide_in_tx(
                conn,
                DecisionInput {
                    workspace_id,
                    approval_id,
                    route_run_id,
                    member_id,
                    via_token_id,
                    approve,
                    reason: reason.as_deref(),
                    client_decision_id,
                },
            )
            .await
        })
    })
    .await;

    let decision = settle_db("approvals.decide", outcome)?;
    let receipt: ApprovalDecisionReceipt = serde_json::from_value(decision.receipt)
        .map_err(|error| ApiError::internal("approvals.decide.receipt", error))?;
    Ok((decision.status, Json(receipt)))
}

struct DecisionInput<'a> {
    workspace_id: Uuid,
    approval_id: Uuid,
    route_run_id: Option<Uuid>,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    approve: bool,
    reason: Option<&'a str>,
    client_decision_id: Uuid,
}

async fn decide_in_tx(conn: &mut PgConnection, input: DecisionInput<'_>) -> DbRejectable<Decision> {
    let now = Utc::now();
    let desired_status = if input.approve {
        "approved"
    } else {
        "rejected"
    };

    // ---- idempotency first (Swift :112-134) --------------------------------
    //
    // Before authorization, because a replay must answer the same thing the
    // first call answered even if the caller's membership has changed since —
    // the decision already happened, and re-judging it would make a retry
    // produce a different history than the original.
    if let Some(existing) =
        existing_decision_in_tx(conn, input.workspace_id, input.client_decision_id).await?
    {
        if existing.approval_id == input.approval_id
            && existing.decided_by == input.member_id
            && existing.approve == input.approve
        {
            return Ok(Ok(Decision::ok(existing.receipt)));
        }
        return Ok(Ok(Decision {
            receipt: decision_receipt(
                input.approval_id,
                "idempotency_conflict",
                Some(input.member_id),
                now,
                Some("approval_decision_idempotency_conflict"),
            ),
            status: StatusCode::CONFLICT,
        }));
    }

    // ---- rejections, all before the first write ----------------------------
    if !is_active_human_member_in_tx(conn, input.member_id).await? {
        return Ok(Ok(refusal(
            input.approval_id,
            input.member_id,
            "forbidden",
            "approval decisions require an active human member",
            StatusCode::FORBIDDEN,
            now,
        )));
    }

    let Some(approval) = lock_approval_in_tx(conn, input.workspace_id, input.approval_id).await?
    else {
        // Also the cross-tenant answer: the lock is scoped to this
        // transaction's workspace, so another tenant's approval id is simply
        // not found — never "forbidden", which would confirm it exists.
        return Ok(Ok(refusal(
            input.approval_id,
            input.member_id,
            "not_found",
            "approval not found",
            StatusCode::NOT_FOUND,
            now,
        )));
    };

    if let Some(route_run_id) = input.route_run_id {
        if route_run_id != approval.run_id {
            return Ok(Ok(refusal(
                approval.id,
                input.member_id,
                "bad_request",
                "approval does not belong to route run",
                StatusCode::BAD_REQUEST,
                now,
            )));
        }
    }

    if !is_active_channel_member_in_tx(conn, approval.channel_id, input.member_id).await? {
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            "forbidden",
            "not a member of this approval channel",
            StatusCode::FORBIDDEN,
            now,
        )));
    }

    if approval.status != "pending" {
        let status = approval.status.clone();
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            &status,
            &format!("approval is already {status}"),
            StatusCode::CONFLICT,
            now,
        )));
    }

    // ---- expiry: settle it rather than merely refusing (Swift :198-221) ----
    if approval.expires_at.is_some_and(|expires| expires <= now) {
        return Ok(Ok(settle_expired(
            conn,
            &approval,
            input.member_id,
            input.via_token_id,
            input.approve,
            input.client_decision_id,
        )
        .await?));
    }

    // ---- writes ------------------------------------------------------------
    let event = decision_event_payload(
        &approval,
        desired_status,
        Some(input.member_id),
        now,
        input.reason,
    );
    let receipt = decision_receipt(
        approval.id,
        desired_status,
        Some(input.member_id),
        now,
        input.reason,
    );

    mark_approval_decided_in_tx(
        conn,
        approval.id,
        desired_status,
        input.member_id,
        now,
        input.reason,
    )
    .await?;

    if let Some(message_id) = approval.request_message_id {
        patch_message_props_in_tx(
            conn,
            input.workspace_id,
            message_id,
            &decided_props_patch(desired_status, Some(input.member_id), now, input.reason),
        )
        .await?;
    }

    record_decision_in_tx(
        conn,
        input.workspace_id,
        approval.id,
        input.client_decision_id,
        input.member_id,
        input.approve,
        desired_status,
        input.reason,
        &receipt,
    )
    .await?;

    write_audit(
        conn,
        &AuditEntry::new(input.workspace_id, format!("approval.{desired_status}"))
            .by(input.member_id)
            .target("approval", approval.id)
            .via_token(input.via_token_id)
            .run(approval.run_id)
            .with_schema(TOOL_AUDIT_SCHEMA, event.clone()),
    )
    .await?;

    if input.approve {
        approve_run(conn, &approval, input.member_id, &event).await?;
    } else {
        reject_run(conn, &approval, input.member_id, input.reason, now).await?;
    }

    emit_outbox(
        &mut *conn,
        input.workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &decision_broadcast_payload(
            &cent_channel(input.workspace_id, approval.channel_id),
            &approval,
            desired_status,
            &event,
            now,
        ),
        Some(approval.channel_id),
    )
    .await
    .map_err(momo_db::DbError::from)?;

    Ok(Ok(Decision::ok(receipt)))
}

/// Approved: requeue the run and enqueue the job that resumes it.
///
/// The `agent_run` update is guarded on `awaiting_approval`
/// ([`requeue_run_from_approval_in_tx`]) and its result is **not** ignored — a
/// `false` means the run left the hold between the lock and here, and enqueuing
/// a resume job for it would run a tool against a run that has already ended.
async fn approve_run(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    decided_by: Uuid,
    event: &Value,
) -> Result<(), momo_db::DbError> {
    if !requeue_run_from_approval_in_tx(conn, approval.run_id).await? {
        // Nothing to resume. The approval still stands as approved (a human did
        // say yes), and the audit row above records that; what does not happen
        // is a job for a run that is no longer parked.
        return Ok(());
    }

    let payload = resume_job_payload(approval.workspace_id, approval, decided_by, event);
    emit_outbox(
        &mut *conn,
        approval.workspace_id,
        OutboxKind::AgentJob,
        RESUME_APPROVAL_JOB_METHOD,
        &payload,
        // `partition_key = agent_member_id` — the same serialization key every
        // agent job uses, so a resume cannot run beside a first-turn job for
        // the same agent (`momo_outbox::agent_job`).
        Some(approval.requested_by),
    )
    .await?;
    Ok(())
}

/// Rejected: end the run and tell the channel, in that order (Swift
/// `cancelRunAndAppendToolResult` :813-892).
///
/// The `tool_result` message is authored by **the agent** (`requested_by`),
/// which is Swift's choice and the right one: the tool call was the agent's
/// utterance, so its outcome belongs to the same speaker. Who decided is in the
/// props, not in the authorship.
async fn reject_run(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    decided_by: Uuid,
    reason: Option<&str>,
    now: chrono::DateTime<Utc>,
) -> Result<(), momo_db::DbError> {
    let ended = end_parked_run_in_tx(
        conn,
        approval.run_id,
        RunStatus::Cancelled,
        &json!({
            "code": "approval_rejected",
            "approval_id": approval.id.to_string(),
            "reason": reason,
        }),
    )
    .await?;
    if !ended {
        return Ok(());
    }

    // The rail hears it (goal SRV-B3c). A parked run renders as 승인 대기, not
    // 작업 중 — but it is still an entry in the client's run table, and a
    // rejection that published nothing would leave it there until the 120s
    // zombie sweep. `ended` guards this: the frame follows the row, so a
    // decision that transitioned nothing announces nothing.
    emit_terminal_agent_status(
        conn,
        approval.workspace_id,
        approval.channel_id,
        approval.requested_by,
        approval.run_id,
        RunStatus::Cancelled,
    )
    .await?;

    let call_id = approval
        .payload
        .get("tool_call")
        .and_then(|call| call.get("call_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut props = ToolResult::error(call_id, REJECTED_TOOL_RESULT_BODY).message_props();
    if let Some(object) = props.as_object_mut() {
        object.insert("approval_id".into(), json!(approval.id.to_string()));
        object.insert("run_id".into(), json!(approval.run_id.to_string()));
        object.insert("status".into(), json!("rejected"));
        object.insert("decided_by".into(), json!(decided_by.to_string()));
        object.insert("decided_at_ms".into(), json!(now.timestamp_millis()));
        object.insert("reason".into(), json!(reason));
    }

    send_message_in_tx(
        conn,
        approval.workspace_id,
        NewMessage {
            channel_id: approval.channel_id,
            author_member_id: approval.requested_by,
            message_type: MessageType::ToolResult,
            body: Some(REJECTED_TOOL_RESULT_BODY.to_string()),
            props,
            root_id: None,
            reply_to_id: None,
            // One rejection line per approval, whatever a retry does. The spine's
            // `(channel, author, client_msg_id)` guard is the same one the
            // agent's reply uses.
            client_msg_id: Some(approval.id),
            run_id: Some(approval.run_id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    Ok(())
}

/// A click that arrived after the deadline (Swift `recordExpiredClick`
/// :894-977).
///
/// It **settles** rather than merely refusing: the approval becomes `expired`,
/// the run `timed_out`, and both the ledger row and the audit row are written.
/// The audit actor is NULL — nobody decided this, the clock did.
async fn settle_expired(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    approve: bool,
    client_decision_id: Uuid,
) -> Result<Decision, momo_db::DbError> {
    let now = Utc::now();
    let reason = "Approval expired before a human decision.";
    let receipt = decision_receipt(approval.id, "expired", None, now, Some(reason));
    let event = decision_event_payload(approval, "expired", None, now, Some(reason));

    mark_approval_expired_in_tx(conn, approval.id, now, reason).await?;
    expire_run(conn, approval).await?;

    record_decision_in_tx(
        conn,
        approval.workspace_id,
        approval.id,
        client_decision_id,
        member_id,
        approve,
        "expired",
        Some(reason),
        &receipt,
    )
    .await?;

    write_audit(
        conn,
        &AuditEntry::new(approval.workspace_id, "approval.expired")
            .about(approval.requested_by)
            .target("approval", approval.id)
            .via_token(via_token_id)
            .run(approval.run_id)
            .with_schema(TOOL_AUDIT_SCHEMA, event.clone()),
    )
    .await?;

    emit_outbox(
        &mut *conn,
        approval.workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &decision_broadcast_payload(
            &cent_channel(approval.workspace_id, approval.channel_id),
            approval,
            "expired",
            &event,
            now,
        ),
        Some(approval.channel_id),
    )
    .await?;

    Ok(Decision {
        receipt,
        status: StatusCode::CONFLICT,
    })
}

/// The run half of an expiry, shared with the sweep's semantics.
///
/// The terminal frame (goal SRV-B3c) is emitted **here** rather than at the call
/// site so that "the run ended" and "the rail was told" cannot come apart in one
/// of the two expiry paths — this is the same reason the transition itself is a
/// shared function instead of two copies of the same `UPDATE`.
pub(crate) async fn expire_run(
    conn: &mut PgConnection,
    approval: &LockedApproval,
) -> Result<bool, momo_db::DbError> {
    let ended = end_parked_run_in_tx(
        conn,
        approval.run_id,
        RunStatus::TimedOut,
        &json!({
            "code": "approval_expired",
            "approval_id": approval.id.to_string(),
        }),
    )
    .await?;
    if ended {
        emit_terminal_agent_status(
            conn,
            approval.workspace_id,
            approval.channel_id,
            approval.requested_by,
            approval.run_id,
            RunStatus::TimedOut,
        )
        .await?;
    }
    Ok(ended)
}

/// An expected refusal: a receipt shaped like a decision, carrying the HTTP
/// status that names why (Swift `expectedFailure` :1032-1049).
///
/// Swift answers refusals with a receipt body rather than the API's error
/// envelope, and that is kept: the mobile client decodes one shape for every
/// outcome of a tap, so a 409 renders "이미 처리된 요청입니다" instead of falling
/// into a generic error path.
fn refusal(
    approval_id: Uuid,
    member_id: Uuid,
    status: &str,
    reason: &str,
    http_status: StatusCode,
    now: chrono::DateTime<Utc>,
) -> Decision {
    Decision {
        receipt: decision_receipt(approval_id, status, Some(member_id), now, Some(reason)),
        status: http_status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The refusal body must decode as the receipt the client expects, or a 409
    /// would reach the phone as an unparseable success shape.
    #[test]
    fn every_refusal_is_a_decodable_receipt() {
        let now = Utc::now();
        for (status, http) in [
            ("forbidden", StatusCode::FORBIDDEN),
            ("not_found", StatusCode::NOT_FOUND),
            ("approved", StatusCode::CONFLICT),
            ("idempotency_conflict", StatusCode::CONFLICT),
        ] {
            let decision = refusal(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                status,
                "because",
                http,
                now,
            );
            let receipt: ApprovalDecisionReceipt =
                serde_json::from_value(decision.receipt).expect("receipt decodes");
            assert_eq!(receipt.status, status);
            assert_eq!(decision.status, http);
        }
    }
}
