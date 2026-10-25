//! 같은 서버 에이전트(Hermes) 감지·연결 (#3883, ADR-0203).
//!
//! ```text
//! GET  /v1/workspaces/{ws}/cohosted-agent           status — never touches the network
//! POST /v1/workspaces/{ws}/cohosted-agent/probe     two fixed GETs at the declared host
//! POST /v1/workspaces/{ws}/cohosted-agent/connect   create the agent member + pin it
//! GET  /v1/workspaces/{ws}/cohosted-agent/models    logged-in providers' models (#4143)
//! PUT  /v1/workspaces/{ws}/cohosted-agent/model     choose provider + model (#4143)
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
//! 7. **The status adds two environment facts, as closed words** (#4337, ADR-0203
//!    증보 2026-10-25 F2): `environment { platform, loginRelay }`, always present
//!    whatever `declaration` says. `platform` was classified once at boot
//!    ([`crate::host_platform::HostPlatform`]); `loginRelay` is the very predicate the
//!    relay routes answer `409 login_relay_off` by. No env string is returned, and
//!    nothing here reads either value to decide anything but the screen's wording.

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
    provider_slug, CohostedAgentProbe, CohostedReport, CohostedTarget, ModelChoice,
    ModelOptionsReport, ProbeOutcome, ToolsetsSignal,
};
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
    read_agent_pin, redacted_endpoint_label, sanitized_model_id, set_agent_pin_model,
    upsert_agent_pin, validated_base_url, PinKind,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

use crate::config::{CohostedAgentConfig, LoginRelayConfig, SettingsConfig};
use crate::error::ApiError;
use crate::host_platform::HostPlatform;
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
const MODELS_SCHEMA: &str = "momo.cohosted_agent.models.v0";
const MODEL_SCHEMA: &str = "momo.cohosted_agent.model.v0";
const MODEL_AUDIT_SCHEMA: &str = "momo.cohosted_agent.model.audit.v0";
const MODEL_AUDIT_ACTION: &str = "agent.cohosted.model_changed";

/// How many of a provider's models are `featured` by default (ADR-0203 증보
/// 2026-10-20 M5): the first N **in Hermes's own order**, plus the model in use.
/// No model name is hard-coded here, so a new Hermes release's own ordering
/// decides what a generation's flagship tier is, and nothing needs a deploy.
pub const FEATURED_PER_PROVIDER: usize = 3;

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

/// Model-list reads and choices one operator may make per window. A separate,
/// larger bucket than probe/connect: it is one read-only GET at the operator's own
/// host per call, and a picker may be reopened a few times.
pub const OPERATOR_MODEL_CALLS_PER_WINDOW: u32 = 20;

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
    /// #4337 (ADR-0203 증보 2026-10-25 F2): always present, whatever `declaration` is.
    environment: EnvironmentDto,
}

/// Whether the Hermes login relay is switched on, as a closed word (F4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum RelaySwitch {
    On,
    Off,
}

/// The environment facts the screen picks its wording by (F2). Two closed enums and nothing else: no
/// stamp, no Railway id, no relay address or key ever goes out through here. Neither field is read by a
/// permission, egress or connectability decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentDto {
    /// `railway` | `compose` | `unknown` — classified at boot (F3).
    platform: HostPlatform,
    /// `on` | `off` — the relay routes' own predicate (F4).
    login_relay: RelaySwitch,
}

/// F4 — `on` exactly when the relay routes would not answer `409 login_relay_off`. It calls
/// [`LoginRelayConfig::target`], the call `login_relay::prepare` makes before that refusal, and **not**
/// `configured()`: that one is true for a URL the write gate refuses or one that carries a path, which
/// would put "on" on the screen above ten routes that all refuse. `on` means "configured and the address
/// passes the gate", not "the sidecar is alive" — nothing is dialled here.
fn login_relay_switch(config: &LoginRelayConfig, settings: &SettingsConfig) -> RelaySwitch {
    if config.target(settings).is_some() {
        RelaySwitch::On
    } else {
        RelaySwitch::Off
    }
}

fn environment_of(state: &AppState) -> EnvironmentDto {
    EnvironmentDto {
        platform: state.cohosted.config.platform,
        login_relay: login_relay_switch(&state.login_relay.config, &state.settings),
    }
}

/// The status body from its already-decided inputs. The handler's only job after the gate and the one pin
/// lookup is to call this, so the body's shape (and what the facts may influence) is testable without a
/// database.
fn assemble_status(
    declared: Declaration,
    label: Option<String>,
    attested: bool,
    connected: Option<Uuid>,
    environment: EnvironmentDto,
) -> StatusResponse {
    StatusResponse {
        schema: STATUS_SCHEMA,
        declaration: declared.as_str(),
        endpoint_label: label,
        tools_lock_attested: attested,
        connectable: declared == Declaration::Ready && attested && connected.is_none(),
        connected_agent_id: connected.map(|id| id.to_string()),
        environment,
    }
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
    Ok(Json(assemble_status(
        declared,
        label,
        state.cohosted.config.tools_locked,
        connected,
        environment_of(&state),
    )))
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

fn throttle_models(state: &AppState, principal: &Principal) -> Option<Response> {
    let verdict = state.cohosted.limiter.check(
        &format!("cohosted_agent:models:{}", principal.member_id),
        OPERATOR_MODEL_CALLS_PER_WINDOW,
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
    // #4143 (ADR-0203 증보 2026-10-20 M3): the model the agent answers on **now**,
    // read from Hermes's own options, so the pin names a real provider + model
    // instead of the virtual alias `hermes-agent` (which Hermes answers with its
    // default whatever is asked). A failed or odd read is not a refusal: the pin
    // then carries no route and the agent behaves exactly as before #4143.
    let route: Option<ModelChoice> = state
        .cohosted
        .probe
        .read_model_options(&target(&state))
        .await
        .current;
    // Otherwise the agent's own first model id; a name it did not list is never invented.
    let model = match &route {
        Some(route) => route.model.clone(),
        None => report
            .model_ids
            .first()
            .cloned()
            .unwrap_or_else(|| FALLBACK_MODEL.to_string()),
    };

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
            let route = route.clone();
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
                    if let Some(route) = &route {
                        set_agent_pin_model(
                            conn,
                            workspace_id,
                            agent.id,
                            &route.provider,
                            &route.model,
                        )
                        .await?;
                    }
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
                                    "model_provider": route.as_ref().map(|r| r.provider.as_str()),
                                    "model_id": route.as_ref().map(|r| r.model.as_str()),
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
// model choice (#4143, ADR-0203 증보 2026-10-20)
// ---------------------------------------------------------------------------
//
// ```text
// GET /v1/workspaces/{ws}/cohosted-agent/models   {current, hermesCurrent, providers[]}
// PUT /v1/workspaces/{ws}/cohosted-agent/model    {"provider": "...", "model": "..."}
// ```
//
// * **Instance operator only, both verbs**, gate first (a stranger spends nothing).
// * **The list is Hermes's, filtered to logged-in providers.** Every request reads
//   `GET {origin}/api/model/options` afresh; nothing a client sends is trusted as
//   a list, and a provider Hermes does not mark `authenticated` never appears.
// * **PUT is a membership check, not a parse.** `(provider, model)` must be listed
//   under a logged-in provider in that fresh read, else `422`. Nothing is written
//   on a refusal.
// * The pin keeps the pair, the worker sends the pair (a bare `model` is ignored
//   by Hermes), and `agent.model` mirrors the model for cards and usage rows.

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoiceDto {
    provider: String,
    model: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntryDto {
    id: String,
    /// The short list a picker shows first; the rest sit behind 「전체 보기」.
    featured: bool,
    /// The model the agent answers on now.
    current: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelsDto {
    provider: String,
    models: Vec<ModelEntryDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsResponse {
    schema: &'static str,
    agent_id: String,
    /// What the agent answers on: the pin's choice, else Hermes's current model.
    #[serde(skip_serializing_if = "Option::is_none")]
    current: Option<ModelChoiceDto>,
    /// True when an operator (or connect) wrote the pair on the pin; false means
    /// the agent follows what Hermes has as its current model.
    pinned: bool,
    /// Hermes's own current provider and model, whatever the pin says.
    #[serde(skip_serializing_if = "Option::is_none")]
    hermes_current: Option<ModelChoiceDto>,
    providers: Vec<ProviderModelsDto>,
}

/// The `featured` rule (ADR-0203 증보 2026-10-20 M5): per provider, the first
/// [`FEATURED_PER_PROVIDER`] models in Hermes's own order, and **always** the model
/// in use. Hermes lists a provider's newest flagship tiers first, so "the first few"
/// is "the current generation's representatives" without this crate naming a model.
pub fn provider_models_dto(
    options: &ModelOptionsReport,
    current: Option<&ModelChoice>,
) -> Vec<ProviderModelsDto> {
    options
        .providers
        .iter()
        .map(|entry| ProviderModelsDto {
            provider: entry.provider.clone(),
            models: entry
                .models
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    let in_use =
                        current.is_some_and(|c| c.provider == entry.provider && &c.model == id);
                    ModelEntryDto {
                        id: id.clone(),
                        featured: in_use || index < FEATURED_PER_PROVIDER,
                        current: in_use,
                    }
                })
                .collect(),
        })
        .collect()
}

fn choice_dto(choice: &ModelChoice) -> ModelChoiceDto {
    ModelChoiceDto {
        provider: choice.provider.clone(),
        model: choice.model.clone(),
    }
}

/// The operator-declared target, or the same 409 `connect` gives.
fn ready_target(state: &AppState) -> Result<CohostedTarget, ApiError> {
    if declaration(state).0 != Declaration::Ready {
        return Err(refusal(
            StatusCode::CONFLICT,
            "cohosted_agent_not_ready",
            "HERMES_BASE_URL과 HERMES_API_KEY를 서버에 설정해야 연결할 수 있어요.",
        ));
    }
    Ok(target(state))
}

async fn require_connected(state: &AppState, workspace_id: Uuid) -> Result<Uuid, ApiError> {
    connected_agent(state, workspace_id).await?.ok_or_else(|| {
        refusal(
            StatusCode::CONFLICT,
            "cohosted_agent_not_connected",
            "이 워크스페이스에 연결된 같은 서버의 에이전트가 없어요. 먼저 연결해 주세요.",
        )
    })
}

/// A fresh read of Hermes's options, or a 502 that says nothing about why.
async fn fresh_model_options(
    state: &AppState,
    target: &CohostedTarget,
) -> Result<ModelOptionsReport, ApiError> {
    let options = state.cohosted.probe.read_model_options(target).await;
    tracing::info!(
        outcome = options.outcome.as_str(),
        requests_sent = options.requests_sent,
        providers = options.providers.len(),
        "cohosted agent model options"
    );
    if options.outcome != ProbeOutcome::Ok {
        return Err(refusal(
            StatusCode::BAD_GATEWAY,
            "cohosted_models_unavailable",
            "같은 서버의 에이전트에서 모델 목록을 읽지 못했어요. 잠시 뒤 다시 시도해 주세요.",
        ));
    }
    Ok(options)
}

/// The pin's stored route, if the pin is the operator-env one.
async fn pinned_route(
    state: &AppState,
    workspace_id: Uuid,
    agent_id: Uuid,
) -> Result<Option<ModelChoice>, ApiError> {
    let pin = settle_db(
        "cohosted_agent.pinned_route",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match read_agent_pin(conn, workspace_id, agent_id).await {
                    Ok(pin) => Ok(Ok(pin)),
                    Err(momo_settings::PinReadError::Db(db)) => Err(db),
                    // A kind this build cannot read has no route it can show.
                    Err(momo_settings::PinReadError::UnknownKind) => Ok(Ok(None)),
                }
            })
        })
        .await,
    )?;
    Ok(pin
        .filter(|pin| pin.kind == PinKind::OperatorEnv)
        .and_then(|pin| pin.model_route)
        .map(|route| ModelChoice {
            provider: route.provider,
            model: route.model,
        }))
}

/// `GET /v1/workspaces/{ws}/cohosted-agent/models`.
pub async fn models(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_instance_operator_write(&state, &principal).await?;
    let target = ready_target(&state)?;
    // Before any database read: a caller hammering this route spends the budget
    // even when no agent is connected (#4159 L5).
    if let Some(limited) = throttle_models(&state, &principal) {
        return Ok(limited);
    }
    let agent_id = require_connected(&state, workspace_id).await?;
    let options = fresh_model_options(&state, &target).await?;
    let pinned = pinned_route(&state, workspace_id, agent_id).await?;
    let current = pinned.clone().or_else(|| options.current.clone());
    Ok(Json(ModelsResponse {
        schema: MODELS_SCHEMA,
        agent_id: agent_id.to_string(),
        current: current.as_ref().map(choice_dto),
        pinned: pinned.is_some(),
        hermes_current: options.current.as_ref().map(choice_dto),
        providers: provider_models_dto(&options, current.as_ref()),
    })
    .into_response())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutModelRequest {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PutModelResponse {
    schema: &'static str,
    agent_id: String,
    current: ModelChoiceDto,
    pinned: bool,
}

fn not_offered() -> ApiError {
    refusal(
        StatusCode::UNPROCESSABLE_ENTITY,
        "cohosted_model_not_offered",
        "그 제공자와 모델은 지금 선택할 수 없어요. 로그인된 제공자의 목록에서 골라 주세요.",
    )
}

/// Why the write found no `operator_env` pin on the agent it just read: the
/// agent was re-pinned to a team link in the meantime (#4159 L2, the operator
/// should look at the profile's AI connection) or it is simply gone/disconnected.
async fn not_connected_or_replaced(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    agent_id: Uuid,
) -> ApiError {
    let replaced = matches!(
        read_agent_pin(conn, workspace_id, agent_id).await,
        Ok(Some(pin)) if pin.kind != PinKind::OperatorEnv
    );
    if replaced {
        refusal(
            StatusCode::CONFLICT,
            "cohosted_agent_pin_replaced",
            "이 에이전트의 AI 연결이 다른 방식으로 바뀌어 같은 서버 모델을 고를 수 없어요.",
        )
    } else {
        refusal(
            StatusCode::CONFLICT,
            "cohosted_agent_not_connected",
            "이 워크스페이스에 연결된 같은 서버의 에이전트가 없어요. 먼저 연결해 주세요.",
        )
    }
}

/// `PUT /v1/workspaces/{ws}/cohosted-agent/model`.
pub async fn put_model(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PutModelRequest>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_instance_operator_write(&state, &principal).await?;
    // Spelling first, without a socket: only a plausible slug and id can be listed.
    let (Some(provider), Some(model)) = (
        provider_slug(&request.provider),
        sanitized_model_id(&request.model),
    ) else {
        return Err(not_offered());
    };
    let target = ready_target(&state)?;
    if let Some(limited) = throttle_models(&state, &principal) {
        return Ok(limited);
    }
    let agent_id = require_connected(&state, workspace_id).await?;
    // A fresh list, every time: the answer to "is this offered" is Hermes's now.
    let options = fresh_model_options(&state, &target).await?;
    if !options.lists(&provider, &model) {
        return Err(not_offered());
    }

    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let outcome: Result<(), ApiError> = with_provider_link_admin_tx(&state.pool, workspace_id, {
        let (provider, model) = (provider.clone(), model.clone());
        move |conn| {
            Box::pin(async move {
                // Still the connected agent, and the pin still the env link:
                // another operator may have disconnected between the read and now.
                if connected_agent_in_tx(conn, workspace_id).await? != Some(agent_id) {
                    return Ok(Err(
                        not_connected_or_replaced(conn, workspace_id, agent_id).await
                    ));
                }
                let previous = read_agent_pin(conn, workspace_id, agent_id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|pin| pin.model_route);
                if !set_agent_pin_model(conn, workspace_id, agent_id, &provider, &model).await? {
                    return Ok(Err(
                        not_connected_or_replaced(conn, workspace_id, agent_id).await
                    ));
                }
                // Cards and usage rows read `agent.model`; the pin is what the
                // worker sends. They are written together or not at all.
                momo_db::sqlx::query(
                    "UPDATE agent SET model = $3, updated_at = now() \
                      WHERE workspace_id = $1 AND member_id = $2",
                )
                .bind(workspace_id)
                .bind(agent_id)
                .bind(&model)
                .execute(&mut *conn)
                .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, MODEL_AUDIT_ACTION)
                        .by(actor)
                        .about(agent_id)
                        .target("agent", agent_id)
                        .via_token(via_token)
                        .with_schema(
                            MODEL_AUDIT_SCHEMA,
                            json!({
                                "provider": provider,
                                "model": model,
                                "previous_provider": previous.as_ref().map(|r| r.provider.as_str()),
                                "previous_model": previous.as_ref().map(|r| r.model.as_str()),
                            }),
                        ),
                )
                .await?;
                Ok(Ok(()))
            })
        }
    })
    .await
    .map_err(|error| ApiError::internal("cohosted_agent.put_model", error))?;
    outcome?;

    Ok(Json(PutModelResponse {
        schema: MODEL_SCHEMA,
        agent_id: agent_id.to_string(),
        current: ModelChoiceDto { provider, model },
        pinned: true,
    })
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
                    // Hermes has one token volume: any other agent that reaches it can
                    // use the connected apps whoever called that agent.
                    if momo_agent::other_operator_env_pinned_in_tx(
                        conn,
                        workspace_id,
                        agent_member_id,
                    )
                    .await?
                        > 0
                    {
                        return Ok(Err(trial_refusal(
                            "connector_trial_shared",
                            "같은 Hermes를 쓰도록 고정된 다른 에이전트가 있어요. 그 에이전트의 고정을 풀어야 앱 시험을 켤 수 있어요.",
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

#[cfg(test)]
mod tests {
    use super::*;
    use momo_provider_probe::ProviderModels;

    fn options(models: &[&str]) -> ModelOptionsReport {
        ModelOptionsReport {
            outcome: ProbeOutcome::Ok,
            reason: None,
            requests_sent: 1,
            current: None,
            providers: vec![ProviderModels {
                provider: "anthropic".into(),
                models: models.iter().map(|m| m.to_string()).collect(),
            }],
        }
    }

    fn featured(entries: &[ProviderModelsDto]) -> Vec<&str> {
        entries[0]
            .models
            .iter()
            .filter(|m| m.featured)
            .map(|m| m.id.as_str())
            .collect()
    }

    #[test]
    fn featured_is_the_first_few_in_hermes_order() {
        let report = options(&["a", "b", "c", "d", "e"]);
        let dto = provider_models_dto(&report, None);
        assert_eq!(featured(&dto), vec!["a", "b", "c"]);
        assert!(dto[0].models.iter().all(|m| !m.current));
    }

    #[test]
    fn the_model_in_use_is_featured_wherever_it_sits() {
        let report = options(&["a", "b", "c", "d", "e"]);
        let in_use = ModelChoice {
            provider: "anthropic".into(),
            model: "e".into(),
        };
        let dto = provider_models_dto(&report, Some(&in_use));
        assert_eq!(featured(&dto), vec!["a", "b", "c", "e"]);
        assert_eq!(
            dto[0].models.iter().filter(|m| m.current).count(),
            1,
            "exactly the one in use"
        );
        // The same model id under another provider is not "in use".
        let other = ModelChoice {
            provider: "openai-codex".into(),
            model: "e".into(),
        };
        let dto = provider_models_dto(&report, Some(&other));
        assert_eq!(featured(&dto), vec!["a", "b", "c"]);
    }

    // -----------------------------------------------------------------------
    // #4337 — the environment facts in the status body (ADR-0203 증보 2026-10-25).
    // None of these needs a database: the handler's work after the gate is
    // `assemble_status`, and `loginRelay` is one call on parsed config.
    // -----------------------------------------------------------------------

    use serde_json::{json, Value};
    use std::io::{self, Write};
    use std::sync::Mutex;
    use tracing_subscriber::fmt::MakeWriter;

    const PLATFORMS: [HostPlatform; 3] = [
        HostPlatform::Railway,
        HostPlatform::Compose,
        HostPlatform::Unknown,
    ];
    const SWITCHES: [RelaySwitch; 2] = [RelaySwitch::On, RelaySwitch::Off];

    /// The wire word of each variant, spelled out by hand. A `match` with no wildcard: a new variant
    /// does not compile until this (and so the lists above and the golden) learns it.
    fn platform_word(platform: HostPlatform) -> &'static str {
        match platform {
            HostPlatform::Railway => "railway",
            HostPlatform::Compose => "compose",
            HostPlatform::Unknown => "unknown",
        }
    }

    fn switch_word(switch: RelaySwitch) -> &'static str {
        match switch {
            RelaySwitch::On => "on",
            RelaySwitch::Off => "off",
        }
    }

    fn relay(url: Option<&str>, key: Option<&str>) -> LoginRelayConfig {
        LoginRelayConfig::from_lookup(|name| match name {
            "HERMES_LOGIN_RELAY_URL" => url.map(str::to_string),
            "HERMES_LOGIN_RELAY_KEY" => key.map(str::to_string),
            _ => None,
        })
    }

    const GOOD_KEY: &str = "relay-key-4337-0123456789abcdef0123456789abcdef";

    /// (name, url, key, what `configured()` says, the expected switch)
    type RelayRow<'a> = (&'a str, Option<&'a str>, Option<&'a str>, bool, RelaySwitch);

    /// ADR-0203 증보 2026-10-25 수용 기준 3 ([rust] 절반): `loginRelay` is the routes' predicate, table by table.
    /// The `configured` column is what `LoginRelayConfig::configured()` says for the same input: the rows
    /// where it is true and the answer is still `off` are the ones that tell `target()` from `configured()`.
    ///
    /// Env-free on purpose: an internal host (`http://hermes:8643`) is `on` only with the process env
    /// `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK` + `AGENT_PROVIDER_LOCAL_HOSTS`, which would be global state in
    /// a parallel test run; that row is the PG pack's (`login_relay_conformance_pg`).
    ///
    /// Sabotage: make `login_relay_switch` call `configured()` -> the `write gate refuses`, `private
    /// literal` and `path` rows go red; drop the key/URL half of `target()` -> the missing rows go red.
    #[test]
    fn login_relay_is_on_exactly_when_the_routes_would_not_refuse() {
        let long_key = "k".repeat(257);
        let short_key = "k".repeat(31);
        let settings = SettingsConfig::default();
        let rows: [RelayRow; 12] = [
            ("nothing set", None, None, false, RelaySwitch::Off),
            (
                "url without key",
                Some("https://relay.example.com"),
                None,
                false,
                RelaySwitch::Off,
            ),
            (
                "key without url",
                None,
                Some(GOOD_KEY),
                false,
                RelaySwitch::Off,
            ),
            (
                "key of 31 characters",
                Some("https://relay.example.com"),
                Some(short_key.as_str()),
                false,
                RelaySwitch::Off,
            ),
            (
                "key of 257 characters",
                Some("https://relay.example.com"),
                Some(long_key.as_str()),
                false,
                RelaySwitch::Off,
            ),
            (
                "key outside the character set",
                Some("https://relay.example.com"),
                Some("relay key with spaces 0123456789abcdef0123456789"),
                false,
                RelaySwitch::Off,
            ),
            (
                "unresolved shared-variable reference as the key",
                Some("https://relay.example.com"),
                Some("${{shared.HERMES_LOGIN_RELAY_KEY}}"),
                false,
                RelaySwitch::Off,
            ),
            (
                "write gate refuses plain http to a remote host",
                Some("http://relay.example.com"),
                Some(GOOD_KEY),
                true,
                RelaySwitch::Off,
            ),
            (
                "write gate refuses a private literal",
                Some("https://10.0.0.5"),
                Some(GOOD_KEY),
                true,
                RelaySwitch::Off,
            ),
            (
                "url with a path",
                Some("https://relay.example.com/v1"),
                Some(GOOD_KEY),
                true,
                RelaySwitch::Off,
            ),
            (
                "public https origin",
                Some("https://relay.example.com"),
                Some(GOOD_KEY),
                true,
                RelaySwitch::On,
            ),
            (
                "public https origin with a port",
                Some("https://relay.example.com:8443"),
                Some(GOOD_KEY),
                true,
                RelaySwitch::On,
            ),
        ];
        // Every row is judged before the test fails, so the failure names all the rows a change breaks.
        let mut wrong: Vec<String> = Vec::new();
        for (name, url, key, configured, expected) in rows {
            let config = relay(url, key);
            if config.configured() != configured {
                wrong.push(format!("{name}: configured() is not {configured}"));
            }
            let got = login_relay_switch(&config, &settings);
            if got != expected {
                wrong.push(format!("{name}: expected {expected:?}, got {got:?}"));
            }
            // The status and the routes ask one question.
            if (expected == RelaySwitch::On) != config.target(&settings).is_some() {
                wrong.push(format!(
                    "{name}: target() disagrees with the expected switch"
                ));
            }
        }
        assert!(
            wrong.is_empty(),
            "rows that disagree:\n{}",
            wrong.join("\n")
        );
    }

    /// ADR-0203 증보 2026-10-25 수용 기준 5 ([rust]): the environment is wording only. Two reference states
    /// (and the undeclared one, where the field must still be there), every `platform` x `loginRelay`
    /// combination: everything but `environment` is the same.
    ///
    /// Sabotage: let `connectable` read the platform (`&& platform != Unknown`) -> red.
    #[test]
    fn the_environment_decides_nothing_but_wording() {
        let agent = Uuid::from_u128(0x4337);
        let label = || Some("http://hermes.railway.internal:8642/v1".to_string());
        let states = [
            (
                "ready, attested, not connected",
                Declaration::Ready,
                true,
                None,
                true,
            ),
            ("connected", Declaration::Ready, true, Some(agent), false),
            ("not declared", Declaration::NotDeclared, false, None, false),
        ];
        for (name, declared, attested, connected, connectable) in states {
            let mut reference: Option<Value> = None;
            for platform in PLATFORMS {
                for login_relay in SWITCHES {
                    let mut body = serde_json::to_value(assemble_status(
                        declared,
                        label(),
                        attested,
                        connected,
                        EnvironmentDto {
                            platform,
                            login_relay,
                        },
                    ))
                    .unwrap();
                    let environment = body
                        .as_object_mut()
                        .unwrap()
                        .remove("environment")
                        .unwrap_or_else(|| panic!("{name}: environment is missing"));
                    assert_eq!(
                        environment,
                        json!({"platform": platform_word(platform), "loginRelay": switch_word(login_relay)}),
                        "{name}"
                    );
                    match &reference {
                        None => reference = Some(body),
                        Some(first) => assert_eq!(
                            &body, first,
                            "{name}: {platform:?}/{login_relay:?} changed more than `environment`"
                        ),
                    }
                }
            }
            let reference = reference.unwrap();
            assert_eq!(reference["connectable"], connectable, "{name}");
            assert_eq!(
                reference["connectedAgentId"],
                connected.map_or(Value::Null, |id| json!(id.to_string())),
                "{name}"
            );
        }
    }

    /// The golden wire (`docs/api/cohosted-agent-status.golden.json`), read at compile time: a missing file
    /// is a build failure, never a skipped check.
    const GOLDEN: &str = include_str!("../../../../../docs/api/cohosted-agent-status.golden.json");

    /// ADR-0203 증보 2026-10-25 수용 기준 6 ([rust]): the serialized status equals the golden, case by case;
    /// the golden names every enum word and the exact `environment` key set; and the golden carries no case
    /// this test does not build (so neither side can grow alone).
    ///
    /// Sabotage: rename `login_relay` on the wire, rename a variant word, drop `environment` from the
    /// assembled body, or change the schema string -> red.
    #[test]
    fn the_serialized_status_is_the_golden() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
        assert_eq!(golden["schema"], STATUS_SCHEMA);
        assert_eq!(
            golden["environment"]["keys"],
            json!(["platform", "loginRelay"])
        );
        assert_eq!(
            golden["environment"]["platform"],
            json!(PLATFORMS.map(platform_word)),
            "golden platform words"
        );
        assert_eq!(
            golden["environment"]["loginRelay"],
            json!(SWITCHES.map(switch_word)),
            "golden loginRelay words"
        );
        // Every variant, serialized, is its word.
        for platform in PLATFORMS {
            assert_eq!(
                serde_json::to_value(platform).unwrap(),
                platform_word(platform)
            );
        }
        for switch in SWITCHES {
            assert_eq!(serde_json::to_value(switch).unwrap(), switch_word(switch));
        }

        let agent = Uuid::parse_str("00000000-0000-7000-8000-0000000000aa").unwrap();
        let hermes = || Some("http://hermes:8642/v1".to_string());
        let railway = || Some("http://hermes.railway.internal:8642/v1".to_string());
        let built: Vec<(&str, StatusResponse)> = vec![
            (
                "not_declared_compose_relay_off",
                assemble_status(
                    Declaration::NotDeclared,
                    None,
                    false,
                    None,
                    EnvironmentDto {
                        platform: HostPlatform::Compose,
                        login_relay: RelaySwitch::Off,
                    },
                ),
            ),
            (
                "not_declared_railway_relay_on",
                assemble_status(
                    Declaration::NotDeclared,
                    None,
                    false,
                    None,
                    EnvironmentDto {
                        platform: HostPlatform::Railway,
                        login_relay: RelaySwitch::On,
                    },
                ),
            ),
            (
                "key_missing_unknown_relay_off",
                assemble_status(
                    Declaration::KeyMissing,
                    hermes(),
                    true,
                    None,
                    EnvironmentDto {
                        platform: HostPlatform::Unknown,
                        login_relay: RelaySwitch::Off,
                    },
                ),
            ),
            (
                "ready_attested_compose_relay_on",
                assemble_status(
                    Declaration::Ready,
                    hermes(),
                    true,
                    None,
                    EnvironmentDto {
                        platform: HostPlatform::Compose,
                        login_relay: RelaySwitch::On,
                    },
                ),
            ),
            (
                "connected_railway_relay_on",
                assemble_status(
                    Declaration::Ready,
                    railway(),
                    true,
                    Some(agent),
                    EnvironmentDto {
                        platform: HostPlatform::Railway,
                        login_relay: RelaySwitch::On,
                    },
                ),
            ),
        ];
        let cases = golden["cases"].as_array().expect("golden cases");
        assert_eq!(
            cases.len(),
            built.len(),
            "the golden and this test list different cases"
        );
        for (name, status) in built {
            let case = cases
                .iter()
                .find(|case| case["name"] == name)
                .unwrap_or_else(|| panic!("golden has no case {name}"));
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                case["body"],
                "case {name}"
            );
        }
    }

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for Capture {
        type Writer = Capture;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// ADR-0203 증보 2026-10-25 수용 기준 2 ([rust] 절반): an arbitrary env string never comes back out.
    /// The markers go into the stamp, the Railway id, the relay URL (a public https host, so the relay is
    /// `on` and its address is really in play) and the relay key. The parse **and** the body's
    /// serialization run under one `tracing` capture. The configurations are split by which platform
    /// marker is present, because with both set the classifier ends at row 1 and never reaches the stamp:
    /// a logger of the stamp would show only in the stamp-only configuration.
    ///
    /// Sabotage: `warn!` the stamp in the parser (stamp-only goes red); put `settings`-normalised relay
    /// URL or label into `EnvironmentDto` (all go red, and the key-set check does too); serialize a raw
    /// env string as `platform`; hold the raw stamp in `CohostedAgentConfig` (the `{:?}` check).
    #[test]
    fn no_env_string_reaches_the_body_or_the_logs() {
        const PLATFORM_MARKER: &str = "MARKER-PLATFORM-4337-body";
        const RWENV_MARKER: &str = "MARKER-RWENV-4337-body";
        const RELAY_HOST_MARKER: &str = "marker-relayurl-4337-body";
        const RELAY_KEY_MARKER: &str = "MARKER-RELAYKEY-4337-body-0123456789abcdef";
        let configurations: [(&str, Option<&str>, Option<&str>); 3] = [
            ("railway id only", Some(RWENV_MARKER), None),
            ("stamp only", None, Some(PLATFORM_MARKER)),
            ("both", Some(RWENV_MARKER), Some(PLATFORM_MARKER)),
        ];
        let settings = SettingsConfig::default();
        for (name, railway_id, stamp) in configurations {
            let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
            let subscriber = tracing_subscriber::fmt()
                .with_writer(Capture(logs.clone()))
                .with_max_level(tracing::Level::TRACE)
                .finish();
            let lookup = |key: &str| -> Option<String> {
                match key {
                    "RAILWAY_ENVIRONMENT_ID" => railway_id.map(str::to_string),
                    "MOMO_SELF_HOST_PLATFORM" => stamp.map(str::to_string),
                    "HERMES_LOGIN_RELAY_URL" => {
                        Some(format!("https://{RELAY_HOST_MARKER}.example.com"))
                    }
                    "HERMES_LOGIN_RELAY_KEY" => Some(RELAY_KEY_MARKER.to_string()),
                    _ => None,
                }
            };
            let (body, debug) = tracing::subscriber::with_default(subscriber, || {
                let cohosted = CohostedAgentConfig::from_lookup(lookup);
                let relay_config = LoginRelayConfig::from_lookup(lookup);
                let environment = EnvironmentDto {
                    platform: cohosted.platform,
                    login_relay: login_relay_switch(&relay_config, &settings),
                };
                assert_eq!(
                    environment.login_relay,
                    RelaySwitch::On,
                    "{name}: the relay markers must make the relay `on`, or the check proves nothing"
                );
                let body = serde_json::to_string(&assemble_status(
                    Declaration::Ready,
                    Some("http://hermes:8642/v1".to_string()),
                    true,
                    None,
                    environment,
                ))
                .unwrap();
                // Positive control: the capture hears this thread.
                tracing::warn!("capture-control-4337");
                (body, format!("{cohosted:?}"))
            });
            let logs = String::from_utf8_lossy(&logs.lock().unwrap()).to_ascii_lowercase();
            assert!(
                logs.contains("capture-control-4337"),
                "{name}: capture is deaf"
            );

            let mut markers = vec![RELAY_HOST_MARKER, RELAY_KEY_MARKER];
            markers.extend(railway_id);
            markers.extend(stamp);
            for marker in markers {
                let marker = marker.to_ascii_lowercase();
                assert!(
                    !body.to_ascii_lowercase().contains(&marker),
                    "{name}: body has {marker}: {body}"
                );
                assert!(
                    !logs.contains(&marker),
                    "{name}: logs have {marker}: {logs}"
                );
            }
            assert!(
                !debug.to_ascii_lowercase().contains("marker-"),
                "{name}: Debug has a marker: {debug}"
            );

            let parsed: Value = serde_json::from_str(&body).unwrap();
            let environment = parsed["environment"]
                .as_object()
                .expect("environment is an object");
            let mut keys: Vec<&str> = environment.keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["loginRelay", "platform"], "{name}");
            assert!(
                PLATFORMS
                    .map(platform_word)
                    .contains(&environment["platform"].as_str().unwrap()),
                "{name}: platform outside the enum"
            );
            assert!(
                SWITCHES
                    .map(switch_word)
                    .contains(&environment["loginRelay"].as_str().unwrap()),
                "{name}: loginRelay outside the enum"
            );
        }
    }
}
