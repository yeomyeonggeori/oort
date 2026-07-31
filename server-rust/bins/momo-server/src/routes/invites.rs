//! The 초대 surface (B4.2, diff-matrix D-3).
//!
//! ```text
//! GET  /v1/workspaces/{ws}/invites   owner/admin list
//! POST /v1/workspaces/{ws}/invites   owner/admin create → 201 with the raw code
//! ```
//!
//! Ports Swift `Routes/InviteRoutes.list` / `create`. Client:
//! `clients/web/src/features/settings/api.ts:442,449`.
//!
//! **The code leaves the server exactly once.** `POST` answers 201 with the raw
//! code; nothing else ever can, because the durable record is a sha256 written by
//! `momo_invite_code_hash()` inside the insert. `GET` therefore projects a
//! 6-character preview, which is enough to say "this row is that link I sent" and
//! not enough to redeem it.
//!
//! Not in this batch: `revoke`, `regenerate`, `redeem`, and the public
//! `POST /v1/join` that actually spends a code. The web client calls none of
//! them, so they stay recorded as open in the diff matrix rather than arriving
//! untested — and the PR body says so, because "you can mint an invite that
//! cannot yet be redeemed on this server" is exactly the kind of half-open door
//! an orchestrator must know about before shipping.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    clamp_invite_list_limit, create_invite, list_invites, normalized_invite_role,
    validated_expires_at_ms, validated_max_uses, InviteCode,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::dto::{CreateInviteRequest, CreateInviteResponse, InviteCodeDto, InviteListResponse};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
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
}
