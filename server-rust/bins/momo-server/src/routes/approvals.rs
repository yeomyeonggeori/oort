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
    action_by_id, action_ref, action_result_props, agent_invite_result_body,
    agent_profile_update_result_body, agent_rename_result_body, channel_create_result_body,
    channel_create_result_rows, channel_member_add_result_body, channel_member_add_rows,
    invite_result_body, invite_result_rows, last_attempt_patch, memory_update_result_body,
    memory_update_result_rows, plugin_install_result_body, plugin_install_result_rows,
    result_client_msg_id, unfurl_update_result_body, unfurl_update_rows,
    work_tier_update_result_body, work_tier_update_rows, workspace_settings_result_body,
    ActionResult, ActionResultNext, RequiredRole, SecretDelivery, ACTION_APPROVED_AUDIT_SCHEMA,
    ACTION_RESULT_EXECUTED, ACTION_TYPE_WORKSPACE_ACTION, AUDIT_ACTION_APPROVED,
    AUDIT_AGENT_AVATAR_UPDATED, AUDIT_AGENT_AVATAR_UPDATED_SCHEMA, AUDIT_AGENT_INVITED,
    AUDIT_AGENT_INVITED_SCHEMA, AUDIT_AGENT_PROFILE_UPDATED, AUDIT_AGENT_PROFILE_UPDATED_SCHEMA,
    AUDIT_CHANNELS_GRANTED, AUDIT_CHANNELS_GRANTED_SCHEMA, AUDIT_CHANNEL_CREATED,
    AUDIT_CHANNEL_CREATED_SCHEMA, AUDIT_CHANNEL_MEMBER_ADDED, AUDIT_CHANNEL_MEMBER_ADDED_SCHEMA,
    AUDIT_MEMBER_RENAMED, AUDIT_MEMBER_RENAMED_SCHEMA, AUDIT_MEMORY_SETTINGS_UPDATED,
    AUDIT_MEMORY_SETTINGS_UPDATED_SCHEMA, AUDIT_UNFURL_SETTING_UPDATED,
    AUDIT_UNFURL_SETTING_UPDATED_SCHEMA, AUDIT_WORKSPACE_SETTING_UPDATED,
    AUDIT_WORKSPACE_SETTING_UPDATED_SCHEMA, AUDIT_WORK_TIER_POLICY_CHANGED,
    AUDIT_WORK_TIER_POLICY_CHANGED_SCHEMA, DEFAULT_INVITE_EXPIRES_IN_DAYS, INVITE_RESULT_NEXT,
    LAST_ATTEMPT_PROPS_KEY, REF_TYPE_AGENT, REF_TYPE_CHANNEL, REF_TYPE_HOSTED_CONNECTION,
    REF_TYPE_INVITE, REF_TYPE_MEMBER, REF_TYPE_MESSAGE, REF_TYPE_WORKSPACE_SETTINGS, ROLE_REQUIRED,
    SECRET_ONCE_INVITE_LINK, SECRET_ONCE_PAIRING,
};
use momo_agent::approval::{
    decided_props_patch, decision_broadcast_payload, decision_event_payload, decision_receipt,
    decision_stamp_in_tx, default_execution_host, existing_decision_in_tx,
    is_active_channel_member_in_tx, is_active_human_member_in_tx, is_overdue, list_approvals_in_tx,
    lock_approval_in_tx, mark_approval_decided_in_tx, mark_approval_expired_in_tx,
    normalized_reason, offers_host_choice, record_decision_in_tx, reference_execution_host,
    resume_job_payload, selectable_host_ids, validated_limit, validated_status, ApprovalListRow,
    LockedApproval,
};
use momo_agent::decider::{action_required_role, decider_gate, GatePlan};
use momo_agent::tools::{ToolResult, TOOL_AUDIT_SCHEMA};
use momo_agent::{
    end_parked_run_in_tx, pinned_target_member, requeue_run_from_approval_in_tx,
    succeed_parked_run_in_tx, RunStatus,
};
use momo_auth::{
    active_hosted_connection_in_tx, append_approved_channels_in_tx, grant_hosted_channels_in_tx,
    hosted_action_connection_in_tx, lock_hosted_connection_in_tx, HostedActionConnection,
    Principal, PrincipalKind, AUDIT_VIA_PUSH_ACTION, MAX_HOSTED_APPROVED_CHANNELS,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_messaging::{
    add_channel_member_in_tx, apply_agent_card_in_tx, apply_avatar_image_in_tx,
    apply_human_avatar_image_in_tx, cent_channel, clear_avatar_image_in_tx,
    create_channel_detailed_in_tx, delete_staged_avatar_image_in_tx, emit_message_edited_in_tx,
    lock_agent_card_in_tx, normalize_channel_kind, patch_and_prune_message_props_in_tx,
    patch_message_props_in_tx, read_avatar_image_bytes_in_tx, read_avatar_image_in_tx,
    rename_agent_display_name_in_tx, send_message_in_tx, set_pin_in_tx,
    staged_image_matches_pin_in_tx, AgentCard, AgentCardPatch, CardStatusPatch, FieldPatch,
    MessageType, NewChannel, NewMessage, PinAction,
};
use momo_outbox::{emit_outbox, OutboxKind, RESUME_APPROVAL_JOB_METHOD};
use momo_settings::{
    create_invite, merge_workspace_settings, read_workspace_settings_for_update,
    write_workspace_settings, INVITE_CREATED_AUDIT_ACTION, INVITE_CREATED_AUDIT_SCHEMA,
};
use momo_t3::work_control::{spawn_host_ineligible_reason_in_tx, work_control_id};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::PushActionCredential;
use crate::config::T3Settings;
use crate::dev_credential::DevCredential;
use crate::dto::{
    ApprovalDecisionReceipt, ApprovalDecisionRequest, ApprovalDto, ApprovalListQuery,
    ApprovalListResponse, SecretOnceDto,
};
use crate::error::ApiError;
use crate::plugin_writes::{self, Actor, Provenance};
use crate::realtime_advert::derive_same_origin_http_base;
use crate::routes::actions::{
    profile_changes, resolve_stored_action_in_tx, resolve_stored_initiative_action_in_tx,
    ActionArgs, AvatarIntent, GateSubject, ResolvedAgentTarget, ResolvedChannel,
    ResolvedConnection, ResolvedMember, ResolvedMessage, ResolvedPlugin, SettingPatch,
    SettingsBefore, StatusIntent,
};
use crate::routes::agents::require_profile_editor_in_tx;
use crate::routes::invites::require_admin;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, emit_terminal_agent_status, epoch_ms,
    has_platform_read_scope, path_uuid, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::routes::webhooks::no_store;
use crate::AppState;

/// `?v=` of the avatar preview: the image's sha256 (64 hex characters).
#[derive(Debug, serde::Deserialize)]
pub struct AvatarPreviewQuery {
    v: Option<String>,
}

/// `GET /v1/workspaces/{ws}/approvals/{approval}/avatar-preview?v={sha256}`
/// (ADR-0186 증보 v3 V3-2a) — **the picture the approver is being asked about**.
///
/// The card's `preview` block names the staged image and its sha256; this route is
/// the one place those bytes can be read before the decision. Who may read them:
/// the people who may *decide* the card — a human who is the target agent's owner
/// or a workspace admin (`require_profile_editor_in_tx`, the very judgment the
/// decision applies); for a `member.avatar.set` card, the person the picture is for
/// and nobody else (ADR-0186 증보 v4). Everybody else — a channel member who is not the owner, a
/// stranger, an agent, an unknown approval id, an approval with no staged avatar —
/// gets the same 404, so the route is neither a preview for onlookers nor an oracle
/// for which approvals carry an image.
///
/// The bytes are the server's re-encoded ones; `?v` must be their sha256 (a
/// different value is a 404, so a cached URL can never show another image); the
/// response carries the stored mime only, `nosniff` and the sandbox CSP like the
/// avatar content proxy.
pub async fn avatar_preview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, approval)): Path<(String, String)>,
    Query(query): Query<AvatarPreviewQuery>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human approver required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let approval_id = path_uuid(&approval, "invalid approval id")?;
    let viewer = principal.member_id;

    let outcome: DbRejectable<Option<momo_messaging::AgentAvatarBytes>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some((action_type, _status, payload)) =
                    momo_agent::approval::read_approval_payload_in_tx(
                        conn,
                        workspace_id,
                        approval_id,
                    )
                    .await?
                else {
                    return Ok(Ok(None));
                };
                if action_type != ACTION_TYPE_WORKSPACE_ACTION {
                    return Ok(Ok(None));
                }
                let args = payload.get("action").and_then(|action| action.get("args"));
                let avatar = args.and_then(|args| args.get("avatar"));
                let Some(image_id) = avatar
                    .filter(|avatar| avatar.get("source").and_then(Value::as_str) == Some("staged"))
                    .and_then(|avatar| avatar.get("imageId"))
                    .and_then(Value::as_str)
                    .and_then(|id| Uuid::parse_str(id).ok())
                else {
                    return Ok(Ok(None));
                };
                let Some(target) = payload
                    .get("action")
                    .and_then(|action| action.get("pins"))
                    .and_then(|pins| pins.get("target"))
                    .and_then(Value::as_str)
                    .and_then(|id| Uuid::parse_str(id).ok())
                else {
                    return Ok(Ok(None));
                };
                // The decider's own judgment, answered as "not found" on any no. For a
                // `member.avatar.set` card the decider is the person the picture is for
                // and nobody else (ADR-0186 증보 v4): not an admin, not the agent's owner,
                // not another member of the room.
                let is_member_avatar_card = payload
                    .get("action")
                    .and_then(|action| action.get("id"))
                    .and_then(Value::as_str)
                    == Some(momo_agent::actions::ACTION_MEMBER_AVATAR_SET);
                if is_member_avatar_card {
                    if target != viewer {
                        return Ok(Ok(None));
                    }
                } else if require_profile_editor_in_tx(conn, workspace_id, target, viewer)
                    .await?
                    .is_err()
                {
                    return Ok(Ok(None));
                }
                let image = read_avatar_image_bytes_in_tx(conn, workspace_id, image_id).await?;
                Ok(Ok(image.filter(|image| image.image.member_id == target)))
            })
        })
        .await;
    let Some(image) = settle_db("approvals.avatar_preview", outcome)? else {
        return Err(ApiError::not_found("avatar preview not found"));
    };
    let sha_hex: String = image
        .image
        .sha256
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let cache_control = match query.v.as_deref() {
        Some(v) if v == sha_hex => "private, max-age=31536000, immutable",
        Some(_) => return Err(ApiError::not_found("avatar preview not found")),
        None => "private, no-cache",
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, image.image.mime)
        .header(header::CONTENT_LENGTH, image.bytes.len().to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::CACHE_CONTROL, cache_control)
        .body(axum::body::Body::from(image.bytes))
        .map_err(|error| ApiError::internal("approvals.avatar_preview.response", error))
}

/// The body of the `tool_result` a rejection appends (Swift :847).
const REJECTED_TOOL_RESULT_BODY: &str = "Tool call rejected by human approval.";

/// ADR-0188 D3 (R0) — the receipt `status` a principal that is not a person is
/// refused with: 「결정 라우트는 사람 principal만 받는다」.
const HUMAN_PRINCIPAL_REQUIRED: &str = "human_principal_required";

/// ADR-0216 D4 / #4660 — the receipt `status` a **developer token** is refused with: a
/// token a person minted for a terminal tool never decides an approval. The closed
/// route table already keeps both decision routes off the developer door (first
/// layer, judged before the database); this is the second layer, inside the one
/// function both routes share, so a future change to either the table or a route's
/// extractors cannot quietly reopen the decision to a tool.
const DEV_CANNOT_DECIDE: &str = "dev_cannot_decide";

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
/// `deliverSecretToAgent: true` on a decision that cannot honour it (ADR-0186
/// 증보 v3 V3-3a). 400, and the approval is not consumed.
const DELIVER_SECRET_NOT_SUPPORTED: &str = "deliver_secret_not_supported";

/// The receipt `status` of a lock-screen decision refused because the approval must
/// be opened in the app (ADR-0204 D7): the native handler turns any 403 into 「눌러서
/// 앱에서 마무리」 (D6).
const OPENS_IN_APP: &str = "opens_in_app";

/// The sentinel itself. Namespaced and versioned so it cannot collide with a
/// genuine `sqlx::Error::Protocol` message from the driver.
const RUN_NOT_PARKED_SENTINEL: &str = "momo.approvals.run_not_parked.v1";

/// How many times a decision is run when it keeps being chosen as a deadlock's victim: the
/// first, and one more. See [`decide`].
const DECISION_ATTEMPTS: u32 = 2;

/// Is this PostgreSQL's `deadlock_detected` (SQLSTATE `40P01`) — the rollback of a transaction
/// that lost a lock cycle, with nothing committed — rather than a failure that running the
/// decision again would only repeat?
fn is_deadlock_victim(error: &momo_db::DbError) -> bool {
    matches!(
        error,
        momo_db::DbError::Sqlx(momo_db::sqlx::Error::Database(database))
            if database.code().as_deref() == Some("40P01")
    )
}

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

pub(crate) fn approval_dto(row: &ApprovalListRow) -> ApprovalDto {
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
    // Present only when the middleware verified a `typ = push_action` token — the
    // lock screen's credential (#3927, ADR-0204 D6). It names the door in the audit
    // log and may only NARROW the route (`opens_in_app` is refused for it): it is
    // never a reason to allow anything an access token could not, because the token
    // adds no authority.
    credential: Option<Extension<PushActionCredential>>,
    // Present only when the middleware verified a developer token (ADR-0216, #4660).
    // It can only make this route refuse (`decide` answers `dev_cannot_decide`).
    dev_credential: Option<Extension<DevCredential>>,
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
        credential.map(|_| AUDIT_VIA_PUSH_ACTION),
        dev_credential.is_some(),
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
    // See `decide_by_approval`: present only for a developer token, and only able to
    // make `decide` refuse. Taken by BOTH routes so neither is a way around the check.
    dev_credential: Option<Extension<DevCredential>>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Result<Response, ApiError> {
    let run_id = path_uuid(&run, "invalid run id")?;
    let workspace_id = principal.workspace_id;
    let approval_id = request.approval_id;
    // Not a door the lock-screen token can use (the middleware's route list has
    // exactly one entry), so there is never a credential to name here.
    decide(
        state,
        principal,
        workspace_id,
        approval_id,
        Some(run_id),
        &headers,
        request,
        None,
        dev_credential.is_some(),
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

#[allow(clippy::too_many_arguments)]
async fn decide(
    state: AppState,
    principal: Principal,
    workspace_id: Uuid,
    approval_id: Uuid,
    route_run_id: Option<Uuid>,
    headers: &HeaderMap,
    request: ApprovalDecisionRequest,
    credential_via: Option<&'static str>,
    by_dev_credential: bool,
) -> Result<Response, ApiError> {
    // **ADR-0216 D4 (#4660) — a developer token never decides.**
    //
    // A developer token authenticates as a *person* (the `Principal` it travels with is
    // `Human`), so the kind check right below does not stop it, and the closed route
    // table is the first and only other layer. This is the second: it sits in the one
    // function both decision routes call, before the idempotency replay and before any
    // row is read, so a tool cannot read a stored receipt through this route either.
    // The marker is inserted only by the developer-token branch of the middleware.
    if by_dev_credential {
        return respond(refusal(
            approval_id,
            principal.member_id,
            DEV_CANNOT_DECIDE,
            "approval decisions are not available to a developer token",
            StatusCode::FORBIDDEN,
            Utc::now(),
        ));
    }

    // **ADR-0188 D3 (R0) — the decision route takes a person, and only a
    // person.**
    //
    // First, before the idempotency replay and before any row is read: a
    // principal that is not a person must not be able to read even a stored
    // receipt through this route. One kind matters above all. A signed work
    // host's principal carries its **owner's** `member_id`
    // (`auth::authenticate_signed_host`), so every membership predicate below
    // would pass it — and a laptop could approve work onto itself as the person
    // who owns it. The route is not on the host signature allow-list
    // (`work_host_auth::is_allowed_signed_path` — ADR-0188: 「host 서명
    // allow-list에 넣지 않는다」), so no such principal reaches here today; this
    // check is what keeps that true if the allow-list ever moves. An agent
    // bearer is refused by the middleware's scope table and again here.
    if principal.kind != PrincipalKind::Human {
        return respond(refusal(
            approval_id,
            principal.member_id,
            HUMAN_PRINCIPAL_REQUIRED,
            "approval decisions require a human principal",
            StatusCode::FORBIDDEN,
            Utc::now(),
        ));
    }

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
    let claude_subscription_agents_enabled =
        state.agent_port.config.claude_subscription_agents_enabled;
    let operator_scope = has_platform_read_scope(&principal);
    let deliver_secret_to_agent = request.deliver_secret_to_agent == Some(true);
    let context_max_messages = state.mentions.context_max_messages;

    // **A decision that PostgreSQL picks as the victim of a deadlock is run once more.**
    //
    // A decision is one transaction with no effect outside the database, and its replay is
    // idempotent by `client_decision_id` — so a rollback by `40P01` committed nothing and the
    // whole remedy is to run it again. It is needed because the decision's lock order cannot be
    // made to agree with every writer it meets: it takes the proposer's hosted connection and
    // inbox counter *before* the channel's `channel_seq` (ADR-0186 증보 v5 U-f, so that two
    // decisions on one DM do not deadlock with each other), while the message spine takes the
    // channel first and fans out to the same connection after. A message sent into that room in
    // the same instant is the other half of an AB/BA pair, and without this the loser of the
    // pair — here, the person's tap — answered 500. (#4702 security review.) Once, not in a
    // loop: a second deadlock is a different problem and answers as it always did.
    let mut attempt = 1;
    let outcome: DbRejectable<Decision> = loop {
        let outcome = agent_tenant_tx(&state.pool, workspace_id, {
            let reason = reason.clone();
            let public_origin = public_origin.clone();
            move |conn| {
                Box::pin(async move {
                    decide_in_tx(
                        conn,
                        DecisionInput {
                            workspace_id,
                            approval_id,
                            route_run_id,
                            member_id,
                            via_token_id,
                            credential_via,
                            approve,
                            reason: reason.as_deref(),
                            client_decision_id,
                            selected_host_id,
                            public_origin: public_origin.as_deref(),
                            claude_subscription_agents_enabled,
                            operator_scope,
                            deliver_secret_to_agent,
                            context_max_messages,
                        },
                    )
                    .await
                })
            }
        })
        .await;
        match &outcome {
            Err(error) if attempt < DECISION_ATTEMPTS && is_deadlock_victim(error) => {
                attempt += 1;
                tracing::warn!(
                    approval_id = %approval_id,
                    "an approval decision was the victim of a deadlock; running it once more"
                );
            }
            _ => break outcome,
        }
    };

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
    respond(decision)
}

/// Answer a settled decision: the receipt, the one-time value grafted on when
/// there is one, and `no-store` on every outcome.
fn respond(decision: Decision) -> Result<Response, ApiError> {
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
    /// The door the decider came through when it was not an ordinary access
    /// token (`Some("push_action")` for the lock screen's token, #3927) —
    /// stamped into `detail.via` of the decision's own audit rows by [`stamp_via`]
    /// and read by the `opens_in_app` refusal. It can only narrow what the decider
    /// may do; it is never an input to a grant.
    credential_via: Option<&'static str>,
    approve: bool,
    reason: Option<&'a str>,
    client_decision_id: Uuid,
    /// ADR-0125 D6-A (#1114) — the host the approver picked on the card.
    selected_host_id: Option<Uuid>,
    /// The absolute origin an invite link should point at, or `None` when this
    /// instance cannot name itself (ADR-0186 부록 C).
    public_origin: Option<&'a str>,
    /// `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED` (#3431, ADR-0193 D18).
    claude_subscription_agents_enabled: bool,
    /// The decider's principal carries the platform operator scope — one of the
    /// two ways to satisfy `RequiredRole::WorkspaceOperator`
    /// (`routes::shared::has_platform_read_scope`).
    operator_scope: bool,
    /// `deliverSecretToAgent` as sent. Only `Some(true)` matters.
    deliver_secret_to_agent: bool,
    /// `MentionSettings::context_max_messages` — the recent-conversation window
    /// of the job an approved in-place channel grant releases (ADR-0162 증보 5 G3).
    context_max_messages: i64,
}

/// Name the door a decision came through in one of its OWN audit rows
/// (`detail.via`), when it was not an ordinary access token (#3927).
///
/// `via_token_id` already points every row at the exact `token` row, whose label
/// says the same thing; this is the human-readable half, on the rows a reader
/// asks "how was this decided?" of. A `via` the row already carries is left
/// alone — the in-place grant's `channels.granted` row uses that key for which
/// door the *grant* came through, and a credential must not overwrite it. A
/// non-object detail is returned unchanged.
fn stamp_via(via: Option<&'static str>, mut detail: Value) -> Value {
    if let (Some(via), Some(object)) = (via, detail.as_object_mut()) {
        object.entry("via").or_insert_with(|| json!(via));
    }
    detail
}

/// Would this decision hand a value-shown-once to the lock screen's credential?
/// A pure function so the rule is testable: no seeded approval reaches the call
/// site while the `opens_in_app` refusal in front of it holds (that is the point).
fn shows_a_value_to_the_lock_screen(credential_via: Option<&str>, secret_present: bool) -> bool {
    credential_via.is_some() && secret_present
}

/// Whether the action a `workspace_action` payload names offers its one-time
/// value to the proposing agent **at the approver's choice**
/// (`SecretDelivery::OptIn`). An unknown or missing id is `false`, so the early
/// guard refuses.
fn payload_offers_opt_in_delivery(payload: &Value) -> bool {
    payload
        .get("action")
        .and_then(|action| action.get("id"))
        .and_then(Value::as_str)
        .and_then(action_by_id)
        .is_some_and(|action| action.secret_delivery == SecretDelivery::OptIn)
}

/// The early `deliverSecretToAgent` guard as a pure function (so its whole truth
/// table is measurable, including the `OptIn` row no action occupies yet): a
/// `true` is honoured only when **approving** a **workspace action** whose
/// registry entry offers `OptIn` delivery (`offers_opt_in`).
fn deliver_flag_refused(
    deliver_requested: bool,
    action_type: &str,
    approve: bool,
    offers_opt_in: bool,
) -> bool {
    deliver_requested && !(action_type == ACTION_TYPE_WORKSPACE_ACTION && approve && offers_opt_in)
}

/// Is this card one that answers a person **outside its room** as a missing approval does? The
/// in-place channel-grant card (it names a room and who called whom there) and the card an agent
/// raised unasked (it stands in its owner's one-to-one direct message and says what the agent wants
/// to do there). One definition for both decision routes' two places that ask.
fn card_is_hidden_from_outsiders(approval: &LockedApproval) -> bool {
    momo_agent::in_place_grant::is_in_place_grant(&approval.payload)
        || momo_agent::initiative::is_unasked_card(approval)
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
            // A card that is hidden from outsiders (below) is hidden here too: whether the run in
            // the path is the card's must not be a way to tell "there is such a card" from "there
            // is none" — to anybody outside the room it answers what a missing approval answers
            // (review of #4704 PR B, M1; the in-place card had the same gap).
            if card_is_hidden_from_outsiders(&approval)
                && !is_active_channel_member_in_tx(conn, approval.channel_id, input.member_id)
                    .await?
            {
                return Ok(Ok(refusal(
                    input.approval_id,
                    input.member_id,
                    "not_found",
                    "approval not found",
                    StatusCode::NOT_FOUND,
                    now,
                )));
            }
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
        // ADR-0162 증보 5 G2/G6 ⑤ — an in-place channel-grant card names a room
        // (possibly private) and who called whom there. To somebody outside that
        // room, an admin included, it answers exactly as a missing approval does,
        // so the id teaches them nothing.
        //
        // ADR-0186 증보 v5 U-c (#4704 PR B, review M8) — the same for a card an agent raised
        // unasked: it stands in its owner's one-to-one direct message and says what the agent
        // wants to do there, so to anybody outside that room — a workspace admin included — the
        // id answers as a missing approval does (`403 forbidden` would confirm the card exists,
        // and whose room it is in). Judged by either server-written marker, like the executor.
        if card_is_hidden_from_outsiders(&approval) {
            return Ok(Ok(refusal(
                input.approval_id,
                input.member_id,
                "not_found",
                "approval not found",
                StatusCode::NOT_FOUND,
                now,
            )));
        }
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            "forbidden",
            "not a member of this approval channel",
            StatusCode::FORBIDDEN,
            now,
        )));
    }

    // **The lock screen's credential never decides an approval that must be
    // opened in the app** (ADR-0204 D6/D7, security review of #3927): one that mints
    // a value shown once (an invite link, a pairing code — `agent.invite` would put
    // the code in THIS response's body) or whose card asks the approver to pick a
    // host. The push is categorised the same way (`momo.approval.open`, no buttons),
    // but that is the client's half; this is the server's, so a mis-categorised card,
    // a stale notification or a leaked token cannot turn a banner tap into those
    // effects. Approve and reject alike (the open category has neither button).
    // Judged straight after the membership gate — a non-member keeps its 403/404 —
    // and before anything is read or written for the decision. The credential only
    // ever NARROWS the route here; it never grants (the token adds no authority).
    if input.credential_via.is_some()
        && momo_agent::actions::opens_in_app(&approval.action_type, &approval.payload)
    {
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            OPENS_IN_APP,
            "this approval must be decided in the app",
            StatusCode::FORBIDDEN,
            now,
        )));
    }

    // **`deliverSecretToAgent` is only meaningful on the approve half of a
    // workspace action** (ADR-0186 증보 v3 V3-3a). Anywhere else it is a
    // malformed request. Judged straight after the membership gate and *before*
    // the status and expiry arms, so it can never be outranked by an expiry
    // settlement (which writes) — a security review (#3795) caught the first
    // draft placing it after that arm.
    if deliver_flag_refused(
        input.deliver_secret_to_agent,
        &approval.action_type,
        input.approve,
        payload_offers_opt_in_delivery(&approval.payload),
    ) {
        return Ok(Ok(refusal(
            approval.id,
            input.member_id,
            DELIVER_SECRET_NOT_SUPPORTED,
            "deliverSecretToAgent applies only to approving a workspace action",
            StatusCode::BAD_REQUEST,
            now,
        )));
    }

    if approval.status != "pending" {
        let status = approval.status.clone();
        // The receipt names whoever **settled** it and when — not the person who
        // pressed the button just now (#3771). A card approved at 22:52 must not
        // answer a second click with 「승인 · 22:54」. A system settlement keeps
        // its `NULL` decider; a row that vanished mid-lock falls back to the old
        // shape (it cannot be reached under `FOR UPDATE`, but the receipt must
        // still decode).
        let (decided_by, decided_at) = decision_stamp_in_tx(conn, input.workspace_id, approval.id)
            .await?
            .map(|(by, at)| (by, at.unwrap_or(now)))
            .unwrap_or((Some(input.member_id), now));
        return Ok(Ok(Decision {
            receipt: decision_receipt(
                approval.id,
                &status,
                decided_by,
                decided_at,
                Some(&format!("approval is already {status}")),
            ),
            status: StatusCode::CONFLICT,
            secret_once: None,
        }));
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

    // ---- ADR-0188 R0: work headed to a remote (member-scoped) host ----------
    //
    // The host this decision is **about** ([`decision_reference_host`]) — when
    // approving, the host the spawn finally runs on, which is why this follows
    // the host choice — and its owner when it is a remote host.
    let remote_host = match decision_reference_host(&approval, &input, &host_choice) {
        Some(host_id) => {
            momo_t3::work_control::remote_host_owner_in_tx(conn, input.workspace_id, host_id)
                .await
                .map_err(control_failure)?
                .map(|owner| (host_id, owner))
        }
        None => None,
    };

    // ADR-0188 D3 — 결정자 = host 소유자. Work headed to somebody's own machine
    // is their call and nobody else's: not a channel member's, not a workspace
    // admin's. The membership check above stays necessary; for this host it
    // stops being sufficient.
    if let Some((_, owner)) = remote_host {
        if owner != input.member_id {
            return Ok(Ok(refusal(
                approval.id,
                input.member_id,
                momo_t3::work_control::REFUSAL_REMOTE_HOST_OWNER_REQUIRED,
                "only the work host's owner can decide work headed to it",
                StatusCode::FORBIDDEN,
                now,
            )));
        }
    }

    // ADR-0188 D6 — 원격 shell 금지. Refused even when the owner approves it:
    // the invariant is about the tool, not the decider (ADR-0188 §3). Only an
    // approval can put a tool on a host, so only an approval is judged — against
    // the host it would really land on, which covers the spawn an agent aimed
    // at a team box and the owner redirected to their laptop.
    if let (true, Some((host_id, _))) = (input.approve, remote_host) {
        let Some(tool) = spawn_execution_tool(&approval.payload) else {
            // `spawn_execution_object` always writes `tool` beside the
            // candidates, so a card that offers hosts without naming its tool
            // was written wrong — answered like a malformed binding, never
            // followed onto somebody's laptop.
            return Ok(Ok(refusal(
                approval.id,
                input.member_id,
                "internal_error",
                "spawn approval names no tool",
                StatusCode::INTERNAL_SERVER_ERROR,
                now,
            )));
        };
        if momo_t3::work_control::remote_host_refuses_tool_in_tx(
            conn,
            input.workspace_id,
            host_id,
            tool,
        )
        .await
        .map_err(control_failure)?
        {
            return Ok(Ok(refusal(
                approval.id,
                input.member_id,
                momo_t3::work_control::REFUSAL_REMOTE_HOST_SHELL,
                "a shell cannot be spawned on a member-scoped work host",
                StatusCode::FORBIDDEN,
                now,
            )));
        }
    }

    // ADR-0188 R0.1 (A′) — 「에이전트 컨트롤은 member-scope host에 kill만」,
    // enforced where the row would be made. Only a spawn card asks a host
    // question (`remote_host` is `Some` only then), so the control this approval
    // releases is a spawn — never the `kill` an agent keeps — and whoever
    // requested it is its origin (`requested_by`: the agent, on the REST
    // ledger's card and on the spawn tool's alike). An agent's spawn is never
    // approved onto somebody's own machine, by its owner included: approving it
    // would only make a dispatched row the poll withholds. Refused before the
    // first write, so the card stays pending — the decider can still pick a
    // workspace host, or reject. The origin is read rather than assumed, although
    // every spawn card is an agent's today: the rule is about agents, and a card
    // a person asks for themselves (ADR-0188 R2) must not inherit it by accident.
    if let (true, Some(_)) = (input.approve, remote_host) {
        if momo_t3::work_control::member_is_agent_in_tx(
            conn,
            input.workspace_id,
            approval.requested_by,
        )
        .await
        .map_err(control_failure)?
        {
            return Ok(Ok(refusal(
                approval.id,
                input.member_id,
                momo_t3::work_control::REFUSAL_MEMBER_HOST_AGENT_CONTROL,
                "an agent's work cannot be sent to a member-scoped work host; pick a \
                 workspace host or reject",
                StatusCode::FORBIDDEN,
                now,
            )));
        }
    }

    // #3431 (ADR-0193 D18) — a shared host (workspace-scoped or cloud) does not
    // run Claude Code while the Claude opt-in is off, whoever approves: any
    // channel member may decide work headed to a shared host, and the Claude
    // login on that machine may be somebody else's, which the server cannot
    // see. Judged on the host the spawn will finally run on, so a retarget to
    // a team box is caught too. Refused before the first write — the card stays
    // pending, and the decider can pick another host or reject.
    if let (true, false, Some(host_id), Some(tool)) = (
        input.approve,
        input.claude_subscription_agents_enabled,
        host_choice.selected,
        spawn_execution_tool(&approval.payload),
    ) {
        if momo_t3::work_control::shared_host_refuses_claude_in_tx(
            conn,
            input.workspace_id,
            host_id,
            tool,
        )
        .await
        .map_err(control_failure)?
        {
            return Ok(Ok(refusal(
                approval.id,
                input.member_id,
                momo_t3::work_control::REFUSAL_CLAUDE_SUBSCRIPTION_PAUSED,
                momo_t3::work_control::CLAUDE_SHARED_HOST_PAUSED_MESSAGE,
                StatusCode::CONFLICT,
                now,
            )));
        }
    }

    // ---- expiry: settle it rather than merely refusing (Swift :198-221) ----
    //
    // `is_overdue` is the one definition of 「past its deadline」 (ADR-0186 증보 v5
    // U-f): the status an agent is told on a re-ask reads the same predicate on the
    // same application clock, so the two agree at the boundary.
    if is_overdue(approval.expires_at, now) {
        // An expired proposal's staged avatar image dies with it.
        discard_staged_avatar_in_tx(conn, &approval).await?;
        return Ok(Ok(settle_expired(
            conn,
            &approval,
            input.member_id,
            input.via_token_id,
            input.credential_via,
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
    // ADR-0162 증보 5 G2 — an in-place 「이 채널에서 쓰기」 card has ONE decider
    // for both halves: a workspace admin who is in the room (the membership
    // gate above). The approve half is gated inside `execute_workspace_action`;
    // without this the reject half fell through to the generic arm, so any room
    // member could cancel somebody else's request and the outcome line would
    // claim 「관리자가 … 승인하지 않아서」 (independent review of #3858). Refused
    // like the approve half — nothing spent, run still held, card still pending.
    //
    // The condition is `decider_gate`'s reject half — the same function the push
    // judgment reads (ADR-0204 D7), so what the route refuses and who the push
    // wakes are one rule.
    if !input.approve
        && decider_gate(&approval.action_type, &approval.payload, false) == GatePlan::Admin
        && require_admin(conn, input.workspace_id, input.member_id)
            .await?
            .is_err()
    {
        return role_required_refusal(conn, &approval, &input, now, Some(RequiredRole::Admin))
            .await;
    }
    // A rejected proposal's staged avatar image dies with it (the 24-hour sweep on
    // the next avatar proposal is the backstop for the arms that never get here,
    // such as a run cancelled by a person).
    if approval.action_type == ACTION_TYPE_WORKSPACE_ACTION && !input.approve {
        discard_staged_avatar_in_tx(conn, &approval).await?;
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
        announce_card_edit(conn, input.workspace_id, message_id).await?;
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
            .with_schema(
                TOOL_AUDIT_SCHEMA,
                // A copy: `event` is also the resume job's input and the
                // broadcast, and neither is told which credential decided
                // (nor that the card was raised unasked: the audit row says so).
                momo_agent::initiative::decision_audit_detail(
                    &approval,
                    stamp_via(input.credential_via, event.clone()),
                ),
            ),
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
// ADR-0186 D2/D4 — the workspace-action executor (#2509, generalised by 증보 S0)
//
// Everything below happens inside the decision transaction that locked the
// approval `FOR UPDATE`, with the **approver's** authority. The agent that
// proposed it is not an admin at any point; it is not even consulted here. What
// it gets is its own name on the outcome line, because the proposal was its
// utterance.
//
// The order is the ADR's, and each step's placement is load-bearing:
//
//   1. the role gate            — before the first write except the card patch;
//                                 a role judged against a *subject* (AgentEditor)
//                                 waits for step 2 because the subject is only
//                                 known once the arguments are resolved
//   2. the arguments, re-proved — from the stored payload, never trusted as-is,
//                                 and resolved against the workspace as it is now
//   3. the action's own executor — which may refuse before ITS first write
//                                 (an invite needs a link origin)
//   4. audit · settle · post · finish · broadcast — one tail for every action
// ---------------------------------------------------------------------------

/// What one action's executor hands back to the shared tail.
///
/// An executor writes its domain rows (and may add to `audits`) and describes
/// the outcome; it never touches the approval, the card, the result line or the
/// run. Those are the tail's, because they are the same for every action and a
/// copy per action is how one of them would forget to prune `last_attempt`.
struct Executed {
    /// Domain audit rows (`invite.created`, `channel.created`, …), written
    /// **before** `action.approved`. Built by the executor because only it knows
    /// the target and the detail; carries no secret.
    audits: Vec<AuditEntry>,
    ref_type: &'static str,
    ref_id: Uuid,
    /// The outcome line's body. As durable as the props beside it.
    result_body: String,
    result_rows: Vec<Value>,
    /// The 1회 value (D4), grafted onto the response by [`decide`] and written
    /// nowhere else. `None` for every action but `invite.create`.
    secret_once: Option<SecretOnceDto>,
    next: Option<ActionResultNext>,
}

/// An executor either ran, or refused **before its first write**.
enum Execution {
    Ran(Executed),
    Refused(Decision),
}

/// Announce a card the decision route just rewrote (#3771).
///
/// `patch_message_props_in_tx` and `patch_and_prune_message_props_in_tx` move
/// `message.props` and, by design, publish nothing. The decision's own
/// `approval.decided` envelope was meant to carry the news, but the web
/// timeline renders the `approval_request` card from the **message** it holds
/// and does not read that envelope, so every viewer kept `status: pending`
/// until a reload and the 승인/거부 buttons came back on a card that had been
/// decided (measured on prod, 2026-10-13: the second click got 「이미 승인으로
/// 기록되어 있었어요」).
///
/// This publishes the existing `message.edited` frame — the whole row, props
/// included, at the message's own `seq` — which every client already applies in
/// place (`momo_messaging::emit_message_edited_in_tx`, the same door the login
/// handoff card uses). It stamps no `edited_at`, so no 「수정됨」 appears.
async fn announce_card_edit(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
) -> Result<(), momo_db::DbError> {
    emit_message_edited_in_tx(conn, workspace_id, message_id).await?;
    Ok(())
}

/// Tell the agent that **proposed a workspace action** that a person has decided
/// it — one `agent_run` reference in its hosted inbox, in the decision's own
/// transaction (ADR-0186 증보 v5 U-f, #4702).
///
/// ## Why this exists
///
/// The outcome line is written through the raw spine ([`send_message_in_tx`]),
/// which projects nothing into an inbox, and its author is the proposing agent —
/// which the inbox would skip anyway. So the outcome of every proposal was visible
/// only to an agent that happened to wake up and re-read the conversation, and
/// nothing woke it. The reference is that signal (the doorbell rings on any inbox
/// growth, ADR-0171). A proposal a person asked for gets it exactly as a proposal
/// nobody asked for does.
///
/// ## Who gets one — and who does not
///
/// Only the proposer's **own** live hosted connection, and only when the run's
/// channel is one that connection covers (`append_run_reference_in_tx`'s own
/// authority predicate is the judge; nothing is added here). A managed agent has no
/// hosted connection and gets nothing — no regression for them. Another hosted
/// agent in the same room gets nothing: the target is explicit, never a fan-out.
/// A replay writes nothing new (the writer is idempotent per run and connection).
///
/// ## Where it sits — before the outcome line
///
/// Every caller writes this **before** its `channel_seq` bump. The reference takes
/// the connection first (the hosted canon's lock order: connection → … →
/// counter), and several executors already hold that row `FOR UPDATE`
/// (`channel.create`, `hosted.channels.grant`) before the outcome line; a decision
/// that locked the channel first and the connection second would deadlock against
/// one of those on a DM that carries two cards.
///
/// ## What it never does: expiry
///
/// Neither the sweep nor the late-tap arm calls this. The sweep runs as
/// `momo_notifier`, which holds no grant on `token` or on the inbox tables on
/// purpose (`bootstrap_runtime_roles.sql`: that role is BYPASSRLS and must not
/// read credentials), so an inbox write there would raise `permission denied` in
/// production, roll the workspace's whole sweep back, and leave every run
/// `awaiting_approval`. A lapse is also not something a person said — waking an
/// agent for it would invite a new proposal every deadline. Expiry is told on a
/// re-ask instead ([`momo_agent::approval::effective_status`]).
///
/// Only `workspace_action` approvals are told. Every other approval kind belongs to
/// a managed agent's own tool loop, which has its own resume job.
async fn wake_proposer_in_tx(
    conn: &mut PgConnection,
    approval: &LockedApproval,
) -> Result<(), momo_db::DbError> {
    if approval.action_type != ACTION_TYPE_WORKSPACE_ACTION {
        return Ok(());
    }
    let Some(connection_id) =
        active_hosted_connection_in_tx(conn, approval.workspace_id, approval.requested_by)
            .await
            .map_err(momo_db::DbError::from)?
    else {
        return Ok(());
    };
    momo_messaging::append_run_reference_in_tx(
        conn,
        approval.workspace_id,
        approval.requested_by,
        connection_id,
        approval.channel_id,
        approval.run_id,
    )
    .await?;
    Ok(())
}

/// The `role_required` refusal: the approval is **not consumed** (ADR-0186 D2) —
/// no ledger row, no status change, the run stays parked. What changes is the
/// card, so a person who tapped and was refused sees why on the surface they
/// tapped, and an admin scrolling past sees that somebody already tried.
async fn role_required_refusal(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    role: Option<RequiredRole>,
) -> DbRejectable<Decision> {
    if let Some(message_id) = approval.request_message_id {
        patch_message_props_in_tx(
            conn,
            input.workspace_id,
            message_id,
            &last_attempt_patch(ROLE_REQUIRED),
        )
        .await?;
        announce_card_edit(conn, input.workspace_id, message_id).await?;
    }
    Ok(Ok(refusal(
        approval.id,
        input.member_id,
        ROLE_REQUIRED,
        match role {
            Some(RequiredRole::AgentEditor) => {
                "this workspace action must be approved by the target agent's owner or a workspace admin"
            }
            Some(RequiredRole::RequestingMember) => {
                "this workspace action must be approved by the member it changes"
            }
            Some(RequiredRole::WorkspaceOperator) => {
                "this workspace action must be approved by a workspace operator"
            }
            Some(RequiredRole::Admin) | None => {
                "this workspace action must be approved by a workspace admin"
            }
        },
        StatusCode::FORBIDDEN,
        now,
    )))
}

/// A proposal that no longer holds: the approval stays pending and nothing is
/// spent (ADR-0186 증보 V1-d — one word for every way a card can go stale, so
/// the client vocabulary does not grow).
/// Delete the staged avatar image a workspace-action approval points at, if any
/// (ADR-0186 증보 v3 V3-2a): the rejected and expired arms. Only a `staged` row can
/// be deleted here — an `applied` image is never touched — and a payload without a
/// staged avatar is a no-op.
async fn discard_staged_avatar_in_tx(
    conn: &mut PgConnection,
    approval: &LockedApproval,
) -> Result<(), momo_db::DbError> {
    if approval.action_type != ACTION_TYPE_WORKSPACE_ACTION {
        return Ok(());
    }
    let avatar = approval
        .payload
        .get("action")
        .and_then(|action| action.get("args"))
        .and_then(|args| args.get("avatar"));
    let staged = avatar
        .filter(|avatar| avatar.get("source").and_then(Value::as_str) == Some("staged"))
        .and_then(|avatar| avatar.get("imageId"))
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok());
    if let Some(image_id) = staged {
        delete_staged_avatar_image_in_tx(conn, approval.workspace_id, image_id).await?;
    }
    Ok(())
}

/// 64 lowercase hex characters → the 32-byte digest, or `None`.
fn decode_pin_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 {
        return None;
    }
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn args_invalid_refusal(
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
) -> Decision {
    refusal(
        approval.id,
        input.member_id,
        "action_args_invalid",
        "this proposal's arguments are no longer valid",
        StatusCode::CONFLICT,
        now,
    )
}

/// Approve a `workspace_action`: run it here, now, as the person who said yes.
async fn execute_workspace_action(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
) -> DbRejectable<Decision> {
    // ---- 1. the gate is the existing surface's own -------------------------
    //
    // Each arm CALLS the function the REST route applies (`require_admin`,
    // `has_platform_read_scope`, `require_profile_editor_in_tx`) rather than
    // copying it: ADR-0186 D2 says the judgement is 「기존 … 와 같은 판정」, and
    // two implementations of one rule drift the day either is widened.
    //
    // The `match` is exhaustive on purpose: the registry publishes a
    // `required_role` per action, and calling `require_admin` unconditionally
    // would make a second action with a different gate silently admin-gated.
    // Adding a `RequiredRole` variant fails to compile in
    // `momo_agent::decider::gate_plan`, which is where the decision about its
    // gate belongs — and, because that is also what the push judgment reads
    // (`decider_gate`, ADR-0204 D7), the new gate reaches the notification
    // audience in the same change instead of drifting from it.
    let required_role = action_required_role(&approval.payload);
    let subject_free_gate = match decider_gate(&approval.action_type, &approval.payload, true) {
        // A workspace action always takes a role; `decider_gate` only answers
        // "no role" for approvals that are not workspace actions, and this
        // function is reached for nothing else. If that ever stops being true the
        // gate must not quietly vanish: roll the decision back instead of waving
        // it through.
        GatePlan::ChannelMember => {
            return Err(protocol_error(
                "workspace action reached the executor with no role gate",
            ));
        }
        // Judged against the target agent, which step 2 resolves.
        GatePlan::TargetAgent => None,
        // Judged against the person the run was raised by, which step 2 resolves too.
        GatePlan::RequestingMember => None,
        GatePlan::Operator => Some(if input.operator_scope {
            Ok(())
        } else {
            require_admin(conn, input.workspace_id, input.member_id).await?
        }),
        GatePlan::Admin => Some(require_admin(conn, input.workspace_id, input.member_id).await?),
    };
    if subject_free_gate.is_some_and(|gate| gate.is_err()) {
        return role_required_refusal(conn, approval, input, now, required_role).await;
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

    // `deliverSecretToAgent` was already judged against this very action by the
    // early guard in `decide_in_tx` (`deliver_flag_refused`), which runs before the
    // expiry arm; a second copy here could never disagree with it, so there is
    // none. The slice that first gives an action `SecretDelivery::OptIn` adds the
    // honoured path *here*, with its own test.

    // The stored `args` are re-run through the **same** resolver the proposal
    // passed (`routes::actions::resolve_stored_action_in_tx`), for the reason ADR-0186
    // D2 gives: 「저장값을 신뢰하지 않는다」. The card may be an hour old, the
    // ceilings may have narrowed, a channel name may have been taken or an agent
    // may have left a room since, and the row is writable by anything that can
    // write `approval.payload`. Re-proving is the difference between "a person
    // approved these values" and "a person approved a row".
    let now_ms = now.timestamp_millis();
    // A card nobody asked for was drawn for **its reader's** eyes (ADR-0186 증보 v5 U-b-4 6): the
    // channel or message it quotes had to be one the reader could already read, and a
    // `channel.create` had to be private. The same rules are judged again here, for the member who
    // is deciding it — who must be able to read what the card quotes, and, for a pin, to pin it.
    //
    // Which rules apply is decided by **either** marker: the payload's `origin` and the run's
    // `input.hold` (written by the server alone, and the run is born with it). A row whose `origin`
    // was dropped is still an unasked card while its run says so — and an unasked card can only ever
    // name an initiative action, so a tampered `action.id` is refused rather than judged by the
    // looser rules of a card a person asked for (security review of #4704, M2).
    let initiated = momo_agent::initiative::is_unasked_card(approval);
    if initiated && !action.initiative {
        return Ok(Ok(args_invalid_refusal(approval, input, now)));
    }
    // **The decision proves the door again** (ADR-0186 증보 v5 U-d 「재증명」): a card may be a day
    // old, and everything that let an agent raise it can have changed since. The switch is on, the
    // connection it was raised through still stands (that connection, active and proved, its
    // credential not revoked — a credential that merely lapsed is routine, an OAuth access token
    // lives thirty minutes and the card a day), the human's approval of it still names
    // `workspace:initiate`, the agent is active and not paused, the person deciding is the agent's
    // **current** owner and the one who confirmed that connection, and (above) the action is still on
    // the list. One `action_args_invalid` for any of them (409, the approval is **not** consumed): a
    // card that no longer stands is not a card to run, and a rejection never comes through here, so a
    // person can always say no.
    //
    // What comes back is the connection the card stands on. It is what the resolver below reads
    // coverage from and what `channel.create` widens — the row that was just proved, and not
    // whichever connection happens to hold a fresh credential at this instant (security review of
    // #4704 PR B, round 2, H1).
    let card_connection = if initiated {
        match crate::routes::agent_initiative::card_still_stands_in_tx(
            conn,
            input.workspace_id,
            approval,
            input.member_id,
        )
        .await?
        {
            Some(connection) => Some(connection),
            None => return Ok(Ok(args_invalid_refusal(approval, input, now))),
        }
    } else {
        None
    };
    let resolution = if let Some(card_connection) = card_connection {
        resolve_stored_initiative_action_in_tx(
            conn,
            input.workspace_id,
            approval.requested_by,
            input.member_id,
            Some(approval.run_id),
            action,
            proposed_args(&approval.payload),
            now_ms,
            approval.id,
            card_connection,
        )
        .await?
    } else {
        resolve_stored_action_in_tx(
            conn,
            input.workspace_id,
            approval.requested_by,
            Some(approval.run_id),
            action,
            proposed_args(&approval.payload),
            now_ms,
            approval.id,
        )
        .await?
    };
    let resolved = match resolution {
        Ok(resolved) => resolved,
        Err(error) if error.message == crate::routes::actions::AVATAR_UNRESOLVED => {
            // The avatar check runs **after** the target resolved, so the target is
            // known — it is in the pins — and the decider can be judged against it:
            // the owner or an admin is told the picture is no longer what the card
            // showed (`action_args_invalid`); anyone else gets the generic
            // `role_required`, which teaches them nothing.
            let pinned_target = approval
                .payload
                .get("action")
                .and_then(|action| action.get("pins"))
                .and_then(|pins| pins.get("target"))
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok());
            // A picture that is no longer what a `member.avatar.set` card showed is told
            // to the person it was drawn for, and to nobody else.
            if required_role == Some(RequiredRole::RequestingMember) {
                if pinned_target == Some(input.member_id) {
                    return Ok(Ok(args_invalid_refusal(approval, input, now)));
                }
                return role_required_refusal(conn, approval, input, now, required_role).await;
            }
            if let Some(target) = pinned_target {
                if require_profile_editor_in_tx(conn, input.workspace_id, target, input.member_id)
                    .await?
                    .is_ok()
                {
                    return Ok(Ok(args_invalid_refusal(approval, input, now)));
                }
            }
            return role_required_refusal(conn, approval, input, now, required_role).await;
        }
        Err(_) => {
            // An unresolvable *target* must not teach a non-eligible decider
            // anything about the workspace. For the subject-judged role the gate
            // has not run, so a decider who is not at least an admin gets the
            // generic `role_required` — only an authorised decider sees that the
            // card went stale.
            if required_role == Some(RequiredRole::AgentEditor)
                && require_admin(conn, input.workspace_id, input.member_id)
                    .await?
                    .is_err()
            {
                return role_required_refusal(conn, approval, input, now, required_role).await;
            }
            // The same for the person-judged role: only the person the card was drawn for
            // may learn that it went stale (an admin may not — an admin is not who decides).
            if required_role == Some(RequiredRole::RequestingMember)
                && pinned_target_member(&approval.payload) != Some(input.member_id)
            {
                return role_required_refusal(conn, approval, input, now, required_role).await;
            }
            return Ok(Ok(args_invalid_refusal(approval, input, now)));
        }
    };

    if required_role == Some(RequiredRole::AgentEditor) {
        // Fail closed: an `AgentEditor` action whose resolver named no agent has
        // nobody to judge the decider against.
        let GateSubject::Agent(agent_member_id) = resolved.subject else {
            return Err(protocol_error(
                "agent_editor action resolved without a target agent",
            ));
        };
        match require_profile_editor_in_tx(
            conn,
            input.workspace_id,
            agent_member_id,
            input.member_id,
        )
        .await?
        {
            Ok(()) => {}
            // The target vanished between resolution and the gate (the same
            // transaction, but the row is unlocked here): the proposal is stale.
            //
            // But only an admin may be told so: `require_profile_editor_in_tx`
            // answers 404 before it looks at the decider's authority, so for
            // anyone else a 404-vs-403 difference would be an oracle for whether
            // that member id is a live agent. They get `role_required` either way.
            Err(error) if error.status == StatusCode::NOT_FOUND => {
                if require_admin(conn, input.workspace_id, input.member_id)
                    .await?
                    .is_err()
                {
                    return role_required_refusal(conn, approval, input, now, required_role).await;
                }
                return Ok(Ok(args_invalid_refusal(approval, input, now)));
            }
            Err(_) => {
                return role_required_refusal(conn, approval, input, now, required_role).await;
            }
        }
    }

    if required_role == Some(RequiredRole::RequestingMember) {
        // Fail closed: a `requesting_member` action whose resolver named no person has
        // nobody to judge the decider against.
        let GateSubject::Member(person) = resolved.subject else {
            return Err(protocol_error(
                "requesting_member action resolved without a person",
            ));
        };
        // **Only the person the picture is for.** Not an admin, not the agent's owner:
        // `person` is the human the server derived from the run, so this one comparison
        // is the whole of "you may only change your own face".
        if person != input.member_id {
            return role_required_refusal(conn, approval, input, now, required_role).await;
        }
    }

    // The ids this card was drawn from must be the ids the names resolve to now.
    // (After the subject gate above, so a decider who is not eligible learns
    // nothing about whether the target moved.)
    let stored_pins = approval
        .payload
        .get("action")
        .and_then(|action| action.get("pins"))
        .unwrap_or(&Value::Null);
    if stored_pins != &resolved.pins {
        return Ok(Ok(args_invalid_refusal(approval, input, now)));
    }

    // ---- 3. the action's own executor --------------------------------------
    let mut executed = match &resolved.validated.args {
        ActionArgs::WorkspaceSettingsUpdate {
            welcome_prompt,
            role_labels,
            before,
        } => {
            match execute_workspace_settings_update(
                conn,
                approval,
                input,
                now,
                welcome_prompt,
                role_labels,
                before,
            )
            .await?
            {
                Execution::Ran(executed) => executed,
                Execution::Refused(decision) => return Ok(Ok(decision)),
            }
        }
        ActionArgs::WorkspaceUnfurlUpdate { enabled, before } => {
            execute_workspace_unfurl_update(conn, approval, input, *enabled, *before).await?
        }
        ActionArgs::WorkspaceMemoryUpdate { enabled, paused } => {
            execute_workspace_memory_update(conn, approval, input, *enabled, *paused).await?
        }
        ActionArgs::WorkspaceWorkTierUpdate {
            mode, auto_target, ..
        } => {
            match execute_workspace_work_tier_update(
                conn,
                approval,
                input,
                now,
                mode,
                auto_target.as_deref(),
            )
            .await?
            {
                Execution::Ran(executed) => executed,
                Execution::Refused(decision) => return Ok(Ok(decision)),
            }
        }
        ActionArgs::HostedChannelsGrant {
            connection: Some(connection),
            channels,
            ..
        } => {
            match execute_hosted_channels_grant(conn, approval, input, now, connection, channels)
                .await?
            {
                Execution::Ran(executed) => executed,
                Execution::Refused(decision) => return Ok(Ok(decision)),
            }
        }
        ActionArgs::HostedChannelsGrant {
            connection: None, ..
        } => {
            return Err(protocol_error(
                "hosted.channels.grant resolved without a connection",
            ));
        }
        ActionArgs::AgentRename {
            display_name,
            target: Some(target),
            ..
        } => match execute_agent_rename(conn, approval, input, display_name, target).await? {
            Execution::Ran(executed) => executed,
            Execution::Refused(decision) => return Ok(Ok(decision)),
        },
        ActionArgs::AgentRename { target: None, .. } => {
            return Err(protocol_error("agent.rename resolved without a target"));
        }
        ActionArgs::AgentProfileUpdate {
            display_name,
            tagline,
            role_label,
            status,
            avatar,
            target: Some(target),
            before: Some(before),
            ..
        } => match execute_agent_profile_update(
            conn,
            approval,
            input,
            now,
            AgentProfileChange {
                display_name,
                tagline,
                role_label,
                status,
                avatar,
            },
            target,
            before,
        )
        .await?
        {
            Execution::Ran(executed) => executed,
            Execution::Refused(decision) => return Ok(Ok(decision)),
        },
        ActionArgs::AgentProfileUpdate { .. } => {
            return Err(protocol_error(
                "agent.profile.update resolved without a target",
            ));
        }
        ActionArgs::AgentInvite {
            platform,
            display_name,
            handle,
        } => match execute_agent_invite(conn, approval, input, now, platform, display_name, handle)
            .await?
        {
            Execution::Ran(executed) => executed,
            Execution::Refused(decision) => return Ok(Ok(decision)),
        },
        ActionArgs::ChannelMemberAdd {
            channel: Some(channel),
            members,
            already_in,
            ..
        } => {
            match execute_channel_member_add(conn, approval, input, channel, members, already_in)
                .await?
            {
                Execution::Ran(executed) => executed,
                Execution::Refused(decision) => return Ok(Ok(decision)),
            }
        }
        // The resolver always fills `channel`; an action that reached the executor
        // without one has nothing to act on, and rolling back is the safe answer.
        ActionArgs::ChannelMemberAdd { channel: None, .. } => {
            return Err(protocol_error(
                "channel.member.add resolved without a channel",
            ));
        }
        ActionArgs::MessagePin {
            change,
            target: Some(message),
            ..
        } => match execute_message_pin(conn, approval, input, now, *change, message).await? {
            Execution::Ran(executed) => executed,
            Execution::Refused(decision) => return Ok(Ok(decision)),
        },
        // The resolver always fills the message; a pin with nothing named has nothing to
        // pin, and rolling back is the safe answer.
        ActionArgs::MessagePin { target: None, .. } => {
            return Err(protocol_error("message pin resolved without a message"));
        }
        ActionArgs::ChannelCreate {
            name,
            kind,
            topic,
            add_proposer,
            members,
            ..
        } => {
            match execute_channel_create(
                conn,
                approval,
                input,
                now,
                name,
                kind,
                topic.as_deref(),
                *add_proposer,
                members,
                card_connection,
            )
            .await?
            {
                Execution::Ran(executed) => executed,
                Execution::Refused(decision) => return Ok(Ok(decision)),
            }
        }
        ActionArgs::InviteCreate {
            role,
            max_uses,
            expires_in_days,
        } => {
            match execute_invite_create(
                conn,
                approval,
                input,
                now,
                role,
                *max_uses,
                *expires_in_days,
            )
            .await?
            {
                Execution::Ran(executed) => executed,
                Execution::Refused(decision) => return Ok(Ok(decision)),
            }
        }
        ActionArgs::MemberDisplayNameSet {
            display_name,
            target: Some(person),
        } => {
            if person.id != input.member_id {
                return Err(protocol_error(
                    "member.display_name.set reached another person",
                ));
            }
            let Some(applied) = momo_messaging::rename_own_display_name_in_tx(
                conn,
                input.workspace_id,
                input.member_id,
                display_name,
            )
            .await?
            else {
                return Ok(Ok(args_invalid_refusal(approval, input, now)));
            };
            Executed {
                audits: vec![AuditEntry::new(input.workspace_id, "member.renamed")
                    .by(input.member_id).about(input.member_id).target("member", input.member_id)
                    .via_token(input.via_token_id).run(approval.run_id)
                    .with_schema("momo.member.renamed.v1", json!({
                        "old": applied.previous_display_name, "new": applied.member.display_name,
                        "via_agent": approval.requested_by.to_string(), "approval_id": approval.id.to_string(),
                    }))],
                ref_type: REF_TYPE_MEMBER, ref_id: input.member_id,
                result_body: "내 이름을 바꿨어요".to_string(),
                result_rows: vec![
                    momo_agent::actions::action_row("바꾸기 전", &person.display_name),
                    momo_agent::actions::action_row("바꾼 뒤", display_name),
                ],
                secret_once: None, next: None,
            }
        }
        ActionArgs::MemberDisplayNameSet { target: None, .. } => {
            return Err(protocol_error(
                "member.display_name.set resolved without a person",
            ));
        }
        ActionArgs::MemberAvatarSet {
            avatar,
            target: Some(person),
        } => match execute_member_avatar_set(conn, approval, input, now, avatar, person).await? {
            Execution::Ran(executed) => executed,
            Execution::Refused(decision) => return Ok(Ok(decision)),
        },
        ActionArgs::MemberAvatarSet { target: None, .. } => {
            return Err(protocol_error(
                "member.avatar.set resolved without a person",
            ));
        }
        ActionArgs::PluginInstall {
            plugin_id,
            plugin: Some(plugin),
        } => match execute_plugin_install(conn, approval, input, now, plugin_id, plugin).await? {
            Execution::Ran(executed) => executed,
            Execution::Refused(decision) => return Ok(Ok(decision)),
        },
        // The resolver always fills `plugin`; an install that reached the executor
        // without one has no manifest the approver was shown, and rolling back is
        // the safe answer.
        ActionArgs::PluginInstall { plugin: None, .. } => {
            return Err(protocol_error("plugin.install resolved without a plugin"));
        }
    };

    // ---- 3b. who receives the one-time value (ADR-0186 증보 v3 V3-3a/V3-5) -----
    //
    // `Always` (the invite link) and `OptIn` with the approver's box checked hand
    // the value to the **proposing agent** through the one-time claim call instead
    // of to the approver: the response carries no `secretOnce`, the executor's
    // minted value is dropped unseen (the claim mints a fresh one — nothing about
    // it is stored), and `payload.secretClaim` records only the permission, its
    // deadline and the ids the claim will act on. The card row says which way it
    // went, so what the approver read is what ran.
    let deliver_to_agent = match action.secret_delivery {
        SecretDelivery::Always => true,
        SecretDelivery::OptIn => input.deliver_secret_to_agent,
        SecretDelivery::None => false,
    };
    if deliver_to_agent && executed.secret_once.is_some() {
        executed.secret_once = None;
        let kind = if action.id == momo_agent::actions::ACTION_AGENT_INVITE {
            momo_agent::actions::SECRET_CLAIM_KIND_PAIRING
        } else {
            momo_agent::actions::SECRET_CLAIM_KIND_INVITE
        };
        let mut grant = momo_agent::actions::secret_claim_grant(now.timestamp_millis());
        if let Some(object) = grant.as_object_mut() {
            object.insert("kind".into(), json!(kind));
            object.insert("refId".into(), json!(executed.ref_id.to_string()));
            object.insert("decidedBy".into(), json!(input.member_id.to_string()));
            // An absolute origin is already required for the link to exist at all
            // (`public_origin_unavailable`); the claim builds the same link from it.
            if let Some(origin) = input.public_origin {
                object.insert("origin".into(), json!(origin));
            }
        }
        momo_agent::grant_secret_claim_in_tx(conn, approval.id, &grant).await?;
    }
    // **Backstop where the value is born** (security review of #3927). A lock-screen
    // decision is refused up front for every action on the open list, so no value to
    // show once should exist here for it. This catches the class that list cannot:
    // a future action that mints a value for the APPROVER (`SecretDelivery::None`)
    // and was never put on it. The transaction rolls back — nothing is committed and
    // nothing is shown.
    if shows_a_value_to_the_lock_screen(input.credential_via, executed.secret_once.is_some()) {
        return Err(protocol_error(
            "a lock-screen decision must not produce a value shown once",
        ));
    }
    if action.id == momo_agent::actions::ACTION_AGENT_INVITE {
        let chosen = if deliver_to_agent {
            momo_agent::actions::PAIRING_DELIVERY_AGENT_TEXT
        } else {
            momo_agent::actions::PAIRING_DELIVERY_APPROVER_TEXT
        };
        for row in executed.result_rows.iter_mut() {
            if row.get("label") == Some(&json!("연결 코드")) {
                row["value"] = json!(chosen);
            }
        }
    }
    if action.id == momo_agent::actions::ACTION_INVITE_CREATE {
        executed.result_rows.push(momo_agent::actions::action_row(
            "초대 링크",
            momo_agent::actions::INVITE_DELIVERY_TEXT,
        ));
    }

    // ---- 4. the shared tail ------------------------------------------------
    //
    // ADR-0186 §5 names two audit rows per action: `action.approved` and the
    // domain one. This arm returns before the generic write block, so the
    // tool-call path's `approval.{status}` row is not written — an executed
    // action is recorded as what it did, once, rather than as a decision plus a
    // coincidence.
    let action_ref_value = action_ref(executed.ref_type, executed.ref_id);
    for entry in &executed.audits {
        // An unasked card's rows say so (`origin`); every other card's are written as they were.
        let stamped = AuditEntry {
            detail: momo_agent::initiative::decision_audit_detail(approval, entry.detail.clone()),
            ..entry.clone()
        };
        write_audit(conn, &stamped).await?;
    }
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
                momo_agent::initiative::decision_audit_detail(
                    approval,
                    stamp_via(
                        input.credential_via,
                        json!({
                            "action_id": action.id,
                            "approval_id": approval.id.to_string(),
                            "proposed_by": approval.requested_by.to_string(),
                            "decided_by": input.member_id.to_string(),
                            "ref": action_ref_value,
                        }),
                    ),
                ),
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
        announce_card_edit(conn, input.workspace_id, message_id).await?;
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

    // ---- ADR-0162 증보 5 G3 — an in-place channel grant releases ONE job -----
    //
    // The card was raised when a person called the agent here; the run has been
    // held on it with no job. Approving widens the grant (above) and then, in
    // this same transaction, re-queues the held run and writes the one job.
    // `requeue_run_from_approval_in_tx` is guarded on `awaiting_approval`, so a
    // replayed or concurrent decision — or a run a person stopped meanwhile —
    // gets `false`, and `false` rolls the whole decision back (grant included):
    // never a widened channel with no work behind it, never a second job.
    if momo_agent::in_place_grant::is_in_place_grant(&approval.payload) {
        let Some(run) =
            momo_agent::load_agent_run_in_tx(conn, input.workspace_id, approval.run_id).await?
        else {
            return Err(protocol_error(RUN_NOT_PARKED_SENTINEL));
        };
        if !requeue_run_from_approval_in_tx(conn, approval.run_id).await? {
            return Err(protocol_error(RUN_NOT_PARKED_SENTINEL));
        }
        // The hold marker leaves with the hold: a released run that later parks
        // on an ordinary approval must count against the concurrency cap again.
        momo_agent::in_place_grant::clear_channel_grant_hold_in_tx(
            conn,
            input.workspace_id,
            approval.run_id,
        )
        .await?;
        if crate::routes::agent_mentions::enqueue_granted_mention_job_in_tx(
            conn,
            input.workspace_id,
            &run,
            executed.ref_id,
            input.context_max_messages,
        )
        .await?
        .is_none()
        {
            return Err(protocol_error(
                "in-place channel grant approved for an agent that can no longer take the job",
            ));
        }
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
        // No outcome line and no terminal frame: the card patch above says
        // 승인됨, and the turn that starts now is the agent's to speak in.
        return Ok(Ok(Decision {
            receipt,
            status: StatusCode::OK,
            secret_once: executed.secret_once,
        }));
    }

    // ---- the proposer's inbox, BEFORE the outcome line (ADR-0186 증보 v5 U-f) ----
    //
    // After the in-place arm above on purpose: that card releases a job, which is
    // its own wake-up, and writes no outcome line — and the grant executor has just
    // covered its channel in this very transaction, so the early return above is the
    // only thing that keeps a second wake from being written for it. Before
    // `send_message_in_tx` below for the lock order `wake_proposer_in_tx` states.
    wake_proposer_in_tx(conn, approval).await?;

    // ---- the outcome line, authored by the agent ---------------------------
    //
    // Same authorship rule as the rejection's (`reject_run`): the proposal was
    // the agent's utterance, so its outcome belongs to the same speaker. Who
    // decided is in the props, not in the authorship.
    send_message_in_tx(
        conn,
        input.workspace_id,
        NewMessage {
            channel_id: approval.channel_id,
            author_member_id: approval.requested_by,
            message_type: MessageType::ToolResult,
            body: Some(executed.result_body),
            props: action_result_props(&ActionResult {
                action_id: action.id,
                status: ACTION_RESULT_EXECUTED,
                approval_id: approval.id,
                decided_by: input.member_id,
                ref_type: executed.ref_type,
                ref_id: executed.ref_id,
                rows: executed.result_rows,
                secret_shown_once: executed.secret_once.is_some(),
                next: executed.next,
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
        // this cannot be swallowed — the action has already executed in this
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
        secret_once: executed.secret_once,
    }))
}

/// `channel.create` (증보 V3): one transaction, three effects — the channel (the
/// **approver** is `created_by` and owner), the proposing agent's membership, and
/// that channel in the agent's hosted connection's approved set. All or nothing;
/// the card's 「이 에이전트도 참여」 row is the thing the approver read.
#[allow(clippy::too_many_arguments)]
async fn execute_channel_create(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    name: &str,
    kind: &'static str,
    topic: Option<&str>,
    add_proposer: bool,
    members: &[ResolvedMember],
    card_connection: Option<Uuid>,
) -> Result<Execution, momo_db::DbError> {
    // The connection is the FIRST lock of the hosted canon, so it is taken before
    // the channel and membership rows this transaction is about to write.
    //
    // A card an agent raised unasked names its own connection — the one it was raised through, which
    // the decision proved to stand a moment ago — and that very row is locked and later widened,
    // whether or not the agent holds a fresh credential at the instant a person taps. The generic
    // read finds the connection *through the credential's expiry*; for a card that waited a day it
    // finds nothing, and the agent would be seated in a room its connection does not cover with the
    // grant and its audit row skipped (security review of #4704 PR B, round 2, H1).
    // A requested card proves the proposer's own connection by the same standing rule. Only a
    // managed proposer has no connection to widen; an ended hosted connection refuses the action.
    let connection = if add_proposer {
        match card_connection {
            Some(card_connection) => {
                let locked = lock_hosted_connection_in_tx(
                    conn,
                    input.workspace_id,
                    approval.requested_by,
                    card_connection,
                )
                .await
                .map_err(momo_db::DbError::from)?;
                // An unasked card never half-executes: the connection stood a moment ago in this very
                // transaction, so if it does not any more the card is stale — refused before any write.
                let Some(covered) = locked else {
                    return Ok(Execution::Refused(args_invalid_refusal(
                        approval, input, now,
                    )));
                };
                Some((card_connection, covered))
            }
            None => {
                match hosted_action_connection_in_tx(
                    conn,
                    input.workspace_id,
                    approval.requested_by,
                )
                .await
                .map_err(momo_db::DbError::from)?
                {
                    HostedActionConnection::Managed => None,
                    HostedActionConnection::Standing(connection_id) => {
                        let Some(covered) = lock_hosted_connection_in_tx(
                            conn,
                            input.workspace_id,
                            approval.requested_by,
                            connection_id,
                        )
                        .await
                        .map_err(momo_db::DbError::from)?
                        else {
                            return Ok(Execution::Refused(args_invalid_refusal(
                                approval, input, now,
                            )));
                        };
                        Some((connection_id, covered))
                    }
                    HostedActionConnection::Unavailable => {
                        return Ok(Execution::Refused(args_invalid_refusal(
                            approval, input, now,
                        )));
                    }
                }
            }
        }
    } else {
        None
    };
    // A connection already at its ceiling cannot take one more: refuse before
    // any write, so the card stays pending and nothing half-happened.
    if connection.is_some_and(|(_, count)| count + 1 > MAX_HOSTED_APPROVED_CHANNELS) {
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    }

    let kind_label = normalize_channel_kind(kind)
        .map_err(|_| protocol_error("channel.create resolved an unknown kind"))?;
    let Some(created) = create_channel_detailed_in_tx(
        conn,
        input.workspace_id,
        &NewChannel {
            kind: kind_label,
            name: name.to_string(),
            topic: topic.map(str::to_string),
            // **The approver's name on the row** and the owner membership: the
            // agent never holds this channel's ownership.
            created_by: input.member_id,
        },
    )
    .await?
    else {
        // The name was taken between the proposal and this tap (증보 V11): the
        // proposal is stale, the approval is not consumed.
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    };
    let channel_id = created.channel.id;

    if add_proposer {
        add_channel_member_in_tx(
            conn,
            input.workspace_id,
            channel_id,
            approval.requested_by,
            "member",
        )
        .await?
        .ok_or_else(|| protocol_error("the proposing agent could not be added to its channel"))?;
    }
    let mut added = 0usize;
    let mut added_ids: Vec<String> = Vec::new();
    let mut ordered: Vec<&ResolvedMember> = members.iter().collect();
    ordered.sort_by_key(|member| member.id);
    for member in ordered {
        // The approver already owns the channel, and the agent is handled above:
        // re-adding either would be a no-op at best and, for the approver, a
        // downgrade from `owner` (the upsert rewrites the role).
        if member.id == input.member_id || (add_proposer && member.id == approval.requested_by) {
            continue;
        }
        add_channel_member_in_tx(conn, input.workspace_id, channel_id, member.id, "member")
            .await?
            .ok_or_else(|| protocol_error("a resolved member could not be added"))?;
        added += 1;
        added_ids.push(member.id.to_string());
    }

    let mut audits = vec![AuditEntry::new(input.workspace_id, AUDIT_CHANNEL_CREATED)
        .by(input.member_id)
        .about(approval.requested_by)
        .target("channel", channel_id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(
            AUDIT_CHANNEL_CREATED_SCHEMA,
            json!({
                "name": name,
                "kind": kind,
                "add_proposer": add_proposer,
                // Who was actually seated (not the requested list): this row is
                // the only durable record of who got into a private room.
                "member_count": added,
                "member_ids": added_ids,
                "via_agent": approval.requested_by.to_string(),
                "approval_id": approval.id.to_string(),
            }),
        )];

    if let Some((connection_id, _)) = connection {
        append_approved_channels_in_tx(conn, input.workspace_id, connection_id, &[channel_id])
            .await
            .map_err(momo_db::DbError::from)?
            .ok_or_else(|| protocol_error("the approved set could not take the new channel"))?;
        audits.push(
            AuditEntry::new(input.workspace_id, AUDIT_CHANNELS_GRANTED)
                .by(input.member_id)
                .about(approval.requested_by)
                .target("hosted_connection", connection_id)
                .via_token(input.via_token_id)
                .run(approval.run_id)
                .with_schema(
                    AUDIT_CHANNELS_GRANTED_SCHEMA,
                    json!({
                        "connection_id": connection_id.to_string(),
                        "channel_ids": [channel_id.to_string()],
                        "via_agent": approval.requested_by.to_string(),
                        "approval_id": approval.id.to_string(),
                    }),
                ),
        );
    }

    Ok(Execution::Ran(Executed {
        audits,
        ref_type: REF_TYPE_CHANNEL,
        ref_id: channel_id,
        result_body: channel_create_result_body(name, kind, channel_id),
        result_rows: channel_create_result_rows(name, kind, add_proposer, added),
        secret_once: None,
        next: None,
    }))
}

/// `workspace.settings.update` (증보 V7): merge the two keys into the settings bag
/// as the approver, under the row lock.
///
/// Re-reads the bag `FOR UPDATE` and refuses (nothing written, approval pending)
/// if a touched key no longer holds what the card showed as its old value — the
/// resolver read it unlocked. The merge is `merge_workspace_settings`, the REST
/// route's own, so the allow-list and every validator are the same; and the result
/// is compared with the old bag so that **only the two keys can have changed**.
async fn execute_workspace_settings_update(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    welcome_prompt: &SettingPatch,
    role_labels: &SettingPatch,
    before: &SettingsBefore,
) -> Result<Execution, momo_db::DbError> {
    let Some(existing) = read_workspace_settings_for_update(conn, input.workspace_id).await? else {
        return Err(protocol_error("workspace settings row is not visible"));
    };
    let mut patch = serde_json::Map::new();
    let mut touched: Vec<(&'static str, &'static str)> = Vec::new();
    for (stored, label, setting, was) in [
        (
            "welcome_prompt",
            "환영 문구",
            welcome_prompt,
            &before.welcome_prompt,
        ),
        ("role_labels", "역할 이름", role_labels, &before.role_labels),
    ] {
        let Some(value) = (match setting {
            SettingPatch::Unchanged => None,
            SettingPatch::Clear => Some(Value::Null),
            SettingPatch::Set(value) => Some(value.clone()),
        }) else {
            continue;
        };
        // The old value the approver read must still be the current one.
        if existing.get(stored) != was.as_ref() {
            return Ok(Execution::Refused(args_invalid_refusal(
                approval, input, now,
            )));
        }
        patch.insert(stored.to_string(), value);
        touched.push((stored, label));
    }
    let Ok(merged) = merge_workspace_settings(&existing, &Value::Object(patch)) else {
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    };
    // Belt and braces: whatever the merge did, no key outside the two moved.
    for key in ["allowed_agent_models", "welcome_agent_member_id"] {
        if existing.get(key) != merged.get(key) {
            return Err(protocol_error(
                "workspace.settings.update changed a key it does not own",
            ));
        }
    }
    let Some(object) = merged.as_object() else {
        return Err(protocol_error("settings bag is not an object"));
    };
    let foreign_changed = existing
        .as_object()
        .into_iter()
        .flatten()
        .chain(object.iter())
        .any(|(key, _)| {
            key != "welcome_prompt" && key != "role_labels" && existing.get(key) != merged.get(key)
        });
    if foreign_changed {
        return Err(protocol_error(
            "workspace.settings.update changed a key it does not own",
        ));
    }
    write_workspace_settings(conn, input.workspace_id, &merged)
        .await?
        .ok_or_else(|| protocol_error("workspace row vanished during a settings write"))?;

    let audit = AuditEntry::new(input.workspace_id, AUDIT_WORKSPACE_SETTING_UPDATED)
        .by(input.member_id)
        .about(approval.requested_by)
        .target("workspace", input.workspace_id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(
            AUDIT_WORKSPACE_SETTING_UPDATED_SCHEMA,
            // Key NAMES only. The welcome prompt is long user text; its old and
            // new values live on the card the approver read, not in the audit log.
            json!({
                "keys": touched.iter().map(|(stored, _)| *stored).collect::<Vec<_>>(),
                "via_agent": approval.requested_by.to_string(),
                "approval_id": approval.id.to_string(),
            }),
        );
    let labels: Vec<&str> = touched.iter().map(|(_, label)| *label).collect();
    let mut rows = Vec::new();
    for (patch_value, was, label) in [
        (welcome_prompt, &before.welcome_prompt, "환영 문구"),
        (role_labels, &before.role_labels, "역할 이름"),
    ] {
        let after_value = match patch_value {
            SettingPatch::Unchanged => continue,
            SettingPatch::Clear => None,
            SettingPatch::Set(value) => Some(value),
        };
        rows.push(momo_agent::actions::settings_change_row(
            label,
            crate::routes::actions::settings_display(was.as_ref()).as_deref(),
            crate::routes::actions::settings_display(after_value).as_deref(),
        ));
    }
    Ok(Execution::Ran(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_WORKSPACE_SETTINGS,
        ref_id: input.workspace_id,
        result_body: workspace_settings_result_body(&labels),
        result_rows: rows,
        secret_once: None,
        next: None,
    }))
}

/// The detail every v2 settings executor adds to its REST route's own audit row
/// (ADR-0201 증보 v2 H6-1): which agent proposed and which approval ran it.
fn via_agent_detail(approval: &LockedApproval, mut detail: Value) -> Value {
    if let Some(object) = detail.as_object_mut() {
        object.insert("via_agent".into(), json!(approval.requested_by.to_string()));
        object.insert("approval_id".into(), json!(approval.id.to_string()));
    }
    detail
}

/// `workspace.unfurl.update` (ADR-0201 증보 v2 H6-1): the write `PUT
/// …/unfurl-settings` makes — `momo_unfurl::upsert_setting_in_tx`, with the
/// **approver** as `updated_by` — and its audit row, plus `via_agent`. The gate
/// (`WorkspaceOperator`, the route's `require_workspace_operator`) and the pin on
/// the switch the card showed ran before this.
async fn execute_workspace_unfurl_update(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    enabled: bool,
    before: Option<bool>,
) -> Result<Executed, momo_db::DbError> {
    let saved =
        momo_unfurl::upsert_setting_in_tx(conn, input.workspace_id, enabled, input.member_id)
            .await?;
    let audit = AuditEntry::new(input.workspace_id, AUDIT_UNFURL_SETTING_UPDATED)
        .by(input.member_id)
        .about(approval.requested_by)
        .target("workspace", input.workspace_id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(
            AUDIT_UNFURL_SETTING_UPDATED_SCHEMA,
            via_agent_detail(approval, json!({ "enabled": saved.enabled })),
        );
    Ok(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_WORKSPACE_SETTINGS,
        ref_id: input.workspace_id,
        result_body: unfurl_update_result_body(saved.enabled),
        result_rows: unfurl_update_rows(before.unwrap_or(!saved.enabled), saved.enabled),
        secret_once: None,
        next: None,
    })
}

/// `plugin.install` (ADR-0201 증보 v2 H7, #3889): the write `POST
/// …/plugins/{plugin}/install` makes — [`plugin_writes::install`], the very
/// function that route calls, with the **approver** as the actor (their role is
/// judged a second time inside it, with the manifest's own `serverPolicy`) and
/// the install **enabled**, which is what the card said. Its audit row
/// (`plugin.installed`) is written by that function and carries `via_agent` and
/// `approval_id`, so the install is recorded as what it did, once, naming the
/// helper that asked.
///
/// A refusal inside it happens before its first write, so it is a refusal here
/// too and the approval stays pending: a role the manifest's policy does not
/// admit is a 403 `role_required`; anything else (the app was revoked in the
/// registry, its manifest stopped passing admission) is the stale card.
async fn execute_plugin_install(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    plugin_id: &str,
    plugin: &ResolvedPlugin,
) -> Result<Execution, momo_db::DbError> {
    let provenance = Provenance {
        subject_member_id: Some(approval.requested_by),
        run_id: Some(approval.run_id),
        via_agent: Some(approval.requested_by),
        approval_id: Some(approval.id),
    };
    let actor = Actor {
        member_id: input.member_id,
        via_token_id: input.via_token_id,
    };
    match plugin_writes::install(
        conn,
        input.workspace_id,
        plugin_id,
        Some(true),
        actor,
        &provenance,
    )
    .await?
    {
        Ok(_installed) => Ok(Execution::Ran(Executed {
            audits: Vec::new(),
            ref_type: REF_TYPE_WORKSPACE_SETTINGS,
            ref_id: input.workspace_id,
            result_body: plugin_install_result_body(plugin.label),
            result_rows: plugin_install_result_rows(
                plugin.label,
                &plugin.version,
                &plugin.egress_domains,
            ),
            secret_once: None,
            next: None,
        })),
        Err(error) if error.status == StatusCode::FORBIDDEN => Ok(Execution::Refused(refusal(
            approval.id,
            input.member_id,
            ROLE_REQUIRED,
            "this app's install policy does not allow your role",
            StatusCode::FORBIDDEN,
            now,
        ))),
        Err(_) => Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        ))),
    }
}

/// `workspace.memory.update` (H6-1): the write `PATCH …/memory/settings` makes,
/// in that route's posture — `app.member_id` bound to the **approver**
/// (`bind_mem_reader_guc`, as `memory_tenant_tx` does), so the `mem_settings`
/// write policy (`mem_is_workspace_admin()`) judges the person who said yes a
/// second time, in the database. The binding is restored before returning, so the
/// rest of the decision transaction runs as it did before.
async fn execute_workspace_memory_update(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    enabled: Option<bool>,
    paused: Option<bool>,
) -> Result<Executed, momo_db::DbError> {
    let previous: Option<String> =
        momo_db::sqlx::query_scalar("SELECT current_setting('app.member_id', true)")
            .fetch_one(&mut *conn)
            .await?;
    momo_messaging::bind_mem_reader_guc(conn, input.member_id).await?;
    // ADR-0196 D9: no workspace row = on, not paused.
    let before = momo_messaging::list_settings_in_tx(conn)
        .await?
        .into_iter()
        .find(|row| row.scope == "workspace")
        .map(|row| (row.enabled, row.paused))
        .unwrap_or((true, false));
    let saved =
        momo_messaging::upsert_workspace_settings_in_tx(conn, input.workspace_id, enabled, paused)
            .await?;
    momo_db::sqlx::query("SELECT set_config('app.member_id', $1, true)")
        .bind(previous.unwrap_or_default())
        .execute(&mut *conn)
        .await?;
    let audit = AuditEntry::new(input.workspace_id, AUDIT_MEMORY_SETTINGS_UPDATED)
        .by(input.member_id)
        .about(approval.requested_by)
        .target("workspace", input.workspace_id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(
            AUDIT_MEMORY_SETTINGS_UPDATED_SCHEMA,
            via_agent_detail(
                approval,
                json!({
                    "scope": "workspace",
                    "enabled": saved.enabled,
                    "paused": saved.paused,
                }),
            ),
        );
    Ok(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_WORKSPACE_SETTINGS,
        ref_id: input.workspace_id,
        result_body: memory_update_result_body(enabled, paused),
        result_rows: memory_update_result_rows(
            before,
            (saved.enabled, saved.paused),
            enabled.is_some(),
            paused.is_some(),
        ),
        secret_once: None,
        next: None,
    })
}

/// `workspace.work_tier.update` (H6-1): the write `PUT …/work-tier-policy` makes
/// for the workspace default — its registry check (`tier_target_allowed`, `FOR
/// SHARE` on the host, so a host revoked since the card was drawn refuses here
/// with nothing written) and `upsert_tier_policy` — and its audit row, plus
/// `via_agent`.
async fn execute_workspace_work_tier_update(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    mode: &str,
    auto_target: Option<&str>,
) -> Result<Execution, momo_db::DbError> {
    let before = momo_settings::load_tier_policy(
        conn,
        input.workspace_id,
        momo_settings::TierScope::Workspace,
    )
    .await?;
    if momo_settings::tier_target_allowed(
        conn,
        input.workspace_id,
        momo_settings::TierScope::Workspace,
        auto_target,
    )
    .await?
    .is_err()
    {
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    }
    let saved = momo_settings::upsert_tier_policy(
        conn,
        input.workspace_id,
        momo_settings::TierScope::Workspace,
        mode,
        auto_target,
    )
    .await?;
    let audit = AuditEntry::new(input.workspace_id, AUDIT_WORK_TIER_POLICY_CHANGED)
        .by(input.member_id)
        .about(approval.requested_by)
        .target("workspace", input.workspace_id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(
            AUDIT_WORK_TIER_POLICY_CHANGED_SCHEMA,
            via_agent_detail(
                approval,
                json!({
                    "scope": "workspace",
                    "mode": saved.mode,
                    "auto_target": saved.auto_target,
                }),
            ),
        );
    let before_label = match &before.auto_target {
        Some(target) => Some(
            crate::routes::actions::work_tier_target_label_in_tx(conn, input.workspace_id, target)
                .await?,
        ),
        None => None,
    };
    let after_label = match &saved.auto_target {
        Some(target) => Some(
            crate::routes::actions::work_tier_target_label_in_tx(conn, input.workspace_id, target)
                .await?,
        ),
        None => None,
    };
    Ok(Execution::Ran(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_WORKSPACE_SETTINGS,
        ref_id: input.workspace_id,
        result_body: work_tier_update_result_body(&saved.mode),
        result_rows: work_tier_update_rows(
            &before.mode,
            before_label.as_deref(),
            &saved.mode,
            after_label.as_deref(),
        ),
        secret_once: None,
        next: None,
    }))
}

/// `hosted.channels.grant` (증보 V5): widen the **proposer's own** connection by
/// the resolved channels and seat the agent in them, as one step. The connection
/// is the one pinned and re-found by the resolver; the grant itself re-checks
/// that it is still live, bound to this agent, under the ceiling.
async fn execute_hosted_channels_grant(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    connection: &ResolvedConnection,
    channels: &[ResolvedChannel],
) -> Result<Execution, momo_db::DbError> {
    let ids: Vec<Uuid> = channels.iter().map(|channel| channel.id).collect();
    let Some(approved) = grant_hosted_channels_in_tx(
        conn,
        input.workspace_id,
        connection.id,
        approval.requested_by,
        &ids,
    )
    .await
    .map_err(momo_db::DbError::from)?
    else {
        // The connection went away, a channel stopped qualifying, or the ceiling
        // was reached since the resolver looked: stale, nothing written.
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    };
    let audit = AuditEntry::new(input.workspace_id, AUDIT_CHANNELS_GRANTED)
        .by(input.member_id)
        .about(approval.requested_by)
        .target("hosted_connection", connection.id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(AUDIT_CHANNELS_GRANTED_SCHEMA, {
            let mut detail = json!({
                "connection_id": connection.id.to_string(),
                "channel_ids": ids.iter().map(Uuid::to_string).collect::<Vec<_>>(),
                "via_agent": approval.requested_by.to_string(),
                "approval_id": approval.id.to_string(),
            });
            // ADR-0162 증보 5 G3-4: which door the grant came through.
            if momo_agent::in_place_grant::is_in_place_grant(&approval.payload) {
                detail["via"] = json!(momo_agent::in_place_grant::IN_PLACE_GRANT_AUDIT_VIA);
            }
            detail
        });
    let named: Vec<(String, Uuid)> = channels
        .iter()
        .map(|channel| (channel.name.clone(), channel.id))
        .collect();
    Ok(Execution::Ran(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_HOSTED_CONNECTION,
        ref_id: connection.id,
        result_body: momo_agent::actions::hosted_channels_grant_result_body(&named, approved.len()),
        result_rows: momo_agent::actions::hosted_channels_grant_rows(
            &channels
                .iter()
                .map(|c| (c.name.clone(), c.kind.clone(), c.member_count))
                .collect::<Vec<_>>(),
            connection.approved_before,
            approved.len(),
        ),
        secret_once: None,
        next: None,
    }))
}

/// `agent.rename` (증보 V4): set the target agent's display name as the approver.
/// The collision check ran in `resolve_stored_action_in_tx` under the workspace's
/// display-name lock, which this transaction still holds, so the write sees the
/// roster that was checked.
async fn execute_agent_rename(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    display_name: &str,
    target: &ResolvedAgentTarget,
) -> Result<Execution, momo_db::DbError> {
    let applied =
        rename_agent_display_name_in_tx(conn, input.workspace_id, target.id, display_name)
            .await?
            .ok_or_else(|| protocol_error("the rename target is no longer a live agent"))?;

    let mut detail = json!({
        "old": applied.previous_display_name,
        "new": applied.member.display_name,
        "kind": "agent",
        "via_agent": approval.requested_by.to_string(),
        "approval_id": approval.id.to_string(),
        "managed": target.managed,
    });
    if target.managed {
        if let Some(object) = detail.as_object_mut() {
            object.insert("target_agent".into(), json!(target.id.to_string()));
            object.insert(
                "owner_member_id".into(),
                json!(target.owner_member_id.map(|owner| owner.to_string())),
            );
        }
    }
    let audit = AuditEntry::new(input.workspace_id, AUDIT_MEMBER_RENAMED)
        .by(input.member_id)
        .about(target.id)
        .target("member", target.id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(AUDIT_MEMBER_RENAMED_SCHEMA, detail);

    Ok(Execution::Ran(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_AGENT,
        ref_id: target.id,
        result_body: agent_rename_result_body(
            &applied.previous_display_name,
            &applied.member.display_name,
        ),
        result_rows: momo_agent::actions::agent_rename_rows(
            &applied.previous_display_name,
            &target.handle,
            &applied.member.display_name,
        ),
        secret_once: None,
        next: None,
    }))
}

/// `agent.invite` (증보 v3 V3-3): the **approver** — an admin, judged by the gate
/// before this runs — becomes the owner of a new hosted agent, born paused with a
/// `pairing_pending` connection, in the decision's own transaction. Nothing the
/// proposing agent said selects an id, a scope or a channel; access opens only when
/// a person confirms the detected connection.
///
/// The pairing code is the one-time value of this decision (`secretOnce`, D4). It is
/// in no audit row, no message and no payload.
async fn execute_agent_invite(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    platform: &str,
    display_name: &str,
    handle: &str,
) -> Result<Execution, momo_db::DbError> {
    use crate::routes::hosted_agent_connections::{provision_hosted_agent_in_tx, Provisioned};
    // The ban list is the REST route's check too; the resolver already asked, this
    // is the same-transaction recheck for a ban that landed in between.
    if momo_settings::is_handle_banned_in_tx(conn, handle).await? {
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    }
    let (member, issuance) = match provision_hosted_agent_in_tx(
        conn,
        input.workspace_id,
        input.member_id,
        input.via_token_id,
        display_name.to_string(),
        handle.to_string(),
        None,
        None,
    )
    .await?
    {
        Provisioned::Created(member, issuance) => (member, issuance),
        // Defence in depth: the resolver already checked every member row, deleted
        // ones included, so this is a race with a creator that takes no namespace
        // lock (join, REST create). Nothing was written; the card is stale.
        Provisioned::DuplicateHandle => {
            return Ok(Execution::Refused(args_invalid_refusal(
                approval, input, now,
            )));
        }
        Provisioned::Rejected(_) => {
            return Err(protocol_error(
                "agent.invite approver is not an active human",
            ));
        }
    };
    let audit = AuditEntry::new(input.workspace_id, AUDIT_AGENT_INVITED)
        .by(input.member_id)
        .about(member.id)
        .target("member", member.id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(
            AUDIT_AGENT_INVITED_SCHEMA,
            // Provenance only — never the pairing code.
            json!({
                "via_agent": approval.requested_by.to_string(),
                "approval_id": approval.id.to_string(),
                "platform": platform,
                "connection_id": issuance.connection.id.to_string(),
            }),
        );
    Ok(Execution::Ran(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_AGENT,
        ref_id: member.id,
        result_body: agent_invite_result_body(display_name),
        result_rows: momo_agent::actions::agent_invite_rows(
            momo_agent::actions::agent_invite_platform_label(platform).unwrap_or(""),
            display_name,
            handle,
        ),
        secret_once: Some(SecretOnceDto {
            kind: SECRET_ONCE_PAIRING.to_string(),
            value: issuance.pairing_credential,
            expires_at_ms: issuance.pairing_expires_at_ms,
        }),
        next: None,
    }))
}

/// The card fields one `agent.profile.update` carries, as the resolver typed them.
struct AgentProfileChange<'a> {
    display_name: &'a Option<String>,
    tagline: &'a FieldPatch,
    role_label: &'a FieldPatch,
    status: &'a StatusIntent,
    avatar: &'a AvatarIntent,
}

/// `agent.profile.update` (증보 v3 V3-2): the name through the one rename write,
/// the rest through the card write, in one transaction and as the approver.
async fn execute_agent_profile_update(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    change: AgentProfileChange<'_>,
    target: &ResolvedAgentTarget,
    before: &AgentCard,
) -> Result<Execution, momo_db::DbError> {
    // The very diff the card showed (the pins proved `before` is still current).
    let changes = profile_changes(
        &target.current_display_name,
        before,
        change.display_name,
        change.tagline,
        change.role_label,
        change.status,
        change.avatar,
    );
    if changes.is_empty() {
        return Err(protocol_error("agent.profile.update changes nothing"));
    }
    // The row is locked **before the first write** and read again: the card was
    // resolved earlier in this transaction without the lock, so anything that
    // moved since (a concurrent rename or profile change) re-asks. A refusal here
    // has written nothing.
    let Some((locked_name, locked_card)) =
        lock_agent_card_in_tx(conn, input.workspace_id, target.id).await?
    else {
        return Err(protocol_error(
            "the profile target is no longer a live agent",
        ));
    };
    if locked_name != target.current_display_name || &locked_card != before {
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    }
    let via_agent = approval.requested_by.to_string();
    let mut audits = Vec::new();
    let mut new_name = target.current_display_name.clone();

    if let Some(name) = change.display_name {
        if name != &target.current_display_name {
            let applied =
                rename_agent_display_name_in_tx(conn, input.workspace_id, target.id, name)
                    .await?
                    .ok_or_else(|| {
                        protocol_error("the profile target is no longer a live agent")
                    })?;
            new_name = applied.member.display_name.clone();
            let mut detail = json!({
                "old": applied.previous_display_name,
                "new": applied.member.display_name,
                "kind": "agent",
                "via_agent": via_agent,
                "approval_id": approval.id.to_string(),
                "managed": target.managed,
            });
            if target.managed {
                if let Some(object) = detail.as_object_mut() {
                    object.insert("target_agent".into(), json!(target.id.to_string()));
                }
            }
            audits.push(
                AuditEntry::new(input.workspace_id, AUDIT_MEMBER_RENAMED)
                    .by(input.member_id)
                    .about(target.id)
                    .target("member", target.id)
                    .via_token(input.via_token_id)
                    .run(approval.run_id)
                    .with_schema(AUDIT_MEMBER_RENAMED_SCHEMA, detail),
            );
        }
    }

    // The picture. An approved image wins over a preset, so each choice clears the
    // other: a preset removes the image row, an image removes the preset key, a
    // clear removes both. The staged image is verified against its pin **again**
    // here, under the member lock taken above and in this transaction — the
    // resolver proved it, this is the write's own guarantee.
    let mut avatar_audit: Option<Value> = None;
    let avatar_preset = match change.avatar {
        AvatarIntent::Unchanged => FieldPatch::Unchanged,
        AvatarIntent::Clear => {
            clear_avatar_image_in_tx(conn, input.workspace_id, target.id).await?;
            FieldPatch::Clear
        }
        AvatarIntent::Preset(id) => {
            clear_avatar_image_in_tx(conn, input.workspace_id, target.id).await?;
            FieldPatch::Set(id.clone())
        }
        AvatarIntent::Staged {
            image_id,
            sha256,
            origin,
        } => {
            let pin = decode_pin_hex(sha256)
                .ok_or_else(|| protocol_error("avatar pin is not a sha256"))?;
            if !staged_image_matches_pin_in_tx(
                conn,
                input.workspace_id,
                *image_id,
                target.id,
                approval.id,
                &pin,
            )
            .await?
            {
                return Ok(Execution::Refused(args_invalid_refusal(
                    approval, input, now,
                )));
            }
            let meta = read_avatar_image_in_tx(conn, input.workspace_id, *image_id)
                .await?
                .ok_or_else(|| protocol_error("the staged avatar vanished"))?;
            apply_avatar_image_in_tx(conn, input.workspace_id, target.id, *image_id, approval.id)
                .await?
                .ok_or_else(|| protocol_error("the staged avatar could not be applied"))?;
            avatar_audit = Some(json!({
                "image_id": image_id.to_string(),
                "origin": origin,
                "mime": meta.mime,
                "width": meta.width,
                "height": meta.height,
                "size_bytes": meta.size_bytes,
                // A prefix is enough to find the row; the bytes never go in a log.
                "sha256_prefix": &sha256[..12],
            }));
            FieldPatch::Clear
        }
        // Raw proposal forms never reach the executor: the stored parser refuses
        // them (`ArgsOrigin::Stored`), so the resolver already said no.
        AvatarIntent::Attachment(_) | AvatarIntent::Generated(_) => {
            return Err(protocol_error("an unstaged avatar reached the executor"));
        }
    };
    let patch = AgentCardPatch {
        avatar_preset,
        tagline: change.tagline.clone(),
        role_label: change.role_label.clone(),
        status: match change.status {
            StatusIntent::Unchanged => CardStatusPatch::Unchanged,
            StatusIntent::Clear => CardStatusPatch::Clear,
            StatusIntent::Set { emoji, text, hours } => CardStatusPatch::Set {
                emoji: emoji.clone(),
                text: text.clone(),
                expires_at: now + chrono::Duration::hours(*hours),
            },
        },
    };
    apply_agent_card_in_tx(conn, input.workspace_id, target.id, &patch)
        .await?
        .ok_or_else(|| protocol_error("the profile target is no longer a live agent"))?;

    // Field **names** only: tagline and status are user-facing prose and never
    // belong in an audit row (the card keeps the old/new for the approver).
    let labels: Vec<&str> = changes.iter().map(|(label, _, _)| *label).collect();
    let keys: Vec<&str> = labels
        .iter()
        .map(|label| match *label {
            "이름" => "displayName",
            "소개" => "tagline",
            "역할 라벨" => "roleLabel",
            "프로필 사진" => "avatar",
            _ => "status",
        })
        .collect();
    let mut detail = json!({
        "fields": keys,
        "via_agent": via_agent,
        "approval_id": approval.id.to_string(),
        "managed": target.managed,
    });
    if target.managed {
        if let Some(object) = detail.as_object_mut() {
            object.insert("target_agent".into(), json!(target.id.to_string()));
            object.insert(
                "owner_member_id".into(),
                json!(target.owner_member_id.map(|owner| owner.to_string())),
            );
        }
    }
    if let Some(avatar_detail) = avatar_audit {
        let mut avatar_detail = avatar_detail;
        if let Some(object) = avatar_detail.as_object_mut() {
            object.insert("via_agent".into(), json!(via_agent));
            object.insert("approval_id".into(), json!(approval.id.to_string()));
            object.insert("managed".into(), json!(target.managed));
        }
        audits.push(
            AuditEntry::new(input.workspace_id, AUDIT_AGENT_AVATAR_UPDATED)
                .by(input.member_id)
                .about(target.id)
                .target("member", target.id)
                .via_token(input.via_token_id)
                .run(approval.run_id)
                .with_schema(AUDIT_AGENT_AVATAR_UPDATED_SCHEMA, avatar_detail),
        );
    }
    audits.push(
        AuditEntry::new(input.workspace_id, AUDIT_AGENT_PROFILE_UPDATED)
            .by(input.member_id)
            .about(target.id)
            .target("member", target.id)
            .via_token(input.via_token_id)
            .run(approval.run_id)
            .with_schema(AUDIT_AGENT_PROFILE_UPDATED_SCHEMA, detail),
    );

    Ok(Execution::Ran(Executed {
        audits,
        ref_type: REF_TYPE_AGENT,
        ref_id: target.id,
        result_body: agent_profile_update_result_body(&labels),
        result_rows: momo_agent::actions::agent_profile_update_rows(
            &new_name,
            &target.handle,
            &changes,
        ),
        secret_once: None,
        next: None,
    }))
}

/// `member.avatar.set` (ADR-0186 증보 v4): put the staged image on the **decider's own**
/// profile, as the decider. The role gate already proved the decider is the person the
/// resolver named; the image is verified against its pin **again** here, under the member
/// lock `apply_human_avatar_image_in_tx` takes, and the previous image row (if any) is
/// deleted in the same transaction.
async fn execute_member_avatar_set(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    avatar: &AvatarIntent,
    person: &crate::routes::actions::ResolvedPerson,
) -> Result<Execution, momo_db::DbError> {
    let AvatarIntent::Staged {
        image_id,
        sha256,
        origin,
    } = avatar
    else {
        return Err(protocol_error("an unstaged avatar reached the executor"));
    };
    // Backstop for the gate above: the only person this ever writes to is the decider.
    if person.id != input.member_id {
        return Err(protocol_error(
            "member.avatar.set reached the executor for someone else",
        ));
    }
    let pin = decode_pin_hex(sha256).ok_or_else(|| protocol_error("avatar pin is not a sha256"))?;
    if !staged_image_matches_pin_in_tx(
        conn,
        input.workspace_id,
        *image_id,
        person.id,
        approval.id,
        &pin,
    )
    .await?
    {
        return Ok(Execution::Refused(args_invalid_refusal(
            approval, input, now,
        )));
    }
    let meta = read_avatar_image_in_tx(conn, input.workspace_id, *image_id)
        .await?
        .ok_or_else(|| protocol_error("the staged avatar vanished"))?;
    apply_human_avatar_image_in_tx(conn, input.workspace_id, person.id, *image_id, approval.id)
        .await?
        .ok_or_else(|| protocol_error("the staged avatar could not be applied"))?;
    let detail = json!({
        "image_id": image_id.to_string(),
        "origin": origin,
        "mime": meta.mime,
        "width": meta.width,
        "height": meta.height,
        "size_bytes": meta.size_bytes,
        // A prefix is enough to find the row; the bytes never go in a log.
        "sha256_prefix": &sha256[..12],
        "via_agent": approval.requested_by.to_string(),
        "approval_id": approval.id.to_string(),
    });
    Ok(Execution::Ran(Executed {
        audits: vec![AuditEntry::new(
            input.workspace_id,
            momo_agent::actions::AUDIT_MEMBER_AVATAR_SET,
        )
        .by(input.member_id)
        .about(person.id)
        .target("member", person.id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(momo_agent::actions::AUDIT_MEMBER_AVATAR_SET_SCHEMA, detail)],
        ref_type: REF_TYPE_MEMBER,
        ref_id: person.id,
        result_body: momo_agent::actions::member_avatar_set_result_body(),
        result_rows: vec![
            momo_agent::actions::action_row(
                "대상",
                momo_agent::actions::member_card_label(&person.display_name, &person.handle, false),
            ),
            momo_agent::actions::action_row("프로필 사진", "카드에 보인 이미지로 바뀌었어요"),
        ],
        secret_once: None,
        next: None,
    }))
}

/// `channel.member.add` (증보 V1/V6): seat each resolved member as `member`, as
/// the approver. A member who is already live in the channel is **skipped, not
/// re-added**: the upsert rewrites the role, so re-adding would quietly demote a
/// channel admin or owner to `member`.
async fn execute_channel_member_add(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    channel: &ResolvedChannel,
    members: &[ResolvedMember],
    already_in: &[Uuid],
) -> Result<Execution, momo_db::DbError> {
    let mut audits = Vec::new();
    let mut added = 0usize;
    // Inserted in id order: two approvals that share members must take their
    // row locks in the same order or they can deadlock.
    let mut ordered: Vec<&ResolvedMember> = members.iter().collect();
    ordered.sort_by_key(|member| member.id);
    for member in ordered {
        if already_in.contains(&member.id) {
            continue;
        }
        add_channel_member_in_tx(conn, input.workspace_id, channel.id, member.id, "member")
            .await?
            .ok_or_else(|| protocol_error("a resolved member could not be added"))?;
        added += 1;
        audits.push(
            AuditEntry::new(input.workspace_id, AUDIT_CHANNEL_MEMBER_ADDED)
                .by(input.member_id)
                .about(member.id)
                .target("channel", channel.id)
                .via_token(input.via_token_id)
                .run(approval.run_id)
                .with_schema(
                    AUDIT_CHANNEL_MEMBER_ADDED_SCHEMA,
                    json!({
                        "channel_id": channel.id.to_string(),
                        "role": "member",
                        "via_agent": approval.requested_by.to_string(),
                        "approval_id": approval.id.to_string(),
                    }),
                ),
        );
    }
    let skipped = members.len() - added;
    Ok(Execution::Ran(Executed {
        audits,
        ref_type: REF_TYPE_CHANNEL,
        ref_id: channel.id,
        result_body: channel_member_add_result_body(&channel.name, added, skipped),
        result_rows: channel_member_add_rows(
            &channel.name,
            &channel.kind,
            channel.member_count + added as i64,
            &members
                .iter()
                .filter(|member| !already_in.contains(&member.id))
                .map(ResolvedMember::card_label)
                .collect::<Vec<_>>(),
            skipped,
        ),
        secret_once: None,
        next: None,
    }))
}

/// `message.pin` / `message.unpin` (ADR-0186 증보 v5 U-e): the pin a person does by hand, done
/// **as the approver**, by the very function their own pin calls ([`set_pin_in_tx`]).
///
/// So the guards are theirs and not a copy: the approver must be a live member of the message's
/// channel, a deleted message cannot be pinned, a channel holds 100, and the broadcast
/// (`message.pinned` / `message.unpinned`) is the one every client already applies. `pinned_by`
/// is the approver; that an agent proposed it is in the audit, never in the pin.
///
/// The resolver (re-run just before this, with the message row locked `FOR UPDATE` and the body
/// hashed under that lock) has already proved that the message is still the one the card quoted,
/// so nothing can change it between that read and this pin.
///
/// Every refusal `set_pin_in_tx` makes — not a member, a full channel, a tombstone — is the
/// card's one word for a stale proposal, `action_args_invalid`, and it returns before the
/// function's first write: **the approval is not consumed**. A message already in the asked
/// state is a success that changes nothing (as it is for a person), and writes no pin audit
/// row, because nothing happened.
async fn execute_message_pin(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    change: PinAction,
    message: &ResolvedMessage,
) -> Result<Execution, momo_db::DbError> {
    let delta = match set_pin_in_tx(
        conn,
        input.workspace_id,
        message.id,
        input.member_id,
        change,
    )
    .await?
    {
        Ok(delta) => delta,
        Err(_) => {
            return Ok(Execution::Refused(args_invalid_refusal(
                approval, input, now,
            )))
        }
    };
    let unpin = change == PinAction::Unpinned;
    let mut audits = Vec::new();
    if delta.changed {
        // The same row, from the same builder, a person's own pin writes — plus who proposed it
        // and which approval it was. Ids only: not a word of the message.
        audits.push(crate::routes::messages::interaction_audit_entry(
            input.workspace_id,
            delta.channel_id,
            message.id,
            input.member_id,
            input.via_token_id,
            &format!("message.{}", delta.action.as_wire_label()),
            &[
                ("via_agent", approval.requested_by),
                ("approval_id", approval.id),
            ],
        ));
    }
    let pinned_after = message.card.pinned_count
        + match (delta.changed, unpin) {
            (true, false) => 1,
            (true, true) => -1,
            (false, _) => 0,
        };
    Ok(Execution::Ran(Executed {
        audits,
        ref_type: REF_TYPE_MESSAGE,
        ref_id: message.id,
        result_body: momo_agent::actions::message_pin_result_body(unpin, delta.changed, message.id),
        result_rows: momo_agent::actions::message_pin_result_rows(&message.card, pinned_after),
        secret_once: None,
        next: None,
    }))
}

/// `invite.create`: mint the code as the approver and show the link once.
async fn execute_invite_create(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    now: chrono::DateTime<Utc>,
    role: &'static str,
    max_uses: i32,
    expires_in_days: Option<i64>,
) -> Result<Execution, momo_db::DbError> {
    // ---- can this server address its own link? -----------------------------
    //
    // Judged before the mint, not after. A code exists exactly once, in the
    // response that carries it (D4), so minting one we cannot put in a link
    // would burn an invite nobody could ever use and leave a row in
    // `invite_code` that no person asked for. Specific to this action: the
    // other actions mint nothing a link could carry.
    let Some(origin) = input.public_origin else {
        return Ok(Execution::Refused(refusal(
            approval.id,
            input.member_id,
            "public_origin_unavailable",
            "this instance cannot address its own invite links",
            StatusCode::CONFLICT,
            now,
        )));
    };

    let now_ms = now.timestamp_millis();
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

    // UTC, like every other date this server renders. A client that wants the
    // reader's own calendar day formats it from the invite row; the card's row
    // is the server's statement about the instant it wrote.
    let expires_on = chrono::DateTime::from_timestamp_millis(created.invite.expires_at_ms)
        .ok_or_else(|| protocol_error("minted invite has an unrepresentable expiry"))?
        .format("%Y-%m-%d")
        .to_string();

    let audit = AuditEntry::new(input.workspace_id, INVITE_CREATED_AUDIT_ACTION)
        .by(input.member_id)
        .target("invite_code", created.invite.id)
        .via_token(input.via_token_id)
        .run(approval.run_id)
        .with_schema(
            INVITE_CREATED_AUDIT_SCHEMA,
            // The REST route's two fields plus this path's provenance. Role and
            // reach only — never the code, never its hash, never the preview
            // (`routes::invites::create`'s discipline, and an audit row is read
            // by more people than a response is).
            json!({
                "role": role,
                "max_uses": max_uses,
                "via_agent": approval.requested_by.to_string(),
                "approval_id": approval.id.to_string(),
            }),
        );

    Ok(Execution::Ran(Executed {
        audits: vec![audit],
        ref_type: REF_TYPE_INVITE,
        ref_id: created.invite.id,
        result_body: invite_result_body(
            role,
            max_uses,
            expires_in_days.unwrap_or(DEFAULT_INVITE_EXPIRES_IN_DAYS),
        ),
        result_rows: invite_result_rows(role, &expires_on),
        secret_once: Some(SecretOnceDto {
            kind: SECRET_ONCE_INVITE_LINK.to_string(),
            value: join_url,
            expires_at_ms: created.invite.expires_at_ms,
        }),
        next: Some(INVITE_RESULT_NEXT),
    }))
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
pub(crate) fn is_url_safe_code_byte(byte: u8) -> bool {
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
    // ADR-0162 증보 5 G4 — a rejected in-place channel grant ends the held run
    // with its own code and tells the person who called, in words, why nothing
    // happened; a tool-call rejection keeps its sentence.
    let in_place = momo_agent::in_place_grant::is_in_place_grant(&approval.payload);
    let (code, body) = if in_place {
        (
            momo_agent::in_place_grant::IN_PLACE_GRANT_REJECTED_CODE,
            momo_agent::in_place_grant::IN_PLACE_GRANT_REJECTED_BODY,
        )
    } else {
        ("approval_rejected", REJECTED_TOOL_RESULT_BODY)
    };
    let ended = end_parked_run_in_tx(
        conn,
        approval.run_id,
        RunStatus::Cancelled,
        &json!({
            "code": code,
            "approval_id": approval.id.to_string(),
            "reason": reason,
        }),
    )
    .await?;
    if !ended {
        return Ok(());
    }

    // ADR-0186 증보 v5 U-f — the proposer's inbox hears the rejection too, and
    // **before** the outcome line below (`wake_proposer_in_tx` says why). Behind
    // the `ended` guard: a run a person cancelled first already wrote its own
    // reference, and a decision that moved nothing announces nothing.
    wake_proposer_in_tx(conn, approval).await?;

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
    let mut props = ToolResult::error(call_id, body).message_props();
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
            body: Some(body.to_string()),
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
    credential_via: Option<&'static str>,
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
            .with_schema(
                TOOL_AUDIT_SCHEMA,
                momo_agent::initiative::decision_audit_detail(
                    approval,
                    stamp_via(credential_via, event.clone()),
                ),
            ),
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

/// ADR-0188 D3 — the host a decision is **about**: 「판정 기준은 최종 선택
/// host다. host 선택이 있으면 선택된 host의 소유자가 기준이다」.
///
/// * **Approving** — the host the spawn will finally run on: the approver's
///   pick, else the card's default. That is exactly what [`resolve_host_choice`]
///   already settled and judged eligible, so it is read from there rather than
///   recomputed.
/// * **Rejecting** — nothing will run, so it is the host **the card** points at:
///   its default, else the host the request itself named
///   ([`momo_agent::approval::requested_execution_host`] — a tool-path card can
///   pre-select nothing).
///   The decider's pick is **ignored** (ADR-0188 R0.1, #2582). It chooses
///   nothing on a rejection, so all it could still choose is which ownership
///   rule applies — and a team box is a selectable candidate on every card, so
///   honouring it let a colleague settle a card sitting on somebody's laptop by
///   "picking" the VPS while saying no.
/// * `None` for an approval that asks no host question — every approval that is
///   not a spawn. ADR-0188 D3 says nothing about who decides those.
fn decision_reference_host(
    approval: &LockedApproval,
    input: &DecisionInput<'_>,
    host_choice: &HostChoice,
) -> Option<Uuid> {
    if input.approve {
        return host_choice.selected;
    }
    // The card's own host: `reference_execution_host` is the one definition, shared
    // with the push judgment (ADR-0204 D7) so the notification wakes the owner of
    // the very machine this rejection would be judged against.
    reference_execution_host(&approval.payload)
}

/// `execution.tool` — the tool a spawn card asks to start, as
/// `momo_t3::work_control::spawn_execution_object` writes it beside the host
/// candidates on both producers (the REST ledger and the `work.session.spawn`
/// tool).
fn spawn_execution_tool(payload: &Value) -> Option<&str> {
    payload
        .get("execution")
        .and_then(|execution| execution.get("tool"))
        .and_then(Value::as_str)
}

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

    /// `deliverSecretToAgent` truth table (ADR-0186 증보 v3, security review of
    /// #3795): honoured only when approving a workspace action that offers
    /// opt-in delivery — every other cell is a refusal. The `offers_opt_in` row
    /// is exercised here because no registry action occupies it yet.
    #[test]
    fn the_deliver_flag_is_honoured_in_exactly_one_cell() {
        for action_type in [ACTION_TYPE_WORKSPACE_ACTION, "tool_call"] {
            for approve in [true, false] {
                for offers in [true, false] {
                    let honoured = !deliver_flag_refused(true, action_type, approve, offers);
                    assert_eq!(
                        honoured,
                        action_type == ACTION_TYPE_WORKSPACE_ACTION && approve && offers,
                        "{action_type} approve={approve} offers={offers}"
                    );
                    // Not asking is never a refusal.
                    assert!(!deliver_flag_refused(false, action_type, approve, offers));
                }
            }
        }
    }

    /// No registry action opts in during P0, so the payload reader says no for
    /// every real, unknown and absent id.
    #[test]
    fn nothing_offers_opt_in_delivery_in_p0() {
        for payload in [
            json!({"action": {"id": "invite.create"}}),
            json!({"action": {"id": "no.such.action"}}),
            json!({}),
        ] {
            assert!(!payload_offers_opt_in_delivery(&payload), "{payload}");
        }
    }

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
            crate::routes::actions::validated_action_args(
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

    fn spawn_card(execution: Value) -> LockedApproval {
        LockedApproval {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            run_id: Uuid::from_u128(3),
            channel_id: Uuid::from_u128(4),
            requested_by: Uuid::from_u128(5),
            request_message_id: Some(Uuid::from_u128(6)),
            action_type: momo_t3::work_control::ACTION_TYPE_WORK_SPAWN.to_string(),
            payload: json!({ "execution": execution }),
            status: "pending".to_string(),
            expires_at: None,
            agent_model: "hermes-agent".to_string(),
            agent_model_source: momo_agent::ModelSource::Agent,
            run_input: json!({}),
            step_count: 0,
            max_steps: 50,
            depth: 0,
        }
    }

    fn decision(approve: bool, pick: Option<Uuid>) -> DecisionInput<'static> {
        DecisionInput {
            workspace_id: Uuid::from_u128(2),
            approval_id: Uuid::from_u128(1),
            route_run_id: None,
            member_id: Uuid::from_u128(7),
            via_token_id: None,
            credential_via: None,
            approve,
            reason: None,
            client_decision_id: Uuid::from_u128(8),
            selected_host_id: pick,
            public_origin: None,
            claude_subscription_agents_enabled: false,
            operator_scope: false,
            deliver_secret_to_agent: false,
            context_max_messages: 30,
        }
    }

    /// ADR-0188 R0.1 (#2582) — a rejection is judged on the host the **card**
    /// points at, never on the decider's pick; an approval on the host it will
    /// really run on.
    #[test]
    fn a_rejection_is_judged_on_the_card_and_never_on_the_pick() {
        let laptop = Uuid::from_u128(10);
        let vps = Uuid::from_u128(11);
        let candidates = json!([
            {"host_id": laptop.to_string(), "selectable": true},
            {"host_id": vps.to_string(), "selectable": true},
        ]);
        let card = spawn_card(json!({
            "requested_host_id": vps.to_string(),
            "default_host_id": laptop.to_string(),
            "host_candidates": candidates,
        }));
        let nothing_runs = HostChoice { selected: None };

        // The card sits on the laptop: picking the VPS (a candidate the card
        // offers) while rejecting does not move it, and neither does no pick.
        for pick in [Some(vps), None, Some(Uuid::from_u128(99))] {
            assert_eq!(
                decision_reference_host(&card, &decision(false, pick), &nothing_runs),
                Some(laptop),
                "rejecting with pick {pick:?}"
            );
        }
        // …and the other way round: a card on the VPS stays on the VPS when
        // the laptop is picked.
        let team_card = spawn_card(json!({
            "requested_host_id": vps.to_string(),
            "default_host_id": vps.to_string(),
            "host_candidates": candidates,
        }));
        assert_eq!(
            decision_reference_host(&team_card, &decision(false, Some(laptop)), &nothing_runs),
            Some(vps)
        );

        // A card that pre-selected nothing is judged on the host the request
        // named.
        let bare = spawn_card(json!({
            "requested_host_id": laptop.to_string(),
            "default_host_id": null,
            "host_candidates": [],
        }));
        assert_eq!(
            decision_reference_host(&bare, &decision(false, Some(vps)), &nothing_runs),
            Some(laptop)
        );
        let no_host_at_all = spawn_card(json!({
            "requested_host_id": null,
            "default_host_id": null,
            "host_candidates": [],
        }));
        assert_eq!(
            decision_reference_host(&no_host_at_all, &decision(false, None), &nothing_runs),
            None
        );

        // Approving is judged on the host the spawn will run on, which
        // `resolve_host_choice` has already settled.
        assert_eq!(
            decision_reference_host(
                &card,
                &decision(true, Some(vps)),
                &HostChoice {
                    selected: Some(vps)
                }
            ),
            Some(vps)
        );

        // No execution object: no host question, whatever was sent.
        let mut plain = spawn_card(json!({}));
        plain.payload = json!({"tool_call": {"name": "work.session.end"}});
        assert_eq!(
            decision_reference_host(&plain, &decision(false, Some(vps)), &nothing_runs),
            None
        );
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

    /// #3927 — the door a decision came through is named in the decision's own
    /// audit row, and only when there is a door to name.
    #[test]
    fn a_credential_is_named_in_the_audit_detail_only_when_there_is_one() {
        let event = json!({"action": "decided", "status": "approved"});
        assert_eq!(stamp_via(None, event.clone()), event);
        assert_eq!(
            stamp_via(Some(AUDIT_VIA_PUSH_ACTION), event.clone()),
            json!({"action": "decided", "status": "approved", "via": "push_action"})
        );
        // The caller's copy is untouched: the broadcast and the resume job are
        // built from the unstamped event.
        assert!(event.get("via").is_none());
    }

    /// The lock screen's token is NARROWER than the access token it was minted
    /// beside, never wider: its only scope is the documentary `push:action`, so it
    /// carries no `platform:read` and a platform operator who is not an admin gets
    /// `role_required` for the operator-gated settings actions with it, where their
    /// access token would pass. Pinned so nobody "fixes" it by copying the caller's
    /// scopes into the token.
    #[test]
    fn the_token_carries_no_operator_standing() {
        let issued = momo_auth::sign_push_action(Uuid::from_u128(1), Uuid::from_u128(2), "s3cret")
            .expect("sign");
        let principal = momo_auth::verify_app_push_action(&issued.token, "s3cret").expect("verify");
        assert_eq!(
            principal.scopes,
            vec![momo_auth::SCOPE_PUSH_ACTION.to_string()]
        );
        assert!(!has_platform_read_scope(&principal));
    }

    /// The backstop's truth table: only the lock screen's credential WITH a value to
    /// show once is stopped; an access token (no `credential_via`) gets its value, and
    /// a credentialed decision that produced nothing proceeds.
    #[test]
    fn a_value_shown_once_never_reaches_the_lock_screen_credential() {
        assert!(shows_a_value_to_the_lock_screen(
            Some(AUDIT_VIA_PUSH_ACTION),
            true
        ));
        assert!(!shows_a_value_to_the_lock_screen(
            Some(AUDIT_VIA_PUSH_ACTION),
            false
        ));
        assert!(!shows_a_value_to_the_lock_screen(None, true));
        assert!(!shows_a_value_to_the_lock_screen(None, false));
    }

    /// The `opens_in_app` refusal is a receipt like every other expected failure,
    /// and it executes nothing.
    #[test]
    fn opens_in_app_is_a_receipt_like_every_other_expected_failure() {
        let decision = refusal(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            OPENS_IN_APP,
            "this approval must be decided in the app",
            StatusCode::FORBIDDEN,
            Utc::now(),
        );
        assert_eq!(decision.status, StatusCode::FORBIDDEN);
        assert!(decision.secret_once.is_none());
        let receipt: ApprovalDecisionReceipt =
            serde_json::from_value(decision.receipt).expect("receipt decodes");
        assert_eq!(receipt.status, "opens_in_app");
        assert!(receipt.result.is_none());
    }

    /// A row that already says which door ITS action came through keeps saying it
    /// (`channels.granted`'s `via: in_place_grant`); the credential does not
    /// overwrite it, and a non-object detail is passed through, not wrapped.
    #[test]
    fn stamping_never_overwrites_an_existing_via_or_wraps_a_scalar() {
        let granted = json!({"channel_ids": [], "via": "in_place_grant"});
        assert_eq!(
            stamp_via(Some(AUDIT_VIA_PUSH_ACTION), granted.clone()),
            granted
        );
        assert_eq!(
            stamp_via(Some(AUDIT_VIA_PUSH_ACTION), json!("scalar")),
            json!("scalar")
        );
    }
}
