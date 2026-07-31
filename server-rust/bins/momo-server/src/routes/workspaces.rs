//! Workspace identity read (B4.1).
//!
//!   `GET /v1/workspaces/{ws}`
//!
//! Ports Swift `WorkspaceRoutes.get` (`WorkspaceRoutes.swift:259-286`). This is
//! the **settings panel's first read** (`clients/web/src/features/settings/api.ts:399`,
//! `fetchWorkspace`): the name at the top of the panel, and the `updatedAtMs`
//! token a later rename must present. Without it the whole settings surface
//! opens in an error state, which is what `docs/planning/2026-08-01-b4-contract-diff.md`
//! recorded as D-3.
//!
//! Deliberately absent from this batch: `POST /v1/workspaces` (tenant
//! provisioning — an instance-operator authority with its own allowlist model)
//! and `PATCH /v1/workspaces/{ws}` (the rename write). Both are real client
//! surfaces and both stay recorded as open gaps; neither is on the sequence this
//! batch had to unblock, and provisioning in particular must not arrive as a
//! side effect of a read batch.
//!
//! **403 vs 404 is a contract, not a detail.** A live workspace the caller is
//! not in answers 403; a workspace that does not exist answers 404. Collapsing
//! them would leave a client unable to tell a stale bookmark from a permissions
//! problem — and the pair is safe here because the route already required the
//! path workspace to equal the credential's before asking anything.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{read_workspace_for_active_member, WorkspaceIdentity, WorkspaceRead};

use crate::dto::{WorkspaceDto, WorkspaceResponse};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, settle_db, workspace_scope, DbRejectable};
use crate::AppState;

fn workspace_dto(workspace: &WorkspaceIdentity) -> WorkspaceDto {
    WorkspaceDto {
        id: workspace.id.to_string(),
        slug: workspace.slug.clone(),
        name: workspace.name.clone(),
        updated_at_ms: workspace.updated_at_ms,
    }
}

pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<WorkspaceResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let outcome: DbRejectable<WorkspaceIdentity> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match read_workspace_for_active_member(conn, workspace_id, principal.member_id)
                    .await?
                {
                    WorkspaceRead::Found(workspace) => Ok(Ok(workspace)),
                    WorkspaceRead::NotMember => {
                        Ok(Err(ApiError::forbidden("not a workspace member")))
                    }
                    WorkspaceRead::NotFound => Ok(Err(ApiError::not_found("workspace not found"))),
                }
            })
        })
        .await;

    let workspace = settle_db("workspaces.get", outcome)?;
    Ok(Json(WorkspaceResponse {
        workspace: workspace_dto(&workspace),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// `fetchWorkspace` throws when `res.workspace` is missing, so the envelope
    /// is load-bearing — and `updatedAtMs` must survive as a number, since the
    /// rename endpoint compares it for optimistic concurrency.
    #[test]
    fn the_response_keeps_its_envelope_and_its_concurrency_token() {
        let json = serde_json::to_value(WorkspaceResponse {
            workspace: workspace_dto(&WorkspaceIdentity {
                id: Uuid::from_u128(1),
                slug: "momo".into(),
                name: "모모".into(),
                updated_at_ms: 1_700_000_000_123,
            }),
        })
        .expect("serialize");
        assert!(json.get("workspace").is_some(), "{json}");
        assert_eq!(json["workspace"]["slug"], "momo");
        assert_eq!(json["workspace"]["name"], "모모");
        assert_eq!(json["workspace"]["updatedAtMs"], 1_700_000_000_123_i64);
    }
}
