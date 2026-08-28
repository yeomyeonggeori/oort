//! ADR-0128 D2/D3 — workspace/channel role, suspend, remove, bans, channel leave.
//!
//! Swift `MemberLifecycleRoutes`. Authorization is judged in
//! `momo_settings::membership_lifecycle` inside the tenant transaction; this
//! file maps those outcomes onto Swift's HTTP sentences.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{Principal, WorkspaceRole};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    change_channel_role_in_tx, change_workspace_role_in_tx, create_workspace_ban_in_tx,
    delete_workspace_ban_in_tx, leave_channel_in_tx, list_workspace_bans_in_tx,
    normalize_ban_identity, remove_workspace_member_in_tx, set_member_status_in_tx, BanRecord,
    MembershipLifecycleError, StatusTransition,
};

use crate::dto::{
    ChangeMembershipRoleRequest, ChannelLeaveResponse, CreateWorkspaceBanRequest,
    MembershipLifecycleResponse, MembershipRoleResponse, RemoveWorkspaceMemberRequest,
    WorkspaceBanDto, WorkspaceBanListResponse, WorkspaceBanResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

fn lifecycle_http(error: MembershipLifecycleError) -> ApiError {
    let message = error.as_swift_message();
    match error {
        MembershipLifecycleError::MemberNotFound
        | MembershipLifecycleError::ChannelMembershipNotFound
        | MembershipLifecycleError::BanNotFound => ApiError::not_found(message),
        MembershipLifecycleError::LastOwner
        | MembershipLifecycleError::StatusMustBe(_)
        | MembershipLifecycleError::BanExists => ApiError::new(StatusCode::CONFLICT, message),
        MembershipLifecycleError::InvalidEmail
        | MembershipLifecycleError::InvalidHandle
        | MembershipLifecycleError::EmailOrHandleRequired => ApiError::bad_request(message),
        MembershipLifecycleError::InvalidStoredRole => {
            ApiError::internal("membership_lifecycle.stored_role", message)
        }
        MembershipLifecycleError::AgentRoleImmutable => ApiError::forbidden(message),
        _ => ApiError::forbidden(message),
    }
}

fn parse_role(raw: &str) -> Result<WorkspaceRole, ApiError> {
    WorkspaceRole::parse(raw)
        .ok_or_else(|| ApiError::bad_request("role must be owner, admin, member, or guest"))
}

fn ban_dto(ban: BanRecord) -> WorkspaceBanDto {
    WorkspaceBanDto {
        id: ban.id.to_string(),
        email: ban.email,
        handle: ban.handle,
        created_by: ban.created_by.to_string(),
        reason: ban.reason,
        created_at_ms: ban.created_at_ms,
    }
}

/// `PATCH /v1/workspaces/{ws}/members/{member}/role`
pub async fn change_workspace_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, member)): Path<(String, String)>,
    Json(request): Json<ChangeMembershipRoleRequest>,
) -> Result<Json<MembershipRoleResponse>, ApiError> {
    require_human(&principal, "membership management requires a human member")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let target_id = path_uuid(&member, "invalid member id")?;
    let requested = parse_role(&request.role)?;
    let actor_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MembershipRoleResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match change_workspace_role_in_tx(
                    conn,
                    workspace_id,
                    actor_id,
                    target_id,
                    requested,
                )
                .await?
                {
                    Ok(applied) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "role.changed")
                                .by(actor_id)
                                .about(target_id)
                                .target("workspace_membership", applied.membership_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.membership.role_changed.v1",
                                    serde_json::json!({
                                        "scope": "workspace",
                                        "old": applied.old_role.as_db_label(),
                                        "new": applied.new_role.as_db_label(),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(MembershipRoleResponse {
                            member_id: target_id.to_string(),
                            scope: "workspace".to_string(),
                            role: applied.new_role.as_db_label().to_string(),
                        }))
                    }
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    Ok(Json(settle_db(
        "membership.change_workspace_role",
        outcome,
    )?))
}

/// `PATCH /v1/workspaces/{ws}/channels/{ch}/members/{member}/role`
pub async fn change_channel_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, member)): Path<(String, String, String)>,
    Json(request): Json<ChangeMembershipRoleRequest>,
) -> Result<Json<MembershipRoleResponse>, ApiError> {
    require_human(&principal, "membership management requires a human member")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let target_id = path_uuid(&member, "invalid member id")?;
    let requested = parse_role(&request.role)?;
    let actor_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MembershipRoleResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match change_channel_role_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    actor_id,
                    target_id,
                    requested,
                )
                .await?
                {
                    Ok(applied) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "role.changed")
                                .by(actor_id)
                                .about(target_id)
                                .target("membership", applied.membership_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.membership.role_changed.v1",
                                    serde_json::json!({
                                        "scope": "channel",
                                        "channel_id": applied.channel_id.to_string(),
                                        "old": applied.old_role.as_db_label(),
                                        "new": applied.new_role.as_db_label(),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(MembershipRoleResponse {
                            member_id: target_id.to_string(),
                            scope: "channel".to_string(),
                            role: applied.new_role.as_db_label().to_string(),
                        }))
                    }
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    Ok(Json(settle_db("membership.change_channel_role", outcome)?))
}

/// `POST /v1/workspaces/{ws}/members/{member}/suspend`
pub async fn suspend(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, member)): Path<(String, String)>,
) -> Result<Json<MembershipLifecycleResponse>, ApiError> {
    set_status(
        state,
        principal,
        workspace,
        member,
        StatusTransition::Suspend,
    )
    .await
}

/// `POST /v1/workspaces/{ws}/members/{member}/reinstate`
pub async fn reinstate(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, member)): Path<(String, String)>,
) -> Result<Json<MembershipLifecycleResponse>, ApiError> {
    set_status(
        state,
        principal,
        workspace,
        member,
        StatusTransition::Reinstate,
    )
    .await
}

async fn set_status(
    state: AppState,
    principal: Principal,
    workspace: String,
    member: String,
    transition: StatusTransition,
) -> Result<Json<MembershipLifecycleResponse>, ApiError> {
    require_human(&principal, "membership management requires a human member")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let target_id = path_uuid(&member, "invalid member id")?;
    let actor_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MembershipLifecycleResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match set_member_status_in_tx(conn, workspace_id, actor_id, target_id, transition)
                    .await?
                {
                    Ok(applied) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, transition.action())
                                .by(actor_id)
                                .about(target_id)
                                .target("member", target_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.membership.status.v1",
                                    serde_json::json!({
                                        "old": applied.old_status,
                                        "new": applied.new_status,
                                        "tokens_revoked": applied.revoked.total.to_string(),
                                        "agent_credentials_revoked":
                                            applied.revoked.agent_bearers.to_string(),
                                        "credentials_restored": "false",
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(MembershipLifecycleResponse {
                            member_id: target_id.to_string(),
                            status: applied.new_status,
                        }))
                    }
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    Ok(Json(settle_db("membership.set_status", outcome)?))
}

/// `DELETE /v1/workspaces/{ws}/members/{member}`
pub async fn remove(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, member)): Path<(String, String)>,
    request: Option<Json<RemoveWorkspaceMemberRequest>>,
) -> Result<Json<MembershipLifecycleResponse>, ApiError> {
    require_human(&principal, "membership management requires a human member")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let target_id = path_uuid(&member, "invalid member id")?;
    let body = request.map(|Json(body)| body).unwrap_or_default();
    let ban = body.ban;
    let reason = body.reason;
    let actor_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MembershipLifecycleResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match remove_workspace_member_in_tx(
                    conn,
                    workspace_id,
                    actor_id,
                    target_id,
                    ban,
                    reason.as_deref(),
                )
                .await?
                {
                    Ok(applied) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "member.removed")
                                .by(actor_id)
                                .about(target_id)
                                .target("member", target_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.membership.removed.v1",
                                    serde_json::json!({
                                        "old": applied.old_status,
                                        "new": "deleted",
                                        "ban": if applied.banned { "true" } else { "false" },
                                        "tokens_revoked": applied.revoked.total.to_string(),
                                        "agent_credentials_revoked":
                                            applied.revoked.agent_bearers.to_string(),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(MembershipLifecycleResponse {
                            member_id: target_id.to_string(),
                            status: "deleted".to_string(),
                        }))
                    }
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    Ok(Json(settle_db("membership.remove", outcome)?))
}

/// `POST /v1/workspaces/{ws}/bans`
pub async fn create_ban(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateWorkspaceBanRequest>,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let (email, handle) =
        normalize_ban_identity(request.email.as_deref(), request.handle.as_deref())
            .map_err(lifecycle_http)?;
    let reason = request.reason;
    let actor_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<BanRecord> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match create_workspace_ban_in_tx(
                    conn,
                    workspace_id,
                    actor_id,
                    email.as_deref(),
                    handle.as_deref(),
                    reason.as_deref(),
                )
                .await?
                {
                    Ok(ban) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "ban.created")
                                .by(actor_id)
                                .about_optional(None)
                                .target("workspace_ban", ban.id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.membership.ban.v1",
                                    serde_json::json!({
                                        "email": ban.email.clone().unwrap_or_default(),
                                        "handle": ban.handle.clone().unwrap_or_default(),
                                        "reason": ban.reason.clone().unwrap_or_default(),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(ban))
                    }
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    let ban = settle_db("membership.create_ban", outcome)?;
    Ok((
        StatusCode::CREATED,
        Json(WorkspaceBanResponse { ban: ban_dto(ban) }),
    )
        .into_response())
}

/// `GET /v1/workspaces/{ws}/bans`
pub async fn list_bans(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<WorkspaceBanListResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor_id = principal.member_id;

    let outcome: DbRejectable<Vec<BanRecord>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match list_workspace_bans_in_tx(conn, workspace_id, actor_id).await? {
                    Ok(bans) => Ok(Ok(bans)),
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    let bans = settle_db("membership.list_bans", outcome)?;
    Ok(Json(WorkspaceBanListResponse {
        bans: bans.into_iter().map(ban_dto).collect(),
    }))
}

/// `DELETE /v1/workspaces/{ws}/bans/{ban}`
pub async fn delete_ban(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, ban)): Path<(String, String)>,
) -> Result<Json<WorkspaceBanResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let ban_id = path_uuid(&ban, "invalid ban id")?;
    let actor_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<BanRecord> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match delete_workspace_ban_in_tx(conn, workspace_id, actor_id, ban_id).await? {
                    Ok(ban) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "ban.deleted")
                                .by(actor_id)
                                .about_optional(None)
                                .target("workspace_ban", ban_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.membership.ban.v1",
                                    serde_json::json!({
                                        "email": ban.email.clone().unwrap_or_default(),
                                        "handle": ban.handle.clone().unwrap_or_default(),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(ban))
                    }
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    let ban = settle_db("membership.delete_ban", outcome)?;
    Ok(Json(WorkspaceBanResponse { ban: ban_dto(ban) }))
}

/// `DELETE /v1/workspaces/{ws}/channels/{ch}/members/me`
pub async fn leave_channel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Json<ChannelLeaveResponse>, ApiError> {
    require_human(&principal, "membership management requires a human member")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<ChannelLeaveResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match leave_channel_in_tx(conn, workspace_id, channel_id, member_id).await? {
                    Ok(applied) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "channel.left")
                                .by(member_id)
                                .target("channel", channel_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.membership.channel_left.v1",
                                    serde_json::json!({
                                        "kind": applied.kind,
                                        "membership_id": applied.membership_id.to_string(),
                                        "archived": applied.archived.to_string(),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(ChannelLeaveResponse {
                            channel_id: channel_id.to_string(),
                            member_id: member_id.to_string(),
                            archived: applied.archived,
                        }))
                    }
                    Err(error) => Ok(Err(lifecycle_http(error))),
                }
            })
        })
        .await;

    Ok(Json(settle_db("membership.leave_channel", outcome)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swift_error_sentences_are_closed() {
        assert_eq!(
            lifecycle_http(MembershipLifecycleError::CannotManageSelf).message,
            "members cannot manage themselves"
        );
        assert_eq!(
            lifecycle_http(MembershipLifecycleError::LastOwner).status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            lifecycle_http(MembershipLifecycleError::DirectMessageLeaveForbidden).message,
            "direct message channels cannot be left"
        );
        let agent_role = lifecycle_http(MembershipLifecycleError::AgentRoleImmutable);
        assert_eq!(agent_role.message, "agent roles are fixed to member");
        assert_eq!(agent_role.status, StatusCode::FORBIDDEN);
    }
}
