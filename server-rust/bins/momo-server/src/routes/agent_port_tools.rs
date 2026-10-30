//! The Agent Port's ten product tools (ADR-0162 D3/D6, HAP-E5; ADR-0186 D2, 증보 G1).
//!
//! `momo-mcp` decides what a credential may see and call; **this module is the
//! typed domain port it is handed**, and it is the whole reason the protocol
//! crate can stay free of SQL. Every method below is thin binding:
//!
//! | tool | the existing thing it calls |
//! |---|---|
//! | `oort_inbox_read` | `momo_messaging::list_hosted_inbox_in_tx` (HAP-E4) |
//! | `oort_conversation_read` | `momo_messaging::list_channel_page` — the REST history's own read |
//! | `oort_message_post` | `momo_messaging::send_message_with_mentions_in_tx` — the REST send's own transaction |
//! | `oort_jobs_claim` | `momo_outbox::claim_hosted_gateway_jobs_in_tx` — the gateway claim, hosted branch |
//! | `oort_job_start` | the claim above + `record_gateway_event_in_tx` (the start report) + the `oort_conversation_read` gate, in one transaction (#3831) |
//! | `oort_job_renew` / `oort_job_release` | `momo_outbox`'s lease verbs; renew uses the hosted TTL and revives an unclaimed expired lease (#3530) |
//! | `oort_run_event` | `routes::agent_gateway::record_gateway_event_in_tx` |
//! | `oort_run_complete` | `routes::agent_gateway::complete_gateway_run_in_tx` |
//! | `oort_action_propose` | `momo_agent::approval`'s producer — the *same* park #979 already wrote for tool calls |
//! | `oort_card_suggest` | `momo_agent::card_suggest` (the gate the worker shares) + `momo_messaging::send_message_in_tx` |
//!
//! There is **no SQL in this file** beyond what those functions own, no second
//! message or job ledger, and no Centrifugo publish: a hosted answer reaches a
//! channel through the same outbox row a human's message does.
//!
//! ## Proposing is not doing (ADR-0186 D2)
//!
//! `oort_action_propose` is the one tool whose subject is the workspace rather
//! than the conversation, and it is deliberately the *weakest* of the nine: it
//! writes an `approval` row, an `approval_request` card and a run transition,
//! and then the run stops. No invite, no webhook, no membership changes here;
//! that happens in the decision transaction, with the **approver's** authority
//! (AX-3b). The agent holds no admin scope at any point, which is why the
//! propose scope opens zero REST routes.
//!
//! The run guard is the other half of that sentence. Once a run is parked,
//! `oort_run_complete` and `oort_job_release` refuse it: an agent that could
//! settle its own parked run would turn "waiting for a person" into "the person
//! never gets asked".
//!
//! ## Authority is re-proved inside every transaction
//!
//! The transport authenticated the bearer, and `tools/list` was built from a
//! connection snapshot. Neither is carried into the write: each tool opens its
//! own tenant transaction and calls
//! [`momo_auth::resolve_hosted_tool_identity_in_tx`] again, so a revoke, a
//! pause, a membership removal or a scope narrowing that commits between the
//! listing and the call lands on the closed side.
//!
//! ## Nothing internal crosses the wire
//!
//! A client never receives a job id, a lease owner, a run id, an inbox
//! sequence, or a raw cursor position. Job authority travels as a sealed
//! [`momo_mcp::LeaseHandle`]; inbox position travels as HAP-E4's sealed cursor.
//! Failures are the five fixed [`ToolFailure`] answers, so a refusal never
//! confirms which of "absent", "invisible" and "forbidden" it was.

use axum::http::StatusCode;
use momo_auth::{HostedToolIdentity, Principal};
use momo_db::{DbError, PgConnection, PgPool};
use momo_mcp::{
    decode_lease_handle, encode_lease_handle, LeaseHandle, ToolCall, ToolCapability, ToolFailure,
    ToolView,
};
use momo_messaging::{
    clamp_history_limit, is_channel_member, list_channel_page, list_hosted_inbox_in_tx,
    send_message_in_tx, send_thread_notice_in_tx, validate_quote_target_in_tx,
    validate_thread_root_in_tx, HistoryCursor, MessageType, NewMessage, SendExtras,
    HOSTED_INBOX_LIMIT_DEFAULT,
};
use momo_outbox::GatewayLeaseBinding;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::agent_gateway::{
    complete_gateway_run_in_tx, record_gateway_event_in_tx, report_standing_in_tx,
    sanitized_gateway_error, validated_event_fields, validated_gateway_artifacts,
    validated_gateway_stage, write_report_rejected_audit, GatewayCompleteInput, GatewayEventInput,
    ReportStanding,
};
use crate::routes::agent_mentions::{route_agent_mentions_in_tx, MentionSend};
use crate::routes::app_notice::validated_app_notice;
use crate::routes::apps_used::validated_apps_used;
use crate::AppState;

/// The cursor argument ceiling, equal to `momo_mcp::tools`' published
/// `maxLength`. HAP-E4 cursors are 135 characters, so this is headroom rather
/// than a limit anyone reaches.
const MAX_CURSOR_BYTES: usize = 256;

/// What the transport proved before a tool ran.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HostedCaller {
    pub workspace_id: Uuid,
    pub agent_member_id: Uuid,
    pub token_id: Uuid,
}

impl HostedCaller {
    /// `None` for any principal that is not an agent bearer carrying a token id
    /// — which is every credential class the Agent Port already refuses, so this
    /// is a type-level restatement rather than a second gate.
    pub fn from_principal(principal: &Principal) -> Option<HostedCaller> {
        if principal.kind != momo_auth::PrincipalKind::Agent {
            return None;
        }
        Some(HostedCaller {
            workspace_id: principal.workspace_id,
            agent_member_id: principal.member_id,
            token_id: principal.token_id?,
        })
    }
}

/// Read the caller's live connection and turn it into the request's tool view.
///
/// A caller with no live connection — a pairing credential, an expired or
/// revoked one, a paused agent — gets [`ToolView::empty`], which is exactly what
/// a connect-only credential gets: an empty `tools/list` and an unknown-tool
/// answer for every call.
pub(crate) async fn tool_view_for(state: &AppState, caller: HostedCaller) -> ToolView {
    // ADR-0193 D6 (#2815) — with the operator's switch off, a subscription
    // (`owner_only`) agent's runtime may call nothing: no inbox read, no job
    // claim, no post. This is the one door through which a job queued before
    // the switch was flipped could still be delivered, so it is closed here
    // rather than per tool. Turning the switch back on restores the view on the
    // next request; nothing else has to be undone.
    if !state.agent_port.config.subscription_agents_enabled {
        match owner_only_caller(&state.pool, caller).await {
            Ok(false) => {}
            Ok(true) => return ToolView::empty(),
            Err(error) => {
                tracing::error!(
                    error = %error,
                    route = "/v1/mcp/agent-port",
                    "Agent Port subscription scope resolution failed"
                );
                return ToolView::empty();
            }
        }
    }
    // #3397 (결재 2026-10-03) — the same door for a Claude subscription agent
    // while the instance has not opted in: agents registered before the flag
    // existed, and jobs queued for them, deliver nothing. Fail closed.
    if !state.agent_port.config.claude_subscription_agents_enabled {
        match claude_subscription_blocked_caller(&state.pool, caller).await {
            Ok(false) => {}
            Ok(true) => return ToolView::empty(),
            Err(error) => {
                tracing::error!(
                    error = %error,
                    route = "/v1/mcp/agent-port",
                    "Agent Port Claude subscription resolution failed"
                );
                return ToolView::empty();
            }
        }
    }
    match hosted_identity(&state.pool, caller).await {
        Ok(Some(identity)) => ToolView::intersect(
            &identity.approved_scopes,
            &identity.token_scopes,
            ToolCapability::FULL,
        ),
        Ok(None) => ToolView::empty(),
        Err(error) => {
            // Never the raw error at the boundary, and never the bearer: this
            // fixed context plus the typed DB error is enough to separate a
            // pool failure from a query failure while the client only learns
            // that it may call nothing.
            tracing::error!(
                error = %error,
                route = "/v1/mcp/agent-port",
                "Agent Port tool view resolution failed"
            );
            ToolView::empty()
        }
    }
}

async fn owner_only_caller(pool: &PgPool, caller: HostedCaller) -> Result<bool, DbError> {
    momo_db::with_tenant_tx(pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            momo_agent::agent_is_owner_only_in_tx(conn, caller.workspace_id, caller.agent_member_id)
                .await
        })
    })
    .await
}

async fn claude_subscription_blocked_caller(
    pool: &PgPool,
    caller: HostedCaller,
) -> Result<bool, DbError> {
    momo_db::with_tenant_tx(pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            momo_agent::agent_claude_subscription_blocked_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                false,
            )
            .await
        })
    })
    .await
}

async fn hosted_identity(
    pool: &PgPool,
    caller: HostedCaller,
) -> Result<Option<HostedToolIdentity>, DbError> {
    momo_db::with_tenant_tx(pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            momo_auth::resolve_hosted_tool_identity_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                caller.token_id,
            )
            .await
            .map_err(DbError::from)
        })
    })
    .await
}

/// Run one admitted tool call and answer on the wire.
///
/// The status and the body are built from **one** verdict, in one place, so a
/// 200 can never carry an error envelope (or the reverse).
pub(crate) async fn execute(
    state: &AppState,
    caller: HostedCaller,
    call: ToolCall,
) -> momo_mcp::HttpResponse {
    // ADR-0200 증보 2026-10-15 T1: the server's own monotonic measure, from the
    // moment the dispatcher takes the call to the moment its verdict is known.
    let started = std::time::Instant::now();
    let result = match call.tool.name {
        momo_mcp::TOOL_INBOX_READ => inbox_read(state, caller, &call.arguments).await,
        momo_mcp::TOOL_CONVERSATION_READ => conversation_read(state, caller, &call.arguments).await,
        momo_mcp::TOOL_MESSAGE_POST => message_post(state, caller, &call.arguments).await,
        momo_mcp::TOOL_JOBS_CLAIM => jobs_claim(state, caller, &call.arguments).await,
        momo_mcp::TOOL_JOB_START => job_start(state, caller, &call.arguments).await,
        momo_mcp::TOOL_JOB_RENEW => {
            job_lease(state, caller, &call.arguments, LeaseVerb::Renew).await
        }
        momo_mcp::TOOL_JOB_RELEASE => {
            job_lease(state, caller, &call.arguments, LeaseVerb::Release).await
        }
        momo_mcp::TOOL_RUN_EVENT => run_event(state, caller, &call.arguments).await,
        momo_mcp::TOOL_RUN_COMPLETE => run_complete(state, caller, &call.arguments).await,
        momo_mcp::TOOL_ACTION_PROPOSE => action_propose(state, caller, &call.arguments).await,
        momo_mcp::TOOL_ACTION_INITIATE => {
            crate::routes::agent_initiative::action_initiate(state, caller, &call.arguments).await
        }
        momo_mcp::TOOL_ACTION_CLAIM_SECRET => {
            action_claim_secret(state, caller, &call.arguments).await
        }
        momo_mcp::TOOL_CARD_SUGGEST => card_suggest(state, caller, &call.arguments).await,
        momo_mcp::TOOL_EXPRESSION_ASSEMBLE => {
            expression_assemble(state, caller, &call.arguments).await
        }
        momo_mcp::TOOL_PING => ping(state, caller, &call.arguments).await,
        _ => Err(ToolFailure::InvalidArguments),
    };
    let elapsed = started.elapsed();
    record_liveness(state, caller, call.tool.name, &result).await;
    record_tool_call(state, caller, &call, &result, elapsed).await;
    match result {
        Ok(structured) => momo_mcp::tool_success(&call, structured),
        Err(failure) => momo_mcp::tool_failure(&call, failure),
    }
}

// ---------------------------------------------------------------------------
// liveness (ADR-0200 D4, #3742)
// ---------------------------------------------------------------------------

/// Record what this call proves about the runtime on the other end, in a SECOND small
/// transaction after the tool's own has settled: a liveness write must never decide a
/// tool's outcome, and a failed tool must still be able to say it was refused.
///
/// * a success refreshes `last_tool_call_at`, plus the work signal it earned — an
///   inbox read, a claim that actually took a job, a run event/complete/propose;
/// * a refusal that is about the CONNECTION (`unavailable`, `not_authorized`) is kept
///   as a closed code so a person debugging "Agent Port unavailable" has something to
///   read. A lost lease or a bad argument is the agent's own flow, not a connection
///   fault, and does not flip the state to `error`.
///
/// Throttled to one write per column per 30 s inside the statement, so a polling
/// agent is nearly free. Best effort: a failure is logged and never reaches the wire.
/// A liveness write that cannot finish in this long is dropped (and logged): the tool
/// has already settled, and a slow database must not become a slow tool response.
const LIVENESS_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

async fn record_liveness(
    state: &AppState,
    caller: HostedCaller,
    tool: &str,
    outcome: &Result<Value, ToolFailure>,
) {
    use momo_agent::Touch;
    let write = match outcome {
        Ok(structured) => {
            let touch = match tool {
                momo_mcp::TOOL_INBOX_READ => Touch {
                    inbox_read: true,
                    ..Touch::default()
                },
                momo_mcp::TOOL_JOBS_CLAIM
                    if structured["jobs"]
                        .as_array()
                        .is_some_and(|jobs| !jobs.is_empty()) =>
                {
                    Touch {
                        claim: true,
                        ..Touch::default()
                    }
                }
                // #3831: a start that returned a job is a claim (when it took one
                // rather than re-entered one) and a run event (when the start
                // report landed); `job: null` proves only that the call worked.
                momo_mcp::TOOL_JOB_START if structured["job"].is_object() => Touch {
                    claim: structured["resumed"] == json!(false),
                    run_event: structured["started"] == json!(true),
                    ..Touch::default()
                },
                momo_mcp::TOOL_RUN_EVENT
                | momo_mcp::TOOL_RUN_COMPLETE
                | momo_mcp::TOOL_ACTION_PROPOSE => Touch {
                    run_event: true,
                    ..Touch::default()
                },
                _ => Touch::default(),
            };
            tokio::time::timeout(
                LIVENESS_WRITE_TIMEOUT,
                momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
                    Box::pin(async move {
                        momo_agent::record_tool_success_in_tx(
                            conn,
                            caller.workspace_id,
                            caller.agent_member_id,
                            caller.token_id,
                            touch,
                        )
                        .await
                    })
                }),
            )
            .await
        }
        // A refusal of the unasked-card door is the door doing its job (the owner has not
        // opened it, a limit was reached): it says nothing about the CONNECTION, and recording
        // it would turn the connection `error` for a person reading the connection card.
        Err(_) if tool == momo_mcp::TOOL_ACTION_INITIATE => return,
        Err(failure @ (ToolFailure::Unavailable | ToolFailure::NotAuthorized)) => {
            let code = if *failure == ToolFailure::Unavailable {
                "unavailable"
            } else {
                "not_authorized"
            };
            tokio::time::timeout(
                LIVENESS_WRITE_TIMEOUT,
                momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
                    Box::pin(async move {
                        momo_agent::record_tool_error_in_tx(
                            conn,
                            caller.workspace_id,
                            caller.agent_member_id,
                            caller.token_id,
                            code,
                        )
                        .await
                    })
                }),
            )
            .await
        }
        Err(_) => return,
    };
    match write {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(error = %error, tool, "agent port liveness write failed");
        }
        Err(_) => tracing::warn!(tool, "agent port liveness write timed out"),
    }
}

// ---------------------------------------------------------------------------
// tool_call ledger (ADR-0200 증보 2026-10-15 T1~T3, #3840)
// ---------------------------------------------------------------------------

/// The argument a handle-taking tool carries its sealed lease handle in. `None` for
/// a tool that takes none (its call points at no run unless it hands a job out).
fn handle_argument(tool: &str) -> Option<&'static str> {
    match tool {
        momo_mcp::TOOL_JOB_START
        | momo_mcp::TOOL_JOB_RENEW
        | momo_mcp::TOOL_JOB_RELEASE
        | momo_mcp::TOOL_RUN_EVENT
        | momo_mcp::TOOL_RUN_COMPLETE => Some("leaseHandle"),
        // ADR-0186 D2 names the field `handle`; the value is the same sealed handle.
        momo_mcp::TOOL_ACTION_PROPOSE
        | momo_mcp::TOOL_ACTION_CLAIM_SECRET
        | momo_mcp::TOOL_EXPRESSION_ASSEMBLE
        | momo_mcp::TOOL_CARD_SUGGEST => Some("handle"),
        _ => None,
    }
}

/// The runs ONE call points at, and nothing inferred (T2):
///
/// * the run inside the sealed handle the caller passed, when the handle opens under
///   this server's secret and names this workspace and this agent — even if the tool
///   then refused (a lost lease is still that agent's call on that run);
/// * the run of every job the call handed out (`oort_jobs_claim`, `oort_job_start`),
///   read back from the handles in the answer the agent is about to receive.
///
/// A call with neither (inbox/conversation read, message post, ping, an unopenable
/// handle, a claim that took nothing) points at no run and is not recorded. No
/// "it must be the one lease it holds" guess: this ledger exists to stop guessing.
fn attributed_runs(
    secret: &str,
    caller: HostedCaller,
    call: &ToolCall,
    result: &Result<Value, ToolFailure>,
) -> Vec<Uuid> {
    let mut raw_handles: Vec<&str> = Vec::new();
    if let Some(field) = handle_argument(call.tool.name) {
        if let Some(raw) = call.arguments.get(field).and_then(Value::as_str) {
            raw_handles.push(raw);
        }
    }
    if let Ok(structured) = result {
        match call.tool.name {
            momo_mcp::TOOL_JOBS_CLAIM => {
                if let Some(jobs) = structured["jobs"].as_array() {
                    raw_handles.extend(jobs.iter().filter_map(|job| job["leaseHandle"].as_str()));
                }
            }
            momo_mcp::TOOL_JOB_START => {
                raw_handles.extend(structured["job"]["leaseHandle"].as_str());
            }
            _ => {}
        }
    }
    let mut runs: Vec<Uuid> = Vec::new();
    for raw in raw_handles {
        if raw.len() > 512 {
            continue;
        }
        let Ok(handle) = decode_lease_handle(raw, secret) else {
            continue;
        };
        if handle.workspace_id != caller.workspace_id
            || handle.agent_member_id != caller.agent_member_id
        {
            continue;
        }
        if !runs.contains(&handle.run_id) {
            runs.push(handle.run_id);
        }
    }
    runs
}

/// Record the call on the run(s) it points at: name, server-measured duration, `ok` or
/// the closed failure code — never arguments, bodies or the handle (T1).
///
/// A SEPARATE short tenant transaction after the tool's own has settled, under the
/// same 2 s ceiling as the liveness write: the record is an observation, not a state
/// transition, so it must never decide, delay past that ceiling, or change the
/// tool's answer. Any failure is logged and dropped.
async fn record_tool_call(
    state: &AppState,
    caller: HostedCaller,
    call: &ToolCall,
    result: &Result<Value, ToolFailure>,
    elapsed: std::time::Duration,
) {
    let tool = call.tool.name;
    // The closed server-side list (T1): only a catalog name is ever written.
    if !momo_mcp::TOOL_CATALOG
        .iter()
        .any(|known| known.name == tool)
    {
        return;
    }
    let runs = attributed_runs(state.agent_port.envelope_secret(), caller, call, result);
    if runs.is_empty() {
        return;
    }
    let code = match result {
        Ok(_) => "ok",
        Err(failure) => failure.code(),
    };
    let duration_ms = i32::try_from(elapsed.as_millis())
        .unwrap_or(i32::MAX)
        .min(momo_agent::TOOL_CALL_DURATION_MS_MAX);
    let write = tokio::time::timeout(
        LIVENESS_WRITE_TIMEOUT,
        momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
            Box::pin(async move {
                for run_id in runs {
                    momo_agent::record_tool_call_in_tx(
                        conn,
                        caller.workspace_id,
                        run_id,
                        caller.agent_member_id,
                        tool,
                        duration_ms,
                        code,
                    )
                    .await?;
                }
                Ok(())
            })
        }),
    )
    .await;
    match write {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(error = %error, tool, "agent port tool_call record failed");
        }
        Err(_) => tracing::warn!(tool, "agent port tool_call record timed out"),
    }
}

// ---------------------------------------------------------------------------
// oort_ping — "I am alive", and nothing else
// ---------------------------------------------------------------------------

/// ADR-0200 D4-5. Rides `agent:inbox:read`, takes no connection or agent from the
/// arguments (it can only ever write the caller's own connection row), stores a closed
/// two-value state, and answers `recorded: false` instead of an error inside the 30 s
/// window so a retry loop is never taught that a limit exists by failing.
async fn ping(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let ping_state = match optional_str(args, "state", 16)? {
        None => momo_agent::PingState::Idle,
        Some(raw) => momo_agent::PingState::from_wire(raw).ok_or(ToolFailure::InvalidArguments)?,
    };
    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_INBOX_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let recorded = momo_agent::record_ping_in_tx(
                conn,
                caller.workspace_id,
                identity.connection_id,
                caller.agent_member_id,
                ping_state,
            )
            .await?;
            Ok(Ok(recorded))
        })
    })
    .await
    .map_err(|error| internal("agent_port.ping", error))?;
    let recorded = outcome?;
    Ok(json!({
        "status": "ok",
        "recorded": recorded,
        "serverTimeMs": crate::routes::shared::epoch_ms(chrono::Utc::now()),
        "minIntervalSeconds": 30,
    }))
}

// ---------------------------------------------------------------------------
// argument readers — every one of them fail-closed on shape
// ---------------------------------------------------------------------------

pub(crate) fn arguments(value: &Value) -> Result<&Map<String, Value>, ToolFailure> {
    value.as_object().ok_or(ToolFailure::InvalidArguments)
}

pub(crate) fn optional_uuid(
    args: &Map<String, Value>,
    key: &str,
) -> Result<Option<Uuid>, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => Uuid::parse_str(raw)
            .map(Some)
            .map_err(|_| ToolFailure::InvalidArguments),
        Some(_) => Err(ToolFailure::InvalidArguments),
    }
}

pub(crate) fn required_uuid(args: &Map<String, Value>, key: &str) -> Result<Uuid, ToolFailure> {
    optional_uuid(args, key)?.ok_or(ToolFailure::InvalidArguments)
}

fn optional_i64(args: &Map<String, Value>, key: &str) -> Result<Option<i64>, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .map(Some)
            .ok_or(ToolFailure::InvalidArguments),
        Some(_) => Err(ToolFailure::InvalidArguments),
    }
}

pub(crate) fn optional_str<'a>(
    args: &'a Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<Option<&'a str>, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) if raw.len() <= max_bytes => Ok(Some(raw.as_str())),
        Some(_) => Err(ToolFailure::InvalidArguments),
    }
}

pub(crate) fn required_str<'a>(
    args: &'a Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<&'a str, ToolFailure> {
    optional_str(args, key, max_bytes)?
        .filter(|value| !value.is_empty())
        .ok_or(ToolFailure::InvalidArguments)
}

/// A domain refusal → its wire answer.
///
/// The mapping is by status, not by message, because the messages are written
/// for humans reading an API and this surface must not hand a hosted adapter a
/// sentence that answers a question it was not allowed to ask.
pub(crate) fn failure_of(error: &ApiError) -> ToolFailure {
    match error.status {
        StatusCode::BAD_REQUEST => ToolFailure::InvalidArguments,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ToolFailure::NotAuthorized,
        StatusCode::NOT_FOUND => ToolFailure::Unavailable,
        StatusCode::CONFLICT => ToolFailure::Conflict,
        _ => ToolFailure::Internal,
    }
}

/// [`failure_of`] for a refusal raised while judging a LEASE-bound call (a run event or
/// completion): a 401/403 there is the run or lease not being this caller's — the
/// agent's own flow, answered on the wire exactly as before — while the connection
/// itself was already proved by `authorize_in_tx` (#3903).
fn lease_failure_of(error: &ApiError) -> ToolFailure {
    match failure_of(error) {
        ToolFailure::NotAuthorized => ToolFailure::HandleRefused,
        other => other,
    }
}

/// A transaction failure → `Internal`, with the cause logged and nothing about
/// it on the wire.
pub(crate) fn internal(context: &str, error: DbError) -> ToolFailure {
    tracing::error!(error = %error, context, "Agent Port tool transaction failed");
    ToolFailure::Internal
}

pub(crate) fn has_scope(identity: &HostedToolIdentity, scope: &str) -> bool {
    identity.token_scopes.iter().any(|value| value == scope)
        && identity.approved_scopes.iter().any(|value| value == scope)
}

/// Re-prove the connection inside the caller's own transaction and require one
/// scope on both halves of the intersection.
pub(crate) async fn authorize_in_tx(
    conn: &mut PgConnection,
    caller: HostedCaller,
    scope: &str,
) -> Result<Result<HostedToolIdentity, ToolFailure>, DbError> {
    let identity = momo_auth::resolve_hosted_tool_identity_in_tx(
        conn,
        caller.workspace_id,
        caller.agent_member_id,
        caller.token_id,
    )
    .await
    .map_err(DbError::from)?;
    let Some(identity) = identity else {
        return Ok(Err(ToolFailure::NotAuthorized));
    };
    if !has_scope(&identity, scope) {
        return Ok(Err(ToolFailure::NotAuthorized));
    }
    Ok(Ok(identity))
}

// ---------------------------------------------------------------------------
// oort_inbox_read
// ---------------------------------------------------------------------------

async fn inbox_read(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    // The same ceiling the published input schema declares (`tools.rs`); a
    // reader bound looser than the advertised one would accept an argument the
    // client was told was invalid.
    let cursor = optional_str(args, "cursor", MAX_CURSOR_BYTES)?.map(str::to_string);
    let limit = optional_i64(args, "limit")?.unwrap_or(HOSTED_INBOX_LIMIT_DEFAULT);
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_INBOX_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let page = list_hosted_inbox_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                identity.connection_id,
                cursor.as_deref(),
                limit,
                &secret,
            )
            .await?;
            // HAP-E4 answers a stale, forged or foreign cursor with the same
            // `Unavailable` an inactive connection gets. That is deliberate and
            // it is also the cursor-secret rotation contract: an agent whose
            // cursor stops opening must re-establish, never silently restart
            // from the beginning and replay the whole ledger.
            Ok(page.map_err(|_| ToolFailure::Unavailable))
        })
    })
    .await
    .map_err(|error| internal("agent_port.inbox_read", error))?;

    let page = outcome?;
    let events: Vec<Value> = page
        .events
        .iter()
        .map(|event| {
            let mut projected = Map::new();
            projected.insert("kind".into(), json!(event.event_kind));
            if let Some(channel_id) = event.source_channel_id {
                projected.insert("channelId".into(), json!(channel_id));
            }
            if let Some(message_id) = event.source_message_id {
                projected.insert("messageId".into(), json!(message_id));
            }
            if let Some(seq) = event.source_message_seq {
                projected.insert("messageSeq".into(), json!(seq));
            }
            // `source_outbox_id` and `inbox_seq` are deliberately absent: the
            // first is a job row id (lease internals) and the second is the
            // connection-local sequence the opaque cursor exists to hide.
            Value::Object(projected)
        })
        .collect();
    Ok(json!({
        "events": events,
        "nextCursor": page.next_cursor,
        "hasMore": page.has_more,
    }))
}

// ---------------------------------------------------------------------------
// oort_conversation_read
// ---------------------------------------------------------------------------

async fn conversation_read(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let channel_id = required_uuid(args, "channelId")?;
    let before = optional_i64(args, "before")?;
    let after = optional_i64(args, "after")?;
    let limit = clamp_history_limit(optional_i64(args, "limit")?);
    let cursor = HistoryCursor::from_query(before, after);

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_MESSAGES_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            // Two independent gates, one answer: see `gated_channel_page`.
            Ok(
                gated_channel_page(conn, caller, &identity, channel_id, cursor, limit)
                    .await?
                    .ok_or(ToolFailure::Unavailable),
            )
        })
    })
    .await
    .map_err(|error| internal("agent_port.conversation_read", error))?;

    outcome
}

/// The ONE definition of "this hosted agent may read this channel's history"
/// (ADR-0162 D3: `oort_conversation_read`'s gate), shared by every tool that
/// returns conversation content — `oort_conversation_read` itself, the fresh
/// window `oort_jobs_claim` carries and the one `oort_job_start` carries
/// (#3831, ADR-0162 증보 4). A second copy of this check is how a convenience
/// tool would quietly become a wider door, so there is none.
///
/// Two independent gates, one answer. A channel outside the human's approval and
/// a channel the agent is not a member of are both `None`, and so is a channel
/// that does not exist — the read must not become a workspace directory. The
/// caller proves the `messages:read` scope on both halves of the intersection
/// before it gets here (`authorize_in_tx` for the read tool,
/// [`job_conversation`] for the composites).
async fn gated_channel_page(
    conn: &mut PgConnection,
    caller: HostedCaller,
    identity: &HostedToolIdentity,
    channel_id: Uuid,
    cursor: HistoryCursor,
    limit: i64,
) -> Result<Option<Value>, DbError> {
    if !identity.approved_channel_ids.contains(&channel_id)
        || !is_channel_member(conn, channel_id, caller.agent_member_id).await?
    {
        return Ok(None);
    }
    let page = list_channel_page(conn, channel_id, cursor, limit).await?;
    // The **image** files attached to these messages (ADR-0186 증보 v3
    // V3-2a): an agent can only propose a workspace file as its avatar if
    // it can name one, and the attachment id is that name. Only complete
    // PNG/JPEG/WebP rows of messages in a channel this read already
    // authorised; the Drive file id is never projected.
    let message_ids: Vec<Uuid> = page.iter().map(|paged| paged.message.id).collect();
    let images = momo_messaging::image_attachments_for_messages_in_tx(
        conn,
        caller.workspace_id,
        &message_ids,
    )
    .await?;
    let messages: Vec<Value> = page
        .iter()
        .map(|paged| {
            let message = &paged.message;
            let mut value = json!({
                "id": message.id,
                "seq": message.seq,
                "channelId": message.channel_id,
                "authorMemberId": message.author_member_id,
                "type": message.message_type.as_db_label(),
                "state": message.state,
                "body": message.body,
                "rootId": message.root_id,
                "replyToId": message.reply_to_id,
                "createdAtMs": crate::routes::shared::epoch_ms(message.created_at),
            });
            let attached: Vec<Value> = images
                .iter()
                .filter(|(message_id, ..)| *message_id == message.id)
                .map(|(_, id, name, mime, size_bytes)| {
                    json!({"id": id, "name": name, "mime": mime, "sizeBytes": size_bytes})
                })
                .collect();
            if !attached.is_empty() && message.state != "deleted" {
                if let Some(object) = value.as_object_mut() {
                    object.insert("imageAttachments".into(), Value::Array(attached));
                }
            }
            value
        })
        .collect();
    let next_before = page.iter().map(|paged| paged.message.seq).min();
    Ok(Some(
        json!({"messages": messages, "nextBefore": next_before}),
    ))
}

/// The latest messages of a job's channel for a composite tool, or `None` when
/// the caller may not read them (#3831). Exactly [`gated_channel_page`] plus the
/// `messages:read` scope on both halves — the scope `oort_conversation_read`
/// requires, nothing looser. Never an error: a composite whose conversation is
/// withheld still delivers its job.
async fn job_conversation(
    conn: &mut PgConnection,
    caller: HostedCaller,
    identity: &HostedToolIdentity,
    channel_id: Uuid,
) -> Result<Option<Value>, DbError> {
    if !has_scope(identity, momo_auth::SCOPE_MESSAGES_READ) {
        return Ok(None);
    }
    let mut page = gated_channel_page(
        conn,
        caller,
        identity,
        channel_id,
        HistoryCursor::Newest,
        JOB_CONVERSATION_ROWS,
    )
    .await?;
    if let Some(messages) = page
        .as_mut()
        .and_then(|page| page.get_mut("messages"))
        .and_then(Value::as_array_mut)
    {
        for message in messages {
            elide_long_body(message);
        }
    }
    Ok(page)
}

/// The most characters of one message body a composite tool returns (the agent
/// context window's own elision bound). A longer body is cut at a character
/// boundary and flagged `bodyTruncated`; `oort_conversation_read` returns it whole.
/// Together with [`JOB_CONVERSATION_ROWS`] this bounds a composite's conversation
/// to 30 × 2 000 characters (#3831 security review M1).
const JOB_CONVERSATION_BODY_CHARS: usize = 2_000;

fn elide_long_body(message: &mut Value) {
    let Some(body) = message.get("body").and_then(Value::as_str) else {
        return;
    };
    if body.chars().count() <= JOB_CONVERSATION_BODY_CHARS {
        return;
    }
    let cut: String = body.chars().take(JOB_CONVERSATION_BODY_CHARS).collect();
    message["body"] = Value::String(cut);
    message["bodyTruncated"] = Value::Bool(true);
}

/// The rows of recent conversation a job carries — the agent context window's own
/// default, so a composite never returns more than a mention turn is built from.
const JOB_CONVERSATION_ROWS: i64 = momo_agent::mention::CONTEXT_WINDOW_DEFAULT;

/// `oort_jobs_claim` attaches the live conversation to at most this many jobs of
/// one call: the claim limit is up to 100, and 100 × 30 rows is not a response.
const CLAIM_CONVERSATION_JOBS: usize = 5;

/// The channel a job's payload names (the claim already required it to be in the
/// live approved set).
fn job_channel_id(payload: &Value) -> Option<Uuid> {
    payload
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

// ---------------------------------------------------------------------------
// oort_message_post
// ---------------------------------------------------------------------------

async fn message_post(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let channel_id = required_uuid(args, "channelId")?;
    let client_msg_id = required_uuid(args, "clientMsgId")?;
    let body = required_str(args, "body", 8_000)?.to_string();
    let root_id = optional_uuid(args, "rootId")?;
    let reply_to_id = optional_uuid(args, "replyToId")?;
    let mention_body = body.clone();
    let gateway_enabled = state.agent_gateway.enabled();
    let hosted_delivery_enabled = state.agent_port.config.hosted_delivery_enabled;
    let subscription_agents_enabled = state.agent_port.config.subscription_agents_enabled;
    let claude_subscription_agents_enabled =
        state.agent_port.config.claude_subscription_agents_enabled;
    // #3948: the operator's attestation, read once per send (an env value, not a row).
    let connector_trial = state.cohosted.config.attest();
    let context_max_messages = state.mentions.context_max_messages;

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_MESSAGES_WRITE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            if !identity.approved_channel_ids.contains(&channel_id)
                || !is_channel_member(conn, channel_id, caller.agent_member_id).await?
            {
                return Ok(Err(ToolFailure::Unavailable));
            }
            if let Some(root_id) = root_id {
                if validate_thread_root_in_tx(conn, channel_id, root_id)
                    .await?
                    .is_err()
                {
                    return Ok(Err(ToolFailure::InvalidArguments));
                }
            }
            if let Some(reply_to_id) = reply_to_id {
                if validate_quote_target_in_tx(conn, channel_id, reply_to_id)
                    .await?
                    .is_err()
                {
                    return Ok(Err(ToolFailure::InvalidArguments));
                }
            }

            // THE send transaction — the same function `routes::messages::send`
            // calls, so `channel_seq`, the `client_msg_id` unique index, the
            // message INSERT and the outbox INSERT are one implementation. No
            // attachment, signature or stream-open surface is exposed here;
            // that is a narrowing of one path, not a second one.
            let sent = momo_messaging::send_message_with_mentions_in_tx(
                conn,
                caller.workspace_id,
                NewMessage {
                    channel_id,
                    author_member_id: caller.agent_member_id,
                    message_type: MessageType::Text,
                    body: Some(body),
                    props: json!({}),
                    root_id,
                    reply_to_id,
                    client_msg_id: Some(client_msg_id),
                    run_id: None,
                    hlc_ts: None,
                    hlc_count: None,
                },
                SendExtras {
                    signature: None,
                    attachment_ids: &[],
                    via_token_id: Some(caller.token_id),
                    opens_stream: false,
                    subscription_agents_disabled: !subscription_agents_enabled,
                    claude_subscription_agents_disabled: !claude_subscription_agents_enabled,
                },
            )
            .await?;
            let sent = match sent {
                Ok(sent) => sent,
                Err(_) => return Ok(Err(ToolFailure::Conflict)),
            };

            // The mention pass, exactly as the REST send runs it and with the
            // same `author_is_agent` verdict — so an agent-authored mention is
            // still skipped and audited rather than starting an uncapped A2A
            // hop. Skipped entirely on a deduped retry, like REST.
            if !sent.deduped {
                if let Err(rejection) = route_agent_mentions_in_tx(
                    conn,
                    MentionSend {
                        workspace_id: caller.workspace_id,
                        channel_id,
                        message_id: sent.message.id,
                        message_seq: sent.message.seq,
                        root_id: sent.message.root_id,
                        author_member_id: caller.agent_member_id,
                        author_is_agent: true,
                        author_is_human: false,
                        body: &mention_body,
                        hlc_ts: sent.message.hlc_ts,
                        via_token_id: Some(caller.token_id),
                        gateway_enabled,
                        hosted_delivery_enabled,
                        subscription_agents_enabled,
                        claude_subscription_agents_enabled,
                        connector_trial: &connector_trial,
                        context_max_messages,
                        // An agent's send never raises the in-place card (G1).
                        inplace_grant_enabled: false,
                        routing: None,
                    },
                )
                .await?
                {
                    return Ok(Err(failure_of(&rejection)));
                }
            }
            Ok(Ok((sent.message.id, sent.message.seq, sent.deduped)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.message_post", error))?;

    let (message_id, seq, deduped) = outcome?;
    Ok(json!({"messageId": message_id, "seq": seq, "deduplicated": deduped}))
}

// ---------------------------------------------------------------------------
// oort_jobs_claim
// ---------------------------------------------------------------------------

/// The job payload projection a hosted adapter receives.
///
/// A whitelist, not a redaction pass: the payload is server-composed and will
/// grow keys, and an allow-list means a new one has to be *added* here before it
/// can reach a client. `run_id` is deliberately absent — the run identity lives
/// inside the sealed handle, which is what makes the handle the only way to act
/// on the work.
fn projected_job_payload(payload: &Value) -> Value {
    let mut projected = Map::new();
    for (source, target) in [
        ("channel_id", "channelId"),
        ("author_member_id", "authorMemberId"),
        ("trigger_message_id", "triggerMessageId"),
        ("trigger_message_seq", "triggerMessageSeq"),
        ("model", "model"),
        ("effort", "effort"),
        ("prompt", "prompt"),
        ("system_prompt", "systemPrompt"),
        ("recent_messages", "recentMessages"),
        ("tools", "tools"),
        ("enabled_tools", "enabledTools"),
        ("max_output_tokens", "maxOutputTokens"),
        ("created_at_ms", "createdAtMs"),
        // ADR-0162 증보 5 W2 (#3851): present only on a thread-reply wake
        // (`"thread_reply"`); a mention's job has no such key, so its projection
        // is byte-for-byte what it was.
        ("wake_reason", "wakeReason"),
        // ADR-0113 증보 2 E10 (#4054): the 「요약만」 instruction for a job whose granted
        // apps include a personal one. A fixed server sentence plus app ids; absent
        // when the job asks nothing, so an ordinary job's projection is unchanged.
        // (`tool_grants`, the grant evidence, is deliberately NOT projected.)
        (momo_agent::APP_RESULT_POLICY_KEY, "appResultPolicy"),
    ] {
        if let Some(value) = payload.get(source) {
            projected.insert(target.to_string(), value.clone());
        }
    }
    Value::Object(projected)
}

async fn jobs_claim(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let limit = momo_outbox::clamp_claim_limit(optional_i64(args, "limit")?);
    let secret = state.agent_port.envelope_secret().to_string();
    let lease_seconds = state.agent_port.config.hosted_lease_seconds;

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_JOBS_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            momo_outbox::retire_settled_run_hosted_jobs_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
            )
            .await
            .map_err(DbError::from)?;
            let claimed = momo_outbox::claim_hosted_gateway_jobs_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                identity.connection_id,
                limit,
                lease_seconds,
            )
            .await
            .map_err(DbError::from)?;

            let mut jobs = Vec::with_capacity(claimed.len());
            for job in claimed {
                // Defence in depth: the hosted claim already refuses to lease a
                // row whose `payload.run_id` is not uuid-shaped, so this branch
                // is unreachable. It stays because the alternative to a skip
                // here would be handing out a handle no later verb could use.
                let Ok(run_id) = Uuid::parse_str(job.run_id_field()) else {
                    continue;
                };
                // The channel the work came from, sealed into the handle so
                // every later verb can re-check the human's exact-channel
                // grant. Unreachable-but-defensive for the same reason the run
                // id is: the claim already required this channel to be in the
                // live approved set, and a handle without one could not carry
                // the grant forward.
                let Some(job_channel_id) = job_channel_id(&job.payload) else {
                    continue;
                };
                let job_channel_id_value = job_channel_id;
                let handle = encode_lease_handle(
                    LeaseHandle {
                        workspace_id: caller.workspace_id,
                        agent_member_id: caller.agent_member_id,
                        connection_id: identity.connection_id,
                        channel_id: job_channel_id,
                        run_id,
                        job_id: job.id,
                        lease_id: job.lease_id,
                    },
                    &secret,
                )
                .map_err(|_| {
                    DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                        "lease handle issuance failed".into(),
                    ))
                })?;
                // ADR-0200 D1/D2: the run's `claimed` fact (time and who) in the
                // run event ledger, same transaction as the lease. A re-claim after
                // an expired lease is a new `claimed` row, which is what happened.
                momo_agent::append_run_event_in_tx(
                    conn,
                    caller.workspace_id,
                    run_id,
                    momo_agent::AppendedRunEvent::Claimed,
                    caller.agent_member_id,
                )
                .await?;
                let mut entry = json!({
                    "leaseHandle": handle,
                    "createdAtMs": crate::routes::shared::epoch_ms(job.created_at),
                    "leaseExpiresAtMs": crate::routes::shared::epoch_ms(job.lease_expires_at),
                    "work": projected_job_payload(&job.payload),
                });
                // #3831 (ADR-0162 증보 4): the live latest-messages page of the
                // job's channel, under exactly `oort_conversation_read`'s gate
                // (`job_conversation`). Bounded: one page per job, for the first
                // few jobs of the call. `work.recentMessages` stays what it was —
                // the snapshot taken when the job was queued.
                if jobs.len() < CLAIM_CONVERSATION_JOBS {
                    if let Some(conversation) =
                        job_conversation(conn, caller, &identity, job_channel_id_value).await?
                    {
                        entry["conversation"] = conversation;
                    }
                }
                jobs.push(entry);
            }
            Ok(Ok(jobs))
        })
    })
    .await
    .map_err(|error| internal("agent_port.jobs_claim", error))?;

    Ok(json!({"jobs": outcome?}))
}

// ---------------------------------------------------------------------------
// oort_job_start (#3831, ADR-0162 증보 4)
// ---------------------------------------------------------------------------

/// The step name of the start report when the caller names none. Plain text under
/// the same character rule as any `stage` (it is validated like one in tests).
const DEFAULT_START_STAGE: &str = "시작: 요청 확인";

/// `oort_job_start` `closed` values (#3903, ADR-0162 증보 6): why a resume gets no job.
const CLOSED_RUN_SETTLED: &str = "run_settled";
const CLOSED_RUN_AWAITING_APPROVAL: &str = "run_awaiting_approval";

fn closed_reason(status: momo_agent::RunStatus) -> Option<&'static str> {
    if status.is_terminal() {
        Some(CLOSED_RUN_SETTLED)
    } else if status == momo_agent::RunStatus::AwaitingApproval {
        Some(CLOSED_RUN_AWAITING_APPROVAL)
    } else {
        None
    }
}

/// Claim one job, send its start report and read the recent conversation, in ONE
/// transaction — the round trips between "the inbox shows a job" and "the
/// person's screen says it started" were the dominant cost of a hosted turn
/// (#3830 measured 39.6 s + 86 s of model turns for what are three mechanical
/// calls).
///
/// Nothing here is a new authority; every part is an existing tool's own check,
/// re-proved inside this transaction:
///
/// * the claim is `oort_jobs_claim`'s (`agent:jobs:read`, the live approved
///   channel set, hosted connection), with `limit` fixed at 1;
/// * the start report is `oort_run_event`'s (`agent:runs:callback`, the lease
///   check, the terminal and approval-hold refusals) — a token without that
///   scope is refused BEFORE anything is claimed, so a half-started job never
///   exists;
/// * the conversation is `oort_conversation_read`'s gate verbatim
///   ([`job_conversation`]: `messages:read`, approved channel, membership). When it
///   does not hold the key is absent and the job is still delivered.
///
/// **Idempotent.** The start report's event id is derived from the lease, so a
/// replay is one marker and one step (the existing `eventId` retry path). A caller
/// that already holds the job passes its `leaseHandle`: the same handle check
/// every lease verb makes, then the same job, report and conversation come back
/// with no second `claimed` row.
async fn job_start(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = optional_str(args, "leaseHandle", 512)?
        .filter(|raw| !raw.is_empty())
        .map(str::to_string);
    // Judged before anything is claimed: a bad step name must not leave a leased
    // job behind with no start report.
    let stage = match optional_str(args, "stage", momo_mcp::MAX_STAGE_BYTES as usize)? {
        Some(raw) => validated_gateway_stage(raw).map_err(|_| ToolFailure::InvalidArguments)?,
        None => DEFAULT_START_STAGE.to_string(),
    };
    let secret = state.agent_port.envelope_secret().to_string();
    let lease_seconds = state.agent_port.config.hosted_lease_seconds;

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_JOBS_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            if !has_scope(&identity, momo_auth::SCOPE_AGENT_RUNS_CALLBACK) {
                return Ok(Err(ToolFailure::NotAuthorized));
            }
            let resumed = raw_handle.is_some();
            let job = match raw_handle.as_deref() {
                Some(raw) => {
                    let handle = match bound_handle(&identity, caller, raw, &secret) {
                        Ok(handle) => handle,
                        Err(failure) => return Ok(Err(failure)),
                    };
                    // #3903 — a handle whose run is no longer the agent's to work gets
                    // a CLOSED answer instead of a generic refusal: a parked run
                    // (`awaiting_approval`) is waiting for a person, a settled run is
                    // over. Both say "stop, do not re-enter", nothing is claimed or
                    // reported, and the answer reveals only the state of the run the
                    // caller's own sealed handle names.
                    if let Some(closed) =
                        momo_agent::lock_gateway_run_in_tx(conn, caller.workspace_id, handle.run_id)
                            .await?
                            .and_then(|run| closed_reason(run.status))
                    {
                        if closed == CLOSED_RUN_SETTLED {
                            momo_outbox::retire_settled_run_hosted_jobs_in_tx(
                                conn,
                                caller.workspace_id,
                                caller.agent_member_id,
                            )
                            .await
                            .map_err(DbError::from)?;
                        }
                        return Ok(Ok(json!({
                            "job": null,
                            "started": false,
                            "resumed": true,
                            "closed": closed,
                        })));
                    }
                    match momo_outbox::read_hosted_leased_job_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                        GatewayLeaseBinding {
                            job_id: handle.job_id,
                            lease_id: handle.lease_id,
                        },
                    )
                    .await
                    .map_err(DbError::from)?
                    {
                        Some(job) => job,
                        // A lease someone else now holds, or a job already settled.
                        None => return Ok(Err(ToolFailure::Conflict)),
                    }
                }
                None => {
                    momo_outbox::retire_settled_run_hosted_jobs_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                    )
                    .await
                    .map_err(DbError::from)?;
                    let claimed = momo_outbox::claim_hosted_gateway_jobs_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                        identity.connection_id,
                        1,
                        lease_seconds,
                    )
                    .await
                    .map_err(DbError::from)?;
                    match claimed.into_iter().next() {
                        Some(job) => job,
                        None => {
                            return Ok(Ok(json!({"job": null, "started": false, "resumed": false})))
                        }
                    }
                }
            };
            // The same defence-in-depth the claim has: the hosted claim already
            // required both ids to be well-formed, so this is unreachable.
            let (Ok(run_id), Some(job_channel)) = (
                Uuid::parse_str(job.run_id_field()),
                job_channel_id(&job.payload),
            ) else {
                return Ok(Err(ToolFailure::Unavailable));
            };
            let lease = GatewayLeaseBinding {
                job_id: job.id,
                lease_id: job.lease_id,
            };
            let handle = encode_lease_handle(
                LeaseHandle {
                    workspace_id: caller.workspace_id,
                    agent_member_id: caller.agent_member_id,
                    connection_id: identity.connection_id,
                    channel_id: job_channel,
                    run_id,
                    job_id: job.id,
                    lease_id: job.lease_id,
                },
                &secret,
            )
            .map_err(|_| {
                DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                    "lease handle issuance failed".into(),
                ))
            })?;
            if !resumed {
                momo_agent::append_run_event_in_tx(
                    conn,
                    caller.workspace_id,
                    run_id,
                    momo_agent::AppendedRunEvent::Claimed,
                    caller.agent_member_id,
                )
                .await?;
            }
            // The start report: `oort_run_event`'s own transaction body. Keyed on
            // the lease, so it is one report per lease however often this is
            // called. A refusal (a parked or settled run) does not take the job
            // back — the caller learns `started: false` and can act on the lease.
            let started = record_gateway_event_in_tx(
                conn,
                caller.workspace_id,
                GatewayEventInput {
                    run_id,
                    lease,
                    status: "running",
                    detail: None,
                    text_delta: None,
                    stage: Some(stage),
                    event_id: Uuid::new_v5(&job.lease_id, b"oort_job_start"),
                    actor_member_id: Some(caller.agent_member_id),
                    via_token_id: Some(caller.token_id),
                    hosted_lease: true,
                },
            )
            .await?
            .is_ok();
            let conversation = job_conversation(conn, caller, &identity, job_channel).await?;
            let mut answer = json!({
                "job": {
                    "leaseHandle": handle,
                    "createdAtMs": crate::routes::shared::epoch_ms(job.created_at),
                    "leaseExpiresAtMs": crate::routes::shared::epoch_ms(job.lease_expires_at),
                    "work": projected_job_payload(&job.payload),
                },
                "started": started,
                "resumed": resumed,
            });
            if let Some(conversation) = conversation {
                answer["conversation"] = conversation;
            }
            Ok(Ok(answer))
        })
    })
    .await
    .map_err(|error| internal("agent_port.job_start", error))?;

    outcome
}

// ---------------------------------------------------------------------------
// oort_job_renew / oort_job_release
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaseVerb {
    Renew,
    Release,
}

/// Open a handle and prove it belongs to **this** caller and connection.
///
/// The binding lives inside the sealed plaintext, so a handle stolen from
/// another connection fails here — before any lease statement runs and without
/// telling the caller whether that job exists.
fn bound_handle(
    identity: &HostedToolIdentity,
    caller: HostedCaller,
    raw: &str,
    secret: &str,
) -> Result<LeaseHandle, ToolFailure> {
    let handle = decode_lease_handle(raw, secret).map_err(|_| ToolFailure::HandleRefused)?;
    if handle.workspace_id != caller.workspace_id
        || handle.agent_member_id != caller.agent_member_id
        || handle.connection_id != identity.connection_id
        // The human's exact-channel grant, re-read from the connection inside
        // this transaction. A lease taken while a channel was approved stops
        // authorizing the moment the approval is narrowed, so a revocation
        // reaches work already in flight and not merely the next claim.
        || !identity.approved_channel_ids.contains(&handle.channel_id)
    {
        return Err(ToolFailure::HandleRefused);
    }
    Ok(handle)
}

async fn job_lease(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
    verb: LeaseVerb,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "leaseHandle", 512)?.to_string();
    let secret = state.agent_port.envelope_secret().to_string();
    let lease_seconds = state.agent_port.config.hosted_lease_seconds;

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_JOBS_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            let lease = GatewayLeaseBinding {
                job_id: handle.job_id,
                lease_id: handle.lease_id,
            };
            match verb {
                LeaseVerb::Renew => {
                    let expires = momo_outbox::renew_hosted_gateway_lease_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                        lease,
                        lease_seconds,
                    )
                    .await
                    .map_err(DbError::from)?;
                    Ok(match expires {
                        Some(expires) => Ok(json!({
                            "status": "renewed",
                            "leaseExpiresAtMs": crate::routes::shared::epoch_ms(expires)
                        })),
                        None => Err(ToolFailure::Conflict),
                    })
                }
                LeaseVerb::Release => {
                    // **ADR-0186 D2 — a parked run may not be handed back.**
                    //
                    // Releasing the lease is how an agent says "I am not doing
                    // this job"; on a run that is waiting for a human decision
                    // that would strand the approval: the card stays pending,
                    // the job returns to the pool, and the next claim finds a
                    // run it cannot park again. `oort_run_complete` already
                    // refuses an approval hold inside
                    // `complete_gateway_run_in_tx` (agent_gateway.rs), and this
                    // is the same refusal on the lease verb that has no run
                    // check of its own — `momo-outbox` knows about leases, not
                    // runs, so the check belongs here.
                    //
                    // Renew is deliberately NOT guarded: keeping a lease alive
                    // while a person decides is exactly what a well-behaved
                    // adapter should be able to do.
                    // **`AwaitingApproval` only, and fail-closed when the run
                    // cannot be read.**
                    //
                    // Not `is_approval_held()`: that predicate also covers
                    // `Paused`, and refusing to release a paused run's lease
                    // would be a behaviour change outside ADR-0186's scope —
                    // pausing is a person stopping work, and handing the job
                    // back is a reasonable thing to do with it.
                    //
                    // A `None` run is refused rather than allowed through. The
                    // loader returns `None` for a run whose agent left the
                    // channel or is no longer active, which is exactly the state
                    // in which a stranded card is most likely and least
                    // recoverable — and releasing a lease we cannot prove is
                    // unparked would do it silently. `Unavailable` (not
                    // `Conflict`) because the run is unreachable rather than in
                    // a refusing state, which is the same distinction every
                    // other tool here draws.
                    match momo_agent::lock_gateway_run_in_tx(
                        conn,
                        caller.workspace_id,
                        handle.run_id,
                    )
                    .await?
                    {
                        Some(run) if run.status == momo_agent::RunStatus::AwaitingApproval => {
                            return Ok(Err(ToolFailure::Conflict));
                        }
                        Some(_) => {}
                        None => return Ok(Err(ToolFailure::Unavailable)),
                    }
                    let released = momo_outbox::release_gateway_lease_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                        lease,
                    )
                    .await
                    .map_err(DbError::from)?;
                    Ok(if released {
                        Ok(json!({"status": "released"}))
                    } else {
                        Err(ToolFailure::Conflict)
                    })
                }
            }
        })
    })
    .await
    .map_err(|error| internal("agent_port.job_lease", error))?;

    outcome
}

// ---------------------------------------------------------------------------
// oort_run_event / oort_run_complete
// ---------------------------------------------------------------------------

async fn run_event(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "leaseHandle", 512)?.to_string();
    // The same byte ceilings the published schema declares — a reader looser
    // than the advertised bound would accept an argument the client was told
    // was invalid, which is the divergence this whole layer exists to remove.
    let (status, detail, text_delta) = validated_event_fields(
        optional_str(args, "status", 64)?,
        optional_str(args, "detail", 2_048)?,
        optional_str(args, "textDelta", 8_192)?,
    )
    .map_err(|error| failure_of(&error))?;
    let event_id = optional_uuid(args, "eventId")?.unwrap_or_else(Uuid::new_v4);
    // Read here, judged inside the transaction: a refused marker leaves an audit
    // row, and a row needs the caller's run to be proven first (D15).
    let raw_stage = match args.get("stage") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) if raw.len() <= momo_mcp::MAX_STAGE_BYTES as usize => {
            Some(raw.clone())
        }
        Some(_) => return Err(ToolFailure::InvalidArguments),
    };
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_RUNS_CALLBACK).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            let stage = match raw_stage
                .as_deref()
                .map(validated_gateway_stage)
                .transpose()
            {
                Ok(stage) => stage,
                Err(reason) => {
                    let lease = GatewayLeaseBinding {
                        job_id: handle.job_id,
                        lease_id: handle.lease_id,
                    };
                    let standing = report_standing_in_tx(
                        conn,
                        caller.workspace_id,
                        handle.run_id,
                        caller.agent_member_id,
                        lease,
                        true,
                    )
                    .await?;
                    if standing == ReportStanding::Live {
                        write_report_rejected_audit(
                            conn,
                            caller.workspace_id,
                            handle.run_id,
                            caller.agent_member_id,
                            Some(caller.token_id),
                            momo_mcp::TOOL_RUN_EVENT,
                            reason,
                            None,
                        )
                        .await?;
                        return Ok(Err(ToolFailure::InvalidArguments));
                    }
                    // Not live: drop the marker and let the ordinary lease
                    // verdict answer (no audit row for a dead handle).
                    None
                }
            };
            let recorded = record_gateway_event_in_tx(
                conn,
                caller.workspace_id,
                GatewayEventInput {
                    run_id: handle.run_id,
                    lease: GatewayLeaseBinding {
                        job_id: handle.job_id,
                        lease_id: handle.lease_id,
                    },
                    status,
                    detail,
                    text_delta,
                    stage,
                    event_id,
                    actor_member_id: Some(caller.agent_member_id),
                    via_token_id: Some(caller.token_id),
                    hosted_lease: true,
                },
            )
            .await?;
            Ok(recorded.map_err(|error| lease_failure_of(&error)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.run_event", error))?;

    outcome?;
    Ok(json!({"status": "accepted"}))
}

async fn run_complete(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "leaseHandle", 512)?.to_string();
    let status = required_str(args, "status", 32)?;
    let error_text = optional_str(args, "error", 4_000)?;
    let succeeded = momo_agent::completion_status(Some(status), error_text)
        .map_err(|_| ToolFailure::InvalidArguments)?;
    // Redacted here, before the text can reach `message.body` and be broadcast
    // to every member of the channel — the same call the REST callback makes.
    let safe_error = sanitized_gateway_error(error_text, &state.agent_gateway.secret);
    let body = optional_str(args, "body", 8_000)?.map(str::to_string);
    let (usage, usage_detail) = usage_from_arguments(args)?;
    let raw_artifacts = args.get("artifacts").cloned();
    // E8 — format-checked here, outside the transaction, so a malformed report
    // never opens one. The lease is untouched, so the agent can complete again
    // without (or with a corrected) `appsUsed`.
    let apps_used =
        validated_apps_used(args.get("appsUsed")).map_err(|_| ToolFailure::InvalidArguments)?;
    // #4054 — the site's 「막힘」 report, refused whole when malformed (the agent
    // can fix its call). A hosted connection cannot be told to be a Mac or Hermes
    // from here, so the notice carries no `site`.
    let app_notice = validated_app_notice(args.get("appNotice"), None)
        .map_err(|_| ToolFailure::InvalidArguments)?;
    let secret = state.agent_port.envelope_secret().to_string();
    let subscription_agents_enabled = state.agent_port.config.subscription_agents_enabled;
    let claude_subscription_agents_enabled =
        state.agent_port.config.claude_subscription_agents_enabled;

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_RUNS_CALLBACK).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            // D12 — a malformed `artifacts` (or, ADR-0162 증보 5 C1, a broken
            // result-contract cross rule) refuses the WHOLE completion before
            // anything is written; the audit row is the only trace, and the lease
            // is untouched so the agent can fix the named field and complete again.
            let artifacts = match validated_gateway_artifacts(
                raw_artifacts.as_ref(),
                momo_t3::work_share::allowed_pr_hosts(),
            ) {
                Ok(artifacts) => artifacts,
                Err(refusal) => {
                    let lease = GatewayLeaseBinding {
                        job_id: handle.job_id,
                        lease_id: handle.lease_id,
                    };
                    let standing = report_standing_in_tx(
                        conn,
                        caller.workspace_id,
                        handle.run_id,
                        caller.agent_member_id,
                        lease,
                        true,
                    )
                    .await?;
                    if standing == ReportStanding::Live {
                        write_report_rejected_audit(
                            conn,
                            caller.workspace_id,
                            handle.run_id,
                            caller.agent_member_id,
                            Some(caller.token_id),
                            momo_mcp::TOOL_RUN_COMPLETE,
                            refusal.reason,
                            Some(refusal.violation),
                        )
                        .await?;
                        // ADR-0162 증보 5 C3 — still -32602, now naming the field
                        // and the closed rule so the agent can fix just that.
                        return Ok(Err(ToolFailure::InvalidArtifacts(refusal.violation)));
                    }
                    // Not live: drop the artifacts and let the ordinary
                    // path answer (a finished run replays its first answer) (no audit row for a dead handle).
                    None
                }
            };
            let completed = complete_gateway_run_in_tx(
                conn,
                caller.workspace_id,
                GatewayCompleteInput {
                    run_id: handle.run_id,
                    // Always present here: a sealed handle cannot exist without
                    // both halves of the binding it was minted from.
                    lease: Some(GatewayLeaseBinding {
                        job_id: handle.job_id,
                        lease_id: handle.lease_id,
                    }),
                    succeeded,
                    body,
                    safe_error,
                    usage,
                    usage_detail,
                    artifacts,
                    apps_used,
                    app_notice,
                    actor_member_id: Some(caller.agent_member_id),
                    via_token_id: Some(caller.token_id),
                    subscription_agents_enabled,
                    claude_subscription_agents_enabled,
                    hosted_lease: true,
                },
            )
            .await?;
            Ok(completed.map_err(|error| lease_failure_of(&error)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.run_complete", error))?;

    let (message_id, seq, status) = outcome?;
    Ok(json!({"status": status, "messageId": message_id, "seq": seq}))
}

// ---------------------------------------------------------------------------
// oort_action_propose
// ---------------------------------------------------------------------------

/// Ask a person to make one workspace change (ADR-0186 D2).
///
/// The whole tool is the approval producer #979 already wrote, called with a
/// different `action_type`:
///
/// 1. the arguments are normalised by the registry's own validators
///    (`routes::actions::validated_action_args`), **outside** the transaction,
///    so a bad proposal never opens one;
/// 2. inside one tenant transaction: the scope is re-proved, the handle's
///    **identity** binding is re-checked (`bound_handle` — workspace, agent,
///    connection and the human's still-current channel approval) and its
///    **lease** is separately proved live and still ours, the run is locked, an
///    `approval` row is inserted, the
///    `approval_request` card goes out through `send_message_in_tx` (the same
///    `channel_seq` bump and the same outbox row a human's message takes), the
///    approval is joined to its card, and the run is parked.
///
/// Everything commits together or not at all, because the two shapes a partial
/// write produces — a parked run with no card, a card with no park — both strand
/// a person waiting on a decision nobody can make.
///
/// **No new outbox producer.** The card's broadcast is `send_message_in_tx`'s
/// own, and no resume job is enqueued: a workspace action's decision executes it
/// directly (AX-3b) rather than handing the run back to a model, which is what
/// `payload.resume_model = null` says out loud.
async fn action_propose(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    // `handle`, not `leaseHandle`: ADR-0186 D2 names the field, and the value is
    // the same sealed `oort_jobs_claim` handle the lease verbs take.
    let raw_handle = required_str(args, "handle", 512)?.to_string();
    let action_id = required_str(args, "actionId", 128)?;
    // ADR-0201 증보 v2 H6: a team-AI-only id through this door answers exactly as
    // an unknown id does — before any argument is read — so an external agent can
    // neither raise the helper's settings cards nor learn that they exist.
    let action = momo_agent::actions::proposable_action_by_id(
        action_id,
        momo_agent::actions::ProposalDoor::AgentPort,
    )
    .ok_or(ToolFailure::InvalidArguments)?;
    let rationale = optional_str(args, "rationale", 280)?.map(str::to_string);
    let raw_args = args.get("args").cloned().unwrap_or_else(|| json!({}));
    // The pure half of the normaliser runs here, **before** a transaction opens,
    // so a malformed proposal never costs one. Resolution against the workspace
    // (ADR-0186 증보 V1-a/b) needs the connection and happens inside, below.
    let proposed_at_ms = chrono::Utc::now().timestamp_millis();
    let pure = crate::routes::actions::validated_action_args(action, &raw_args, proposed_at_ms)
        .map_err(|error| failure_of(&crate::error::ApiError::from(error)))?;
    // **An avatar image is turned into server-made bytes before anything else
    // happens** (ADR-0186 증보 v3 V3-2a): decoded and re-encoded under a timeout, off
    // the async threads, and — for a workspace file — fetched from Drive *outside*
    // any database transaction. Nothing the agent sent survives this step.
    let prepared_avatar = prepare_avatar(state, caller, &pure.args, &raw_handle).await?;
    // **`expression.create`: every candidate is fetched, decoded and re-encoded before the
    // transaction opens** (ADR-0218 D2: decoding never holds a row lock). A link goes through
    // the guarded transport, an attachment through Drive, generated bytes through the
    // isolated decoder; nothing the agent sent survives this step but the metadata it named.
    let prepared_expression = prepare_expression(state, caller, &pure.args, &raw_handle).await?;

    let secret = state.agent_port.envelope_secret().to_string();
    let now = chrono::Utc::now();
    let expires_at = momo_agent::default_expires_at(now, momo_agent::DEFAULT_TTL_SECONDS);

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        let mut prepared_expression = prepared_expression;
        Box::pin(async move {
            // **Lock order** (second security review of #3797): the display-name
            // advisory lock is the **first** thing this transaction takes — before
            // `authorize_in_tx`, whose hosted-identity read holds the proposer's member
            // row `FOR SHARE`. An approval and the human `PATCH …/agents/{agent}` take
            // the advisory lock and *then* the target's member row `FOR UPDATE`;
            // proposing in the opposite order (row first, lock second) deadlocks with a
            // concurrent approval of the same agent. The lock is re-entrant, so the
            // resolver's own acquisition later in this transaction is a no-op.
            if matches!(
                action.id,
                momo_agent::actions::ACTION_AGENT_RENAME
                    | momo_agent::actions::ACTION_AGENT_PROFILE_UPDATE
            ) {
                momo_messaging::lock_display_name_namespace_in_tx(conn, caller.workspace_id)
                    .await?;
            }
            // **The agent's unasked-card lock, also first** (ADR-0186 증보 v5 U-d, #4704 PR B —
            // the follow-up of PR A's second security review). The three places an agent may have
            // waiting are shared between what a person asked for (this call) and what the agent
            // raised unasked (`oort_action_initiate`), and each counts and then inserts. The
            // unasked door counts behind this very advisory lock and takes no row lock on the
            // agent's `member`, so the `FOR NO KEY UPDATE` the count below takes would not keep it
            // out: a person's proposal and an unasked card could both read "two" and both raise a
            // third. Taking the lock **before** `authorize_in_tx` (whose identity read share-locks
            // the member row) is the only order that cannot cycle with that door, which holds the
            // lock and then only share-locks. Nothing else takes this key, so it waits on nothing
            // but the agent's own other calls.
            momo_agent::initiative::lock_agent_initiative_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
            )
            .await?;
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            // The same lock the gateway callbacks take: it re-proves that the
            // agent is still an active agent member AND still a member of the
            // run's channel, so an agent removed from the room mid-run cannot
            // raise a card in it.
            let Some(run) =
                momo_agent::lock_gateway_run_in_tx(conn, caller.workspace_id, handle.run_id)
                    .await?
            else {
                return Ok(Err(ToolFailure::Unavailable));
            };
            // **The lease must still be live and still ours** — the same
            // judgment `oort_run_complete` makes through
            // `complete_gateway_run_in_tx`, applied here because parking a run
            // is no less consequential than settling one.
            //
            // `bound_handle` above proves *identity* (workspace, agent,
            // connection, approved channel) and nothing about the lease: a
            // handle whose lease expired and whose job was re-claimed by a
            // newer worker still decodes and still binds. Without this check
            // that stale handle could park the run, and the worker that
            // actually holds the job would then get 409 on every
            // `oort_run_complete` until the one-hour TTL — a turn nobody can
            // finish, caused by a proposal nobody asked for. ADR-0186 D2 gives
            // the park to the lease holder; this is what makes that true.
            //
            // `allow_settled: false` — a done job may be replayed into
            // `run_complete` (the retry window), but never into a new proposal.
            let lease_snapshot = momo_outbox::lock_gateway_lease_in_tx(
                conn,
                caller.workspace_id,
                handle.run_id,
                run.agent_member_id,
                GatewayLeaseBinding {
                    job_id: handle.job_id,
                    lease_id: handle.lease_id,
                },
            )
            .await
            .map_err(DbError::from)?;
            if !momo_outbox::gateway_lease_authorized_hosted(lease_snapshot, handle.lease_id, false)
            {
                return Ok(Err(ToolFailure::Conflict));
            }
            if run.agent_member_id != caller.agent_member_id
                // The channel sealed into the handle is the one the human
                // approved for this connection; the run's own channel is where
                // the card must land. They are the same channel by construction
                // — a disagreement means the handle and the run are not about
                // the same work, and guessing which to believe is not an option.
                || run.channel_id != handle.channel_id
            {
                return Ok(Err(ToolFailure::HandleRefused));
            }
            // A run already parked, already settled, or paused cannot raise a
            // second card. `park_run_for_approval_in_tx` would refuse anyway;
            // answering here means the refusal is `Conflict` rather than an
            // indistinguishable late failure after three writes.
            if run.status.is_approval_held() || run.status.is_terminal() {
                return Ok(Err(ToolFailure::Conflict));
            }
            // **The two "already full" answers come first — for the two actions whose
            // text is judged against the roster** (증보 v3, security review of #3797):
            // `Conflict` must not depend on whether the proposal's *text* passes the
            // roster-name rules, or an agent that already holds a pending proposal
            // could tell 409 from 400 and so probe which names exist. Neither check
            // reads the text: the ceiling counts, and the same-target check resolves
            // only **who the proposal is about**. The other actions keep their order
            // (resolution, then the ceiling), which the v2 suite pins.
            let judges_text_against_roster = matches!(
                action.id,
                momo_agent::actions::ACTION_AGENT_RENAME
                    | momo_agent::actions::ACTION_AGENT_PROFILE_UPDATE
            );
            if judges_text_against_roster {
                // The pending ceiling (증보 V1-e): the agent's `member` row is locked
                // first so concurrent runs of one agent cannot each read "2 pending"
                // and each add a third.
                let pending = momo_agent::lock_agent_and_count_pending_workspace_actions_in_tx(
                    conn,
                    caller.workspace_id,
                    caller.agent_member_id,
                )
                .await?;
                if pending >= momo_agent::MAX_PENDING_WORKSPACE_ACTIONS {
                    return Ok(Err(ToolFailure::Conflict));
                }
                // A second proposal about the same agent while one waits (증보 V4-M-9):
                // the target's row is locked first so two simultaneous proposals
                // cannot both see "none".
                if let Some(target) = crate::routes::actions::early_target_agent_in_tx(
                    conn,
                    caller.workspace_id,
                    caller.agent_member_id,
                    action,
                    &raw_args,
                    proposed_at_ms,
                )
                .await?
                {
                    if momo_agent::lock_target_and_find_pending_action_in_tx(
                        conn,
                        caller.workspace_id,
                        action.id,
                        target,
                    )
                    .await?
                    {
                        return Ok(Err(ToolFailure::Conflict));
                    }
                }
            }
            // **Resolved inside the transaction** (ADR-0186 증보 V1-a/b): names are
            // looked up against the workspace as it is now, and the card rows are
            // built from what was found, never from the agent's strings. A
            // resolution failure is the same `InvalidArguments` as a malformed
            // argument — it never says which name failed.
            let mut resolved = match crate::routes::actions::resolve_action_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                // The run the card is raised in: `member.avatar.set` derives the person
                // it is about from it (and from nothing the agent typed).
                Some(handle.run_id),
                action,
                &raw_args,
                proposed_at_ms,
            )
            .await?
            {
                Ok(resolved) => resolved,
                // Every resolution failure is the one `InvalidArguments`, whatever
                // status the resolver chose: mapping the status through
                // `failure_of` would let a 404 vs a 409 say which name failed.
                Err(_) => return Ok(Err(ToolFailure::InvalidArguments)),
            };
            // The pending ceiling for the actions whose answer does not depend on the
            // roster (증보 V1-e): after resolution, as in v2.
            if !judges_text_against_roster {
                let pending = momo_agent::lock_agent_and_count_pending_workspace_actions_in_tx(
                    conn,
                    caller.workspace_id,
                    caller.agent_member_id,
                )
                .await?;
                if pending >= momo_agent::MAX_PENDING_WORKSPACE_ACTIONS {
                    return Ok(Err(ToolFailure::Conflict));
                }
            }
            // A second rename of the same agent while one waits is refused
            // (증보 V4-M-9): the target's row is locked first so two simultaneous
            // proposals cannot both see "none".
            if let crate::routes::actions::GateSubject::Agent(target)
            | crate::routes::actions::GateSubject::Member(target) = resolved.subject
            {
                if momo_agent::lock_target_and_find_pending_action_in_tx(
                    conn,
                    caller.workspace_id,
                    action.id,
                    target,
                )
                .await?
                {
                    return Ok(Err(ToolFailure::Conflict));
                }
            }
            // `queued → running`, idempotent and non-regressive. A hosted run is
            // still `queued` until its first progress event, and an adapter that
            // claims a job and proposes without reporting progress first is
            // normal — the park below requires `running`.
            // **Stage the avatar image** (V3-2a): the server-re-encoded bytes become a
            // `staged` row for the *target* agent, and the stored arguments, the pins
            // and the card preview all name that row and its sha256 — never the
            // agent's bytes, never an id it chose.
            let mut avatar_preview: Option<Value> = None;
            let mut staged_image_id: Option<Uuid> = None;
            if let Some(prepared) = &prepared_avatar {
                // The image is staged for the **subject** the resolver named: the target
                // agent (`agent.profile.update`) or the person the run was raised by
                // (`member.avatar.set`). The bytes were prepared for one of the two, and a
                // mismatch (the run's requester changed between the two transactions) is a
                // refusal, never a re-aim.
                let target = match (resolved.subject, prepared.for_member) {
                    (crate::routes::actions::GateSubject::Agent(target), None) => target,
                    (crate::routes::actions::GateSubject::Member(target), Some(prepared_for))
                        if target == prepared_for =>
                    {
                        target
                    }
                    _ => return Ok(Err(ToolFailure::InvalidArguments)),
                };
                momo_messaging::purge_stale_staged_avatar_images_in_tx(conn, caller.workspace_id)
                    .await?;
                let image_id = momo_messaging::stage_avatar_image_in_tx(
                    conn,
                    caller.workspace_id,
                    target,
                    caller.agent_member_id,
                    prepared.origin,
                    &prepared.image,
                )
                .await?;
                staged_image_id = Some(image_id);
                let sha256 = hex_lower(&prepared.image.sha256);
                let staged = json!({
                    "source": "staged",
                    "imageId": image_id.to_string(),
                    "sha256": sha256,
                    "origin": prepared.origin,
                });
                if let Some(object) = resolved.validated.normalized.as_object_mut() {
                    object.insert("avatar".into(), staged);
                }
                if let Some(object) = resolved.pins.as_object_mut() {
                    object.insert(
                        "avatar".into(),
                        json!({"imageId": image_id.to_string(), "sha256": sha256}),
                    );
                }
                // Everything here is the server's: ids, hash, measured size.
                avatar_preview = Some(json!({
                    "kind": "avatar_image",
                    "imageId": image_id.to_string(),
                    "sha256": sha256,
                    "mime": prepared.image.mime,
                    "width": prepared.image.width,
                    "height": prepared.image.height,
                    "sizeBytes": prepared.image.bytes.len(),
                    "origin": prepared.origin,
                }));
                if let Some(preview) = avatar_preview.as_mut() {
                    momo_workspace_actions::profile_avatar::add_previous_in_tx(
                        conn,
                        caller.workspace_id,
                        target,
                        preview,
                    )
                    .await?;
                }
            }
            // Backstop for the invariant the handler promises: no raw avatar input
            // (bytes, a file id the agent chose) reaches the stored arguments.
            if let Some(avatar) = resolved.validated.normalized.get("avatar") {
                let source = avatar.get("source").and_then(Value::as_str);
                if matches!(source, Some("generated") | Some("attachment")) {
                    discard_staged(conn, caller.workspace_id, staged_image_id).await?;
                    return Ok(Err(ToolFailure::InvalidArguments));
                }
            }
            // **`expression.create`: what is stored is the ids of the drafts, nothing else**
            // (ADR-0186 v8). The candidates were prepared before this transaction; here they
            // are matched to what the resolver just proved, and the stored arguments become
            // the draft ids. Every refusal is before the park below: a refusal that commits
            // must not leave a parked run behind.
            let mut expression_drafts: Option<(
                Vec<Uuid>,
                Vec<momo_expressions::action::Candidate>,
            )> = None;
            if let crate::routes::actions::ActionArgs::ExpressionCreate { candidates, .. } =
                &resolved.validated.args
            {
                let Some(prepared) = prepared_expression.take() else {
                    return Ok(Err(ToolFailure::InvalidArguments));
                };
                if prepared.len() != candidates.len()
                    || prepared
                        .iter()
                        .zip(candidates.iter())
                        .any(|(prepared, proposed)| prepared.meta != proposed.meta)
                {
                    return Ok(Err(ToolFailure::InvalidArguments));
                }
                let ids: Vec<Uuid> = (0..prepared.len()).map(|_| Uuid::new_v4()).collect();
                resolved.validated.normalized =
                    json!({"drafts": ids.iter().map(Uuid::to_string).collect::<Vec<_>>()});
                expression_drafts = Some((ids, prepared));
            }
            // A pin card's structured preview (ADR-0186 증보 v5 U-e): the ids a client opens the
            // message by and the length the approver weighs the quote against. All of it is the
            // server's reading of the stored message; none of it is the agent's.
            let message_preview: Option<Value> = match &resolved.validated.args {
                crate::routes::actions::ActionArgs::MessagePin {
                    target: Some(target),
                    ..
                } => Some(momo_agent::actions::message_pin_preview(
                    target.id,
                    target.channel_id,
                    &target.card,
                )),
                _ => None,
            };
            momo_agent::mark_run_started_in_tx(conn, handle.run_id).await?;
            // **The park happens before the approval, not after.**
            //
            // Its `status = 'running'` guard is the one thing in this
            // transaction that can legitimately answer "no", and a refusal after
            // the approval row and the card were written would have to roll them
            // back through an error path that cannot carry `Conflict`. Doing it
            // first means the refusal costs nothing and the three writes below
            // are unconditional. The run row is already locked `FOR UPDATE` by
            // the snapshot above, so nothing can move it in between.
            if !momo_agent::park_run_for_approval_in_tx(conn, handle.run_id, expires_at).await? {
                // `with_tenant_tx` commits on a handled refusal: drop the unbound row.
                discard_staged(conn, caller.workspace_id, staged_image_id).await?;
                return Ok(Err(ToolFailure::Conflict));
            }

            let mut payload = momo_agent::workspace_action_payload(
                action.id,
                &resolved.validated.normalized,
                rationale.as_deref(),
                caller.agent_member_id,
            );
            // Bind the card to the authenticated connection that raised it,
            // rather than whichever connection exists when a person decides.
            // The decision resolver re-proves this id without requiring an
            // unexpired access token (#4821, ADR-0186 U-d).
            if resolved.pins.is_null() {
                resolved.pins = json!({});
            }
            resolved.pins["hostedConnection"] = json!(identity.connection_id);
            if let Some(action_block) = payload.get_mut("action").and_then(Value::as_object_mut) {
                // The ids the names resolved to, for the decision to compare.
                action_block.insert("pins".into(), resolved.pins.clone());
            }
            let approval_id = momo_agent::create_pending_approval_in_tx(
                conn,
                caller.workspace_id,
                momo_agent::NewApproval {
                    run_id: handle.run_id,
                    channel_id: run.channel_id,
                    // The **agent** asked. `approval.requested_by` is a member
                    // id like any other, and it is also what makes self-approval
                    // structurally impossible: a decision requires
                    // `member.kind = 'human'`.
                    requested_by: caller.agent_member_id,
                    action_type: momo_agent::ACTION_TYPE_WORKSPACE_ACTION.to_string(),
                    payload,
                    expires_at,
                },
            )
            .await?;
            // The drafts stand behind the approval row (the FK), so they are inserted now, in
            // this same transaction; the card shows them exactly as stored.
            let mut expression_card: Option<Value> = None;
            if let Some((ids, items)) = expression_drafts.take() {
                momo_expressions::action::insert_candidates_in_tx(
                    conn,
                    caller.workspace_id,
                    approval_id,
                    caller.agent_member_id,
                    expires_at,
                    &ids,
                    items,
                )
                .await
                .map_err(crate::routes::approvals::expression_db_error)?;
                expression_card = Some(
                    momo_expressions::action::card_in_tx(conn, caller.workspace_id, approval_id)
                        .await
                        .map_err(crate::routes::approvals::expression_db_error)?,
                );
            }
            let card = send_message_in_tx(
                conn,
                caller.workspace_id,
                NewMessage {
                    channel_id: run.channel_id,
                    author_member_id: caller.agent_member_id,
                    message_type: MessageType::ApprovalRequest,
                    body: Some(momo_agent::workspace_action_request_body(action)),
                    props: {
                        let mut props = momo_agent::workspace_action_request_props(
                            approval_id,
                            handle.run_id,
                            run.channel_id,
                            action,
                            {
                                let mut block = momo_agent::action_block(
                                    action,
                                    resolved.validated.rows.clone(),
                                    rationale.as_deref(),
                                );
                                if let (Some(preview), Some(object)) = (
                                    avatar_preview.as_ref().or(message_preview.as_ref()),
                                    block.as_object_mut(),
                                ) {
                                    object.insert("preview".into(), preview.clone());
                                }
                                // ADR-0218 `Approval`: the candidates as stored, in
                                // `approval_request.props.action.expression`.
                                if let (Some(card), Some(object)) =
                                    (expression_card.as_ref(), block.as_object_mut())
                                {
                                    object.insert("expression".into(), card.clone());
                                }
                                block
                            },
                            expires_at,
                        );
                        // A rename of ANOTHER agent says so in the sentence the
                        // approver reads first (증보 V4).
                        if let (Some(summary), Some(object)) =
                            (&resolved.validated.summary, props.as_object_mut())
                        {
                            object.insert("summary".into(), Value::String(summary.clone()));
                        }
                        props
                    },
                    root_id: None,
                    reply_to_id: None,
                    // A key **derived from** the approval id, not the approval
                    // id itself — see `momo_agent::card_client_msg_id`. The
                    // rejection and expiry `tool_result` lines for this same
                    // approval are authored by this same agent in this same
                    // channel and keyed on `approval.id`, so reusing it here
                    // would make the card and its own outcome line collide on
                    // `message_client_idem_uniq` and silently drop one of them.
                    client_msg_id: Some(momo_agent::card_client_msg_id(approval_id)),
                    run_id: Some(handle.run_id),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?;
            momo_agent::attach_request_message_in_tx(
                conn,
                caller.workspace_id,
                approval_id,
                card.message.id,
            )
            .await?;
            // The staged image belongs to **this** approval, in the database's own
            // record (write-once): a decision accepts it under no other.
            if let Some(image_id) = staged_image_id {
                if !momo_messaging::bind_staged_image_to_approval_in_tx(
                    conn,
                    caller.workspace_id,
                    image_id,
                    approval_id,
                )
                .await?
                {
                    return Err(DbError::from(momo_db::sqlx::Error::RowNotFound));
                }
                // A `member.avatar.set` proposal is on the record the moment it is staged
                // (ids, origin, measured size, a sha256 prefix — never the bytes).
                if action.id == momo_agent::actions::ACTION_MEMBER_AVATAR_SET {
                    if let (Some(preview), crate::routes::actions::GateSubject::Member(person)) =
                        (&avatar_preview, resolved.subject)
                    {
                        let mut detail = preview.clone();
                        if let Some(object) = detail.as_object_mut() {
                            object.remove("kind");
                            object.remove("previousAvatarUrl");
                            if let Some(sha) = object.get("sha256").and_then(Value::as_str) {
                                let prefix = sha.chars().take(12).collect::<String>();
                                object.remove("sha256");
                                object.insert("sha256_prefix".into(), json!(prefix));
                            }
                            object.insert("approval_id".into(), json!(approval_id.to_string()));
                            object.insert(
                                "via_agent".into(),
                                json!(caller.agent_member_id.to_string()),
                            );
                        }
                        momo_db::audit::write_audit(
                            conn,
                            &momo_db::audit::AuditEntry::new(
                                caller.workspace_id,
                                momo_agent::actions::AUDIT_MEMBER_AVATAR_STAGED,
                            )
                            .by(caller.agent_member_id)
                            .about(person)
                            .target("member", person)
                            .run(handle.run_id)
                            .with_schema(
                                momo_agent::actions::AUDIT_MEMBER_AVATAR_STAGED_SCHEMA,
                                detail,
                            ),
                        )
                        .await?;
                    }
                }
            }
            Ok(Ok(json!({
                "approvalId": approval_id,
                "status": "pending",
                "expiresAtMs": expires_at.timestamp_millis(),
                "cardMessageId": card.message.id,
            })))
        })
    })
    .await
    .map_err(|error| internal("agent_port.action_propose", error))?;

    outcome
}

// ---------------------------------------------------------------------------
// avatar images (ADR-0186 증보 2026-10-13 v3, V3-2a)
// ---------------------------------------------------------------------------

/// `expression.create`'s preparation (ADR-0186 v8 X8-1, ADR-0218 D3/D5), all of it **before**
/// any transaction that writes. One short read transaction proves who may propose and which
/// attachments are the requester's (V4's own judgement); then each candidate, in turn and inside
/// one deadline, is fetched and decoded:
///
/// * `attachment`: the file from Drive, then the isolated decoder. A file that is not a
///   picture is the same `InvalidArguments` a stranger's photo is; a video is a manual card
///   (`video_processing_unavailable`, D4 on hold).
/// * `url`: the link through `momo-unfurl`'s guard (HTTPS, 443, address pin, hops, 5 s, 5 MiB).
///   A link that is private **from the start** refuses the whole proposal; every other
///   failure is a manual card with its closed reason and the safe source link.
/// * `generated`: strict base64, at most 1 MiB, then the decoder. Bad bytes are the agent's
///   own fault: `InvalidArguments`, not a card.
///
/// A busy decoder is waited for within the remaining deadline; if no slot comes the call is
/// `Unavailable` (retry), never a `source_timeout` card. What is returned carries pictures and
/// the closed codes only: nothing fetched is ever handed back to the agent as text.
async fn prepare_expression(
    state: &AppState,
    caller: HostedCaller,
    args: &crate::routes::actions::ActionArgs,
    raw_handle: &str,
) -> Result<Option<Vec<momo_expressions::action::Candidate>>, ToolFailure> {
    use crate::routes::actions::{ActionArgs, ExpressionImageSpec};
    use base64::Engine as _;
    use momo_expressions::{intake, media, Origin};
    let ActionArgs::ExpressionCreate { candidates, .. } = args else {
        return Ok(None);
    };
    let started = std::time::Instant::now();
    let remaining = || momo_expressions::action::PREPARE_DEADLINE.saturating_sub(started.elapsed());
    let secret = state.agent_port.envelope_secret().to_string();
    let raw_handle = raw_handle.to_string();
    let wanted: Vec<Option<Uuid>> = candidates
        .iter()
        .map(|candidate| match candidate.image {
            ExpressionImageSpec::Attachment(id) => Some(id),
            _ => None,
        })
        .collect();
    let looked_up = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            let Some(run) =
                momo_agent::lock_gateway_run_in_tx(conn, caller.workspace_id, handle.run_id)
                    .await?
            else {
                return Ok(Err(ToolFailure::Unavailable));
            };
            let Some((requester, channel_id)) = momo_messaging::requester_of_run_in_tx(
                conn,
                caller.workspace_id,
                handle.run_id,
                run.agent_member_id,
            )
            .await?
            else {
                return Ok(Err(ToolFailure::InvalidArguments));
            };
            let mut sources = Vec::with_capacity(wanted.len());
            for attachment in &wanted {
                sources.push(match attachment {
                    None => None,
                    Some(id) => {
                        let found = momo_messaging::find_requester_attachment_in_tx(
                            conn,
                            caller.workspace_id,
                            requester,
                            channel_id,
                            *id,
                            momo_expressions::INPUT_BYTES as i64,
                        )
                        .await?;
                        match found {
                            Some(found) => Some(found),
                            None => return Ok(Err(ToolFailure::InvalidArguments)),
                        }
                    }
                });
            }
            Ok(Ok(sources))
        })
    })
    .await
    .map_err(|error| internal("agent_port.expression_prepare", error))??;

    let mut prepared = Vec::with_capacity(candidates.len());
    for (candidate, source) in candidates.iter().zip(looked_up) {
        if remaining().is_zero() {
            return Err(ToolFailure::Unavailable);
        }
        let (origin, picture) = match &candidate.image {
            ExpressionImageSpec::Attachment(_) => {
                let source = source.ok_or(ToolFailure::InvalidArguments)?;
                let content = state
                    .drive
                    .file_content(&source.drive_file_id, source.size_bytes)
                    .await
                    .map_err(|_| ToolFailure::Unavailable)?;
                let bytes = content
                    .read_prefix(momo_expressions::INPUT_BYTES + 1)
                    .await
                    .map_err(|_| ToolFailure::Unavailable)?;
                if bytes.len() > momo_expressions::INPUT_BYTES {
                    return Err(ToolFailure::InvalidArguments);
                }
                let picture = match intake::picture_or_reason(bytes, Some(remaining())).await {
                    Ok(intake::Picture::Ready(processed)) => (Some(*processed), None),
                    // A video attachment is the one card an attachment may become.
                    Ok(intake::Picture::Manual("video_processing_unavailable")) => {
                        (None, Some("video_processing_unavailable"))
                    }
                    // Not a picture / too big / undecodable: the requester's file is the
                    // wrong file, like another person's photo. No card for it.
                    Ok(intake::Picture::Manual(_)) => return Err(ToolFailure::InvalidArguments),
                    Err(intake::DecoderBusy) => return Err(ToolFailure::Unavailable),
                };
                (Origin::attachment(), picture)
            }
            ExpressionImageSpec::Url(raw) => {
                // Malformed, credentialed, fragment, http, private-from-the-start (any spelling)
                // or a port other than 443: the whole proposal is refused, nothing is stored.
                let url = momo_unfurl::parse_source_url(raw)
                    .map_err(|_| ToolFailure::InvalidArguments)?;
                let origin = Origin::url(url.origin());
                if !state.unfurl_enabled {
                    // The instance's outgoing-request switch is off: no request is made.
                    (origin, (None, Some("source_unavailable")))
                } else {
                    let permit = intake::import_slots()
                        .clone()
                        .try_acquire_owned()
                        .map_err(|_| ToolFailure::Unavailable)?;
                    let deadline = remaining().min(momo_unfurl::SOURCE_DEADLINE);
                    let outcome = match momo_unfurl::fetch_source(
                        &*state.unfurl_http,
                        &url,
                        deadline,
                    )
                    .await
                    {
                        Ok(bytes) => {
                            match intake::picture_or_reason(bytes, Some(remaining())).await {
                                Ok(intake::Picture::Ready(processed)) => (Some(*processed), None),
                                Ok(intake::Picture::Manual(code)) => (None, Some(code)),
                                Err(intake::DecoderBusy) => return Err(ToolFailure::Unavailable),
                            }
                        }
                        Err(refused) if refused.is_private_origin() => {
                            return Err(ToolFailure::InvalidArguments)
                        }
                        Err(refused) => (None, Some(refused.code())),
                    };
                    drop(permit);
                    (origin, outcome)
                }
            }
            ExpressionImageSpec::Generated {
                data_base64,
                prompt,
                ..
            } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_base64)
                    .map_err(|_| ToolFailure::InvalidArguments)?;
                if bytes.len() > 1024 * 1024 {
                    return Err(ToolFailure::InvalidArguments);
                }
                // The bytes decide the format, never the declared mime; a page, a video, a
                // broken picture is the agent's own bad input.
                if media::sniff(&bytes) != media::Sniffed::Image {
                    return Err(ToolFailure::InvalidArguments);
                }
                let processed =
                    media::process_waiting(bytes, remaining())
                        .await
                        .map_err(|rejected| match rejected {
                            media::Rejected::Busy => ToolFailure::Unavailable,
                            _ => ToolFailure::InvalidArguments,
                        })?;
                (
                    Origin {
                        kind: "generated".into(),
                        source_url: None,
                        prompt: Some(prompt.clone()),
                    },
                    (Some(processed), None),
                )
            }
        };
        prepared.push(momo_expressions::action::Candidate {
            meta: candidate.meta.clone(),
            origin,
            media: picture.0,
            code: picture.1,
        });
    }
    Ok(Some(prepared))
}

/// An avatar image the server has already re-encoded, ready to be staged.
struct PreparedAvatar {
    image: momo_messaging::ProcessedAvatar,
    /// `attachment` or `generated` (`agent_avatar_source_ck`).
    origin: &'static str,
    /// The person the bytes were prepared for (`member.avatar.set`: the human the run was
    /// raised by), or `None` for an agent's own picture. The staging step requires the
    /// resolver's subject to be this very person.
    for_member: Option<Uuid>,
}

/// The longest the decode-and-re-encode may run.
const AVATAR_PROCESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How many image decodes may run at once, process-wide. A decode of a tiny file can
/// peak at tens of MiB (the security review of #3799 measured 160–310 MB at 4096² before the
/// shrink-then-rotate order; #4385 measured the 4096 px / 16 MP ceiling), and `spawn_blocking` is not cancelled by the
/// timeout, so without this several agents — or one agent retrying — would multiply
/// that. Two at a time; a third caller waits (still inside the timeout) or is refused.
static AVATAR_DECODE_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

async fn discard_staged(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    staged: Option<Uuid>,
) -> Result<(), DbError> {
    if let Some(image_id) = staged {
        momo_messaging::delete_staged_avatar_image_in_tx(conn, workspace_id, image_id).await?;
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Run the (CPU- and memory-bound) image pass off the async threads and under a
/// timeout. Every failure — a refused image, a join error, the timeout — is the
/// one `InvalidArguments`: which rule the picture broke is not the agent's to learn.
async fn process_avatar_bytes(
    bytes: Vec<u8>,
    max_input: usize,
) -> Result<momo_messaging::ProcessedAvatar, ToolFailure> {
    process_avatar_bytes_coded(bytes, max_input)
        .await
        .map_err(|_| ToolFailure::InvalidArguments)
}

/// [`process_avatar_bytes`] with the **reason** kept, for the audit row only. The code
/// is one of [`momo_messaging::AvatarImageRejected::code`] or `timeout`/`busy`; it is
/// written to `member.avatar.refused` and never returned to the agent.
async fn process_avatar_bytes_coded(
    bytes: Vec<u8>,
    max_input: usize,
) -> Result<momo_messaging::ProcessedAvatar, &'static str> {
    // The permit is taken **inside** the timeout and moved into the blocking task,
    // so it is released when the decode actually ends — not when the caller gives up.
    let work = async move {
        let permit = AVATAR_DECODE_PERMITS.acquire().await.map_err(|_| "busy")?;
        let task = tokio::task::spawn_blocking(move || {
            let _held = permit;
            momo_messaging::process_avatar_image(&bytes, max_input)
        });
        task.await.map_err(|_| "busy")
    };
    match tokio::time::timeout(AVATAR_PROCESS_TIMEOUT, work).await {
        Ok(Ok(Ok(image))) => Ok(image),
        Ok(Ok(Err(rejected))) => Err(rejected.code()),
        Ok(Err(code)) => Err(code),
        Err(_) => Err("timeout"),
    }
}

/// Record that a `member.avatar.set` proposal was refused **before anything was staged**
/// (ADR-0186 증보 v4): who proposed, whom it was about when that is known, and a reason
/// code — never the input. Best effort: the refusal the agent sees does not depend on it.
async fn audit_member_avatar_refused(
    state: &AppState,
    caller: HostedCaller,
    person: Option<Uuid>,
    reason: &'static str,
) {
    let _ = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let mut entry = momo_db::audit::AuditEntry::new(
                caller.workspace_id,
                momo_agent::actions::AUDIT_MEMBER_AVATAR_REFUSED,
            )
            .by(caller.agent_member_id);
            if let Some(person) = person {
                entry = entry.about(person).target("member", person);
            }
            momo_db::audit::write_audit(
                conn,
                &entry.with_schema(
                    momo_agent::actions::AUDIT_MEMBER_AVATAR_REFUSED_SCHEMA,
                    json!({
                        "reason": reason,
                        "via_agent": caller.agent_member_id.to_string(),
                    }),
                ),
            )
            .await?;
            Ok(())
        })
    })
    .await;
}

/// Turn the proposal's avatar input, if it has any, into server-made bytes.
///
/// * `generated` — strict standard base64, decoded size capped well inside the Agent
///   Port's 64 KiB body, then the image pass;
/// * `attachment` — the file must be one **this agent could read** (complete, bound
///   to a live message, in an approved non-DM channel it belongs to; a PNG/JPEG/WebP
///   within 5 MiB). Its bytes come from Drive here, outside any transaction.
///
/// Anything else (no avatar, a preset, a clear) returns `None`.
async fn prepare_avatar(
    state: &AppState,
    caller: HostedCaller,
    args: &crate::routes::actions::ActionArgs,
    raw_handle: &str,
) -> Result<Option<PreparedAvatar>, ToolFailure> {
    use base64::Engine as _;
    if let crate::routes::actions::ActionArgs::MemberAvatarSet {
        avatar: crate::routes::actions::AvatarIntent::Attachment(attachment_id),
        ..
    } = args
    {
        return prepare_member_avatar(
            state,
            caller,
            raw_handle,
            &crate::routes::actions::AvatarIntent::Attachment(*attachment_id),
        )
        .await;
    }
    let avatar = match args {
        crate::routes::actions::ActionArgs::AgentProfileUpdate { avatar, .. }
        | crate::routes::actions::ActionArgs::MemberAvatarSet { avatar, .. } => avatar,
        _ => return Ok(None),
    };
    match avatar {
        crate::routes::actions::AvatarIntent::Generated(encoded) => {
            if matches!(
                args,
                crate::routes::actions::ActionArgs::MemberAvatarSet { .. }
            ) {
                return prepare_member_avatar(state, caller, raw_handle, avatar).await;
            }
            // Authorise before spending decode capacity (A1 review M1): a caller
            // without the propose scope must not be able to occupy the shared permits.
            let allowed = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
                Box::pin(async move {
                    Ok(
                        authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE)
                            .await?
                            .is_ok(),
                    )
                })
            })
            .await
            .map_err(|_| ToolFailure::Unavailable)?;
            if !allowed {
                return Err(ToolFailure::NotAuthorized);
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| ToolFailure::InvalidArguments)?;
            if bytes.len() > momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_GENERATED {
                return Err(ToolFailure::InvalidArguments);
            }
            let image =
                process_avatar_bytes(bytes, momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_GENERATED)
                    .await?;
            Ok(Some(PreparedAvatar {
                image,
                origin: "generated",
                for_member: None,
            }))
        }
        crate::routes::actions::AvatarIntent::Attachment(attachment_id) => {
            let attachment_id = *attachment_id;
            let max = momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT;
            let raw_handle = raw_handle.to_string();
            let secret = state.agent_port.envelope_secret().to_string();
            let found = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
                Box::pin(async move {
                    let identity =
                        match authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE)
                            .await?
                        {
                            Ok(identity) => identity,
                            Err(_) => return Ok(None),
                        };
                    let visible = momo_messaging::find_visible_image_attachment_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                        &identity.approved_channel_ids,
                        attachment_id,
                        max as i64,
                    )
                    .await?;
                    if visible.is_some() {
                        return Ok(visible);
                    }
                    // #4791: a photo the requester sent in this run's conversation
                    // also works in their DM. No routing/DM scope is widened here:
                    // the live connection and signed lease still bind this very run.
                    let Ok(handle) = bound_handle(&identity, caller, &raw_handle, &secret) else {
                        return Ok(None);
                    };
                    let Some((requester, channel)) = momo_messaging::requester_of_run_in_tx(
                        conn,
                        caller.workspace_id,
                        handle.run_id,
                        caller.agent_member_id,
                    )
                    .await?
                    else {
                        return Ok(None);
                    };
                    if channel != handle.channel_id
                        || !momo_messaging::is_channel_member(conn, channel, caller.agent_member_id)
                            .await?
                        || !momo_messaging::is_channel_member(conn, channel, requester).await?
                    {
                        return Ok(None);
                    }
                    momo_messaging::find_requester_attachment_in_tx(
                        conn,
                        caller.workspace_id,
                        requester,
                        channel,
                        attachment_id,
                        max as i64,
                    )
                    .await
                })
            })
            .await
            .map_err(|error| internal("agent_port.avatar_attachment", error))?;
            let Some(source) = found else {
                return Err(ToolFailure::InvalidArguments);
            };
            let content = state
                .drive
                .file_content(&source.drive_file_id, source.size_bytes)
                .await
                .map_err(|_| ToolFailure::InvalidArguments)?;
            // One byte more than the ceiling: a longer stream than the row claimed
            // is refused, not truncated into something that decodes.
            let bytes = content
                .read_prefix(max + 1)
                .await
                .map_err(|_| ToolFailure::InvalidArguments)?;
            if bytes.len() > max {
                return Err(ToolFailure::InvalidArguments);
            }
            let image = process_avatar_bytes(bytes, max).await?;
            Ok(Some(PreparedAvatar {
                image,
                origin: "attachment",
                for_member: None,
            }))
        }
        _ => Ok(None),
    }
}

/// `member.avatar.set`: find the person the run was raised by and **their** attachment in
/// the conversation the run is in, fetch the file from Drive (outside any transaction) and
/// turn it into server-made bytes.
///
/// What is checked here, before a decoder runs, and answered as the one opaque
/// `InvalidArguments` (each refusal also leaves a reason code in the audit log):
/// the handle is this agent's and its run is live; the run was raised by a live human; the
/// attachment is complete, an allowed type, within 5 MiB, **written by that human, in the
/// run's own channel**. A file somebody else attached, or one from another conversation,
/// does not exist as far as this call can tell.
async fn prepare_member_avatar(
    state: &AppState,
    caller: HostedCaller,
    raw_handle: &str,
    avatar: &crate::routes::actions::AvatarIntent,
) -> Result<Option<PreparedAvatar>, ToolFailure> {
    let max = momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT;
    let secret = state.agent_port.envelope_secret().to_string();
    let raw_handle = raw_handle.to_string();
    let attachment_id = match avatar {
        crate::routes::actions::AvatarIntent::Attachment(id) => Some(*id),
        crate::routes::actions::AvatarIntent::Generated(_) => None,
        _ => return Err(ToolFailure::InvalidArguments),
    };
    let looked_up = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err((failure, None, "not_authorized"))),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err((failure, None, "handle_refused"))),
            };
            let Some(run) =
                momo_agent::lock_gateway_run_in_tx(conn, caller.workspace_id, handle.run_id)
                    .await?
            else {
                return Ok(Err((ToolFailure::Unavailable, None, "run_unavailable")));
            };
            let Some((person, channel_id)) = momo_messaging::requester_of_run_in_tx(
                conn,
                caller.workspace_id,
                handle.run_id,
                run.agent_member_id,
            )
            .await?
            else {
                return Ok(Err((ToolFailure::InvalidArguments, None, "no_requester")));
            };
            // Per-person hourly ceiling, before a byte is fetched or decoded. Counts the
            // proposals that were staged or refused for this person (not the rate-limit
            // refusals themselves, so the window drains as the hour passes).
            let recent: i64 = momo_db::sqlx::query_scalar(
                "SELECT count(*) FROM audit_log \
                  WHERE workspace_id = $1 AND subject_member_id = $2 \
                    AND action IN ($3, $4) \
                    AND detail->>'reason' IS DISTINCT FROM $5 \
                    AND created_at > now() - interval '1 hour'",
            )
            .bind(caller.workspace_id)
            .bind(person)
            .bind(momo_agent::actions::AUDIT_MEMBER_AVATAR_STAGED)
            .bind(momo_agent::actions::AUDIT_MEMBER_AVATAR_REFUSED)
            .bind(momo_agent::actions::MEMBER_AVATAR_RATE_LIMITED_REASON)
            .fetch_one(&mut *conn)
            .await?;
            if recent >= momo_agent::actions::MEMBER_AVATAR_PROPOSALS_PER_HOUR {
                return Ok(Err((
                    ToolFailure::InvalidArguments,
                    Some(person),
                    momo_agent::actions::MEMBER_AVATAR_RATE_LIMITED_REASON,
                )));
            }
            let source = if let Some(attachment_id) = attachment_id {
                let source = momo_messaging::find_requester_attachment_in_tx(
                    conn,
                    caller.workspace_id,
                    person,
                    channel_id,
                    attachment_id,
                    max as i64,
                )
                .await?;
                let Some(source) = source else {
                    return Ok(Err((
                        ToolFailure::InvalidArguments,
                        Some(person),
                        "attachment_not_available",
                    )));
                };
                Some(source)
            } else {
                None
            };
            Ok(Ok((person, source)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.member_avatar_attachment", error))?;
    let (person, source) = match looked_up {
        Ok(found) => found,
        Err((failure, person, reason)) => {
            if matches!(failure, ToolFailure::InvalidArguments) {
                audit_member_avatar_refused(state, caller, person, reason).await;
            }
            return Err(failure);
        }
    };
    let fetched = async {
        if let crate::routes::actions::AvatarIntent::Generated(encoded) = avatar {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "invalid_base64")?;
            return process_avatar_bytes_coded(
                bytes,
                momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_GENERATED,
            )
            .await;
        }
        let source = source.ok_or("attachment_not_available")?;
        let content = state
            .drive
            .file_content(&source.drive_file_id, source.size_bytes)
            .await
            .map_err(|_| "drive_unavailable")?;
        // One byte more than the ceiling: a longer stream than the row claimed is
        // refused, not truncated into something that decodes.
        let bytes = content
            .read_prefix(max + 1)
            .await
            .map_err(|_| "drive_unavailable")?;
        if bytes.len() > max {
            return Err("too_large");
        }
        process_avatar_bytes_coded(bytes, max).await
    }
    .await;
    match fetched {
        Ok(image) => Ok(Some(PreparedAvatar {
            image,
            origin: if attachment_id.is_some() {
                "attachment"
            } else {
                "generated"
            },
            for_member: Some(person),
        })),
        Err(reason) => {
            audit_member_avatar_refused(state, caller, Some(person), reason).await;
            Err(ToolFailure::InvalidArguments)
        }
    }
}

// ---------------------------------------------------------------------------
// oort_action_claim_secret (ADR-0186 증보 v3 V3-4)
// ---------------------------------------------------------------------------

/// Receive, **once**, the value an approval granted to the agent that proposed it.
///
/// The server stores no plaintext: the value is minted **here**, at the claim, by the
/// same domain function the human regenerate paths use — which also invalidates
/// whatever value existed before. Everything else about the claim is judged under the
/// approval row's `FOR UPDATE` lock, so two concurrent claims serialise and exactly one
/// finds the grant `Open`.
///
/// Every refusal that is not about the value's own lifecycle (not the proposer, not
/// approved, no grant, a target that is gone or in the wrong state) is the one
/// `Unavailable`. `AlreadyClaimed` and `ClaimExpired` are only ever said to the
/// proposer, who is the only caller that reaches them.
async fn action_claim_secret(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    use momo_agent::actions::{
        action_by_id, secret_claim_state, SecretClaimState, SecretDelivery,
        ACTION_TYPE_WORKSPACE_ACTION, AUDIT_SECRET_CLAIMED, AUDIT_SECRET_CLAIMED_SCHEMA,
        SECRET_CLAIM_KIND_INVITE, SECRET_CLAIM_KIND_PAIRING, SECRET_CLAIM_PAYLOAD_KEY,
    };
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "handle", 512)?.to_string();
    let approval_id = Uuid::parse_str(required_str(args, "approvalId", 64)?)
        .map_err(|_| ToolFailure::InvalidArguments)?;
    let secret = state.agent_port.envelope_secret().to_string();
    // The operator\'s configured public address, if any. It outranks the origin the
    // approver\'s request carried (I2 review M1): the link now reaches a person through
    // an agent, unseen, so a `Host` header must not be the thing that decides where
    // it points when the operator has said what the address is.
    let configured_origin = state.t3.ready_public_base_url();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            if let Err(failure) = bound_handle(&identity, caller, &raw_handle, &secret) {
                return Ok(Err(failure));
            }
            let Some(approval) =
                momo_agent::approval::lock_approval_in_tx(conn, caller.workspace_id, approval_id)
                    .await?
            else {
                return Ok(Err(ToolFailure::Unavailable));
            };
            let action = approval
                .payload
                .get("action")
                .and_then(|action| action.get("id"))
                .and_then(Value::as_str)
                .and_then(action_by_id);
            let Some(action) = action else {
                return Ok(Err(ToolFailure::Unavailable));
            };
            if approval.requested_by != caller.agent_member_id
                || approval.action_type != ACTION_TYPE_WORKSPACE_ACTION
                || approval.status != "approved"
                || action.secret_delivery == SecretDelivery::None
            {
                return Ok(Err(ToolFailure::Unavailable));
            }
            let now_ms = chrono::Utc::now().timestamp_millis();
            match secret_claim_state(&approval.payload, now_ms) {
                SecretClaimState::NotGranted => return Ok(Err(ToolFailure::Unavailable)),
                SecretClaimState::AlreadyClaimed => return Ok(Err(ToolFailure::AlreadyClaimed)),
                SecretClaimState::Expired => return Ok(Err(ToolFailure::ClaimExpired)),
                SecretClaimState::Open => {}
            }
            let grant = &approval.payload[SECRET_CLAIM_PAYLOAD_KEY];
            let kind = grant.get("kind").and_then(Value::as_str).unwrap_or("");
            let ref_id = grant
                .get("refId")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok());
            let decided_by = grant
                .get("decidedBy")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok());
            let (Some(ref_id), Some(decided_by)) = (ref_id, decided_by) else {
                return Ok(Err(ToolFailure::Unavailable));
            };

            let mut minted_invite: Option<Uuid> = None;
            let (value, expires_at_ms) = match kind {
                SECRET_CLAIM_KIND_PAIRING => {
                    // The connection the approval created, while it is still waiting
                    // for its first handshake. A detected, active or retired one is
                    // not the thing this grant was about.
                    let Some(connection) = momo_auth::latest_hosted_connection_for_agent_in_tx(
                        conn,
                        caller.workspace_id,
                        ref_id,
                    )
                    .await
                    .map_err(DbError::from)?
                    else {
                        return Ok(Err(ToolFailure::Unavailable));
                    };
                    if !matches!(connection.status.as_str(), "pairing_pending" | "expired") {
                        return Ok(Err(ToolFailure::Unavailable));
                    }
                    match momo_auth::regenerate_pairing_in_tx(
                        conn,
                        caller.workspace_id,
                        connection.id,
                    )
                    .await
                    .map_err(DbError::from)?
                    {
                        momo_auth::HostedMutation::Applied(issuance) => {
                            (issuance.pairing_credential, issuance.pairing_expires_at_ms)
                        }
                        _ => return Ok(Err(ToolFailure::Unavailable)),
                    }
                }
                SECRET_CLAIM_KIND_INVITE => {
                    let Some(origin) = configured_origin
                        .as_deref()
                        .or_else(|| grant.get("origin").and_then(Value::as_str))
                    else {
                        return Ok(Err(ToolFailure::Unavailable));
                    };
                    // The approver\'s authority is re-proved: an admin demoted or
                    // removed since the approval does not get to have a link minted
                    // in their name (I2 review M2).
                    if crate::routes::invites::require_admin(conn, caller.workspace_id, decided_by)
                        .await?
                        .is_err()
                    {
                        return Ok(Err(ToolFailure::Unavailable));
                    }
                    // The invite as the approval made it: still live, not spent, not
                    // revoked by the approver. The replacement keeps its role, its
                    // `max_uses` **and its expiry** (V3-4: no new ceiling is born here).
                    let live: Option<(chrono::DateTime<chrono::Utc>,)> = momo_db::sqlx::query_as(
                        "SELECT expires_at FROM invite_code \
                          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL \
                            AND expires_at > now() AND used_count < max_uses \
                          FOR UPDATE",
                    )
                    .bind(caller.workspace_id)
                    .bind(ref_id)
                    .fetch_optional(&mut *conn)
                    .await?;
                    let Some((expires_at,)) = live else {
                        return Ok(Err(ToolFailure::Unavailable));
                    };
                    let created =
                        match momo_settings::regenerate_invite(conn, ref_id, decided_by).await? {
                            Ok(created) => created,
                            Err(_) => return Ok(Err(ToolFailure::Unavailable)),
                        };
                    momo_db::sqlx::query(
                        "UPDATE invite_code SET expires_at = $3, updated_at = now() \
                          WHERE workspace_id = $1 AND id = $2",
                    )
                    .bind(caller.workspace_id)
                    .bind(created.invite.id)
                    .bind(expires_at)
                    .execute(&mut *conn)
                    .await?;
                    minted_invite = Some(created.invite.id);
                    if !created
                        .code
                        .bytes()
                        .all(crate::routes::approvals::is_url_safe_code_byte)
                    {
                        return Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                            "minted invite code is not url-safe".into(),
                        )));
                    }
                    (
                        format!("{origin}/join?code={}", created.code),
                        expires_at.timestamp_millis(),
                    )
                }
                _ => return Ok(Err(ToolFailure::Unavailable)),
            };

            if !momo_agent::stamp_secret_claimed_in_tx(conn, approval.id, now_ms).await? {
                // The lock says this cannot happen; if it did, the minted value must
                // die with the transaction.
                return Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                    "secret claim stamped twice".into(),
                )));
            }
            momo_db::audit::write_audit(
                conn,
                &momo_db::audit::AuditEntry::new(caller.workspace_id, AUDIT_SECRET_CLAIMED)
                    .by(caller.agent_member_id)
                    .target("approval", approval.id)
                    .run(approval.run_id)
                    .with_schema(
                        AUDIT_SECRET_CLAIMED_SCHEMA,
                        // Who, which approval, which kind. Never the value.
                        json!({
                            "approval_id": approval.id.to_string(),
                            "action_id": action.id,
                            "kind": kind,
                            "invite_id": minted_invite.map(|id| id.to_string()),
                            "replaced_invite_id": (kind == SECRET_CLAIM_KIND_INVITE)
                                .then(|| ref_id.to_string()),
                        }),
                    ),
            )
            .await?;
            Ok(Ok(json!({
                "actionId": action.id,
                "kind": kind,
                "value": value,
                "expiresAtMs": expires_at_ms,
            })))
        })
    })
    .await
    .map_err(|error| internal("agent_port.action_claim_secret", error))?;
    outcome
}

// ---------------------------------------------------------------------------
// oort_expression_assemble (ADR-0218 G3.7 (a), #4820 C1b)
// ---------------------------------------------------------------------------

/// The picture an `oort_expression_assemble` call names.
enum AssembleSource {
    /// An attachment of the run's conversation; the server fetches it.
    Attachment(Uuid),
    /// Bytes the agent sent, strict base64 decoded (at most 4 MiB, G3.2).
    Bytes(Vec<u8>),
}

/// What the arguments say once the pure checks passed (nothing has touched the database).
struct AssembleCall {
    raw_handle: String,
    request: momo_expressions::assemble::AssembleRequest,
    source: AssembleSource,
    prompt: String,
    /// G1: the attachment the drawing is based on; verified before it is kept.
    source_attachment_id: Option<Uuid>,
}

/// `assembly_params_invalid` (ADR-0218 G3.8) as the call error it is: the same -32602 as any
/// malformed argument, plus `error.data {code, params}` naming the wrong parameters — the names
/// of `momo_mcp::ASSEMBLE_PARAMS`, never a value. The names are logged too. A name the closed
/// list does not hold (the two lists drifting) falls back to the plain `InvalidArguments`: a
/// name that is not on the list is never said.
fn params_failure(params: &[momo_expressions::assemble::Param]) -> ToolFailure {
    let names: Vec<&'static str> = params.iter().map(|param| param.name()).collect();
    tracing::info!(
        params = ?names,
        "oort_expression_assemble refused: assembly_params_invalid"
    );
    momo_mcp::AssembleParams::from_names(names.iter().copied()).map_or(
        ToolFailure::InvalidArguments,
        ToolFailure::InvalidAssembleParams,
    )
}

/// The pure half of the call: shape, strict base64, the prompt rule and the assembler's own
/// parameter validation. A wrong parameter the published schema cannot say (a duplicate preset, a
/// sequence cell outside the grid, a play length over 10 s, a size inside the range but not one
/// of the three) is `InvalidAssembleParams` and names it ([`params_failure`]); any other wrong
/// shape is the same `InvalidArguments` as any malformed argument and carries no cause (the
/// closed `ToolFailure` set).
fn parse_assemble(arguments_value: &Value) -> Result<AssembleCall, ToolFailure> {
    use base64::Engine as _;
    use momo_expressions::assemble::AssembleRequest;
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "handle", 512)?.to_string();
    let prompt = required_str(args, "prompt", 8000)?;
    if !momo_expressions::action::valid_prompt(prompt) {
        return Err(ToolFailure::InvalidArguments);
    }
    let source_attachment_id = optional_uuid(args, "sourceAttachmentId")?;
    let mut request = Map::new();
    request.insert(
        "motion".into(),
        args.get("motion")
            .cloned()
            .ok_or(ToolFailure::InvalidArguments)?,
    );
    if let Some(size) = args.get("size").filter(|size| !size.is_null()) {
        request.insert("size".into(), size.clone());
    }
    let request: AssembleRequest = serde_json::from_value(Value::Object(request))
        .map_err(|_| ToolFailure::InvalidArguments)?;
    if let Err(error) = request.validate() {
        return Err(match &error {
            momo_expressions::assemble::AssembleError::ParamsInvalid { params } => {
                params_failure(params)
            }
            _ => ToolFailure::InvalidArguments,
        });
    }
    let source = args
        .get("source")
        .and_then(Value::as_object)
        .ok_or(ToolFailure::InvalidArguments)?;
    let source = match source.get("from").and_then(Value::as_str) {
        Some("attachment") => AssembleSource::Attachment(required_uuid(source, "attachmentId")?),
        Some("base64") => {
            let encoded = required_str(source, "dataBase64", momo_mcp::MAX_ASSEMBLE_BASE64_BYTES)?;
            // 5,592,408 characters is 1,398,102 groups of three: up to 4 MiB + 2 bytes. The
            // 4 MiB of G3.2 is a limit on the **decoded** picture, so it is judged by the
            // assembler on the decoded bytes (`assembly_source_too_large`), not here.
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| ToolFailure::InvalidArguments)?;
            AssembleSource::Bytes(bytes)
        }
        _ => return Err(ToolFailure::InvalidArguments),
    };
    Ok(AssembleCall {
        raw_handle,
        request,
        source,
        prompt: prompt.to_string(),
        source_attachment_id,
    })
}

/// A refusal the card can show (G3.8): `{code}` and, for a too-large animation, `bytes` — the
/// size that was measured. A tool **result**, not a protocol fault: nothing was wrong with the
/// call, and the agent reads the code to tell the person.
fn assemble_refusal(error: &momo_expressions::assemble::AssembleError) -> Value {
    use momo_expressions::assemble::AssembleError;
    match error {
        AssembleError::OutputTooLarge { bytes } => {
            json!({"code": "assembly_output_too_large", "bytes": bytes})
        }
        other => json!({"code": other.code()}),
    }
}

/// What the lookup transaction proved before any work starts.
struct AssembleLookup {
    requester: Uuid,
    /// The attachment to fetch, when the picture is one.
    source: Option<momo_messaging::AvatarAttachmentSource>,
    /// This agent already holds as many candidates as the cap allows for what was asked.
    full: bool,
}

/// Put motion on one picture and keep the candidates (ADR-0218 G3).
///
/// Two short transactions and the work between them, never one transaction across the 10 s:
///
/// 1. **Lookup.** The scope and the lease handle are re-proved exactly as `oort_card_suggest`
///    does (a stale handle cannot speak for a run somebody else holds), the person the run was
///    raised by is read from the run, an attachment source — and a `sourceAttachmentId` — must
///    be a complete, live attachment **that person** wrote in **this** conversation (a stranger's
///    file and an unknown id are the same `InvalidArguments`), and the agent's twelve are
///    pre-counted so a call that cannot be kept is refused before it costs a decoder slot.
/// 2. **Work.** The attachment is fetched from Drive outside any transaction, a slot is taken
///    from the shared decoder semaphore (none free is `assembly_busy`, at once), and the child
///    builds the candidates inside what is left of the call's one 10 s.
/// 3. **Keep.** The scope is proved again, then [`momo_expressions::assembly::keep_in_tx`] stores
///    the result under the agent's own lock.
///
/// Answers: a G3.8 code is a **result** (`{code}` / `{code, bytes}`); the assembler's parameter
/// check is `InvalidArguments`; an assembler that cannot run is `Internal` (5xx), never a card
/// code. Nothing here writes the prompt, the picture, its base64 or the attachment to a log, an
/// audit row or the outbox. The rate limit was spent once by the transport, before the body.
async fn expression_assemble(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    use momo_expressions::assemble::{self, AssembleError, SourceFrom};
    use momo_expressions::assembly;
    let started = std::time::Instant::now();
    let call = parse_assemble(arguments_value)?;
    let secret = state.agent_port.envelope_secret().to_string();
    let wanted = call.request.slot_kinds().len() as i64;
    let (attachment, pointer) = (
        match &call.source {
            AssembleSource::Attachment(id) => Some(*id),
            AssembleSource::Bytes(_) => None,
        },
        call.source_attachment_id,
    );
    let raw_handle = call.raw_handle.clone();

    // ---- 1. lookup --------------------------------------------------------------------
    let lookup = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            let Some(run) =
                momo_agent::lock_gateway_run_in_tx(conn, caller.workspace_id, handle.run_id)
                    .await?
            else {
                return Ok(Err(ToolFailure::Unavailable));
            };
            let lease_snapshot = momo_outbox::lock_gateway_lease_in_tx(
                conn,
                caller.workspace_id,
                handle.run_id,
                run.agent_member_id,
                GatewayLeaseBinding {
                    job_id: handle.job_id,
                    lease_id: handle.lease_id,
                },
            )
            .await
            .map_err(DbError::from)?;
            if !momo_outbox::gateway_lease_authorized_hosted(lease_snapshot, handle.lease_id, false)
            {
                return Ok(Err(ToolFailure::Conflict));
            }
            if run.agent_member_id != caller.agent_member_id || run.channel_id != handle.channel_id
            {
                return Ok(Err(ToolFailure::HandleRefused));
            }
            if run.status.is_approval_held() || run.status.is_terminal() {
                return Ok(Err(ToolFailure::Conflict));
            }
            let Some((requester, channel_id)) = momo_messaging::requester_of_run_in_tx(
                conn,
                caller.workspace_id,
                handle.run_id,
                run.agent_member_id,
            )
            .await?
            else {
                return Ok(Err(ToolFailure::InvalidArguments));
            };
            let mut source = None;
            for (id, is_source) in [(attachment, true), (pointer, false)] {
                let Some(id) = id else { continue };
                let found = momo_messaging::find_requester_attachment_in_tx(
                    conn,
                    caller.workspace_id,
                    requester,
                    channel_id,
                    id,
                    momo_expressions::INPUT_BYTES as i64,
                )
                .await?;
                match (found, is_source) {
                    (Some(found), true) => source = Some(found),
                    (Some(_), false) => {}
                    // A stranger's file, another conversation, a pending or deleted one and an
                    // unknown id are one answer.
                    (None, _) => return Ok(Err(ToolFailure::InvalidArguments)),
                }
            }
            let held = assembly::held_in_tx(conn, caller.workspace_id, caller.agent_member_id)
                .await
                .map_err(crate::routes::approvals::expression_db_error)?;
            Ok(Ok(AssembleLookup {
                requester,
                source,
                full: held + wanted > assembly::HELD_MAX,
            }))
        })
    })
    .await
    .map_err(|error| internal("agent_port.expression_assemble_lookup", error))??;
    if lookup.full {
        return Ok(assemble_refusal(&AssembleError::Busy));
    }

    // ---- 2. work ----------------------------------------------------------------------
    // One clock for the whole call: what the Drive fetch and the lookup spent is not the child's.
    let remaining = || assemble::DEADLINE.saturating_sub(started.elapsed());
    let (bytes, from) = match call.source {
        AssembleSource::Bytes(bytes) => (bytes, SourceFrom::Request),
        AssembleSource::Attachment(_) => {
            let source = lookup.source.ok_or(ToolFailure::InvalidArguments)?;
            let fetch = async {
                let content = state
                    .drive
                    .file_content(&source.drive_file_id, source.size_bytes)
                    .await
                    .map_err(|_| ())?;
                content
                    .read_prefix(momo_expressions::INPUT_BYTES + 1)
                    .await
                    .map_err(|_| ())
            };
            match tokio::time::timeout(remaining(), fetch).await {
                Err(_) => return Ok(assemble_refusal(&AssembleError::Timeout)),
                Ok(Err(())) => return Err(ToolFailure::Unavailable),
                Ok(Ok(bytes)) => (bytes, SourceFrom::Server),
            }
        }
    };
    let budget = remaining();
    if budget.is_zero() {
        return Ok(assemble_refusal(&AssembleError::Timeout));
    }
    let program = match &state.assembler_program {
        Some(program) => program.as_ref().clone(),
        None => assemble::assembler_path().map_err(|_| ToolFailure::Internal)?,
    };
    let answer = assemble::try_assemble_with_program(
        &program,
        budget,
        &call.request,
        bytes,
        from,
        &momo_expressions::media::decoder_slots(),
    )
    .await;
    let outcomes = match answer {
        Ok(outcomes) => outcomes,
        // Already proved by `parse_assemble`; the child repeats it, so it can only come back
        // if the two ever disagree. The agent's call is the thing that is wrong either way, and
        // it hears the same names as it would have from the door.
        Err(AssembleError::ParamsInvalid { params }) => return Err(params_failure(&params)),
        Err(AssembleError::Unavailable) => {
            // An operator fault (no binary, a child that died for no limit's reason): a 5xx,
            // never a card code. Nothing of the request is in the log line.
            tracing::error!("oort_expression_assemble: the assembler is unavailable");
            return Err(ToolFailure::Internal);
        }
        Err(refusal) => return Ok(assemble_refusal(&refusal)),
    };
    // Every candidate built too large leaves nothing to keep: the first one's measured size is
    // the answer.
    if let Some(Err(first)) = outcomes
        .first()
        .filter(|_| outcomes.iter().all(|o| o.is_err()))
    {
        return Ok(assemble_refusal(first));
    }

    // ---- 3. keep ----------------------------------------------------------------------
    let kinds = call.request.slot_kinds();
    let prompt = call.prompt;
    let source_attachment_id = call.source_attachment_id;
    let requester = lookup.requester;
    let kept = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            if let Err(failure) =
                authorize_in_tx(conn, caller, momo_auth::SCOPE_WORKSPACE_PROPOSE).await?
            {
                return Ok(Err(failure));
            }
            let kept = assembly::keep_in_tx(
                conn,
                &assembly::Keep {
                    workspace: caller.workspace_id,
                    agent: caller.agent_member_id,
                    requester,
                    prompt: &prompt,
                    source_attachment_id,
                    motions: &kinds,
                    outcomes: &outcomes,
                },
            )
            .await
            .map_err(crate::routes::approvals::expression_db_error)?;
            Ok(Ok(kept))
        })
    })
    .await
    .map_err(|error| internal("agent_port.expression_assemble_keep", error))??;
    let kept = match kept {
        Ok(kept) => kept,
        // Another call of this agent took the room while this one was building.
        Err(assembly::Full { .. }) => return Ok(assemble_refusal(&AssembleError::Busy)),
    };
    Ok(json!({
        "assemblyId": kept.assembly_id,
        "expiresAtMs": crate::routes::shared::epoch_ms(kept.expires_at),
        "candidates": kept.candidates.iter().map(|candidate| json!({
            "index": candidate.index,
            "motion": candidate.motion,
            "frames": candidate.frames,
            "durationMs": candidate.duration_ms,
            "bytes": candidate.bytes,
            "sha256": candidate.sha256,
        })).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// oort_card_suggest
// ---------------------------------------------------------------------------

/// The keys this door owns itself, beside the three `validate_suggestion`
/// reads. Every other key — `label`, `forMemberId`, `channelId`, `props`
/// included — is refused (ADR-0186 증보 G1).
const CARD_SUGGEST_DOOR_KEYS: [&str; 3] = ["handle", "clientMsgId", "rootId"];

/// `no_human_requester` on the wire (ADR-0186 증보 G3).
///
/// `ToolFailure` is the closed five-answer set and a sixth, cause-carrying
/// answer is exactly what it exists to prevent, so the refusal is spelled with
/// one of the five: `Unavailable` — 「the target is not reachable」 — because
/// the thing that is missing is the *recipient*, not a valid argument and not a
/// permission. The cause is logged server-side; the agent learns it from the
/// error code alone, and zero messages are written either way.
const NO_HUMAN_REQUESTER_FAILURE: ToolFailure = ToolFailure::Unavailable;

/// Suggest a client-command card to the person who asked (ADR-0186 증보
/// G1~G3).
///
/// One tenant transaction, and the only write in it is the message:
///
/// 1. the arguments pass `momo_agent::validate_suggestion` — the **same** gate
///    the worker's `card_suggest` uses — **outside** the transaction, so a bad
///    suggestion never opens one;
/// 2. `messages:write` is re-proved, the handle's identity binding is
///    re-checked (`bound_handle`) and its **lease** is proved live and ours,
///    exactly as `oort_action_propose` does — a stale handle must not be able
///    to speak for a run somebody else now holds;
/// 3. the requester is read from `agent_run.trigger_message_id` and must be a
///    human, or the call is `no_human_requester` with nothing written;
/// 4. the card goes out through `send_thread_notice_in_tx` — `channel_seq`
///    bump, message, outbox row, and the thread rollup + `thread.updated` when
///    it is a reply — in the **handle's** channel.
///
/// Not written: an approval row, a run transition (no `mark_run_started`, no
/// park — `agent_run.status` is read, locked and left as it was), a props
/// patch, an outbox row of any new kind. No PTY, no provider link, no settings
/// route is reached from here (G1 「에이전트는 실행하지 않는다」).
async fn card_suggest(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "handle", 512)?.to_string();
    let client_msg_id = required_uuid(args, "clientMsgId")?;
    let root_id = optional_uuid(args, "rootId")?;
    let suggestion = momo_agent::validate_suggestion(arguments_value, &CARD_SUGGEST_DOOR_KEYS)
        .map_err(|_| ToolFailure::InvalidArguments)?;
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_MESSAGES_WRITE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            // Re-proves the agent is active and still in the run's channel. A
            // lock, not a write: the run's status is not touched below.
            let Some(run) =
                momo_agent::lock_gateway_run_in_tx(conn, caller.workspace_id, handle.run_id)
                    .await?
            else {
                return Ok(Err(ToolFailure::Unavailable));
            };
            let lease_snapshot = momo_outbox::lock_gateway_lease_in_tx(
                conn,
                caller.workspace_id,
                handle.run_id,
                run.agent_member_id,
                GatewayLeaseBinding {
                    job_id: handle.job_id,
                    lease_id: handle.lease_id,
                },
            )
            .await
            .map_err(DbError::from)?;
            if !momo_outbox::gateway_lease_authorized_hosted(lease_snapshot, handle.lease_id, false)
            {
                return Ok(Err(ToolFailure::Conflict));
            }
            if run.agent_member_id != caller.agent_member_id || run.channel_id != handle.channel_id
            {
                return Ok(Err(ToolFailure::HandleRefused));
            }
            // A parked or settled run speaks no more. A suggestion is not a
            // transition, but a card appearing under a pending approval — or
            // after the answer — is a message about work nobody is doing.
            if run.status.is_approval_held() || run.status.is_terminal() {
                return Ok(Err(ToolFailure::Conflict));
            }
            let channel_id = handle.channel_id;
            if let Some(root_id) = root_id {
                if validate_thread_root_in_tx(conn, channel_id, root_id)
                    .await?
                    .is_err()
                {
                    return Ok(Err(ToolFailure::InvalidArguments));
                }
            }
            let Some(requester) =
                momo_agent::suggestion_requester_in_tx(conn, caller.workspace_id, handle.run_id)
                    .await?
            else {
                tracing::info!(
                    reason = momo_agent::SuggestionRefusal::NoHumanRequester.as_str(),
                    "oort_card_suggest refused"
                );
                return Ok(Err(NO_HUMAN_REQUESTER_FAILURE));
            };

            // `send_thread_notice_in_tx`, not `send_message_in_tx` (#2959 M1):
            // the same single send transaction, plus the thread rollup and
            // `thread.updated` when the card is a reply, so it shows up in the
            // thread's count and live view. No mention pass, no inbox fan-out.
            let sent = send_thread_notice_in_tx(
                conn,
                caller.workspace_id,
                NewMessage {
                    channel_id,
                    author_member_id: caller.agent_member_id,
                    message_type: MessageType::Text,
                    body: Some(suggestion.body.clone()),
                    props: momo_agent::command_suggest_props(&suggestion, requester.member_id),
                    root_id,
                    reply_to_id: None,
                    // The agent's own key, like `oort_message_post`: a retried
                    // call with the same value is the same message.
                    client_msg_id: Some(client_msg_id),
                    run_id: Some(handle.run_id),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?;
            Ok(Ok((sent.message.id, sent.message.seq, sent.deduped)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.card_suggest", error))?;

    let (message_id, seq, deduped) = outcome?;
    Ok(json!({"messageId": message_id, "seq": seq, "deduplicated": deduped}))
}

/// One reported token count.
///
/// Two bounds, both of them the ledger's: `i32` is its column width, so a value
/// that does not fit is a bad argument here rather than a silent truncation in
/// the row that gets billed; and a **negative** count is refused because
/// `RunUsageReport::resolve` and `record_run_usage_in_tx` would carry it
/// straight into a workspace's usage totals and subtract from them. The
/// published schema already says `minimum: 0` — this is that same rule enforced
/// a second time, at the boundary that writes.
///
/// The landed `usage_ledger` carries no CHECK of its own; adding one to a table
/// this goal does not own belongs to #1375's hygiene pass.
fn bounded_token_count(usage: &Map<String, Value>, key: &str) -> Result<Option<i32>, ToolFailure> {
    match optional_i64(usage, key)? {
        None => Ok(None),
        Some(value) if value < 0 => Err(ToolFailure::InvalidArguments),
        Some(value) => i32::try_from(value)
            .map(Some)
            .map_err(|_| ToolFailure::InvalidArguments),
    }
}

/// The reported usage block, in the same two shapes the REST callback produces:
/// the resolver's input and the verbatim echo written to props/output/audit.
#[allow(clippy::type_complexity)]
fn usage_from_arguments(
    args: &Map<String, Value>,
) -> Result<(Option<momo_agent::RunUsageReport>, Option<Value>), ToolFailure> {
    let Some(usage) = args.get("usage") else {
        return Ok((None, None));
    };
    if usage.is_null() {
        return Ok((None, None));
    }
    let usage = usage.as_object().ok_or(ToolFailure::InvalidArguments)?;
    let report = momo_agent::RunUsageReport {
        model: optional_str(usage, "model", 128)?.map(str::to_string),
        effort: optional_str(usage, "effort", 32)?.map(str::to_string),
        prompt_tokens: bounded_token_count(usage, "promptTokens")?,
        completion_tokens: bounded_token_count(usage, "completionTokens")?,
        cached_tokens: bounded_token_count(usage, "cachedTokens")?,
        reasoning_tokens: bounded_token_count(usage, "reasoningTokens")?,
        cost_micro_usd: None,
        was_estimated: None,
    };
    let detail = json!({
        "model": report.model,
        "effort": report.effort,
        "prompt_tokens": report.prompt_tokens,
        "completion_tokens": report.completion_tokens,
        "cached_tokens": report.cached_tokens,
        "reasoning_tokens": report.reasoning_tokens,
        "cost_micro_usd": Value::Null,
        "was_estimated": Value::Null,
    });
    Ok((Some(report), Some(detail)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-0186 v3 A1 (security review of #3799, hard acceptance item): at most two
    /// image decodes run at once, process-wide, and the permit is released when the
    /// decode ends — never leaked by a refused image.
    #[tokio::test]
    async fn at_most_two_avatar_decodes_run_at_once_and_a_refusal_releases_its_permit() {
        assert_eq!(AVATAR_DECODE_PERMITS.available_permits(), 2);
        let first = AVATAR_DECODE_PERMITS.try_acquire().expect("one permit");
        let second = AVATAR_DECODE_PERMITS.try_acquire().expect("two permits");
        assert!(
            AVATAR_DECODE_PERMITS.try_acquire().is_err(),
            "a third decode must wait"
        );
        drop((first, second));
        // A refused image (not an image at all) takes a permit and gives it back.
        let refused = process_avatar_bytes(b"not an image".to_vec(), 1024).await;
        assert!(refused.is_err());
        assert_eq!(AVATAR_DECODE_PERMITS.available_permits(), 2);
    }

    #[test]
    fn a_digest_is_spelled_as_lowercase_hex() {
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
    }

    /// #4054 — the 「요약만」 instruction reaches the hosted adapter (the projection is
    /// an allow-list, so an unlisted key would be written and never delivered), and
    /// the grant evidence it follows from still does not.
    #[test]
    fn the_summary_only_instruction_is_projected_and_the_grant_evidence_is_not() {
        let policy = momo_agent::app_result_policy(["gmail"]).expect("a personal app");
        let payload = json!({
            "channel_id": "5B1F4A2E-0000-4000-8000-000000000004",
            "prompt": "hello",
            "tool_grants": [{"grantId": "G", "pluginId": "gmail", "scope": "s", "tools": ["t"]}],
            momo_agent::APP_RESULT_POLICY_KEY: policy.clone(),
        });
        let projected = projected_job_payload(&payload);
        assert_eq!(projected["appResultPolicy"], policy);
        assert!(projected.get("tool_grants").is_none());
        assert!(projected.get("toolGrants").is_none());
        let plain = projected_job_payload(&json!({"prompt": "hello"}));
        assert!(plain.get("appResultPolicy").is_none());
    }

    #[test]
    fn the_job_projection_is_an_allow_list_that_hides_the_run() {
        let payload = json!({
            "run_id": "5B1F4A2E-0000-4000-8000-000000000001",
            "workspace_id": "5B1F4A2E-0000-4000-8000-000000000002",
            "agent_member_id": "5B1F4A2E-0000-4000-8000-000000000003",
            "channel_id": "5B1F4A2E-0000-4000-8000-000000000004",
            "prompt": "hello",
            "delivery": "gateway",
            "step_count": 0,
            "future_secret_looking_key": "momo_agent_v1.leak"
        });
        let projected = projected_job_payload(&payload);
        assert_eq!(
            projected["channelId"],
            json!("5B1F4A2E-0000-4000-8000-000000000004")
        );
        assert_eq!(projected["prompt"], json!("hello"));
        for hidden in [
            "runId",
            "run_id",
            "delivery",
            "step_count",
            "future_secret_looking_key",
            "agent_member_id",
        ] {
            assert!(projected.get(hidden).is_none(), "{hidden}");
        }
        assert!(!projected.to_string().contains("momo_agent_v1"));
    }

    #[test]
    fn a_domain_status_maps_onto_one_of_the_five_wire_failures() {
        for (status, expected) in [
            (StatusCode::BAD_REQUEST, ToolFailure::InvalidArguments),
            (StatusCode::UNAUTHORIZED, ToolFailure::NotAuthorized),
            (StatusCode::FORBIDDEN, ToolFailure::NotAuthorized),
            (StatusCode::NOT_FOUND, ToolFailure::Unavailable),
            (StatusCode::CONFLICT, ToolFailure::Conflict),
            (StatusCode::INTERNAL_SERVER_ERROR, ToolFailure::Internal),
            (StatusCode::IM_A_TEAPOT, ToolFailure::Internal),
        ] {
            assert_eq!(
                failure_of(&ApiError::new(status, "a message a client must never read")),
                expected,
                "{status}"
            );
        }
    }

    #[test]
    fn argument_readers_refuse_every_wrong_shape() {
        let args = json!({
            "channelId": "not-a-uuid",
            "limit": "12",
            "body": 7,
            "ok": "5b1f4a2e-0000-4000-8000-000000000001"
        });
        let args = args.as_object().unwrap();
        assert_eq!(
            required_uuid(args, "channelId"),
            Err(ToolFailure::InvalidArguments)
        );
        assert_eq!(
            required_uuid(args, "missing"),
            Err(ToolFailure::InvalidArguments)
        );
        assert_eq!(
            optional_i64(args, "limit"),
            Err(ToolFailure::InvalidArguments)
        );
        assert_eq!(optional_i64(args, "absent"), Ok(None));
        assert_eq!(
            required_str(args, "body", 10),
            Err(ToolFailure::InvalidArguments)
        );
        assert!(required_uuid(args, "ok").is_ok());
        assert_eq!(
            optional_str(args, "ok", 4),
            Err(ToolFailure::InvalidArguments),
            "a byte ceiling is enforced before the value is used"
        );
        assert_eq!(arguments(&json!([])), Err(ToolFailure::InvalidArguments));
    }

    /// A handle is only usable by the identity it was minted for. Each of the
    /// three axes alone is enough to refuse it, and the refusal is the same
    /// `NotAuthorized` a garbage string gets.
    #[test]
    fn a_lease_handle_is_refused_off_its_own_identity() {
        let caller = HostedCaller {
            workspace_id: Uuid::from_u128(1),
            agent_member_id: Uuid::from_u128(2),
            token_id: Uuid::from_u128(3),
        };
        let approved_channel = Uuid::from_u128(7);
        let identity = HostedToolIdentity {
            connection_id: Uuid::from_u128(4),
            agent_member_id: caller.agent_member_id,
            token_id: caller.token_id,
            token_scopes: Vec::new(),
            approved_scopes: Vec::new(),
            approved_channel_ids: vec![approved_channel],
        };
        let handle = encode_lease_handle(
            LeaseHandle {
                workspace_id: caller.workspace_id,
                agent_member_id: caller.agent_member_id,
                connection_id: identity.connection_id,
                channel_id: approved_channel,
                run_id: Uuid::from_u128(5),
                job_id: 11,
                lease_id: Uuid::from_u128(6),
            },
            "secret",
        )
        .unwrap();
        assert!(bound_handle(&identity, caller, &handle, "secret").is_ok());

        // Narrowing the human's approval retires a lease already in hand.
        let narrowed = HostedToolIdentity {
            approved_channel_ids: Vec::new(),
            ..identity.clone()
        };
        assert_eq!(
            bound_handle(&narrowed, caller, &handle, "secret"),
            Err(ToolFailure::HandleRefused),
            "a revoked channel approval must stop work already leased"
        );

        let other_connection = HostedToolIdentity {
            connection_id: Uuid::from_u128(99),
            ..identity.clone()
        };
        assert_eq!(
            bound_handle(&other_connection, caller, &handle, "secret"),
            Err(ToolFailure::HandleRefused)
        );
        let other_agent = HostedCaller {
            agent_member_id: Uuid::from_u128(98),
            ..caller
        };
        assert_eq!(
            bound_handle(&identity, other_agent, &handle, "secret"),
            Err(ToolFailure::HandleRefused)
        );
        let other_workspace = HostedCaller {
            workspace_id: Uuid::from_u128(97),
            ..caller
        };
        assert_eq!(
            bound_handle(&identity, other_workspace, &handle, "secret"),
            Err(ToolFailure::HandleRefused)
        );
        assert_eq!(
            bound_handle(&identity, caller, "momo_lease_v1.zzzz", "secret"),
            Err(ToolFailure::HandleRefused)
        );
        assert_eq!(
            bound_handle(&identity, caller, &handle, "another-secret"),
            Err(ToolFailure::HandleRefused)
        );
    }

    /// **ADR-0186 D2 — the propose tool's scope is its own.**
    ///
    /// `authorize_in_tx` asks for exactly one scope per tool, and this is the
    /// pairing for the one tool that can change what a workspace looks like. A
    /// credential holding every conversational scope opens nothing of it, on
    /// either half of the intersection.
    #[test]
    fn the_propose_scope_is_not_implied_by_any_other() {
        let full = |scopes: &[&str]| HostedToolIdentity {
            connection_id: Uuid::from_u128(1),
            agent_member_id: Uuid::from_u128(2),
            token_id: Uuid::from_u128(3),
            token_scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
            approved_scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
            approved_channel_ids: Vec::new(),
        };
        let conversational = full(&[
            "agent:port:connect",
            "agent:inbox:read",
            "messages:read",
            "messages:write",
            "agent:jobs:read",
            "agent:runs:callback",
        ]);
        assert!(!has_scope(
            &conversational,
            momo_auth::SCOPE_WORKSPACE_PROPOSE
        ));
        let mut proposer = full(&["workspace:propose"]);
        assert!(has_scope(&proposer, momo_auth::SCOPE_WORKSPACE_PROPOSE));
        proposer.token_scopes.clear();
        assert!(!has_scope(&proposer, momo_auth::SCOPE_WORKSPACE_PROPOSE));
        proposer.token_scopes = vec!["workspace:propose".into()];
        proposer.approved_scopes.clear();
        assert!(!has_scope(&proposer, momo_auth::SCOPE_WORKSPACE_PROPOSE));
        // The scope the adapter asks for and the scope the catalog publishes are
        // the same string; a typo on either side would be a silently dead tool.
        assert_eq!(
            momo_auth::SCOPE_WORKSPACE_PROPOSE,
            momo_mcp::TOOL_CATALOG
                .iter()
                .find(|tool| tool.name == momo_mcp::TOOL_ACTION_PROPOSE)
                .expect("the propose tool is served")
                .required_scope
        );
    }

    /// The park is the run guard, stated as the predicate both refusals read.
    ///
    /// `complete_gateway_run_in_tx` answers an approval hold with 409 before it
    /// even judges the lease (agent_gateway.rs), and `failure_of` maps that onto
    /// `Conflict`; `job_release` asks `is_approval_held` directly. This pins the
    /// two ends of that chain so a future status can neither widen the hold nor
    /// leak out of it as some other wire answer.
    #[test]
    fn an_approval_hold_is_a_conflict_on_both_guarded_verbs() {
        assert!(momo_agent::RunStatus::AwaitingApproval.is_approval_held());
        assert_eq!(
            failure_of(&ApiError::new(
                StatusCode::CONFLICT,
                "agent run requires a human approval decision (awaiting_approval)"
            )),
            ToolFailure::Conflict,
            "the parked run's 409 must reach the adapter as Conflict, not Internal"
        );
        // Renew is not guarded, and the statuses that are not a hold are not
        // affected by any of this.
        for open in [
            momo_agent::RunStatus::Queued,
            momo_agent::RunStatus::Running,
        ] {
            assert!(!open.is_approval_held(), "{open:?}");
        }
    }

    /// Both halves of the intersection are required at call time too, not only
    /// when the catalog was listed.
    #[test]
    fn a_scope_must_be_on_both_halves_at_call_time() {
        let mut identity = HostedToolIdentity {
            connection_id: Uuid::from_u128(1),
            agent_member_id: Uuid::from_u128(2),
            token_id: Uuid::from_u128(3),
            token_scopes: vec!["messages:write".into()],
            approved_scopes: vec!["messages:write".into()],
            approved_channel_ids: Vec::new(),
        };
        assert!(has_scope(&identity, "messages:write"));
        assert!(!has_scope(&identity, "messages:read"));
        identity.approved_scopes.clear();
        assert!(!has_scope(&identity, "messages:write"));
        identity.approved_scopes = vec!["messages:write".into()];
        identity.token_scopes.clear();
        assert!(!has_scope(&identity, "messages:write"));
    }

    /// The code of one `async fn name(` up to its closing brace at column 0,
    /// with `//` comment lines removed — the doc comments name the very things
    /// the function must not call, and a guard that matched prose would be
    /// measuring the documentation.
    fn function_code(source: &str, signature: &str) -> String {
        let start = source
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} is in the source"));
        let body = &source[start..];
        let end = body.find("\n}\n").expect("the function closes at column 0");
        body[..end]
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Does `code` (lowercased) reach `word`? A compound word (`provider_link`,
    /// `settings::`) is a substring match; a single word (`pty`) must be a whole
    /// `_`-separated part of an identifier, so `is_empty` is not a PTY.
    fn reaches(code: &str, word: &str) -> bool {
        if word.contains('_') || word.contains(':') {
            return code.contains(word);
        }
        code.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .flat_map(|identifier| identifier.split('_'))
            .any(|part| part == word)
    }

    /// **ADR-0186 증보 G1 / G6 — the suggestion runs nothing.** Neither door
    /// reaches a PTY, a provider link, a settings route, a work session, an
    /// approval or a run transition; and the shared gate's crate cannot, because
    /// it has no dependency that could.
    #[test]
    fn a_suggestion_calls_no_pty_provider_link_settings_or_run_transition() {
        let forbidden = [
            "pty",
            "provider_link",
            "momo_provider",
            "momo_settings",
            "settings::",
            "work_session",
            "momo_t3",
            "create_pending_approval",
            "park_run",
            "mark_run_started",
            "finish_run",
            "emit_outbox",
            "patch_message_props",
            "send_message_with_mentions",
        ];
        let hosted = function_code(
            include_str!("agent_port_tools.rs"),
            "async fn card_suggest(",
        );
        let worker = function_code(
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../momo-agent-worker/src/tool_exec.rs"
            )),
            "async fn card_suggest(",
        );
        for (door, code) in [("hosted", &hosted), ("worker", &worker)] {
            assert!(
                code.contains("send_thread_notice_in_tx"),
                "{door}: the one write, with the thread rollup"
            );
            assert!(
                code.contains("validate_suggestion"),
                "{door}: the shared gate"
            );
            assert!(
                code.contains("suggestion_requester_in_tx"),
                "{door}: the requester comes from the run"
            );
            let lowered = code.to_lowercase();
            for word in forbidden {
                assert!(
                    !reaches(&lowered, word),
                    "{door} card_suggest reaches `{word}`"
                );
            }
        }
        let domain = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../crates/momo-agent/src/card_suggest.rs"
        ))
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
        for word in forbidden {
            assert!(
                !reaches(&domain, word),
                "momo_agent::card_suggest reaches `{word}`"
            );
        }
        // The matcher itself can fail: a PTY call spelled as code is caught.
        assert!(reaches("open_pty(session)", "pty"));
        assert!(!reaches("args.is_empty()", "pty"));
        let manifest = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../crates/momo-agent/Cargo.toml"
        ));
        let dependencies = manifest
            .split("[dev-dependencies]")
            .next()
            .expect("a dependency table");
        for crate_name in ["momo-settings", "momo-provider", "momo-t3", "momo-outbox"] {
            assert!(
                !dependencies
                    .lines()
                    .any(|line| line.trim_start().starts_with(crate_name)),
                "momo-agent depends on {crate_name}"
            );
        }
    }

    /// `no_human_requester` is spelled with one of the five closed answers, and
    /// not with the one that means "your arguments were wrong".
    #[test]
    fn no_human_requester_is_unavailable_on_the_wire() {
        assert_eq!(NO_HUMAN_REQUESTER_FAILURE, ToolFailure::Unavailable);
        assert_eq!(NO_HUMAN_REQUESTER_FAILURE.wire().1, -32004);
    }

    /// ADR-0218 G3.8: the names an `assembly_params_invalid` answer may carry
    /// (`momo_mcp::ASSEMBLE_PARAMS`, the adapter's closed list) and the assembler's own
    /// `Param::ALL` are one list in one order. A parameter the assembler can name and the list
    /// cannot would turn a wrong call into a nameless refusal, so the two are pinned together;
    /// and what the door says is exactly the names it was given, in that order, with no value.
    #[test]
    fn the_adapters_parameter_names_are_the_assemblers() {
        use momo_expressions::assemble::Param;
        assert_eq!(Param::ALL.map(Param::name), momo_mcp::ASSEMBLE_PARAMS);
        for param in Param::ALL {
            let ToolFailure::InvalidAssembleParams(named) = params_failure(&[param]) else {
                panic!("{param:?} is not named");
            };
            assert_eq!(named.names().collect::<Vec<_>>(), [param.name()]);
        }
        let everything = params_failure(&[Param::Size, Param::Presets, Param::FrameMs]);
        assert_eq!(
            everything.data(),
            Some(json!({
                "code": "assembly_params_invalid",
                "params": ["presets", "frameMs", "size"]
            })),
            "named once each, in the closed list's order"
        );
        assert_eq!(everything.wire(), (400, -32602, "invalid tool arguments"));
    }
}
