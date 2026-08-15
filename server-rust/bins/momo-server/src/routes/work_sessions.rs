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
//! ## Named parity gaps (B2.3+, each excluded by the packet)
//!
//! * `PATCH` arms other than `status:"ended"` — idle/running transitions, ACP
//!   events, observation changes and remote-PTY binding are all
//!   **work-host-signed** paths (`transitionToolLifecycle` :702-704 begins
//!   `guard principal.kind == .workHost`), and that authenticator is not ported.
//!   They are refused by name (400) rather than silently ignored.
//! * `create` by a signed work host (`controlId` + dispatched spawn control) —
//!   same reason.
//! * `resume` drops **one** Swift step now: the audit row (see the crate-level
//!   note on `momo_db::audit`). The two that mattered are back — the
//!   `work_tier_policy` gate with `requireResumeTarget` (:1855-1871, #1139) and
//!   the `work_control` spawn dispatch that tells a daemon to actually restart
//!   the tool (:1940-1959, #1138's fourth measurement). Both were absences a
//!   client could not compensate for: the first made the client-side target
//!   filter the *only* check in the system, and the second made 「인수」 a
//!   promise about a ledger row rather than about a running tool.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{cent_channel, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::work_control::{
    control_event_payload, insert_work_control_in_tx, record_host_last_used_in_tx,
    resume_target_rejection_in_tx, NewWorkControl, ResumeTargetRejection, KIND_SPAWN,
    STATUS_DISPATCHED,
};
use momo_t3::{
    acquire_slot_in_tx, allocate_uuid_v7, card_props, close_control_window_in_tx,
    cloud_host_id_for_host, cloud_host_id_for_host_in_tx, cloud_host_id_for_session_in_tx,
    create_resumed_work_session_in_tx, create_work_session_with_id_in_tx, end_work_session_in_tx,
    is_active_channel_member_in_tx, lifecycle_payload, list_work_session_details_in_tx,
    lock_work_session_detail_in_tx, mark_work_session_resumed_in_tx, resolve_cloud_host_id,
    start_usage_in_tx, terminate_in_tx, update_session_card_props_in_tx, work_session_scope_in_tx,
    work_tool_is_enabled_in_tx, ControlWindowEndReason, NewWorkSession, T3Error, T3LockLadder,
    TerminationReason, WorkSessionDetail,
};
use uuid::Uuid;

use crate::dto::{
    CreateWorkSessionRequest, ResumeWorkSessionRequest, UpdateWorkSessionRequest, WorkSessionDto,
    WorkSessionListQuery, WorkSessionListResponse, WorkSessionResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    lifecycle_body, path_uuid, require_human, settle, t3_error, tenant_tx, workspace_scope,
    Rejectable,
};
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
    require_human(&principal, "work sessions require a human or work host")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    reject_unsupported_create(&request)?;
    let tool = validated_tool(&request.tool)?;
    let label = validated_label(&request.label)?;
    let channel_id = request.channel_id;
    let host_id = request.host_id;
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
    if !is_active_channel_member_in_tx(conn, workspace_id, channel_id, member_id).await? {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }
    // Slot admission (`WorkPoolRoutes.acquireSlot`). Its 409 vocabulary is the
    // Swift one, not the domain error's Display.
    if let Err(error) = acquire_slot_in_tx(conn, workspace_id, member_id, host_id).await {
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
            author_member_id: member_id,
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
            member_id,
            host_id,
            root_message_id: card.message.id,
            tool: tool.to_string(),
            label: label.to_string(),
        },
    )
    .await?;

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

/// `PATCH /v1/workspaces/{ws}/work-sessions/{session}` (Swift `end`, :328-601),
/// the `status: "ended"` arm.
pub async fn end(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    Json(request): Json<UpdateWorkSessionRequest>,
) -> Result<Json<WorkSessionResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;

    // The arms this batch does not serve, refused by name.
    if request.pty_id.is_some() || request.attach_endpoint.is_some() {
        return Err(ApiError::bad_request(
            "remote PTY binding requires work host signature",
        ));
    }
    if request.display_id.is_some() || request.display_endpoint.is_some() {
        return Err(ApiError::bad_request(
            "display binding requires work host signature",
        ));
    }
    if request.event.is_some() {
        return Err(ApiError::bad_request(
            "ACP event ingestion requires work host signature",
        ));
    }
    if request.observation.is_some() {
        return Err(ApiError::bad_request(
            "observation updates are not served by momo-server yet",
        ));
    }
    match request.status.as_deref() {
        Some("ended") => {}
        Some("idle") | Some("running") => {
            return Err(ApiError::forbidden(
                "tool lifecycle transitions require work host signature",
            ))
        }
        _ => {
            return Err(ApiError::bad_request(
                "status must be idle, running, or ended",
            ))
        }
    }

    let member_id = principal.member_id;
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
        let Some((owner_member_id, _host_id, channel_id)) =
            work_session_scope_in_tx(conn, workspace_id, session_id).await?
        else {
            return Ok(Err(ApiError::not_found("work session not found")));
        };
        if owner_member_id != member_id {
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
    if existing.member_id != member_id {
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
    if existing.status == "ended" {
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
    // ended underneath somebody's keyboard. In the same transaction as the end
    // itself, because a window left open on an ended session would keep the
    // `work_controls` gate refusing forever on a session nobody can control —
    // an agent blocked by a person who is no longer there.
    //
    // The boundary event still goes out. 「재개」 is not literally what happens
    // when the session is over, but the fact an agent and a surface both need is
    // that the window closed and why, and `end_reason: session_ended` is that.
    if let Some(window) = close_control_window_in_tx(
        conn,
        workspace_id,
        session_id,
        ControlWindowEndReason::SessionEnded,
    )
    .await?
    {
        // No actor: ending the session is what closed it, and naming the person
        // as having *returned* control would record an act they did not perform.
        crate::routes::display_attach::emit_control_closed_in_tx(
            conn,
            workspace_id,
            ended.channel_id,
            None,
            None,
            &window,
        )
        .await?;
    }

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
