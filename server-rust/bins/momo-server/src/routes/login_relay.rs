//! Hermes 로그인 중계 — 운영자 전용 oort API (#4079; ADR-0203 증보 2026-10-19 L4, ADR-0004 증보 7).
//!
//! ```text
//! GET    /v1/workspaces/{ws}/agents/{agent}/model-login                    connected? (Codex, Claude)
//! POST   /v1/workspaces/{ws}/agents/{agent}/model-login                    {"provider"}  start
//! POST   /v1/workspaces/{ws}/agents/{agent}/model-login/{login_id}/complete {"pasted"}
//! GET    /v1/workspaces/{ws}/agents/{agent}/model-login/{login_id}         poll
//! DELETE /v1/workspaces/{ws}/agents/{agent}/model-login/{login_id}         cancel
//! (the same five under …/app-login with {"app"} for an MCP app)
//! ```
//!
//! The sidecar (`infra/hermes/login_relay.py`) runs the vendor login inside the operator's Hermes. This
//! module is the **0-byte boundary** in front of it (Q1, ADR-0004 증보 7): a one-time authorization code
//! or a device code passes through here ONCE and is not stored, logged, audited, echoed in an error,
//! counted in a metric, pushed, or published to Centrifugo. Tokens never come here at all.
//!
//! ## Rules this module holds
//!
//! 1. **Instance operator only, every route** (`require_instance_operator_write`), first thing, so a
//!    stranger learns nothing — not even whether the relay is configured. A `platform:read` scope is not enough.
//! 2. **No key, no relay** (`409 login_relay_off`): without `HERMES_LOGIN_RELAY_URL` + `HERMES_LOGIN_RELAY_KEY`
//!    nothing is dialled and the screen shows the shell command instead (ADR Q3).
//! 3. **Only the operator's own co-hosted Hermes**: the agent is owned by the caller and pinned
//!    `operator_env` (the K-S2 check). An app login also needs exactly one active person and no other agent on
//!    the same Hermes (its token volume has no per-person isolation, ADR K2).
//! 4. **`pasted` is a [`Pasted`]**: `Debug` and `Serialize` print `<redacted>`. The request body is read as
//!    bytes and parsed here, so no extractor error text can echo it, and this module's own `debug!` of the
//!    request struct (below) prints the masked form.
//! 5. **Nothing is persisted**: no table, `login_id` is only relayed, the audit row carries the actor,
//!    `kind/target` and a result word from a closed set. Every response is `Cache-Control: no-store`.
//! 6. **Request-body logging is off for these routes**: the server has no body-logging layer, and one added
//!    later must skip `/model-login` and `/app-login`. If cookie authentication is ever introduced
//!    (ADR-0119 reserves a refresh-cookie upgrade before the public alpha), these routes must also require
//!    an `Origin` check and a custom header — today the bearer-header token has no CSRF surface.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_provider_probe::{
    is_login_id, is_target_name, Pasted, RelayFailure, RelayKind, RelayMode, RelayTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

use crate::config::LoginRelayConfig;
use crate::error::ApiError;
use crate::rate_limit::{too_many_requests, SlidingWindowRateLimiter};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_instance_operator_write, settle_db,
    workspace_scope,
};
use crate::AppState;

const START_SCHEMA: &str = "momo.login_relay.start.v0";
const STATUS_SCHEMA: &str = "momo.login_relay.status.v0";
const TARGETS_SCHEMA: &str = "momo.login_relay.targets.v0";
const AUDIT_SCHEMA: &str = "momo.login_relay.audit.v0";

/// Starts one operator may make per window (each one calls the real vendor for Codex).
pub const START_CALLS_PER_WINDOW: u32 = 6;
/// Paste attempts per window (the sidecar also stops a login after three refusals).
pub const COMPLETE_CALLS_PER_WINDOW: u32 = 12;
/// Polls, cancels and target reads (each is a DB transaction plus a sidecar call; the screen polls every few seconds).
pub const READ_CALLS_PER_WINDOW: u32 = 120;
pub const CALL_WINDOW: Duration = Duration::from_secs(60);

const PROVIDERS: [&str; 2] = ["openai-codex", "anthropic"];

/// What the operator declared for the relay, the client that can act on it, and its throttle.
pub struct LoginRelayState {
    pub config: LoginRelayConfig,
    client: Arc<dyn momo_provider_probe::LoginRelayClient>,
    limiter: SlidingWindowRateLimiter,
}

impl LoginRelayState {
    pub fn new(
        config: LoginRelayConfig,
        client: Arc<dyn momo_provider_probe::LoginRelayClient>,
    ) -> Self {
        LoginRelayState {
            config,
            client,
            limiter: SlidingWindowRateLimiter::new(),
        }
    }
}

/// The two route families share one implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flow {
    /// `…/model-login`: provider subscription login (Codex, Claude).
    Model,
    /// `…/app-login`: an MCP app (Gmail, Calendar, Drive, …).
    App,
}

impl Flow {
    fn kind(self) -> RelayKind {
        match self {
            Flow::Model => RelayKind::Provider,
            Flow::App => RelayKind::Mcp,
        }
    }

    fn audit_action(self, step: &str) -> String {
        match self {
            Flow::Model => format!("agent.model_login.{step}"),
            Flow::App => format!("agent.app_login.{step}"),
        }
    }

    fn name_ok(self, name: &str) -> bool {
        match self {
            Flow::Model => PROVIDERS.contains(&name),
            Flow::App => is_target_name(name),
        }
    }
}

// ---------------------------------------------------------------------------
// request / response shapes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartModel {
    provider: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartApp {
    app: String,
}

/// The `complete` body. `Debug` is derived on purpose: the value is a [`Pasted`], so a `{:?}` of the whole
/// request (the thing a careless `debug!` would print) shows `<redacted>`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteBody {
    pasted: Pasted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    schema: &'static str,
    login_id: String,
    /// `device` (show URL + code, then poll) | `paste` (open the URL, paste back what the vendor shows).
    mode: &'static str,
    /// For the screen once. Not stored here; `Cache-Control: no-store`.
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    expires_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    schema: &'static str,
    /// `pending | submitted | done | failed | expired | cancelled`.
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetDto {
    target: String,
    connected: bool,
    /// An ESTIMATE of when this app's login may lapse (#4081). Only on a connected app; never a fact.
    #[serde(skip_serializing_if = "Option::is_none")]
    estimated: Option<EstimateDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EstimateDto {
    basis: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    issued_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    test_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'static str>,
}

/// Google refresh tokens of an External app in Testing lapse about this long after consent.
const GOOGLE_TESTING_REFRESH_SECS: i64 = 7 * 24 * 60 * 60;
/// The three Google apps behind the probe path (keep equal to the sidecar's `GOOGLE_PROBE_SERVERS`).
const GOOGLE_APPS: [&str; 3] = ["gmail", "google_calendar", "google_drive"];

/// Policy over the relay's clock reading. The relay supplies facts (`basis`, `issuedAt`); the operator's
/// declaration supplies the rule. The 7-day expiry is computed only from an OBSERVED login: a file time can be
/// moved by a routine access-token refresh, and a deadline built on it would be a made-up number.
fn estimate_dto(
    target: &str,
    reading: Option<momo_provider_probe::LoginEstimate>,
    google_testing: bool,
) -> Option<EstimateDto> {
    use momo_provider_probe::EstimateBasis;
    let reading = reading?;
    let testing = google_testing && GOOGLE_APPS.contains(&target);
    let observed = reading.basis == EstimateBasis::RelayObservedLogin;
    let expires_at = (testing && observed)
        .then(|| {
            reading
                .issued_at
                .and_then(|at| at.checked_add(GOOGLE_TESTING_REFRESH_SECS))
        })
        .flatten();
    let note = if testing && observed {
        Some("google_testing_refresh_7d")
    } else if reading.basis == EstimateBasis::TokenFileMtime {
        Some("token_age_unknown_start")
    } else {
        None
    };
    Some(EstimateDto {
        basis: reading.basis.as_str(),
        issued_at: reading.issued_at,
        test_mode: testing.then_some(true),
        expires_at,
        note,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetsResponse {
    schema: &'static str,
    targets: Vec<TargetDto>,
}

fn no_store<T: Serialize>(status: StatusCode, body: T) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::PRAGMA, "no-cache"),
        ],
        Json(body),
    )
        .into_response()
}

/// A fixed refusal text per code: never a word from the sidecar or the request.
fn failure(failure: RelayFailure) -> ApiError {
    let (status, code, message): (StatusCode, &'static str, &'static str) = match failure {
        RelayFailure::Invalid => (
            StatusCode::BAD_REQUEST,
            "relay_invalid",
            "요청 값이 올바르지 않아요.",
        ),
        RelayFailure::EgressDenied | RelayFailure::Unreachable => (
            StatusCode::BAD_GATEWAY,
            "login_relay_unreachable",
            "로그인 중계에 닿지 못했어요. Hermes 컨테이너가 떠 있는지 확인해 주세요.",
        ),
        RelayFailure::BadResponse => (
            StatusCode::BAD_GATEWAY,
            "login_relay_bad_response",
            "로그인 중계의 답을 읽지 못했어요.",
        ),
        RelayFailure::Refused { code, .. } => match code {
            "login_in_progress" => (
                StatusCode::CONFLICT,
                "login_in_progress",
                "이 대상의 로그인이 이미 진행 중이에요. 끝내거나 취소한 뒤 다시 시작해 주세요.",
            ),
            "rate_limited" => (
                StatusCode::TOO_MANY_REQUESTS,
                "login_relay_rate_limited",
                "잠시 뒤에 다시 시도해 주세요.",
            ),
            "operator_mismatch" => (
                StatusCode::FORBIDDEN,
                "login_forbidden",
                "다른 운영자가 시작한 로그인이에요.",
            ),
            "not_found" => (
                StatusCode::NOT_FOUND,
                "login_not_found",
                "이 로그인은 없거나 이미 끝나서 지워졌어요.",
            ),
            "state_mismatch" => (
                StatusCode::BAD_REQUEST,
                "state_mismatch",
                "붙여넣은 값이 이 로그인에서 받은 것이 아니에요. 열린 로그인 창의 값을 다시 복사해 주세요.",
            ),
            "redirect_mismatch" | "extra_params" | "bad_paste" => (
                StatusCode::BAD_REQUEST,
                match code {
                    "redirect_mismatch" => "redirect_mismatch",
                    "extra_params" => "extra_params",
                    _ => "bad_paste",
                },
                "붙여넣은 값의 모양이 맞지 않아요. 로그인 창이 보여 준 값을 그대로 붙여넣어 주세요.",
            ),
            "already_submitted" | "not_pending" | "not_paste_mode" => (
                StatusCode::CONFLICT,
                match code {
                    "already_submitted" => "already_submitted",
                    "not_pending" => "login_not_pending",
                    _ => "not_paste_mode",
                },
                "지금은 값을 붙여넣을 수 없는 로그인이에요.",
            ),
            "url_rejected" | "parse_failed" | "start_failed" | "start_timeout" => (
                StatusCode::BAD_GATEWAY,
                match code {
                    "url_rejected" => "login_url_rejected",
                    "parse_failed" => "login_parse_failed",
                    "start_timeout" => "login_start_timeout",
                    _ => "login_start_failed",
                },
                "로그인을 시작하지 못했어요. 셸 명령으로 로그인할 수 있어요.",
            ),
            "unauthorized" => (
                StatusCode::BAD_GATEWAY,
                "login_relay_misconfigured",
                "로그인 중계의 키가 서로 맞지 않아요. 두 쪽의 HERMES_LOGIN_RELAY_KEY를 확인해 주세요.",
            ),
            _ => (
                StatusCode::BAD_GATEWAY,
                "login_relay_error",
                "로그인 중계가 요청을 처리하지 못했어요.",
            ),
        },
    };
    ApiError::coded(status, code, message)
}

/// Closed vocabulary for the audit `result`.
fn result_word(failure: &RelayFailure) -> &'static str {
    match failure {
        RelayFailure::Invalid => "invalid",
        RelayFailure::EgressDenied | RelayFailure::Unreachable => "unreachable",
        RelayFailure::BadResponse => "bad_response",
        RelayFailure::Refused { code, .. } => match *code {
            "login_in_progress" => "in_progress",
            "rate_limited" => "rate_limited",
            "operator_mismatch" => "forbidden",
            "not_found" => "not_found",
            "state_mismatch" | "redirect_mismatch" | "extra_params" | "bad_paste" => {
                "paste_refused"
            }
            "url_rejected" | "parse_failed" | "start_failed" | "start_timeout" => "start_failed",
            _ => "relay_error",
        },
    }
}

// ---------------------------------------------------------------------------
// the shared pre-flight
// ---------------------------------------------------------------------------

struct Ready {
    workspace_id: Uuid,
    agent: Uuid,
    actor: Uuid,
    via_token: Option<Uuid>,
    target: RelayTarget,
    /// The `X-Operator` value: the caller's member id (stable, no PII).
    operator: String,
}

/// Proof that the caller is a listed instance operator of this workspace. Every handler gets one before it
/// reads a byte of the body: a stranger gets 403 whatever he sends, spends no throttle, and learns nothing.
struct Authorized {
    workspace_id: Uuid,
}

async fn authorize(
    state: &AppState,
    principal: &Principal,
    workspace: &str,
) -> Result<Authorized, ApiError> {
    let workspace_id = workspace_scope(workspace, principal)?;
    require_instance_operator_write(state, principal).await?;
    Ok(Authorized { workspace_id })
}

/// Relay switch → the caller's own pinned Hermes → (start only) the app-login rules.
/// A refusal writes nothing and dials nothing.
async fn prepare(
    state: &AppState,
    principal: &Principal,
    auth: Authorized,
    agent: &str,
    flow: Flow,
    starting: bool,
) -> Result<Ready, ApiError> {
    let workspace_id = auth.workspace_id;
    let Some(target) = state.login_relay.config.target(&state.settings) else {
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "login_relay_off",
            "이 서버는 로그인 중계가 꺼져 있어요. 셸 명령으로 로그인해 주세요.",
        ));
    };
    let agent_member_id = path_uuid(agent, "invalid agent id")?;
    let actor = principal.member_id;
    let app_rules = starting && flow == Flow::App;

    settle_db(
        "login_relay.prepare",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let owner: Option<Option<Uuid>> = momo_db::sqlx::query_scalar(
                    "SELECT a.owner_human_id FROM agent a \
                       JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id \
                      WHERE a.workspace_id = $1 AND a.member_id = $2 \
                        AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL",
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
                        "only the operator who connected this agent can log it in",
                    )));
                }
                if !momo_agent::agent_is_operator_env_pinned_in_tx(conn, workspace_id, agent_member_id)
                    .await?
                {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "login_not_cohosted",
                        "같은 서버에 연결한 Hermes 에이전트에서만 로그인할 수 있어요.",
                    )));
                }
                if app_rules {
                    // The apps' tokens live in one Hermes volume with no per-person isolation (ADR K2).
                    if momo_agent::other_operator_env_pinned_in_tx(conn, workspace_id, agent_member_id)
                        .await?
                        > 0
                    {
                        return Ok(Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "connector_trial_shared",
                            "같은 Hermes를 쓰도록 고정된 다른 에이전트가 있어요. 그 에이전트의 고정을 풀어야 앱에 로그인할 수 있어요.",
                        )));
                    }
                    let facts =
                        momo_agent::trial_candidate_facts_in_tx(conn, workspace_id, actor).await?;
                    if facts.active_humans != 1 {
                        return Ok(Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "connector_trial_members",
                            "활성 사람 멤버가 정확히 1명인 워크스페이스에서만 앱에 로그인할 수 있어요.",
                        )));
                    }
                }
                Ok(Ok(()))
            })
        })
        .await,
    )?;

    Ok(Ready {
        workspace_id,
        agent: agent_member_id,
        actor,
        via_token: audit_via_token_id(principal),
        target,
        operator: actor.to_string(),
    })
}

fn throttle(state: &AppState, principal: &Principal, step: &str, limit: u32) -> Option<Response> {
    let verdict = state.login_relay.limiter.check(
        &format!("login_relay:{step}:operator:{}", principal.member_id),
        limit,
        CALL_WINDOW,
    );
    (!verdict.allowed).then(|| too_many_requests(verdict.retry_after_seconds))
}

/// The audit line must not decide the outcome of a login that already happened in Hermes: if the write fails
/// after the sidecar answered, the caller still gets the answer (a 500 here would lose the device code and strand
/// the target in `login_in_progress`, or turn an accepted paste into `already_submitted` on retry). The failure
/// is logged with fixed words only.
async fn audit_best_effort(
    state: &AppState,
    ready: &Ready,
    flow: Flow,
    step: &str,
    name: &str,
    result: &'static str,
) {
    if audit(state, ready, flow, step, name, result).await.is_err() {
        tracing::warn!(step, result, "login relay audit line could not be written");
    }
}

/// One audit line: actor, `kind/target`, a result word from a closed set. Never the URL, a code, the pasted
/// value or the `login_id`.
async fn audit(
    state: &AppState,
    ready: &Ready,
    flow: Flow,
    step: &str,
    name: &str,
    result: &'static str,
) -> Result<(), ApiError> {
    let entry_workspace = ready.workspace_id;
    let (actor, agent, via_token) = (ready.actor, ready.agent, ready.via_token);
    let action = flow.audit_action(step);
    let kind = flow.kind().as_str();
    let name = name.to_string();
    settle_db(
        "login_relay.audit",
        agent_tenant_tx(&state.pool, entry_workspace, move |conn| {
            Box::pin(async move {
                write_audit(
                    conn,
                    &AuditEntry::new(entry_workspace, &action)
                        .by(actor)
                        .about(agent)
                        .target("agent", agent)
                        .via_token(via_token)
                        .with_schema(
                            AUDIT_SCHEMA,
                            json!({ "kind": kind, "target": name, "result": result }),
                        ),
                )
                .await?;
                Ok(Ok(()))
            })
        })
        .await,
    )
}

/// A login id that is not the sidecar's shape never becomes a path: it is simply not a login.
fn require_login_id(login_id: &str) -> Result<(), ApiError> {
    if is_login_id(login_id) {
        Ok(())
    } else {
        Err(ApiError::coded(
            StatusCode::NOT_FOUND,
            "login_not_found",
            "이 로그인은 없거나 이미 끝나서 지워졌어요.",
        ))
    }
}

fn status_response(reply: momo_provider_probe::StatusReply) -> Response {
    no_store(
        StatusCode::OK,
        StatusResponse {
            schema: STATUS_SCHEMA,
            status: reply.status,
            reason: reply.reason,
        },
    )
}

// ---------------------------------------------------------------------------
// handlers (shared bodies)
// ---------------------------------------------------------------------------

async fn targets_of(
    state: AppState,
    principal: Principal,
    workspace: String,
    agent: String,
    flow: Flow,
) -> Result<Response, ApiError> {
    let auth = authorize(&state, &principal, &workspace).await?;
    let ready = prepare(&state, &principal, auth, &agent, flow, false).await?;
    if let Some(refusal) = throttle(&state, &principal, "read", READ_CALLS_PER_WINDOW) {
        return Ok(refusal);
    }
    let list = state
        .login_relay
        .client
        .status(&ready.target)
        .await
        .map_err(failure)?;
    let targets = list
        .into_iter()
        .filter(|t| t.kind == flow.kind())
        .map(|t| TargetDto {
            estimated: if flow == Flow::App && t.connected {
                estimate_dto(
                    &t.target,
                    t.estimate,
                    state.login_relay.config.google_testing(),
                )
            } else {
                None
            },
            target: t.target,
            connected: t.connected,
        })
        .collect();
    Ok(no_store(
        StatusCode::OK,
        TargetsResponse {
            schema: TARGETS_SCHEMA,
            targets,
        },
    ))
}

async fn start_of(
    state: AppState,
    principal: Principal,
    workspace: String,
    agent: String,
    flow: Flow,
    body: Bytes,
) -> Result<Response, ApiError> {
    // Authority before the body: a stranger gets 403 even for a malformed body.
    let auth = authorize(&state, &principal, &workspace).await?;
    // The body is parsed here, not by an extractor: a malformed body gets one fixed answer, no parser text.
    let name = match flow {
        Flow::Model => serde_json::from_slice::<StartModel>(&body).map(|b| b.provider),
        Flow::App => serde_json::from_slice::<StartApp>(&body).map(|b| b.app),
    }
    .map_err(|_| ApiError::bad_request("invalid request body"))?;
    let ready = prepare(&state, &principal, auth, &agent, flow, true).await?;
    if !flow.name_ok(&name) {
        return Err(ApiError::bad_request(match flow {
            Flow::Model => "unknown provider",
            Flow::App => "invalid app name",
        }));
    }
    if let Some(refusal) = throttle(&state, &principal, "start", START_CALLS_PER_WINDOW) {
        return Ok(refusal);
    }
    match state
        .login_relay
        .client
        .start(&ready.target, flow.kind(), &name, &ready.operator)
        .await
    {
        Ok(reply) => {
            audit_best_effort(&state, &ready, flow, "started", &name, "started").await;
            Ok(no_store(
                StatusCode::OK,
                StartResponse {
                    schema: START_SCHEMA,
                    login_id: reply.login_id,
                    mode: match reply.mode {
                        RelayMode::Device => "device",
                        RelayMode::Paste => "paste",
                    },
                    url: reply.url,
                    user_code: reply.user_code,
                    expires_at: reply.expires_at,
                },
            ))
        }
        Err(error) => {
            audit_best_effort(&state, &ready, flow, "started", &name, result_word(&error)).await;
            Err(failure(error))
        }
    }
}

async fn complete_of(
    state: AppState,
    principal: Principal,
    workspace: String,
    agent: String,
    login_id: String,
    flow: Flow,
    body: Bytes,
) -> Result<Response, ApiError> {
    let auth = authorize(&state, &principal, &workspace).await?;
    let request = serde_json::from_slice::<CompleteBody>(&body)
        .map_err(|_| ApiError::bad_request("invalid request body"))?;
    drop(body);
    // Safe to print: `pasted` is masked. This line is why the masking type exists.
    tracing::debug!(?request, "login relay complete requested");
    let ready = prepare(&state, &principal, auth, &agent, flow, false).await?;
    require_login_id(&login_id)?;
    if !request.pasted.is_well_formed() {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            "bad_paste",
            "붙여넣은 값의 모양이 맞지 않아요. 로그인 창이 보여 준 값을 그대로 붙여넣어 주세요.",
        ));
    }
    if let Some(refusal) = throttle(&state, &principal, "complete", COMPLETE_CALLS_PER_WINDOW) {
        return Ok(refusal);
    }
    let outcome = state
        .login_relay
        .client
        .complete(&ready.target, &login_id, &ready.operator, &request.pasted)
        .await;
    match outcome {
        Ok(reply) => {
            audit_best_effort(&state, &ready, flow, "submitted", "-", "submitted").await;
            Ok(status_response(reply))
        }
        Err(error) => {
            audit_best_effort(&state, &ready, flow, "submitted", "-", result_word(&error)).await;
            Err(failure(error))
        }
    }
}

async fn poll_of(
    state: AppState,
    principal: Principal,
    workspace: String,
    agent: String,
    login_id: String,
    flow: Flow,
) -> Result<Response, ApiError> {
    let auth = authorize(&state, &principal, &workspace).await?;
    let ready = prepare(&state, &principal, auth, &agent, flow, false).await?;
    require_login_id(&login_id)?;
    if let Some(refusal) = throttle(&state, &principal, "read", READ_CALLS_PER_WINDOW) {
        return Ok(refusal);
    }
    let reply = state
        .login_relay
        .client
        .poll(&ready.target, &login_id, &ready.operator)
        .await
        .map_err(failure)?;
    if matches!(reply.status, "done" | "failed" | "expired") {
        // The first poll that sees an end writes the one result line (the UI stops polling at an end).
        audit_best_effort(&state, &ready, flow, "finished", "-", reply.status).await;
    }
    Ok(status_response(reply))
}

async fn cancel_of(
    state: AppState,
    principal: Principal,
    workspace: String,
    agent: String,
    login_id: String,
    flow: Flow,
) -> Result<Response, ApiError> {
    let auth = authorize(&state, &principal, &workspace).await?;
    let ready = prepare(&state, &principal, auth, &agent, flow, false).await?;
    require_login_id(&login_id)?;
    if let Some(refusal) = throttle(&state, &principal, "read", READ_CALLS_PER_WINDOW) {
        return Ok(refusal);
    }
    let reply = state
        .login_relay
        .client
        .cancel(&ready.target, &login_id, &ready.operator)
        .await
        .map_err(failure)?;
    audit_best_effort(&state, &ready, flow, "cancelled", "-", "cancelled").await;
    Ok(status_response(reply))
}

// ---------------------------------------------------------------------------
// the ten routes
// ---------------------------------------------------------------------------

pub async fn model_targets(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    targets_of(state, principal, workspace, agent, Flow::Model).await
}

pub async fn model_start(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    start_of(state, principal, workspace, agent, Flow::Model, body).await
}

pub async fn model_complete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent, login_id)): Path<(String, String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    complete_of(
        state,
        principal,
        workspace,
        agent,
        login_id,
        Flow::Model,
        body,
    )
    .await
}

pub async fn model_poll(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent, login_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    poll_of(state, principal, workspace, agent, login_id, Flow::Model).await
}

pub async fn model_cancel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent, login_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    cancel_of(state, principal, workspace, agent, login_id, Flow::Model).await
}

pub async fn app_targets(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    targets_of(state, principal, workspace, agent, Flow::App).await
}

pub async fn app_start(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    start_of(state, principal, workspace, agent, Flow::App, body).await
}

pub async fn app_complete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent, login_id)): Path<(String, String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    complete_of(
        state,
        principal,
        workspace,
        agent,
        login_id,
        Flow::App,
        body,
    )
    .await
}

pub async fn app_poll(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent, login_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    poll_of(state, principal, workspace, agent, login_id, Flow::App).await
}

pub async fn app_cancel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent, login_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    cancel_of(state, principal, workspace, agent, login_id, Flow::App).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_complete_request_prints_masked() {
        let request: CompleteBody =
            serde_json::from_str(r#"{"pasted":"MARKER-CODE-unit#STATE"}"#).unwrap();
        let printed = format!("{request:?}");
        assert!(!printed.contains("MARKER-CODE-unit"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
        let again = serde_json::to_string(&request.pasted).unwrap();
        assert!(!again.contains("MARKER-CODE-unit"), "{again}");
    }

    #[test]
    fn unknown_body_fields_and_wrong_types_are_refused_without_echo() {
        assert!(serde_json::from_slice::<CompleteBody>(br#"{"pasted":"x","extra":1}"#).is_err());
        assert!(serde_json::from_slice::<CompleteBody>(br#"{"pasted":5}"#).is_err());
        assert!(serde_json::from_slice::<StartModel>(br#"{"app":"x"}"#).is_err());
    }

    #[test]
    fn every_relay_refusal_maps_to_fixed_text_and_a_closed_audit_word() {
        for code in [
            "login_in_progress",
            "rate_limited",
            "operator_mismatch",
            "not_found",
            "state_mismatch",
            "redirect_mismatch",
            "extra_params",
            "bad_paste",
            "already_submitted",
            "not_pending",
            "not_paste_mode",
            "url_rejected",
            "parse_failed",
            "start_failed",
            "start_timeout",
            "unauthorized",
            "relay_error",
        ] {
            let f = RelayFailure::Refused { status: 400, code };
            let _ = failure(f);
            assert!(!result_word(&f).is_empty());
        }
        for f in [
            RelayFailure::Invalid,
            RelayFailure::EgressDenied,
            RelayFailure::Unreachable,
            RelayFailure::BadResponse,
        ] {
            let _ = failure(f);
            assert!(!result_word(&f).is_empty());
        }
    }

    #[test]
    fn the_seven_day_rule_needs_the_declaration_a_google_app_and_an_observed_login() {
        use momo_provider_probe::{EstimateBasis, LoginEstimate};
        let at = 1_760_000_000;
        let seen = Some(LoginEstimate {
            basis: EstimateBasis::RelayObservedLogin,
            issued_at: Some(at),
        });
        let on = estimate_dto("gmail", seen, true).unwrap();
        assert_eq!(
            (on.test_mode, on.expires_at, on.note),
            (
                Some(true),
                Some(at + 604_800),
                Some("google_testing_refresh_7d")
            )
        );
        // not declared: the reading stays, no deadline and no test-mode claim
        let off = estimate_dto("gmail", seen, false).unwrap();
        assert_eq!(
            (off.test_mode, off.expires_at, off.note),
            (None, None, None)
        );
        // declared, but not a Google app
        let other = estimate_dto("notes", seen, true).unwrap();
        assert_eq!((other.test_mode, other.expires_at), (None, None));
        // declared, but the login time is only a file time: no invented deadline
        let mtime = Some(LoginEstimate {
            basis: EstimateBasis::TokenFileMtime,
            issued_at: Some(at),
        });
        let guess = estimate_dto("gmail", mtime, true).unwrap();
        assert_eq!(
            (guess.test_mode, guess.expires_at, guess.note),
            (Some(true), None, Some("token_age_unknown_start"))
        );
        assert!(estimate_dto("gmail", None, true).is_none());
    }

    #[test]
    fn a_model_login_names_only_the_two_providers() {
        assert!(Flow::Model.name_ok("openai-codex") && Flow::Model.name_ok("anthropic"));
        assert!(!Flow::Model.name_ok("gmail") && !Flow::Model.name_ok("../x"));
        assert!(Flow::App.name_ok("gmail") && !Flow::App.name_ok("-x") && !Flow::App.name_ok("A"));
    }
}
