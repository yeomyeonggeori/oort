//! The 티어 정책 surface — ADR-0125 D11 (B4.2, diff-matrix D-3).
//!
//! ```text
//! GET|PUT /v1/workspaces/{ws}/work-tier-policy       workspace default (owner/admin)
//! GET|PUT /v1/workspaces/{ws}/work-tier-policy/me    the caller's own override
//! ```
//!
//! Ports Swift `Routes/WorkTierPolicyRoutes.swift`. Client:
//! `clients/web/src/features/settings/api.ts:279-336`.
//!
//! The two scopes are **not** the same route with a flag, and the difference is
//! authorization, not shape: the workspace default is owner/admin because it
//! decides where everyone's work runs, while `/me` is any active human because a
//! member may always speak for themselves — and only for themselves. `/me` never
//! reads a member id from the request; it takes the credential's, so there is no
//! spelling of this API that edits someone else's override.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    load_tier_policy, tier_target_allowed, upsert_tier_policy, validated_auto_target,
    validated_tier_mode, TierPolicy, TierScope,
};
use uuid::Uuid;

use crate::dto::{PutWorkTierPolicyRequest, WorkTierPolicyDto, WorkTierPolicyResponse};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

fn policy_dto(workspace_id: Uuid, policy: TierPolicy) -> WorkTierPolicyDto {
    WorkTierPolicyDto {
        workspace_id: workspace_id.to_string(),
        member_id: policy.member_id.map(|id| id.to_string()),
        mode: policy.mode,
        auto_target: policy.auto_target,
        inherited: policy.inherited,
        updated_at_ms: policy.updated_at_ms,
    }
}

pub async fn get_workspace_default(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<String>,
) -> Result<Json<WorkTierPolicyResponse>, ApiError> {
    read(state, principal, path, false).await
}

pub async fn get_member_override(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<String>,
) -> Result<Json<WorkTierPolicyResponse>, ApiError> {
    read(state, principal, path, true).await
}

pub async fn put_workspace_default(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<String>,
    body: Json<PutWorkTierPolicyRequest>,
) -> Result<Json<WorkTierPolicyResponse>, ApiError> {
    write(state, principal, path, body, false).await
}

pub async fn put_member_override(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<String>,
    body: Json<PutWorkTierPolicyRequest>,
) -> Result<Json<WorkTierPolicyResponse>, ApiError> {
    write(state, principal, path, body, true).await
}

async fn read(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    member_override: bool,
) -> Result<Json<WorkTierPolicyResponse>, ApiError> {
    require_human(&principal, "work tier policy requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let scope = if member_override {
        TierScope::Member(member_id)
    } else {
        TierScope::Workspace
    };

    let outcome: DbRejectable<TierPolicy> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) =
                    authorize(conn, workspace_id, member_id, member_override).await?
                {
                    return Ok(Err(rejection));
                }
                Ok(Ok(load_tier_policy(conn, workspace_id, scope).await?))
            })
        })
        .await;

    let policy = settle_db("work_tier_policy.get", outcome)?;
    Ok(Json(WorkTierPolicyResponse {
        work_tier_policy: policy_dto(workspace_id, policy),
    }))
}

async fn write(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PutWorkTierPolicyRequest>,
    member_override: bool,
) -> Result<Json<WorkTierPolicyResponse>, ApiError> {
    require_human(&principal, "work tier policy requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    // Shape first, outside the transaction: an invalid mode or a target sent in
    // the wrong mode is a 400 and never reaches a lock.
    let mode = validated_tier_mode(&request.mode)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let auto_target = validated_auto_target(request.auto_target.as_deref(), mode)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;

    let scope = if member_override {
        TierScope::Member(member_id)
    } else {
        TierScope::Workspace
    };

    let outcome: DbRejectable<TierPolicy> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) =
                    authorize(conn, workspace_id, member_id, member_override).await?
                {
                    return Ok(Err(rejection));
                }
                // The registry check takes `FOR SHARE` on the host row, so the
                // host cannot be revoked between this check and the write.
                if let Err(rejected) =
                    tier_target_allowed(conn, workspace_id, scope, auto_target.as_deref()).await?
                {
                    return Ok(Err(ApiError::new(
                        axum::http::StatusCode::CONFLICT,
                        rejected.to_string(),
                    )));
                }

                let saved =
                    upsert_tier_policy(conn, workspace_id, scope, mode, auto_target.as_deref())
                        .await?;
                let entry = AuditEntry::new(workspace_id, "work.tier_policy.changed")
                    .by(member_id)
                    // The subject is whose policy changed: the member for an
                    // override, nobody in particular for the workspace default.
                    .about_optional(saved.member_id)
                    .via_token(via_token)
                    .with_schema(
                        "momo.work_tier_policy.changed.v1",
                        serde_json::json!({
                            "scope": scope.as_str(),
                            "mode": saved.mode,
                            "auto_target": saved.auto_target,
                        }),
                    );
                write_audit(conn, &entry).await?;
                Ok(Ok(saved))
            })
        })
        .await;

    let policy = settle_db("work_tier_policy.put", outcome)?;
    Ok(Json(WorkTierPolicyResponse {
        work_tier_policy: policy_dto(workspace_id, policy),
    }))
}

/// The scope's authorization, run inside the caller's transaction.
///
/// * workspace default → owner/admin (Swift `requireWorkspaceAdmin` :314-324);
/// * `/me` → an active workspace membership (Swift `requireActiveHuman`
///   :326-354). `active_workspace_role` is the single membership authority, and
///   it already joins `member.status = 'active' AND deleted_at IS NULL` — so a
///   suspended member's surviving `workspace_membership` row does not authorize.
async fn authorize(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    member_override: bool,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    Ok(if member_override {
        match role {
            Some(_) => Ok(()),
            None => Err(ApiError::forbidden("active human membership required")),
        }
    } else {
        match role {
            Some(role) if role.is_admin() => Ok(()),
            _ => Err(ApiError::forbidden(
                "workspace tier policy requires owner or admin",
            )),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspace_default_row_carries_no_member_id() {
        let json = serde_json::to_value(WorkTierPolicyResponse {
            work_tier_policy: policy_dto(
                Uuid::from_u128(1),
                TierPolicy {
                    member_id: None,
                    mode: "ask".into(),
                    auto_target: None,
                    inherited: false,
                    updated_at_ms: None,
                },
            ),
        })
        .expect("serialize");
        assert!(json.get("workTierPolicy").is_some(), "{json}");
        assert!(
            json["workTierPolicy"].get("memberId").is_none(),
            "an omitted memberId is how the client tells the default row apart"
        );
        assert_eq!(json["workTierPolicy"]["inherited"], false);
        assert!(json["workTierPolicy"].get("autoTarget").is_none());
    }

    /// `inherited: true` is the sentence "no override exists"; it must survive
    /// serialization or the panel claims a saved choice nobody made.
    #[test]
    fn an_inherited_member_read_says_so_on_the_wire() {
        let member = Uuid::from_u128(7);
        let json = serde_json::to_value(policy_dto(
            Uuid::from_u128(1),
            TierPolicy {
                member_id: Some(member),
                mode: "auto".into(),
                auto_target: Some("cloud".into()),
                inherited: true,
                updated_at_ms: Some(1_700_000_000_123),
            },
        ))
        .expect("serialize");
        assert_eq!(json["inherited"], true);
        assert_eq!(json["memberId"], member.to_string());
        assert_eq!(json["autoTarget"], "cloud");
        assert_eq!(json["updatedAtMs"], 1_700_000_000_123_i64);
    }
}
