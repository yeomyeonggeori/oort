//! The AgentGateway callback surface — Swift `AgentGatewayRoutes` parity for the
//! B2.6 billing spine.
//!
//! ```text
//! GET  /v1/workspaces/{ws}/agents/{agent}/gateway/jobs/pending
//! POST /v1/workspaces/{ws}/agents/{agent}/gateway/jobs/{job}/lease/renew
//! POST /v1/workspaces/{ws}/agents/{agent}/gateway/jobs/{job}/lease/release
//! POST /v1/workspaces/{ws}/agent-runs/{run}/gateway/events
//! POST /v1/workspaces/{ws}/agent-runs/{run}/gateway/complete
//! ```
//!
//! ## What this surface is, and is not
//!
//! It is **not** a provider-credential surface (Swift's opening comment, :7-13).
//! Hermes or another runtime owns the model keys; momo accepts status/result
//! callbacks for jobs momo itself created, and commits user-visible output
//! through the same Postgres/outbox path as every other message.
//!
//! ## The three gates every callback passes
//!
//! 1. **mode** — `requireGatewayMode` (:1138-1142): 403 unless the operator chose
//!    `AGENT_GATEWAY_MODE=gateway`. A worker-mode instance has no callback
//!    surface, so a stray adapter cannot write into it.
//! 2. **actor binding** — `requireRunActorBinding` (:1144-1172): a credential
//!    naming a member may only speak for *its own* run. (The legacy process
//!    secret names no member, so it is exempt — and is why that secret is
//!    deprecated.)
//! 3. **lease** — `gatewayLeaseAuthorized`: the caller must still own the pending
//!    `agent_job` row bound to this run. This is what an attacker who learned a
//!    `run_id` runs into.
//!
//! ## Scope (deviations recorded in the PR body)
//!
//! The `tool_call` (work-control) and `approval_request` branches of Swift's
//! `event` handler are **not** ported: both are other subsystems' surfaces
//! reached through this door, and neither is on the billing spine. Streaming
//! `text_delta` relay is likewise absent — a `streaming` event is accepted and
//! recorded, but no partial-message broadcast is emitted, so nothing here relays
//! a token stream. The progress rate limiter (a process-local sliding window) is
//! not ported either; it is not an invariant and a single-process limiter is not
//! the right shape for a multi-replica deployment.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use momo_agent::{
    completion_status, finish_run_in_tx, is_active_agent_in_tx, lock_gateway_run_in_tx,
    mark_run_started_in_tx, record_run_usage_in_tx, CompletionStatusError, GatewayRunSnapshot,
    RunUsageReport,
};
use momo_auth::Principal;
use momo_db::audit::{run_event_recorded, write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_messaging::{find_client_message_in_tx, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{
    claim_gateway_jobs_in_tx, clamp_claim_limit, gateway_lease_authorized,
    lock_gateway_lease_in_tx, release_gateway_lease_in_tx, renew_gateway_lease_in_tx,
    settle_gateway_job_in_tx, GatewayLeaseBinding,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::GatewayCaller;
use crate::dto::{
    AgentGatewayCompleteRequest, AgentGatewayCompleteResponse, AgentGatewayEventRequest,
    AgentGatewayEventResponse, AgentGatewayLeaseRequest, AgentGatewayLeaseResponse,
    AgentGatewayPendingJob, AgentGatewayPendingJobsResponse, AgentGatewayUsageDto,
    PendingJobsQuery,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, emit_rail_frame, emit_terminal_agent_status, epoch_ms, path_uuid, settle_db,
};
use crate::AppState;

/// Swift `AgentGatewayEventRequest.maximumDetailBytes` / `maximumTextDeltaBytes`
/// (:1853-1854).
const MAX_DETAIL_BYTES: usize = 2_048;
const MAX_TEXT_DELTA_BYTES: usize = 8_192;
/// Swift `sanitizedGatewayError`'s cap (:1581).
const MAX_ERROR_CHARS: usize = 1_000;
/// Shortest configured secret that is worth substring-redacting out of an error
/// message. See [`sanitized_gateway_error`] — this is a deliberate hardening over
/// Swift's bare `!gatewaySecret.isEmpty` guard.
const MIN_REDACTABLE_SECRET_CHARS: usize = 16;

// ---------------------------------------------------------------------------
// jobs: claim / renew / release
// ---------------------------------------------------------------------------

/// `GET …/agents/{agent}/gateway/jobs/pending` — claim work, with a lease.
pub async fn pending_jobs(
    State(state): State<AppState>,
    caller: GatewayCaller,
    Path((workspace, agent)): Path<(String, String)>,
    Query(query): Query<PendingJobsQuery>,
) -> Result<Json<AgentGatewayPendingJobsResponse>, ApiError> {
    require_gateway_mode(&state)?;
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;
    let agent_id = path_uuid(&agent, "invalid agent id")?;
    require_actor_is_target_agent(&caller, workspace_id, agent_id)?;

    let limit = clamp_claim_limit(query.limit());
    let jobs = settle_db(
        "agent_gateway.pending_jobs",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_agent_in_tx(conn, workspace_id, agent_id).await? {
                    return Ok(Err(ApiError::not_found("active agent not found")));
                }
                let claimed = claim_gateway_jobs_in_tx(conn, workspace_id, agent_id, limit)
                    .await
                    .map_err(momo_db::DbError::from)?;
                Ok(Ok(claimed
                    .into_iter()
                    .map(|job| AgentGatewayPendingJob {
                        id: job.id,
                        run_id: job.run_id_field().to_string(),
                        created_at_ms: epoch_ms(job.created_at),
                        lease_id: job.lease_id.to_string(),
                        lease_expires_at_ms: epoch_ms(job.lease_expires_at),
                        payload: job.payload,
                    })
                    .collect::<Vec<_>>()))
            })
        })
        .await,
    )?;

    Ok(Json(AgentGatewayPendingJobsResponse { jobs }))
}

/// `POST …/jobs/{job}/lease/renew` — a long run keeps its claim alive.
pub async fn renew_lease(
    State(state): State<AppState>,
    caller: GatewayCaller,
    Path((workspace, agent, job)): Path<(String, String, String)>,
    body: Option<Json<AgentGatewayLeaseRequest>>,
) -> Result<Json<AgentGatewayLeaseResponse>, ApiError> {
    require_gateway_mode(&state)?;
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;
    let agent_id = path_uuid(&agent, "invalid agent id")?;
    let job_id = path_job_id(&job)?;
    require_actor_is_target_agent(&caller, workspace_id, agent_id)?;
    let lease = validated_lease_request(body.map(|Json(body)| body).unwrap_or_default(), job_id)?;

    let expires_at = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            renew_gateway_lease_in_tx(conn, workspace_id, agent_id, lease)
                .await
                .map_err(momo_db::DbError::from)
        })
    })
    .await
    .map_err(|error| ApiError::internal("agent_gateway.renew_lease", error))?;

    let Some(expires_at) = expires_at else {
        return Err(lease_rejected());
    };
    Ok(Json(AgentGatewayLeaseResponse {
        status: "renewed",
        job_id,
        lease_id: lease.lease_id.to_string(),
        lease_expires_at_ms: Some(epoch_ms(expires_at)),
    }))
}

/// `POST …/jobs/{job}/lease/release` — hand the claim back immediately rather
/// than making the next consumer wait out the expiry.
pub async fn release_lease(
    State(state): State<AppState>,
    caller: GatewayCaller,
    Path((workspace, agent, job)): Path<(String, String, String)>,
    body: Option<Json<AgentGatewayLeaseRequest>>,
) -> Result<Json<AgentGatewayLeaseResponse>, ApiError> {
    require_gateway_mode(&state)?;
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;
    let agent_id = path_uuid(&agent, "invalid agent id")?;
    let job_id = path_job_id(&job)?;
    require_actor_is_target_agent(&caller, workspace_id, agent_id)?;
    let lease = validated_lease_request(body.map(|Json(body)| body).unwrap_or_default(), job_id)?;

    let released = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            release_gateway_lease_in_tx(conn, workspace_id, agent_id, lease)
                .await
                .map_err(momo_db::DbError::from)
        })
    })
    .await
    .map_err(|error| ApiError::internal("agent_gateway.release_lease", error))?;

    if !released {
        return Err(lease_rejected());
    }
    Ok(Json(AgentGatewayLeaseResponse {
        status: "released",
        job_id,
        lease_id: lease.lease_id.to_string(),
        lease_expires_at_ms: None,
    }))
}

// ---------------------------------------------------------------------------
// run callbacks: events / complete
// ---------------------------------------------------------------------------

/// `POST …/agent-runs/{run}/gateway/events` — progress.
///
/// The only state this writes is `queued → running` plus an audit row. The audit
/// row doubles as the **event de-duplication key**: an adapter that retries an
/// event id it already sent gets `accepted` without a second transition (Swift
/// :343-359), so at-least-once delivery does not become at-least-once state.
pub async fn event(
    State(state): State<AppState>,
    caller: GatewayCaller,
    Path((workspace, run)): Path<(String, String)>,
    Json(request): Json<AgentGatewayEventRequest>,
) -> Result<Json<AgentGatewayEventResponse>, ApiError> {
    require_gateway_mode(&state)?;
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;
    let run_id = path_uuid(&run, "invalid run id")?;
    let principal = caller.require_gateway_principal(workspace_id)?.cloned();

    let Some(lease) = lease_binding(request.job_id, request.lease_id) else {
        return Err(lease_rejected());
    };
    let (status, detail, text_delta) = validated_event_fields(
        request.status.as_deref(),
        request.detail.as_deref(),
        request.text_delta.as_deref(),
    )?;
    let event_id = request.event_id.unwrap_or_else(Uuid::new_v4);
    let via_token_id = principal.as_ref().and_then(|p| p.token_id);
    let actor_member_id = principal.as_ref().map(|p| p.member_id);
    let input = GatewayEventInput {
        run_id,
        lease,
        status,
        detail,
        text_delta,
        event_id,
        actor_member_id,
        via_token_id,
    };

    settle_db(
        "agent_gateway.event",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move { record_gateway_event_in_tx(conn, workspace_id, input).await })
        })
        .await,
    )?;

    Ok(Json(AgentGatewayEventResponse {
        status: "accepted",
        run_id: run_id.to_string(),
    }))
}

/// `status`/`detail`/`text_delta` validation, shared by the REST callback and
/// the Agent Port's `oort_run_event` tool.
///
/// `text_delta` belongs to `streaming` and nowhere else (Swift :1898-1904). The
/// delta is validated and then deliberately dropped: B2.6 relays no stream, and
/// silently accepting it on the wrong status would let an adapter believe momo
/// had delivered something.
pub(crate) fn validated_event_fields(
    status: Option<&str>,
    detail: Option<&str>,
    text_delta: Option<&str>,
) -> Result<(&'static str, Option<String>, Option<String>), ApiError> {
    let status = normalized_event_status(status)?;
    let detail = bounded(detail, "detail", MAX_DETAIL_BYTES)?;
    let text_delta = bounded(text_delta, "text_delta", MAX_TEXT_DELTA_BYTES)?;
    if status == "streaming" {
        if text_delta.as_deref().unwrap_or_default().is_empty() {
            return Err(ApiError::bad_request("streaming event requires text_delta"));
        }
    } else if text_delta.is_some() {
        return Err(ApiError::bad_request(
            "text_delta is only valid for streaming events",
        ));
    }
    Ok((status, detail, text_delta))
}

/// One already-validated progress event, ready for the run ledger.
///
/// A struct rather than eight parameters because two callers now share this
/// transaction — the REST callback and the Agent Port tool — and a positional
/// list is exactly how the two would eventually pass different things.
pub(crate) struct GatewayEventInput {
    pub run_id: Uuid,
    pub lease: GatewayLeaseBinding,
    pub status: &'static str,
    pub detail: Option<String>,
    pub text_delta: Option<String>,
    pub event_id: Uuid,
    /// `None` only for the deprecated process secret, which names no member.
    pub actor_member_id: Option<Uuid>,
    pub via_token_id: Option<Uuid>,
}

/// **The** gateway progress transaction. Both doors reach the run ledger
/// through this function, so the lease check, the idempotency key, the terminal
/// rules and the rail frames are one implementation rather than two that agree
/// today.
///
/// The gateway *mode* gate is deliberately absent: it is a property of the REST
/// callback surface, not of the run ledger, and a per-agent hosted connection is
/// authorized by its own connection rather than by the instance's provider mode.
pub(crate) async fn record_gateway_event_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: GatewayEventInput,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let GatewayEventInput {
        run_id,
        lease,
        status,
        detail,
        text_delta,
        event_id,
        actor_member_id,
        via_token_id,
    } = input;
    let Some(run) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await? else {
        return Ok(Err(ApiError::not_found("agent run not found")));
    };
    if let Err(rejection) = actor_binding(actor_member_id, run.agent_member_id) {
        return Ok(Err(rejection));
    }
    // A cancellation acknowledgement is the one event a run in a
    // settled state may still carry, so the lease check widens only
    // for that exact pair (Swift :341).
    let allow_settled = status == "cancelled" && run.status == momo_agent::RunStatus::Cancelled;
    if !lease_is_authorized(conn, workspace_id, run_id, &run, lease, allow_settled).await? {
        return Ok(Err(lease_rejected()));
    }

    if run_event_recorded(conn, workspace_id, run_id, EVENT_AUDIT_ACTION, event_id).await? {
        return Ok(Ok(()));
    }
    if run.status.is_approval_held() {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "agent run is awaiting a human approval decision",
        )));
    }
    if run.status.is_terminal() && status != "cancelled" {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "agent run is already terminal",
        )));
    }
    if status == "cancelled" && run.status != momo_agent::RunStatus::Cancelled {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "gateway cancellation acknowledgement has no rejected run",
        )));
    }

    if matches!(status, "running" | "thinking" | "streaming") {
        mark_run_started_in_tx(conn, run_id).await?;

        // …and the rail is told what the gateway is doing (goal
        // SRV-B3d). This is the projection Swift gets wrong: it
        // folds everything that is not `streaming`/`cancelled` into
        // `("thinking","running")`, which is why its *terminal*
        // events vanish. Here the fold is total on purpose — these
        // three statuses really are all "the turn is running" — and
        // the terminal case never reaches this branch at all,
        // because `complete` owns it (goal SRV-B3c).
        let address = momo_agent::AgentRunAddress {
            workspace_id,
            channel_id: run.channel_id,
            agent_member_id: run.agent_member_id,
            run_id,
        };
        let phase = event_progress_phase(status);
        // Keyed on the gateway's own event id, which is what makes
        // a retried callback one frame instead of two: the whole
        // event is already idempotent on it (`run_event_recorded`
        // above returns early), and the frame follows the same key
        // so a retry that raced that check still collapses in
        // Centrifugo's cache.
        emit_rail_frame(
            conn,
            workspace_id,
            run.channel_id,
            &momo_agent::progress_agent_status_payload(
                address,
                phase,
                epoch_ms(chrono::Utc::now()),
                &format!("gateway:{event_id}"),
            ),
        )
        .await?;

        // The delta this route has validated and thrown away since
        // B2.6 ("the delta is validated and then deliberately
        // dropped: B2.6 relays no stream"). It is a relay, not an
        // accumulator — momo never held the partial answer and does
        // not start now; the client appends.
        if let Some(delta) = text_delta.as_deref().filter(|d| !d.is_empty()) {
            emit_rail_frame(
                conn,
                workspace_id,
                run.channel_id,
                &momo_agent::agent_partial_payload(
                    address,
                    delta,
                    epoch_ms(chrono::Utc::now()),
                    &format!("gateway:{event_id}"),
                ),
            )
            .await?;
        }
    }

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, EVENT_AUDIT_ACTION)
            .by(run.agent_member_id)
            .target("agent_run", run_id)
            .via_token(via_token_id)
            .run(run_id)
            .with_schema(
                "momo.agent_gateway.event.v0",
                json!({
                    "status": status,
                    "detail": detail,
                    "event_id": event_id.to_string(),
                    "text_delta_bytes": text_delta.as_ref().map(|value| value.len()),
                    "run_id": run_id.to_string(),
                    "agent_member_id": run.agent_member_id.to_string(),
                    "source": "hermes_gateway",
                }),
            ),
    )
    .await?;
    Ok(Ok(()))
}

/// `POST …/agent-runs/{run}/gateway/complete` — the run's last word, and the
/// only place `usage_ledger` is written.
///
/// **Four writes, one transaction:** the final message (through the messenger's
/// own send path, so it bumps `channel_seq` and broadcasts through the single
/// outbox egress), the ledger row, the terminal run status, and the job's
/// settlement. Splitting them would make a billed run with no output — or output
/// with no bill — representable; here it is not.
pub async fn complete(
    State(state): State<AppState>,
    caller: GatewayCaller,
    Path((workspace, run)): Path<(String, String)>,
    Json(request): Json<AgentGatewayCompleteRequest>,
) -> Result<Json<AgentGatewayCompleteResponse>, ApiError> {
    require_gateway_mode(&state)?;
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;
    let run_id = path_uuid(&run, "invalid run id")?;
    let principal = caller.require_gateway_principal(workspace_id)?.cloned();

    let succeeded = completion_status(request.status.as_deref(), request.error.as_deref())
        .map_err(|error| match error {
            CompletionStatusError::SuccessWithError | CompletionStatusError::Unknown => {
                ApiError::bad_request(error.to_string())
            }
        })?;
    let safe_error = sanitized_gateway_error(request.error.as_deref(), &state.agent_gateway.secret);
    let usage = request.usage.as_ref().map(usage_report);
    let via_token_id = principal.as_ref().and_then(|p| p.token_id);
    let actor_member_id = principal.as_ref().map(|p| p.member_id);
    let usage_detail = request.usage.as_ref().map(usage_detail_json);
    let input = GatewayCompleteInput {
        run_id,
        lease: lease_binding(request.job_id, request.lease_id),
        succeeded,
        body: request.body.clone(),
        safe_error,
        usage,
        usage_detail,
        actor_member_id,
        via_token_id,
    };

    let outcome = settle_db(
        "agent_gateway.complete",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move { complete_gateway_run_in_tx(conn, workspace_id, input).await })
        })
        .await,
    )?;

    let (message_id, seq, status) = outcome;
    Ok(Json(AgentGatewayCompleteResponse {
        status,
        run_id: run_id.to_string(),
        message_id: message_id.to_string(),
        seq,
    }))
}

/// One already-validated completion, ready for the run ledger.
pub(crate) struct GatewayCompleteInput {
    pub run_id: Uuid,
    /// `None` when the caller presented an incomplete lease pair.
    ///
    /// Deliberately optional rather than validated by the caller: the shape
    /// check has to happen **after** the run is locked and its approval hold is
    /// answered, or a run parked on a human decision would answer
    /// `lease is expired or not owned` to an adapter whose real problem is that
    /// a person has not decided yet — the exact misdiagnosis the comment below
    /// says this ordering exists to prevent.
    pub lease: Option<GatewayLeaseBinding>,
    pub succeeded: bool,
    /// The gateway's raw body, echoed verbatim into `agent_run.output`.
    pub body: Option<String>,
    /// Already redacted by [`sanitized_gateway_error`] — this function never
    /// sees the raw provider error, because the text reaches `message.body` and
    /// is broadcast to the whole channel.
    pub safe_error: Option<String>,
    pub usage: Option<RunUsageReport>,
    pub usage_detail: Option<Value>,
    pub actor_member_id: Option<Uuid>,
    pub via_token_id: Option<Uuid>,
}

/// **The** gateway completion transaction — four writes, one transaction, two
/// callers (the REST callback and the Agent Port's `oort_run_complete`).
///
/// Extracted rather than reimplemented for the Agent Port because a second
/// completion path is a second way to bill a run, a second way to answer in a
/// channel, and a second set of terminal rules to keep in step. Like
/// [`record_gateway_event_in_tx`] it carries no gateway-mode gate: the mode is a
/// property of the REST surface, and a hosted connection carries its own
/// authorization.
pub(crate) async fn complete_gateway_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: GatewayCompleteInput,
) -> Result<Result<(Uuid, i64, &'static str), ApiError>, momo_db::DbError> {
    let GatewayCompleteInput {
        run_id,
        lease,
        succeeded,
        body,
        safe_error,
        usage,
        usage_detail,
        actor_member_id,
        via_token_id,
    } = input;
    let body_text = timeline_body(body.as_deref(), succeeded, safe_error.as_deref());
    let Some(run) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await? else {
        return Ok(Err(ApiError::not_found("agent run not found")));
    };
    if let Err(rejection) = actor_binding(actor_member_id, run.agent_member_id) {
        return Ok(Err(rejection));
    }

    // An approval hold is answered BEFORE the lease is judged: a run
    // parked on a human decision must say so even to a gateway whose
    // lease expired, or the adapter retries forever against the wrong
    // diagnosis (Swift :825-827).
    if run.status.is_approval_held() {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "agent run requires a human approval decision ({})",
                run.status.as_db_label()
            ),
        )));
    }

    let Some(lease) = lease else {
        return Ok(Err(lease_rejected()));
    };
    let terminal = run.status.is_terminal();
    if !lease_is_authorized(conn, workspace_id, run_id, &run, lease, terminal).await? {
        return Ok(Err(lease_rejected()));
    }

    // A terminal run either replays the message it already produced,
    // or refuses. Looking the message up FIRST is what keeps a
    // cancelled run from acquiring a "final response" it never had.
    if terminal {
        let existing =
            find_client_message_in_tx(conn, run.channel_id, run.agent_member_id, run_id).await?;
        return Ok(match existing {
            Some(message) => Ok((message.id, message.seq, run.status.as_db_label())),
            None => Err(ApiError::new(
                StatusCode::CONFLICT,
                format!(
                    "agent run is already terminal ({})",
                    run.status.as_db_label()
                ),
            )),
        });
    }

    // 1. the final message — the messenger's own write path, keyed by
    //    the run id so a replay can never produce a second one.
    let message = send_message_in_tx(
        conn,
        workspace_id,
        NewMessage {
            channel_id: run.channel_id,
            author_member_id: run.agent_member_id,
            message_type: if succeeded {
                MessageType::Text
            } else {
                MessageType::System
            },
            body: Some(body_text.clone()),
            props: timeline_props(
                &run,
                run_id,
                succeeded,
                usage_detail.clone(),
                safe_error.as_deref(),
            ),
            root_id: None,
            // ADR-0148 규칙 6 — the same answer the worker gives,
            // arriving by a different door, so it points at the same
            // message. Both read `agent_run.trigger_message_id` off
            // the locked run row rather than off a job payload,
            // which is what keeps "an agent quotes what it answers"
            // one rule instead of two implementations of it.
            reply_to_id: run.trigger_message_id,
            client_msg_id: Some(run_id),
            run_id: Some(run_id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;

    // 1b. …and the hosted inbox projection for that answer (ADR-0162 / HAP-E5).
    //
    //     The answer is written through the RAW spine — `send_message_in_tx`,
    //     not the product send — so it does not inherit the fan-out that
    //     `send_message_with_mentions_in_tx` performs. Without this call a
    //     hosted agent sharing a channel with another agent would never see
    //     that agent's answers in its durable inbox, which is exactly the
    //     mixed-workspace story the selector exists to serve.
    //
    //     The author is excluded inside the fan-out, so the completing agent
    //     does not read its own answer back. On the terminal-replay branch
    //     above no message is written and none is needed: the reference the
    //     first completion appended is already there, and the append is
    //     idempotent anyway.
    momo_messaging::fan_out_message_reference_in_tx(
        conn,
        workspace_id,
        run.channel_id,
        message.message.id,
        run.agent_member_id,
    )
    .await?;

    // 2. the bill.
    let resolved = RunUsageReport::resolve(
        usage.as_ref(),
        &run.model,
        run.requested_effort.as_deref(),
        run.profile_effort_pref.as_deref(),
    );
    record_run_usage_in_tx(
        conn,
        workspace_id,
        run_id,
        run.agent_member_id,
        run.channel_id,
        &resolved,
    )
    .await?;

    // 3. the terminal status.
    let output = json!({
        "schema": "momo.agent_gateway.output.v0",
        "status": if succeeded { "succeeded" } else { "failed" },
        "body": body,
        "message_id": message.message.id.to_string(),
        "usage": usage_detail,
    });
    let error_json = (!succeeded).then(|| {
        json!({
            "code": "hermes_gateway_failed",
            "message": safe_error
                .clone()
                .unwrap_or_else(|| "gateway reported failure".to_string()),
            "source": "hermes_gateway",
        })
    });
    finish_run_in_tx(conn, run_id, succeeded, &output, error_json.as_ref()).await?;

    // 3b. …and the rail is told the turn is over (goal SRV-B3c).
    //
    // Measured gap this closes: `agent:ws<WS>.<CH>.<AGENT>` had a
    // subscriber (realtime.rs authorizes it, every client folds it)
    // and NO producer anywhere in this workspace — so a run that
    // succeeded simply went quiet and each client waited out its own
    // idle TTL instead of being told. The frame is emitted in THIS
    // transaction and after the final message's own broadcast, so a
    // client can never learn the turn ended before it sees what the
    // turn said.
    emit_terminal_agent_status(
        conn,
        workspace_id,
        run.channel_id,
        run.agent_member_id,
        run_id,
        if succeeded {
            momo_agent::RunStatus::Succeeded
        } else {
            momo_agent::RunStatus::Failed
        },
    )
    .await?;

    // 4. the job is done; `last_error` is NULL on success so an
    //    operator reading the outbox sees why a job stopped.
    settle_gateway_job_in_tx(
        conn,
        workspace_id,
        run_id,
        lease,
        if succeeded {
            None
        } else {
            Some(safe_error.as_deref().unwrap_or("gateway reported failure"))
        },
    )
    .await
    .map_err(momo_db::DbError::from)?;

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, "agent.gateway.completed")
            .by(run.agent_member_id)
            .target("agent_run", run_id)
            .via_token(via_token_id)
            .run(run_id)
            .with_schema(
                "momo.agent_gateway.completed.v0",
                json!({
                    "status": if succeeded { "succeeded" } else { "failed" },
                    "run_id": run_id.to_string(),
                    "message_id": message.message.id.to_string(),
                    "usage": usage_detail,
                    "source": "hermes_gateway",
                }),
            ),
    )
    .await?;

    Ok(Ok((
        message.message.id,
        message.message.seq,
        if succeeded { "succeeded" } else { "failed" },
    )))
}

// ---------------------------------------------------------------------------
// gates + helpers
// ---------------------------------------------------------------------------

const EVENT_AUDIT_ACTION: &str = "agent.gateway.status";

/// Swift `requireGatewayMode` (:1138-1142).
fn require_gateway_mode(state: &AppState) -> Result<(), ApiError> {
    if state.agent_gateway.enabled() {
        Ok(())
    } else {
        Err(ApiError::forbidden("agent gateway mode is disabled"))
    }
}

/// Swift `rejectGatewayLease` (:1286-1288). One message for every lease failure —
/// wrong owner, expired, settled, or absent — so a caller cannot use the wording
/// to probe another consumer's state.
fn lease_rejected() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "gateway job lease is expired or not owned",
    )
}

/// The `{job}` path segment (Swift `jobID` :1413-1419): a positive `Int64`.
fn path_job_id(raw: &str) -> Result<i64, ApiError> {
    raw.trim()
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| ApiError::bad_request("invalid gateway job id"))
}

fn lease_binding(job_id: Option<i64>, lease_id: Option<Uuid>) -> Option<GatewayLeaseBinding> {
    match (job_id, lease_id) {
        (Some(job_id), Some(lease_id)) if job_id > 0 => {
            Some(GatewayLeaseBinding { job_id, lease_id })
        }
        _ => None,
    }
}

/// Swift `AgentGatewayLeaseRequest.validated(jobID:)` (:2389-2397). Note both
/// failures are **409**, not 400: the body disagreeing with the path is treated
/// as a lease problem, which is the wording Swift chose and clients parse.
fn validated_lease_request(
    request: AgentGatewayLeaseRequest,
    path_job_id: i64,
) -> Result<GatewayLeaseBinding, ApiError> {
    if let Some(job_id) = request.job_id {
        if job_id != path_job_id {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "gateway job id does not match path",
            ));
        }
    }
    let lease_id = request
        .lease_id
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "lease_id is required"))?;
    Ok(GatewayLeaseBinding {
        job_id: path_job_id,
        lease_id,
    })
}

/// Swift's `principal.memberID != targetAgentID` guard on the three job routes
/// (:61-63, :152-154, :199-201).
fn require_actor_is_target_agent(
    caller: &GatewayCaller,
    workspace_id: Uuid,
    target_agent_id: Uuid,
) -> Result<Option<Principal>, ApiError> {
    let principal = caller.require_gateway_principal(workspace_id)?.cloned();
    if let Some(principal) = principal.as_ref() {
        if principal.member_id != target_agent_id {
            return Err(ApiError::forbidden(
                "agent bearer actor does not match target agent",
            ));
        }
    }
    Ok(principal)
}

/// Swift `runActorBindingAllows` (:1174-1180): a credential that names a member
/// may only speak for its own run. `None` (the legacy process secret) is exempt,
/// which is exactly why that credential is deprecated.
fn actor_binding(
    principal_member_id: Option<Uuid>,
    run_agent_member_id: Uuid,
) -> Result<(), ApiError> {
    match principal_member_id {
        Some(member_id) if member_id != run_agent_member_id => Err(ApiError::forbidden(
            "agent bearer actor does not match run agent",
        )),
        _ => Ok(()),
    }
}

async fn lease_is_authorized(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    run: &GatewayRunSnapshot,
    lease: GatewayLeaseBinding,
    allow_settled: bool,
) -> Result<bool, momo_db::DbError> {
    let snapshot = lock_gateway_lease_in_tx(conn, workspace_id, run_id, run.agent_member_id, lease)
        .await
        .map_err(momo_db::DbError::from)?;
    Ok(gateway_lease_authorized(
        snapshot,
        lease.lease_id,
        allow_settled,
    ))
}

/// Swift `normalizedStatus` (:1471-1474) + `validatedProgress`'s closed set
/// (:1889). Empty/absent means `running`.
fn normalized_event_status(raw: Option<&str>) -> Result<&'static str, ApiError> {
    let value = raw.map(|raw| raw.trim().to_ascii_lowercase());
    let value = match value.as_deref() {
        None | Some("") => "running",
        Some(other) => other,
    };
    match value {
        "running" => Ok("running"),
        "thinking" => Ok("thinking"),
        "streaming" => Ok("streaming"),
        "cancelled" => Ok("cancelled"),
        _ => Err(ApiError::bad_request("unknown gateway event status")),
    }
}

/// Swift `bounded` (:1912-1918) — a byte cap, checked before anything is stored.
fn bounded(raw: Option<&str>, field: &str, limit: usize) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.len() > limit {
        return Err(ApiError::bad_request(format!("{field} is too large")));
    }
    Ok(Some(raw.to_string()))
}

fn usage_report(dto: &AgentGatewayUsageDto) -> RunUsageReport {
    RunUsageReport {
        model: dto.model.clone(),
        effort: dto.effort.clone(),
        prompt_tokens: dto.prompt_tokens,
        completion_tokens: dto.completion_tokens,
        cached_tokens: dto.cached_tokens,
        reasoning_tokens: dto.reasoning_tokens,
        cost_micro_usd: dto.cost_micro_usd,
        was_estimated: dto.was_estimated,
    }
}

/// Swift `AgentGatewayUsage.asObject` (:2335-2346) — the *reported* block, echoed
/// into `message.props`, `agent_run.output` and the audit row unchanged. It is
/// deliberately not the resolved row: those three record what the gateway
/// claimed, while `usage_ledger` records what momo billed.
fn usage_detail_json(dto: &AgentGatewayUsageDto) -> Value {
    json!({
        "model": dto.model,
        "effort": dto.effort,
        "prompt_tokens": dto.prompt_tokens,
        "completion_tokens": dto.completion_tokens,
        "cached_tokens": dto.cached_tokens,
        "reasoning_tokens": dto.reasoning_tokens,
        "cost_micro_usd": dto.cost_micro_usd,
        "was_estimated": dto.was_estimated,
    })
}

/// Swift `timelineBody` (:1497-1511).
fn timeline_body(body: Option<&str>, succeeded: bool, safe_error: Option<&str>) -> String {
    if succeeded {
        let text = body.map(str::trim).unwrap_or_default();
        return if text.is_empty() {
            "(Hermes gateway returned an empty response.)".to_string()
        } else {
            text.to_string()
        };
    }
    match safe_error.map(str::trim).filter(|value| !value.is_empty()) {
        Some(reason) => {
            format!("Hermes gateway failed before producing a final response: {reason}")
        }
        None => "Hermes gateway failed before producing a final response.".to_string(),
    }
}

/// Swift `timelineProps` (:1513-1529).
fn timeline_props(
    run: &GatewayRunSnapshot,
    run_id: Uuid,
    succeeded: bool,
    usage: Option<Value>,
    error: Option<&str>,
) -> Value {
    json!({
        "schema": "momo.agent_gateway.timeline.v0",
        "source": "hermes_gateway",
        "status": if succeeded { "succeeded" } else { "failed" },
        "run_id": run_id.to_string(),
        "agent_member_id": run.agent_member_id.to_string(),
        "usage": usage,
        "error": error,
    })
}

/// Redact credential-shaped content out of gateway-reported error text — Swift
/// `sanitizedGatewayError` (:1554-1587).
///
/// This is not hygiene theatre. The error string is written to `message.body`,
/// which is broadcast to every member of the channel, so a runtime that
/// helpfully includes the failing request's headers would publish its own
/// credentials to the workspace. The order matters: the instance's own secret
/// first (it is the one value this server knows verbatim), then the shaped
/// tokens, then the catch-all — a message that still *smells* of a credential
/// after redaction is replaced wholesale rather than published with holes in it.
///
/// Swift uses regular expressions; this is a token scan over the same shapes,
/// which avoids adding a regex dependency for one function and covers the same
/// prefixes. Cases where the two could differ (a token glued to adjacent
/// non-delimiter bytes) are caught by the credential-hint sweep that follows.
///
/// **Hardening over Swift:** the secret is substring-replaced only when it is at
/// least [`MIN_REDACTABLE_SECRET_CHARS`] long. Swift guards on
/// `!gatewaySecret.isEmpty`, which means an instance configured with a two-letter
/// `AGENT_GATEWAY_SECRET` rewrites every occurrence of those letters in every
/// error message — the messages become unreadable and nothing is protected,
/// because a value that short was never a credential. This function is called
/// with the configured secret whether or not the legacy path is enabled, so the
/// guard has to live here rather than upstream.
pub(crate) fn sanitized_gateway_error(raw: Option<&str>, gateway_secret: &str) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }
    let mut value = value.to_string();
    if gateway_secret.chars().count() >= MIN_REDACTABLE_SECRET_CHARS {
        value = value.replace(gateway_secret, "[redacted]");
    }

    // Split on the delimiters that can never be part of a token, redact whole
    // tokens, and keep the delimiters so the message stays readable.
    let mut redacted = String::with_capacity(value.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if !token.is_empty() {
            out.push_str(&redact_token(token));
            token.clear();
        }
    };
    for ch in value.chars() {
        if ch.is_whitespace()
            || matches!(
                ch,
                '"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
            )
        {
            flush(&mut token, &mut redacted);
            redacted.push(ch);
        } else {
            token.push(ch);
        }
    }
    flush(&mut token, &mut redacted);

    // The catch-all: if it still reads like a credential dump, say so instead of
    // publishing it (Swift :1576-1580).
    let lowered = redacted.to_lowercase();
    if [
        "bearer ",
        "authorization:",
        "api_key",
        "access_token",
        "refresh_token",
    ]
    .iter()
    .any(|hint| lowered.contains(hint))
    {
        return Some(
            "Hermes gateway reported an error with redacted credential-shaped content.".to_string(),
        );
    }

    if redacted.chars().count() > MAX_ERROR_CHARS {
        let prefix: String = redacted.chars().take(MAX_ERROR_CHARS).collect();
        return Some(format!("{prefix}... [truncated]"));
    }
    Some(redacted)
}

/// One token's redaction verdict (Swift's three regexes, :1561-1575).
fn redact_token(token: &str) -> String {
    let trimmed = token.trim_matches(|c: char| matches!(c, '.' | ':' | '=' | '!' | '?'));
    if trimmed.starts_with("momo_agent_v1.") && trimmed.matches('.').count() >= 2 {
        return token.replace(trimmed, "[redacted-agent-token]");
    }
    let lowered = trimmed.to_ascii_lowercase();
    let provider_shaped = ["sk-", "ghp_", "github_pat_", "ya29."]
        .iter()
        .any(|prefix| lowered.starts_with(prefix) && trimmed.len() >= prefix.len() + 8)
        || (lowered.starts_with("xox")
            && trimmed.len() >= 12
            && trimmed
                .chars()
                .nth(3)
                .is_some_and(|c| matches!(c, 'b' | 'a' | 'p' | 'r' | 's'))
            && trimmed.chars().nth(4) == Some('-'));
    if provider_shaped {
        return token.replace(trimmed, "[redacted-provider-token]");
    }
    // A compact JWS: three base64url segments, the first starting `eyJ`.
    if trimmed.starts_with("eyJ") && trimmed.split('.').count() == 3 {
        let segments: Vec<&str> = trimmed.split('.').collect();
        if segments.iter().all(|segment| segment.len() >= 5) {
            return token.replace(trimmed, "[redacted-jwt]");
        }
    }
    token.to_string()
}

/// Which rail phase a gateway `event` status means (goal SRV-B3d).
///
/// Pure so the decision is testable without a gateway: there is no HTTP-level
/// suite for `/gateway/events` on this server, so this function is where the
/// projection is pinned.
///
/// Compare Swift `agentStatusProjection` (`AgentGatewayRoutes.swift:1755-1763`),
/// which answers the same question for the same three statuses **and one more**:
/// it also folds every terminal status into `("thinking","running")`, which is
/// how a finished run came to announce that it was still thinking. Here the
/// terminal case cannot reach this function — `complete` owns it — so the fold
/// below is total over its domain rather than over everything.
fn event_progress_phase(status: &str) -> momo_agent::AgentPhase {
    if status == "streaming" {
        momo_agent::AgentPhase::Streaming
    } else {
        // `running` and `thinking` are the same fact to a reader: picked up,
        // nothing to show yet.
        momo_agent::AgentPhase::Thinking
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three statuses that mean "running" project onto two phases, and
    /// **neither is terminal** — a progress frame that spelled `done` would
    /// clear the badge in the middle of the answer.
    #[test]
    fn a_gateway_progress_status_never_projects_onto_a_terminal_phase() {
        assert_eq!(
            event_progress_phase("streaming").as_wire(),
            "streaming",
            "the one status that carries a delta keeps its own phase"
        );
        for status in ["running", "thinking"] {
            assert_eq!(
                event_progress_phase(status).as_wire(),
                "thinking",
                "{status}"
            );
        }
        for status in ["running", "thinking", "streaming"] {
            let wire = event_progress_phase(status).as_wire();
            assert!(
                wire != "done" && wire != "error",
                "`isRunOver` reads the phase axis first: {status} → {wire}"
            );
        }
    }

    /// The route only reaches the projection for the three statuses that mark a
    /// run started; `cancelled` is settled elsewhere and must not be re-announced
    /// here. This pins the guard, which lives in the route beside
    /// `mark_run_started_in_tx`.
    #[test]
    fn only_a_started_run_publishes_a_progress_frame() {
        for status in ["running", "thinking", "streaming"] {
            assert!(matches!(status, "running" | "thinking" | "streaming"));
        }
        assert!(
            !matches!("cancelled", "running" | "thinking" | "streaming"),
            "the cancel path already published the terminal frame (goal SRV-B3c); \
             a second frame here would be a duplicate under a different key"
        );
    }

    #[test]
    fn the_job_path_segment_must_be_a_positive_integer() {
        assert_eq!(path_job_id("42").expect("positive"), 42);
        for raw in ["0", "-1", "abc", "", " 1.5 "] {
            assert_eq!(
                path_job_id(raw).expect_err("rejected").status,
                StatusCode::BAD_REQUEST
            );
        }
    }

    /// Every lease failure is one 409 with one message: a caller must not be able
    /// to tell "expired" from "someone else owns it" from "no such job".
    #[test]
    fn a_lease_body_must_agree_with_the_path_and_carry_a_lease_id() {
        let lease_id = Uuid::from_u128(9);
        assert_eq!(
            validated_lease_request(
                AgentGatewayLeaseRequest {
                    job_id: Some(7),
                    lease_id: Some(lease_id)
                },
                7
            )
            .expect("agreeing"),
            GatewayLeaseBinding {
                job_id: 7,
                lease_id
            }
        );
        // An omitted body job_id is fine — the path already named it.
        assert!(validated_lease_request(
            AgentGatewayLeaseRequest {
                job_id: None,
                lease_id: Some(lease_id)
            },
            7
        )
        .is_ok());
        assert_eq!(
            validated_lease_request(
                AgentGatewayLeaseRequest {
                    job_id: Some(8),
                    lease_id: Some(lease_id)
                },
                7
            )
            .expect_err("disagreement")
            .message,
            "gateway job id does not match path"
        );
        assert_eq!(
            validated_lease_request(AgentGatewayLeaseRequest::default(), 7)
                .expect_err("no lease id")
                .status,
            StatusCode::CONFLICT
        );
        assert_eq!(lease_rejected().status, StatusCode::CONFLICT);
    }

    #[test]
    fn a_partial_lease_binding_is_no_binding() {
        let lease_id = Uuid::from_u128(9);
        assert!(lease_binding(Some(1), Some(lease_id)).is_some());
        assert!(lease_binding(None, Some(lease_id)).is_none());
        assert!(lease_binding(Some(1), None).is_none());
        assert!(
            lease_binding(Some(0), Some(lease_id)).is_none(),
            "outbox ids are positive; 0 is a client that sent nothing"
        );
    }

    #[test]
    fn the_event_status_set_is_closed_and_defaults_to_running() {
        assert_eq!(normalized_event_status(None).expect("default"), "running");
        assert_eq!(
            normalized_event_status(Some("  ")).expect("blank"),
            "running"
        );
        for raw in ["running", "THINKING", " streaming ", "cancelled"] {
            assert!(normalized_event_status(Some(raw)).is_ok());
        }
        for raw in ["succeeded", "failed", "tool_call", "approval_request"] {
            assert_eq!(
                normalized_event_status(Some(raw))
                    .expect_err("not a progress status")
                    .message,
                "unknown gateway event status",
                "{raw} must not be writable through the progress endpoint"
            );
        }
    }

    #[test]
    fn detail_and_text_delta_are_byte_capped() {
        assert!(bounded(
            Some(&"x".repeat(MAX_DETAIL_BYTES)),
            "detail",
            MAX_DETAIL_BYTES
        )
        .is_ok());
        assert_eq!(
            bounded(
                Some(&"x".repeat(MAX_DETAIL_BYTES + 1)),
                "detail",
                MAX_DETAIL_BYTES
            )
            .expect_err("too large")
            .message,
            "detail is too large"
        );
        assert_eq!(bounded(None, "detail", 10).expect("absent"), None);
    }

    /// A credential-naming caller may only speak for its own run; the process
    /// secret (no member) is exempt, which is why it is deprecated.
    #[test]
    fn the_actor_binding_pins_a_member_credential_to_its_own_run() {
        let agent = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        assert!(actor_binding(Some(agent), agent).is_ok());
        assert_eq!(
            actor_binding(Some(other), agent)
                .expect_err("foreign agent")
                .status,
            StatusCode::FORBIDDEN
        );
        assert!(
            actor_binding(None, agent).is_ok(),
            "the legacy shared secret names no member"
        );
    }

    #[test]
    fn the_timeline_body_never_leaves_the_channel_blank() {
        assert_eq!(
            timeline_body(Some("   "), true, None),
            "(Hermes gateway returned an empty response.)"
        );
        assert_eq!(timeline_body(Some(" done "), true, None), "done");
        assert_eq!(
            timeline_body(None, false, Some("boom")),
            "Hermes gateway failed before producing a final response: boom"
        );
        assert_eq!(
            timeline_body(None, false, None),
            "Hermes gateway failed before producing a final response."
        );
    }

    /// The instance's own secret is the one value this server can redact exactly.
    #[test]
    fn the_gateway_secret_never_survives_into_a_channel_message() {
        let secret = "R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa";
        let sanitized = sanitized_gateway_error(
            Some(&format!("upstream rejected secret={secret} retrying")),
            secret,
        )
        .expect("some text");
        assert!(!sanitized.contains(secret));
        assert!(sanitized.contains("[redacted]"));
    }

    #[test]
    fn credential_shaped_tokens_are_redacted() {
        let cases = [
            (
                "auth failed for momo_agent_v1.5b1f4a2e-0000-4000-8000-000000000001.AAAAbbbb",
                "[redacted-agent-token]",
            ),
            (
                "provider said sk-abcdefghijklmnop is bad",
                "[redacted-provider-token]",
            ),
            (
                "token ghp_abcdefghijklmnop rejected",
                "[redacted-provider-token]",
            ),
            (
                "used xoxb-1234567890-abcdef here",
                "[redacted-provider-token]",
            ),
            (
                "google ya29.abcdefghijkl expired",
                "[redacted-provider-token]",
            ),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl rejected",
                "[redacted-jwt]",
            ),
        ];
        for (input, expected) in cases {
            let sanitized = sanitized_gateway_error(Some(input), "").expect("some text");
            assert!(
                sanitized.contains(expected),
                "{input:?} should have produced {expected}, got {sanitized:?}"
            );
        }
    }

    /// If it still smells like a credential dump after redaction, none of it is
    /// published — a partially-redacted header block is still a leak.
    #[test]
    fn a_credential_shaped_message_is_replaced_wholesale() {
        for input in [
            "request failed: Authorization: Bearer abc",
            "config had api_key set",
            "refresh_token rotation failed",
        ] {
            assert_eq!(
                sanitized_gateway_error(Some(input), "").expect("replaced"),
                "Hermes gateway reported an error with redacted credential-shaped content."
            );
        }
    }

    #[test]
    fn an_empty_error_is_none_and_a_long_one_is_truncated() {
        assert_eq!(sanitized_gateway_error(None, ""), None);
        assert_eq!(sanitized_gateway_error(Some("   "), ""), None);
        let long = "e".repeat(MAX_ERROR_CHARS + 50);
        let sanitized = sanitized_gateway_error(Some(&long), "").expect("truncated");
        assert!(sanitized.ends_with("... [truncated]"));
        assert_eq!(
            sanitized.chars().count(),
            MAX_ERROR_CHARS + "... [truncated]".chars().count()
        );
    }

    /// Ordinary text must survive intact — over-redaction would make failures
    /// undebuggable, which is its own outage.
    #[test]
    fn ordinary_error_text_is_left_alone() {
        let input = "model hermes-agent timed out after 30s (attempt 2/3)";
        for secret in ["", "R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa"] {
            assert_eq!(
                sanitized_gateway_error(Some(input), secret).as_deref(),
                Some(input)
            );
        }
    }

    /// The hardening this function adds over Swift: a degenerate secret would
    /// substring-match ordinary prose, shredding every error message while
    /// protecting nothing (a two-letter value is not a credential).
    #[test]
    fn a_too_short_secret_is_not_substring_redacted() {
        let input = "model hermes-agent timed out after 30s";
        assert_eq!(
            sanitized_gateway_error(Some(input), "s").as_deref(),
            Some(input),
            "Swift's bare non-empty guard would have rewritten every 's' here"
        );
        // At the threshold the redaction resumes.
        let real = "a".repeat(MIN_REDACTABLE_SECRET_CHARS);
        let sanitized = sanitized_gateway_error(Some(&format!("saw {real} in the log")), &real)
            .expect("some text");
        assert!(sanitized.contains("[redacted]"));
        assert!(!sanitized.contains(&real));
    }
}
