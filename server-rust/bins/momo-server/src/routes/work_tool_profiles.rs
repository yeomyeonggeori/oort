//! Work-tool catalog read (`WorkToolProfileRoutes.list`, ADR-0130 D3).
//!
//! `#1777` ports the **GET only**. `momo-workd` cannot stay up without it
//! (`Main.swift` fetches the catalog after heartbeat and treats a failure as
//! fatal). Create/update/delete stay unported — those are admin CRUD, not the
//! daemon loop.
//!
//! A signed work host sees the **enabled** projection. A human admin sees every
//! row. An agent is 403 (`work tool profiles require an admin or work host`).

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal, PrincipalKind};
use momo_db::sqlx;
use momo_db::sqlx::Row;
use serde_json::Value;
use uuid::Uuid;

use crate::dto::{WorkToolProfileDto, WorkToolProfilesResponse};
use crate::error::ApiError;
use crate::routes::shared::{require_human_or_work_host, settle, tenant_tx, workspace_scope};
use crate::AppState;

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<WorkToolProfilesResponse>, ApiError> {
    require_human_or_work_host(
        &principal,
        "work tool profiles require an admin or work host",
    )?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let host_signed = principal.kind == PrincipalKind::WorkHost;
    let member_id = principal.member_id;

    let profiles = settle(
        "work_tool_profiles.list",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !host_signed {
                    let role = active_workspace_role(conn, workspace_id, member_id).await?;
                    if !role.is_some_and(|role| role.is_admin()) {
                        return Ok(Err(ApiError::forbidden(
                            "work tool profiles require an admin or work host",
                        )));
                    }
                }
                let rows = sqlx::query(
                    "SELECT id, workspace_id, tool_key, display_name, \
                            launch_template, tier_defaults, env_policy, enabled, \
                            created_by, updated_by, \
                            (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms, \
                            (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms \
                       FROM work_tool_profile \
                      WHERE workspace_id = $1 \
                        AND ($2 OR enabled) \
                      ORDER BY tool_key",
                )
                .bind(workspace_id)
                // Human admin sees every row (`$2 = true`). A signed host sees
                // the enabled projection only (`$2 = false` → `AND enabled`).
                .bind(!host_signed)
                .fetch_all(&mut *conn)
                .await?;
                let mut profiles = Vec::with_capacity(rows.len());
                for row in rows {
                    profiles.push(WorkToolProfileDto {
                        id: row.try_get::<Uuid, _>("id")?.to_string(),
                        workspace_id: row.try_get::<Uuid, _>("workspace_id")?.to_string(),
                        tool_key: row.try_get("tool_key")?,
                        display_name: row.try_get("display_name")?,
                        launch_template: row.try_get::<Value, _>("launch_template")?,
                        tier_defaults: row.try_get::<Value, _>("tier_defaults")?,
                        env_policy: row.try_get::<Value, _>("env_policy")?,
                        enabled: row.try_get("enabled")?,
                        created_by: row.try_get::<Uuid, _>("created_by")?.to_string(),
                        updated_by: row.try_get::<Uuid, _>("updated_by")?.to_string(),
                        created_at_ms: row.try_get("created_at_ms")?,
                        updated_at_ms: row.try_get("updated_at_ms")?,
                    });
                }
                Ok(Ok(profiles))
            })
        })
        .await,
    )?;

    Ok(Json(WorkToolProfilesResponse {
        work_tool_profiles: profiles,
    }))
}
