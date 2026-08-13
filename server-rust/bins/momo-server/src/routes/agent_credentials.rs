//! Human owner/admin lifecycle for generic per-agent bearer credentials.
//!
//! Raw bearer material exists in exactly two places: the local `String` minted
//! for a create request and that request's one-time response. The domain module
//! hashes it inside PostgreSQL and every projection below is metadata-only.

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{
    active_agent_for_credential_list, active_workspace_role,
    agent_credential_requires_instance_operator, issue_agent_credential_in_tx,
    list_agent_credentials_in_tx, mint_agent_bearer, normalized_agent_credential_label,
    normalized_agent_credential_reason, normalized_agent_credential_scopes,
    revoke_agent_credential_in_tx, validated_agent_credential_expiry,
    validated_rotation_grace_seconds, verified_operator_email, AgentCredentialInputError,
    AgentCredentialMutation, AgentCredentialRecord, Principal, AUDIT_ACTION_ISSUED,
    AUDIT_ACTION_REVOKED, AUDIT_SCHEMA_ISSUED, AUDIT_SCHEMA_REVOKED,
    HOSTED_CONNECTION_MANAGED_CODE,
};
use momo_db::audit::{write_audit, AuditEntry};
use serde_json::json;

use crate::dto::{
    AgentCredentialDto, AgentCredentialListResponse, CreateAgentCredentialRequest,
    CreateAgentCredentialResponse, RevokeAgentCredentialRequest, RevokeAgentCredentialResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
};
use crate::AppState;

const PLATFORM_READ_SCOPE: &str = "platform:read";

fn input_error(error: AgentCredentialInputError) -> ApiError {
    ApiError::bad_request(error.to_string())
}

fn credential_dto(record: AgentCredentialRecord) -> AgentCredentialDto {
    AgentCredentialDto {
        id: record.id.to_string(),
        agent_member_id: record.agent_member_id.to_string(),
        status: record.status.as_str(),
        scopes: record.scopes,
        label: record.label,
        last_used_at_ms: record.last_used_at_ms,
        expires_at_ms: record.expires_at_ms,
        revoked_at_ms: record.revoked_at_ms,
        created_at_ms: record.created_at_ms,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn hosted_connection_managed() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, HOSTED_CONNECTION_MANAGED_CODE)
}

/// `POST /v1/workspaces/{ws}/agents/{agent}/credentials`.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    Json(request): Json<CreateAgentCredentialRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;

    // All shape decisions happen before the transaction. Entropy is consumed
    // only after the human-admin and operator gates pass inside that same
    // tenant transaction.
    let scopes =
        normalized_agent_credential_scopes(request.scopes.as_deref()).map_err(input_error)?;
    let label = normalized_agent_credential_label(request.label.as_deref()).map_err(input_error)?;
    let expires_at_ms =
        validated_agent_credential_expiry(request.expires_at_ms, now_ms()).map_err(input_error)?;
    let rotation_grace_seconds =
        validated_rotation_grace_seconds(request.rotation_grace_seconds).map_err(input_error)?;
    let actor_member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let carries_platform_read = principal
        .scopes
        .iter()
        .any(|scope| scope == PLATFORM_READ_SCOPE);
    let operator_emails = state.settings.platform_admin_emails.clone();
    let requires_instance_operator = agent_credential_requires_instance_operator(&scopes);
    let (issued, raw_token) = settle_db(
        "agent_credentials.create",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, actor_member_id).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Err(ApiError::forbidden("workspace admin required")));
                }

                if requires_instance_operator && !carries_platform_read {
                    let email =
                        verified_operator_email(conn, workspace_id, actor_member_id).await?;
                    if !email.is_some_and(|email| operator_emails.contains(&email)) {
                        return Ok(Err(ApiError::forbidden(
                            "platform:read scope or listed instance operator required",
                        )));
                    }
                }

                let raw_token = match mint_agent_bearer(workspace_id) {
                    Ok(token) => token,
                    Err(error) => {
                        return Ok(Err(ApiError::internal("agent_credentials.mint", error)))
                    }
                };

                let issued = match issue_agent_credential_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    actor_member_id,
                    &raw_token,
                    &scopes,
                    &label,
                    expires_at_ms,
                    rotation_grace_seconds,
                )
                .await?
                {
                    AgentCredentialMutation::Applied(issued) => issued,
                    AgentCredentialMutation::AgentNotFound => {
                        return Ok(Err(ApiError::not_found("active agent not found")))
                    }
                    AgentCredentialMutation::HostedConnectionManaged => {
                        return Ok(Err(hosted_connection_managed()))
                    }
                    // The request expired while waiting for the per-agent
                    // rotation lock. The atomic SQL statement changed nothing.
                    AgentCredentialMutation::ExpiryNotFuture => {
                        return Ok(Err(ApiError::bad_request(
                            "expiresAtMs must be in the future",
                        )))
                    }
                    AgentCredentialMutation::CredentialNotFound => {
                        return Ok(Err(ApiError::internal(
                            "agent_credentials.create",
                            "unexpected credential mutation result",
                        )))
                    }
                };

                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_ACTION_ISSUED)
                        .by(actor_member_id)
                        .about(agent_member_id)
                        .target("token", issued.credential.id)
                        .via_token(via_token_id)
                        .with_schema(
                            AUDIT_SCHEMA_ISSUED,
                            json!({
                                "scopes": scopes,
                                "label": label,
                                "rotated_credential_count": issued.rotated_credential_count,
                                "rotation_grace_seconds": rotation_grace_seconds,
                            }),
                        ),
                )
                .await?;
                Ok(Ok((issued, raw_token)))
            })
        })
        .await,
    )?;

    let body = CreateAgentCredentialResponse {
        credential: credential_dto(issued.credential),
        token: raw_token,
        token_type: "Bearer",
        rotated_credential_count: issued.rotated_credential_count,
        rotation_grace_ends_at_ms: issued.rotation_grace_ends_at_ms,
    };
    let mut response = (StatusCode::CREATED, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    Ok(response)
}

/// `GET /v1/workspaces/{ws}/agents/{agent}/credentials`.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<AgentCredentialListResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    let actor_member_id = principal.member_id;

    let records = settle_db(
        "agent_credentials.list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, actor_member_id).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Err(ApiError::forbidden("workspace admin required")));
                }
                if !active_agent_for_credential_list(conn, workspace_id, agent_member_id).await? {
                    return Ok(Err(ApiError::not_found("active agent not found")));
                }
                Ok(Ok(list_agent_credentials_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                )
                .await?))
            })
        })
        .await,
    )?;

    Ok(Json(AgentCredentialListResponse {
        credentials: records.into_iter().map(credential_dto).collect(),
    }))
}

/// `POST /v1/workspaces/{ws}/agents/{agent}/credentials/{credential}/revoke`.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent, credential)): Path<(String, String, String)>,
    request: Option<Json<RevokeAgentCredentialRequest>>,
) -> Result<Json<RevokeAgentCredentialResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    let credential_id = path_uuid(&credential, "invalid credential id")?;
    let reason = normalized_agent_credential_reason(
        request
            .as_ref()
            .and_then(|Json(body)| body.reason.as_deref()),
    )
    .map_err(input_error)?;
    let actor_member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let revoked = settle_db(
        "agent_credentials.revoke",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, actor_member_id).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Err(ApiError::forbidden("workspace admin required")));
                }
                let revoked = match revoke_agent_credential_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    credential_id,
                )
                .await?
                {
                    AgentCredentialMutation::Applied(revoked) => revoked,
                    AgentCredentialMutation::HostedConnectionManaged => {
                        return Ok(Err(hosted_connection_managed()))
                    }
                    AgentCredentialMutation::AgentNotFound
                    | AgentCredentialMutation::CredentialNotFound => {
                        return Ok(Err(ApiError::not_found("agent credential not found")))
                    }
                    AgentCredentialMutation::ExpiryNotFuture => {
                        return Ok(Err(ApiError::internal(
                            "agent_credentials.revoke",
                            "unexpected expiry mutation result",
                        )))
                    }
                };
                if revoked.revoked_now {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, AUDIT_ACTION_REVOKED)
                            .by(actor_member_id)
                            .about(agent_member_id)
                            .target("token", credential_id)
                            .via_token(via_token_id)
                            .with_schema(AUDIT_SCHEMA_REVOKED, json!({"reason": reason})),
                    )
                    .await?;
                }
                Ok(Ok(revoked))
            })
        })
        .await,
    )?;

    Ok(Json(RevokeAgentCredentialResponse {
        credential: credential_dto(revoked.credential),
        revoked_now: revoked.revoked_now,
        already_revoked: !revoked.revoked_now,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn projected_credentials_have_no_secret_field_by_construction() {
        let dto = credential_dto(AgentCredentialRecord {
            id: Uuid::from_u128(1),
            agent_member_id: Uuid::from_u128(2),
            status: momo_auth::AgentCredentialStatus::Active,
            scopes: vec!["messages:write".to_string()],
            label: Some("runtime".to_string()),
            last_used_at_ms: None,
            expires_at_ms: None,
            revoked_at_ms: None,
            created_at_ms: 3,
        });
        let value = serde_json::to_value(dto).unwrap();
        assert!(value.get("token").is_none());
        assert!(value.get("tokenHash").is_none());
        assert!(value.get("prefix").is_none());
    }
}
