//! Password surfaces for #1767.
//!
//! ```text
//! POST  /v1/workspaces/{ws}/members/{member}/password-reset   owner/admin
//! PATCH /v1/workspaces/{ws}/members/me/password               self, current password
//! ```
//!
//! Reset links are operator-mediated and out-of-band (invite convention).
//! There is no mailer. The raw token leaves the server once in the 201 body.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{
    active_workspace_role, change_own_password_in_tx, issue_password_reset_in_tx,
    mint_owner_claim_token, normalized_claim_password, IssuedPasswordReset, PasswordChangeMutation,
    PasswordResetIssueError, Principal, CLAIM_KIND_PASSWORD_RESET,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::get_member;
use uuid::Uuid;

use crate::dto::{ChangePasswordRequest, LoginResponse, MemberDto, PasswordResetClaimResponse};
use crate::error::ApiError;
use crate::rate_limit::client_ip;
use crate::routes::auth_routes::{base_scopes, issue_and_record_session};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

fn spec_password(raw: &str) -> Result<String, ApiError> {
    normalized_claim_password(raw).map_err(|error| ApiError::bad_request(error.to_string()))
}

fn admit_password_change(
    state: &AppState,
    headers: &HeaderMap,
    member_id: Uuid,
) -> Result<(), ApiError> {
    let config = &state.rate_limit.config;
    let member_key = format!("pwchange:member:{member_id}");
    let ip = client_ip(headers, None);
    let ip_key = ip.as_ref().map(|addr| format!("pwchange:ip:{addr}"));
    let mut checks: Vec<(&str, u32)> = Vec::new();
    if config.password_change_per_member_limit > 0 {
        checks.push((&member_key, config.password_change_per_member_limit));
    }
    if let Some(ref key) = ip_key {
        if config.password_change_per_ip_limit > 0 {
            checks.push((key.as_str(), config.password_change_per_ip_limit));
        }
    }
    if checks.is_empty() {
        return Ok(());
    }
    let verdicts = state
        .rate_limit
        .limiter
        .check_many(&checks, Duration::from_secs(config.window_seconds));
    if verdicts.iter().any(|verdict| !verdict.allowed) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit exceeded",
        ));
    }
    Ok(())
}

/// Invite management is workspace authority (ADR-0128).
async fn require_admin(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    Ok(match role {
        Some(role) if role.is_admin() => Ok(()),
        Some(_) => Err(ApiError::forbidden("workspace admin required")),
        None => Err(ApiError::forbidden("not a workspace member")),
    })
}

pub async fn issue_password_reset(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, member)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor_id = principal.member_id;
    let target_id = path_uuid(&member, "invalid member id")?;
    let via_token = audit_via_token_id(&principal);
    let token = mint_owner_claim_token()
        .map_err(|error| ApiError::internal("password_reset.entropy", error))?;

    let outcome: DbRejectable<IssuedPasswordReset> = agent_tenant_tx(&state.pool, workspace_id, {
        let token = token.clone();
        move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_admin(conn, workspace_id, actor_id).await? {
                    return Ok(Err(rejection));
                }
                match issue_password_reset_in_tx(conn, workspace_id, actor_id, target_id, &token)
                    .await?
                {
                    Ok(issued) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "member.password_reset.issued")
                                .by(actor_id)
                                .target("credential_claim", issued.claim_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.member.password_reset.issued.v1",
                                    serde_json::json!({
                                        "member_id": issued.member_id.to_string()
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(issued))
                    }
                    Err(PasswordResetIssueError::NotFound) => {
                        Ok(Err(ApiError::not_found("workspace member not found")))
                    }
                    Err(PasswordResetIssueError::NotHuman) => Ok(Err(ApiError::bad_request(
                        "password reset is for human members",
                    ))),
                    Err(PasswordResetIssueError::NotActive) => Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "member is not active",
                    ))),
                    Err(PasswordResetIssueError::Forbidden) => {
                        Ok(Err(ApiError::forbidden("password reset not permitted")))
                    }
                }
            })
        }
    })
    .await;

    let issued = settle_db("password_reset.issue", outcome)?;
    Ok((
        StatusCode::CREATED,
        Json(PasswordResetClaimResponse {
            token: issued.token,
            kind: CLAIM_KIND_PASSWORD_RESET,
            expires_at_ms: issued.expires_at_ms,
            claim_path: format!("/claim/{token}"),
        }),
    )
        .into_response())
}

pub async fn change_own_password(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    require_human(&principal, "only a human member can change a password")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    admit_password_change(&state, &headers, member_id)?;

    let current = spec_password(&request.current_password)?;
    let new_password = spec_password(&request.new_password)?;
    if current == new_password {
        return Err(ApiError::bad_request("new password must be different"));
    }
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<PasswordChangeMutation> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let mutation = change_own_password_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &current,
                    &new_password,
                )
                .await?;
                if let PasswordChangeMutation::Applied { sessions_revoked } = mutation {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "member.password_changed")
                            .by(member_id)
                            .target("member", member_id)
                            .via_token(via_token)
                            .with_schema(
                                "momo.member.password_changed.v1",
                                serde_json::json!({
                                    "sessions_revoked": sessions_revoked.to_string()
                                }),
                            ),
                    )
                    .await?;
                }
                Ok(Ok(mutation))
            })
        })
        .await;

    match settle_db("password.change", outcome)? {
        PasswordChangeMutation::CurrentMismatch => {
            return Err(ApiError::forbidden("current password is incorrect"));
        }
        PasswordChangeMutation::NoPassword => {
            return Err(ApiError::new(StatusCode::CONFLICT, "no password to change"));
        }
        PasswordChangeMutation::Applied { .. } => {}
    }

    let member = momo_db::with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { get_member(conn, member_id).await })
    })
    .await
    .map_err(|error| crate::error::db_error("password.change.member", error))?
    .ok_or_else(|| ApiError::forbidden("not a workspace member"))?;

    let (access, refresh) = issue_and_record_session(
        &state,
        workspace_id,
        member_id,
        base_scopes(),
        "password.change.session",
    )
    .await?;

    Ok(Json(LoginResponse {
        access_token: access.token,
        refresh_token: refresh.token,
        member: MemberDto {
            id: member.id.to_string(),
            workspace_id: member.workspace_id.to_string(),
            kind: member.kind.as_db_label().to_string(),
            display_name: member.display_name,
            handle: member.handle,
        },
        realtime_web_socket_url: state.advertised_realtime_ws_url(&headers, uri.scheme_str())?,
    }))
}
