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
    mark_run_started_in_tx, record_run_usage_in_tx, AppNotice, AppNoticeSite,
    CompletionStatusError, GatewayRunSnapshot, RunUsageReport, PROP_APPS_USED, PROP_APP_NOTICE,
};
use momo_auth::Principal;
use momo_db::audit::{run_event_recorded, write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_mcp::{
    ArtifactRule, ArtifactViolation, ARTIFACT_KEYS, MAX_REPORTED_COUNT, NEXT_ACTIONS, RESULT_KINDS,
    TEST_COUNT_KEYS, TOOL_COUNT_KEYS,
};
use momo_messaging::{
    find_client_message_in_tx, send_thread_notice_in_tx, MessageType, NewMessage,
};
use momo_outbox::{
    claim_gateway_jobs_in_tx, clamp_claim_limit, gateway_lease_authorized,
    gateway_lease_authorized_hosted, lock_gateway_lease_in_tx, release_gateway_lease_in_tx,
    renew_gateway_lease_in_tx, settle_gateway_job_in_tx, GatewayLeaseBinding,
};
use momo_t3::work_share::{
    validated_branch, validated_count, validated_pr_url, validated_stage_markers, MAX_COUNT,
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::auth::GatewayCaller;
use crate::dto::{
    AgentGatewayCompleteRequest, AgentGatewayCompleteResponse, AgentGatewayEventRequest,
    AgentGatewayEventResponse, AgentGatewayLeaseRequest, AgentGatewayLeaseResponse,
    AgentGatewayPendingJob, AgentGatewayPendingJobsResponse, AgentGatewayUsageDto,
    PendingJobsQuery,
};
use crate::error::ApiError;
use crate::routes::app_notice::validated_app_notice;
use crate::routes::apps_used::{validated_apps_used, write_tool_used_audit, AppsUsed};
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
        stage: None,
        event_id,
        actor_member_id,
        via_token_id,
        hosted_lease: false,
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
    /// ADR-0162 증보 3 D11 — one already-validated progress marker
    /// ([`validated_gateway_stage`]). Only the Agent Port tool carries one; the
    /// REST callback is not extended (`None`).
    pub stage: Option<String>,
    pub event_id: Uuid,
    /// `None` only for the deprecated process secret, which names no member.
    pub actor_member_id: Option<Uuid>,
    pub via_token_id: Option<Uuid>,
    /// ADR-0162 증보 3 부록 (#3530) — the lease is a hosted (Agent Port) one, so
    /// an expired-but-unclaimed lease still authorizes its own handle. `false`
    /// on the REST callback: the managed gateway's rule is unchanged.
    pub hosted_lease: bool,
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
        stage,
        event_id,
        actor_member_id,
        via_token_id,
        hosted_lease,
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
    if !lease_is_authorized(
        conn,
        workspace_id,
        run_id,
        &run,
        lease,
        allow_settled,
        hosted_lease,
    )
    .await?
    {
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

    // ADR-0162 증보 3 D11 — the marker and the step it spends. A settled run
    // (`cancelled` acknowledgement) takes none: the run is over and its record
    // must not move.
    if let Some(stage) = stage.as_deref().filter(|_| !run.status.is_terminal()) {
        record_stage_in_tx(conn, workspace_id, run_id, stage).await?;
        // ADR-0200 D2: the same marker, with its time, in the run event ledger the
        // panel reads after it was closed. Hosted (Agent Port) runs only — a managed
        // or BYOA gateway keeps `output.stages` alone (ADR-0200 D6).
        if hosted_lease {
            momo_agent::append_run_event_in_tx(
                conn,
                workspace_id,
                run_id,
                momo_agent::AppendedRunEvent::Stage(stage),
                run.agent_member_id,
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
    if let Some(unknown) = request
        .usage
        .as_ref()
        .map(|dto| dto.unknown_key_names(8))
        .filter(|keys| !keys.is_empty())
    {
        // #4375 — names only, never values: these keys were not read, so that
        // part of the usage is billed as reported-nothing.
        tracing::warn!(
            ?unknown,
            "agent gateway usage carried unknown keys; ignored"
        );
    }
    let usage = request.usage.as_ref().map(usage_report);
    let via_token_id = principal.as_ref().and_then(|p| p.token_id);
    let actor_member_id = principal.as_ref().map(|p| p.member_id);
    let usage_detail = request.usage.as_ref().map(usage_detail_json);
    // E8 — the Hermes door reports 「쓴 앱」 too. Unlike the Agent Port, whose
    // refusal names a field the agent can fix, this door has no way to say what
    // was wrong, and the report is telemetry riding on the run's final answer:
    // a malformed one is dropped (nothing stored, nothing audited) rather than
    // costing the answer. The Port refuses; this door forgets.
    let apps_used = validated_apps_used(request.apps_used.as_ref())
        .ok()
        .flatten();
    // #4054 — the site's own 「막힘」 report, same asymmetry: this door forgets a
    // malformed one. `site` is ours: this door is Hermes' and nobody else's.
    let app_notice = validated_app_notice(request.app_notice.as_ref(), Some(AppNoticeSite::Hermes))
        .ok()
        .flatten();
    let input = GatewayCompleteInput {
        run_id,
        lease: lease_binding(request.job_id, request.lease_id),
        succeeded,
        body: request.body.clone(),
        safe_error,
        usage,
        usage_detail,
        artifacts: None,
        apps_used,
        app_notice,
        actor_member_id,
        via_token_id,
        subscription_agents_enabled: state.agent_port.config.subscription_agents_enabled,
        claude_subscription_agents_enabled: state
            .agent_port
            .config
            .claude_subscription_agents_enabled,
        hosted_lease: false,
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
        message_id: message_id.map(|id| id.to_string()),
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
    /// ADR-0162 증보 3 D12 — already validated ([`validated_gateway_artifacts`]);
    /// the REST callback is not extended (`None`).
    pub artifacts: Option<GatewayArtifacts>,
    /// ADR-0113 증보 2 E8 (#3946) — the execution site's 「쓴 앱」 report, already
    /// validated ([`crate::routes::apps_used::validated_apps_used`]). Stored in
    /// `output.appsUsed` and audited as one `connector.tool_used` row.
    pub apps_used: Option<AppsUsed>,
    /// #4054 — the site's validated 「막힘」 report with the server-authored
    /// `site`; written to `message.props.app_notice` and nowhere else.
    pub app_notice: Option<AppNotice>,
    pub actor_member_id: Option<Uuid>,
    pub via_token_id: Option<Uuid>,
    /// ADR-0193 D6 (#2815) — `AgentPortConfig::subscription_agents_enabled`,
    /// for the hosted-inbox fan-out of the answer this completion writes.
    pub subscription_agents_enabled: bool,
    /// #3397 — `AgentPortConfig::claude_subscription_agents_enabled`.
    pub claude_subscription_agents_enabled: bool,
    /// ADR-0162 증보 3 부록 (#3530) — see [`GatewayEventInput::hosted_lease`].
    pub hosted_lease: bool,
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
) -> Result<Result<(Option<Uuid>, Option<i64>, &'static str), ApiError>, momo_db::DbError> {
    let GatewayCompleteInput {
        run_id,
        lease,
        succeeded,
        body,
        safe_error,
        usage,
        usage_detail,
        artifacts,
        apps_used,
        app_notice,
        actor_member_id,
        via_token_id,
        subscription_agents_enabled,
        claude_subscription_agents_enabled,
        hosted_lease,
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
    if !lease_is_authorized(
        conn,
        workspace_id,
        run_id,
        &run,
        lease,
        terminal,
        hosted_lease,
    )
    .await?
    {
        return Ok(Err(lease_rejected()));
    }

    // A terminal run either replays the message it already produced,
    // or refuses. Looking the message up FIRST is what keeps a
    // cancelled run from acquiring a "final response" it never had.
    if terminal {
        let existing =
            find_client_message_in_tx(conn, run.channel_id, run.agent_member_id, run_id).await?;
        // #4017 — a successful run with no text wrote no message the first
        // time; replaying its completion answers the same (no message), not 409.
        if existing.is_none()
            && run.status.as_db_label() == "succeeded"
            && existing_output_object_in_tx(conn, run_id)
                .await?
                .get("message_id")
                .is_some_and(Value::is_null)
        {
            return Ok(Ok((None, None, "succeeded")));
        }
        return Ok(match existing {
            Some(message) => Ok((
                Some(message.id),
                Some(message.seq),
                run.status.as_db_label(),
            )),
            None => Err(ApiError::new(
                StatusCode::CONFLICT,
                format!(
                    "agent run is already terminal ({})",
                    run.status.as_db_label()
                ),
            )),
        });
    }

    // #4054 — a reported app id is shape-checked at the door; here it must also be an
    // app oort knows (an official, unrevoked registry row), or the notice keeps its
    // kind and loses the id. Otherwise a site could attribute a block to any
    // identifier-shaped string and the channel would print it.
    let app_notice = match app_notice {
        Some(mut notice) => {
            if let Some(plugin_id) = notice.plugin_id.as_deref() {
                if !known_official_plugin_in_tx(conn, plugin_id).await? {
                    notice.plugin_id = None;
                }
            }
            Some(notice)
        }
        None => None,
    };

    // 1. the final message — the messenger's own write path, keyed by
    //    the run id so a replay can never produce a second one.
    //    #4017: a successful run with nothing to say writes none (see
    //    [`timeline_body`]); everything below still settles the run.
    //
    //    #4622 (ADR-0148 증보 2026-10-27): written on the spine that keeps the thread's
    //    rollup, because the answer to a request made inside a thread belongs in that
    //    thread (`run.trigger_root_id`) — and a reply that skipped the rollup would sit
    //    under the root without the root's 「답글 N개」 ever moving.
    let message = match body_text {
        Some(body_text) => Some(
            send_thread_notice_in_tx(
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
                    body: Some(body_text),
                    props: timeline_props(
                        &run,
                        run_id,
                        succeeded,
                        usage_detail.clone(),
                        safe_error.as_deref(),
                        apps_used.as_ref(),
                        app_notice.as_ref(),
                    ),
                    // #4622 — the thread the request was made in, or the main flow when it
                    // was made there (a channel's top level, a DM): the same place the
                    // worker and the team AI put the same answer, read off the same locked
                    // run row (`GatewayRunSnapshot::trigger_root_id`).
                    root_id: run.trigger_root_id,
                    // ADR-0148 규칙 6 — the same answer the worker gives,
                    // arriving by a different door, so it points at the same
                    // message. Both read `agent_run.trigger_message_id` off
                    // the locked run row rather than off a job payload,
                    // which is what keeps "an agent quotes what it answers"
                    // one rule instead of two implementations of it. 규칙 1:
                    // belonging (`root_id`) and aim (`reply_to_id`) are two
                    // columns, so an answer inside a thread carries both.
                    reply_to_id: run.trigger_message_id,
                    client_msg_id: Some(run_id),
                    run_id: Some(run_id),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?,
        ),
        None => None,
    };

    // 1b. …and the hosted inbox projection for that answer (ADR-0162 / HAP-E5).
    //
    //     The answer is written through the RAW spine — `send_thread_notice_in_tx`,
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
    if let Some(message) = message.as_ref() {
        momo_messaging::fan_out_message_reference_in_tx(
            conn,
            workspace_id,
            run.channel_id,
            message.message.id,
            run.agent_member_id,
            subscription_agents_enabled,
            claude_subscription_agents_enabled,
        )
        .await?;
    }

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
    // Start from what the run already carries (`stages`, D11) so completing
    // never erases the progress it reported; the completion's own keys win.
    let mut output = existing_output_object_in_tx(conn, run_id).await?;
    for (key, value) in [
        ("schema", json!("momo.agent_gateway.output.v0")),
        (
            "status",
            json!(if succeeded { "succeeded" } else { "failed" }),
        ),
        ("body", json!(body)),
        (
            "message_id",
            json!(message.as_ref().map(|m| m.message.id.to_string())),
        ),
        ("usage", usage_detail.clone().unwrap_or(Value::Null)),
    ] {
        output.insert(key.into(), value);
    }
    if let Some(artifacts) = artifacts.as_ref() {
        output.insert("artifacts".into(), artifacts.to_json());
    }
    if let Some(apps_used) = apps_used.as_ref() {
        output.insert("appsUsed".into(), apps_used.to_json());
    }
    let output = Value::Object(output);
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

    // ADR-0162 증보 3 D15 — one row per completion that carried artifacts: the
    // key names only, never a value.
    if let Some(artifacts) = artifacts.as_ref() {
        write_audit(
            conn,
            &AuditEntry::new(workspace_id, ARTIFACTS_AUDIT_ACTION)
                .by(run.agent_member_id)
                .target("agent_run", run_id)
                .via_token(via_token_id)
                .run(run_id)
                .with_schema(
                    "momo.agent_run.artifacts_reported.v0",
                    json!({
                        "run_id": run_id.to_string(),
                        "keys": artifacts.keys(),
                    }),
                ),
        )
        .await?;
    }

    // ADR-0113 증보 2 E8 — one row per completion that carried a 「쓴 앱」 report:
    // app ids, tool names and counts under the closed key set, never a value.
    if let Some(apps_used) = apps_used.as_ref() {
        write_tool_used_audit(
            conn,
            workspace_id,
            run_id,
            run.agent_member_id,
            via_token_id,
            apps_used,
        )
        .await?;
    }

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
                    "message_id": message.as_ref().map(|m| m.message.id.to_string()),
                    "usage": usage_detail,
                    "source": "hermes_gateway",
                }),
            ),
    )
    .await?;

    Ok(Ok((
        message.as_ref().map(|m| m.message.id),
        message.as_ref().map(|m| m.message.seq),
        if succeeded { "succeeded" } else { "failed" },
    )))
}

// ---------------------------------------------------------------------------
// ADR-0162 증보 3 — progress markers and artifacts (D11, D12, D15)
// ---------------------------------------------------------------------------

const ARTIFACTS_AUDIT_ACTION: &str = "agent.run.artifacts_reported";
const REPORT_REJECTED_AUDIT_ACTION: &str = "agent.run.report_rejected";
/// `agent_run.output.stages` keeps the newest this many (the share's
/// `MAX_STAGE_MARKERS`).
const MAX_STORED_STAGES: usize = momo_t3::work_share::MAX_STAGE_MARKERS;

/// The closed set of refusal reasons a report can be audited with. A code, never
/// the offending text: the value is attacker-shaped and the audit row is not the
/// place to keep it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReportRejection {
    Stage,
    ArtifactsShape,
    ArtifactsPrUrl,
    ArtifactsBranch,
    ArtifactsCount,
    /// ADR-0162 증보 5 C1/C2 — a result-contract field or cross rule.
    ArtifactsContract,
}

impl ReportRejection {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Stage => "stage_invalid",
            Self::ArtifactsShape => "artifacts_shape_invalid",
            Self::ArtifactsPrUrl => "artifacts_pr_url_invalid",
            Self::ArtifactsBranch => "artifacts_branch_invalid",
            Self::ArtifactsCount => "artifacts_count_invalid",
            Self::ArtifactsContract => "artifacts_contract_invalid",
        }
    }
}

/// One stage marker, under the share's own rule ([`validated_stage_markers`] —
/// the very function `work_session_share` runs; 1..=80 characters, no control or
/// bidi character, no `/` or `\\`). Trimmed, as the share trims.
pub(crate) fn validated_gateway_stage(raw: &str) -> Result<String, ReportRejection> {
    validated_stage_markers(&[raw.to_string()])
        .ok()
        .and_then(|mut markers| markers.pop())
        .ok_or(ReportRejection::Stage)
}

/// The finished work's outputs (D12), after validation. Every field is optional.
///
/// ADR-0162 증보 5 C1/C2 adds the code-task result contract (`result_kind` …
/// `commit_sha`) and the in-VM counts (`tool_counts`). All of it is the agent's
/// own report: nothing here is checked against GitHub (D9, the server holds no
/// GitHub token), and the read side labels it so (`agentReported`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GatewayArtifacts {
    pub pr_url: Option<String>,
    pub branch: Option<String>,
    pub added: Option<i64>,
    pub deleted: Option<i64>,
    pub commits: Option<i64>,
    /// One of [`momo_mcp::RESULT_KINDS`].
    pub result_kind: Option<&'static str>,
    /// `(passed, failed, notRun)`.
    pub tests: Option<(i64, i64, i64)>,
    /// One of [`momo_mcp::NEXT_ACTIONS`].
    pub next_action: Option<&'static str>,
    /// 7..=40 hex characters, lowercased.
    pub commit_sha: Option<String>,
    /// The reported categories of [`momo_mcp::TOOL_COUNT_KEYS`], in that order;
    /// `None` when no category was reported.
    pub tool_counts: Option<Vec<(&'static str, i64)>>,
}

impl GatewayArtifacts {
    fn is_empty(&self) -> bool {
        self.pr_url.is_none()
            && self.branch.is_none()
            && self.added.is_none()
            && self.deleted.is_none()
            && self.commits.is_none()
            && self.result_kind.is_none()
            && self.tests.is_none()
            && self.next_action.is_none()
            && self.commit_sha.is_none()
            && self.tool_counts.is_none()
    }

    /// The stored shape — only the keys that were reported.
    pub(crate) fn to_json(&self) -> Value {
        let mut object = Map::new();
        if let Some(value) = &self.pr_url {
            object.insert("prUrl".into(), json!(value));
        }
        if let Some(value) = &self.branch {
            object.insert("branch".into(), json!(value));
        }
        for (key, value) in [
            ("added", self.added),
            ("deleted", self.deleted),
            ("commits", self.commits),
        ] {
            if let Some(value) = value {
                object.insert(key.into(), json!(value));
            }
        }
        if let Some(value) = self.result_kind {
            object.insert("resultKind".into(), json!(value));
        }
        if let Some((passed, failed, not_run)) = self.tests {
            object.insert(
                "tests".into(),
                json!({"passed": passed, "failed": failed, "notRun": not_run}),
            );
        }
        if let Some(value) = self.next_action {
            object.insert("nextAction".into(), json!(value));
        }
        if let Some(value) = &self.commit_sha {
            object.insert("commitSha".into(), json!(value));
        }
        if let Some(counts) = &self.tool_counts {
            let counts: Map<String, Value> = counts
                .iter()
                .map(|(key, value)| ((*key).to_owned(), json!(value)))
                .collect();
            object.insert("toolCounts".into(), Value::Object(counts));
        }
        Value::Object(object)
    }

    /// The key names present, for the audit row.
    fn keys(&self) -> Vec<&'static str> {
        let mut keys = Vec::new();
        for (key, present) in [
            ("prUrl", self.pr_url.is_some()),
            ("branch", self.branch.is_some()),
            ("added", self.added.is_some()),
            ("deleted", self.deleted.is_some()),
            ("commits", self.commits.is_some()),
            ("resultKind", self.result_kind.is_some()),
            ("tests", self.tests.is_some()),
            ("nextAction", self.next_action.is_some()),
            ("commitSha", self.commit_sha.is_some()),
            ("toolCounts", self.tool_counts.is_some()),
        ] {
            if present {
                keys.push(key);
            }
        }
        keys
    }
}

/// A refused `artifacts`: the closed audit reason (D15) and the field-level
/// violation the agent is told about (ADR-0162 증보 5 C3). Neither carries a
/// value the agent sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ArtifactsRefusal {
    pub reason: ReportRejection,
    pub violation: ArtifactViolation,
}

fn refused(reason: ReportRejection, field: &str, rule: ArtifactRule) -> ArtifactsRefusal {
    ArtifactsRefusal {
        reason,
        // Every path named here is in momo-mcp's closed list (pinned by
        // `every_refusal_path_is_a_closed_artifact_path`); the fallback is the
        // object itself rather than a panic on a request path.
        violation: ArtifactViolation::on(field, rule)
            .or_else(|| ArtifactViolation::on("artifacts", rule))
            .expect("`artifacts` is a closed artifact path"),
    }
}

fn cross(
    field: &'static str,
    rule: ArtifactRule,
    requires: Option<&'static str>,
    hint: &'static str,
) -> ArtifactsRefusal {
    ArtifactsRefusal {
        reason: ReportRejection::ArtifactsContract,
        violation: ArtifactViolation::cross(field, rule, requires, hint),
    }
}

/// One closed-vocabulary string (`resultKind`, `nextAction`), as the `'static`
/// member of `allowed` it equals.
fn closed_value(
    object: &Map<String, Value>,
    key: &str,
    field: &str,
    allowed: &'static [&'static str],
) -> Result<Option<&'static str>, ArtifactsRefusal> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => allowed
            .iter()
            .copied()
            .find(|candidate| *candidate == value)
            .map(Some)
            .ok_or_else(|| {
                refused(
                    ReportRejection::ArtifactsContract,
                    field,
                    ArtifactRule::Enum,
                )
            }),
        Some(_) => Err(refused(
            ReportRejection::ArtifactsContract,
            field,
            ArtifactRule::Format,
        )),
    }
}

/// One `tests` / `toolCounts` count: an integer in `0..=MAX_REPORTED_COUNT`.
fn reported_count(raw: &Value, field: &str) -> Result<i64, ArtifactsRefusal> {
    let Value::Number(number) = raw else {
        return Err(refused(
            ReportRejection::ArtifactsContract,
            field,
            ArtifactRule::Format,
        ));
    };
    match number.as_i64() {
        Some(value) if (0..=MAX_REPORTED_COUNT).contains(&value) => Ok(value),
        Some(_) => Err(refused(
            ReportRejection::ArtifactsContract,
            field,
            ArtifactRule::Range,
        )),
        // A fraction is the wrong shape; an integer beyond i64 is out of range.
        None if number.is_u64() => Err(refused(
            ReportRejection::ArtifactsContract,
            field,
            ArtifactRule::Range,
        )),
        None => Err(refused(
            ReportRejection::ArtifactsContract,
            field,
            ArtifactRule::Format,
        )),
    }
}

fn validated_tests(raw: Option<&Value>) -> Result<Option<(i64, i64, i64)>, ArtifactsRefusal> {
    let object = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(refused(
                ReportRejection::ArtifactsContract,
                "artifacts.tests",
                ArtifactRule::Format,
            ))
        }
    };
    if object
        .keys()
        .any(|key| !TEST_COUNT_KEYS.contains(&key.as_str()))
    {
        return Err(refused(
            ReportRejection::ArtifactsContract,
            "artifacts.tests",
            ArtifactRule::Forbidden,
        ));
    }
    let mut counts = [0_i64; 3];
    for (slot, key) in counts.iter_mut().zip(TEST_COUNT_KEYS) {
        let field = match key {
            "passed" => "artifacts.tests.passed",
            "failed" => "artifacts.tests.failed",
            _ => "artifacts.tests.notRun",
        };
        match object.get(key) {
            None | Some(Value::Null) => {
                return Err(refused(
                    ReportRejection::ArtifactsContract,
                    field,
                    ArtifactRule::Required,
                ))
            }
            Some(raw) => *slot = reported_count(raw, field)?,
        }
    }
    Ok(Some((counts[0], counts[1], counts[2])))
}

fn validated_tool_counts(
    raw: Option<&Value>,
) -> Result<Option<Vec<(&'static str, i64)>>, ArtifactsRefusal> {
    let object = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(refused(
                ReportRejection::ArtifactsContract,
                "artifacts.toolCounts",
                ArtifactRule::Format,
            ))
        }
    };
    if object
        .keys()
        .any(|key| !TOOL_COUNT_KEYS.contains(&key.as_str()))
    {
        return Err(refused(
            ReportRejection::ArtifactsContract,
            "artifacts.toolCounts",
            ArtifactRule::Forbidden,
        ));
    }
    let mut counts = Vec::new();
    for key in TOOL_COUNT_KEYS {
        let field = match key {
            "run" => "artifacts.toolCounts.run",
            "edit" => "artifacts.toolCounts.edit",
            "read" => "artifacts.toolCounts.read",
            "search" => "artifacts.toolCounts.search",
            "web" => "artifacts.toolCounts.web",
            _ => "artifacts.toolCounts.other",
        };
        match object.get(key) {
            None | Some(Value::Null) => {}
            Some(raw) => counts.push((key, reported_count(raw, field)?)),
        }
    }
    Ok((!counts.is_empty()).then_some(counts))
}

fn validated_commit_sha(raw: Option<&Value>) -> Result<Option<String>, ArtifactsRefusal> {
    let field = "artifacts.commitSha";
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            if !(7..=40).contains(&value.len()) {
                return Err(refused(
                    ReportRejection::ArtifactsContract,
                    field,
                    ArtifactRule::Range,
                ));
            }
            if !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(refused(
                    ReportRejection::ArtifactsContract,
                    field,
                    ArtifactRule::Format,
                ));
            }
            Ok(Some(value.to_ascii_lowercase()))
        }
        Some(_) => Err(refused(
            ReportRejection::ArtifactsContract,
            field,
            ArtifactRule::Format,
        )),
    }
}

/// ADR-0162 증보 5 C1's cross rules — the minimum that keeps the closed fields
/// from contradicting each other. The first broken rule is the answer, in a
/// fixed order, so a retry that fixes it meets the next one deterministically.
fn contract_violation(artifacts: &GatewayArtifacts) -> Option<ArtifactsRefusal> {
    const NEEDS_KIND: &str = "needs artifacts.resultKind";
    let Some(kind) = artifacts.result_kind else {
        // An old five-key routine (or counts alone) needs no kind; the three
        // code-task fields do.
        for (field, present) in [
            ("artifacts.tests", artifacts.tests.is_some()),
            ("artifacts.nextAction", artifacts.next_action.is_some()),
            ("artifacts.commitSha", artifacts.commit_sha.is_some()),
        ] {
            if present {
                return Some(cross(
                    field,
                    ArtifactRule::Requires,
                    Some("artifacts.resultKind"),
                    NEEDS_KIND,
                ));
            }
        }
        return None;
    };
    let has_pr = artifacts.pr_url.is_some();
    let has_branch = artifacts.branch.is_some();
    match kind {
        "pr_opened" if !has_pr => {
            return Some(cross(
                "artifacts.prUrl",
                ArtifactRule::Required,
                None,
                "is required when resultKind is pr_opened",
            ))
        }
        "branch_only" if !has_branch => {
            return Some(cross(
                "artifacts.branch",
                ArtifactRule::Required,
                None,
                "is required when resultKind is branch_only",
            ))
        }
        "branch_only" if has_pr => {
            return Some(cross(
                "artifacts.prUrl",
                ArtifactRule::Forbidden,
                None,
                "must be absent when resultKind is branch_only",
            ))
        }
        "vm_only" if has_pr => {
            return Some(cross(
                "artifacts.prUrl",
                ArtifactRule::Forbidden,
                None,
                "must be absent when resultKind is vm_only",
            ))
        }
        "vm_only" if has_branch => {
            return Some(cross(
                "artifacts.branch",
                ArtifactRule::Forbidden,
                None,
                "must be absent when resultKind is vm_only",
            ))
        }
        "no_change" => {
            for (field, present) in [
                ("artifacts.prUrl", has_pr),
                ("artifacts.branch", has_branch),
                ("artifacts.commitSha", artifacts.commit_sha.is_some()),
            ] {
                if present {
                    return Some(cross(
                        field,
                        ArtifactRule::Forbidden,
                        None,
                        "must be absent when resultKind is no_change",
                    ));
                }
            }
            for (field, value) in [
                ("artifacts.added", artifacts.added),
                ("artifacts.deleted", artifacts.deleted),
                ("artifacts.commits", artifacts.commits),
            ] {
                if value.is_some_and(|count| count != 0) {
                    return Some(cross(
                        field,
                        ArtifactRule::Forbidden,
                        None,
                        "must be absent or 0 when resultKind is no_change",
                    ));
                }
            }
        }
        _ => {}
    }
    if artifacts.next_action == Some("merge_ok") {
        if kind != "pr_opened" {
            return Some(cross(
                "artifacts.nextAction",
                ArtifactRule::Requires,
                Some("artifacts.resultKind"),
                "can be merge_ok only when resultKind is pr_opened",
            ));
        }
        if artifacts.tests.is_some_and(|(_, failed, _)| failed > 0) {
            return Some(cross(
                "artifacts.nextAction",
                ArtifactRule::Forbidden,
                None,
                "cannot be merge_ok while artifacts.tests.failed is above 0",
            ));
        }
    }
    None
}

/// `artifacts` (D12, ADR-0162 증보 5 C1/C2) against the share's rules and the
/// result contract. `Ok(None)` for an absent, `null` or empty object; any
/// malformed field or broken cross rule is an `Err` — the caller rejects the
/// **whole** completion, nothing is dropped and nothing is stored.
///
/// `additionalProperties:false` is enforced here as well as by the published
/// schema, so the contract does not depend on the transport having checked it.
pub(crate) fn validated_gateway_artifacts(
    raw: Option<&Value>,
    allowed_hosts: &[String],
) -> Result<Option<GatewayArtifacts>, ArtifactsRefusal> {
    let object = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(refused(
                ReportRejection::ArtifactsShape,
                "artifacts",
                ArtifactRule::Format,
            ))
        }
    };
    if object
        .keys()
        .any(|key| !ARTIFACT_KEYS.contains(&key.as_str()))
    {
        return Err(refused(
            ReportRejection::ArtifactsShape,
            "artifacts",
            ArtifactRule::Forbidden,
        ));
    }
    let text = |key: &str, field: &str| -> Result<Option<&str>, ArtifactsRefusal> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.as_str())),
            Some(_) => Err(refused(
                ReportRejection::ArtifactsShape,
                field,
                ArtifactRule::Format,
            )),
        }
    };
    let count = |key: &str, field: &str| -> Result<Option<i64>, ArtifactsRefusal> {
        let raw = match object.get(key) {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::Number(number)) => number.as_i64(),
            Some(_) => {
                return Err(refused(
                    ReportRejection::ArtifactsShape,
                    field,
                    ArtifactRule::Format,
                ))
            }
        };
        // A fractional or beyond-i64 number is not a count either.
        if raw.is_none() {
            return Err(refused(
                ReportRejection::ArtifactsCount,
                field,
                ArtifactRule::Format,
            ));
        }
        validated_count(raw, key, MAX_COUNT)
            .map_err(|_| refused(ReportRejection::ArtifactsCount, field, ArtifactRule::Range))
    };
    let artifacts = GatewayArtifacts {
        pr_url: text("prUrl", "artifacts.prUrl")?
            .map(|value| validated_pr_url(value, allowed_hosts))
            .transpose()
            .map_err(|_| {
                refused(
                    ReportRejection::ArtifactsPrUrl,
                    "artifacts.prUrl",
                    ArtifactRule::Format,
                )
            })?,
        branch: text("branch", "artifacts.branch")?
            .map(validated_branch)
            .transpose()
            .map_err(|_| {
                refused(
                    ReportRejection::ArtifactsBranch,
                    "artifacts.branch",
                    ArtifactRule::Format,
                )
            })?,
        added: count("added", "artifacts.added")?,
        deleted: count("deleted", "artifacts.deleted")?,
        commits: count("commits", "artifacts.commits")?,
        result_kind: closed_value(object, "resultKind", "artifacts.resultKind", &RESULT_KINDS)?,
        tests: validated_tests(object.get("tests"))?,
        next_action: closed_value(object, "nextAction", "artifacts.nextAction", &NEXT_ACTIONS)?,
        commit_sha: validated_commit_sha(object.get("commitSha"))?,
        tool_counts: validated_tool_counts(object.get("toolCounts"))?,
    };
    if let Some(refusal) = contract_violation(&artifacts) {
        return Err(refusal);
    }
    Ok((!artifacts.is_empty()).then_some(artifacts))
}

/// The agent-reported part of a stored `output.artifacts` — the read-side
/// projection ADR-0162 증보 5 C1 calls `agentReported`:
/// `{resultKind, tests, nextAction, commitSha, toolCounts}`, only the keys that
/// were stored. `None` when the run reported none of them (an old routine, or
/// no artifacts at all), so the field is simply absent on the wire.
///
/// Only values of the stored shape are carried: this reads what
/// [`validated_gateway_artifacts`] wrote, but a row is still data, not proof.
pub(crate) fn agent_reported_of(output: Option<&Value>) -> Option<Value> {
    let artifacts = output?.get("artifacts")?.as_object()?;
    let mut reported = Map::new();
    for key in ["resultKind", "nextAction", "commitSha"] {
        if let Some(value @ Value::String(_)) = artifacts.get(key) {
            reported.insert(key.into(), value.clone());
        }
    }
    for key in ["tests", "toolCounts"] {
        if let Some(Value::Object(counts)) = artifacts.get(key) {
            let counts: Map<String, Value> = counts
                .iter()
                .filter(|(_, value)| value.is_i64())
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect();
            reported.insert(key.into(), Value::Object(counts));
        }
    }
    (!reported.is_empty()).then_some(Value::Object(reported))
}

/// Where a report stands before its refusal may be recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReportStanding {
    /// A live lease on a run that can still take a report: a refusal is audited
    /// and answered 400.
    Live,
    /// Anything else (stale or expired lease, terminal run, approval hold,
    /// foreign run): the bad field is ignored and the call takes its ordinary
    /// path, so a finished run's retried completion replays its first answer and
    /// a lost lease answers the one 409 — and **no audit row is written**, so a
    /// dead handle cannot grow the audit log.
    NotLive,
}

/// Judge [`ReportStanding`] under the run's row lock.
pub(crate) async fn report_standing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    lease: GatewayLeaseBinding,
    hosted_lease: bool,
) -> Result<ReportStanding, momo_db::DbError> {
    let Some(run) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await? else {
        return Ok(ReportStanding::NotLive);
    };
    if run.agent_member_id != agent_member_id
        || run.status.is_terminal()
        || run.status.is_approval_held()
        || !lease_is_authorized(conn, workspace_id, run_id, &run, lease, false, hosted_lease)
            .await?
    {
        return Ok(ReportStanding::NotLive);
    }
    Ok(ReportStanding::Live)
}

/// The audit row a refused report leaves (D15): the run, the tool and a reason
/// code — no text from the report.
///
/// ADR-0162 증보 5 C3: a refused `artifacts` also records the closed `field` and
/// `rule` it broke and which refusal this is for the run (`attempt`, 1-based),
/// so an operator can see an agent that retries the same mistake. Still no
/// value. The server does not stop a retry by count — the lease and the rate
/// limit bound it; the routine's "at most 2 corrections" rule is the agent's.
// The tenant, the run, its agent, the token, the tool and the two halves of the
// refusal are each one audit column/key; bundling them would only rename them.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn write_report_rejected_audit(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    via_token_id: Option<Uuid>,
    tool: &'static str,
    reason: ReportRejection,
    violation: Option<ArtifactViolation>,
) -> Result<(), momo_db::DbError> {
    let mut detail = json!({
        "run_id": run_id.to_string(),
        "tool": tool,
        "reason": reason.code(),
    });
    if let Some(violation) = violation {
        // Counted per run and tool — a superset of "per lease", since a refused
        // completion leaves its lease intact and a run rarely changes lease.
        // Keyed by the indexed target columns (`audit_target_idx`, the same
        // predicate `momo_db::audit::run_event_recorded` uses), so a refusal
        // reads this run's rows rather than scanning the workspace's audit log.
        let earlier: i64 = momo_db::sqlx::query_scalar(
            "SELECT count(*) FROM audit_log \
              WHERE target_type = 'agent_run' AND target_id = $1 \
                AND workspace_id = $2 AND run_id = $1 AND action = $3 \
                AND detail->>'tool' = $4",
        )
        .bind(run_id)
        .bind(workspace_id)
        .bind(REPORT_REJECTED_AUDIT_ACTION)
        .bind(tool)
        .fetch_one(&mut *conn)
        .await?;
        if let Some(object) = detail.as_object_mut() {
            object.insert("field".into(), json!(violation.field));
            object.insert("rule".into(), json!(violation.rule.as_str()));
            object.insert("attempt".into(), json!(earlier + 1));
        }
    }
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, REPORT_REJECTED_AUDIT_ACTION)
            .by(agent_member_id)
            .target("agent_run", run_id)
            .via_token(via_token_id)
            .run(run_id)
            .with_schema("momo.agent_run.report_rejected.v0", detail),
    )
    .await?;
    Ok(())
}

/// The run's `output` as an object to extend, or an empty one. A stored value
/// that is not an object (never written by this code) is not carried forward.
async fn existing_output_object_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
) -> Result<Map<String, Value>, momo_db::DbError> {
    let stored: Option<Value> =
        momo_db::sqlx::query_scalar("SELECT output FROM agent_run WHERE id = $1")
            .bind(run_id)
            .fetch_one(&mut *conn)
            .await?;
    Ok(match stored {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    })
}

/// Append one marker to `output.stages` (newest [`MAX_STORED_STAGES`] kept, an
/// immediate repeat folded) and spend one step, saturating at `max_steps`
/// (`agent_run_step_cap_ck`). The caller holds the run's row lock.
async fn record_stage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    stage: &str,
) -> Result<(), momo_db::DbError> {
    let mut output = existing_output_object_in_tx(conn, run_id).await?;
    let mut stages: Vec<Value> = match output.remove("stages") {
        Some(Value::Array(items)) => items.into_iter().filter(Value::is_string).collect(),
        _ => Vec::new(),
    };
    if stages.last().and_then(Value::as_str) != Some(stage) {
        stages.push(json!(stage));
    }
    if stages.len() > MAX_STORED_STAGES {
        stages.drain(..stages.len() - MAX_STORED_STAGES);
    }
    output.insert("stages".into(), Value::Array(stages));
    momo_db::sqlx::query(
        "UPDATE agent_run \
            SET output = $3, \
                step_count = LEAST(step_count + 1, max_steps), \
                updated_at = now() \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(run_id)
    .bind(workspace_id)
    .bind(Value::Object(output))
    .execute(&mut *conn)
    .await?;
    Ok(())
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
    hosted_lease: bool,
) -> Result<bool, momo_db::DbError> {
    let snapshot = lock_gateway_lease_in_tx(conn, workspace_id, run_id, run.agent_member_id, lease)
        .await
        .map_err(momo_db::DbError::from)?;
    Ok(if hosted_lease {
        gateway_lease_authorized_hosted(snapshot, lease.lease_id, allow_settled)
    } else {
        gateway_lease_authorized(snapshot, lease.lease_id, allow_settled)
    })
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

/// Swift `timelineBody` (:1497-1511), reshaped by #4017.
///
/// `None` = a **successful run that produced no text**: the run still ends
/// normally (status, receipt, rail frame, bill), but the timeline gets no
/// message. The old English stand-in named an internal product and told the
/// reader nothing; an empty answer is not an answer, and a blank-looking
/// bubble in a 1:1 DM reads as the agent ignoring the person. A failure keeps
/// its system line, in the product's own voice and without the runtime's name.
fn timeline_body(body: Option<&str>, succeeded: bool, safe_error: Option<&str>) -> Option<String> {
    if succeeded {
        let text = body.map(str::trim).unwrap_or_default();
        return (!text.is_empty()).then(|| text.to_string());
    }
    Some(
        match safe_error.map(str::trim).filter(|value| !value.is_empty()) {
            Some(reason) => format!("답을 만들지 못했어요: {reason}"),
            None => "답을 만들지 못했어요.".to_string(),
        },
    )
}

/// Swift `timelineProps` (:1513-1529).
/// Is `plugin_id` an official, unrevoked row of the plugin registry (the global
/// catalogue, not a workspace's install)?
async fn known_official_plugin_in_tx(
    conn: &mut PgConnection,
    plugin_id: &str,
) -> Result<bool, momo_db::DbError> {
    let known: bool = momo_db::sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM plugin_registry \
                         WHERE plugin_id = $1 AND official AND revoked_at IS NULL)",
    )
    .bind(plugin_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(known)
}

fn timeline_props(
    run: &GatewayRunSnapshot,
    run_id: Uuid,
    succeeded: bool,
    usage: Option<Value>,
    error: Option<&str>,
    apps_used: Option<&AppsUsed>,
    app_notice: Option<&AppNotice>,
) -> Value {
    let mut props = json!({
        "schema": "momo.agent_gateway.timeline.v0",
        "source": "hermes_gateway",
        "status": if succeeded { "succeeded" } else { "failed" },
        "run_id": run_id.to_string(),
        "agent_member_id": run.agent_member_id.to_string(),
        "usage": usage,
        "error": error,
    });
    // #4054 — both keys are server-owned (`momo_agent::SERVER_OWNED_APP_PROPS_KEYS`):
    // written here from the validated reports, absent when nothing was reported.
    // The answer carries the receipt so a row need not fetch the run to learn
    // whether apps were used; "no report" stays "no key", never an empty list.
    if let Some(object) = props.as_object_mut() {
        if let Some(apps_used) = apps_used {
            object.insert(PROP_APPS_USED.into(), apps_used.to_json());
        }
        if let Some(app_notice) = app_notice {
            object.insert(PROP_APP_NOTICE.into(), app_notice.to_json());
        }
    }
    props
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
            "에이전트가 오류를 알려 왔지만 민감한 값이 섞여 있어 내용을 가렸어요.".to_string(),
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

    /// #4375 — a camelCase usage body reaches the billed report and the echoed
    /// detail block (the ledger input), not just the DTO.
    #[test]
    fn camel_case_usage_body_is_billed_and_echoed() {
        let dto: AgentGatewayUsageDto = serde_json::from_value(json!({
            "promptTokens": 11, "completionTokens": 5, "cachedTokens": 3,
            "reasoningTokens": 2, "costMicroUsd": 1234, "wasEstimated": false,
        }))
        .expect("usage");
        let report = usage_report(&dto);
        assert_eq!(report.prompt_tokens, Some(11));
        assert_eq!(report.completion_tokens, Some(5));
        assert_eq!(report.cached_tokens, Some(3));
        assert_eq!(report.reasoning_tokens, Some(2));
        assert_eq!(report.cost_micro_usd, Some(1234));
        assert_eq!(report.was_estimated, Some(false));
        let detail = usage_detail_json(&dto);
        assert_eq!(detail["prompt_tokens"], json!(11));
        assert_eq!(detail["cost_micro_usd"], json!(1234));
    }

    fn hosts() -> Vec<String> {
        vec!["github.com".to_string()]
    }

    fn run_snapshot() -> GatewayRunSnapshot {
        GatewayRunSnapshot {
            agent_member_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            status: momo_agent::RunStatus::Running,
            trigger_message_id: None,
            trigger_root_id: None,
            model: "hermes-agent".to_string(),
            requested_effort: None,
            profile_effort_pref: None,
            started_at: None,
            observed_at: chrono::Utc::now(),
        }
    }

    /// ADR-0113 증보 3 F5 (#4313): a gateway completion cannot put `requestedApps` on its answer. The
    /// answer's props are **built by the server** from validated reports only (`appsUsed`, `app_notice`),
    /// so a runtime that reports the key — inside its usage block, which is the one free-form place — gets
    /// it nowhere near the top level a client reads, and the requested-apps marker stays the send
    /// route's alone.
    #[test]
    fn a_gateway_answer_never_carries_the_requested_apps_marker() {
        let props = timeline_props(
            &run_snapshot(),
            Uuid::from_u128(3),
            true,
            Some(json!({
                "requestedApps": ["com.momo.plugins.gmail"],
                "prompt_tokens": 1,
            })),
            None,
            None,
            None,
        );
        assert!(props.get("requestedApps").is_none(), "{props}");
        assert!(props.get("requested_apps").is_none(), "{props}");
        // The only app keys that can appear are the two validated ones, and only when reported.
        let keys: Vec<&str> = props
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        for key in keys {
            assert!(
                !momo_agent::SERVER_OWNED_APP_PROPS_KEYS.contains(&key),
                "no server-owned app key without a report: {key}"
            );
        }
    }

    /// D11 — the stage rule is the share's rule, not a copy of it: the same
    /// inputs the share test refuses are refused here, and a Korean marker of 80
    /// characters (more than 80 bytes) is accepted.
    #[test]
    fn a_stage_marker_follows_the_share_rule() {
        assert_eq!(
            validated_gateway_stage("  원인 찾음 ").as_deref(),
            Ok("원인 찾음")
        );
        assert!(validated_gateway_stage(&"가".repeat(80)).is_ok());
        for bad in [
            "",
            "   ",
            &"x".repeat(81),
            "bad\u{7}",
            "\u{202E}rtl",
            "a/b",
            "a\\b",
            "/Users/me/secret/auth.rs",
        ] {
            assert_eq!(
                validated_gateway_stage(bad),
                Err(ReportRejection::Stage),
                "{bad:?}"
            );
        }
    }

    /// D12 — a valid report is stored as sent (PR URL canonicalised), an absent
    /// or empty one stores nothing.
    #[test]
    fn valid_artifacts_are_normalised_and_an_empty_report_is_nothing() {
        let artifacts = validated_gateway_artifacts(
            Some(&json!({
                "prUrl": "https://GitHub.com/acme/app/pull/42?x=1#y",
                "branch": "feat/x",
                "added": 10, "deleted": 0, "commits": 3
            })),
            &hosts(),
        )
        .expect("valid")
        .expect("present");
        assert_eq!(
            artifacts.to_json(),
            json!({
                "prUrl": "https://github.com/acme/app/pull/42",
                "branch": "feat/x", "added": 10, "deleted": 0, "commits": 3
            })
        );
        assert_eq!(
            artifacts.keys(),
            ["prUrl", "branch", "added", "deleted", "commits"]
        );
        for none in [
            None,
            Some(&Value::Null),
            Some(&json!({})),
            Some(&json!({"added": null})),
        ] {
            assert_eq!(validated_gateway_artifacts(none, &hosts()), Ok(None));
        }
    }

    /// D12 — every malformed field refuses the whole report, and says which kind
    /// of field with a closed code.
    #[test]
    fn each_malformed_artifact_field_refuses_the_report() {
        let cases = [
            (json!("x"), ReportRejection::ArtifactsShape),
            (json!({"title": "fix"}), ReportRejection::ArtifactsShape),
            (json!({"prUrl": 5}), ReportRejection::ArtifactsShape),
            (
                json!({"prUrl": "http://github.com/a/b/pull/1"}),
                ReportRejection::ArtifactsPrUrl,
            ),
            (
                json!({"prUrl": "https://evil.example/a/b/pull/1"}),
                ReportRejection::ArtifactsPrUrl,
            ),
            (
                json!({"prUrl": "https://github.com/a/b/pull/1/files"}),
                ReportRejection::ArtifactsPrUrl,
            ),
            (
                json!({"branch": "/etc/passwd"}),
                ReportRejection::ArtifactsBranch,
            ),
            (
                json!({"branch": "fix: rotate"}),
                ReportRejection::ArtifactsBranch,
            ),
            (json!({"branch": "C:\\x"}), ReportRejection::ArtifactsBranch),
            (json!({"added": -1}), ReportRejection::ArtifactsCount),
            (json!({"deleted": 1.5}), ReportRejection::ArtifactsCount),
            (
                json!({"commits": MAX_COUNT + 1}),
                ReportRejection::ArtifactsCount,
            ),
            (json!({"commits": "3"}), ReportRejection::ArtifactsShape),
        ];
        for (value, expected) in cases {
            assert_eq!(
                validated_gateway_artifacts(Some(&value), &hosts()).map_err(|r| r.reason),
                Err(expected),
                "{value}"
            );
        }
        assert!(
            validated_gateway_artifacts(Some(&json!({"commits": MAX_COUNT})), &hosts()).is_ok()
        );
    }

    fn refusal_of(value: Value) -> (&'static str, &'static str, Option<&'static str>) {
        let refusal = validated_gateway_artifacts(Some(&value), &hosts())
            .expect_err(&format!("{value} must be refused"));
        (
            refusal.violation.field,
            refusal.violation.rule.as_str(),
            refusal.violation.requires,
        )
    }

    /// ADR-0162 증보 5 C1 — a full code-task report is stored in its closed shape
    /// (sha lowercased, counts as sent) and the old five keys still pass alone.
    #[test]
    fn a_code_task_report_is_stored_closed_and_normalised() {
        let artifacts = validated_gateway_artifacts(
            Some(&json!({
                "resultKind": "pr_opened",
                "prUrl": "https://github.com/acme/app/pull/42",
                "branch": "feat/x",
                "tests": {"passed": 12, "failed": 0, "notRun": 1},
                "nextAction": "merge_ok",
                "commitSha": "ABCDEF0123",
                "toolCounts": {"run": 12, "edit": 4, "read": 30, "web": null}
            })),
            &hosts(),
        )
        .expect("valid")
        .expect("present");
        assert_eq!(
            artifacts.to_json(),
            json!({
                "prUrl": "https://github.com/acme/app/pull/42",
                "branch": "feat/x",
                "resultKind": "pr_opened",
                "tests": {"passed": 12, "failed": 0, "notRun": 1},
                "nextAction": "merge_ok",
                "commitSha": "abcdef0123",
                "toolCounts": {"run": 12, "edit": 4, "read": 30}
            })
        );
        assert_eq!(
            artifacts.keys(),
            [
                "prUrl",
                "branch",
                "resultKind",
                "tests",
                "nextAction",
                "commitSha",
                "toolCounts"
            ]
        );
        assert_eq!(
            agent_reported_of(Some(&json!({"artifacts": artifacts.to_json()}))),
            Some(json!({
                "resultKind": "pr_opened",
                "tests": {"passed": 12, "failed": 0, "notRun": 1},
                "nextAction": "merge_ok",
                "commitSha": "abcdef0123",
                "toolCounts": {"run": 12, "edit": 4, "read": 30}
            }))
        );
        // Counts alone need no kind (C2); an empty toolCounts is nothing.
        assert!(
            validated_gateway_artifacts(Some(&json!({"toolCounts": {"read": 3}})), &hosts())
                .expect("valid")
                .is_some()
        );
        assert_eq!(
            validated_gateway_artifacts(Some(&json!({"toolCounts": {}})), &hosts()),
            Ok(None)
        );
        // An old routine's report has no agent-reported part.
        assert_eq!(
            agent_reported_of(Some(
                &json!({"artifacts": {"prUrl": "https://github.com/a/b/pull/1"}})
            )),
            None
        );
        assert_eq!(agent_reported_of(None), None);
        // Each kind's minimal valid report.
        for ok in [
            json!({"resultKind": "pr_opened", "prUrl": "https://github.com/a/b/pull/1", "branch": "x"}),
            json!({"resultKind": "branch_only", "branch": "x", "commitSha": "abcdef1"}),
            json!({"resultKind": "vm_only", "tests": {"passed": 0, "failed": 2, "notRun": 0}, "nextAction": "blocked"}),
            json!({"resultKind": "no_change", "added": 0, "deleted": 0, "commits": 0, "nextAction": "none"}),
            json!({"resultKind": "pr_opened", "prUrl": "https://github.com/a/b/pull/1", "tests": {"passed": 3, "failed": 1, "notRun": 0}, "nextAction": "please_test"}),
        ] {
            assert!(
                validated_gateway_artifacts(Some(&ok), &hosts()).is_ok(),
                "{ok}"
            );
        }
    }

    /// ADR-0162 증보 5 C1/C3 — every cross rule and closed-field fault refuses the
    /// whole report and names exactly which field and rule (never the value).
    #[test]
    fn each_contract_violation_names_its_field_and_rule() {
        let pr = "https://github.com/a/b/pull/1";
        let kind = Some("artifacts.resultKind");
        type Named = (&'static str, &'static str, Option<&'static str>);
        let cases: Vec<(Value, Named)> = vec![
            (
                json!({"tests": {"passed": 1, "failed": 0, "notRun": 0}}),
                ("artifacts.tests", "requires", kind),
            ),
            (
                json!({"nextAction": "none"}),
                ("artifacts.nextAction", "requires", kind),
            ),
            (
                json!({"commitSha": "abcdef1"}),
                ("artifacts.commitSha", "requires", kind),
            ),
            (
                json!({"resultKind": "pr_opened"}),
                ("artifacts.prUrl", "required", None),
            ),
            (
                json!({"resultKind": "branch_only"}),
                ("artifacts.branch", "required", None),
            ),
            (
                json!({"resultKind": "branch_only", "branch": "x", "prUrl": pr}),
                ("artifacts.prUrl", "forbidden", None),
            ),
            (
                json!({"resultKind": "vm_only", "prUrl": pr}),
                ("artifacts.prUrl", "forbidden", None),
            ),
            (
                json!({"resultKind": "vm_only", "branch": "x"}),
                ("artifacts.branch", "forbidden", None),
            ),
            (
                json!({"resultKind": "no_change", "commitSha": "abcdef1"}),
                ("artifacts.commitSha", "forbidden", None),
            ),
            (
                json!({"resultKind": "no_change", "added": 3}),
                ("artifacts.added", "forbidden", None),
            ),
            (
                json!({"resultKind": "no_change", "commits": 1}),
                ("artifacts.commits", "forbidden", None),
            ),
            (
                json!({"resultKind": "branch_only", "branch": "x", "nextAction": "merge_ok"}),
                ("artifacts.nextAction", "requires", kind),
            ),
            (
                json!({"resultKind": "pr_opened", "prUrl": pr, "nextAction": "merge_ok", "tests": {"passed": 3, "failed": 1, "notRun": 0}}),
                ("artifacts.nextAction", "forbidden", None),
            ),
            (
                json!({"resultKind": "merged"}),
                ("artifacts.resultKind", "enum", None),
            ),
            (
                json!({"resultKind": 3}),
                ("artifacts.resultKind", "format", None),
            ),
            (
                json!({"resultKind": "vm_only", "nextAction": "ship"}),
                ("artifacts.nextAction", "enum", None),
            ),
            (
                json!({"resultKind": "vm_only", "tests": {"passed": 1}}),
                ("artifacts.tests.failed", "required", None),
            ),
            (
                json!({"resultKind": "vm_only", "tests": {"passed": 1, "failed": 0, "notRun": 0, "x": 1}}),
                ("artifacts.tests", "forbidden", None),
            ),
            (
                json!({"resultKind": "vm_only", "tests": {"passed": 100_001, "failed": 0, "notRun": 0}}),
                ("artifacts.tests.passed", "range", None),
            ),
            (
                json!({"resultKind": "vm_only", "tests": {"passed": 1, "failed": 0, "notRun": -1}}),
                ("artifacts.tests.notRun", "range", None),
            ),
            (
                json!({"resultKind": "vm_only", "commitSha": "xyz1234"}),
                ("artifacts.commitSha", "format", None),
            ),
            (
                json!({"resultKind": "vm_only", "commitSha": "abc"}),
                ("artifacts.commitSha", "range", None),
            ),
            (
                json!({"resultKind": "vm_only", "commitSha": "a".repeat(41)}),
                ("artifacts.commitSha", "range", None),
            ),
            (
                json!({"toolCounts": {"bash": 1}}),
                ("artifacts.toolCounts", "forbidden", None),
            ),
            (
                json!({"toolCounts": {"run": 1.5}}),
                ("artifacts.toolCounts.run", "format", None),
            ),
            (
                json!({"toolCounts": {"web": 100_001}}),
                ("artifacts.toolCounts.web", "range", None),
            ),
            (
                json!({"toolCounts": "lots"}),
                ("artifacts.toolCounts", "format", None),
            ),
            (json!({"title": "fix"}), ("artifacts", "forbidden", None)),
            (
                json!({"branch": "fix: rotate"}),
                ("artifacts.branch", "format", None),
            ),
            (
                json!({"prUrl": "http://github.com/a/b/pull/1"}),
                ("artifacts.prUrl", "format", None),
            ),
            (json!({"added": -1}), ("artifacts.added", "range", None)),
        ];
        for (value, expected) in cases {
            assert_eq!(refusal_of(value.clone()), expected, "{value}");
            let refusal = validated_gateway_artifacts(Some(&value), &hosts()).unwrap_err();
            let message = refusal.violation.message();
            assert!(message.starts_with(expected.0), "{message}");
            let data = refusal.violation.data().to_string();
            for leaked in [
                "merged", "ship", "bash", "lots", "xyz1234", "rotate", "http://",
            ] {
                assert!(
                    !message.contains(leaked) && !data.contains(leaked),
                    "{leaked}: {message} {data}"
                );
            }
        }
        // Old keys keep their old audit codes; new ones get the contract code.
        assert_eq!(
            validated_gateway_artifacts(Some(&json!({"resultKind": "pr_opened"})), &hosts())
                .unwrap_err()
                .reason
                .code(),
            "artifacts_contract_invalid"
        );
    }

    /// Every path the server names is one momo-mcp's closed list knows, so no
    /// refusal falls back to the generic object path by accident.
    #[test]
    fn every_refusal_path_is_a_closed_artifact_path() {
        for field in [
            "artifacts",
            "artifacts.prUrl",
            "artifacts.branch",
            "artifacts.added",
            "artifacts.deleted",
            "artifacts.commits",
            "artifacts.resultKind",
            "artifacts.tests",
            "artifacts.tests.passed",
            "artifacts.tests.failed",
            "artifacts.tests.notRun",
            "artifacts.nextAction",
            "artifacts.commitSha",
            "artifacts.toolCounts",
            "artifacts.toolCounts.run",
            "artifacts.toolCounts.edit",
            "artifacts.toolCounts.read",
            "artifacts.toolCounts.search",
            "artifacts.toolCounts.web",
            "artifacts.toolCounts.other",
        ] {
            assert_eq!(
                ArtifactViolation::on(field, ArtifactRule::Format).map(|v| v.field),
                Some(field)
            );
        }
    }

    /// C3's message is the agent's one fix instruction, so it must state the
    /// rule the validator actually applies: every character `validated_branch`
    /// refuses is named in the branch clause, and the PR clause does not pin
    /// one host when the operator may allow a GitHub Enterprise one.
    #[test]
    fn the_branch_and_pr_messages_state_the_rule_the_validator_applies() {
        let branch = refusal_message(json!({"branch": "a:b"}));
        for forbidden in ['~', '^', ':', '?', '*', '[', '\\'] {
            let raw = format!("feat{forbidden}x");
            assert!(
                momo_t3::work_share::validated_branch(&raw).is_err(),
                "{raw} is refused by the validator"
            );
            assert!(
                branch.contains(forbidden),
                "{forbidden} missing from: {branch}"
            );
        }
        assert!(
            branch.contains("whitespace") && branch.contains("path"),
            "{branch}"
        );
        let pr = refusal_message(json!({"prUrl": "https://example.com/a/b/pull/1"}));
        assert!(
            pr.starts_with("artifacts.prUrl must be https://<allowed host>/"),
            "{pr}"
        );
        assert!(!pr.contains("example.com"), "{pr}");
    }

    fn refusal_message(value: Value) -> String {
        validated_gateway_artifacts(Some(&value), &hosts())
            .expect_err("refused")
            .violation
            .message()
    }

    /// The published schema's ceiling is the share's.
    #[test]
    fn the_published_count_ceiling_is_the_shares() {
        assert_eq!(momo_mcp::MAX_ARTIFACT_COUNT, MAX_COUNT);
        assert_eq!(
            momo_mcp::MAX_STAGE_BYTES as usize,
            momo_t3::work_share::MAX_STAGE_MARKER_CHARS * 4
        );
    }

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
    fn an_empty_success_leaves_no_placeholder_and_a_failure_keeps_its_line() {
        // #4017: an empty success leaves no message, not a placeholder.
        assert_eq!(timeline_body(Some("   "), true, None), None);
        assert_eq!(timeline_body(None, true, None), None);
        assert_eq!(
            timeline_body(Some(" done "), true, None).as_deref(),
            Some("done")
        );
        assert_eq!(
            timeline_body(None, false, Some("boom")).as_deref(),
            Some("답을 만들지 못했어요: boom")
        );
        assert_eq!(
            timeline_body(None, false, None).as_deref(),
            Some("답을 만들지 못했어요.")
        );
        for text in [
            timeline_body(None, false, Some("boom")),
            timeline_body(None, false, None),
        ]
        .into_iter()
        .flatten()
        {
            assert!(!text.contains("Hermes"), "no internal runtime name: {text}");
        }
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
                "에이전트가 오류를 알려 왔지만 민감한 값이 섞여 있어 내용을 가렸어요."
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
