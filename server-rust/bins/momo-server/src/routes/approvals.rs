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
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use momo_agent::actions::{
    action_by_id, action_ref, action_result_props, invite_result_body, invite_result_rows,
    last_attempt_patch, result_client_msg_id, ActionResult, RequiredRole,
    ACTION_APPROVED_AUDIT_SCHEMA, ACTION_RESULT_EXECUTED, ACTION_TYPE_WORKSPACE_ACTION,
    AUDIT_ACTION_APPROVED, DEFAULT_INVITE_EXPIRES_IN_DAYS, LAST_ATTEMPT_PROPS_KEY, REF_TYPE_INVITE,
    ROLE_REQUIRED, SECRET_ONCE_INVITE_LINK,
};
use momo_agent::approval::{
    decided_props_patch, decision_broadcast_payload, decision_event_payload, decision_receipt,
    default_execution_host, existing_decision_in_tx, is_active_channel_member_in_tx,
    is_active_human_member_in_tx, list_approvals_in_tx, lock_approval_in_tx,
    mark_approval_decided_in_tx, mark_approval_expired_in_tx, normalized_reason,
    offers_host_choice, record_decision_in_tx, resume_job_payload, selectable_host_ids,
    validated_limit, validated_status, ApprovalListRow, LockedApproval,
};
use momo_agent::tools::{ToolResult, TOOL_AUDIT_SCHEMA};
use momo_agent::{
    end_parked_run_in_tx, requeue_run_from_approval_in_tx, succeed_parked_run_in_tx, RunStatus,
};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_messaging::{
    cent_channel, patch_and_prune_message_props_in_tx, patch_message_props_in_tx,
    send_message_in_tx, MessageType, NewMessage,
};
use momo_outbox::{emit_outbox, OutboxKind, RESUME_APPROVAL_JOB_METHOD};
use momo_settings::{create_invite, INVITE_CREATED_AUDIT_ACTION, INVITE_CREATED_AUDIT_SCHEMA};
use momo_t3::work_control::{spawn_host_ineligible_reason_in_tx, work_control_id};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::T3Settings;
use crate::dto::{
    ApprovalDecisionReceipt, ApprovalDecisionRequest, ApprovalDto, ApprovalListQuery,
    ApprovalListResponse, SecretOnceDto,
};
use crate::error::ApiError;
use crate::realtime_advert::derive_same_origin_http_base;
use crate::routes::actions::{validated_action_args, ActionArgs};
use crate::routes::invites::require_admin;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, emit_terminal_agent_status, epoch_ms, path_uuid,
    settle_db, workspace_scope, DbRejectable,
};
use crate::routes::webhooks::no_store;
use crate::AppState;

/// The body of the `tool_result` a rejection appends (Swift :847).
const REJECTED_TOOL_RESULT_BODY: &str = "Tool call rejected by human approval.";

/// The one expected failure this route discovers **after** its first write, and
/// the receipt `status` it answers with.
///
/// ADR-0186 D2 executes the action and only then moves the run out of its hold.
/// If the run left the hold in between — a human stop, or the expiry sweep
/// winning the race — the invite has already been minted in this transaction
/// and the only honest answer is to roll the whole decision back. But a
/// rollback is `Err(DbError)`, and `settle_db` folds every `Err` into an opaque
/// 500, which would make this the one outcome on a route whose every other
/// expected failure is a receipt (403/404/409). A card stuck in that state
/// would then answer 500 to every tap forever, with the approval still pending.
///
/// So the executor returns a **sentinel** protocol error: the transaction rolls
/// back exactly as it must, and [`decide`] recognises the sentinel and answers
/// the receipt-shaped 409 the clients already decode.
const RUN_NOT_PARKED: &str = "run_not_parked";

/// The sentinel itself. Namespaced and versioned so it cannot collide with a
/// genuine `sqlx::Error::Protocol` message from the driver.
const RUN_NOT_PARKED_SENTINEL: &str = "momo.approvals.run_not_parked.v1";

/// Is this the rollback [`RUN_NOT_PARKED`] asked for, rather than a real
/// database failure?
fn is_run_not_parked(error: &momo_db::DbError) -> bool {
    matches!(
        error,
        momo_db::DbError::Sqlx(momo_db::sqlx::Error::Protocol(message))
            if message == RUN_NOT_PARKED_SENTINEL
    )
}

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
    headers: HeaderMap,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let approval_id = path_uuid(&approval, "invalid approval id")?;
    // Swift `validateBodyApprovalID` (:1026-1030): the body must agree with the
    // path, so a client cannot decide one approval while its telemetry records
    // another.
    if request.approval_id != approval_id {
        return Err(ApiError::bad_request("approval_id does not match path"));
    }
    decide(
        state,
        principal,
        workspace_id,
        approval_id,
        None,
        &headers,
        request,
    )
    .await
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
    headers: HeaderMap,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Result<Response, ApiError> {
    let run_id = path_uuid(&run, "invalid run id")?;
    let workspace_id = principal.workspace_id;
    let approval_id = request.approval_id;
    decide(
        state,
        principal,
        workspace_id,
        approval_id,
        Some(run_id),
        &headers,
        request,
    )
    .await
}

/// A settled decision: the receipt plus the status it answers with.
struct Decision {
    /// What is stored in `approval_decision.receipt` **and** answered — the two
    /// are the same bytes, which is what makes an idempotent retry honest.
    receipt: Value,
    status: StatusCode,
    /// ADR-0186 부록 C / D4 — the one-time value this decision minted.
    ///
    /// Deliberately **outside** [`Self::receipt`]: the receipt is persisted and
    /// replayed, and this is neither. It is carried out of the transaction as a
    /// separate field and grafted onto the response body by [`decide`], so
    /// "stored" and "answered" differ by exactly this one key and a reader can
    /// see where the difference is made.
    secret_once: Option<SecretOnceDto>,
}

impl Decision {
    fn ok(receipt: Value) -> Decision {
        Decision {
            receipt,
            status: StatusCode::OK,
            secret_once: None,
        }
    }
}

async fn decide(
    state: AppState,
    principal: Principal,
    workspace_id: Uuid,
    approval_id: Uuid,
    route_run_id: Option<Uuid>,
    headers: &HeaderMap,
    request: ApprovalDecisionRequest,
) -> Result<Response, ApiError> {
    let reason = normalized_reason(request.reason.as_deref());
    let approve = request.approve;
    let client_decision_id = request.client_decision_id;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let selected_host_id = request.host_id;
    // Resolved here rather than inside the transaction because it is a property
    // of *this request* (its Host header) and of the process (its configured
    // public base), not of any row. The executor judges its absence before the
    // first write — see `execute_workspace_action`.
    let public_origin = invite_link_origin(&state.t3, headers);

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
                    selected_host_id,
                    public_origin: public_origin.as_deref(),
                },
            )
            .await
        })
    })
    .await;

    let decision = match outcome {
        // The action was executed and then un-executed: the transaction rolled
        // back, so nothing was minted, nothing was decided, and the approval is
        // still pending. Answering the receipt rather than a 500 is what lets a
        // client say 「이 승인의 실행 대상이 이미 끝났습니다」 and stop offering
        // the button.
        Err(ref error) if is_run_not_parked(error) => refusal(
            approval_id,
            member_id,
            RUN_NOT_PARKED,
            "this approval's run is no longer waiting for a decision",
            StatusCode::CONFLICT,
            Utc::now(),
        ),
        outcome => settle_db("approvals.decide", outcome)?,
    };
    let status = decision.status;
    let secret_once = decision.secret_once;
    let mut receipt: ApprovalDecisionReceipt = serde_json::from_value(decision.receipt)
        .map_err(|error| ApiError::internal("approvals.decide.receipt", error))?;
    if let Some(secret) = secret_once {
        // An executed action always built its `result` first, so a missing one
        // here would mean the two halves of 부록 C had come apart. Answering the
        // link with no `ref` beside it would hand a person a credential with
        // nothing naming what it opens.
        let result = receipt.result.as_mut().ok_or_else(|| {
            ApiError::internal(
                "approvals.decide.result",
                "a one-time value with no result object",
            )
        })?;
        result.secret_once = Some(secret);
    }

    // **ADR-0186 D4 — on every outcome, not only the one that carries a link.**
    //
    // A conditional `no-store` would be a signal in itself: an intermediary (or
    // a person reading a HAR) could tell "this decision minted something" from
    // the headers alone, before reading the body. It is also the fragile shape —
    // one more arm that can answer with a secret is one more place to remember.
    Ok(no_store((status, Json(receipt)).into_response()))
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
    /// ADR-0125 D6-A (#1114) — the host the approver picked on the card.
    selected_host_id: Option<Uuid>,
    /// The absolute origin an invite link should point at, or `None` when this
    /// instance cannot name itself (ADR-0186 부록 C).
    public_origin: Option<&'a str>,
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
            secret_once: None,
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

    // The `work_control` this approval owns, if any (Swift :196). A malformed
    // binding is answered here rather than followed, because following it would
    // send a spawn down the generic resume path where nothing dispatches it.
    let control_id = match work_control_id(&approval.payload) {
        Ok(control_id) => control_id,
        Err(message) => {
            return Ok(Ok(refusal(
                approval.id,
                input.member_id,
                "internal_error",
                message,
                StatusCode::INTERNAL_SERVER_ERROR,
                now,
            )))
        }
    };

    // ---- ADR-0125 D6-A: the host choice, judged before the first write -----
    let host_choice = match resolve_host_choice(conn, &approval, &input, now).await? {
        Ok(choice) => choice,
        Err(rejected) => return Ok(Ok(rejected)),
    };

    // ---- expiry: settle it rather than merely refusing (Swift :198-221) ----
    if approval.expires_at.is_some_and(|expires| expires <= now) {
        return Ok(Ok(settle_expired(
            conn,
            &approval,
            input.member_id,
            input.via_token_id,
            input.approve,
            input.client_decision_id,
            control_id,
        )
        .await?));
    }

    // **ADR-0186 D2 — the approve half of a workspace action is executed, not
    // resumed.**
    //
    // The generic path below would requeue the run and enqueue a
    // `resume_approval` job whose payload has no `tool_call` at all — a job the
    // worker cannot run. A workspace action has no model turn waiting on it:
    // the decision transaction *is* the execution (ADR-0186 §5: 세 경로 모두
    // resume job 0건).
    //
    // **Only the approve half branches.** Rejection and expiry keep the arms
    // they already had, and the existing ones are correct for this payload:
    // `reject_run` reads `payload.tool_call.call_id` with `unwrap_or_default()`,
    // `end_parked_run_in_tx` is guarded on `awaiting_approval`, and the resume
    // job is emitted only by `approve_run`.
    //
    // Placed **after** the expiry settlement above: an already-overdue card
    // still settles as `expired` on a tap rather than minting an invite past its
    // own deadline.
    if approval.action_type == ACTION_TYPE_WORKSPACE_ACTION && input.approve {
        return execute_workspace_action(conn, &approval, &input, now).await;
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
        // The same prune the executor does, on the arm a person reaches by
        // saying **no**. A proposal refused for want of authority and then
        // rejected would otherwise render `status: rejected` beside
        // `last_attempt: "role_required"` — two answers to "what happened
        // here". Pruning a key this card never had is a no-op, so the tool-call
        // face of this route is untouched.
        patch_and_prune_message_props_in_tx(
            conn,
            input.workspace_id,
            message_id,
            &decided_props_patch(desired_status, Some(input.member_id), now, input.reason),
            &[LAST_ATTEMPT_PROPS_KEY],
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

    // Swift `shouldApplyGenericAgentDecisionFlow(workControlID:)` (:302): a
    // work-control approval settles its ledger row instead of resuming an agent
    // turn, because the thing waiting on it is a **host**, not a model.
    if let Some(control_id) = control_id {
        if approval.action_type != momo_t3::work_control::ACTION_TYPE_WORK_SPAWN {
            return Err(protocol_error("work control approval action is malformed"));
        }
        crate::routes::work_controls::apply_spawn_approval_decision(
            conn,
            input.workspace_id,
            approval.id,
            control_id,
            input.approve,
            host_choice.selected,
        )
        .await
        .map_err(control_failure)?
        .ok_or_else(|| protocol_error("linked work control is not pending approval"))?;
    } else if input.approve {
        approve_run(
            conn,
            &approval,
            input.member_id,
            &event,
            host_choice.selected,
        )
        .await?;
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
    approved_host_id: Option<Uuid>,
) -> Result<(), momo_db::DbError> {
    if !requeue_run_from_approval_in_tx(conn, approval.run_id).await? {
        // Nothing to resume. The approval still stands as approved (a human did
        // say yes), and the audit row above records that; what does not happen
        // is a job for a run that is no longer parked.
        return Ok(());
    }

    let payload = resume_job_payload(
        approval.workspace_id,
        approval,
        decided_by,
        event,
        approved_host_id,
    );
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

// ---------------------------------------------------------------------------
// ADR-0186 D2/D4 — the workspace-action executor (#2509)
//
// Everything below happens inside the decision transaction that locked the
// approval `FOR UPDATE`, with the **approver's** authority. The agent that
// proposed it is not an admin at any point; it is not even consulted here. What
// it gets is its own name on the outcome line, because the proposal was its
// utterance.
//
// The order is the ADR's, and each step's placement is load-bearing:
//
//   1. the role gate            — before the first write except the card patch
//   2. the arguments, re-proved — from the stored payload, never trusted as-is
//   3. the link's origin        — before the first write, so a link this server
//                                 cannot address refuses instead of minting a
//                                 code nobody will ever see
//   4. execute · audit · settle · post · finish · broadcast
// ---------------------------------------------------------------------------

/// Approve a `workspace_action`: run it here, now, as the person who said yes.
async fn execute_workspace_action(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
) -> DbRejectable<Decision> {
    // ---- 1. the gate is the invite surface's own ---------------------------
    //
    // `require_admin` is `routes::invites`'s function, called rather than
    // copied: ADR-0186 D2 says the judgement is 「기존 `require_admin`과 같은
    // 판정」, and two implementations of one rule drift the day either is
    // widened. It is also the same authority the REST route would have applied
    // had this person minted the invite by hand — which is exactly what they
    // are doing, one card removed.
    //
    // The `match` is exhaustive on purpose: the registry publishes a
    // `required_role` per action, and calling `require_admin` unconditionally
    // would make a second action with a different gate silently admin-gated.
    // Adding a `RequiredRole` variant now fails to compile here, which is where
    // the decision about its gate belongs.
    let gate = match action_required_role(&approval.payload) {
        Some(RequiredRole::Admin) | None => {
            require_admin(conn, input.workspace_id, input.member_id).await?
        }
    };
    if gate.is_err() {
        // The approval is **not consumed** (ADR-0186 D2): no ledger row, no
        // status change, the run stays parked. What does change is the card — a
        // person who tapped and was refused must be able to see why on the
        // surface they tapped, and an admin scrolling past must see that
        // somebody already tried.
        if let Some(message_id) = approval.request_message_id {
            patch_message_props_in_tx(
                conn,
                input.workspace_id,
                message_id,
                &last_attempt_patch(ROLE_REQUIRED),
            )
            .await?;
        }
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            ROLE_REQUIRED,
            "this workspace action must be approved by a workspace admin",
            StatusCode::FORBIDDEN,
            now,
        )));
    }

    // ---- 2. what was proposed, re-proved -----------------------------------
    let Some(action_id) = approval
        .payload
        .get("action")
        .and_then(|action| action.get("id"))
        .and_then(Value::as_str)
    else {
        // A `workspace_action` row with no action id cannot have come from
        // `oort_action_propose`. Rolling back is the only safe answer: the
        // alternative is guessing which action a person consented to.
        return Err(protocol_error("workspace action approval names no action"));
    };
    let Some(action) = action_by_id(action_id) else {
        // The registry no longer publishes this id — a card outlived the action
        // it proposed. The approval stays pending rather than executing
        // something whose contract this build does not carry.
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            "action_unavailable",
            "this workspace action is no longer offered by this server",
            StatusCode::CONFLICT,
            now,
        )));
    };

    // The stored `args` are re-run through the **same** normaliser the proposal
    // passed (`routes::actions::validated_action_args`), for the reason ADR-0186
    // D2 gives: 「저장값을 신뢰하지 않는다」. The card may be an hour old, the
    // ceilings may have narrowed since, and the row is writable by anything that
    // can write `approval.payload`. Re-proving costs one function call and is
    // the difference between "a person approved these numbers" and "a person
    // approved a row".
    let now_ms = now.timestamp_millis();
    let Ok(validated) = validated_action_args(action, proposed_args(&approval.payload), now_ms)
    else {
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            "action_args_invalid",
            "this proposal's arguments are no longer valid",
            StatusCode::CONFLICT,
            now,
        )));
    };

    // ---- 3. can this server address its own link? --------------------------
    //
    // Judged before the mint, not after. A code exists exactly once, in the
    // response that carries it (D4), so minting one we cannot put in a link
    // would burn an invite nobody could ever use and leave a row in
    // `invite_code` that no person asked for.
    let Some(origin) = input.public_origin else {
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            "public_origin_unavailable",
            "this instance cannot address its own invite links",
            StatusCode::CONFLICT,
            now,
        )));
    };

    // ---- 4. execute --------------------------------------------------------
    let ActionArgs::InviteCreate {
        role,
        max_uses,
        expires_in_days,
    } = validated.args;
    let expires_at_ms = expires_in_days.map(|days| now_ms + days * 86_400_000);
    let created = create_invite(
        conn,
        input.workspace_id,
        role,
        max_uses,
        expires_at_ms,
        // **The approver's name on the row**, not the agent's. `invite_code.
        // created_by` is who is accountable for this link existing.
        input.member_id,
    )
    .await?;

    // base64url by construction (`momo_generate_invite_code`, 003). Checked
    // rather than escaped: an unsafe code means the generator changed, and
    // quietly percent-encoding it would hide that while producing a link whose
    // text no longer matches the code a person may type by hand.
    if !created.code.bytes().all(is_url_safe_code_byte) {
        return Err(protocol_error("minted invite code is not url-safe"));
    }
    let join_url = format!("{origin}/join?code={}", created.code);
    let action_ref_value = action_ref(REF_TYPE_INVITE, created.invite.id);

    // ---- audit: two rows, and the generic `approval.approved` is not one ----
    //
    // ADR-0186 §5 names exactly two: `action.approved` and `invite.created`.
    // This arm returns before the generic write block, so the tool-call path's
    // `approval.{status}` row is not written — an executed action is recorded as
    // what it did, once, rather than as a decision plus a coincidence.
    write_audit(
        conn,
        &AuditEntry::new(input.workspace_id, INVITE_CREATED_AUDIT_ACTION)
            .by(input.member_id)
            .target("invite_code", created.invite.id)
            .via_token(input.via_token_id)
            .run(approval.run_id)
            .with_schema(
                INVITE_CREATED_AUDIT_SCHEMA,
                // The REST route's two fields plus this path's provenance.
                // Role and reach only — never the code, never its hash, never
                // the preview (`routes::invites::create`'s discipline, and an
                // audit row is read by more people than a response is).
                json!({
                    "role": role,
                    "max_uses": max_uses,
                    "via_agent": approval.requested_by.to_string(),
                    "approval_id": approval.id.to_string(),
                }),
            ),
    )
    .await?;
    write_audit(
        conn,
        &AuditEntry::new(input.workspace_id, AUDIT_ACTION_APPROVED)
            .by(input.member_id)
            // Actor and subject differ here and the difference is the point:
            // a person decided, an agent's proposal was decided about.
            .about(approval.requested_by)
            .target("approval", approval.id)
            .via_token(input.via_token_id)
            .run(approval.run_id)
            .with_schema(
                ACTION_APPROVED_AUDIT_SCHEMA,
                json!({
                    "action_id": action.id,
                    "approval_id": approval.id.to_string(),
                    "proposed_by": approval.requested_by.to_string(),
                    "decided_by": input.member_id.to_string(),
                    "ref": action_ref_value,
                }),
            ),
    )
    .await?;

    // ---- settle the approval ----------------------------------------------
    let event = decision_event_payload(
        approval,
        "approved",
        Some(input.member_id),
        now,
        input.reason,
    );
    let mut receipt = decision_receipt(
        approval.id,
        "approved",
        Some(input.member_id),
        now,
        input.reason,
    );
    // The **ref only** (ADR-0186 D2). This object is stored verbatim in
    // `approval_decision.receipt` and replayed to a retry, so anything put here
    // is a durable copy — and `secretOnce` is grafted on afterwards, outside the
    // transaction, by `decide`.
    if let Some(object) = receipt.as_object_mut() {
        object.insert(
            "result".into(),
            json!({"actionId": action.id, "ref": action_ref_value}),
        );
    }

    mark_approval_decided_in_tx(
        conn,
        approval.id,
        "approved",
        input.member_id,
        now,
        input.reason,
    )
    .await?;

    if let Some(message_id) = approval.request_message_id {
        // The prune is what clears an earlier refusal: a card that says 승인됨
        // must not also still say the last attempt needed an admin — and a
        // shallow merge cannot delete, so writing a null would have left the
        // key present for any client reading it by presence.
        patch_and_prune_message_props_in_tx(
            conn,
            input.workspace_id,
            message_id,
            &decided_props_patch("approved", Some(input.member_id), now, input.reason),
            &[LAST_ATTEMPT_PROPS_KEY],
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
        "approved",
        input.reason,
        &receipt,
    )
    .await?;

    // ---- the outcome line, authored by the agent ---------------------------
    //
    // Same authorship rule as the rejection's (`reject_run`): the proposal was
    // the agent's utterance, so its outcome belongs to the same speaker. Who
    // decided is in the props, not in the authorship.
    // UTC, like every other date this server renders. A client that wants the
    // reader's own calendar day formats it from the invite row; the card's row
    // is the server's statement about the instant it wrote.
    let expires_on = chrono::DateTime::from_timestamp_millis(created.invite.expires_at_ms)
        .ok_or_else(|| protocol_error("minted invite has an unrepresentable expiry"))?
        .format("%Y-%m-%d")
        .to_string();
    send_message_in_tx(
        conn,
        input.workspace_id,
        NewMessage {
            channel_id: approval.channel_id,
            author_member_id: approval.requested_by,
            message_type: MessageType::ToolResult,
            body: Some(invite_result_body(
                role,
                max_uses,
                expires_in_days.unwrap_or(DEFAULT_INVITE_EXPIRES_IN_DAYS),
            )),
            props: action_result_props(&ActionResult {
                action_id: action.id,
                status: ACTION_RESULT_EXECUTED,
                approval_id: approval.id,
                decided_by: input.member_id,
                ref_type: REF_TYPE_INVITE,
                ref_id: created.invite.id,
                rows: invite_result_rows(role, &expires_on),
                secret_shown_once: true,
            }),
            root_id: None,
            reply_to_id: None,
            // NOT `approval.id` — that key belongs to the rejection and expiry
            // lines (`momo_agent::actions::result_client_msg_id`).
            client_msg_id: Some(result_client_msg_id(approval.id)),
            run_id: Some(approval.run_id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;

    // ---- the run ends here, succeeded, with no job behind it ---------------
    if !succeed_parked_run_in_tx(
        conn,
        approval.run_id,
        &json!({"actionId": action.id, "ref": action_ref_value}),
    )
    .await?
    {
        // The guard lost: this run is no longer parked (a human stop, or an
        // expiry that raced us). Unlike `approve_run`'s identical-looking check
        // this cannot be swallowed — an invite has already been minted in this
        // transaction, and `Err` is the only channel that rolls it back.
        return Err(protocol_error(RUN_NOT_PARKED_SENTINEL));
    }
    emit_terminal_agent_status(
        conn,
        input.workspace_id,
        approval.channel_id,
        approval.requested_by,
        approval.run_id,
        RunStatus::Succeeded,
    )
    .await?;

    emit_outbox(
        &mut *conn,
        input.workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &decision_broadcast_payload(
            &cent_channel(input.workspace_id, approval.channel_id),
            approval,
            "approved",
            &event,
            now,
        ),
        Some(approval.channel_id),
    )
    .await
    .map_err(momo_db::DbError::from)?;

    Ok(Ok(Decision {
        receipt,
        status: StatusCode::OK,
        secret_once: Some(SecretOnceDto {
            kind: SECRET_ONCE_INVITE_LINK.to_string(),
            value: join_url,
            expires_at_ms: created.invite.expires_at_ms,
        }),
    }))
}

/// The `required_role` the registry publishes for this proposal's action.
///
/// `None` when the payload names an action this build no longer carries — the
/// gate then falls back to the strictest rule v1 has (admin), and the
/// `action_unavailable` refusal below is what actually answers. Reading the
/// role before resolving the action keeps the **authority** check first, which
/// is the order ADR-0186 D2 spells out: a non-admin must not be able to learn
/// which actions this server still offers by tapping approve.
fn action_required_role(payload: &Value) -> Option<RequiredRole> {
    let action_id = payload
        .get("action")
        .and_then(|action| action.get("id"))
        .and_then(Value::as_str)?;
    action_by_id(action_id).map(|action| action.required_role)
}

/// `payload.action.args`, or a value the normaliser will refuse.
///
/// Returning `&Value::Null` rather than defaulting to `{}` keeps a payload with
/// no args from being read as "all defaults": a proposal always writes the
/// normalised object, so its absence is corruption, not brevity.
fn proposed_args(payload: &Value) -> &Value {
    payload
        .get("action")
        .and_then(|action| action.get("args"))
        .unwrap_or(&Value::Null)
}

/// base64url, the alphabet `momo_generate_invite_code` produces.
fn is_url_safe_code_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

/// The absolute origin an invite link points at (ADR-0186 부록 C).
///
/// ## Why this is not simply `MOMO_PUBLIC_BASE_URL`
///
/// The brief pointed at 「초대 redeem 라우트가 쓰는 공개 사이트 주소 정본」, and
/// there is no such thing: the redeem route builds no URL (the web client
/// assembles its own from `resolveServerBaseUrl`, `IssuedInviteCard.tsx:39`),
/// and #1926's `OORT_SITE_ADDRESS` is a Caddy template env this process never
/// reads. So this resolves the two sources that **do** exist, in the order that
/// makes a self-hosted instance work out of the box:
///
/// 1. `MOMO_PUBLIC_BASE_URL`, when the operator set it to an absolute https
///    origin. It is stored on [`T3Settings`] because T3 needed it first, and is
///    read here **without** consulting `T3Settings::enabled` — the operator's
///    answer to "what is this deployment's public address" does not become
///    untrue when oort Cloud is off, which is the default.
/// 2. otherwise the request's own origin, by the ADR-0167 trust boundary
///    ([`derive_same_origin_http_base`]) — the same `Host` + `X-Forwarded-Proto`
///    derivation the realtime advertisement and the Drive capability URL use,
///    including its Host validation. That is correct for the canonical
///    deployment, where one Caddy site serves the SPA at `/` and the API at
///    `/v1` (`infra/rust/Caddyfile`), so the link a decider is handed is the
///    address they are already looking at.
///
/// `None` only when both fail, which needs an HTTP/1.1 request with no usable
/// `Host` at all. The executor answers that with a refusal rather than a link.
fn invite_link_origin(settings: &T3Settings, headers: &HeaderMap) -> Option<String> {
    if let Some(configured) = settings.ready_public_base_url() {
        return Some(configured);
    }
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    derive_same_origin_http_base(forwarded_proto, host, None).ok()
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
#[allow(clippy::too_many_arguments)]
async fn settle_expired(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    approve: bool,
    client_decision_id: Uuid,
    control_id: Option<Uuid>,
) -> Result<Decision, momo_db::DbError> {
    let now = Utc::now();
    // Swift :201-210. A spawn whose card expired is **denied**, not left
    // pending: the control row is what a host would consume, and an expired
    // approval that left it dispatchable would be a deadline that bounds the
    // inbox but not the machine.
    if let Some(control_id) = control_id {
        momo_t3::work_control::apply_spawn_approval_decision_in_tx(
            conn,
            approval.workspace_id,
            approval.id,
            control_id,
            false,
        )
        .await
        .map_err(control_failure)?;
    }
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
        secret_once: None,
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

// ---------------------------------------------------------------------------
// ADR-0125 D6-A — the host the approver chose (#1114)
// ---------------------------------------------------------------------------

/// The outcome of judging a decision's host selection.
struct HostChoice {
    /// The host the spawn will actually run on, or `None` when this approval
    /// asks no host question at all.
    selected: Option<Uuid>,
}

/// Judge the approver's host pick against the very list the card published.
///
/// Three checks, in this order and all **before the first write**:
///
/// 1. a `hostId` on an approval that offers no picker is a 400 — the client is
///    answering a question this card did not ask, and silently ignoring it would
///    let a person believe they had chosen something;
/// 2. the pick must be one of the candidates this approval published as
///    `selectable`. Reading the stored list rather than recomputing one is what
///    guarantees the gate and the picker agree — a recomputed list could differ
///    from the rows the human actually saw;
/// 3. the pick must **still** be eligible now. The card may be hours old, and a
///    host can be revoked, go offline, or change hands in between; step 2 alone
///    would dispatch to a laptop that closed.
///
/// The session owner every check is made for is the **agent's owner human**, not
/// the approver: a spawned session belongs to the person the agent acts for
/// (Swift `createControl` binds `sessionOwnerMemberID = binding.ownerHumanID`),
/// so the candidate list is stable from the moment the card is drawn and does
/// not depend on which colleague happens to tap approve.
async fn resolve_host_choice(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
) -> Result<Result<HostChoice, Decision>, momo_db::DbError> {
    let offers_choice = offers_host_choice(&approval.payload);
    if !offers_choice {
        if input.selected_host_id.is_some() {
            return Ok(Err(refusal(
                approval.id,
                input.member_id,
                "bad_request",
                "this approval does not offer a host choice",
                StatusCode::BAD_REQUEST,
                now,
            )));
        }
        return Ok(Ok(HostChoice { selected: None }));
    }

    let selected = input
        .selected_host_id
        .or_else(|| default_execution_host(&approval.payload));

    // A rejection needs no host: nothing will run.
    if !input.approve {
        return Ok(Ok(HostChoice { selected: None }));
    }

    let Some(selected) = selected else {
        return Ok(Err(refusal(
            approval.id,
            input.member_id,
            "conflict",
            "no eligible work host is available for this spawn",
            StatusCode::CONFLICT,
            now,
        )));
    };
    if let Some(chosen) = input.selected_host_id {
        if !selectable_host_ids(&approval.payload).contains(&chosen) {
            return Ok(Err(refusal(
                approval.id,
                input.member_id,
                "forbidden",
                "selected host is not one of this approval's candidates",
                StatusCode::FORBIDDEN,
                now,
            )));
        }
    }

    let owner_member_id = match momo_t3::work_control::agent_owner_human_in_tx(
        conn,
        approval.workspace_id,
        approval.requested_by,
    )
    .await
    .map_err(control_failure)?
    {
        Some(owner) => owner,
        None => {
            return Ok(Err(refusal(
                approval.id,
                input.member_id,
                "conflict",
                "the requesting agent has no active human owner",
                StatusCode::CONFLICT,
                now,
            )))
        }
    };
    if let Some(reason) =
        spawn_host_ineligible_reason_in_tx(conn, approval.workspace_id, selected, owner_member_id)
            .await
            .map_err(control_failure)?
    {
        return Ok(Err(refusal(
            approval.id,
            input.member_id,
            "conflict",
            &format!("selected work host is unavailable: {reason}"),
            StatusCode::CONFLICT,
            now,
        )));
    }

    Ok(Ok(HostChoice {
        selected: Some(selected),
    }))
}

/// Carry a control-ledger failure across the `T3Error` → `DbError` seam.
///
/// The decision transaction speaks `DbError` because nothing else it touches is
/// a T3 lifecycle object. A ledger failure has to **roll the decision back** —
/// an approval marked `approved` whose control never dispatched is the worst of
/// both answers — and `Err(DbError)` is the only channel that rolls back here
/// (`Ok(Err(_))` commits, which is why every rejection above is returned before
/// the first write). So the `Db` arm passes through and everything else becomes
/// a protocol error carrying the ledger's own sentence.
fn control_failure(error: momo_t3::T3Error) -> momo_db::DbError {
    match error {
        momo_t3::T3Error::Db(inner) => inner,
        other => protocol_error(&other.to_string()),
    }
}

fn protocol_error(message: &str) -> momo_db::DbError {
    momo_db::DbError::Sqlx(momo_db::sqlx::Error::Protocol(message.to_string()))
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
        // A refusal mints nothing, so there is nothing to show once.
        secret_once: None,
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
            assert!(
                receipt.result.is_none(),
                "a refusal executed nothing, so it names nothing"
            );
        }
    }

    /// `role_required` joins that family rather than becoming the one 403 on
    /// this route that answers a different schema.
    ///
    /// The spec is explicit — 「Expected failures (403/404/409) return the SAME
    /// receipt schema (not the generic error envelope)」
    /// (`docs/api/openapi.yaml`, `decideApproval`) — and both clients decode it
    /// that way (`packages/momo-core/.../approvalDecision.ts:233` lists 403 in
    /// `receiptStatuses` and then reads `receipt.status`).
    #[test]
    fn role_required_is_a_receipt_like_every_other_expected_failure() {
        let decision = refusal(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            ROLE_REQUIRED,
            "this workspace action must be approved by a workspace admin",
            StatusCode::FORBIDDEN,
            Utc::now(),
        );
        assert_eq!(decision.status, StatusCode::FORBIDDEN);
        assert!(decision.secret_once.is_none());
        let receipt: ApprovalDecisionReceipt =
            serde_json::from_value(decision.receipt).expect("receipt decodes");
        assert_eq!(receipt.status, "role_required");
        assert_eq!(
            receipt.status,
            momo_agent::actions::ROLE_REQUIRED,
            "the word on the wire and the word in the card props are one constant"
        );
    }

    fn headers_of(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                axum::http::HeaderValue::from_str(value).expect("header value"),
            );
        }
        headers
    }

    fn settings_with(public_base_url: Option<&str>) -> T3Settings {
        T3Settings {
            public_base_url: public_base_url.map(str::to_string),
            ..T3Settings::default()
        }
    }

    /// The configured origin wins, and — the load-bearing half — it is read
    /// **without** consulting `T3Settings::enabled`.
    ///
    /// `MOMO_PUBLIC_BASE_URL` lives on the T3 struct because oort Cloud needed
    /// it first, but it answers "what is this deployment's public address",
    /// which does not stop being true when T3 is off. T3 is off by **default**,
    /// so gating on it would have meant every ordinary deployment silently fell
    /// through to the header derivation.
    #[test]
    fn the_configured_public_base_wins_even_with_t3_disabled() {
        let settings = settings_with(Some("https://oort.example.com/"));
        assert!(!settings.enabled, "the default, and the interesting case");
        assert_eq!(
            invite_link_origin(&settings, &headers_of(&[("host", "internal:8080")])).as_deref(),
            Some("https://oort.example.com"),
            "trailing slash trimmed, and the Host header does not override it"
        );
    }

    /// Unset (or unusable) configuration falls through to this request's own
    /// origin, by the ADR-0167 derivation the realtime advert already uses.
    #[test]
    fn an_unconfigured_instance_addresses_itself_from_the_request() {
        assert_eq!(
            invite_link_origin(
                &settings_with(None),
                &headers_of(&[("host", "team.example"), ("x-forwarded-proto", "https")])
            )
            .as_deref(),
            Some("https://team.example")
        );
        // A loopback self-host with no proxy in front of it: http, port kept.
        assert_eq!(
            invite_link_origin(
                &settings_with(None),
                &headers_of(&[("host", "127.0.0.1:8080")])
            )
            .as_deref(),
            Some("http://127.0.0.1:8080")
        );
        // `http://…` is not an https public base, so it is not accepted as
        // configuration (`T3Settings::ready_public_base_url`) — but the request
        // still answers for itself rather than leaving the link unbuildable.
        assert_eq!(
            invite_link_origin(
                &settings_with(Some("http://insecure.example")),
                &headers_of(&[("host", "team.example")])
            )
            .as_deref(),
            Some("http://team.example")
        );
    }

    /// No configuration and no usable `Host` ⇒ no origin, and the executor
    /// refuses rather than minting a code it cannot put in a link.
    #[test]
    fn a_request_that_names_no_host_yields_no_origin() {
        assert_eq!(
            invite_link_origin(&settings_with(None), &HeaderMap::new()),
            None
        );
        // Host is a trust boundary: control bytes are refused upstream by
        // `derive_same_origin_http_base`, and an invalid header value cannot
        // even be constructed here — so the reachable failure is absence.
        assert_eq!(
            invite_link_origin(&settings_with(None), &headers_of(&[("host", " ")])),
            None
        );
    }

    /// The executor reads the proposal's arguments from one place, and a
    /// payload that carries none hands the normaliser something it refuses
    /// rather than an empty object it would happily fill with defaults.
    #[test]
    fn missing_proposal_args_are_null_rather_than_defaults() {
        assert_eq!(
            proposed_args(&json!({"action": {"id": "invite.create", "args": {"role": "admin"}}})),
            &json!({"role": "admin"})
        );
        assert_eq!(proposed_args(&json!({})), &Value::Null);
        assert_eq!(proposed_args(&json!({"action": {"id": "x"}})), &Value::Null);
        assert!(
            validated_action_args(
                action_by_id(momo_agent::actions::ACTION_INVITE_CREATE).expect("v1"),
                proposed_args(&json!({})),
                0,
            )
            .is_err(),
            "a null is refused; `{{}}` would have been accepted as all-defaults"
        );
    }

    /// The rollback channel carries exactly one meaning, and nothing else in
    /// it is mistaken for that meaning.
    #[test]
    fn only_the_sentinel_is_read_as_a_run_that_left_its_hold() {
        assert!(is_run_not_parked(&protocol_error(RUN_NOT_PARKED_SENTINEL)));
        // A real driver protocol failure must still roll back as a 500 — it is
        // not an expected outcome and a client can do nothing with it.
        assert!(!is_run_not_parked(&protocol_error(
            "unexpected response from the server"
        )));
        assert!(!is_run_not_parked(&protocol_error(RUN_NOT_PARKED)));
        assert!(!is_run_not_parked(&momo_db::DbError::Sqlx(
            momo_db::sqlx::Error::RowNotFound
        )));
        // The wire word and the sentinel are different strings on purpose: one
        // is a contract with clients, the other is internal plumbing.
        assert_ne!(RUN_NOT_PARKED, RUN_NOT_PARKED_SENTINEL);
        let decision = refusal(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            RUN_NOT_PARKED,
            "this approval's run is no longer waiting for a decision",
            StatusCode::CONFLICT,
            Utc::now(),
        );
        assert_eq!(decision.status, StatusCode::CONFLICT);
        let receipt: ApprovalDecisionReceipt =
            serde_json::from_value(decision.receipt).expect("receipt decodes");
        assert_eq!(receipt.status, "run_not_parked");
        assert!(receipt.result.is_none(), "nothing survived the rollback");
    }

    /// The link is built by concatenation, so the code's alphabet is checked
    /// rather than assumed: `momo_generate_invite_code` (003) is base64url.
    #[test]
    fn only_a_base64url_code_may_be_pasted_into_a_link() {
        for safe in ["Ab3-_x", "aaaaBBBB9999", "-_-_"] {
            assert!(safe.bytes().all(is_url_safe_code_byte), "{safe}");
        }
        for unsafe_code in ["a&b", "a#b", "a b", "a/b", "a=b", "a?b", "a+b"] {
            assert!(
                !unsafe_code.bytes().all(is_url_safe_code_byte),
                "{unsafe_code} would truncate or re-target the link"
            );
        }
    }
}
