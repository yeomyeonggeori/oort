//! Password surfaces for #1767.
//!
//! ```text
//! POST  /v1/workspaces/{ws}/members/{member}/password-reset   owner/admin
//! PATCH /v1/workspaces/{ws}/members/me/password               self, current password
//! ```
//!
//! Reset links are operator-mediated and out-of-band (invite convention).
//! There is no mailer. The raw token leaves the server once in the 201 body.
//!
//! ## The change is one transaction, under the workspace's membership lock (#4636)
//!
//! The standing check, the current-password check, the new hash, the sweep of the
//! member's sessions, the audit row and the new session's pair are **one tenant
//! transaction** whose first statement takes the workspace's membership lock
//! **exclusively** ([`lock_membership_mutation`]) — the lock a suspension, removal or
//! departure takes. The doors that sign someone in (login, join) hold it shared, so a
//! sign-in in flight finishes first and its pair is swept with the rest, or starts after
//! the change and reads the new password: the sweep never runs between a sign-in's checks
//! and its recording. A suspension that overlaps a change waits for its commit and
//! revokes the pair it recorded; one that committed first is found **inside** the lock
//! (the middleware judged the bearer before the lock was had, and a request can be
//! waiting for the lock while the member is suspended), which refuses the change before
//! anything is written.
//!
//! Lock order: membership lock → `human` row → member-wide sweep lock → `token` rows.
//! The membership lock is always first. The operator's reissue (`issue_password_reset`)
//! takes it first too, exclusively: it locks a member row and then that member's open link,
//! the opposite order of a claim that spends the link and then needs the member row for its
//! audit row, so without the shared first lock the two could wait for each other. Row locks
//! that a foreign key takes (an `audit_log` or `token` insert needs the member row) are not
//! part of this order: transactions that start with the membership lock are serialized by it
//! and cannot meet there, and the paths that do not start with it (token rotation, linking a
//! device) are not covered by this change.

use std::time::Duration;

use crate::session_end::end_member_sessions_in_tx;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::IssuedToken;
use momo_auth::{
    active_workspace_role, change_own_password_in_tx, issue_password_reset_in_tx,
    mint_owner_claim_token, normalized_current_password, normalized_new_password,
    IssuedPasswordReset, PasswordChangeMutation, PasswordResetIssueError, Principal,
    CLAIM_KIND_PASSWORD_RESET,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{get_member, Member, RevocationCause};
use momo_settings::lock_membership_mutation;
use uuid::Uuid;

use crate::dto::{ChangePasswordRequest, LoginResponse, MemberDto, PasswordResetClaimResponse};
use crate::error::ApiError;
use crate::rate_limit::client_ip;
use crate::routes::auth_routes::{base_scopes, mint_and_record_session_in_tx};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

/// The password the caller *proves* (ADR-0215 D2): present and bounded, and
/// nothing more — an account whose password predates the new length rule must
/// still be able to change it. The password the caller *chooses* goes through
/// [`normalized_new_password`] and answers `password_too_short` /
/// `password_too_long`.
fn spec_current_password(raw: &str) -> Result<String, ApiError> {
    normalized_current_password(raw).map_err(|error| ApiError::bad_request(error.to_string()))
}

pub(crate) fn admit_password_change(
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
                // The membership lock, exclusive and first, like every other transaction that
                // locks member rows to change what a member can do: a reissue locks the target's
                // member row and then the target's open link, and the claim that spends that link
                // holds the link and then needs the member row (its audit row references it). Two
                // transactions that take those rows in opposite orders wait for each other until
                // the database ends one of them; behind this lock they cannot meet.
                lock_membership_mutation(conn, workspace_id).await?;
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

/// What the change transaction decided, mapped to HTTP outside it.
enum PasswordChanged {
    /// The current password did not match, or there is none: nothing was written.
    Refused(PasswordChangeMutation),
    /// The password is changed, the member's other sessions are swept, and the caller's
    /// new pair is recorded — in the same transaction that holds the membership lock.
    Applied {
        member: Member,
        access: IssuedToken,
        refresh: IssuedToken,
    },
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

    let current = spec_current_password(&request.current_password)?;
    let new_password = normalized_new_password(&request.new_password)?;
    if current == new_password {
        return Err(ApiError::bad_request("new password must be different"));
    }
    let via_token = audit_via_token_id(&principal);
    let jwt_secret = state.jwt_secret.clone();

    let outcome: DbRejectable<PasswordChanged> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The membership lock, exclusive and first (see the module docs).
                lock_membership_mutation(conn, workspace_id).await?;
                // The standing is read under the lock and before the first write: the
                // bearer was judged before the lock was had, and a suspension or removal
                // that committed in between has already revoked it.
                let Some(member) = get_member(conn, member_id).await? else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                if member.status != "active" {
                    return Ok(Err(ApiError::forbidden("member is not active")));
                }
                let mutation = change_own_password_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &current,
                    &new_password,
                )
                .await?;
                let PasswordChangeMutation::Applied { sessions_revoked } = mutation else {
                    return Ok(Ok(PasswordChanged::Refused(mutation)));
                };
                // The change revoked every session of the member (the caller gets a
                // fresh one below); every phone registered under them stops receiving
                // pushes now (#2677).
                end_member_sessions_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    RevocationCause::PasswordChanged,
                )
                .await?;
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
                // The new session's pair, on THIS connection and after the sweep above, so
                // the sweep cannot take it and a suspension that follows can.
                let (access, refresh) = mint_and_record_session_in_tx(
                    conn,
                    &jwt_secret,
                    workspace_id,
                    member_id,
                    base_scopes(),
                )
                .await?;
                Ok(Ok(PasswordChanged::Applied {
                    member,
                    access,
                    refresh,
                }))
            })
        })
        .await;

    let (member, access, refresh) = match settle_db("password.change", outcome)? {
        PasswordChanged::Refused(PasswordChangeMutation::CurrentMismatch) => {
            return Err(ApiError::forbidden("current password is incorrect"));
        }
        PasswordChanged::Refused(PasswordChangeMutation::NoPassword) => {
            return Err(ApiError::new(StatusCode::CONFLICT, "no password to change"));
        }
        PasswordChanged::Refused(PasswordChangeMutation::Applied { .. }) => {
            return Err(ApiError::internal(
                "password.change.unexpected_applied",
                "applied mapped as a refusal",
            ));
        }
        PasswordChanged::Applied {
            member,
            access,
            refresh,
        } => (member, access, refresh),
    };

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
