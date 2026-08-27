//! Work-session lifecycle (ADR-0114 ledger + ADR-0140 T3 billing) — Swift
//! `WorkSessionRoutes.swift:119-124` parity for the four routes that batch names.
//!
//! ```text
//! POST  /v1/workspaces/{ws}/work-sessions                    create
//! PATCH /v1/workspaces/{ws}/work-sessions/{session}          end   (status="ended")
//! POST  /v1/workspaces/{ws}/work-sessions/{session}/resume   resume
//! GET   /v1/workspaces/{ws}/work-sessions?active=0|1         list
//! ```
//!
//! ## The one rule this module exists to keep
//!
//! **Settlement happens in `t3_terminate` and nowhere else.** The end path calls
//! [`momo_t3::terminate_in_tx`] (which is a single `SELECT t3_terminate(…)`) and
//! then performs the ordinary, tier-agnostic `status = 'ended'` write that a
//! T1/T2 session performs too. There is no `settled_at`, `active_seconds` or
//! `credit_entry` statement anywhere in this crate; if one appeared, migration
//! 053's `work_host_usage_settlement_guard` would refuse it at runtime — which
//! is exactly what the smoke's red assertion proves.
//!
//! ## Transaction shape
//!
//! Every mutation runs inside ONE transaction that took the ADR-0140 D2 ladder
//! first ([`momo_t3::with_t3_lifecycle_tx`]) when a cloud host is involved, and a
//! plain tenant transaction when one is not — the same branch Swift makes with
//! `withTenantLifecycleTransactionUnwrapped(cloudHostID: nil)`. The cloud-host id
//! is pre-resolved without a lock, then re-read inside the transaction and
//! compared; a difference is a 409 (`revalidateT3CloudHost`, :642-691), never a
//! write under the wrong advisory.
//!
//! Authorization checks inside those transactions return through
//! [`Rejectable`](crate::routes::shared::Rejectable) and **always precede the
//! first write**, so a rejected request commits a read-only transaction — the
//! same effect Swift gets by throwing out of the closure.
//!
//! ## Named parity (#1777 closed the host-signed session arms)
//!
//! * Host-signed `POST …/work-sessions` (`controlId` ↔ dispatched spawn) and
//!   `PATCH` idle/running + `bindRemotePTY` are served (#1777). Observation is
//!   the human-owner PATCH (#1778). ACP event ingestion is the host-signed
//!   PATCH `event` arm (#1785).
//! * `resume` drops **one** Swift step now: the audit row (see the crate-level
//!   note on `momo_db::audit`). The two that mattered are back — the
//!   `work_tier_policy` gate with `requireResumeTarget` (:1855-1871, #1139) and
//!   the `work_control` spawn dispatch that tells a daemon to actually restart
//!   the tool (:1940-1959, #1138's fourth measurement). Both were absences a
//!   client could not compensate for: the first made the client-side target
//!   filter the *only* check in the system, and the second made 「인수」 a
//!   promise about a ledger row rather than about a running tool.

use std::collections::HashSet;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::sqlx;
use momo_messaging::{cent_channel, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::work_control::{
    control_event_payload, dispatched_spawn_owner_in_tx, insert_work_control_in_tx,
    record_host_last_used_in_tx, resume_target_rejection_in_tx, NewWorkControl,
    ResumeTargetRejection, KIND_SPAWN, STATUS_DISPATCHED,
};
use momo_t3::{
    acquire_slot_in_tx, allocate_uuid_v7, card_props, close_control_window_in_tx,
    cloud_host_id_for_host, cloud_host_id_for_host_in_tx, cloud_host_id_for_session_in_tx,
    create_resumed_work_session_in_tx, create_work_session_with_id_in_tx, end_work_session_in_tx,
    is_active_channel_member_in_tx, lifecycle_payload, list_work_session_details_in_tx,
    lock_work_session_detail_in_tx, mark_work_session_resumed_in_tx, parse_remote_pty_binding,
    pause_usage_in_tx, remote_pty_host_status_in_tx, resolve_cloud_host_id,
    set_work_session_observation_in_tx, start_usage_in_tx, terminate_in_tx, tool_lifecycle_payload,
    transition_tool_lifecycle_in_tx, update_session_card_props_in_tx, work_session_scope_in_tx,
    work_tool_is_enabled_in_tx, write_remote_pty_binding_in_tx, ControlWindowEndReason,
    NewWorkSession, RemotePtyBinding, RemotePtyHostStatus, T3Error, T3LockLadder,
    TerminationReason, WorkSessionDetail,
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::dto::{
    CreateWorkSessionRequest, ResumeWorkSessionRequest, UpdateWorkSessionRequest,
    WorkSessionAcpEvent, WorkSessionDto, WorkSessionListQuery, WorkSessionListResponse,
    WorkSessionResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, lifecycle_body, path_uuid, require_human, require_human_or_work_host,
    settle, t3_error, tenant_tx, workspace_scope, Rejectable,
};
use crate::work_host_auth::signed_request_unauthorized;
use crate::AppState;

// ---------------------------------------------------------------------------
// validation + wire shaping
// ---------------------------------------------------------------------------

/// `WorkToolProfileRoutes.validatedToolKey` (:247-253): `^[a-z0-9][a-z0-9._-]{1,63}$`.
fn validated_tool(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim().to_lowercase();
    let mut characters = value.chars();
    let first_ok = characters
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest: Vec<char> = characters.collect();
    let rest_ok = (1..=63).contains(&rest.len())
        && rest
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(*c));
    if first_ok && rest_ok {
        Ok(value)
    } else {
        Err(ApiError::bad_request("invalid work tool key"))
    }
}

/// Web wire + openapi `UpdateWorkSessionObservationRequest`: `open` | `owner_only`.
fn validated_observation(raw: &str) -> Result<&'static str, ApiError> {
    match raw {
        "open" => Ok("open"),
        "owner_only" => Ok("owner_only"),
        _ => Err(ApiError::bad_request(
            "observation must be open or owner_only",
        )),
    }
}

/// `validatedLabel` (:2099-2105).
fn validated_label(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim().to_string();
    let length = value.chars().count();
    if (1..=120).contains(&length) {
        Ok(value)
    } else {
        Err(ApiError::bad_request(
            "label must contain 1...120 characters",
        ))
    }
}

/// `activeFilter` (:2107-2113): absent/`"0"`/`"1"`, anything else is a 400.
fn active_filter(raw: Option<&str>) -> Result<bool, ApiError> {
    match raw {
        None | Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => Err(ApiError::bad_request("active must be 0 or 1")),
    }
}

fn session_dto(detail: WorkSessionDetail) -> WorkSessionDto {
    WorkSessionDto {
        id: detail.id.to_string(),
        workspace_id: detail.workspace_id.to_string(),
        channel_id: detail.channel_id.to_string(),
        member_id: detail.member_id.to_string(),
        host_id: detail.host_id.to_string(),
        root_message_id: detail.root_message_id.to_string(),
        tool: detail.tool,
        label: detail.label,
        status: detail.status,
        observation: detail.observation,
        observer_grant_count: detail.observer_grant_count,
        remote_attach_available: detail.remote_attach_available,
        remote_display_available: detail.remote_display_available,
        control_started_at: detail.control_started_at_ms,
        started_at_ms: detail.started_at_ms,
        ended_at_ms: detail.ended_at_ms,
        exit_code: detail.exit_code,
        end_reason: detail.end_reason,
        resumed_from_session_id: detail.resumed_from_session_id.map(|id| id.to_string()),
    }
}

// `card_props` and `lifecycle_payload` moved to `momo_t3::lifecycle` when goal
// SRV-T1 gave work-session control a **second** caller: the agent's
// `work.session.end` tool, executed by momo-agent-worker once a human approves
// it. Both callers now render one card and one envelope. Keeping them private
// here would have meant the worker growing its own copy, and two builders for
// one card is how a session ends in the database while the timeline still shows
// it running.

/// Reject the request shapes this batch does not serve, by name (ADR-0134 D1).
fn reject_unsupported_create(request: &CreateWorkSessionRequest) -> Result<(), ApiError> {
    if request.control_id.is_some() {
        return Err(ApiError::bad_request(
            "controlId is reserved for work host dispatch",
        ));
    }
    if request.pty_id.is_some() || request.attach_endpoint.is_some() {
        return Err(ApiError::bad_request(
            "remote PTY binding requires work host signature",
        ));
    }
    // LIVE-1's pair, refused the same way and for a stronger reason: unlike the
    // PTY arm, this server *does* serve a display binding — on
    // `POST …/work-sessions/{session}/display-binding`, work-host-signed. So the
    // refusal here is not "unported", it is a boundary: a human bearer may not
    // tell the ledger what is on a machine's screen.
    if request.display_id.is_some() || request.display_endpoint.is_some() {
        return Err(ApiError::bad_request(
            "display binding requires work host signature",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-sessions` → 201 (Swift `create`, :126-326).
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateWorkSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_human_or_work_host(&principal, "work sessions require a human or work host")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let host_signed = principal.kind == PrincipalKind::WorkHost;
    if host_signed {
        let Some(signing_host) = principal.token_id else {
            return Err(signed_request_unauthorized());
        };
        if request.host_id != signing_host || request.control_id.is_none() {
            return Err(ApiError::forbidden("work host session binding is invalid"));
        }
        if request.display_id.is_some() || request.display_endpoint.is_some() {
            return Err(ApiError::bad_request(
                "display binding requires work host signature",
            ));
        }
    } else {
        reject_unsupported_create(&request)?;
    }
    let tool = validated_tool(&request.tool)?;
    let label = validated_label(&request.label)?;
    let remote_pty = parse_remote_pty_binding(
        request.pty_id.as_deref(),
        request.attach_endpoint.as_deref(),
    )
    .map_err(|error| ApiError::bad_request(error.message()))?;
    let channel_id = request.channel_id;
    let host_id = request.host_id;
    let control_id = request.control_id;
    let member_id = principal.member_id;

    // No lock: the id only chooses which advisory the transaction takes, and the
    // transaction re-reads it under the ladder.
    let cloud_host_id = cloud_host_id_for_host(&state.pool, workspace_id, host_id)
        .await
        .map_err(|error| t3_error("work_sessions.create.resolve", error))?;

    let body = lifecycle_body(move |conn: &mut momo_db::PgConnection| {
        Box::pin(async move {
            create_in_tx(
                conn,
                workspace_id,
                member_id,
                channel_id,
                host_id,
                cloud_host_id,
                &tool,
                &label,
                control_id,
                remote_pty,
            )
            .await
        }) as _
    });

    let detail = settle(
        "work_sessions.create",
        match cloud_host_id {
            // T3: the host advisory + the work_pool rung (slot admission writes
            // to the workspace axis) exactly as Swift asks for
            // (`lockWorkPool: targetCloudHostID != nil`, :165).
            Some(cloud_host_id) => {
                momo_t3::with_t3_lifecycle_tx(
                    &state.pool,
                    workspace_id,
                    T3LockLadder::host(cloud_host_id).with_work_pool(),
                    body,
                )
                .await
            }
            // T1/T2: no cloud host exists, so there is no advisory to take.
            None => tenant_tx(&state.pool, workspace_id, body).await,
        },
    )?;

    Ok((
        StatusCode::CREATED,
        Json(WorkSessionResponse {
            work_session: session_dto(detail),
        }),
    ))
}

#[allow(clippy::too_many_arguments)]
async fn create_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
    host_id: Uuid,
    expected_cloud_host_id: Option<Uuid>,
    tool: &str,
    label: &str,
    control_id: Option<Uuid>,
    remote_pty: Option<RemotePtyBinding>,
) -> Rejectable<WorkSessionDetail> {
    // ---- rejections first (nothing is written above this line) -------------
    if cloud_host_id_for_host_in_tx(conn, workspace_id, host_id).await? != expected_cloud_host_id {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work host cloud lifecycle changed; retry",
        )));
    }
    if !work_tool_is_enabled_in_tx(conn, workspace_id, tool).await? {
        return Ok(Err(ApiError::bad_request(
            "work tool is not registered or enabled",
        )));
    }
    // Host-signed create: the owner is the requesting agent's human, never the
    // host's own member_id. Human create keeps the bearer as owner.
    let session_owner_member_id = if let Some(control_id) = control_id {
        match dispatched_spawn_owner_in_tx(
            conn,
            workspace_id,
            control_id,
            channel_id,
            host_id,
            tool,
            label,
        )
        .await?
        {
            Some(owner) => owner,
            None => {
                return Ok(Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "spawn control is not dispatchable by this host",
                )))
            }
        }
    } else {
        member_id
    };
    if remote_pty.is_some() {
        match remote_pty_host_status_in_tx(conn, workspace_id, host_id).await? {
            RemotePtyHostStatus::Capable => {}
            RemotePtyHostStatus::NotFound => {
                return Ok(Err(ApiError::forbidden("work host not found")))
            }
            RemotePtyHostStatus::NotCapable => {
                return Ok(Err(ApiError::forbidden(
                    "work host does not support terminal attach",
                )))
            }
        }
    }
    if !is_active_channel_member_in_tx(conn, workspace_id, channel_id, session_owner_member_id)
        .await?
    {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }
    // Slot admission (`WorkPoolRoutes.acquireSlot`). Its 409 vocabulary is the
    // Swift one, not the domain error's Display.
    if let Err(error) =
        acquire_slot_in_tx(conn, workspace_id, session_owner_member_id, host_id).await
    {
        return Ok(Err(match error {
            T3Error::SlotsExhausted { .. } => ApiError::new(StatusCode::CONFLICT, "pool_exhausted"),
            T3Error::MemberSlotLimit { .. } => ApiError::new(StatusCode::CONFLICT, "member_limit"),
            other => return Err(other),
        }));
    }

    // ---- writes ------------------------------------------------------------
    let session_id = allocate_uuid_v7(conn).await?;
    let props = card_props(session_id, tool, label, "running", None, None, None, None);

    // The card message goes through the messaging write path, so the seq bump,
    // the message row and its `message.new` broadcast keep exactly one
    // implementation (invariant #3/#4). `client_msg_id = session_id` is Swift's
    // (:244) — it makes the card idempotent per session.
    let card = send_message_in_tx(
        conn,
        workspace_id,
        NewMessage {
            channel_id,
            author_member_id: session_owner_member_id,
            message_type: MessageType::System,
            body: None,
            props: props.clone(),
            root_id: None,
            reply_to_id: None,
            client_msg_id: Some(session_id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await
    .map_err(T3Error::from)?;

    let session = create_work_session_with_id_in_tx(
        conn,
        workspace_id,
        session_id,
        NewWorkSession {
            channel_id,
            member_id: session_owner_member_id,
            host_id,
            root_message_id: card.message.id,
            tool: tool.to_string(),
            label: label.to_string(),
        },
    )
    .await?;

    if let Some(binding) = remote_pty.as_ref() {
        if !write_remote_pty_binding_in_tx(conn, workspace_id, session.id, binding).await? {
            return Ok(Err(ApiError::new(
                StatusCode::CONFLICT,
                "work session state changed; retry",
            )));
        }
    }

    // Opens the T3 ledger + first `active` interval and moves the cloud host to
    // `running`. `None` = a T1/T2 host: same call site, no ledger.
    start_usage_in_tx(conn, workspace_id, session.id, host_id).await?;

    let detail = lock_work_session_detail_in_tx(conn, workspace_id, session.id)
        .await?
        .ok_or(T3Error::SessionNotFound)?;
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &lifecycle_payload(
            &cent_channel(workspace_id, channel_id),
            "work.session.started",
            &detail.0,
            card.message.seq,
        ),
        Some(channel_id),
    )
    .await
    .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;

    Ok(Ok(detail.0))
}

// ---------------------------------------------------------------------------
// end
// ---------------------------------------------------------------------------

/// `PATCH /v1/workspaces/{ws}/work-sessions/{session}` (Swift `end`, :328-601).
///
/// Dispatcher: bindRemotePTY, ACP (#1785), observation (human owner, #1778),
/// idle/running, then the `status: "ended"` arm.
pub async fn end(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    Json(request): Json<UpdateWorkSessionRequest>,
) -> Result<Json<WorkSessionResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;

    if request.display_id.is_some() || request.display_endpoint.is_some() {
        return Err(ApiError::bad_request(
            "display binding requires work host signature",
        ));
    }
    if request.pty_id.is_some() || request.attach_endpoint.is_some() {
        if request.status.is_some()
            || request.exit_code.is_some()
            || request.observation.is_some()
            || request.event.is_some()
        {
            return Err(ApiError::bad_request(
                "remote PTY binding cannot be combined with lifecycle fields",
            ));
        }
        // Human unsigned path stays 400 (regression lock). A signed host is
        // dispatched into bindRemotePTY.
        if principal.kind != PrincipalKind::WorkHost {
            return Err(ApiError::bad_request(
                "remote PTY binding requires work host signature",
            ));
        }
        return bind_remote_pty(state, principal, workspace_id, session_id, &request).await;
    }
    if let Some(event) = request.event {
        if request.status.is_some() || request.exit_code.is_some() || request.observation.is_some()
        {
            return Err(ApiError::bad_request(
                "event cannot be combined with lifecycle fields",
            ));
        }
        // Unsigned keeps the current 400 sentence (regression lock). Swift's
        // in-handler check is 403 "ACP events require work host signature";
        // #1777 kept the existing unsigned 400 for the other host-only arms.
        if principal.kind != PrincipalKind::WorkHost {
            return Err(ApiError::bad_request(
                "ACP event ingestion requires work host signature",
            ));
        }
        return record_acp_event(state, principal, workspace_id, session_id, event).await;
    }
    if let Some(observation) = request.observation.as_deref() {
        if request.status.is_some() || request.exit_code.is_some() {
            return Err(ApiError::bad_request(
                "observation cannot be combined with lifecycle fields",
            ));
        }
        return update_observation(state, principal, workspace_id, session_id, observation).await;
    }
    match request.status.as_deref() {
        Some("ended") => {}
        Some("idle") => {
            if principal.kind != PrincipalKind::WorkHost {
                return Err(ApiError::forbidden(
                    "tool lifecycle transitions require work host signature",
                ));
            }
            let Some(exit_code) = request.exit_code else {
                return Err(ApiError::bad_request("idle transition requires exitCode"));
            };
            return transition_lifecycle(
                state,
                principal,
                workspace_id,
                session_id,
                "idle",
                Some(exit_code),
            )
            .await;
        }
        Some("running") => {
            if principal.kind != PrincipalKind::WorkHost {
                return Err(ApiError::forbidden(
                    "tool lifecycle transitions require work host signature",
                ));
            }
            if request.exit_code.is_some() {
                return Err(ApiError::bad_request(
                    "running transition does not accept exitCode",
                ));
            }
            return transition_lifecycle(
                state,
                principal,
                workspace_id,
                session_id,
                "running",
                None,
            )
            .await;
        }
        _ => {
            return Err(ApiError::bad_request(
                "status must be idle, running, or ended",
            ))
        }
    }

    let member_id = principal.member_id;
    let signing_host_id = match principal.kind {
        PrincipalKind::WorkHost => {
            Some(principal.token_id.ok_or_else(signed_request_unauthorized)?)
        }
        _ => None,
    };
    let exit_code = request.exit_code;
    let cloud_host_id = resolve_cloud_host_id(&state.pool, workspace_id, session_id)
        .await
        .map_err(|error| t3_error("work_sessions.end.resolve", error))?;

    let body = lifecycle_body(move |conn: &mut momo_db::PgConnection| {
        Box::pin(async move {
            end_in_tx(
                conn,
                workspace_id,
                member_id,
                signing_host_id,
                session_id,
                cloud_host_id,
                exit_code,
            )
            .await
        }) as _
    });

    let detail = settle(
        "work_sessions.end",
        match cloud_host_id {
            // `with_workspace_credit` because this transaction may reach
            // `t3_terminate`, which appends a `credit_entry` and therefore
            // arrives at the same workspace row from the other direction.
            Some(cloud_host_id) => {
                momo_t3::with_t3_lifecycle_tx(
                    &state.pool,
                    workspace_id,
                    T3LockLadder::host(cloud_host_id).with_workspace_credit(),
                    body,
                )
                .await
            }
            None => tenant_tx(&state.pool, workspace_id, body).await,
        },
    )?;

    Ok(Json(WorkSessionResponse {
        work_session: session_dto(detail),
    }))
}

async fn end_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    signing_host_id: Option<Uuid>,
    session_id: Uuid,
    expected_cloud_host_id: Option<Uuid>,
    exit_code: Option<i32>,
) -> Rejectable<WorkSessionDetail> {
    if cloud_host_id_for_session_in_tx(conn, workspace_id, session_id).await?
        != expected_cloud_host_id
    {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session cloud lifecycle changed; retry",
        )));
    }

    if expected_cloud_host_id.is_some() {
        // Authorization WITHOUT the session row lock (Swift :441-443):
        // `t3_terminate` owns the `usage → session` rungs and must take them
        // after the prelude's `credit → cloud host`. Taking the session row here
        // would invert that order.
        let Some((owner_member_id, host_id, channel_id)) =
            work_session_scope_in_tx(conn, workspace_id, session_id).await?
        else {
            return Ok(Err(ApiError::not_found("work session not found")));
        };
        if let Some(signing_host_id) = signing_host_id {
            if host_id != signing_host_id {
                return Ok(Err(ApiError::forbidden(
                    "work host cannot end another host session",
                )));
            }
        } else if owner_member_id != member_id {
            return Ok(Err(ApiError::forbidden(
                "only the session owner can end it",
            )));
        }
        if !is_active_channel_member_in_tx(conn, workspace_id, channel_id, owner_member_id).await? {
            return Ok(Err(ApiError::forbidden(
                "active channel membership required",
            )));
        }
        // ---- the ONE settlement statement ---------------------------------
        terminate_in_tx(conn, workspace_id, session_id, TerminationReason::Ended).await?;
    }

    let Some((existing, root_seq)) =
        lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if let Some(signing_host_id) = signing_host_id {
        if existing.host_id != signing_host_id {
            return Ok(Err(ApiError::forbidden(
                "work host cannot end another host session",
            )));
        }
    } else if existing.member_id != member_id {
        return Ok(Err(ApiError::forbidden(
            "only the session owner can end it",
        )));
    }
    if !is_active_channel_member_in_tx(conn, workspace_id, existing.channel_id, existing.member_id)
        .await?
    {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }
    // Already ended: idempotent 200 with the row as it stands (Swift :530-541).
    //
    // The window still gets closed on the way out, and that is not belt-and-
    // braces. A session can reach `ended` by paths that do not run the block
    // below — the offline sweep and `t3_terminate` settle the ledger and leave
    // the control window to the lease backstop — and a window left open on a
    // finished session is a row that says a person holds a keyboard on a screen
    // that no longer exists. Idempotent 재종료 is where the ledger gets to be
    // honest about that, at the cost of one UPDATE that almost always matches
    // nothing.
    if existing.status == "ended" {
        close_control_window_for_ended_session_in_tx(
            conn,
            workspace_id,
            existing.channel_id,
            session_id,
        )
        .await?;
        return Ok(Ok(existing));
    }

    let Some(ended) = end_work_session_in_tx(conn, workspace_id, session_id, exit_code).await?
    else {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session state changed; retry",
        )));
    };

    // The third close of ADR-0004 증보 3's control window (076): the session
    // ended underneath somebody's keyboard.
    close_control_window_for_ended_session_in_tx(conn, workspace_id, ended.channel_id, session_id)
        .await?;

    let props = card_props(
        ended.id,
        &ended.tool,
        &ended.label,
        "ended",
        ended.ended_at_ms,
        ended.exit_code,
        None,
        None,
    );
    update_session_card_props_in_tx(
        conn,
        workspace_id,
        ended.root_message_id,
        &props.to_string(),
    )
    .await?;

    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &lifecycle_payload(
            &cent_channel(workspace_id, ended.channel_id),
            "work.session.ended",
            &ended,
            root_seq,
        ),
        Some(ended.channel_id),
    )
    .await
    .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;

    Ok(Ok(ended))
}

/// Close the control window a session leaves behind, and announce it.
///
/// The `session_ended` arm of ADR-0004 증보 3's three closes, shared by every
/// lifecycle path in this module that takes a session away from underneath a
/// person's keyboard: the end, the idempotent 재종료 of a session something else
/// already ended, and the resume that retires a source session.
///
/// It runs in the SAME transaction as the write that ended the session, because
/// a window left open on a finished session keeps the `work_controls` gate
/// refusing forever on a session nobody can control — an agent blocked by a
/// person who is no longer there.
///
/// The boundary event still goes out. 「재개」 is not literally what happens when
/// the session is over, but the fact an agent and a surface both need is that
/// the window closed and why, and `end_reason: session_ended` is that. No actor
/// is named: the session's own lifecycle closed it, and recording the person as
/// having *returned* control would be an act they did not perform.
///
/// Idempotent, like the underlying close: on the overwhelmingly common path
/// there was no window and this is one UPDATE that matches nothing.
///
/// The close is written **before** `emit_control_closed_in_tx` resumes, which is
/// this path's half of the lock order in
/// `momo_agent::run::lock_driver_runs_in_tx`: the run rows are taken last, after
/// the session row this caller already holds and after the window row on the
/// line above.
async fn close_control_window_for_ended_session_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    session_id: Uuid,
) -> Result<(), T3Error> {
    let Some(window) = close_control_window_in_tx(
        conn,
        workspace_id,
        session_id,
        ControlWindowEndReason::SessionEnded,
    )
    .await?
    else {
        return Ok(());
    };
    crate::routes::display_attach::emit_control_closed_in_tx(
        conn,
        workspace_id,
        channel_id,
        None,
        None,
        &window,
    )
    .await
}

// ---------------------------------------------------------------------------
// observation (human owner, #1778)
// ---------------------------------------------------------------------------

/// Swift `updateObservation` (`WorkSessionRoutes.swift:1662-1761`).
///
/// Human session owner only. `open` ↔ `owner_only` is the existing consent
/// model (ADR-0126 D1 / ADR-0004 증보 3 D3: 인간 observer는 이 토글 그대로).
/// Closing to `owner_only` revokes live observer grants. Host-signed callers
/// stay out — that arm is #1777's and does not speak observation.
async fn update_observation(
    state: AppState,
    principal: Principal,
    workspace_id: Uuid,
    session_id: Uuid,
    raw: &str,
) -> Result<Json<WorkSessionResponse>, ApiError> {
    require_human(&principal, "observation requires a human bearer")?;
    let observation = validated_observation(raw)?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let detail = settle(
        "work_sessions.observation",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                update_observation_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    via_token_id,
                    session_id,
                    observation,
                )
                .await
            })
        })
        .await,
    )?;

    Ok(Json(WorkSessionResponse {
        work_session: session_dto(detail),
    }))
}

async fn update_observation_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    session_id: Uuid,
    observation: &'static str,
) -> Rejectable<WorkSessionDetail> {
    if active_workspace_role(conn, workspace_id, member_id)
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?
        .is_none()
    {
        return Ok(Err(ApiError::forbidden("not an active workspace member")));
    }

    let Some((existing, _)) =
        lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if existing.member_id != member_id {
        return Ok(Err(ApiError::forbidden(
            "only the session owner can change observation",
        )));
    }
    if !is_active_channel_member_in_tx(conn, workspace_id, existing.channel_id, member_id).await? {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }

    let Some(updated) =
        set_work_session_observation_in_tx(conn, workspace_id, session_id, observation).await?
    else {
        return Ok(Err(ApiError::internal(
            "work_sessions.observation",
            "work session observation update failed",
        )));
    };

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, "work.session.observation")
            .by(member_id)
            .target("work_session", session_id)
            .via_token(via_token_id)
            .with_schema(
                "momo.work.session.observation.v1",
                json!({
                    "session_id": session_id.to_string(),
                    "observation": observation,
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    Ok(Ok(updated))
}

// ---------------------------------------------------------------------------
// ACP event relay (host-signed, #1785)
// ---------------------------------------------------------------------------

const ACP_EVENT_RATE_WINDOW_SECONDS: u64 = 60;
const MAXIMUM_ACP_EVENTS_PER_WINDOW: u32 = 240;
const MAXIMUM_ACP_EVENT_BYTES: usize = 65_536;

const FORBIDDEN_ACP_KEY_NEEDLES: &[&str] = &[
    "_meta",
    "credential",
    "token",
    "secret",
    "environment",
    "env",
    "command",
    "output",
    "cwd",
    "path",
    "raw",
];

#[derive(Debug)]
struct ValidatedAcpEvent {
    channel_id: Uuid,
    body: String,
    safe_payload: Value,
    props: Value,
}

/// Swift `recordACPEvent` (`WorkSessionRoutes.swift:1400-1555`).
async fn record_acp_event(
    state: AppState,
    principal: Principal,
    workspace_id: Uuid,
    session_id: Uuid,
    event: WorkSessionAcpEvent,
) -> Result<Json<WorkSessionResponse>, ApiError> {
    let Some(signing_host_id) = principal.token_id else {
        return Err(signed_request_unauthorized());
    };
    let encoded = serde_json::to_vec(&event)
        .map_err(|_| ApiError::bad_request("invalid ACP event envelope"))?;
    if encoded.len() > MAXIMUM_ACP_EVENT_BYTES {
        return Err(ApiError::bad_request("ACP event exceeds 65536 bytes"));
    }
    let normalized = validated_acp_event(&event, session_id)?;
    let key = format!("work-acp:{workspace_id}:{session_id}");
    if !state
        .rate_limit
        .limiter
        .check(
            &key,
            MAXIMUM_ACP_EVENTS_PER_WINDOW,
            Duration::from_secs(ACP_EVENT_RATE_WINDOW_SECONDS),
        )
        .allowed
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "ACP event rate limit exceeded",
        ));
    }

    let detail = settle(
        "work_sessions.record_acp_event",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                record_acp_event_in_tx(
                    conn,
                    workspace_id,
                    session_id,
                    signing_host_id,
                    &event,
                    &normalized,
                )
                .await
            })
        })
        .await,
    )?;
    Ok(Json(WorkSessionResponse {
        work_session: session_dto(detail),
    }))
}

async fn record_acp_event_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    signing_host_id: Uuid,
    event: &WorkSessionAcpEvent,
    normalized: &ValidatedAcpEvent,
) -> Rejectable<WorkSessionDetail> {
    let Some((existing, _)) =
        lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if existing.host_id != signing_host_id {
        return Ok(Err(ApiError::forbidden(
            "work host cannot relay another host session",
        )));
    }
    if existing.status != "running" {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session is not running",
        )));
    }
    if normalized.channel_id != existing.channel_id {
        return Ok(Err(ApiError::bad_request(
            "ACP event channel does not match session",
        )));
    }
    if !is_active_channel_member_in_tx(conn, workspace_id, existing.channel_id, existing.member_id)
        .await?
    {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }

    let sent = send_message_in_tx(
        conn,
        workspace_id,
        NewMessage {
            channel_id: existing.channel_id,
            author_member_id: existing.member_id,
            message_type: MessageType::System,
            body: Some(normalized.body.clone()),
            props: normalized.props.clone(),
            root_id: Some(existing.root_message_id),
            reply_to_id: None,
            client_msg_id: Some(event.event_id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await
    .map_err(T3Error::from)?;

    if !sent.deduped {
        let channel = cent_channel(workspace_id, existing.channel_id);
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &acp_event_payload(
                &channel,
                event,
                &normalized.safe_payload,
                sent.message.id,
                existing.root_message_id,
                sent.message.seq,
            ),
            Some(existing.channel_id),
        )
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;
    }

    Ok(Ok(existing))
}

/// Swift `validatedACPEvent` (`WorkSessionRoutes.swift:2203-2291`).
fn validated_acp_event(
    event: &WorkSessionAcpEvent,
    session_id: Uuid,
) -> Result<ValidatedAcpEvent, ApiError> {
    let Some(payload) = event.payload.as_object() else {
        return Err(ApiError::bad_request("invalid ACP event envelope"));
    };
    if event.v != 1 || event.ts < 0 || contains_forbidden_acp_key(&event.payload) {
        return Err(ApiError::bad_request("invalid ACP event envelope"));
    }
    let Some(channel_id) = payload
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
    else {
        return Err(ApiError::bad_request(
            "ACP event session binding is invalid",
        ));
    };
    if !uuid_field_eq(payload.get("run_id"), session_id)
        || !uuid_field_eq(payload.get("work_session_id"), session_id)
    {
        return Err(ApiError::bad_request(
            "ACP event session binding is invalid",
        ));
    }

    let mut allowed: HashSet<&str> = ["run_id", "work_session_id", "channel_id", "agent_member_id"]
        .into_iter()
        .collect();
    let body = match event.event_type.as_str() {
        "agent.partial" => {
            allowed.insert("text_delta");
            let Some(text) = payload.get("text_delta").and_then(Value::as_str) else {
                return Err(ApiError::bad_request("invalid ACP progress text"));
            };
            if text.is_empty() || text.len() > 4_096 {
                return Err(ApiError::bad_request("invalid ACP progress text"));
            }
            text.to_string()
        }
        "agent.status" => {
            allowed.extend([
                "phase",
                "run_status",
                "detail",
                "tool_call_name",
                "has_plan",
                "plan",
                "terminal_event",
                "exit_code",
            ]);
            let phase = payload.get("phase").and_then(Value::as_str);
            let run_status = payload.get("run_status").and_then(Value::as_str);
            if !matches!(phase, Some("thinking") | Some("streaming"))
                || run_status != Some("running")
            {
                return Err(ApiError::bad_request("invalid ACP status projection"));
            }
            if let Some(detail) = payload.get("detail").and_then(Value::as_str) {
                if detail.len() > 4_096 {
                    return Err(ApiError::bad_request("ACP status detail is too large"));
                }
            }
            if let Some(terminal) = payload.get("terminal_event").and_then(Value::as_str) {
                if terminal != "created" && terminal != "ended" {
                    return Err(ApiError::bad_request("invalid ACP terminal event"));
                }
            }
            payload
                .get("detail")
                .and_then(Value::as_str)
                .unwrap_or("ACP session update")
                .to_string()
        }
        "approval.requested" => {
            allowed.extend(["action", "action_type", "status", "options"]);
            let Some(options) = payload.get("options").and_then(Value::as_array) else {
                return Err(ApiError::bad_request("invalid ACP approval request"));
            };
            if payload.get("action").and_then(Value::as_str) != Some("requested")
                || payload.get("action_type").and_then(Value::as_str) != Some("tool_call")
                || payload.get("status").and_then(Value::as_str) != Some("pending")
                || options.is_empty()
                || options.len() > 16
            {
                return Err(ApiError::bad_request("invalid ACP approval request"));
            }
            let option_allowed: HashSet<&str> = ["option_id", "name", "kind"].into_iter().collect();
            for option in options {
                let Some(item) = option.as_object() else {
                    return Err(ApiError::bad_request("invalid ACP approval option"));
                };
                let option_keys: HashSet<&str> = item.keys().map(String::as_str).collect();
                let option_id = item.get("option_id").and_then(Value::as_str);
                let name = item.get("name").and_then(Value::as_str);
                if !option_keys.is_subset(&option_allowed)
                    || !option_id.is_some_and(|id| !id.is_empty() && id.len() <= 128)
                    || !name.is_some_and(|name| !name.is_empty() && name.len() <= 256)
                {
                    return Err(ApiError::bad_request("invalid ACP approval option"));
                }
            }
            "Approval requested".to_string()
        }
        "approval.decided" => {
            allowed.extend(["action", "status", "option_id"]);
            let status = payload.get("status").and_then(Value::as_str);
            if payload.get("action").and_then(Value::as_str) != Some("decided")
                || !matches!(status, Some("approved") | Some("rejected"))
            {
                return Err(ApiError::bad_request("invalid ACP approval decision"));
            }
            if status == Some("approved") {
                "Approval granted".to_string()
            } else {
                "Approval rejected".to_string()
            }
        }
        _ => return Err(ApiError::bad_request("unsupported ACP event type")),
    };

    let keys: HashSet<&str> = payload.keys().map(String::as_str).collect();
    if !keys.is_subset(&allowed) {
        return Err(ApiError::bad_request(
            "ACP event contains non-summary fields",
        ));
    }

    let safe_payload = Value::Object(payload.clone());
    let props = json!({
        "kind": "work_session_event",
        "schema": "momo.work_session.acp_event.v1",
        "source": "acp",
        "event_id": event.event_id.to_string(),
        "event_type": event.event_type,
        "event_ts": event.ts,
        "event": safe_payload.clone(),
    });
    Ok(ValidatedAcpEvent {
        channel_id,
        body,
        safe_payload,
        props,
    })
}

/// Swift `acpEventPayload` (`WorkSessionRoutes.swift:2293-2317`).
fn acp_event_payload(
    channel: &str,
    event: &WorkSessionAcpEvent,
    safe_payload: &Value,
    message_id: Uuid,
    root_message_id: Uuid,
    seq: i64,
) -> Value {
    let mut payload = match safe_payload {
        Value::Object(object) => object.clone(),
        _ => Map::new(),
    };
    payload.insert("event_id".into(), json!(event.event_id.to_string()));
    payload.insert("message_id".into(), json!(message_id.to_string()));
    payload.insert("root_message_id".into(), json!(root_message_id.to_string()));
    json!({
        "channel": channel,
        "data": {
            "type": event.event_type,
            "v": 1,
            "ts": event.ts,
            "seq": seq,
            "payload": payload,
        },
        "idempotency_key": format!("{channel}:acp:{}", event.event_id),
    })
}

fn uuid_field_eq(value: Option<&Value>, expected: Uuid) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
        == Some(expected)
}

fn contains_forbidden_acp_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, child)| {
            let lowered = key.to_ascii_lowercase();
            FORBIDDEN_ACP_KEY_NEEDLES
                .iter()
                .any(|needle| lowered.contains(needle))
                || contains_forbidden_acp_key(child)
        }),
        Value::Array(array) => array.iter().any(contains_forbidden_acp_key),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// bindRemotePTY (host-signed)
// ---------------------------------------------------------------------------

/// Swift `bindRemotePTY` (`WorkSessionRoutes.swift:1567-1660`).
async fn bind_remote_pty(
    state: AppState,
    principal: Principal,
    workspace_id: Uuid,
    session_id: Uuid,
    request: &UpdateWorkSessionRequest,
) -> Result<Json<WorkSessionResponse>, ApiError> {
    let Some(signing_host_id) = principal.token_id else {
        return Err(signed_request_unauthorized());
    };
    let binding = parse_remote_pty_binding(
        request.pty_id.as_deref(),
        request.attach_endpoint.as_deref(),
    )
    .map_err(|error| ApiError::bad_request(error.message()))?
    .ok_or_else(|| ApiError::bad_request("ptyId and attachEndpoint must be provided together"))?;

    let detail = settle(
        "work_sessions.bind_remote_pty",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                bind_remote_pty_in_tx(conn, workspace_id, session_id, signing_host_id, &binding)
                    .await
            })
        })
        .await,
    )?;
    Ok(Json(WorkSessionResponse {
        work_session: session_dto(detail),
    }))
}

async fn bind_remote_pty_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    signing_host_id: Uuid,
    binding: &RemotePtyBinding,
) -> Rejectable<WorkSessionDetail> {
    let Some((existing, _)) =
        lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if existing.host_id != signing_host_id {
        return Ok(Err(ApiError::forbidden(
            "work host cannot bind another host session",
        )));
    }
    if existing.status != "running" && existing.status != "idle" {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "remote PTY binding requires a running or idle session",
        )));
    }
    // Idempotent identical republish; a different pair is 409.
    if existing.remote_attach_available {
        let stored = sqlx::query(
            "SELECT pty_id, attach_endpoint FROM work_session \
              WHERE workspace_id = $1 AND id = $2",
        )
        .bind(workspace_id)
        .bind(session_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(T3Error::from)?;
        let pty_id: Option<String> =
            sqlx::Row::try_get(&stored, "pty_id").map_err(T3Error::from)?;
        let attach_endpoint: Option<String> =
            sqlx::Row::try_get(&stored, "attach_endpoint").map_err(T3Error::from)?;
        if pty_id.as_deref() != Some(binding.pty_id.as_str())
            || attach_endpoint.as_deref() != Some(binding.attach_endpoint.as_str())
        {
            return Ok(Err(ApiError::new(
                StatusCode::CONFLICT,
                "work session already has a different remote PTY binding",
            )));
        }
        return Ok(Ok(existing));
    }
    match remote_pty_host_status_in_tx(conn, workspace_id, existing.host_id).await? {
        RemotePtyHostStatus::Capable => {}
        RemotePtyHostStatus::NotFound => {
            return Ok(Err(ApiError::forbidden("work host not found")))
        }
        RemotePtyHostStatus::NotCapable => {
            return Ok(Err(ApiError::forbidden(
                "work host does not support terminal attach",
            )))
        }
    }
    if !write_remote_pty_binding_in_tx(conn, workspace_id, session_id, binding).await? {
        return Ok(Err(ApiError::internal(
            "work_sessions.bind_remote_pty",
            "remote PTY binding update failed",
        )));
    }
    let Some((updated, _)) = lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::internal(
            "work_sessions.bind_remote_pty",
            "remote PTY binding update failed",
        )));
    };
    Ok(Ok(updated))
}

// ---------------------------------------------------------------------------
// idle / running (host-signed)
// ---------------------------------------------------------------------------

/// Swift `transitionToolLifecycle` (`WorkSessionRoutes.swift:693-1036`).
async fn transition_lifecycle(
    state: AppState,
    principal: Principal,
    workspace_id: Uuid,
    session_id: Uuid,
    target_status: &'static str,
    exit_code: Option<i32>,
) -> Result<Json<WorkSessionResponse>, ApiError> {
    let Some(signing_host_id) = principal.token_id else {
        return Err(signed_request_unauthorized());
    };
    let cloud_host_id = resolve_cloud_host_id(&state.pool, workspace_id, session_id)
        .await
        .map_err(|error| t3_error("work_sessions.transition.resolve", error))?;

    let body = lifecycle_body(move |conn: &mut momo_db::PgConnection| {
        Box::pin(async move {
            transition_lifecycle_in_tx(
                conn,
                workspace_id,
                signing_host_id,
                session_id,
                cloud_host_id,
                target_status,
                exit_code,
            )
            .await
        }) as _
    });

    let detail = settle(
        "work_sessions.transition",
        match cloud_host_id {
            Some(cloud_host_id) => {
                momo_t3::with_t3_lifecycle_tx(
                    &state.pool,
                    workspace_id,
                    T3LockLadder::host(cloud_host_id),
                    body,
                )
                .await
            }
            None => tenant_tx(&state.pool, workspace_id, body).await,
        },
    )?;
    Ok(Json(WorkSessionResponse {
        work_session: session_dto(detail),
    }))
}

async fn transition_lifecycle_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    signing_host_id: Uuid,
    session_id: Uuid,
    expected_cloud_host_id: Option<Uuid>,
    target_status: &str,
    exit_code: Option<i32>,
) -> Rejectable<WorkSessionDetail> {
    if cloud_host_id_for_session_in_tx(conn, workspace_id, session_id).await?
        != expected_cloud_host_id
    {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session cloud lifecycle changed; retry",
        )));
    }
    let Some((existing, root_seq)) =
        lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if existing.host_id != signing_host_id {
        return Ok(Err(ApiError::forbidden(
            "work host cannot update another host session",
        )));
    }
    if !is_active_channel_member_in_tx(conn, workspace_id, existing.channel_id, existing.member_id)
        .await?
    {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }
    if existing.status == target_status {
        return Ok(Ok(existing));
    }
    let expected = if target_status == "idle" {
        "running"
    } else {
        "idle"
    };
    if existing.status != expected {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "work session cannot transition from {} to {target_status}",
                existing.status
            ),
        )));
    }

    // T3: a paused daemon cannot ask to be woken (Swift :1083-1088). Idle
    // pauses the usage ledger only — the provider pause/intent prelude is
    // not ported (T1 workd never has a cloud host).
    if let Some(cloud_host_id) = expected_cloud_host_id {
        if target_status == "running" {
            return Ok(Err(ApiError::new(
                StatusCode::CONFLICT,
                "paused oort Cloud sessions must be resumed by the human cloud resume endpoint",
            )));
        }
        pause_usage_in_tx(conn, workspace_id, existing.host_id, Some(session_id)).await?;
        let _ = cloud_host_id;
    }

    let Some(updated) =
        transition_tool_lifecycle_in_tx(conn, workspace_id, session_id, target_status, exit_code)
            .await?
    else {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session state changed; retry",
        )));
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(updated.started_at_ms);
    let props = card_props(
        updated.id,
        &updated.tool,
        &updated.label,
        target_status,
        None,
        updated.exit_code,
        None,
        None,
    );
    update_session_card_props_in_tx(
        conn,
        workspace_id,
        updated.root_message_id,
        &props.to_string(),
    )
    .await?;

    let channel = cent_channel(workspace_id, updated.channel_id);
    let (event_type, event_seq, discriminator, _idle_message) = if target_status == "idle" {
        let idle_card = send_message_in_tx(
            conn,
            workspace_id,
            NewMessage {
                channel_id: updated.channel_id,
                author_member_id: updated.member_id,
                message_type: MessageType::System,
                body: Some("작업 완료 — idle 대기".into()),
                props: json!({
                    "kind": "work_session_idle",
                    "session_id": updated.id.to_string(),
                    "owner_member_id": updated.member_id.to_string(),
                }),
                root_id: Some(updated.root_message_id),
                reply_to_id: None,
                client_msg_id: None,
                run_id: None,
                hlc_ts: Some(now_ms),
                hlc_count: None,
            },
        )
        .await
        .map_err(T3Error::from)?;
        (
            "work.session.idle",
            idle_card.message.seq,
            idle_card.message.id.to_string(),
            Some(idle_card),
        )
    } else {
        (
            "work.session.resumed-to-running",
            root_seq,
            now_ms.to_string(),
            None,
        )
    };

    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &tool_lifecycle_payload(
            &channel,
            event_type,
            &updated,
            event_seq,
            now_ms,
            &discriminator,
        ),
        Some(updated.channel_id),
    )
    .await
    .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, event_type)
            .by(updated.member_id)
            .target("work_session", session_id)
            .with_schema(
                if target_status == "idle" {
                    "momo.work.session.idle.v1"
                } else {
                    "momo.work.session.resumed_to_running.v1"
                },
                {
                    let mut detail = json!({
                        "session_id": session_id.to_string(),
                        "host_id": updated.host_id.to_string(),
                    });
                    if let Some(exit_code) = exit_code {
                        detail["exit_code"] = json!(exit_code);
                    }
                    detail
                },
            ),
    )
    .await
    .map_err(T3Error::from)?;

    Ok(Ok(updated))
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

/// The status each resume-target refusal answers with (#1139).
///
/// Three of the four are Swift's own 409s (`requireResumeTarget` :2538-2552):
/// the host is gone, or the tier policy points somewhere else — states that
/// change under a card that is minutes old, which is what a conflict means.
///
/// **`OtherMemberHost` deviates from Swift and answers 403.** Swift says 409
/// there, but Swift's *own* sibling check for the identical fact — a
/// member-scoped host that is not yours — answers 403
/// (`WorkControlRoutes.validateTargetHostScope` :990-1005), and so does this
/// server's spawn path (`work_controls::create_in_tx`). Someone else's laptop is
/// not a race you can retry; it is a permission you do not have, and one server
/// answering the same sentence with two codes is how a client ends up writing
/// two branches for one refusal.
fn resume_target_status(rejection: ResumeTargetRejection) -> ApiError {
    match rejection {
        ResumeTargetRejection::HostUnavailable => ApiError::new(
            StatusCode::CONFLICT,
            "target work host is unavailable or revoked",
        ),
        ResumeTargetRejection::OtherMemberHost => {
            ApiError::forbidden("target work host belongs to another member")
        }
        ResumeTargetRejection::AutoPolicyRequiresCloud => ApiError::new(
            StatusCode::CONFLICT,
            "auto policy requires a cloud work host",
        ),
        ResumeTargetRejection::OutsideAutoPolicy => ApiError::new(
            StatusCode::CONFLICT,
            "target work host is outside auto policy",
        ),
        ResumeTargetRejection::SameAsSourceHost => ApiError::new(
            StatusCode::CONFLICT,
            "resume target must differ from the source host",
        ),
    }
}

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/resume` → 201
/// (Swift `resume`, :1763-2025), minus the audit row named in the module docs.
pub async fn resume(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    Json(request): Json<ResumeWorkSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_human(&principal, "work session resume requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let source_session_id = path_uuid(&session, "invalid work session id")?;
    let target_host_id = request.target_host_id;
    let member_id = principal.member_id;

    let source_cloud_host_id = resolve_cloud_host_id(&state.pool, workspace_id, source_session_id)
        .await
        .map_err(|error| t3_error("work_sessions.resume.resolve", error))?;
    let target_cloud_host_id = cloud_host_id_for_host(&state.pool, workspace_id, target_host_id)
        .await
        .map_err(|error| t3_error("work_sessions.resume.resolve", error))?;
    let lifecycle_hosts: Vec<Uuid> = [source_cloud_host_id, target_cloud_host_id]
        .into_iter()
        .flatten()
        .collect();

    let body = lifecycle_body(move |conn: &mut momo_db::PgConnection| {
        Box::pin(async move {
            resume_in_tx(
                conn,
                workspace_id,
                member_id,
                source_session_id,
                source_cloud_host_id,
                target_host_id,
                target_cloud_host_id,
            )
            .await
        }) as _
    });

    let detail = settle(
        "work_sessions.resume",
        if lifecycle_hosts.is_empty() {
            tenant_tx(&state.pool, workspace_id, body).await
        } else {
            // Both hosts, in ascending id order (the ladder sorts them), plus
            // work_pool for admission and workspace_credit because the source's
            // settlement will append a credit entry.
            let mut ladder = T3LockLadder::hosts(lifecycle_hosts).with_work_pool();
            if source_cloud_host_id.is_some() {
                ladder = ladder.with_workspace_credit();
            }
            momo_t3::with_t3_lifecycle_tx(&state.pool, workspace_id, ladder, body).await
        },
    )?;

    Ok((
        StatusCode::CREATED,
        Json(WorkSessionResponse {
            work_session: session_dto(detail),
        }),
    ))
}

#[allow(clippy::too_many_arguments)]
async fn resume_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    source_session_id: Uuid,
    expected_source_cloud_host_id: Option<Uuid>,
    target_host_id: Uuid,
    expected_target_cloud_host_id: Option<Uuid>,
) -> Rejectable<WorkSessionDetail> {
    if cloud_host_id_for_session_in_tx(conn, workspace_id, source_session_id).await?
        != expected_source_cloud_host_id
    {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session cloud lifecycle changed; retry",
        )));
    }
    if cloud_host_id_for_host_in_tx(conn, workspace_id, target_host_id).await?
        != expected_target_cloud_host_id
    {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work host cloud lifecycle changed; retry",
        )));
    }

    let Some((source, source_seq)) =
        lock_work_session_detail_in_tx(conn, workspace_id, source_session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if !work_tool_is_enabled_in_tx(conn, workspace_id, &source.tool).await? {
        return Ok(Err(ApiError::bad_request(
            "work tool is not registered or enabled",
        )));
    }
    if source.status != "orphaned" {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "only an orphaned work session can resume",
        )));
    }
    // ADR-0143 D2/D3: continuity belongs to the workstream, not to the Run's
    // actor. Eligibility is therefore active membership of the anchor channel —
    // the source `member_id` stays an execution record and is never transferred.
    if !is_active_channel_member_in_tx(conn, workspace_id, source.channel_id, member_id).await? {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }

    // ---- the target, at last (#1139) ---------------------------------------
    // Until this batch the Rust port asked nothing at all about `target_host_id`
    // — it went straight from membership to `acquire_slot_in_tx`, which cares
    // about capacity and not about permission. The client core's
    // `workSessionResumeTargets` filter was therefore the only place the
    // question "may this lineage go there?" was ever asked, which is exactly the
    // fail-open #1138 measured and #1139 exists to close. A filter in a browser
    // is a convenience; this is the check.
    //
    // `load_tier_policy` is momo-settings' — the same read the tier settings
    // surface uses, so the policy that governs a resume and the policy a person
    // edits are one row and not two interpretations of it.
    let policy = momo_settings::load_tier_policy(
        conn,
        workspace_id,
        momo_settings::TierScope::Member(member_id),
    )
    .await
    .map_err(T3Error::from)?;
    if policy.mode == "t1_only" {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "tier policy does not allow resume",
        )));
    }
    if let Some(rejection) = resume_target_rejection_in_tx(
        conn,
        workspace_id,
        member_id,
        target_host_id,
        source.host_id,
        &policy.mode,
        policy.auto_target.as_deref(),
    )
    .await?
    {
        return Ok(Err(resume_target_status(rejection)));
    }

    if let Err(error) = acquire_slot_in_tx(conn, workspace_id, member_id, target_host_id).await {
        return Ok(Err(match error {
            T3Error::SlotsExhausted { .. } => ApiError::new(StatusCode::CONFLICT, "pool_exhausted"),
            T3Error::MemberSlotLimit { .. } => ApiError::new(StatusCode::CONFLICT, "member_limit"),
            other => return Err(other),
        }));
    }

    // ---- writes ------------------------------------------------------------
    // The source's ledger is settled as `orphaned`: the host it was running on
    // is gone, which ADR-0140 calls the most common billing end, not an
    // exceptional one.
    if expected_source_cloud_host_id.is_some() {
        terminate_in_tx(
            conn,
            workspace_id,
            source_session_id,
            TerminationReason::Orphaned,
        )
        .await?;
    }

    let resumed_session_id = allocate_uuid_v7(conn).await?;
    let resumed = create_resumed_work_session_in_tx(
        conn,
        workspace_id,
        resumed_session_id,
        &source,
        member_id,
        target_host_id,
    )
    .await?;
    start_usage_in_tx(conn, workspace_id, resumed.id, target_host_id).await?;

    let Some(ended_source) =
        mark_work_session_resumed_in_tx(conn, workspace_id, source_session_id).await?
    else {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session state changed; retry",
        )));
    };

    // The source session just became `ended`, so whatever window stood on it
    // closes here for the same reason it closes on the ordinary end path. This
    // is not a hypothetical shape: a session is orphaned because its host went
    // away, and the person watching that happen is precisely the person who was
    // most likely holding its screen. Without this the takeover would leave an
    // open window on a dead session forever — no producer can renew it (the host
    // is gone) so it would eventually lapse, but until it did the agent's run
    // path would be refused on a session that no longer exists, and the ledger
    // would claim someone held a keyboard the whole time.
    //
    // The window belongs to the SOURCE. It is deliberately not carried over to
    // the successor: control is a person's act on one live screen (증보 3 D1),
    // the successor has a different host, a different screen and no display
    // binding yet, and the person retakes control there by asking for it.
    close_control_window_for_ended_session_in_tx(
        conn,
        workspace_id,
        source.channel_id,
        source_session_id,
    )
    .await?;

    // The instruction that makes 인수 mean something (#1138's fourth
    // measurement, Swift :1940-1959). Without this row the takeover produced a
    // ledger entry and a card, and the tool never restarted anywhere — which is
    // why `HANDOFF_COPY.takeover.lead` could only promise "가져옵니다".
    //
    // It is written `dispatched` directly rather than through the
    // approval→approved→dispatched ladder, and that is not a shortcut: the
    // person asking IS the authority this ledger asks for, they named the host
    // themselves, and the four checks above already judged that choice. Routing
    // a human's own explicit act through an approval card would ask them to
    // approve their own click.
    //
    // The session is pre-allocated (`resumed.id`), so the control is bound to it
    // from the first write — the same order Swift uses, and the reason
    // `spawn_ack_session_matches_in_tx` has a human-requester arm: the daemon's
    // ack lands on a session that already exists.
    let control = insert_work_control_in_tx(
        conn,
        workspace_id,
        NewWorkControl {
            channel_id: source.channel_id,
            requester_member_id: member_id,
            target_host_id,
            session_id: Some(resumed.id),
            kind: KIND_SPAWN.to_string(),
            payload: serde_json::json!({"tool": resumed.tool, "label": resumed.label}),
            status: STATUS_DISPATCHED.to_string(),
        },
    )
    .await?;

    // ADR-0125 D6-A "마지막 사용" (migration 061): a takeover is the most
    // deliberate host choice there is — the person picked the machine their work
    // moves to. Recorded for the caller, who is both the chooser and the owner
    // of the successor session.
    record_host_last_used_in_tx(conn, workspace_id, member_id, target_host_id).await?;

    let props = card_props(
        resumed.id,
        &resumed.tool,
        &resumed.label,
        "running",
        None,
        None,
        None,
        Some(source_session_id),
    );
    update_session_card_props_in_tx(
        conn,
        workspace_id,
        resumed.root_message_id,
        &props.to_string(),
    )
    .await?;

    for payload in [
        lifecycle_payload(
            &cent_channel(workspace_id, source.channel_id),
            "work.session.ended",
            &ended_source,
            source_seq,
        ),
        lifecycle_payload(
            &cent_channel(workspace_id, resumed.channel_id),
            "work.session.started",
            &resumed,
            source_seq,
        ),
        // Same outbox, same partition key, one transaction: the room learns the
        // lineage moved and the host learns to start the tool in the order they
        // happened. The daemon does not depend on this frame arriving (it polls
        // `pending-controls`), which is why the ledger row is written first.
        control_event_payload(
            &cent_channel(workspace_id, control.channel_id),
            "work.control.dispatched",
            &control,
            None,
            None,
        ),
    ] {
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &payload,
            Some(source.channel_id),
        )
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;
    }

    Ok(Ok(resumed))
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/// `GET /v1/workspaces/{ws}/work-sessions?active=0|1` (Swift `list`, :2027-2093).
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<WorkSessionListQuery>,
) -> Result<Json<WorkSessionListResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let active_only = active_filter(query.active.as_deref())?;
    let member_id = principal.member_id;

    let sessions = settle(
        "work_sessions.list",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(list_work_session_details_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    active_only,
                )
                .await?))
            })
        })
        .await,
    )?;

    Ok(Json(WorkSessionListResponse {
        work_sessions: sessions.into_iter().map(session_dto).collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail() -> WorkSessionDetail {
        WorkSessionDetail {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            member_id: Uuid::from_u128(4),
            host_id: Uuid::from_u128(5),
            root_message_id: Uuid::from_u128(6),
            tool: "claude".into(),
            label: "run".into(),
            status: "running".into(),
            observation: "open".into(),
            observer_grant_count: 0,
            remote_attach_available: false,
            remote_display_available: false,
            control_started_at_ms: None,
            started_at_ms: 1_700_000_000_000,
            ended_at_ms: None,
            exit_code: None,
            end_reason: None,
            resumed_from_session_id: None,
        }
    }

    #[test]
    fn tool_and_label_validation_matches_swift() {
        assert_eq!(validated_tool(" Claude ").unwrap(), "claude");
        assert_eq!(validated_tool("open-code.v2").unwrap(), "open-code.v2");
        assert!(validated_tool("c").is_err(), "at least two characters");
        assert!(validated_tool("-nope").is_err(), "must start alphanumeric");
        assert!(validated_tool("has space").is_err());
        assert!(validated_label("").is_err());
        assert!(validated_label(&"x".repeat(120)).is_ok());
        assert!(validated_label(&"x".repeat(121)).is_err());
        assert_eq!(validated_observation("open").unwrap(), "open");
        assert_eq!(validated_observation("owner_only").unwrap(), "owner_only");
        assert!(validated_observation("closed").is_err());
        assert!(validated_observation("ownerOnly").is_err());
    }

    #[test]
    fn active_filter_is_strict() {
        assert!(!active_filter(None).unwrap());
        assert!(!active_filter(Some("0")).unwrap());
        assert!(active_filter(Some("1")).unwrap());
        assert_eq!(
            active_filter(Some("true")).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn card_props_carry_the_client_contract() {
        let props = card_props(
            Uuid::from_u128(1),
            "claude",
            "run",
            "running",
            None,
            None,
            None,
            None,
        );
        assert_eq!(props["kind"], "work_session");
        assert_eq!(props["status"], "running");
        assert!(props.get("ended_at").is_none());

        let ended = card_props(
            Uuid::from_u128(1),
            "claude",
            "run",
            "ended",
            Some(9),
            Some(0),
            None,
            None,
        );
        assert_eq!(ended["ended_at"], 9);
        assert_eq!(ended["exit_code"], 0);
    }

    #[test]
    fn lifecycle_payload_has_no_version_and_a_per_event_idempotency_key() {
        let mut session = detail();
        let channel = cent_channel(session.workspace_id, session.channel_id);
        let started = lifecycle_payload(&channel, "work.session.started", &session, 12);
        assert!(
            started.get("version").is_none(),
            "the card's message.new owns this seq; a second version would make \
             the relay stale-skip one of the two envelopes"
        );
        assert_eq!(started["data"]["type"], "work.session.started");
        assert_eq!(started["data"]["seq"], 12);
        assert_eq!(
            started["data"]["payload"]["started_at"],
            1_700_000_000_000i64
        );
        let channel = cent_channel(session.workspace_id, session.channel_id);
        assert_eq!(started["channel"], channel);
        assert_eq!(
            started["idempotency_key"],
            format!("{channel}:work.session.started:{}", session.id)
        );

        session.status = "ended".into();
        session.ended_at_ms = Some(1_700_000_009_000);
        session.exit_code = Some(0);
        let ended = lifecycle_payload(
            &cent_channel(session.workspace_id, session.channel_id),
            "work.session.ended",
            &session,
            12,
        );
        assert_eq!(ended["data"]["ts"], 1_700_000_009_000i64);
        assert_eq!(ended["data"]["payload"]["ended_at"], 1_700_000_009_000i64);
        assert_eq!(ended["data"]["payload"]["exit_code"], 0);
        assert!(
            ended["data"]["payload"].get("started_at").is_none(),
            "the ended envelope carries the end timestamps, not the start"
        );
        assert_ne!(
            ended["idempotency_key"], started["idempotency_key"],
            "started and ended must not collapse onto one idempotency key"
        );
    }

    #[test]
    fn acp_event_validation_and_no_version_projection() {
        assert_eq!(MAXIMUM_ACP_EVENTS_PER_WINDOW, 240);
        assert_eq!(ACP_EVENT_RATE_WINDOW_SECONDS, 60);
        assert_eq!(MAXIMUM_ACP_EVENT_BYTES, 65_536);

        let session_id = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0531);
        let channel_id = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0202);
        let event_id = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0546);
        let event = WorkSessionAcpEvent {
            event_id,
            event_type: "agent.status".into(),
            v: 1,
            ts: 1_784_678_400_000,
            payload: json!({
                "run_id": session_id,
                "work_session_id": session_id,
                "channel_id": channel_id,
                "phase": "thinking",
                "run_status": "running",
                "detail": "Plan ready",
                "has_plan": true,
                "plan": [{"content": "Implement relay"}],
            }),
        };
        let validated = validated_acp_event(&event, session_id).expect("valid status");
        assert_eq!(validated.channel_id, channel_id);
        assert_eq!(validated.body, "Plan ready");
        assert_eq!(validated.props["kind"], "work_session_event");
        assert_eq!(validated.props["schema"], "momo.work_session.acp_event.v1");

        let payload = acp_event_payload(
            "ch:ws00000000-0000-7000-8000-000000000001.00000000-0000-7000-8000-000000000202",
            &event,
            &validated.safe_payload,
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            77,
        );
        assert!(
            payload.get("version").is_none(),
            "message.new owns this seq; a second version would stale-skip one envelope"
        );
        assert_eq!(payload["data"]["type"], "agent.status");
        assert_eq!(payload["data"]["seq"], 77);
        assert_eq!(payload["data"]["v"], 1);

        let forbidden = WorkSessionAcpEvent {
            event_id: Uuid::new_v4(),
            event_type: "agent.partial".into(),
            v: 1,
            ts: 1,
            payload: json!({
                "run_id": session_id,
                "work_session_id": session_id,
                "channel_id": channel_id,
                "text_delta": "safe",
                "_meta": {"acp": {"raw": "forbidden"}},
            }),
        };
        assert_eq!(
            validated_acp_event(&forbidden, session_id)
                .unwrap_err()
                .message,
            "invalid ACP event envelope"
        );
    }

    #[test]
    fn work_host_only_create_fields_are_refused_by_name() {
        let base = || CreateWorkSessionRequest {
            channel_id: Uuid::nil(),
            host_id: Uuid::nil(),
            tool: "claude".into(),
            label: "run".into(),
            control_id: None,
            pty_id: None,
            attach_endpoint: None,
            display_id: None,
            display_endpoint: None,
        };
        assert!(reject_unsupported_create(&base()).is_ok());
        let mut with_control = base();
        with_control.control_id = Some(Uuid::nil());
        assert_eq!(
            reject_unsupported_create(&with_control)
                .unwrap_err()
                .message,
            "controlId is reserved for work host dispatch"
        );
        let mut with_pty = base();
        with_pty.pty_id = Some("pty".into());
        assert!(reject_unsupported_create(&with_pty).is_err());

        // LIVE-1: each half alone is refused, so a client cannot discover which
        // one this server "really" reads by sending them one at a time.
        let mutations: [fn(&mut CreateWorkSessionRequest); 2] = [
            |request| request.display_id = Some("display".into()),
            |request| request.display_endpoint = Some("wss://host.example/signal".into()),
        ];
        for mutate in mutations {
            let mut with_display = base();
            mutate(&mut with_display);
            assert_eq!(
                reject_unsupported_create(&with_display)
                    .unwrap_err()
                    .message,
                "display binding requires work host signature"
            );
        }
    }
}
