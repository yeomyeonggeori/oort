//! Personal cloud box — the owner's side of the blind relay (#3511, ADR-0197 M4 증보 2).
//!
//! ```text
//! PUT  /v1/workspaces/{ws}/cloud-boxes/{box}/owner-device-list   first owner DeviceList (R2-signed control)
//! GET  /v1/workspaces/{ws}/cloud-boxes/{box}/trust-bundle         runner key, attested host key, pin
//! PUT  /v1/workspaces/{ws}/cloud-boxes/{box}/pin                  the owner device's HostPin
//! POST /v1/workspaces/{ws}/cloud-boxes/{box}/attach               signed cloud_pty_attach → single-use ticket
//! GET  /v1/workspaces/{ws}/cloud-boxes/{box}/relay/{session}      WebSocket (ticket in Sec-WebSocket-Protocol)
//! ```
//!
//! ## What the server does here, and what it never does
//!
//! * **Owner only, no exception (D6).** The box's owner passes; a workspace admin who is not the owner gets 403
//!   `cloud_box_owner_only`, anyone else 404. There is no admin attach.
//! * **The signature is always required** for the two controls that change what a box trusts or lets in
//!   (`cloud_box_owner_list`, `cloud_pty_attach`), whatever `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` says. That flag
//!   gates the *production enablement* with R2 (#3030); it never makes these two optional.
//! * **The target host is the box's, not the request's** (ADR-0188 D3): `host_id` in the statement is read off
//!   the box's `cloud_box_agent` row. The statement binds the box id and the SHA-256 of the `Hello` the device
//!   will send, so the authorisation cannot be paired with another handshake.
//! * **The server's check is a second layer.** The box-agent verifies the owner device's signature itself (S2).
//!   A server that is wrong, or compromised, cannot open a terminal by being wrong.
//! * **No bytes are read.** The relay socket is `cloud_box_relay::run_end`; this module only mints the ticket and
//!   upgrades.
//! * **The trust bundle carries no owner device list and no fingerprint** (S2 conditions ①): a new device gets
//!   the list in person, and the runner fingerprint is computed on the device from the key bytes.

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_auth::human_control::ControlSubject;
use momo_auth::human_control::ControlTarget;
use momo_settings::cloud_box::BoxState;
use momo_settings::cloud_box_relay::{
    attach_context_in_tx, put_owner_list_in_tx, put_pin_in_tx, trust_bundle_in_tx, PutListOutcome,
    PutPinOutcome, MAX_OPAQUE_BYTES,
};
use momo_wire::{EntityRef, ENTITY_CLOUD_BOX_OWNER_LIST, ENTITY_CLOUD_PTY_ATTACH};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::cloud_box_relay::{
    run_end, OpenError, OpenParams, MAX_HELLO_BYTES, MAX_RELAY_MESSAGE, RELAY_AUDIT_SCHEMA,
};
use crate::dto::{
    CloudBoxAttachRequest, CloudBoxAttachResponse, CloudBoxHostKeyDto, CloudBoxOwnerListRequest,
    CloudBoxPinRequest, CloudBoxRelayDto, CloudBoxRunnerKeyDto, CloudBoxStoredResponse,
    CloudBoxTrustBundleResponse,
};
use crate::error::ApiError;
use crate::human_control::{authorize_human_control_in_tx, record_signed_statement_in_tx};
use crate::routes::cloud_boxes::{gate, load_owner_box};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
};
use crate::AppState;

/// The WebSocket subprotocol the relay speaks. The ticket rides as a second offered protocol,
/// `ticket.<base64url>`: a browser cannot set headers on a WebSocket, and a query string would put the
/// ticket in access logs.
pub const SUBPROTOCOL: &str = "oort.cloud-pty.v1";
const TICKET_PREFIX: &str = "ticket.";

fn decode_opaque(value: &str, what: &'static str, max: usize) -> Result<Vec<u8>, ApiError> {
    let bytes = BASE64
        .decode(value.trim())
        .map_err(|_| ApiError::bad_request(format!("{what} must be base64")))?;
    if bytes.is_empty() || bytes.len() > max {
        return Err(ApiError::bad_request(format!(
            "{what} must be 1...{max} bytes"
        )));
    }
    Ok(bytes)
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `PUT …/cloud-boxes/{box}/owner-device-list`.
pub async fn put_owner_list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
    Json(request): Json<CloudBoxOwnerListRequest>,
) -> Result<Json<CloudBoxStoredResponse>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let box_id = path_uuid(&cloud_box, "invalid cloud box id")?;
    let list = decode_opaque(&request.list, "list", MAX_OPAQUE_BYTES)?;
    let list_sha256 = hex_sha256(&list);
    let actor = principal.member_id;
    let settings = state.device_keys.clone();
    let signature = request.signature;
    settle_db(
        "cloud_box.owner_list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(refusal) = load_owner_box(conn, workspace_id, box_id, actor).await? {
                    return Ok(Err(refusal));
                }
                // The statement names the box as its host line (no box-agent exists yet).
                let target = ControlTarget {
                    workspace_id,
                    member_id: actor,
                    host_id: box_id,
                    session_id: None,
                    subject: ControlSubject::CloudBoxOwnerList {
                        box_id,
                        list_sha256: &list_sha256,
                    },
                };
                let verified = match authorize_human_control_in_tx(
                    conn,
                    &settings,
                    &target,
                    signature.as_ref(),
                    true,
                )
                .await?
                {
                    Ok(Some(verified)) => verified,
                    Ok(None) => unreachable!("a required signature is verified or refused"),
                    Err(refusal) => return Ok(Err(refusal)),
                };
                match put_owner_list_in_tx(conn, workspace_id, box_id, &list).await? {
                    PutListOutcome::Stored => {}
                    PutListOutcome::Locked => {
                        return Ok(Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "cloud_box_list_locked",
                            "첫 소유자 목록은 박스를 만들기 전에만 넣을 수 있어요.",
                        )))
                    }
                    PutListOutcome::NotFound => return Ok(Err(crate::routes::cloud_boxes::not_found())),
                }
                record_signed_statement_in_tx(
                    conn,
                    workspace_id,
                    &EntityRef::new(ENTITY_CLOUD_BOX_OWNER_LIST, box_id),
                    verified.key.member_id,
                    &verified.key.public_key,
                    &verified.signature_b64,
                    &verified.signed_bytes,
                )
                .await?;
                Ok(Ok(()))
            })
        })
        .await,
    )?;
    Ok(Json(CloudBoxStoredResponse { stored: true }))
}

/// `GET …/cloud-boxes/{box}/trust-bundle`.
pub async fn trust_bundle(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
) -> Result<Json<CloudBoxTrustBundleResponse>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let box_id = path_uuid(&cloud_box, "invalid cloud box id")?;
    let actor = principal.member_id;
    let bundle = settle_db(
        "cloud_box.trust_bundle",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(refusal) = load_owner_box(conn, workspace_id, box_id, actor).await? {
                    return Ok(Err(refusal));
                }
                Ok(Ok(trust_bundle_in_tx(conn, workspace_id, box_id).await?))
            })
        })
        .await,
    )?;
    let online = bundle
        .host_id
        .is_some_and(|host| state.cloud_relay.listener_online(host));
    let host = match (&bundle.host_public_key, &bundle.attestation) {
        (Some(key), Some(attestation)) => Some(CloudBoxHostKeyDto {
            public_key: BASE64.encode(key),
            attestation: BASE64.encode(attestation),
        }),
        _ => None,
    };
    Ok(Json(CloudBoxTrustBundleResponse {
        box_id: box_id.to_string(),
        host_id: bundle.host_id.map(|id| id.to_string()),
        agent_online: online,
        runner: bundle.runner_public_key.as_ref().map(|key| CloudBoxRunnerKeyDto {
            public_key: BASE64.encode(key),
        }),
        host,
        pin: bundle.pin.as_ref().map(|pin| BASE64.encode(pin)),
    }))
}

/// `PUT …/cloud-boxes/{box}/pin`.
pub async fn put_pin(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
    Json(request): Json<CloudBoxPinRequest>,
) -> Result<Json<CloudBoxStoredResponse>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let box_id = path_uuid(&cloud_box, "invalid cloud box id")?;
    let pin = decode_opaque(&request.pin, "pin", MAX_OPAQUE_BYTES)?;
    let actor = principal.member_id;
    settle_db(
        "cloud_box.pin",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(refusal) = load_owner_box(conn, workspace_id, box_id, actor).await? {
                    return Ok(Err(refusal));
                }
                Ok(match put_pin_in_tx(conn, workspace_id, box_id, &pin).await? {
                    PutPinOutcome::Stored => Ok(()),
                    PutPinOutcome::NotActive => Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "cloud_box_agent_not_active",
                        "박스 host 키가 아직 런너 증명을 받지 못했어요.",
                    )),
                    PutPinOutcome::NotFound => Err(crate::routes::cloud_boxes::not_found()),
                })
            })
        })
        .await,
    )?;
    Ok(Json(CloudBoxStoredResponse { stored: true }))
}

fn throttled() -> ApiError {
    ApiError::coded(
        StatusCode::TOO_MANY_REQUESTS,
        "cloud_box_attach_throttled",
        "붙는 중인 연결이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.",
    )
}

fn open_error(error: OpenError) -> ApiError {
    match error {
        OpenError::Disabled => ApiError::not_found("not found"),
        OpenError::AgentOffline => ApiError::coded(
            StatusCode::CONFLICT,
            "cloud_box_agent_offline",
            "박스가 아직 연결되지 않았어요. 켜는 중이면 잠시 뒤에 다시 시도해 주세요.",
        ),
        OpenError::BoxBusy => ApiError::coded(
            StatusCode::CONFLICT,
            "cloud_box_busy",
            "이 박스에 붙을 수 있는 연결을 모두 쓰고 있어요.",
        ),
        OpenError::TooManyPendingForMember | OpenError::TooManyPendingGlobal => throttled(),
    }
}

/// `POST …/cloud-boxes/{box}/attach`.
pub async fn attach(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
    Json(request): Json<CloudBoxAttachRequest>,
) -> Result<Json<CloudBoxAttachResponse>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let box_id = path_uuid(&cloud_box, "invalid cloud box id")?;
    let hello = decode_opaque(&request.hello, "hello", MAX_HELLO_BYTES)?;
    let hello_hex = hex_sha256(&hello);
    let hello_sha256: [u8; 32] = Sha256::digest(&hello).into();
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let settings = state.device_keys.clone();
    let signature = request.signature;
    let session_id = Uuid::new_v4();
    let hub = state.cloud_relay.clone();
    let authorised = settle_db(
        "cloud_box.attach",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let owned = match load_owner_box(conn, workspace_id, box_id, actor).await? {
                    Ok(owned) => owned,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                if !matches!(owned.state, BoxState::Running | BoxState::Idle) {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "cloud_box_not_running",
                        format!("지금 상태({})에서는 붙을 수 없어요.", owned.state.as_str()),
                    )));
                }
                let Some(context) = attach_context_in_tx(conn, workspace_id, box_id).await? else {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "cloud_box_agent_unavailable",
                        "박스 host가 아직 등록되지 않았어요.",
                    )));
                };
                if context.host_revoked || context.host_owner != actor {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "cloud_box_agent_unavailable",
                        "박스 host를 쓸 수 없어요.",
                    )));
                }
                // Cheap refusals before the signature's nonce is spent.
                if !hub.listener_online(context.host_id) {
                    return Ok(Err(open_error(OpenError::AgentOffline)));
                }
                let target = ControlTarget {
                    workspace_id,
                    member_id: actor,
                    host_id: context.host_id,
                    session_id: None,
                    subject: ControlSubject::CloudPtyAttach {
                        box_id,
                        hello_sha256: &hello_hex,
                    },
                };
                let verified = match authorize_human_control_in_tx(
                    conn,
                    &settings,
                    &target,
                    signature.as_ref(),
                    // Always: the flag gates enablement, never this control.
                    true,
                )
                .await?
                {
                    Ok(Some(verified)) => verified,
                    Ok(None) => unreachable!("a required signature is verified or refused"),
                    Err(refusal) => return Ok(Err(refusal)),
                };
                record_signed_statement_in_tx(
                    conn,
                    workspace_id,
                    &EntityRef::new(ENTITY_CLOUD_PTY_ATTACH, session_id),
                    verified.key.member_id,
                    &verified.key.public_key,
                    &verified.signature_b64,
                    &verified.signed_bytes,
                )
                .await?;
                // Ids only: no hello, no key, no ticket.
                let mut entry = AuditEntry::new(workspace_id, "cloud_box.pty_attach")
                    .about(actor)
                    .target("cloud_box", box_id)
                    .via_token(via_token)
                    .with_schema(
                        RELAY_AUDIT_SCHEMA,
                        json!({
                            "box_id": box_id.to_string(),
                            "session_id": session_id.to_string(),
                            "device_key_id": verified.key.id.to_string(),
                        }),
                    );
                entry.actor_member_id = Some(actor);
                write_audit(conn, &entry).await?;
                Ok(Ok((context.host_id, verified.key.id)))
            })
        })
        .await,
    )?;
    let (host_id, device_key_id) = authorised;
    let opened = state
        .cloud_relay
        .open_session(OpenParams {
            session_id,
            workspace_id,
            box_id,
            host_id,
            member_id: actor,
            device_key_id,
            hello_sha256,
        })
        .map_err(open_error)?;
    Ok(Json(CloudBoxAttachResponse {
        session_id: opened.session_id.to_string(),
        ticket: opened.ticket,
        expires_at_ms: opened.expires_at_ms,
        relay: CloudBoxRelayDto {
            path: format!(
                "/v1/workspaces/{workspace_id}/cloud-boxes/{box_id}/relay/{}",
                opened.session_id
            ),
            subprotocol: SUBPROTOCOL,
        },
    }))
}

fn ticket_from(headers: &HeaderMap) -> Option<String> {
    let offered = headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .collect::<Vec<_>>();
    if !offered.contains(&SUBPROTOCOL) {
        return None;
    }
    offered
        .iter()
        .find_map(|item| item.strip_prefix(TICKET_PREFIX))
        .map(str::to_string)
}

/// `GET …/cloud-boxes/{box}/relay/{session}` — the device's socket. The ticket is the credential; every
/// failure is the same 401.
pub async fn device_socket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, cloud_box, session)): Path<(String, String, String)>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    gate(&state)?;
    let unauthorized = || ApiError::unauthorized("relay ticket required");
    let (Ok(workspace_id), Ok(box_id), Ok(session_id)) = (
        Uuid::parse_str(&workspace),
        Uuid::parse_str(&cloud_box),
        Uuid::parse_str(&session),
    ) else {
        return Err(unauthorized());
    };
    let Some(ticket) = ticket_from(&headers) else {
        return Err(unauthorized());
    };
    let Some(end) = state
        .cloud_relay
        .claim_device(workspace_id, box_id, session_id, &ticket)
    else {
        return Err(unauthorized());
    };
    let hub = state.cloud_relay.clone();
    Ok(upgrade
        .protocols([SUBPROTOCOL])
        // The relay's own check (exactly `MAX_RELAY_MESSAGE`, answered `message_too_large`) sees every over-size message
        // first; the socket's limit is a backstop a kilobyte above it so a huge message is never buffered.
        .max_message_size(MAX_RELAY_MESSAGE + 1024)
        .max_frame_size(MAX_RELAY_MESSAGE + 1024)
        .on_upgrade(move |socket| run_end(hub, socket, end)))
}

/// Per-IP budget for refused relay tickets (a 401 spends it; a good socket never does).
pub async fn refused_ticket_budget(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    crate::rate_limit::per_ip_refused(state, request, next, "ip:cloud-relay", |config| {
        config.claim_per_ip_limit
    })
    .await
}
