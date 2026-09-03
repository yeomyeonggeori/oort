//! The 초대 surface (B4.2 + #1769).
//!
//! ```text
//! GET    /v1/workspaces/{ws}/invites              owner/admin list
//! POST   /v1/workspaces/{ws}/invites              owner/admin create → 201 + raw code
//! GET    /v1/workspaces/{ws}/invites/{invite}     owner/admin redeem status
//! DELETE /v1/workspaces/{ws}/invites/{invite}     owner/admin revoke (#1769 verb)
//! POST   /v1/workspaces/{ws}/invites/{invite}/revoke
//! POST   /v1/workspaces/{ws}/invites/{invite}/regenerate
//! POST   /v1/workspaces/{ws}/invites/redeem       member self-redeem
//! ```
//!
//! Ports Swift `Routes/InviteRoutes.swift`. Client create/list:
//! `clients/web/src/features/settings/api.ts:442,449`.
//!
//! **The code leaves the server exactly once per mint.** Create and regenerate
//! answer 201 with the raw code; nothing else ever can, because the durable
//! record is a sha256 written by `momo_invite_code_hash()` inside the statement.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    clamp_invite_list_limit, create_invite, list_invite_redemptions, list_invites,
    normalized_invite_code, normalized_invite_role, normalized_revoke_reason, read_invite,
    redeem_invite_for_member, regenerate_invite, revoke_invite, validated_expires_at_ms,
    validated_max_uses, InviteCode, InviteMutationInvalid, InviteRedeemInvalid, InviteRedemption,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::dto::{
    CreateInviteRequest, CreateInviteResponse, InviteCodeDto, InviteListResponse,
    InviteRedemptionDto, InviteStatusResponse, RedeemInviteRequest, RedeemInviteResponse,
    RevokeInviteRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

/// Swift reads both spellings of the flag (`InviteRoutes.swift:121`), and only
/// the literal `"true"` counts — the same `include_archived` convention the
/// channel list follows.
#[derive(Debug, Deserialize)]
pub struct InviteListQuery {
    #[serde(default)]
    include_revoked: Option<String>,
    #[serde(default, rename = "includeRevoked")]
    include_revoked_camel: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

impl InviteListQuery {
    fn include_revoked(&self) -> bool {
        self.include_revoked.as_deref() == Some("true")
            || self.include_revoked_camel.as_deref() == Some("true")
    }
}

fn invite_dto(invite: InviteCode) -> InviteCodeDto {
    InviteCodeDto {
        id: invite.id.to_string(),
        workspace_id: invite.workspace_id.to_string(),
        code_preview: invite.code_preview,
        role: invite.role,
        max_uses: invite.max_uses,
        used_count: invite.used_count,
        expires_at_ms: invite.expires_at_ms,
        revoked_at_ms: invite.revoked_at_ms,
        revoked_by: invite.revoked_by.map(|id| id.to_string()),
        revocation_reason: invite.revocation_reason,
        created_by: invite.created_by.to_string(),
        created_at_ms: invite.created_at_ms,
        updated_at_ms: invite.updated_at_ms,
    }
}

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<InviteListQuery>,
) -> Result<Json<InviteListResponse>, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let include_revoked = query.include_revoked();
    let limit = clamp_invite_list_limit(query.limit.as_deref());

    let outcome: DbRejectable<Vec<InviteCode>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                Ok(Ok(list_invites(conn, include_revoked, limit).await?))
            })
        })
        .await;

    let invites = settle_db("invites.list", outcome)?;
    Ok(Json(InviteListResponse {
        invites: invites.into_iter().map(invite_dto).collect(),
    }))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateInviteRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    // Shape first: a bad role, an out-of-range use count, or an expiry already in
    // the past never reaches a statement.
    let role = normalized_invite_role(request.role.as_deref())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let max_uses = validated_max_uses(request.max_uses)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let expires_at_ms =
        validated_expires_at_ms(request.expires_at_ms, chrono::Utc::now().timestamp_millis())
            .map_err(|error| ApiError::bad_request(error.to_string()))?;

    let outcome: DbRejectable<momo_settings::CreatedInvite> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let created =
                    create_invite(conn, workspace_id, role, max_uses, expires_at_ms, member_id)
                        .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "invite.created")
                        .by(member_id)
                        .target("invite_code", created.invite.id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.invite.created.v1",
                            // Role and reach only. Never the code, never its
                            // hash, never the preview — an audit row is read by
                            // more people than the response is.
                            serde_json::json!({"role": role, "max_uses": max_uses}),
                        ),
                )
                .await?;
                Ok(Ok(created))
            })
        })
        .await;

    let created = settle_db("invites.create", outcome)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateInviteResponse {
            invite: invite_dto(created.invite),
            code: created.code,
        }),
    )
        .into_response())
}

pub async fn get_one(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, invite)): Path<(String, String)>,
) -> Result<Json<InviteStatusResponse>, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let invite_id = path_uuid(&invite, "invalid invite id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<(InviteCode, Vec<InviteRedemption>)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(invite) = read_invite(conn, invite_id).await? else {
                    return Ok(Err(ApiError::not_found("invite code not found")));
                };
                let redemptions = list_invite_redemptions(conn, invite_id).await?;
                Ok(Ok((invite, redemptions)))
            })
        })
        .await;

    let (invite, redemptions) = settle_db("invites.get", outcome)?;
    Ok(Json(InviteStatusResponse {
        invite: invite_dto(invite),
        redemptions: redemptions.into_iter().map(redemption_dto).collect(),
    }))
}

pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, invite)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<InviteCodeDto>, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let invite_id = path_uuid(&invite, "invalid invite id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let reason = decode_revoke_reason(&body)?;
    let reason_for_sql = reason.clone();

    let outcome: DbRejectable<InviteCode> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let revoked =
                    match revoke_invite(conn, invite_id, member_id, reason_for_sql.as_deref())
                        .await?
                    {
                        Ok(revoked) => revoked,
                        Err(InviteMutationInvalid::NotFound) => {
                            return Ok(Err(ApiError::not_found(
                                InviteMutationInvalid::NotFound.to_string(),
                            )));
                        }
                        Err(InviteMutationInvalid::AlreadyConsumed) => {
                            return Ok(Err(ApiError::new(
                                StatusCode::CONFLICT,
                                InviteMutationInvalid::AlreadyConsumed.to_string(),
                            )));
                        }
                        Err(InviteMutationInvalid::NotFoundOrRevoked) => {
                            return Ok(Err(ApiError::new(
                                StatusCode::CONFLICT,
                                InviteMutationInvalid::NotFoundOrRevoked.to_string(),
                            )));
                        }
                    };
                if revoked.newly_revoked {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "invite.revoked")
                            .by(member_id)
                            .target("invite_code", invite_id)
                            .via_token(via_token)
                            .with_schema(
                                "momo.invite.revoked.v1",
                                serde_json::json!({"reason": reason_for_sql}),
                            ),
                    )
                    .await?;
                }
                Ok(Ok(revoked.invite))
            })
        })
        .await;

    let invite = settle_db("invites.revoke", outcome)?;
    Ok(Json(invite_dto(invite)))
}

pub async fn regenerate(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, invite)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let invite_id = path_uuid(&invite, "invalid invite id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<momo_settings::CreatedInvite> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_admin(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let created = match regenerate_invite(conn, invite_id, member_id).await? {
                    Ok(created) => created,
                    Err(error) => {
                        return Ok(Err(ApiError::new(StatusCode::CONFLICT, error.to_string())));
                    }
                };
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "invite.regenerated")
                        .by(member_id)
                        .target("invite_code", invite_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.invite.regenerated.v1",
                            serde_json::json!({
                                "new_invite_id": created.invite.id,
                                "role": created.invite.role,
                                "max_uses": created.invite.max_uses,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(created))
            })
        })
        .await;

    let created = settle_db("invites.regenerate", outcome)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateInviteResponse {
            invite: invite_dto(created.invite),
            code: created.code,
        }),
    )
        .into_response())
}

/// ADR-0181: redeem does not create a member, so it does not enqueue a welcome
/// kickoff. First-entry triggers are `POST /v1/join` (`createdMember: true`)
/// and owner-claim completion.
pub async fn redeem(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RedeemInviteRequest>,
) -> Result<Json<RedeemInviteResponse>, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let code = normalized_invite_code(&request.code)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let email = request
        .email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let outcome: DbRejectable<momo_settings::RedeemedInvite> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_member(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                match redeem_invite_for_member(
                    conn,
                    workspace_id,
                    member_id,
                    &code,
                    email.as_deref(),
                )
                .await?
                {
                    Ok(redeemed) => Ok(Ok(redeemed)),
                    Err(InviteRedeemInvalid::Banned) => Ok(Err(ApiError::forbidden(
                        InviteRedeemInvalid::Banned.to_string(),
                    ))),
                    Err(InviteRedeemInvalid::NotMember) => Ok(Err(ApiError::forbidden(
                        InviteRedeemInvalid::NotMember.to_string(),
                    ))),
                    Err(InviteRedeemInvalid::Unusable) => Ok(Err(ApiError::bad_request(
                        InviteRedeemInvalid::Unusable.to_string(),
                    ))),
                }
            })
        })
        .await;

    let redeemed = settle_db("invites.redeem", outcome)?;
    Ok(Json(RedeemInviteResponse {
        invite: invite_dto(redeemed.invite),
        redemption_id: redeemed.redemption_id.to_string(),
    }))
}

fn redemption_dto(row: InviteRedemption) -> InviteRedemptionDto {
    InviteRedemptionDto {
        id: row.id.to_string(),
        member_id: row.member_id.to_string(),
        email: row.email,
        redeemed_at_ms: row.redeemed_at_ms,
    }
}

fn decode_revoke_reason(body: &Bytes) -> Result<Option<String>, ApiError> {
    if body.is_empty() {
        return Ok(None);
    }
    let parsed: RevokeInviteRequest =
        serde_json::from_slice(body).map_err(|_| ApiError::bad_request("invalid revoke body"))?;
    Ok(normalized_revoke_reason(parsed.reason.as_deref()))
}

/// Invite management is workspace authority, not channel authority (ADR-0128) —
/// `active_workspace_role` is the single place that decides it.
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

/// Swift `requireWorkspaceMember` (:510-517) — any active membership, not admin.
async fn require_member(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    Ok(match role {
        Some(_) => Ok(()),
        None => Err(ApiError::forbidden("not a workspace member")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the literal `"true"` opens the revoked rows — `1`/`yes` do not, the
    /// same convention `include_archived` follows on the channel list.
    #[test]
    fn include_revoked_accepts_one_spelling_in_two_cases() {
        let query = |snake: Option<&str>, camel: Option<&str>| InviteListQuery {
            include_revoked: snake.map(str::to_string),
            include_revoked_camel: camel.map(str::to_string),
            limit: None,
        };
        assert!(query(Some("true"), None).include_revoked());
        assert!(query(None, Some("true")).include_revoked());
        assert!(!query(Some("1"), None).include_revoked());
        assert!(!query(Some("yes"), None).include_revoked());
        assert!(!query(None, None).include_revoked());
    }

    /// The preview is a recognition hint. The wire must never grow a field that
    /// could redeem the invite.
    #[test]
    fn the_projection_carries_a_preview_and_nothing_redeemable() {
        let json = serde_json::to_value(invite_dto(InviteCode {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            code_preview: "aB3-x9".into(),
            role: "member".into(),
            max_uses: 5,
            used_count: 1,
            expires_at_ms: 1_700_000_000_000,
            revoked_at_ms: None,
            revoked_by: None,
            revocation_reason: None,
            created_by: Uuid::from_u128(3),
            created_at_ms: 1_600_000_000_000,
            updated_at_ms: 1_600_000_000_000,
        }))
        .expect("serialize");
        assert_eq!(json["codePreview"], "aB3-x9");
        assert_eq!(json["usedCount"], 1);
        assert!(json.get("code").is_none(), "{json}");
        assert!(json.get("codeHash").is_none(), "{json}");
        assert!(
            json.get("revokedAtMs").is_none(),
            "a live invite omits the revocation trio rather than sending nulls"
        );
    }

    #[test]
    fn an_empty_revoke_body_is_a_revoke_with_no_reason() {
        assert_eq!(decode_revoke_reason(&Bytes::new()).expect("empty"), None);
        assert_eq!(
            decode_revoke_reason(&Bytes::from_static(b"{}")).expect("object"),
            None
        );
        assert_eq!(
            decode_revoke_reason(&Bytes::from_static(b"{\"reason\":\" leaked \"}"))
                .expect("reason")
                .as_deref(),
            Some("leaked")
        );
    }
}
