//! Personal cloud box — the runner's door (#3505, ADR-0197 M2, D2).
//!
//! Operator routes (a human, the **instance operator** — D2 역할 분리; a workspace
//! admin alone is refused):
//!
//! ```text
//! POST /v1/workspaces/{ws}/cloud-box-runners                    register  → runner + credential (once)
//! GET  /v1/workspaces/{ws}/cloud-box-runners                    list      (no hashes, no tokens)
//! POST /v1/workspaces/{ws}/cloud-box-runners/{runner}/rotate    new credential (the old one dies now)
//! POST /v1/workspaces/{ws}/cloud-box-runners/{runner}/revoke    revoke (its leases return to pending)
//! ```
//!
//! Runner routes (the **runner credential** and nothing else; mounted outside the
//! bearer middleware, so no human JWT, agent bearer or work-host signature is ever
//! tried in its place):
//!
//! ```text
//! POST /v1/workspaces/{ws}/cloud-box-runner/claim                          poll: take controls (each with a lease)
//! POST /v1/workspaces/{ws}/cloud-box-runner/controls/{control}/complete    report one (fenced by lease + attempts)
//! GET  /v1/workspaces/{ws}/cloud-box-runner/boxes                          ids + states, for orphan reconciliation
//! PUT  /v1/workspaces/{ws}/cloud-box-runner/identity                       the runner's Ed25519 public key (set once)
//! GET  /v1/workspaces/{ws}/cloud-box-runner/registrations                  box-agent registrations waiting for the runner
//! POST /v1/workspaces/{ws}/cloud-box-runner/boxes/{box}/attestation        the runner attests a host key (M4)
//! POST /v1/workspaces/{ws}/cloud-box-runner/boxes/{box}/registration/reject the runner could not verify the MAC (M4)
//! GET  /v1/workspaces/{ws}/cloud-box-runner/boxes/{box}/provisioning       the box's first owner device list (M4)
//! ```
//!
//! ## Rules this module is the door for
//!
//! 1. **Closed by default.** Every route here answers 404 before any database read
//!    unless `MOMO_CLOUD_BOX_ENABLED=true` (the same gate as the box routes).
//! 2. **Cheap to refuse.** A token without the runner shape and an address whose refused-credential
//!    budget is spent are turned away before any database work; bodies are capped at 4 KiB.
//! 3. **One uniform 401.** Malformed token, another credential class, unknown
//!    runner, another workspace's runner (RLS hides it), revoked runner, wrong
//!    secret: the same status and the same sentence, so the answer teaches nothing
//!    about which check failed. Only refusals count against the per-IP budget, so
//!    a runner polling every few seconds is never throttled.
//! 4. **The runner acts as itself, in its workspace.** The credential is bound to a
//!    workspace; the `{ws}` in the path is where the tenant transaction opens and
//!    the runner is looked up *inside it*, so a runner credential presented for
//!    another workspace finds no row. Authentication and the action share one
//!    transaction.
//! 5. **Closed bodies.** Unknown fields are refused (422) on every request body.

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::{DbError, PgConnection};
use momo_settings::cloud_box::{
    claim_controls_in_tx, complete_control_in_tx, list_reconcile_boxes_in_tx, BoxState,
    CompleteOutcome, CompleteReport, DeletionReport, Observed,
};
use momo_settings::cloud_box_runner::{
    hash_runner_credential, list_runners_in_tx, mint_runner_credential, register_runner_in_tx,
    revoke_runner_in_tx, rotate_runner_in_tx, RegisterOutcome, RevokeOutcome, RotateOutcome,
    RunnerInfo,
};
use uuid::Uuid;

use crate::dto::{
    CloudBoxPendingRegistrationDto, CloudBoxRunnerAttestationRequest,
    CloudBoxRunnerIdentityRequest, CloudBoxRunnerProvisioningResponse,
    CloudBoxRunnerRegistrationsResponse, CloudBoxRunnerRejectRequest, CloudBoxStoredResponse,
    CloudBoxControlDto, CloudBoxControlLimitsDto, CloudBoxReconcileEntryDto,
    CloudBoxReconcileResponse, CloudBoxRunnerClaimRequest, CloudBoxRunnerClaimResponse,
    CloudBoxRunnerCompleteRequest, CloudBoxRunnerCompleteResponse,
    CloudBoxRunnerCredentialResponse, CloudBoxRunnerDto, CloudBoxRunnerListResponse,
    CloudBoxRunnerRegisterRequest,
};
use crate::error::ApiError;
use crate::routes::cloud_boxes::gate;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, futures_box, path_uuid, require_human,
    require_instance_operator, require_instance_operator_write, settle_db, workspace_scope,
};
use crate::AppState;

/// Runner request bodies are tiny (a limit, a lease, a report); anything bigger is refused before it is read.
pub const MAX_RUNNER_BODY_BYTES: usize = 4096;

fn runner_dto(info: &RunnerInfo) -> CloudBoxRunnerDto {
    CloudBoxRunnerDto {
        id: info.id.to_string(),
        name: info.name.clone(),
        credential_fingerprint: info.credential_fingerprint.clone(),
        registered_by: info.registered_by.map(|id| id.to_string()),
        created_at_ms: info.created_at_ms,
        rotated_at_ms: info.rotated_at_ms,
        last_seen_at_ms: info.last_seen_at_ms,
        revoked_at_ms: info.revoked_at_ms,
    }
}

// ---------------------------------------------------------------------------
// operator routes
// ---------------------------------------------------------------------------

/// A credential is shown once: the response must not be cached or stored by anything on the way.
type OneTime = [(HeaderName, HeaderValue); 2];

fn no_store() -> OneTime {
    [
        (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        (header::PRAGMA, HeaderValue::from_static("no-cache")),
    ]
}

fn mint(runner_id: Uuid) -> Result<String, ApiError> {
    mint_runner_credential(runner_id)
        .map_err(|error| ApiError::internal("cloud_box_runner.mint", error))
}

/// `POST /v1/workspaces/{ws}/cloud-box-runners` — instance operator only.
pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CloudBoxRunnerRegisterRequest>,
) -> Result<(StatusCode, OneTime, Json<CloudBoxRunnerCredentialResponse>), ApiError> {
    gate(&state)?;
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_instance_operator_write(&state, &principal).await?;
    let runner_id = Uuid::new_v4();
    let credential = mint(runner_id)?;
    let hash = hash_runner_credential(&credential);
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let name = request.name;
    let info = settle_db(
        "cloud_box_runner.register",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match register_runner_in_tx(
                    conn,
                    workspace_id,
                    actor,
                    &name,
                    runner_id,
                    &hash,
                    via_token,
                )
                .await?
                {
                    RegisterOutcome::Registered(info) => Ok(Ok(info)),
                    RegisterOutcome::AlreadyRegistered => Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "cloud_box_runner_exists",
                        "이 워크스페이스에는 이미 런너가 있어요. 워크스페이스당 런너는 하나예요.",
                    ))),
                    RegisterOutcome::InvalidName => {
                        Ok(Err(ApiError::bad_request("name must be 1...64 characters")))
                    }
                }
            })
        })
        .await,
    )?;
    Ok((
        StatusCode::CREATED,
        no_store(),
        Json(CloudBoxRunnerCredentialResponse {
            runner: runner_dto(&info),
            credential,
        }),
    ))
}

/// `GET /v1/workspaces/{ws}/cloud-box-runners` — instance operator only.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<CloudBoxRunnerListResponse>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_instance_operator(&state, &principal).await?;
    let runners = settle_db(
        "cloud_box_runner.list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move { Ok(Ok(list_runners_in_tx(conn, workspace_id).await?)) })
        })
        .await,
    )?;
    Ok(Json(CloudBoxRunnerListResponse {
        runners: runners.iter().map(runner_dto).collect(),
    }))
}

/// `POST /v1/workspaces/{ws}/cloud-box-runners/{runner}/rotate` — instance operator only.
pub async fn rotate(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, runner)): Path<(String, String)>,
) -> Result<(OneTime, Json<CloudBoxRunnerCredentialResponse>), ApiError> {
    gate(&state)?;
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let runner_id = path_uuid(&runner, "invalid runner id")?;
    require_instance_operator_write(&state, &principal).await?;
    let credential = mint(runner_id)?;
    let hash = hash_runner_credential(&credential);
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let info = settle_db(
        "cloud_box_runner.rotate",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match rotate_runner_in_tx(conn, workspace_id, runner_id, &hash, actor, via_token)
                    .await?
                {
                    RotateOutcome::Rotated(info) => Ok(Ok(info)),
                    RotateOutcome::NotFound => Ok(Err(ApiError::not_found("runner not found"))),
                }
            })
        })
        .await,
    )?;
    Ok((
        no_store(),
        Json(CloudBoxRunnerCredentialResponse {
            runner: runner_dto(&info),
            credential,
        }),
    ))
}

/// `POST /v1/workspaces/{ws}/cloud-box-runners/{runner}/revoke` — instance operator only.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, runner)): Path<(String, String)>,
) -> Result<Json<CloudBoxRunnerDto>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let runner_id = path_uuid(&runner, "invalid runner id")?;
    require_instance_operator_write(&state, &principal).await?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let info = settle_db(
        "cloud_box_runner.revoke",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match revoke_runner_in_tx(conn, workspace_id, runner_id, actor, via_token).await? {
                    RevokeOutcome::Revoked(info) | RevokeOutcome::AlreadyRevoked(info) => {
                        Ok(Ok(info))
                    }
                    RevokeOutcome::NotFound => Ok(Err(ApiError::not_found("runner not found"))),
                }
            })
        })
        .await,
    )?;
    Ok(Json(runner_dto(&info)))
}

// ---------------------------------------------------------------------------
// the runner's own routes
// ---------------------------------------------------------------------------

/// The one 401 every credential failure answers with.
fn unauthorized() -> ApiError {
    ApiError::unauthorized("runner credential required")
}

/// The bearer in the `Authorization` header, by the same parser as every other
/// bearer route.
fn presented_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(crate::auth::bearer_token)
}

/// Authenticate the runner and run `body` in the same tenant transaction. The
/// tenant is the path workspace; the runner row is read inside it.
async fn with_runner<T, F>(
    state: &AppState,
    headers: &HeaderMap,
    workspace_raw: &str,
    context: &'static str,
    body: F,
) -> Result<T, ApiError>
where
    T: Send,
    F: for<'c> FnOnce(
            &'c mut PgConnection,
            Uuid,
            RunnerInfo,
        ) -> futures_box::BoxFuture<'c, Result<Result<T, ApiError>, DbError>>
        + Send
        + 'static,
{
    gate(state)?;
    let Some(token) = presented_token(headers).map(str::to_owned) else {
        return Err(unauthorized());
    };
    let Ok(workspace_id) = Uuid::parse_str(workspace_raw) else {
        return Err(unauthorized());
    };
    // A token that does not even have the runner's shape never opens a transaction.
    if momo_settings::cloud_box_runner::runner_id_of_token(&token).is_none() {
        return Err(unauthorized());
    }
    settle_db(
        context,
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(runner) = momo_settings::cloud_box_runner::authenticate_runner_in_tx(
                    conn,
                    workspace_id,
                    &token,
                )
                .await?
                else {
                    return Ok(Err(unauthorized()));
                };
                body(conn, workspace_id, runner).await
            })
        })
        .await,
    )
}

/// A closed request body: parsed only after the gate and the credential, so a
/// closed instance answers 404 and an unauthenticated caller 401 whatever it sends.
/// Unknown fields are a 422.
fn parse_body<B: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<B, ApiError> {
    serde_json::from_slice(bytes).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("invalid request body: {error}"),
        )
    })
}

/// `POST /v1/workspaces/{ws}/cloud-box-runner/claim`.
pub async fn claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<String>,
    body: Bytes,
) -> Result<Json<CloudBoxRunnerClaimResponse>, ApiError> {
    let claimed = with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.claim",
        move |conn, workspace_id, runner| {
            Box::pin(async move {
                let request: CloudBoxRunnerClaimRequest = match parse_body(&body) {
                    Ok(request) => request,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let limit = request.limit.unwrap_or(10);
                if !(1..=50).contains(&limit) {
                    return Ok(Err(ApiError::bad_request("limit must be 1...50")));
                }
                Ok(Ok(claim_controls_in_tx(
                    conn,
                    workspace_id,
                    runner.id,
                    limit,
                )
                .await?))
            })
        },
    )
    .await?;
    Ok(Json(CloudBoxRunnerClaimResponse {
        controls: claimed
            .controls
            .iter()
            .map(|control| CloudBoxControlDto {
                id: control.id.to_string(),
                lease_id: control.lease_id.to_string(),
                attempts: control.attempts,
                seq: control.seq,
                box_id: control.box_id.to_string(),
                verb: control.verb.clone(),
                limits: control.limits.map(|limits| CloudBoxControlLimitsDto {
                    cpu_millis: limits.cpu_millis,
                    memory_mb: limits.memory_mb,
                    disk_gb: limits.disk_gb,
                    pids: limits.pids,
                }),
            })
            .collect(),
        poisoned: claimed.poisoned.iter().map(Uuid::to_string).collect(),
    }))
}

fn observed_from_wire(word: &str) -> Option<Observed> {
    match word {
        "running" => Some(Observed::Running),
        "stopped" => Some(Observed::Stopped),
        "absent" => Some(Observed::Absent),
        _ => None,
    }
}

/// `POST /v1/workspaces/{ws}/cloud-box-runner/controls/{control}/complete`.
pub async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, control)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<CloudBoxRunnerCompleteResponse>, ApiError> {
    let outcome = with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.complete",
        move |conn, workspace_id, runner| {
            Box::pin(async move {
                let request: CloudBoxRunnerCompleteRequest = match parse_body(&body) {
                    Ok(request) => request,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let Ok(control_id) = Uuid::parse_str(&control) else {
                    return Ok(Err(ApiError::bad_request("invalid control id")));
                };
                let observed = match request.observed.as_deref() {
                    None => None,
                    Some(word) => match observed_from_wire(word) {
                        Some(observed) => Some(observed),
                        None => {
                            return Ok(Err(ApiError::bad_request(
                                "observed must be running, stopped or absent",
                            )))
                        }
                    },
                };
                let report = CompleteReport {
                    ok: request.ok,
                    observed,
                    deletion: request.deletion.map(|deletion| DeletionReport {
                        container_absent: deletion.container_absent,
                        volume_absent: deletion.volume_absent,
                    }),
                };
                let outcome = complete_control_in_tx(
                    conn,
                    workspace_id,
                    runner.id,
                    control_id,
                    request.lease_id,
                    request.attempts,
                    report,
                )
                .await?;
                Ok(match outcome {
                    CompleteOutcome::Completed { box_state } => Ok(box_state),
                    CompleteOutcome::Stale => Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "cloud_box_control_stale",
                        "이 컨트롤은 더 이상 이 런너의 것이 아니에요(lease가 끝났거나 다시 내줬거나 취소됐어요).",
                    )),
                    CompleteOutcome::NotFound => Err(ApiError::not_found("control not found")),
                    CompleteOutcome::InvalidReport(reason) => Err(ApiError::bad_request(reason)),
                })
            })
        },
    )
    .await?;
    // A box that is gone has no host any more: the relay supervisor ends its sessions now.
    state.cloud_relay.kick();
    Ok(Json(CloudBoxRunnerCompleteResponse {
        box_state: outcome.map(BoxState::as_str),
    }))
}

/// `GET /v1/workspaces/{ws}/cloud-box-runner/boxes`.
pub async fn boxes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<String>,
) -> Result<Json<CloudBoxReconcileResponse>, ApiError> {
    let listed = with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.boxes",
        move |conn, workspace_id, _runner| {
            Box::pin(async move { Ok(Ok(list_reconcile_boxes_in_tx(conn, workspace_id).await?)) })
        },
    )
    .await?;
    Ok(Json(CloudBoxReconcileResponse {
        boxes: listed
            .iter()
            .map(|entry| CloudBoxReconcileEntryDto {
                box_id: entry.box_id.to_string(),
                state: entry.state.as_str(),
            })
            .collect(),
    }))
}

/// Per-IP budget for **refused** runner credentials. The handler decides first and
/// only a 401 spends the address's budget, so a runner polling every few seconds is
/// never throttled while a guessing client runs out. (The credential is 256 random
/// bits; this is a tidy-up, not the defence.)
pub async fn refused_credential_budget(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    crate::rate_limit::per_ip_refused(state, request, next, "ip:cloud-runner", |config| {
        config.claim_per_ip_limit
    })
    .await
}

// ---------------------------------------------------------------------------
// #3511 (ADR-0197 M4 증보 2) — the runner's part of the trust chain
// ---------------------------------------------------------------------------

fn fixed<const N: usize>(value: &str, what: &'static str) -> Result<[u8; N], ApiError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()
        .and_then(|bytes| <[u8; N]>::try_from(bytes).ok())
        .ok_or_else(|| ApiError::bad_request(format!("{what} must be {N} bytes, base64")))
}

/// `PUT /v1/workspaces/{ws}/cloud-box-runner/identity` — the runner's Ed25519 public key, set once.
pub async fn identity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<String>,
    body: Bytes,
) -> Result<Json<CloudBoxStoredResponse>, ApiError> {
    with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.identity",
        move |conn, workspace_id, runner| {
            Box::pin(async move {
                use momo_settings::cloud_box_relay::{set_runner_signing_key_in_tx, SigningKeyOutcome};
                let request: CloudBoxRunnerIdentityRequest = match parse_body(&body) {
                    Ok(request) => request,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let key: [u8; 32] = match fixed(&request.public_key, "publicKey") {
                    Ok(key) => key,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                Ok(
                    match set_runner_signing_key_in_tx(conn, workspace_id, runner.id, &key).await? {
                        SigningKeyOutcome::Set | SigningKeyOutcome::Same => Ok(()),
                        SigningKeyOutcome::Conflict => Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "cloud_box_runner_key_conflict",
                            "이 런너의 서명 키는 이미 정해져 있어요. 키를 바꾸려면 런너를 새로 등록해야 해요.",
                        )),
                        SigningKeyOutcome::NotFound => Err(unauthorized()),
                    },
                )
            })
        },
    )
    .await?;
    Ok(Json(CloudBoxStoredResponse { stored: true }))
}

/// `GET /v1/workspaces/{ws}/cloud-box-runner/registrations`.
pub async fn registrations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<String>,
) -> Result<Json<CloudBoxRunnerRegistrationsResponse>, ApiError> {
    use base64::Engine as _;
    let listed = with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.registrations",
        move |conn, workspace_id, _runner| {
            Box::pin(async move {
                Ok(Ok(
                    momo_settings::cloud_box_relay::list_pending_registrations_in_tx(
                        conn,
                        workspace_id,
                    )
                    .await?,
                ))
            })
        },
    )
    .await?;
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(Json(CloudBoxRunnerRegistrationsResponse {
        registrations: listed
            .iter()
            .map(|entry| CloudBoxPendingRegistrationDto {
                box_id: entry.box_id.to_string(),
                host_public_key: b64.encode(&entry.host_public_key),
                mac: b64.encode(&entry.mac),
            })
            .collect(),
    }))
}

/// `POST /v1/workspaces/{ws}/cloud-box-runner/boxes/{box}/attestation`.
pub async fn attestation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, cloud_box)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<CloudBoxStoredResponse>, ApiError> {
    with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.attestation",
        move |conn, workspace_id, runner| {
            Box::pin(async move {
                use momo_settings::cloud_box_relay::{activate_agent_in_tx, ActivateOutcome};
                let request: CloudBoxRunnerAttestationRequest = match parse_body(&body) {
                    Ok(request) => request,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let Ok(box_id) = Uuid::parse_str(&cloud_box) else {
                    return Ok(Err(ApiError::bad_request("invalid cloud box id")));
                };
                let host_key: [u8; 32] = match fixed(&request.host_public_key, "hostPublicKey") {
                    Ok(key) => key,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let attestation: [u8; 64] = match fixed(&request.attestation, "attestation") {
                    Ok(value) => value,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                Ok(
                    match activate_agent_in_tx(
                        conn,
                        workspace_id,
                        runner.id,
                        box_id,
                        &host_key,
                        &attestation,
                    )
                    .await?
                    {
                        ActivateOutcome::Activated { .. } | ActivateOutcome::AlreadyActive { .. } => {
                            Ok(())
                        }
                        ActivateOutcome::NoMatchingRegistration => Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "cloud_box_registration_changed",
                            "대기 중인 등록이 증명한 키와 달라요.",
                        )),
                        ActivateOutcome::KeyConflict => Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "cloud_box_agent_key_conflict",
                            "이 박스에는 이미 다른 host 키가 등록돼 있어요.",
                        )),
                        ActivateOutcome::NotFound => Err(ApiError::not_found("cloud box not found")),
                    },
                )
            })
        },
    )
    .await?;
    Ok(Json(CloudBoxStoredResponse { stored: true }))
}

/// `POST /v1/workspaces/{ws}/cloud-box-runner/boxes/{box}/registration/reject`.
pub async fn reject_registration(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, cloud_box)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<CloudBoxStoredResponse>, ApiError> {
    let cleared = with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.reject_registration",
        move |conn, workspace_id, _runner| {
            Box::pin(async move {
                let request: CloudBoxRunnerRejectRequest = match parse_body(&body) {
                    Ok(request) => request,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let Ok(box_id) = Uuid::parse_str(&cloud_box) else {
                    return Ok(Err(ApiError::bad_request("invalid cloud box id")));
                };
                let host_key: [u8; 32] = match fixed(&request.host_public_key, "hostPublicKey") {
                    Ok(key) => key,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                Ok(Ok(momo_settings::cloud_box_relay::reject_registration_in_tx(
                    conn,
                    workspace_id,
                    box_id,
                    &host_key,
                )
                .await?))
            })
        },
    )
    .await?;
    Ok(Json(CloudBoxStoredResponse { stored: cleared }))
}

/// `GET /v1/workspaces/{ws}/cloud-box-runner/boxes/{box}/provisioning`.
pub async fn provisioning(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, cloud_box)): Path<(String, String)>,
) -> Result<Json<CloudBoxRunnerProvisioningResponse>, ApiError> {
    use base64::Engine as _;
    let list = with_runner(
        &state,
        &headers,
        &workspace,
        "cloud_box_runner.provisioning",
        move |conn, workspace_id, _runner| {
            Box::pin(async move {
                let Ok(box_id) = Uuid::parse_str(&cloud_box) else {
                    return Ok(Err(ApiError::bad_request("invalid cloud box id")));
                };
                Ok(
                    match momo_settings::cloud_box_relay::owner_list_in_tx(conn, workspace_id, box_id)
                        .await?
                    {
                        Some(list) => Ok(list),
                        None => Err(ApiError::coded(
                            StatusCode::NOT_FOUND,
                            "cloud_box_list_missing",
                            "이 박스에는 소유자 목록이 아직 없어요.",
                        )),
                    },
                )
            })
        },
    )
    .await?;
    Ok(Json(CloudBoxRunnerProvisioningResponse {
        owner_device_list: base64::engine::general_purpose::STANDARD.encode(list),
    }))
}
