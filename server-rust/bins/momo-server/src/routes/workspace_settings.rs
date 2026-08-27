//! Workspace shared-settings bag (#1800).
//!
//! ```text
//! GET|PATCH  /v1/workspaces/{ws}/settings          owner/admin
//! ```
//!
//! The bag is operator-only. Members who need one key get a derived projection
//! (see `allowed-models`). `GET /v1/workspaces/{ws}` stays untouched.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    merge_workspace_settings, read_workspace_settings, write_workspace_settings,
    WorkspaceSettingsInvalid,
};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, require_workspace_operator, settle_db,
    workspace_scope, DbRejectable,
};
use crate::AppState;

fn rejection(error: WorkspaceSettingsInvalid) -> ApiError {
    if error.is_payload_too_large() {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, error.to_string())
    } else {
        ApiError::bad_request(error.to_string())
    }
}

fn as_object(settings: Option<Value>) -> Value {
    match settings {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    }
}

/// `GET /v1/workspaces/{ws}/settings`
pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_human(&principal, "workspace settings require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_workspace_operator(&state, &principal, workspace_id).await?;
    let outcome: DbRejectable<Value> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            match read_workspace_settings(conn, workspace_id).await? {
                Some(settings) => Ok(Ok(as_object(Some(settings)))),
                None => Ok(Err(ApiError::not_found("workspace not found"))),
            }
        })
    })
    .await;
    Ok(Json(settle_db("workspace.settings.get", outcome)?))
}

/// `PATCH /v1/workspaces/{ws}/settings`
pub async fn patch(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_human(&principal, "workspace settings require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_workspace_operator(&state, &principal, workspace_id).await?;
    let member_id = principal.member_id;
    let via = audit_via_token_id(&principal);
    let patch_keys: Vec<String> = request
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    let outcome: DbRejectable<Value> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let existing = match read_workspace_settings(conn, workspace_id).await? {
                Some(settings) => as_object(Some(settings)),
                None => return Ok(Err(ApiError::not_found("workspace not found"))),
            };
            let merged = match merge_workspace_settings(&existing, &request) {
                Ok(merged) => merged,
                Err(error) => return Ok(Err(rejection(error))),
            };
            let Some(stored) = write_workspace_settings(conn, workspace_id, &merged).await? else {
                return Ok(Err(ApiError::not_found("workspace not found")));
            };
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "workspace_setting.updated")
                    .by(member_id)
                    .via_token(via)
                    .with_schema(
                        "momo.workspace_setting.updated.v1",
                        json!({ "keys": patch_keys }),
                    ),
            )
            .await?;
            Ok(Ok(as_object(Some(stored))))
        })
    })
    .await;
    Ok(Json(settle_db("workspace.settings.patch", outcome)?))
}
