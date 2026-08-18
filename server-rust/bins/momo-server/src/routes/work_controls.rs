//! The host-control ledger REST surface (#1114) — Swift
//! `Routes/WorkControlRoutes.swift` parity for the five routes the spawn closed
//! loop needs.
//!
//! ```text
//! POST   /v1/workspaces/{ws}/work-controls                  (agent bearer, work:control)
//! POST   /v1/workspaces/{ws}/work-controls/{control}/ack    (host owner | signed host)
//! GET    /v1/workspaces/{ws}/work-auto-approvals            (human)
//! PUT    /v1/workspaces/{ws}/work-auto-approvals/{tool}     (human)
//! DELETE /v1/workspaces/{ws}/work-auto-approvals/{tool}     (human)
//! ```
//!
//! ## The one rule this module exists to keep
//!
//! **A spawn reaches a host only through a decision somebody made.** There are
//! exactly two ways a `work_control` row becomes `dispatched`:
//!
//! 1. a human decided the approval bound to it
//!    ([`apply_spawn_approval_decision`], called from
//!    [`crate::routes::approvals`] inside the decision transaction), or
//! 2. the host's own owner had pre-authorised that tool
//!    (`work_auto_approve`, ADR-0114 D5).
//!
//! Both are the same person's authority. There is no third path, and the
//! database is what makes that true rather than this module's discipline:
//! `apply_spawn_approval_decision_in_tx` moves the row only when the control's
//! `approval_message_id` is the decided approval's `request_message_id`, and
//! `mark_control_dispatched_in_tx` moves it only from `approved`. A
//! `pending_approval` control has no statement in this binary that can dispatch
//! it.
//!
//! ## The daemon arm (#1114, closing #1132's first deviation)
//!
//! Swift accepts either the registering human owner *or* a `MomoHost`-signed
//! daemon (`acknowledge` :251-291). #1132 served only the human arm, for a
//! reason it stated rather than hid: the signed path was not on
//! `work_host_auth`'s allow-list, the authenticator pinned the signer against a
//! `{host}` segment this path does not have, and — decisively — the surface a
//! daemon learns *what* to acknowledge from
//! (`GET …/work-hosts/{host}/pending-controls`) was itself unported. All three
//! are addressed together here, because any two of them without the third
//! produce something worse than a gap: an authenticated caller with nothing to
//! authenticate about, or a queue nobody may answer.
//!
//! ## Named parity gaps (each refused by absence, not approximated)
//!
//! * **`POST …/work-sessions` with `controlId`.** Still refused by name
//!   (`work_sessions::reject_unsupported_create`) for the same reason: it is a
//!   work-host-signed arm. The in-process path that #1114 does close — the
//!   `work.session.spawn` tool — creates the session through the domain
//!   functions directly and binds the control to it
//!   (`momo_t3::work_control::bind_control_session_in_tx`), which is what Swift's
//!   `resume` does when it pre-allocates a session before writing its spawn
//!   control.
//!
//! ## Transaction shape
//!
//! One `tenant_tx` per request. Every rejection is returned through
//! [`Rejectable`] **before the first write**, so a refused request commits a
//! read-only transaction. The approval row, its card, the control binding and
//! the audit row commit together — a control that was `pending_approval` with no
//! approval behind it would be a spawn nobody can ever authorise or refuse.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_agent::approval::{
    attach_request_message_in_tx, create_pending_approval_in_tx, default_expires_at, NewApproval,
    DEFAULT_TTL_SECONDS,
};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_messaging::{cent_channel, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::work_control::{
    active_host_owner_in_tx, bind_control_approval_message_in_tx, control_event_payload,
    control_run_binding_in_tx, default_spawn_host, disable_auto_approve_in_tx,
    enable_auto_approve_in_tx, fail_approved_control_in_tx, insert_work_control_in_tx,
    last_used_spawn_host_in_tx, list_auto_approvals_in_tx, lock_work_control_in_tx,
    mark_control_dispatched_in_tx, record_host_last_used_in_tx,
    session_control_lineage_status_in_tx, settle_control_ack_in_tx,
    spawn_ack_session_matches_in_tx, spawn_execution_object, spawn_host_candidates_in_tx,
    spawn_is_auto_approved_in_tx, target_host_scope_allows, target_work_host_in_tx,
    validated_error_label, validated_payload, validated_session_shape, validated_tool_key,
    work_host_is_active_in_tx, NewWorkControl, WorkControlRow, ACTION_TYPE_WORK_SPAWN,
    APPROVAL_SOURCE_WORK_CONTROL, KIND_INPUT, KIND_KILL, KIND_READ, KIND_SPAWN, STATUS_APPROVED,
    STATUS_DISPATCHED, STATUS_PENDING_APPROVAL,
};
use momo_t3::{
    active_control_window_in_tx, expire_lapsed_control_windows_in_tx, work_tool_is_enabled_in_tx,
    T3Error,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::dto::{
    CreateWorkControlRequest, WorkAutoApprovalsResponse, WorkAutoApproveResponse,
    WorkControlAckRequest, WorkControlDto, WorkControlResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, path_uuid, require_human, settle, tenant_tx, workspace_scope, Rejectable,
};
use crate::AppState;

/// The `audit_log.action` values this surface writes (Swift's own strings).
const AUDIT_CONTROL_REQUESTED: &str = "work.control.requested";
const AUDIT_APPROVAL_REQUESTED: &str = "approval.requested";
const AUDIT_AUTO_APPROVE_ENABLED: &str = "work.auto_approve.enabled";
const AUDIT_AUTO_APPROVE_DISABLED: &str = "work.auto_approve.disabled";

const SCHEMA_CONTROL_REQUESTED: &str = "momo.work_control.requested.v1";
const SCHEMA_APPROVAL_REQUEST: &str = "momo.work_control.approval_request.v1";
const SCHEMA_AUTO_APPROVE_CHANGED: &str = "momo.work_auto_approve.changed.v1";

/// The label a dispatch answers with when the host was revoked between the
/// approval and the delivery (Swift `failDispatchForRevokedHost` :897).
const ERROR_HOST_REVOKED: &str = "host_revoked";

// ---------------------------------------------------------------------------
// wire shaping
// ---------------------------------------------------------------------------

pub(crate) fn control_dto(control: WorkControlRow) -> WorkControlDto {
    WorkControlDto {
        id: control.id.to_string(),
        workspace_id: control.workspace_id.to_string(),
        channel_id: control.channel_id.to_string(),
        requester_member_id: control.requester_member_id.to_string(),
        target_host_id: control.target_host_id.to_string(),
        session_id: control.session_id.map(|id| id.to_string()),
        kind: control.kind,
        payload: control.payload,
        status: control.status,
        approval_message_id: control.approval_message_id.map(|id| id.to_string()),
        created_at_ms: control.created_at_ms,
        updated_at_ms: control.updated_at_ms,
    }
}

/// Swift `validatedKind` (:547-552).
fn validated_kind(raw: &str) -> Result<&'static str, ApiError> {
    match raw {
        KIND_SPAWN => Ok(KIND_SPAWN),
        KIND_INPUT => Ok(KIND_INPUT),
        KIND_READ => Ok(KIND_READ),
        KIND_KILL => Ok(KIND_KILL),
        _ => Err(ApiError::bad_request(
            "kind must be spawn, input, read, or kill",
        )),
    }
}

fn rejection(message: &'static str) -> ApiError {
    ApiError::bad_request(message)
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-controls` → 201 (Swift `create`, :89-114).
///
/// Agent bearer only, and that is not a stylistic choice: a control names the
/// run it belongs to, and [`control_run_binding_in_tx`] proves the run is *this*
/// agent's and still open. A human bearer has no run to bind, so there is
/// nothing for the ledger to record on their behalf.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateWorkControlRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if principal.kind != PrincipalKind::Agent {
        return Err(ApiError::forbidden("work controls require an agent bearer"));
    }
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let kind = validated_kind(request.kind.trim())?;
    let payload = validated_payload(&request.payload, kind).map_err(|error| rejection(error.0))?;
    validated_session_shape(kind, request.session_id).map_err(rejection)?;

    let agent_member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let channel_id = request.channel_id;
    let run_id = request.run_id;
    let target_host_id = request.target_host_id;
    let session_id = request.session_id;

    let control = settle(
        "work_controls.create",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                create_in_tx(
                    conn,
                    CreateInput {
                        workspace_id,
                        agent_member_id,
                        via_token_id,
                        channel_id,
                        run_id,
                        target_host_id,
                        session_id,
                        kind,
                        payload,
                    },
                )
                .await
            })
        })
        .await,
    )?;

    Ok((
        StatusCode::CREATED,
        Json(WorkControlResponse {
            work_control: control_dto(control),
        }),
    ))
}

struct CreateInput {
    workspace_id: Uuid,
    agent_member_id: Uuid,
    via_token_id: Option<Uuid>,
    channel_id: Uuid,
    run_id: Uuid,
    target_host_id: Uuid,
    session_id: Option<Uuid>,
    kind: &'static str,
    payload: Value,
}

async fn create_in_tx(conn: &mut PgConnection, input: CreateInput) -> Rejectable<WorkControlRow> {
    // ---- rejections first (nothing is written above this line) -------------
    let Some(binding) = control_run_binding_in_tx(
        conn,
        input.workspace_id,
        input.channel_id,
        input.run_id,
        input.agent_member_id,
    )
    .await?
    else {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "agent run is not eligible for work control",
        )));
    };

    let Some(host) = target_work_host_in_tx(conn, input.workspace_id, input.target_host_id).await?
    else {
        // Missing, revoked and cross-workspace collapse to one non-disclosing
        // answer (Swift :978-980).
        return Ok(Err(ApiError::not_found("work host not found")));
    };
    if !target_host_scope_allows(&host, binding.owner_human_id) {
        return Ok(Err(ApiError::forbidden(
            "member-scoped work host belongs to another session owner",
        )));
    }

    let tool = input.payload.get("tool").and_then(Value::as_str);
    if input.kind == KIND_SPAWN {
        let Some(tool) = tool else {
            return Ok(Err(ApiError::bad_request(
                "spawn payload requires tool and label strings",
            )));
        };
        if !work_tool_is_enabled_in_tx(conn, input.workspace_id, tool).await? {
            return Ok(Err(ApiError::bad_request(
                "work tool is not registered or enabled",
            )));
        }
    } else {
        let session_id = input.session_id.expect("validated_session_shape");
        let Some(status) = session_control_lineage_status_in_tx(
            conn,
            input.workspace_id,
            input.channel_id,
            session_id,
            input.target_host_id,
            input.agent_member_id,
        )
        .await?
        else {
            return Ok(Err(ApiError::forbidden(
                "session is outside the approved requester lineage",
            )));
        };
        if (input.kind == KIND_INPUT || input.kind == KIND_KILL) && status != "running" {
            return Ok(Err(ApiError::new(
                StatusCode::CONFLICT,
                "input and kill require a running work session",
            )));
        }

        // ADR-0004 증보 3 D3 — 비관측, enforced rather than declared.
        //
        // While a person holds control of this session's screen, the agent's
        // access to the session is refused. This is the only server path an
        // agent has to a work session — `read` is its screen, `input` is its
        // keyboard, `kill` is its off switch, and both attach routes are
        // `require_human`, so an agent cannot mint a capability to watch either
        // surface directly. Refusing here is therefore not *a* block on
        // observation; it is the whole of it.
        //
        // It is deliberately the FIRST thing checked about the window and the
        // LAST rejection before any write: nothing above this line has written
        // anything, so an agent that asks during a window leaves no
        // `work_control` row, no dispatch and no audit trail of having tried to
        // look — which is what makes "the agent observed nothing" a statement
        // about the ledger and not just about delivery.
        //
        // 409 rather than 403: this is a state the session is temporarily in,
        // not a permission the agent lacks, and the difference is what tells a
        // runtime to wait rather than to give up. The refusal says only that
        // much. The timestamps an agent is entitled to — 정지 시각, 재개 시각,
        // 「사용자 개입 완료」 — arrive on the `work.session.control` envelope
        // that opening and closing a window emit, which is the surface a
        // runtime already watches; putting them in an error body instead would
        // deliver them only to whoever happened to lose a race.
        //
        // The lapsed-window sweep runs first so a window whose producer died is
        // not still blocking the agent on the strength of a stale row.
        //
        // A lapse is the one close nobody performs, so this is where it gets
        // announced: the person shut their laptop, the producer stopped
        // re-validating, and the 재개 event an agent is owed (증보 3 D3) has no
        // other author. Emitting from the detection point rather than from a
        // timer keeps the boundary events in the same transaction as the fact
        // they describe.
        //
        // This path holds no session lock, and does not need one: the window row
        // is closed by the statement below before `emit_control_closed_in_tx`
        // takes the run rows, which is the order
        // `momo_agent::run::lock_driver_runs_in_tx` contracts for — the run lock
        // is what serializes this resume against a window opening on another
        // session of the same run.
        for window in
            expire_lapsed_control_windows_in_tx(conn, input.workspace_id, session_id).await?
        {
            crate::routes::display_attach::emit_control_closed_in_tx(
                conn,
                input.workspace_id,
                input.channel_id,
                None,
                None,
                &window,
            )
            .await?;
        }
        if active_control_window_in_tx(conn, input.workspace_id, session_id)
            .await?
            .is_some()
        {
            return Ok(Err(ApiError::new(
                StatusCode::CONFLICT,
                "work session is under human control",
            )));
        }
    }

    // ADR-0114 D5. Only a spawn can be pre-authorised; input/read/kill are
    // already inside a lineage a human approved once.
    let auto_approved = match (input.kind, tool) {
        (KIND_SPAWN, Some(tool)) => {
            spawn_is_auto_approved_in_tx(conn, input.workspace_id, binding.owner_human_id, tool)
                .await?
        }
        _ => false,
    };
    let dispatch_now = auto_approved || input.kind != KIND_SPAWN;

    // ---- writes ------------------------------------------------------------
    let control = insert_work_control_in_tx(
        conn,
        input.workspace_id,
        NewWorkControl {
            channel_id: input.channel_id,
            requester_member_id: input.agent_member_id,
            target_host_id: input.target_host_id,
            session_id: input.session_id,
            kind: input.kind.to_string(),
            payload: input.payload.clone(),
            status: if dispatch_now {
                STATUS_APPROVED.to_string()
            } else {
                STATUS_PENDING_APPROVAL.to_string()
            },
        },
    )
    .await?;

    write_audit(
        conn,
        &AuditEntry::new(input.workspace_id, AUDIT_CONTROL_REQUESTED)
            .by(input.agent_member_id)
            .about(binding.owner_human_id)
            .target("work_control", control.id)
            .via_token(input.via_token_id)
            .run(input.run_id)
            .with_schema(
                SCHEMA_CONTROL_REQUESTED,
                json!({
                    "control_id": control.id.to_string(),
                    "run_id": input.run_id.to_string(),
                    "kind": input.kind,
                    "target_host_id": input.target_host_id.to_string(),
                    "auto_approved": auto_approved,
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    let settled = if dispatch_now {
        let settled = dispatch_control_in_tx(conn, input.workspace_id, &control).await?;
        // ADR-0125 D6-A "마지막 사용" (migration 061). Only a **spawn that
        // actually reached a host** counts: an `input`/`read`/`kill` addresses a
        // session whose host was chosen once already, and a dispatch that failed
        // on a revoked host is not a host anyone used. The pre-authorisation is
        // the owner's own standing decision, which is why their preference moves
        // here without a card ever being drawn.
        if input.kind == KIND_SPAWN && settled.status == STATUS_DISPATCHED {
            record_host_last_used_in_tx(
                conn,
                input.workspace_id,
                binding.owner_human_id,
                settled.target_host_id,
            )
            .await?;
        }
        settled
    } else {
        create_spawn_approval_in_tx(
            conn,
            SpawnApprovalInput {
                workspace_id: input.workspace_id,
                run_id: input.run_id,
                owner_human_id: binding.owner_human_id,
                via_token_id: input.via_token_id,
                control: &control,
            },
        )
        .await?
    };
    Ok(Ok(settled))
}

// ---------------------------------------------------------------------------
// dispatch + approval (shared with the decision route)
// ---------------------------------------------------------------------------

/// `approved` → `dispatched`, or `approved` → `failed` when the host was revoked
/// in between (Swift `enqueueDispatch` :813-869).
///
/// The liveness probe is a `FOR SHARE` read inside this transaction, so a
/// concurrent `DELETE …/work-hosts/{host}` either lands first (and this answers
/// `failed` with `host_revoked`) or blocks until this commits. ADR-0125 D8's
/// "revoke immediately stops control consumption" is that lock, not a check.
pub(crate) async fn dispatch_control_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control: &WorkControlRow,
) -> Result<WorkControlRow, T3Error> {
    if !work_host_is_active_in_tx(conn, workspace_id, control.target_host_id).await? {
        let Some(failed) = fail_approved_control_in_tx(conn, workspace_id, control.id).await?
        else {
            return Err(T3Error::IllegalTransition(format!(
                "work control {} is not approved for dispatch",
                control.id
            )));
        };
        emit_control_event(
            conn,
            workspace_id,
            &failed,
            "work.control.acked",
            Some(false),
            Some(ERROR_HOST_REVOKED),
        )
        .await?;
        return Ok(failed);
    }

    let Some(dispatched) = mark_control_dispatched_in_tx(conn, workspace_id, control.id).await?
    else {
        return Err(T3Error::IllegalTransition(format!(
            "work control {} is not approved for dispatch",
            control.id
        )));
    };
    emit_control_event(
        conn,
        workspace_id,
        &dispatched,
        "work.control.dispatched",
        None,
        None,
    )
    .await?;
    Ok(dispatched)
}

struct SpawnApprovalInput<'a> {
    workspace_id: Uuid,
    run_id: Uuid,
    owner_human_id: Uuid,
    via_token_id: Option<Uuid>,
    control: &'a WorkControlRow,
}

/// The approval a pending spawn waits on, its card, and the run hold (Swift
/// `createSpawnApproval` :658-811).
///
/// Two deliberate differences from Swift, both of them this server's own
/// doctrine rather than drift:
///
/// * **The card goes through `send_message_in_tx`.** Swift hand-writes the
///   `channel_seq` bump, the `message` insert and the broadcast payload; here
///   the message spine owns all three (invariants #2/#3/#4), so an approval card
///   takes a real `message.seq` like every other message.
/// * **The approval gets an `expires_at`.** Swift's work-control approval has
///   none. An approval nobody ever clicks would sit in every human's inbox
///   forever, which is exactly why `momo_agent::approval` made the deadline
///   non-optional and shipped a sweep for it. Inheriting the Swift gap would
///   have made this the one approval the sweep cannot reach.
/// * **The `agent_run` is NOT parked.** Swift moves the run to
///   `awaiting_approval` here (:754-761) and then — because the decision route
///   skips the generic agent flow for a work-control approval
///   (`shouldApplyGenericAgentDecisionFlow`) — never moves it back. On Swift
///   that is inert; here it would be actively wrong, because this server's
///   approval sweep ends an overdue parked run as `timed_out`, so an *approved*
///   spawn would kill the very run that asked for it. The control's own status
///   and its `work.control.*` envelopes are what a caller follows, and those are
///   the surface this ledger exists to provide.
async fn create_spawn_approval_in_tx(
    conn: &mut PgConnection,
    input: SpawnApprovalInput<'_>,
) -> Result<WorkControlRow, T3Error> {
    let control = input.control;
    let tool = control.tool().unwrap_or_default().to_string();
    let label = control.label().unwrap_or_default().to_string();

    // ADR-0125 D6-A — the picker's rows, judged for the human who will own the
    // session. The control already names a target host; the candidates say what
    // else that person could have chosen, which is what makes the card a
    // 실행 방식 컨펌 카드 rather than a yes/no.
    let candidates =
        spawn_host_candidates_in_tx(conn, input.workspace_id, input.owner_human_id).await?;
    // ADR-0125 D6-A's "마지막 사용" (migration 061). Read for the same person the
    // candidates were judged for — a default is a statement about whose habit it
    // is, and the requesting agent has none.
    let last_used =
        last_used_spawn_host_in_tx(conn, input.workspace_id, input.owner_human_id).await?;
    let execution = spawn_execution_object(
        &tool,
        &label,
        Some(control.target_host_id),
        default_spawn_host(&candidates, last_used).or(Some(control.target_host_id)),
        &candidates,
    );

    let now = chrono::Utc::now();
    let expires_at = default_expires_at(now, DEFAULT_TTL_SECONDS);
    let payload = json!({
        "source": APPROVAL_SOURCE_WORK_CONTROL,
        "work_control_id": control.id.to_string(),
        "target_host_id": control.target_host_id.to_string(),
        "on_behalf_of": input.owner_human_id.to_string(),
        "tool_call": {
            "call_id": control.id.to_string(),
            "name": ACTION_TYPE_WORK_SPAWN,
            "arguments": control.payload.clone(),
        },
        "execution": execution,
    });

    let approval_id = create_pending_approval_in_tx(
        conn,
        input.workspace_id,
        NewApproval {
            run_id: input.run_id,
            channel_id: control.channel_id,
            requested_by: control.requester_member_id,
            action_type: ACTION_TYPE_WORK_SPAWN.to_string(),
            payload: payload.clone(),
            expires_at,
        },
    )
    .await
    .map_err(T3Error::from)?;

    let props = json!({
        "kind": "work_control_approval",
        "approval_id": approval_id.to_string(),
        "control_id": control.id.to_string(),
        "run_id": input.run_id.to_string(),
        "action_type": ACTION_TYPE_WORK_SPAWN,
        "approval_status": "pending",
        "status": "pending",
        "tool": tool,
        "label": label,
        "target_host_id": control.target_host_id.to_string(),
        "expires_at_ms": expires_at.timestamp_millis(),
        "execution": execution,
    });
    let body = format!("Approval required: spawn {tool} — {label}");

    let card = send_message_in_tx(
        conn,
        input.workspace_id,
        NewMessage {
            channel_id: control.channel_id,
            author_member_id: control.requester_member_id,
            message_type: MessageType::ApprovalRequest,
            body: Some(body),
            props,
            root_id: None,
            reply_to_id: None,
            // One card per approval, whatever a retry does.
            client_msg_id: Some(approval_id),
            run_id: Some(input.run_id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await
    .map_err(T3Error::from)?;

    attach_request_message_in_tx(conn, input.workspace_id, approval_id, card.message.id)
        .await
        .map_err(T3Error::from)?;
    let Some(bound) =
        bind_control_approval_message_in_tx(conn, input.workspace_id, control.id, card.message.id)
            .await?
    else {
        return Err(T3Error::SessionNotFound);
    };

    write_audit(
        conn,
        &AuditEntry::new(input.workspace_id, AUDIT_APPROVAL_REQUESTED)
            .by(control.requester_member_id)
            .about(input.owner_human_id)
            .target("approval", approval_id)
            .via_token(input.via_token_id)
            .run(input.run_id)
            .with_schema(
                SCHEMA_APPROVAL_REQUEST,
                json!({
                    "approval_id": approval_id.to_string(),
                    "control_id": control.id.to_string(),
                    "run_id": input.run_id.to_string(),
                    "tool": tool,
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    Ok(bound)
}

/// Apply a human's verdict to the `work_control` a `work.spawn` approval owns,
/// inside the decision's own transaction (Swift `applySpawnApprovalDecision`
/// :489-533).
///
/// Called by [`crate::routes::approvals`] — the decision route owns the approval
/// row and this owns the control, and keeping the ownership split is what stops
/// two modules from each having an opinion about when a spawn dispatches.
pub(crate) async fn apply_spawn_approval_decision(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
    control_id: Uuid,
    approved: bool,
    selected_host_id: Option<Uuid>,
) -> Result<Option<WorkControlRow>, T3Error> {
    let Some(decided) = momo_t3::work_control::apply_spawn_approval_decision_in_tx(
        conn,
        workspace_id,
        approval_id,
        control_id,
        approved,
    )
    .await?
    else {
        return Ok(None);
    };
    if !approved {
        return Ok(Some(decided));
    }
    // A host swap is the whole point of the D6-A card: the human may send the
    // spawn somewhere other than where the agent proposed. The eligibility of
    // that choice was checked by the decision route against the candidate list
    // this approval published; retargeting here is the write half.
    let retargeted = match selected_host_id {
        Some(host_id) if host_id != decided.target_host_id => {
            momo_t3::work_control::retarget_control_host_in_tx(
                conn,
                workspace_id,
                decided.id,
                host_id,
            )
            .await?
            .unwrap_or(decided)
        }
        _ => decided,
    };
    // A tool disabled between the request and the decision must not run
    // (Swift :523-525).
    if let Some(tool) = retargeted.tool() {
        if !work_tool_is_enabled_in_tx(conn, workspace_id, tool).await? {
            return Err(T3Error::IllegalTransition(
                "work tool is not registered or enabled".to_string(),
            ));
        }
    }
    let dispatched = dispatch_control_in_tx(conn, workspace_id, &retargeted).await?;
    // ADR-0125 D6-A "마지막 사용" (migration 061): the person just told this
    // server where their work should run, and that answer outlives this card.
    // Attributed to the **session owner**, which is who the candidate list was
    // judged for — not to the approver, who may be a colleague with entirely
    // different hosts, and not to the requesting agent, which has none.
    if dispatched.status == STATUS_DISPATCHED {
        if let Some(owner_member_id) = momo_t3::work_control::agent_owner_human_in_tx(
            conn,
            workspace_id,
            dispatched.requester_member_id,
        )
        .await?
        {
            record_host_last_used_in_tx(
                conn,
                workspace_id,
                owner_member_id,
                dispatched.target_host_id,
            )
            .await?;
        }
    }
    Ok(Some(dispatched))
}

async fn emit_control_event(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control: &WorkControlRow,
    event_type: &str,
    ok: Option<bool>,
    error_label: Option<&str>,
) -> Result<(), T3Error> {
    let payload = control_event_payload(
        &cent_channel(workspace_id, control.channel_id),
        event_type,
        control,
        ok,
        error_label,
    );
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(control.channel_id),
    )
    .await
    .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ack
// ---------------------------------------------------------------------------

/// Who is allowed to say "this ran" (Swift `acknowledge` :250-291).
///
/// Two credentials, and they are checked against **different** facts: a human
/// must be the host's registered owner, a signed daemon must *be* the host the
/// control was addressed to. Collapsing them — say, by letting any signed host
/// ack, or by trusting a human who merely shares the workspace — would let one
/// party close the loop on another party's machine, and every later
/// `input`/`read`/`kill` trusts that lineage
/// (`session_control_lineage_status_in_tx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AckCaller {
    /// A human bearer, to be compared against `work_host.owner_member_id`.
    HostOwner(Uuid),
    /// A `MomoHost`-signed daemon, to be compared against
    /// `work_control.target_host_id`.
    SigningHost(Uuid),
}

/// `POST /v1/workspaces/{ws}/work-controls/{control}/ack` (Swift `acknowledge`,
/// :248-357) — both arms.
///
/// #1132 served only the human arm and named the reason: the signed daemon had
/// no way to *learn* what to acknowledge, so authenticating it would have been
/// "an authenticated caller with nothing to authenticate about". `GET
/// …/work-hosts/{host}/pending-controls` is that missing half and it lands in
/// the same change, so the loop closes here.
///
/// **`work:control` is still not enough to ack.** The agent-bearer scope that
/// lets an agent *request* a control deliberately does not reach this route
/// (`momo_auth::required_agent_scope`): if the same credential could both ask
/// for a spawn and report that it ran, an agent could manufacture a session the
/// host has never seen, and everything downstream would believe it.
pub async fn acknowledge(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, control)): Path<(String, String)>,
    Json(request): Json<WorkControlAckRequest>,
) -> Result<Json<WorkControlResponse>, ApiError> {
    let caller = match principal.kind {
        PrincipalKind::Human => AckCaller::HostOwner(principal.member_id),
        // The signed branch of `auth::require_principal` puts the HOST id in
        // `token_id` (Swift: `tokenID: identity.hostID`). A work-host principal
        // without one would be a middleware bug, not a client error.
        PrincipalKind::WorkHost => match principal.token_id {
            Some(host_id) => AckCaller::SigningHost(host_id),
            None => return Err(crate::work_host_auth::signed_request_unauthorized()),
        },
        PrincipalKind::Agent => {
            return Err(ApiError::forbidden(
                "work control ack requires the execution host",
            ))
        }
    };
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let control_id = path_uuid(&control, "invalid work control id")?;
    let error_label = validated_error_label(request.error_label.as_deref()).map_err(rejection)?;
    if request.ok && error_label.is_some() {
        return Err(ApiError::bad_request(
            "successful ack cannot include errorLabel",
        ));
    }
    let ok = request.ok;
    let session_id = request.session_id;

    let settled = settle(
        "work_controls.ack",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                acknowledge_in_tx(
                    conn,
                    workspace_id,
                    caller,
                    control_id,
                    ok,
                    session_id,
                    error_label.as_deref(),
                )
                .await
            })
        })
        .await,
    )?;

    Ok(Json(WorkControlResponse {
        work_control: control_dto(settled),
    }))
}

#[allow(clippy::too_many_arguments)]
async fn acknowledge_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    caller: AckCaller,
    control_id: Uuid,
    ok: bool,
    session_id: Option<Uuid>,
    error_label: Option<&str>,
) -> Rejectable<WorkControlRow> {
    let Some(locked) = lock_work_control_in_tx(conn, workspace_id, control_id).await? else {
        return Ok(Err(ApiError::not_found("work control not found")));
    };
    if locked.status != STATUS_DISPATCHED {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "only dispatched controls can be acknowledged",
        )));
    }
    // Swift resolves the host owner for BOTH arms (:275-282) and so does this:
    // a control addressed to a host whose registration is gone cannot be
    // acknowledged by anyone, which is ADR-0125 D8 again — revocation stops
    // consumption, including the last message of a consumption that was already
    // under way.
    let Some(owner_member_id) =
        active_host_owner_in_tx(conn, workspace_id, locked.target_host_id).await?
    else {
        return Ok(Err(ApiError::not_found("work host not found")));
    };
    match caller {
        AckCaller::HostOwner(member_id) if owner_member_id != member_id => {
            return Ok(Err(ApiError::forbidden(
                "only the registered host owner can acknowledge",
            )));
        }
        AckCaller::SigningHost(host_id) if host_id != locked.target_host_id => {
            return Ok(Err(ApiError::forbidden(
                "work host cannot acknowledge another host control",
            )));
        }
        _ => {}
    }

    let ack_session_id = if locked.kind == KIND_SPAWN && ok {
        let Some(session_id) = session_id else {
            return Ok(Err(ApiError::bad_request(
                "successful spawn ack requires sessionId",
            )));
        };
        if !spawn_ack_session_matches_in_tx(conn, &locked, session_id).await? {
            return Ok(Err(ApiError::new(
                StatusCode::CONFLICT,
                "spawn ack session does not match work_session",
            )));
        }
        Some(session_id)
    } else {
        if let Some(supplied) = session_id {
            if Some(supplied) != locked.session_id {
                return Ok(Err(ApiError::bad_request(
                    "ack sessionId does not match control",
                )));
            }
        }
        session_id.or(locked.session_id)
    };

    let Some(settled) =
        settle_control_ack_in_tx(conn, workspace_id, control_id, ok, ack_session_id).await?
    else {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work control state changed; retry",
        )));
    };
    emit_control_event(
        conn,
        workspace_id,
        &settled,
        "work.control.acked",
        Some(ok),
        error_label,
    )
    .await?;
    Ok(Ok(settled))
}

// ---------------------------------------------------------------------------
// auto-approvals (ADR-0114 D5)
// ---------------------------------------------------------------------------

/// `GET /v1/workspaces/{ws}/work-auto-approvals` (Swift `listAutoApprovals`,
/// :369-405).
///
/// The caller's **own** settings only. Auto-approval is a statement about whose
/// hosts may be used without asking, so reading someone else's would be reading
/// the shape of their consent.
pub async fn list_auto_approvals(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<WorkAutoApprovalsResponse>, ApiError> {
    require_human(&principal, "auto-approve settings require a human owner")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let tools = settle(
        "work_controls.list_auto_approvals",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(
                    list_auto_approvals_in_tx(conn, workspace_id, member_id).await?
                ))
            })
        })
        .await,
    )?;
    Ok(Json(WorkAutoApprovalsResponse { tools }))
}

/// `PUT /v1/workspaces/{ws}/work-auto-approvals/{tool}` (Swift, :359-362).
pub async fn enable_auto_approve(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Json<WorkAutoApproveResponse>, ApiError> {
    mutate_auto_approve(state, principal, path, true).await
}

/// `DELETE /v1/workspaces/{ws}/work-auto-approvals/{tool}` (Swift, :364-367).
pub async fn disable_auto_approve(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Json<WorkAutoApproveResponse>, ApiError> {
    mutate_auto_approve(state, principal, path, false).await
}

async fn mutate_auto_approve(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, tool)): Path<(String, String)>,
    enabled: bool,
) -> Result<Json<WorkAutoApproveResponse>, ApiError> {
    require_human(&principal, "auto-approve settings require a human owner")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let tool = validated_tool_key(&tool).map_err(|error| rejection(error.0))?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let stored = tool.clone();

    settle(
        "work_controls.mutate_auto_approve",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Enabling a tool the workspace has disabled would store a
                // setting that can never fire; refusing it is how "disabled"
                // keeps meaning something (Swift :427-434).
                if enabled && !work_tool_is_enabled_in_tx(conn, workspace_id, &stored).await? {
                    return Ok(Err(ApiError::bad_request(
                        "work tool is not registered or enabled",
                    )));
                }
                let changed = if enabled {
                    enable_auto_approve_in_tx(conn, workspace_id, member_id, &stored).await?
                } else {
                    disable_auto_approve_in_tx(conn, workspace_id, member_id, &stored).await?
                };
                // A no-op retry writes no audit row: an audit trail that records
                // settings that did not change cannot be read as a history of
                // changes.
                if changed {
                    let mut entry = AuditEntry::new(
                        workspace_id,
                        if enabled {
                            AUDIT_AUTO_APPROVE_ENABLED
                        } else {
                            AUDIT_AUTO_APPROVE_DISABLED
                        },
                    )
                    .by(member_id)
                    .about(member_id)
                    .via_token(via_token_id)
                    .with_schema(
                        SCHEMA_AUTO_APPROVE_CHANGED,
                        json!({ "tool": stored, "enabled": enabled }),
                    );
                    // `work_auto_approve` has no synthetic id — its primary key
                    // is (workspace, owner, tool) — so the row is named by type
                    // and detail, exactly as Swift writes it (:471-475).
                    entry.target_type = Some("work_auto_approve".to_string());
                    write_audit(conn, &entry).await?;
                }
                Ok(Ok(()))
            })
        })
        .await,
    )?;

    Ok(Json(WorkAutoApproveResponse { tool, enabled }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kind_vocabulary_is_closed() {
        for kind in [KIND_SPAWN, KIND_INPUT, KIND_READ, KIND_KILL] {
            assert_eq!(validated_kind(kind).unwrap(), kind);
        }
        assert_eq!(
            validated_kind("restart").unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        assert!(
            validated_kind("Spawn").is_err(),
            "the check constraint is case-sensitive"
        );
    }

    /// The card's execution object, pinned. A client draws radio buttons from
    /// these keys, so a rename here is a broken picker, not a refactor.
    #[test]
    fn the_execution_object_names_the_choice_and_its_default() {
        let host = Uuid::from_u128(7);
        let execution = spawn_execution_object("codex", "run", Some(host), Some(host), &[]);
        assert_eq!(execution["kind"], "work_session_spawn");
        assert_eq!(execution["tool"], "codex");
        assert_eq!(execution["requested_host_id"], host.to_string());
        assert_eq!(execution["default_host_id"], host.to_string());
        assert_eq!(execution["host_candidates"], json!([]));

        // No eligible host at all: the card still renders, and says so by
        // carrying a null default rather than silently pre-selecting nothing.
        let empty = spawn_execution_object("codex", "run", None, None, &[]);
        assert_eq!(empty["requested_host_id"], Value::Null);
        assert_eq!(empty["default_host_id"], Value::Null);
    }
}
