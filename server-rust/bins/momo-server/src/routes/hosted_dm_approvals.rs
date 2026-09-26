//! ADR-0162 증보 2 (#2915) — hosted 1:1 DM approval.
//!
//! ```text
//! GET    /v1/workspaces/{ws}/hosted-agent-connections/{id}/dm-approvals
//! PUT    /v1/workspaces/{ws}/hosted-agent-connections/{id}/dm-approvals/{channel}
//! DELETE /v1/workspaces/{ws}/hosted-agent-connections/{id}/dm-approvals/{channel}
//! GET    /v1/workspaces/{ws}/channels/{channel}/agent-dm-delivery
//! ```
//!
//! * The list is readable by the agent's owner and by workspace admins; only
//!   the owner writes (B3). The owner's own DM is open by rule and cannot be
//!   stored; a subscription agent's other DMs cannot be opened (B4).
//! * `agent-dm-delivery` answers the composer (#2891): what happens if the
//!   caller speaks in this DM now. It is computed from the same candidate row
//!   the mention selector decides on, so it cannot promise a reply the selector
//!   would refuse. A caller who is not a human member of a 1:1 DM with one
//!   agent gets `state: null` — the same answer as a DM with no agent.

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_agent::{
    hosted_dm_delivery, list_hosted_agent_dms_in_tx, load_dm_audience_in_tx,
    load_hosted_dm_connection_in_tx, load_mention_candidates_in_tx, resolve_dm_addressing,
    set_hosted_dm_approval_in_tx, DmAddressing, HostedDmApprovalError, HostedDmRow,
};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use serde::Serialize;
use serde_json::json;

use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedDmApprovalRowDto {
    pub channel_id: String,
    pub counterpart_member_id: String,
    /// `owner` | `approved` | `unapproved` | `not_approvable`
    pub state: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedDmApprovalsResponse {
    pub connection_id: String,
    pub agent_member_id: String,
    pub owner_member_id: Option<String>,
    /// The caller is the owner and the connection is live.
    pub can_edit: bool,
    pub owner_only: bool,
    pub dms: Vec<HostedDmApprovalRowDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedDmApprovalWriteResponse {
    pub connection_id: String,
    pub dm: HostedDmApprovalRowDto,
    pub changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDmDeliveryResponse {
    pub channel_id: String,
    pub agent_member_id: Option<String>,
    pub owner_member_id: Option<String>,
    /// `null` when this is not a 1:1 DM between the caller and one agent.
    pub state: Option<&'static str>,
}

fn row_dto(row: &HostedDmRow) -> HostedDmApprovalRowDto {
    HostedDmApprovalRowDto {
        channel_id: row.channel_id.to_string(),
        counterpart_member_id: row.counterpart_member_id.to_string(),
        state: row.state.as_str(),
    }
}

fn no_store<T: Serialize>(status: StatusCode, body: T) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn approval_error(error: HostedDmApprovalError) -> ApiError {
    match error {
        HostedDmApprovalError::NotFound => ApiError::not_found("hosted connection not found"),
        HostedDmApprovalError::NotOwner => {
            ApiError::forbidden("only the agent's owner can approve its DMs")
        }
        HostedDmApprovalError::OwnerOnly => ApiError::new(
            StatusCode::CONFLICT,
            "a subscription agent answers its owner's DM only",
        ),
        HostedDmApprovalError::NotLive => {
            ApiError::new(StatusCode::CONFLICT, "hosted connection is not live")
        }
        HostedDmApprovalError::NotOneToOneDm => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "channel is not a 1:1 DM between this agent and a member",
        ),
        HostedDmApprovalError::OwnerDm => {
            ApiError::new(StatusCode::CONFLICT, "the owner's DM is always open")
        }
    }
}

/// `GET …/hosted-agent-connections/{connection}/dm-approvals`
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let actor = principal.member_id;
    let outcome = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let Some(connection) =
                load_hosted_dm_connection_in_tx(conn, workspace_id, connection_id, false).await?
            else {
                return Ok(Err(ApiError::not_found("hosted connection not found")));
            };
            let is_owner = connection.owner_member_id == Some(actor);
            let is_admin = active_workspace_role(conn, workspace_id, actor)
                .await?
                .is_some_and(|role| role.is_admin());
            if !is_owner && !is_admin {
                return Ok(Err(ApiError::forbidden(
                    "the agent's owner or a workspace admin required",
                )));
            }
            let dms = list_hosted_agent_dms_in_tx(conn, workspace_id, &connection).await?;
            Ok(Ok(HostedDmApprovalsResponse {
                connection_id: connection.connection_id.to_string(),
                agent_member_id: connection.agent_member_id.to_string(),
                owner_member_id: connection.owner_member_id.map(|id| id.to_string()),
                can_edit: is_owner && connection.is_live(),
                owner_only: connection.owner_only,
                dms: dms.iter().map(row_dto).collect(),
            }))
        })
    })
    .await;
    let body = settle_db("hosted_dm_approvals.list", outcome)?;
    Ok(no_store(StatusCode::OK, body))
}

async fn write(
    state: AppState,
    principal: Principal,
    workspace: String,
    connection: String,
    channel: String,
    approve: bool,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let outcome = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let (dm, changed) = match set_hosted_dm_approval_in_tx(
                conn,
                workspace_id,
                connection_id,
                channel_id,
                actor,
                approve,
            )
            .await?
            {
                Ok(done) => done,
                Err(error) => return Ok(Err(approval_error(error))),
            };
            if changed {
                let action = if approve {
                    "hosted_agent.dm_approval.granted"
                } else {
                    "hosted_agent.dm_approval.revoked"
                };
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, action)
                        .by(actor)
                        .target("hosted_agent_connection", connection_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.hosted_agent.dm_approval.v1",
                            json!({
                                "channel_id": channel_id,
                                "counterpart_member_id": dm.counterpart_member_id,
                                "approved": approve,
                            }),
                        ),
                )
                .await?;
            }
            Ok(Ok(HostedDmApprovalWriteResponse {
                connection_id: connection_id.to_string(),
                dm: row_dto(&dm),
                changed,
            }))
        })
    })
    .await;
    let body = settle_db("hosted_dm_approvals.write", outcome)?;
    Ok(no_store(StatusCode::OK, body))
}

/// `PUT …/dm-approvals/{channel}` — the owner opens one DM.
pub async fn approve(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection, channel)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    write(state, principal, workspace, connection, channel, true).await
}

/// `DELETE …/dm-approvals/{channel}` — the owner closes it again.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection, channel)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    write(state, principal, workspace, connection, channel, false).await
}

/// `GET /v1/workspaces/{ws}/channels/{channel}/agent-dm-delivery`
pub async fn dm_delivery(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let caller = principal.member_id;
    let hosted_delivery_enabled = state.agent_port.config.hosted_delivery_enabled;
    let subscription_agents_enabled = state.agent_port.config.subscription_agents_enabled;
    let outcome: DbRejectable<AgentDmDeliveryResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let none = AgentDmDeliveryResponse {
                    channel_id: channel_id.to_string(),
                    agent_member_id: None,
                    owner_member_id: None,
                    state: None,
                };
                let audience = load_dm_audience_in_tx(conn, channel_id).await?;
                // The DM rule's own verdict, with the caller as author: a caller
                // who is not a human member of this DM learns nothing about it.
                let DmAddressing::Addressed(agent_member_id) =
                    resolve_dm_addressing(&audience, caller, false)
                else {
                    return Ok(Ok(none));
                };
                let one_to_one = audience.participants.len() == 2;
                let candidates =
                    load_mention_candidates_in_tx(conn, workspace_id, channel_id).await?;
                let Some(agent) = candidates
                    .iter()
                    .find(|candidate| candidate.member_id == agent_member_id)
                else {
                    return Ok(Ok(none));
                };
                let delivery = hosted_dm_delivery(
                    agent,
                    caller,
                    one_to_one,
                    hosted_delivery_enabled,
                    subscription_agents_enabled,
                );
                Ok(Ok(AgentDmDeliveryResponse {
                    channel_id: channel_id.to_string(),
                    agent_member_id: Some(agent_member_id.to_string()),
                    owner_member_id: agent.owner_member_id.map(|id| id.to_string()),
                    state: Some(delivery.as_str()),
                }))
            })
        })
        .await;
    let body = settle_db("hosted_dm_approvals.dm_delivery", outcome)?;
    Ok(no_store(StatusCode::OK, body))
}
