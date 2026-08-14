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
    acknowledge_hosted_artifact_in_tx, active_workspace_role, artifact_audit_detail,
    complete_hosted_disconnect_in_tx, confirm_hosted_connection_in_tx,
    count_unresolved_required_artifacts_in_tx, create_hosted_connection_in_tx,
    get_hosted_connection_in_tx, list_hosted_artifacts_in_tx, list_hosted_connections_in_tx,
    regenerate_pairing_in_tx, start_hosted_disconnect_in_tx, validate_artifact_evidence,
    validate_artifact_seeds, validate_artifact_status, validate_channel_ids,
    validate_hosted_scopes, HostedArtifact, HostedArtifactAck, HostedArtifactAcknowledgement,
    HostedArtifactSeed, HostedConnection, HostedDisconnectCompletion, HostedDisconnectStart,
    HostedMutation, Principal,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
};
use serde_json::json;

use crate::dto::{
    AcknowledgeHostedCleanupArtifactRequest, AcknowledgeHostedCleanupArtifactResponse,
    CompleteHostedAgentDisconnectResponse, ConfirmHostedAgentConnectionRequest,
    ConfirmHostedAgentConnectionResponse, CreateHostedAgentConnectionRequest,
    CreateHostedAgentConnectionResponse, DisconnectHostedAgentConnectionRequest,
    DisconnectHostedAgentConnectionResponse, HostedAgentConnectionDto,
    HostedAgentConnectionListResponse, HostedAgentConnectionResponse, HostedCleanupArtifactDto,
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

fn artifact_dto(artifact: HostedArtifact) -> HostedCleanupArtifactDto {
    HostedCleanupArtifactDto {
        id: artifact.id.to_string(),
        kind: artifact.kind,
        external_ref: artifact.external_ref,
        expected_action: artifact.expected_action,
        current_status: artifact.current_status,
        disposition: artifact.disposition,
        resolved: artifact.resolved,
        required: artifact.required,
        source: artifact.source,
        acknowledged_by: artifact.acknowledged_by.map(|id| id.to_string()),
        acknowledged_at_ms: artifact.acknowledged_at_ms,
        evidence: artifact.evidence,
        updated_at_ms: artifact.updated_at_ms,
    }
}

fn artifact_dtos(artifacts: Vec<HostedArtifact>) -> Vec<HostedCleanupArtifactDto> {
    artifacts.into_iter().map(artifact_dto).collect()
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
    let (row, artifacts) = settle_db(
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
                let artifacts =
                    list_hosted_artifacts_in_tx(conn, workspace_id, connection_id).await?;
                Ok(Ok((row, artifacts)))
            })
        })
        .await,
    )?;
    Ok(Json(HostedAgentConnectionResponse {
        connection: dto(row),
        cleanup_artifacts: artifact_dtos(artifacts),
    }))
}

/// `POST /v1/workspaces/{ws}/hosted-agent-connections/{connection}/disconnect`.
///
/// One transaction, five effects (ADR-0162 HAP-E6): the connection's live
/// bearer is revoked, the connection becomes `cleanup_pending`, the dedicated
/// agent is paused, every open gateway job of that agent is suppressed with its
/// lease released, and the cleanup manifest is seeded. A failure anywhere rolls
/// the whole set back, because a revoked credential beside a runnable agent —
/// or a paused agent beside a live credential — is a worse state than either
/// end of the transition.
///
/// A retry answers the same thing and writes nothing, including no second audit
/// row.
pub async fn disconnect(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
    request: Option<Json<DisconnectHostedAgentConnectionRequest>>,
) -> Result<Json<DisconnectHostedAgentConnectionResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let requested = request.map(|Json(body)| body).unwrap_or_default();
    let seeds: Vec<HostedArtifactSeed> = requested
        .artifacts
        .into_iter()
        .map(|item| HostedArtifactSeed {
            kind: item.kind,
            external_ref: item.external_ref,
        })
        .collect();
    let seeds = validate_artifact_seeds(&seeds)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let (connection_row, artifacts, remaining, started_now) = settle_db(
        "hosted_agent_connections.disconnect",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                let started = match start_hosted_disconnect_in_tx(
                    conn,
                    workspace_id,
                    connection_id,
                    actor,
                    &seeds,
                )
                .await?
                {
                    HostedDisconnectStart::Applied(started) => *started,
                    HostedDisconnectStart::NotFound => {
                        return Ok(Err(ApiError::not_found("hosted connection not found")))
                    }
                    HostedDisconnectStart::AlreadyTerminal(_) => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "hosted connection is already disconnected",
                        )))
                    }
                    HostedDisconnectStart::WrongState => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "hosted connection cannot disconnect",
                        )))
                    }
                };
                if started.changed {
                    // The same tenant transaction: work that was already handed
                    // out stops here, not on the next poll.
                    let suppression = momo_outbox::suppress_hosted_agent_jobs_in_tx(
                        conn,
                        workspace_id,
                        started.connection.agent_member_id,
                    )
                    .await
                    .map_err(momo_db::DbError::from)?;
                    write_audit(
                        conn,
                        &AuditEntry::new(
                            workspace_id,
                            "hosted_agent.connection.disconnect_started",
                        )
                        .by(actor)
                        .about(started.connection.agent_member_id)
                        .target("hosted_agent_connection", connection_id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.hosted_agent.connection.disconnect_started.v1",
                            json!({
                                "status": "cleanup_pending",
                                "revoked_credential_count": started.revoked_credential_count,
                                "suppressed_job_count": suppression.suppressed_jobs,
                                "released_lease_count": suppression.released_leases,
                                "artifact_count": started.artifacts.len(),
                                "trigger": "operator"
                            }),
                        ),
                    )
                    .await?;
                }
                let remaining =
                    count_unresolved_required_artifacts_in_tx(conn, workspace_id, connection_id)
                        .await?;
                Ok(Ok((
                    started.connection,
                    started.artifacts,
                    remaining,
                    started.changed,
                )))
            })
        })
        .await,
    )?;

    Ok(Json(DisconnectHostedAgentConnectionResponse {
        connection: dto(connection_row),
        cleanup_artifacts: artifact_dtos(artifacts),
        remaining_required: remaining,
        started_now,
    }))
}

/// `POST /v1/workspaces/{ws}/hosted-agent-connections/{connection}/cleanup-artifacts/{artifact}/acknowledge`.
///
/// The manual half of cleanup confirmation. `source` is never read from the
/// request: this route writes `manual` and nothing else, so a client cannot
/// promote its own claim to the `server_verified` provenance the disconnect
/// reserved for the credential it revoked itself.
pub async fn acknowledge_cleanup_artifact(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection, artifact)): Path<(String, String, String)>,
    Json(request): Json<AcknowledgeHostedCleanupArtifactRequest>,
) -> Result<Json<AcknowledgeHostedCleanupArtifactResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let artifact_id = path_uuid(&artifact, "invalid cleanup artifact id")?;
    validate_artifact_status(&request.current_status)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    // A decision needs evidence; a bare observation does not, because an
    // observation resolves nothing.
    let evidence = match request.disposition.as_deref() {
        Some(_) => Some(
            validate_artifact_evidence(request.evidence.as_deref())
                .map_err(|error| ApiError::bad_request(error.to_string()))?,
        ),
        None => None,
    };
    let disposition = request.disposition;
    let current_status = request.current_status;
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let acknowledged = settle_db(
        "hosted_agent_connections.acknowledge_cleanup_artifact",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                let acknowledged = match acknowledge_hosted_artifact_in_tx(
                    conn,
                    workspace_id,
                    connection_id,
                    HostedArtifactAcknowledgement {
                        artifact_id,
                        actor_member_id: actor,
                        current_status: &current_status,
                        disposition: disposition.as_deref(),
                        evidence: evidence.as_deref(),
                    },
                )
                .await?
                {
                    HostedArtifactAck::Applied(acknowledged) => *acknowledged,
                    HostedArtifactAck::NotFound => {
                        return Ok(Err(ApiError::not_found("cleanup artifact not found")))
                    }
                    HostedArtifactAck::WrongState => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "hosted connection is not awaiting cleanup",
                        )))
                    }
                    HostedArtifactAck::AlreadyResolved => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "cleanup artifact is already resolved",
                        )))
                    }
                    HostedArtifactAck::IllegalDisposition => {
                        return Ok(Err(ApiError::bad_request(
                            "disposition is not legal for this artifact kind",
                        )))
                    }
                };
                if acknowledged.changed {
                    write_audit(
                        conn,
                        &AuditEntry::new(
                            workspace_id,
                            "hosted_agent.connection.cleanup_artifact_acknowledged",
                        )
                        .by(actor)
                        .target("hosted_agent_connection", connection_id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.hosted_agent.connection.cleanup_artifact_acknowledged.v1",
                            artifact_audit_detail(&acknowledged.artifact),
                        ),
                    )
                    .await?;
                }
                Ok(Ok(acknowledged))
            })
        })
        .await,
    )?;

    Ok(Json(AcknowledgeHostedCleanupArtifactResponse {
        artifact: artifact_dto(acknowledged.artifact),
        remaining_required: acknowledged.remaining_required,
        changed: acknowledged.changed,
    }))
}

/// `POST /v1/workspaces/{ws}/hosted-agent-connections/{connection}/disconnect/complete`.
///
/// The terminal transition, refused while anything required is unresolved and
/// performed at most once. A replay answers 200 with `disconnectedNow: false`
/// and writes no audit row.
pub async fn complete_disconnect(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
) -> Result<Json<CompleteHostedAgentDisconnectResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let (connection_row, artifacts, disconnected_now) = settle_db(
        "hosted_agent_connections.complete_disconnect",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                let (row, changed) =
                    match complete_hosted_disconnect_in_tx(conn, workspace_id, connection_id)
                        .await?
                    {
                        HostedDisconnectCompletion::Applied(row) => (*row, true),
                        HostedDisconnectCompletion::AlreadyTerminal(row) => (*row, false),
                        HostedDisconnectCompletion::NotFound => {
                            return Ok(Err(ApiError::not_found("hosted connection not found")))
                        }
                        HostedDisconnectCompletion::WrongState => {
                            return Ok(Err(ApiError::new(
                                StatusCode::CONFLICT,
                                "hosted connection is not awaiting cleanup",
                            )))
                        }
                        HostedDisconnectCompletion::Unresolved { .. }
                        // One answer for both, because they are the same
                        // refusal from a caller's side — the manifest does not
                        // say this connection is clean — and separating them
                        // would tell an unauthorized prober whether a
                        // disconnect had ever started.
                        | HostedDisconnectCompletion::ManifestMissing => {
                            return Ok(Err(ApiError::new(
                                StatusCode::CONFLICT,
                                "hosted connection has unresolved cleanup artifacts",
                            )))
                        }
                        HostedDisconnectCompletion::LocalRevokeIncomplete => {
                            return Ok(Err(ApiError::new(
                                StatusCode::CONFLICT,
                                "hosted connection local revoke is not confirmed",
                            )))
                        }
                    };
                if changed {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "hosted_agent.connection.disconnected")
                            .by(actor)
                            .about(row.agent_member_id)
                            .target("hosted_agent_connection", connection_id)
                            .via_token(via_token_id)
                            .with_schema(
                                "momo.hosted_agent.connection.disconnected.v1",
                                json!({"status": "disconnected", "history_preserved": true}),
                            ),
                    )
                    .await?;
                }
                let artifacts =
                    list_hosted_artifacts_in_tx(conn, workspace_id, connection_id).await?;
                Ok(Ok((row, artifacts, changed)))
            })
        })
        .await,
    )?;

    Ok(Json(CompleteHostedAgentDisconnectResponse {
        connection: dto(connection_row),
        cleanup_artifacts: artifact_dtos(artifacts),
        disconnected_now,
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
