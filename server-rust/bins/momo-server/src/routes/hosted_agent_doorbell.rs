//! ADR-0171 hosted-connection doorbell register/unregister.
//!
//! ```text
//! PUT    /v1/workspaces/{ws}/hosted-agent-connections/{id}/doorbell
//! DELETE /v1/workspaces/{ws}/hosted-agent-connections/{id}/doorbell
//! ```
//!
//! Off (`MOMO_DOORBELL_ENABLED` ≠ exact `true`) is an empty 404 — the same
//! answer an unknown path gets, so the flag itself is not a probe surface.

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_webhook::{
    register_doorbell_in_tx, unregister_doorbell_in_tx, DoorbellProjection, DoorbellRegisterError,
    OutboundUrl, OutboundUrlError, SystemHostResolver, DOORBELL_SECRET_MAX_BYTES,
};
use serde_json::json;
use uuid::Uuid;

use crate::dto::{HostedDoorbellResponse, RegisterHostedDoorbellRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, require_human, settle_db,
    workspace_scope,
};
use crate::AppState;

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

/// Flag-off and unknown-path share this answer so a closed gate is not a 503.
fn not_found_empty() -> Response {
    let mut response = StatusCode::NOT_FOUND.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn doorbell_dto(
    connection_id: Uuid,
    projection: DoorbellProjection,
    registered_at_ms: i64,
) -> HostedDoorbellResponse {
    HostedDoorbellResponse {
        connection_id: connection_id.to_string(),
        url: projection.url,
        secret_masked: projection.secret_masked,
        registered_at_ms,
        last_fired_at_ms: projection.last_fired_at.map(epoch_ms),
        last_status: projection.last_status,
    }
}

async fn authorize(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    if active_workspace_role(conn, workspace_id, member_id)
        .await?
        .is_some_and(|role| role.is_admin())
    {
        Ok(Ok(()))
    } else {
        Ok(Err(ApiError::forbidden("workspace admin required")))
    }
}

async fn preauthorize(
    state: &AppState,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), ApiError> {
    let outcome = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { authorize(conn, workspace_id, member_id).await })
    })
    .await;
    settle_db("hosted_agent_doorbell.authorize", outcome)
}

async fn validate_url(state: &AppState, raw: &str) -> Result<OutboundUrl, ApiError> {
    let allow_http = state.webhook.allow_development_http;
    let url = momo_webhook::validated_url(raw, allow_http).map_err(url_error)?;
    momo_webhook::validated_resolved_addresses(&url, &SystemHostResolver)
        .await
        .map_err(url_error)?;
    Ok(url)
}

fn url_error(error: OutboundUrlError) -> ApiError {
    ApiError::bad_request(error.to_string())
}

/// `PUT /v1/workspaces/{ws}/hosted-agent-connections/{connection}/doorbell`
pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
    Json(request): Json<RegisterHostedDoorbellRequest>,
) -> Result<Response, ApiError> {
    if !state.webhook.doorbell_enabled {
        return Ok(not_found_empty());
    }
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    preauthorize(&state, workspace_id, member_id).await?;
    if request.secret.trim().len() > DOORBELL_SECRET_MAX_BYTES {
        return Err(ApiError::bad_request(
            "doorbell secret exceeds the sealed-box bound",
        ));
    }
    let url = validate_url(&state, &request.url).await?;
    let secret = request.secret.clone();
    let master_key = state
        .webhook
        .outbound_master_key_or(&state.jwt_secret)
        .to_string();
    let absolute = url.absolute.clone();

    let outcome = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                return Ok(Err(rejection));
            }
            match register_doorbell_in_tx(
                conn,
                workspace_id,
                connection_id,
                member_id,
                &absolute,
                &secret,
                &master_key,
            )
            .await?
            {
                Ok(projection) => {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "hosted_agent.doorbell.registered")
                            .by(member_id)
                            .target("hosted_agent_connection", connection_id)
                            .via_token(via_token)
                            .with_schema(
                                "momo.hosted_agent.doorbell.registered.v1",
                                json!({
                                    "host": url_host(&absolute),
                                    "secret_masked": projection.secret_masked,
                                }),
                            ),
                    )
                    .await?;
                    Ok(Ok(projection))
                }
                Err(DoorbellRegisterError::NotFound) => {
                    Ok(Err(ApiError::not_found("hosted connection not found")))
                }
                Err(DoorbellRegisterError::NotActive) => Ok(Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "doorbell requires an active hosted connection",
                ))),
                Err(DoorbellRegisterError::Seal(error)) => {
                    Ok(Err(ApiError::bad_request(error.to_string())))
                }
            }
        })
    })
    .await;

    let projection = settle_db("hosted_agent_doorbell.register", outcome)?;
    // registered_at is "now" from the insert; the projection does not carry it
    // separately because GET uses last_fired. Echo clock for the write response.
    Ok(no_store(
        StatusCode::OK,
        doorbell_dto(connection_id, projection, epoch_ms(chrono::Utc::now())),
    ))
}

/// `DELETE /v1/workspaces/{ws}/hosted-agent-connections/{connection}/doorbell`
pub async fn unregister(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, connection)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    if !state.webhook.doorbell_enabled {
        return Ok(not_found_empty());
    }
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let connection_id = path_uuid(&connection, "invalid hosted connection id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                return Ok(Err(rejection));
            }
            let Some(projection) =
                unregister_doorbell_in_tx(conn, workspace_id, connection_id).await?
            else {
                return Ok(Err(ApiError::not_found("doorbell is not registered")));
            };
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "hosted_agent.doorbell.unregistered")
                    .by(member_id)
                    .target("hosted_agent_connection", connection_id)
                    .via_token(via_token)
                    .with_schema(
                        "momo.hosted_agent.doorbell.unregistered.v1",
                        json!({
                            "host": url_host(&projection.url),
                        }),
                    ),
            )
            .await?;
            Ok(Ok(projection))
        })
    })
    .await;

    let projection = settle_db("hosted_agent_doorbell.unregister", outcome)?;
    Ok(no_store(
        StatusCode::OK,
        doorbell_dto(connection_id, projection, epoch_ms(chrono::Utc::now())),
    ))
}

fn url_host(absolute: &str) -> String {
    momo_webhook::parse_outbound_url(absolute, true)
        .map(|url| url.host)
        .unwrap_or_else(|_| "unknown".to_string())
}
