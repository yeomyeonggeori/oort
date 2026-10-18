//! 같은 서버 에이전트(Hermes) 감지·연결 (#3883, ADR-0203).
//!
//! ```text
//! GET  /v1/workspaces/{ws}/cohosted-agent           status — never touches the network
//! POST /v1/workspaces/{ws}/cohosted-agent/probe     two fixed GETs at the declared host
//! POST /v1/workspaces/{ws}/cohosted-agent/connect   create the agent member + pin it
//! ```
//!
//! ## Rules this module holds
//!
//! 1. **Instance operator only, every route** (`require_instance_operator_write`:
//!    a `platform:read` scope is not enough, because probe and connect act on the
//!    operator's own network and credentials). The gate is the first thing a
//!    handler does, so a stranger neither spends the probe budget nor learns
//!    whether the feature is declared (ADR-0203 D3).
//! 2. **One declared host, nothing guessed.** The only host ever dialled is the
//!    one in `HERMES_BASE_URL`, and only when the operator actually wrote it
//!    ([`CohostedAgentConfig::declared`]); the localhost default
//!    `ProviderConfig` fills in is not a declaration. Undeclared means zero
//!    requests (D1). The two paths, the redirect refusal and the egress guard
//!    live in `momo-provider-probe` — this crate links no HTTP client.
//! 3. **The declared URL passes the write gate first** (`validated_base_url`):
//!    plaintext `http://` for a non-public host needs the operator's own
//!    `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK` + exact `AGENT_PROVIDER_LOCAL_HOSTS`
//!    opt-in (ADR-0004 증보 2026-09-08), so the bearer never goes out in clear to
//!    a host the operator did not name as local.
//! 4. **Connect needs the operator's attestation** (`OORT_COHOSTED_AGENT_TOOLS_LOCKED`,
//!    D6): the server cannot see the agent's tools, so the answer is the
//!    operator's declaration, never a finding. The status says exactly that.
//!    Connect also re-probes live and refuses unless the agent answers.
//! 5. **Connect grants nothing** (D4): it writes a `member`, an `agent` row, an
//!    `agent_profile` row with **no** tools enabled, the `operator_env` pin
//!    (#3873) and audit rows — no channel membership, no welcome kickoff, no
//!    tool or plugin grant.
//! 6. **No secret, no body.** Responses and audit rows carry the redacted
//!    endpoint label, counts and fixed vocabulary; `HERMES_API_KEY` and anything
//!    the agent sent back never leave the probe crate.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_agent::{
    create_agent_identity_in_tx, upsert_agent_profile_in_tx, validate_agent_profile, AgentCreation,
    ModelSource, NewAgentMember,
};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::with_provider_link_admin_tx;
use momo_messaging::name_guard::{
    conflicts_with_roster, has_invisible_or_control_characters, RosterName,
};
use momo_messaging::{load_roster_names_in_tx, lock_display_name_namespace_in_tx};
use momo_provider_probe::{
    CohostedAgentProbe, CohostedReport, CohostedTarget, ProbeOutcome, ToolsetsSignal,
};
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
    redacted_endpoint_label, upsert_agent_pin, validated_base_url, PinKind,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

use crate::config::CohostedAgentConfig;
use crate::error::ApiError;
use crate::rate_limit::{too_many_requests, SlidingWindowRateLimiter};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_instance_operator_write, settle_db,
    workspace_scope,
};
use crate::AppState;

const STATUS_SCHEMA: &str = "momo.cohosted_agent.status.v0";
const PROBE_SCHEMA: &str = "momo.cohosted_agent.probe.v0";
const CONNECT_SCHEMA: &str = "momo.cohosted_agent.connect.v0";
const AUDIT_SCHEMA: &str = "momo.cohosted_agent.audit.v0";
const PIN_AUDIT_SCHEMA: &str = "momo.agent_provider_pin.audit.v0";

const DEFAULT_DISPLAY_NAME: &str = "Hermes";
const DEFAULT_HANDLE: &str = "hermes";
/// Used when the agent lists no usable model id (D4: the agent's own model).
const FALLBACK_MODEL: &str = "hermes-agent";
/// The agent row's `base_url` is required but never dialled for a pinned agent
/// (the pin names the operator env link); an `.invalid` host keeps it from ever
/// resolving to anything.
const PLACEHOLDER_BASE_URL: &str = "https://cohosted-agent.invalid/v1";

/// Probe + connect calls one operator may make per window. A probe is up to
/// three requests at the operator's own host, so the budget is small.
pub const OPERATOR_CALLS_PER_WINDOW: u32 = 6;
pub const OPERATOR_CALL_WINDOW: Duration = Duration::from_secs(60);

/// What the operator declared, the probe that can act on it, and its throttle.
pub struct CohostedAgentState {
    pub config: CohostedAgentConfig,
    probe: Arc<dyn CohostedAgentProbe>,
    limiter: SlidingWindowRateLimiter,
}

impl CohostedAgentState {
    pub fn new(config: CohostedAgentConfig, probe: Arc<dyn CohostedAgentProbe>) -> Self {
        CohostedAgentState {
            config,
            probe,
            limiter: SlidingWindowRateLimiter::new(),
        }
    }
}

/// Why nothing can be dialled, decided without a socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Declaration {
    /// `HERMES_BASE_URL` was never written.
    NotDeclared,
    /// Written, but the key is missing / a dev placeholder.
    KeyMissing,
    /// Written, but not an address the gate lets this server dial.
    UrlRefused,
    Ready,
}

impl Declaration {
    fn as_str(self) -> &'static str {
        match self {
            Declaration::NotDeclared => "not_declared",
            Declaration::KeyMissing => "key_missing",
            Declaration::UrlRefused => "url_refused",
            Declaration::Ready => "ready",
        }
    }
}

fn declaration(state: &AppState) -> (Declaration, Option<String>) {
    if !state.cohosted.config.declared {
        return (Declaration::NotDeclared, None);
    }
    let env = &state.settings.env_provider;
    // The label is only the redacted origin (no userinfo/query), safe to show.
    let label = Some(redacted_endpoint_label(&env.base_url));
    if !env.key_configured() {
        return (Declaration::KeyMissing, label);
    }
    match validated_base_url(
        &env.base_url,
        &state.settings.environment,
        env.allow_local_loopback,
    ) {
        Ok(_) => (Declaration::Ready, label),
        Err(_) => (Declaration::UrlRefused, label),
    }
}

/// The probe dials the gate's normalised spelling of the declared URL (what
/// `validated_base_url` approved), never the raw env string.
fn target(state: &AppState) -> CohostedTarget {
    let env = &state.settings.env_provider;
    let approved = validated_base_url(
        &env.base_url,
        &state.settings.environment,
        env.allow_local_loopback,
    )
    // `declaration()` already refused anything the gate refuses; an empty string
    // dials nothing if that ever stops being true.
    .unwrap_or_default();
    CohostedTarget {
        base_url: approved,
        bearer: env.bearer.clone(),
    }
}

/// The active agent already connected in this workspace (an `operator_env` pin on
/// a member that is not deleted). A plain tenant read: the pin table's read policy
/// needs only `app.workspace_id`.
async fn connected_agent(state: &AppState, workspace_id: Uuid) -> Result<Option<Uuid>, ApiError> {
    settle_db(
        "cohosted_agent.connected",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move { Ok(Ok(connected_agent_in_tx(conn, workspace_id).await?)) })
        })
        .await,
    )
}

async fn connected_agent_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
) -> Result<Option<Uuid>, momo_db::DbError> {
    let row: Option<(Uuid,)> = momo_db::sqlx::query_as(
        "SELECT p.agent_member_id FROM agent_provider_pin p \
           JOIN member m ON m.id = p.agent_member_id AND m.workspace_id = p.workspace_id \
          WHERE p.workspace_id = $1 AND p.kind = 'operator_env' AND m.deleted_at IS NULL \
          ORDER BY p.updated_at LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(id,)| id))
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    schema: &'static str,
    /// `not_declared` | `key_missing` | `url_refused` | `ready`.
    declaration: &'static str,
    /// The redacted label of the declared address (never a URL with a secret).
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint_label: Option<String>,
    /// The operator's own statement that the tool lock checklist was followed.
    /// Not something this server verified.
    tools_lock_attested: bool,
    /// Connect is allowed: declared and ready and attested.
    connectable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    connected_agent_id: Option<String>,
}

/// `GET /v1/workspaces/{ws}/cohosted-agent` — no network, ever.
pub async fn status(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<StatusResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_instance_operator_write(&state, &principal).await?;
    let (declared, label) = declaration(&state);
    let connected = if declared == Declaration::NotDeclared {
        None
    } else {
        connected_agent(&state, workspace_id).await?
    };
    let attested = state.cohosted.config.tools_locked;
    Ok(Json(StatusResponse {
        schema: STATUS_SCHEMA,
        declaration: declared.as_str(),
        endpoint_label: label,
        tools_lock_attested: attested,
        connectable: declared == Declaration::Ready && attested && connected.is_none(),
        connected_agent_id: connected.map(|id| id.to_string()),
    }))
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeRequest {
    /// Also ask the agent for `GET /v1/toolsets` (a caution signal only).
    #[serde(default)]
    pub check_toolsets: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsetsDto {
    /// `not_checked` | `unavailable` | `unreadable` | `none_listed` | `dangerous_listed`.
    signal: &'static str,
    /// Which of `terminal`, `code_execution`, `browser` the agent named.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    listed: Vec<&'static str>,
    /// Always false: what the agent says about itself is not proof.
    proof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResponse {
    schema: &'static str,
    /// `not_declared` | `key_missing` | `url_refused` (nothing dialled), or the
    /// probe class `ok` | `rejected` | `unreachable` | `rate_limited` | `unknown`.
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint_label: Option<String>,
    /// Requests that left this server for the probe.
    requests_sent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_count: Option<u64>,
    tools_lock_attested: bool,
    toolsets: ToolsetsDto,
    connectable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    connected_agent_id: Option<String>,
}

fn toolsets_dto(signal: &ToolsetsSignal) -> ToolsetsDto {
    ToolsetsDto {
        signal: signal.as_str(),
        listed: match signal {
            ToolsetsSignal::Listed(names) => names.clone(),
            _ => Vec::new(),
        },
        proof: false,
    }
}

fn throttle(state: &AppState, principal: &Principal) -> Option<Response> {
    let verdict = state.cohosted.limiter.check(
        &format!("cohosted_agent:operator:{}", principal.member_id),
        OPERATOR_CALLS_PER_WINDOW,
        OPERATOR_CALL_WINDOW,
    );
    (!verdict.allowed).then(|| too_many_requests(verdict.retry_after_seconds))
}

/// `POST /v1/workspaces/{ws}/cohosted-agent/probe`.
pub async fn probe(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    body: Option<Json<ProbeRequest>>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_instance_operator_write(&state, &principal).await?;
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let attested = state.cohosted.config.tools_locked;

    let (declared, label) = declaration(&state);
    if declared != Declaration::Ready {
        // Decided without a socket: zero requests.
        return Ok(Json(ProbeResponse {
            schema: PROBE_SCHEMA,
            state: declared.as_str(),
            reason: None,
            endpoint_label: label,
            requests_sent: 0,
            model_count: None,
            tools_lock_attested: attested,
            toolsets: toolsets_dto(&ToolsetsSignal::NotChecked),
            connectable: false,
            connected_agent_id: None,
        })
        .into_response());
    }
    if let Some(limited) = throttle(&state, &principal) {
        return Ok(limited);
    }

    let report = state
        .cohosted
        .probe
        .probe_cohosted(&target(&state), request.check_toolsets)
        .await;
    tracing::info!(
        endpoint = %label.as_deref().unwrap_or(""),
        outcome = report.outcome.as_str(),
        requests_sent = report.requests_sent,
        "cohosted agent probe"
    );
    let connected = connected_agent(&state, workspace_id).await?;
    let ok = report.outcome == ProbeOutcome::Ok;
    Ok(Json(ProbeResponse {
        schema: PROBE_SCHEMA,
        state: report.outcome.as_str(),
        reason: report.reason.clone(),
        endpoint_label: label,
        requests_sent: report.requests_sent,
        model_count: report.model_count,
        tools_lock_attested: attested,
        toolsets: toolsets_dto(&report.toolsets),
        connectable: ok && attested && connected.is_none(),
        connected_agent_id: connected.map(|id| id.to_string()),
    })
    .into_response())
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectRequest {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResponse {
    schema: &'static str,
    agent_id: String,
    handle: String,
    display_name: String,
    endpoint_label: String,
    /// Always `operator_env`.
    pin_kind: &'static str,
}

fn refusal(status: StatusCode, code: &'static str, message: &'static str) -> ApiError {
    ApiError::coded(status, code, message)
}

/// `POST /v1/workspaces/{ws}/cohosted-agent/connect`.
pub async fn connect(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    body: Option<Json<ConnectRequest>>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    // Authority first: a stranger learns nothing, spends nothing, dials nothing.
    require_instance_operator_write(&state, &principal).await?;
    let request = body.map(|Json(request)| request).unwrap_or_default();

    // ---- pure checks, no socket ----
    let display_name = normalized_join_display_name(
        request
            .display_name
            .as_deref()
            .unwrap_or(DEFAULT_DISPLAY_NAME),
    )
    .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    // A name other people read on cards and in voice lines: the hidden-character
    // rule `PATCH …/agents/{agent}` applies (`routes/agents.rs`).
    if has_invisible_or_control_characters(&display_name) {
        return Err(ApiError::bad_request(
            "displayName must not contain invisible or control characters",
        ));
    }
    let handle =
        normalized_requested_handle(Some(request.handle.as_deref().unwrap_or(DEFAULT_HANDLE)))
            .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?
            .ok_or_else(|| ApiError::bad_request("handle is required"))?;

    let (declared, label) = declaration(&state);
    if declared != Declaration::Ready {
        return Err(refusal(
            StatusCode::CONFLICT,
            "cohosted_agent_not_ready",
            "HERMES_BASE_URL과 HERMES_API_KEY를 서버에 설정해야 연결할 수 있어요.",
        ));
    }
    if !state.cohosted.config.tools_locked {
        return Err(refusal(
            StatusCode::CONFLICT,
            "cohosted_tools_lock_not_attested",
            "도구 잠금 확인(OORT_COHOSTED_AGENT_TOOLS_LOCKED)이 없어 연결할 수 없어요. 체크리스트를 따른 뒤 운영자가 직접 선언해 주세요.",
        ));
    }
    let label = label.unwrap_or_default();
    if connected_agent(&state, workspace_id).await?.is_some() {
        return Err(refusal(
            StatusCode::CONFLICT,
            "cohosted_agent_already_connected",
            "이 워크스페이스에는 이미 같은 서버의 에이전트가 연결돼 있어요.",
        ));
    }
    if let Some(limited) = throttle(&state, &principal) {
        return Ok(limited);
    }

    // ---- live check: connect only to an agent that answers right now ----
    let report: CohostedReport = state
        .cohosted
        .probe
        .probe_cohosted(&target(&state), false)
        .await;
    tracing::info!(
        endpoint = %label,
        outcome = report.outcome.as_str(),
        requests_sent = report.requests_sent,
        "cohosted agent connect probe"
    );
    if report.outcome != ProbeOutcome::Ok {
        return Err(refusal(
            StatusCode::CONFLICT,
            "cohosted_agent_not_reachable",
            "같은 서버의 에이전트가 지금 답하지 않아요. 주소와 키를 확인한 뒤 다시 찾아 주세요.",
        ));
    }
    // The agent's own first model id; a name it did not list is never invented.
    let model = report
        .model_ids
        .first()
        .cloned()
        .unwrap_or_else(|| FALLBACK_MODEL.to_string());

    let profile = validate_agent_profile("", None, None, &[], None)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let input = NewAgentMember {
        display_name,
        handle,
        model: model.clone(),
        model_source: ModelSource::Agent,
        base_url: PLACEHOLDER_BASE_URL.to_string(),
        system_prompt: None,
        config: json!({}),
        owner_human_id: actor,
    };

    // One transaction: identity, profile, pin and audit commit together or not
    // at all. Nothing here adds a channel membership or any grant.
    let outcome: Result<momo_agent::AgentMember, ApiError> =
        with_provider_link_admin_tx(&state.pool, workspace_id, {
            let label = label.clone();
            let model = model.clone();
            move |conn| {
                Box::pin(async move {
                    // Two operators clicking at once must not make two agents:
                    // the check and the insert share this lock.
                    momo_db::sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                        .bind(format!("cohosted_connect:{workspace_id}"))
                        .execute(&mut *conn)
                        .await?;
                    if connected_agent_in_tx(conn, workspace_id).await?.is_some() {
                        return Ok(Err(refusal(
                            StatusCode::CONFLICT,
                            "cohosted_agent_already_connected",
                            "이 워크스페이스에는 이미 같은 서버의 에이전트가 연결돼 있어요.",
                        )));
                    }
                    // The create/rename siblings' hygiene, inside the same transaction:
                    // a banned handle does not come back as an agent, and the name's
                    // skeleton may not equal another member's name or handle.
                    if is_handle_banned_in_tx(conn, &input.handle).await? {
                        return Ok(Err(refusal(
                            StatusCode::FORBIDDEN,
                            "cohosted_agent_handle_banned",
                            "그 핸들은 이 워크스페이스에서 쓸 수 없어요.",
                        )));
                    }
                    lock_display_name_namespace_in_tx(conn, workspace_id).await?;
                    let roster = load_roster_names_in_tx(conn, workspace_id, Uuid::nil()).await?;
                    let names: Vec<RosterName<'_>> = roster
                        .iter()
                        .map(|(member_id, display_name, handle)| RosterName {
                            member_id: *member_id,
                            display_name,
                            handle,
                        })
                        .collect();
                    if conflicts_with_roster(&input.display_name, Uuid::nil(), &names) {
                        return Ok(Err(refusal(
                            StatusCode::CONFLICT,
                            "cohosted_agent_name_taken",
                            "그 이름을 쓰는 멤버가 이미 있어요. 다른 이름을 골라 주세요.",
                        )));
                    }
                    let created = create_agent_identity_in_tx(conn, workspace_id, &input).await?;
                    let agent = match created {
                        AgentCreation::Created(agent) => agent,
                        AgentCreation::DuplicateHandle => {
                            return Ok(Err(refusal(
                                StatusCode::CONFLICT,
                                "cohosted_agent_handle_taken",
                                "그 핸들을 쓰는 멤버가 이미 있어요. 다른 핸들을 골라 주세요.",
                            )))
                        }
                        AgentCreation::InvalidOwner => {
                            return Ok(Err(ApiError::bad_request(
                                "operator must be an active human of this workspace",
                            )))
                        }
                    };
                    upsert_agent_profile_in_tx(conn, workspace_id, agent.id, actor, &profile)
                        .await?;
                    upsert_agent_pin(
                        conn,
                        workspace_id,
                        agent.id,
                        PinKind::OperatorEnv,
                        None,
                        None,
                        actor,
                    )
                    .await?;
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "agent.created")
                            .by(actor)
                            .about(agent.id)
                            .target("agent", agent.id)
                            .via_token(via_token)
                            .with_schema(
                                "momo.agent.created.v1",
                                json!({
                                    "handle": agent.handle,
                                    "model": model,
                                    "model_source": "agent",
                                    "endpoint_label": PLACEHOLDER_BASE_URL,
                                    "owner_human_id": actor.to_string(),
                                    "channel_memberships_created": 0,
                                }),
                            ),
                    )
                    .await?;
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "agent.provider_pin.updated")
                            .by(actor)
                            .about(agent.id)
                            .target("agent", agent.id)
                            .via_token(via_token)
                            .with_schema(
                                PIN_AUDIT_SCHEMA,
                                json!({
                                    "kind": "operator_env",
                                    "link_position": null,
                                    "endpoint_label": label,
                                    "previous_kind": null,
                                    "previous_link_position": null,
                                }),
                            ),
                    )
                    .await?;
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "agent.cohosted.connected")
                            .by(actor)
                            .about(agent.id)
                            .target("agent", agent.id)
                            .via_token(via_token)
                            .with_schema(
                                AUDIT_SCHEMA,
                                json!({
                                    "endpoint_label": label,
                                    // The operator's own declaration, not a finding.
                                    "tools_lock_attested": true,
                                    "model_count": report.model_count,
                                    "grants": "none",
                                }),
                            ),
                    )
                    .await?;
                    Ok(Ok(agent))
                })
            }
        })
        .await
        .map_err(|error| ApiError::internal("cohosted_agent.connect", error))?;

    let agent = outcome?;
    Ok((
        StatusCode::CREATED,
        Json(ConnectResponse {
            schema: CONNECT_SCHEMA,
            agent_id: agent.id.to_string(),
            handle: agent.handle,
            display_name: agent.display_name,
            endpoint_label: label,
            pin_kind: "operator_env",
        }),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// 「커넥터 시험」 (#3948 K-S2, ADR-0203 증보 2026-10-16 K2·K4)
// ---------------------------------------------------------------------------
//
// ```text
// PUT /v1/workspaces/{ws}/agents/{agent}/connector-trial   {"enabled": true|false}
// GET /v1/workspaces/{ws}/agents/{agent}/connector-trial
// ```
//
// A Hermes on the operator's own server can read **one person's** apps (Gmail,
// Calendar, Drive) with that person's own tokens, because Hermes keeps one token
// volume and has no per-person isolation (ADR-0203 K1). The server therefore
// enforces what the operator's checklist only asks for:
//
// * **Operator only, both verbs** (`require_instance_operator_write`), and the
//   agent must be the operator's own co-hosted agent: pinned to the operator's env
//   link and owned by the operator. The stored mark is #3938's
//   `agent.connector_owner_human_id`, written through the one writer
//   (`set_connector_owner_in_tx`); this route never names a human.
// * **Turning on** needs, in this order: both attestations and an app list in the
//   server's environment (`409 connector_trial_attest`), exactly one active human
//   in the workspace (`409 connector_trial_members`), and every listed app in the
//   owner's active grants (`409 connector_trial_apps`). A refused request writes
//   nothing.
// * **Delivery re-measures all three, every time** (`momo_agent::connector_trial_stop`
//   — the mention/DM/thread-wake gate, the DM state, the work request, and the
//   worker's people count). Turning on is not a promise that it stays valid.
// * **An attestation is the operator's own statement, not oort's verification.**
//   The server cannot see Hermes's tools, `mcp_servers` or token volume; every
//   response says so.

const TRIAL_SCHEMA: &str = "momo.cohosted_agent.connector_trial.v0";
const TRIAL_AUDIT_SCHEMA: &str = "momo.cohosted_agent.connector_trial.audit.v0";
const TRIAL_AUDIT_ACTION: &str = "agent.connector_trial.updated";
const SELF_DECLARED_NOTE: &str =
    "이 선언은 운영자의 자기 선언이에요. oort가 Hermes의 도구나 앱 연결을 검증한 것이 아니에요.";

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutConnectorTrialRequest {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialAttestDto {
    tools_locked: bool,
    connectors_locked: bool,
    /// The app ids the operator says are switched on in Hermes (ids only).
    apps: Vec<String>,
    /// Always true: what the operator declared is not something oort verified.
    self_declared: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTrialResponse {
    schema: &'static str,
    agent_id: String,
    enabled: bool,
    /// While enabled: why delivery is stopped right now (`attest` | `members` |
    /// `apps`), or absent when it is flowing.
    #[serde(skip_serializing_if = "Option::is_none")]
    stopped: Option<&'static str>,
    attested: TrialAttestDto,
    note: &'static str,
}

fn attest_dto(attest: &momo_agent::ConnectorTrialAttest) -> TrialAttestDto {
    TrialAttestDto {
        tools_locked: attest.tools_locked,
        connectors_locked: attest.connectors_locked,
        apps: attest.apps.clone(),
        self_declared: true,
    }
}

fn trial_refusal(code: &'static str, message: &'static str) -> ApiError {
    ApiError::coded(StatusCode::CONFLICT, code, message)
}

/// `PUT /v1/workspaces/{ws}/agents/{agent}/connector-trial`.
pub async fn put_connector_trial(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    Json(request): Json<PutConnectorTrialRequest>,
) -> Result<Json<ConnectorTrialResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    // Authority first: a stranger learns nothing about the agent or the trial.
    require_instance_operator_write(&state, &principal).await?;
    let agent_member_id = crate::routes::shared::path_uuid(&agent, "invalid agent id")?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let enabled = request.enabled;
    let attest = state.cohosted.config.attest();
    let audit_attest = attest.clone();

    settle_db(
        "cohosted_agent.connector_trial.put",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Lock the agent row first: the checks below and the write see one
                // agent. It must be the operator's own co-hosted agent.
                let owner: Option<Option<Uuid>> = momo_db::sqlx::query_scalar(
                    "SELECT a.owner_human_id FROM agent a \
                       JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id \
                      WHERE a.workspace_id = $1 AND a.member_id = $2 \
                        AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
                        FOR UPDATE OF a",
                )
                .bind(workspace_id)
                .bind(agent_member_id)
                .fetch_optional(&mut *conn)
                .await?;
                let Some(owner) = owner else {
                    return Ok(Err(ApiError::not_found("active agent not found")));
                };
                if owner != Some(actor) {
                    return Ok(Err(ApiError::forbidden(
                        "only the operator who connected this agent can change this",
                    )));
                }
                let before = momo_agent::agent_connector_owner_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                )
                .await?
                .is_some();

                if enabled {
                    if !momo_agent::agent_is_operator_env_pinned_in_tx(
                        conn,
                        workspace_id,
                        agent_member_id,
                    )
                    .await?
                    {
                        return Ok(Err(trial_refusal(
                            "connector_trial_not_cohosted",
                            "같은 서버에 연결한 Hermes 에이전트에서만 앱 시험을 켤 수 있어요.",
                        )));
                    }
                    if !attest.is_complete() {
                        return Ok(Err(trial_refusal(
                            "connector_trial_attest",
                            "서버에 도구 잠금 선언, 앱 시험 선언, 켜 둔 앱 목록이 모두 있어야 켤 수 있어요. 이것은 운영자의 자기 선언이고 oort가 검증하지 않아요.",
                        )));
                    }
                    let facts =
                        momo_agent::trial_candidate_facts_in_tx(conn, workspace_id, actor).await?;
                    if facts.active_humans != 1 {
                        return Ok(Err(trial_refusal(
                            "connector_trial_members",
                            "활성 사람 멤버가 정확히 1명인 워크스페이스에서만 앱 시험을 켤 수 있어요.",
                        )));
                    }
                    if !momo_agent::ungranted_apps(&attest, &facts.granted_apps).is_empty() {
                        return Ok(Err(trial_refusal(
                            "connector_trial_apps",
                            "켜 둔 앱 중 소유자의 활성 허용이 없는 앱이 있어요. 앱을 허용하거나 목록에서 빼 주세요.",
                        )));
                    }
                }

                match momo_agent::set_connector_owner_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    actor,
                    enabled,
                )
                .await?
                {
                    momo_agent::ConnectorOwnerChange::NoSuchAgent => {
                        return Ok(Err(ApiError::not_found("active agent not found")));
                    }
                    momo_agent::ConnectorOwnerChange::NotOwner => {
                        return Ok(Err(ApiError::forbidden(
                            "only the operator who connected this agent can change this",
                        )));
                    }
                    momo_agent::ConnectorOwnerChange::Applied { .. } => {}
                }
                if before != enabled {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, TRIAL_AUDIT_ACTION)
                            .by(actor)
                            .about(agent_member_id)
                            .target("agent", agent_member_id)
                            .via_token(via_token)
                            .with_schema(
                                TRIAL_AUDIT_SCHEMA,
                                json!({
                                    "enabled": enabled,
                                    "apps": audit_attest.apps,
                                    "self_declared": true,
                                }),
                            ),
                    )
                    .await?;
                }
                Ok(Ok(()))
            })
        })
        .await,
    )?;

    let attested = attest_dto(&state.cohosted.config.attest());
    Ok(Json(ConnectorTrialResponse {
        schema: TRIAL_SCHEMA,
        agent_id: agent_member_id.to_string(),
        enabled,
        stopped: None,
        attested,
        note: SELF_DECLARED_NOTE,
    }))
}

/// `GET /v1/workspaces/{ws}/agents/{agent}/connector-trial` — the mark and, while
/// it is on, why delivery is stopped right now. Reads only; operator only.
pub async fn get_connector_trial(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<ConnectorTrialResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_instance_operator_write(&state, &principal).await?;
    let agent_member_id = crate::routes::shared::path_uuid(&agent, "invalid agent id")?;
    let attest = state.cohosted.config.attest();
    let judged = attest.clone();

    let (enabled, stopped) = settle_db(
        "cohosted_agent.connector_trial.get",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let known: bool = momo_db::sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM agent a \
                       JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id \
                      WHERE a.workspace_id = $1 AND a.member_id = $2 \
                        AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL)",
                )
                .bind(workspace_id)
                .bind(agent_member_id)
                .fetch_one(&mut *conn)
                .await?;
                if !known {
                    return Ok(Err(ApiError::not_found("active agent not found")));
                }
                let marked =
                    momo_agent::agent_connector_owner_in_tx(conn, workspace_id, agent_member_id)
                        .await?
                        .is_some();
                let facts =
                    momo_agent::connector_trial_facts_in_tx(conn, workspace_id, agent_member_id)
                        .await?;
                let stopped = momo_agent::connector_trial_stop(facts.as_ref(), &judged)
                    .map(momo_agent::ConnectorTrialStop::as_str);
                Ok(Ok((marked, stopped)))
            })
        })
        .await,
    )?;

    Ok(Json(ConnectorTrialResponse {
        schema: TRIAL_SCHEMA,
        agent_id: agent_member_id.to_string(),
        enabled,
        stopped,
        attested: attest_dto(&attest),
        note: SELF_DECLARED_NOTE,
    }))
}
