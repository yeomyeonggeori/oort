//! Personal cloud box — the box-agent's door (#3511, ADR-0197 M4 증보 2, D2·D5).
//!
//! ```text
//! POST /v1/workspaces/{ws}/cloud-boxes/{box}/agent/register                 PUBLIC (IP budget)
//! GET  /v1/workspaces/{ws}/work-hosts/{host}/cloud-box/listen               WebSocket, host-signed v2
//! GET  /v1/workspaces/{ws}/work-hosts/{host}/cloud-box/relay/{session}      WebSocket, host-signed v2
//! ```
//!
//! ## Registration without a password the server knows
//!
//! The box-agent has no credential yet, so `register` is public: it takes the box's host public key and a MAC
//! over `("momo.box.register.v1", box id, host key)` keyed by a pairing code that only the **runner** and the box
//! know. **The server cannot verify the MAC** and never tries: it parks the pair (last writer wins, a nuisance
//! and not a compromise) until the runner — which holds the code — verifies it and attests the key
//! (`cloud_box_runner::attestation`). Only then does the server create the box's host: `scope = 'member'`,
//! `type = 'cloud'`, owner = the **box's** owner (never anything the request said). From that moment the host key is
//! fixed: the same key registering again is an idempotent 200, another key a 409 that overwrites nothing.
//! The runner's attestation plus the owner device's `HostPin` stand where ADR-0146's `host_register` device
//! signature stands for other hosts.
//!
//! ## The two host sockets
//!
//! Both are ordinary signed host requests (`momo.work_host.request.v2`: method, path, workspace, host, time, body
//! digest, one-time request id) mounted outside the bearer middleware; a signature that verifies is a host that
//! exists, is not revoked, and whose owner is an active human. On top of that the route checks this host is an
//! `active` box-agent of a box in `running|idle`. A second **listen** socket for one host is refused while the first
//! is alive (a volume clone must not displace the box). A **session** socket is claimed by the host the session
//! was authorised for, once.

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_auth::load_work_host;
use momo_db::{DbError, PgConnection};
use momo_settings::cloud_box::{find_box_in_tx, BoxState};
use momo_settings::cloud_box_relay::{
    box_of_host_in_tx, register_agent_in_tx, RegisterAgentOutcome, KEY_LEN, MAC_LEN,
};
use uuid::Uuid;

use crate::cloud_box_relay::{run_end, run_listener, ListenerRefused, MAX_RELAY_MESSAGE};
use crate::dto::{
    CloudBoxAgentHostDto, CloudBoxAgentRegisterRequest, CloudBoxAgentRegisterResponse,
};
use crate::error::ApiError;
use crate::routes::cloud_boxes::gate;
use crate::routes::shared::{agent_tenant_tx, settle_db};
use crate::work_host_auth::{authenticate_signed_host_request, SignedHostRequest};
use crate::AppState;

fn fixed<const N: usize>(value: &str, what: &'static str) -> Result<[u8; N], ApiError> {
    BASE64
        .decode(value.trim())
        .ok()
        .and_then(|bytes| <[u8; N]>::try_from(bytes).ok())
        .ok_or_else(|| ApiError::bad_request(format!("{what} must be {N} bytes, base64")))
}

/// `POST …/cloud-boxes/{box}/agent/register` — public.
pub async fn register(
    State(state): State<AppState>,
    Path((workspace, cloud_box)): Path<(String, String)>,
    Json(request): Json<CloudBoxAgentRegisterRequest>,
) -> Result<Json<CloudBoxAgentRegisterResponse>, ApiError> {
    gate(&state)?;
    let (Ok(workspace_id), Ok(box_id)) =
        (Uuid::parse_str(&workspace), Uuid::parse_str(&cloud_box))
    else {
        return Err(ApiError::not_found("cloud box not found"));
    };
    let host_key: [u8; KEY_LEN] = fixed(&request.host_public_key, "hostPublicKey")?;
    let mac: [u8; MAC_LEN] = fixed(&request.mac, "mac")?;
    let answer = settle_db(
        "cloud_box.agent_register",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(
                    match register_agent_in_tx(conn, workspace_id, box_id, &host_key, &mac).await? {
                        RegisterAgentOutcome::Pending => Ok(CloudBoxAgentRegisterResponse {
                            state: "pending",
                            work_host: None,
                        }),
                        RegisterAgentOutcome::Active { host_id } => {
                            let Some(host) = load_work_host(conn, host_id).await? else {
                                return Ok(Err(ApiError::not_found("cloud box not found")));
                            };
                            Ok(CloudBoxAgentRegisterResponse {
                                state: "active",
                                work_host: Some(CloudBoxAgentHostDto {
                                    id: host.id.to_string(),
                                    owner_member_id: host.owner_member_id.to_string(),
                                    scope: "member",
                                    host_type: "cloud",
                                    public_key: host.public_key,
                                }),
                            })
                        }
                        RegisterAgentOutcome::KeyConflict => Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "cloud_box_agent_key_conflict",
                            "이 박스에는 이미 다른 host 키가 등록돼 있어요. 키를 바꾸려면 박스를 지우고 다시 만들어야 해요.",
                        )),
                        RegisterAgentOutcome::NotFound => {
                            Err(ApiError::not_found("cloud box not found"))
                        }
                    },
                )
            })
        })
        .await,
    )?;
    Ok(Json(answer))
}

/// Per-IP budget for the public registration route (the pending slot is a nuisance surface, not a secret).
pub async fn register_budget(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    crate::rate_limit::per_ip_cloud_agent_register(State(state), request, next).await
}

/// A host that signed the request must be an `active` box-agent whose box is running. Returns its box.
async fn live_box_of_host(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host: &SignedHostRequest,
) -> Result<Option<Uuid>, DbError> {
    let Some(box_id) = box_of_host_in_tx(conn, workspace_id, host.host_id).await? else {
        return Ok(None);
    };
    let Some(info) = find_box_in_tx(conn, workspace_id, box_id).await? else {
        return Ok(None);
    };
    // The host's signed owner is the box's owner: the registration made it so, and an owner change breaks it.
    if info.member_id != host.owner_member_id
        || !matches!(info.state, BoxState::Running | BoxState::Idle)
    {
        return Ok(None);
    }
    Ok(Some(box_id))
}

async fn authorise_box_agent(
    state: &AppState,
    uri: &Uri,
    headers: &HeaderMap,
    workspace_id: Uuid,
) -> Result<SignedHostRequest, ApiError> {
    gate(state)?;
    let host =
        authenticate_signed_host_request(state, &Method::GET, uri, headers, &[], workspace_id)
            .await?;
    let for_check = host.clone();
    let live = settle_db(
        "cloud_box.agent_authorise",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(live_box_of_host(conn, workspace_id, &for_check).await?))
            })
        })
        .await,
    )?;
    if live.is_none() {
        return Err(crate::work_host_auth::signed_request_unauthorized());
    }
    Ok(host)
}

/// `GET …/work-hosts/{host}/cloud-box/listen`.
pub async fn listen(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
    Path((workspace, _host)): Path<(String, String)>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let workspace_id = Uuid::parse_str(&workspace)
        .map_err(|_| crate::work_host_auth::signed_request_unauthorized())?;
    let host = authorise_box_agent(&state, &uri, &headers, workspace_id).await?;
    let hub = state.cloud_relay.clone();
    let (conn, notices, last_seen) = match hub.register_listener(host.host_id) {
        Ok(registered) => registered,
        Err(ListenerRefused::AlreadyConnected) => {
            return Err(ApiError::coded(
                StatusCode::CONFLICT,
                "cloud_box_agent_already_connected",
                "이 box host는 이미 연결돼 있어요.",
            ))
        }
    };
    let host_id = host.host_id;
    Ok(upgrade.on_upgrade(move |socket| run_listener(hub, socket, host_id, conn, notices, last_seen)))
}

/// `GET …/work-hosts/{host}/cloud-box/relay/{session}`.
pub async fn session_socket(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
    Path((workspace, _host, session)): Path<(String, String, String)>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let workspace_id = Uuid::parse_str(&workspace)
        .map_err(|_| crate::work_host_auth::signed_request_unauthorized())?;
    let session_id = Uuid::parse_str(&session)
        .map_err(|_| crate::work_host_auth::signed_request_unauthorized())?;
    let host = authorise_box_agent(&state, &uri, &headers, workspace_id).await?;
    let Some(end) = state
        .cloud_relay
        .claim_box(workspace_id, host.host_id, session_id)
    else {
        return Err(crate::work_host_auth::signed_request_unauthorized());
    };
    let hub = state.cloud_relay.clone();
    Ok(upgrade
        .max_message_size(MAX_RELAY_MESSAGE)
        .max_frame_size(MAX_RELAY_MESSAGE)
        .on_upgrade(move |socket| run_end(hub, socket, end)))
}
