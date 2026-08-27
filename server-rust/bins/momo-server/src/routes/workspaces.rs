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
//! **B4.2 adds the write B4.1 deliberately left out**: `POST /v1/workspaces`,
//! tenant provisioning (`settings/api.ts:389`, `createWorkspace`). B4.1's note
//! said provisioning "must not arrive as a side effect of a read batch" — this
//! is the batch that owns it, and it arrives with the instance-operator gate
//! (MOMO-583) the surface has always required.
//!
//! Still absent: `PATCH /v1/workspaces/{ws}` (the rename write). The web client
//! does not call it — it is not among the 68 measured pairs — so it stays
//! recorded as open rather than shipping on the strength of the DTO alone.
//!
//! **403 vs 404 is a contract, not a detail.** A live workspace the caller is
//! not in answers 403; a workspace that does not exist answers 404. Collapsing
//! them would leave a client unable to tell a stale bookmark from a permissions
//! problem — and the pair is safe here because the route already required the
//! path workspace to equal the credential's before asking anything.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{
    active_workspace_role, read_workspace_for_active_member, WorkspaceIdentity, WorkspaceRead,
    WorkspaceRole,
};
use momo_settings::{
    create_workspace_in_tx, lock_membership_mutation, normalized_workspace_name,
    normalized_workspace_slug, revoke_member_tokens_in_tx, terminate_workspace_membership_in_tx,
    workspace_has_another_active_owner, WorkspaceProvisionRejected,
};

use crate::dto::{
    CreateWorkspaceRequest, CreateWorkspaceResponse, MembershipLifecycleResponse, WorkspaceDto,
    WorkspaceResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, require_instance_operator, settle_db,
    workspace_scope, DbRejectable,
};
use crate::AppState;

fn workspace_dto(workspace: &WorkspaceIdentity) -> WorkspaceDto {
    WorkspaceDto {
        id: workspace.id.to_string(),
        slug: workspace.slug.clone(),
        name: workspace.name.clone(),
        updated_at_ms: workspace.updated_at_ms,
        // The content path with the media id as an immutable version token
        // (ADR-0161 D5). It changes on replacement, so a cached avatar is never
        // stale; absent when the workspace has no avatar (rail shows the initial).
        avatar_url: workspace.avatar_media_id.map(|media_id| {
            format!(
                "/v1/workspaces/{}/avatar/content?v={}",
                workspace.id, media_id
            )
        }),
        role_labels: workspace.role_labels.clone(),
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

/// `POST /v1/workspaces` — provision a tenant (Swift `WorkspaceRoutes.create`,
/// MOMO-589 / ADR-0117 §D1-A).
///
/// **Gated on the instance operator, not on workspace ownership.** Provisioning
/// mints a tenant on the shared instance, so it reuses the same MOMO-583
/// authority as the instance-global provider link: a `platform:read` token, or a
/// workspace owner/admin whose verified email is listed in
/// `PLATFORM_ADMIN_EMAILS`. An ordinary workspace owner cannot create tenants,
/// which is the whole reason the split exists.
///
/// The new workspace is seeded with the operator's own identity as its owner
/// (same email, same password hash, copied inside SQL) plus a `#general` channel
/// — so the caller can log into the result immediately instead of receiving an
/// id they have no way to enter.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> Result<Response, ApiError> {
    require_instance_operator(&state, &principal).await?;

    let slug = normalized_workspace_slug(&request.slug)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let name = normalized_workspace_name(&request.name)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;

    let operator_workspace = principal.workspace_id;
    let operator_member = principal.member_id;

    // One transaction provisions the whole tenant. It opens under the operator's
    // home workspace so the identity snapshot passes RLS, then rebinds
    // `app.workspace_id` to the NEW workspace for every seed INSERT.
    let outcome: DbRejectable<momo_settings::CreatedWorkspace> =
        agent_tenant_tx(&state.pool, operator_workspace, move |conn| {
            Box::pin(async move {
                let created = match create_workspace_in_tx(
                    conn,
                    operator_workspace,
                    operator_member,
                    &slug,
                    &name,
                )
                .await?
                {
                    Ok(created) => created,
                    Err(WorkspaceProvisionRejected::OperatorMissing) => {
                        return Ok(Err(ApiError::forbidden("operator account not found")))
                    }
                    Err(WorkspaceProvisionRejected::SlugTaken) => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "workspace slug already exists",
                        )))
                    }
                };

                // Attributed to the NEW owner inside the NEW workspace — the GUC
                // is already rebound, and an audit row must live in the tenant it
                // describes. `via_token_id` stays NULL because the authorizing
                // token belongs to a different workspace and the FK would reject
                // it; the acting operator is named in `detail` instead.
                write_audit(
                    conn,
                    &AuditEntry::new(created.workspace_id, "workspace.created")
                        .by(created.owner_member_id)
                        .target("workspace", created.workspace_id)
                        .via_token(None)
                        .with_schema(
                            "momo.workspace.created.v1",
                            serde_json::json!({
                                "slug": created.slug,
                                "default_channel": "general",
                                "source": "momo-rest",
                                "created_by_workspace_id": operator_workspace.to_string(),
                                "created_by_member_id": operator_member.to_string(),
                            }),
                        ),
                )
                .await?;
                Ok(Ok(created))
            })
        })
        .await;

    let created = settle_db("workspaces.create", outcome)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateWorkspaceResponse {
            schema: "momo.workspace.created.v1",
            workspace_id: created.workspace_id.to_string(),
            slug: created.slug,
            name: created.name,
        }),
    )
        .into_response())
}

/// `DELETE /v1/workspaces/{ws}/members/me` — self-leave (ADR-0161 D4, Swift
/// `MemberLifecycleRoutes.leaveWorkspace`).
///
/// The last owner cannot leave: ownership must transfer first, so a workspace is
/// never orphaned. That refusal is a **409** (a precondition violation), distinct
/// from a non-member's 403 — and distinct in copy from *channel* leave, which is
/// the lower-scoped act (D4, "혼동 금지").
///
/// Every rejection is produced BEFORE the first write, because the tenant-tx's
/// `Ok(Err(_))` channel commits (shared.rs `DbRejectable`): the advisory lock,
/// the role read, and the last-owner check all run first, then the deletes.
pub async fn leave(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<MembershipLifecycleResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    // Only a person resigns from a workspace; an agent is operated, not a member
    // who leaves (parity with Swift `requireHumanPrincipal`).
    require_human(&principal, "only a human member can leave a workspace")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let outcome: DbRejectable<MembershipLifecycleResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // First statement: serialize against concurrent membership
                // mutations so two owners cannot both pass the last-owner check.
                lock_membership_mutation(conn, workspace_id).await?;

                // The workspace is the caller's own (workspace_scope enforced it),
                // so a missing membership means they already left: 403, not 404.
                let role = match active_workspace_role(conn, workspace_id, member_id).await? {
                    Some(role) => role,
                    None => return Ok(Err(ApiError::forbidden("not a workspace member"))),
                };
                if role == WorkspaceRole::Owner
                    && !workspace_has_another_active_owner(conn, workspace_id, member_id).await?
                {
                    return Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "workspace must retain at least one owner",
                    )));
                }

                // Past every refusal: now write.
                let revoked = revoke_member_tokens_in_tx(conn, workspace_id, member_id).await?;
                terminate_workspace_membership_in_tx(conn, workspace_id, member_id).await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "workspace.left")
                        .by(member_id)
                        .target("member", member_id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.workspace.member_left.v1",
                            serde_json::json!({
                                "old": "active",
                                "new": "deleted",
                                "tokens_revoked": revoked.total.to_string(),
                                "agent_credentials_revoked": revoked.agent_bearers.to_string(),
                            }),
                        ),
                )
                .await?;
                Ok(Ok(MembershipLifecycleResponse {
                    member_id: member_id.to_string(),
                    status: "deleted".to_string(),
                }))
            })
        })
        .await;

    Ok(Json(settle_db("workspaces.leave", outcome)?))
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
                avatar_media_id: None,
                role_labels: serde_json::json!({}),
            }),
        })
        .expect("serialize");
        assert!(json.get("workspace").is_some(), "{json}");
        assert_eq!(json["workspace"]["slug"], "momo");
        assert_eq!(json["workspace"]["name"], "모모");
        assert_eq!(json["workspace"]["updatedAtMs"], 1_700_000_000_123_i64);
        // No avatar → the key is absent, not null (skip_serializing_if).
        assert!(json["workspace"].get("avatarUrl").is_none(), "{json}");
        assert_eq!(json["workspace"]["roleLabels"], serde_json::json!({}));
        assert!(
            json["workspace"].get("settings").is_none(),
            "identity must not grow a settings bag: {json}"
        );
    }

    /// A set avatar surfaces as a versioned content path — the `?v={media}` is
    /// what makes the cached bytes immutable and busts on replacement (D5).
    #[test]
    fn a_set_avatar_is_a_versioned_content_path() {
        let dto = workspace_dto(&WorkspaceIdentity {
            id: Uuid::from_u128(1),
            slug: "momo".into(),
            name: "모모".into(),
            updated_at_ms: 1_700_000_000_123,
            avatar_media_id: Some(Uuid::from_u128(42)),
            role_labels: serde_json::json!({"owner": "마스터"}),
        });
        let url = dto.avatar_url.expect("avatar url present");
        assert!(url.starts_with("/v1/workspaces/"), "{url}");
        assert!(url.contains("/avatar/content?v="), "{url}");
        assert!(url.ends_with(&Uuid::from_u128(42).to_string()), "{url}");
        assert_eq!(dto.role_labels, serde_json::json!({"owner": "마스터"}));
    }
}
