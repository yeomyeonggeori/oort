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
//! * `resume` drops three Swift steps, all of them B2.3 surfaces: the
//!   `work_tier_policy` gate (:1855-1871), the `work_control` spawn dispatch
//!   that tells a daemon to actually restart the tool (:1940-1959), and the
//!   audit row (see the crate-level note on `momo_db::audit`). What it does keep
//!   is the whole billing story: the source's ledger is settled through
//!   `t3_terminate` with reason `orphaned`, and the successor opens its own.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{cent_channel, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::{
    acquire_slot_in_tx, allocate_uuid_v7, cloud_host_id_for_host, cloud_host_id_for_host_in_tx,
    cloud_host_id_for_session_in_tx, create_resumed_work_session_in_tx,
    create_work_session_with_id_in_tx, end_work_session_in_tx, is_active_channel_member_in_tx,
    list_work_session_details_in_tx, lock_work_session_detail_in_tx,
    mark_work_session_resumed_in_tx, resolve_cloud_host_id, start_usage_in_tx, terminate_in_tx,
    update_session_card_props_in_tx, work_session_scope_in_tx, work_tool_is_enabled_in_tx,
    NewWorkSession, T3Error, T3LockLadder, TerminationReason, WorkSessionDetail,
};
use serde_json::{json, Map, Value};
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
        started_at_ms: detail.started_at_ms,
        ended_at_ms: detail.ended_at_ms,
        exit_code: detail.exit_code,
        end_reason: detail.end_reason,
        resumed_from_session_id: detail.resumed_from_session_id.map(|id| id.to_string()),
    }
}

/// The session card's `props` (Swift `cardProps`, :2346-2371). The card is the
/// thread's rendering of the session, so these keys are a client contract.
///
/// Positional rather than a struct, matching the Swift signature one-for-one:
/// there are three call sites and a builder would make it harder to check that
/// each passes what Swift passes.
#[allow(clippy::too_many_arguments)]
fn card_props(
    session_id: Uuid,
    tool: &str,
    label: &str,
    status: &str,
    ended_at_ms: Option<i64>,
    exit_code: Option<i32>,
    end_reason: Option<&str>,
    resumed_from_session_id: Option<Uuid>,
) -> Value {
    let mut props = Map::new();
    props.insert("kind".into(), json!("work_session"));
    props.insert("session_id".into(), json!(session_id.to_string()));
    props.insert("tool".into(), json!(tool));
    props.insert("label".into(), json!(label));
    props.insert("status".into(), json!(status));
    if let Some(ended_at_ms) = ended_at_ms {
        props.insert("ended_at".into(), json!(ended_at_ms));
    }
    if let Some(exit_code) = exit_code {
        props.insert("exit_code".into(), json!(exit_code));
    }
    if let Some(end_reason) = end_reason {
        props.insert("end_reason".into(), json!(end_reason));
    }
    if let Some(source) = resumed_from_session_id {
        props.insert("resumed_from_session_id".into(), json!(source.to_string()));
    }
    Value::Object(props)
}

/// The `work.session.started` / `work.session.ended` broadcast envelope
/// (`lifecyclePayload`, :2115-2156).
///
/// Deliberately carries **no** `version`: the card's `message.new` owns this seq
/// and has already advanced the channel version, so a second envelope claiming
/// the same version would make the relay skip one of them (the stale-skip
/// defect JOURNAL records from batch 2).
fn lifecycle_payload(
    event_type: &str,
    session: &WorkSessionDetail,
    root_message_seq: i64,
) -> Value {
    let is_ended = event_type == "work.session.ended";
    let timestamp = if is_ended {
        session.ended_at_ms.unwrap_or(session.started_at_ms)
    } else {
        session.started_at_ms
    };

    let mut payload = Map::new();
    payload.insert("session_id".into(), json!(session.id.to_string()));
    payload.insert("channel_id".into(), json!(session.channel_id.to_string()));
    payload.insert(
        "root_message_id".into(),
        json!(session.root_message_id.to_string()),
    );
    payload.insert("member_id".into(), json!(session.member_id.to_string()));
    payload.insert("host_id".into(), json!(session.host_id.to_string()));
    payload.insert("tool".into(), json!(session.tool));
    payload.insert("label".into(), json!(session.label));
    if is_ended {
        if let Some(ended_at_ms) = session.ended_at_ms {
            payload.insert("ended_at".into(), json!(ended_at_ms));
        }
        if let Some(exit_code) = session.exit_code {
            payload.insert("exit_code".into(), json!(exit_code));
        }
        if let Some(end_reason) = &session.end_reason {
            payload.insert("end_reason".into(), json!(end_reason));
        }
    } else {
        payload.insert("started_at".into(), json!(session.started_at_ms));
    }
    if let Some(source) = session.resumed_from_session_id {
        payload.insert("resumed_from_session_id".into(), json!(source.to_string()));
    }

    let channel = cent_channel(session.workspace_id, session.channel_id);
    json!({
        "channel": channel,
        "data": {
            "type": event_type,
            "v": 1,
            "ts": timestamp,
            "seq": root_message_seq,
            "payload": Value::Object(payload),
        },
        "idempotency_key": format!("{channel}:{event_type}:{}", session.id),
    })
}

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
        &lifecycle_payload("work.session.started", &detail.0, card.message.seq),
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
        &lifecycle_payload("work.session.ended", &ended, root_seq),
        Some(ended.channel_id),
    )
    .await
    .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;

    Ok(Ok(ended))
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/resume` → 201
/// (Swift `resume`, :1763-2025), minus the three B2.3 steps named in the module
/// docs.
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
        lifecycle_payload("work.session.ended", &ended_source, source_seq),
        lifecycle_payload("work.session.started", &resumed, source_seq),
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
        let started = lifecycle_payload("work.session.started", &session, 12);
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
        let ended = lifecycle_payload("work.session.ended", &session, 12);
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
    }
}
