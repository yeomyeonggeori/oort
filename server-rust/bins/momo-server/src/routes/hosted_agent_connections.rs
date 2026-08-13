//! ADR-0162 hosted-agent admin lifecycle. OAuth and provider delivery are
//! intentionally absent; this surface provisions only a dedicated paused
//! identity and the static-bearer pairing/activation state machine.

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_agent::{
    create_agent_identity_in_tx, set_agent_paused_in_tx, AgentCreation, NewAgentMember,
};
use momo_auth::{
    active_workspace_role, confirm_hosted_connection_in_tx, create_hosted_connection_in_tx,
    get_hosted_connection_in_tx, list_hosted_connections_in_tx, regenerate_pairing_in_tx,
    validate_channel_ids, validate_hosted_scopes, HostedConnection, HostedMutation, Principal,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
};
use serde_json::json;

use crate::dto::{
    ConfirmHostedAgentConnectionRequest, ConfirmHostedAgentConnectionResponse,
    CreateHostedAgentConnectionRequest, CreateHostedAgentConnectionResponse,
    HostedAgentConnectionDto, HostedAgentConnectionListResponse, HostedAgentConnectionResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
};
use crate::AppState;

fn dto(connection: HostedConnection) -> HostedAgentConnectionDto {
    HostedAgentConnectionDto {
        id: connection.id.to_string(),
        agent_member_id: connection.agent_member_id.to_string(),
        status: connection.status,
        auth_mode: connection.auth_mode,
        audience: connection.audience,
        approved_channel_ids: connection
            .approved_channel_ids
            .into_iter()
            .map(|id| id.to_string())
            .collect(),
        approved_scopes: connection.approved_scopes,
        active_credential_id: connection.active_token_id.map(|id| id.to_string()),
        created_at_ms: connection.created_at_ms,
        updated_at_ms: connection.updated_at_ms,
    }
}

fn no_store<T: serde::Serialize>(status: StatusCode, body: T) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

async fn require_admin(
    conn: &mut momo_db::PgConnection,
    workspace_id: uuid::Uuid,
    actor_member_id: uuid::Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    if active_workspace_role(conn, workspace_id, actor_member_id)
        .await?
        .is_some_and(|role| role.is_admin())
    {
        Ok(Ok(()))
    } else {
        Ok(Err(ApiError::forbidden("workspace admin required")))
    }
}

pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateHostedAgentConnectionRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    if request.auth_mode != "static_bearer" {
        return Err(ApiError::bad_request("authMode must equal static_bearer"));
    }
    let display_name = normalized_join_display_name(&request.display_name)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let handle = normalized_requested_handle(Some(&request.handle))
        .map_err(|error| ApiError::bad_request(error.to_string()))?
        .ok_or_else(|| ApiError::bad_request("handle is required"))?;
    let actor_member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let issuance = settle_db(
        "hosted_agent_connections.create",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor_member_id).await? {
                    return Ok(Err(error));
                }
                if is_handle_banned_in_tx(conn, &handle).await? {
                    return Ok(Err(ApiError::forbidden(
                        "member is banned from this workspace",
                    )));
                }
                // The non-routable sentinel is display metadata only. Hosted
                // execution never dereferences agent.base_url (#1364 guard).
                let member = match create_agent_identity_in_tx(
                    conn,
                    workspace_id,
                    &NewAgentMember {
                        display_name,
                        handle,
                        model: momo_auth::HOSTED_AGENT_MODEL.to_string(),
                        base_url: momo_auth::HOSTED_AGENT_INERT_BASE_URL.to_string(),
                        system_prompt: None,
                        config: json!({"execution_mode":"hosted_dial_in"}),
                        owner_human_id: actor_member_id,
                    },
                )
                .await?
                {
                    AgentCreation::Created(member) => member,
                    AgentCreation::DuplicateHandle => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "agent handle already exists",
                        )))
                    }
                    AgentCreation::InvalidOwner => {
                        return Ok(Err(ApiError::forbidden("active human owner required")))
                    }
                };
                if set_agent_paused_in_tx(conn, workspace_id, member.id, actor_member_id, true)
                    .await?
                    .is_none()
                {
                    return Err(momo_db::DbError::from(momo_db::sqlx::Error::RowNotFound));
                }
                let issuance =
                    create_hosted_connection_in_tx(conn, workspace_id, member.id, actor_member_id)
                        .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "hosted_agent.connection.created")
                        .by(actor_member_id)
                        .about(member.id)
                        .target("hosted_agent_connection", issuance.connection.id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.hosted_agent.connection.created.v1",
                            json!({"auth_mode":"static_bearer","status":"pairing_pending"}),
                        ),
                )
                .await?;
                Ok(Ok(issuance))
            })
        })
        .await,
    )?;
    Ok(no_store(
        StatusCode::CREATED,
        CreateHostedAgentConnectionResponse {
            connection: dto(issuance.connection),
            pairing_credential: issuance.pairing_credential,
            pairing_expires_at_ms: issuance.pairing_expires_at_ms,
        },
    ))
}

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<HostedAgentConnectionListResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let rows = settle_db(
        "hosted_agent_connections.list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                Ok(Ok(list_hosted_connections_in_tx(conn, workspace_id).await?))
            })
        })
        .await,
    )?;
    Ok(Json(HostedAgentConnectionListResponse {
        connections: rows.into_iter().map(dto).collect(),
    }))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
) -> Result<Json<HostedAgentConnectionResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let actor = principal.member_id;
    let row = settle_db(
        "hosted_agent_connections.get",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                let Some(row) =
                    get_hosted_connection_in_tx(conn, workspace_id, connection_id).await?
                else {
                    return Ok(Err(ApiError::not_found("hosted connection not found")));
                };
                Ok(Ok(row))
            })
        })
        .await,
    )?;
    Ok(Json(HostedAgentConnectionResponse {
        connection: dto(row),
    }))
}

pub async fn regenerate(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let issuance = settle_db(
        "hosted_agent_connections.regenerate",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                match regenerate_pairing_in_tx(conn, workspace_id, connection_id).await? {
                    HostedMutation::Applied(value) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(
                                workspace_id,
                                "hosted_agent.connection.pairing_regenerated",
                            )
                            .by(actor)
                            .about(value.connection.agent_member_id)
                            .target("hosted_agent_connection", connection_id)
                            .via_token(via_token_id)
                            .with_schema(
                                "momo.hosted_agent.connection.pairing_regenerated.v1",
                                json!({"status":"pairing_pending"}),
                            ),
                        )
                        .await?;
                        Ok(Ok(value))
                    }
                    HostedMutation::NotFound => {
                        Ok(Err(ApiError::not_found("hosted connection not found")))
                    }
                    HostedMutation::WrongState
                    | HostedMutation::InvalidApproval
                    | HostedMutation::Expired => Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "hosted connection cannot regenerate",
                    ))),
                }
            })
        })
        .await,
    )?;
    Ok(no_store(
        StatusCode::OK,
        CreateHostedAgentConnectionResponse {
            connection: dto(issuance.connection),
            pairing_credential: issuance.pairing_credential,
            pairing_expires_at_ms: issuance.pairing_expires_at_ms,
        },
    ))
}

pub async fn confirm(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
    Json(request): Json<ConfirmHostedAgentConnectionRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    if request.auth_mode != "static_bearer" {
        return Err(ApiError::bad_request("authMode must equal static_bearer"));
    }
    if request.audience != momo_auth::HOSTED_AGENT_PORT_AUDIENCE {
        return Err(ApiError::bad_request(
            "audience must equal /v1/mcp/agent-port",
        ));
    }
    validate_channel_ids(&request.approved_channel_ids)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let channels = request.approved_channel_ids;
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let issuance = settle_db(
        "hosted_agent_connections.confirm",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                let scopes = match validate_hosted_scopes(&request.approved_scopes) {
                    Ok(scopes) => scopes,
                    Err(error) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(
                                workspace_id,
                                "hosted_agent.connection.confirm_scope_denied",
                            )
                            .by(actor)
                            .target("hosted_agent_connection", connection_id)
                            .via_token(via_token_id)
                            .with_schema(
                                "momo.hosted_agent.connection.confirm_scope_denied.v1",
                                json!({
                                    "code": "scope_not_allowed",
                                    "requested_scope_count": request.approved_scopes.len()
                                }),
                            ),
                        )
                        .await?;
                        return Ok(Err(ApiError::bad_request(error.to_string())));
                    }
                };
                let approval = momo_auth::HostedConnectionApproval {
                    agent_member_id: request.agent_member_id,
                    auth_mode: request.auth_mode,
                    audience: request.audience,
                    channel_ids: channels,
                    scopes,
                };
                let issuance = match confirm_hosted_connection_in_tx(
                    conn,
                    workspace_id,
                    connection_id,
                    actor,
                    &approval,
                )
                .await?
                {
                    HostedMutation::Applied(value) => value,
                    HostedMutation::NotFound => {
                        return Ok(Err(ApiError::not_found("hosted connection not found")))
                    }
                    HostedMutation::InvalidApproval => {
                        return Ok(Err(ApiError::bad_request(
                            "approved channels are not eligible",
                        )))
                    }
                    HostedMutation::WrongState | HostedMutation::Expired => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "hosted connection is not detected",
                        )))
                    }
                };
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "hosted_agent.connection.confirmed")
                        .by(actor)
                        .about(issuance.connection.agent_member_id)
                        .target("hosted_agent_connection", connection_id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.hosted_agent.connection.confirmed.v1",
                            json!({
                                "channel_count": approval.channel_ids.len(),
                                "scopes": approval.scopes,
                                "audience": "/v1/mcp/agent-port"
                            }),
                        ),
                )
                .await?;
                Ok(Ok(issuance))
            })
        })
        .await,
    )?;
    Ok(no_store(
        StatusCode::CREATED,
        ConfirmHostedAgentConnectionResponse {
            connection: dto(issuance.connection),
            credential_id: issuance.credential_id.to_string(),
            credential: issuance.credential,
            token_type: "Bearer",
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_responses_are_forced_no_store() {
        let response = no_store(
            StatusCode::CREATED,
            serde_json::json!({"credential":"redacted"}),
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::PRAGMA], "no-cache");
    }
}
