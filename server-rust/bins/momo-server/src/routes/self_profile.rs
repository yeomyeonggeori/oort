//! Self member profile writes — BZ-4e (#1873) + ADR-0185 E2 (#2331).
//!
//! ```text
//! PATCH /v1/workspaces/{ws}/members/me    {"displayName"?, "handle"?}
//! ```
//!
//! Human only. Agent display names stay on the agent profile path; the
//! middleware already refuses an agent bearer that is not on the allow-list
//! (`agent bearer is not allowed for this route`), and [`require_human`] is the
//! handler-level backstop so a later allow-list slip cannot widen this surface.
//! Display-name normalization is [`momo_settings::normalized_join_display_name`]
//! — the same function join uses — so a 400 here is the same sentence a 400
//! there is. Handle normalization is [`momo_settings::normalized_requested_handle`];
//! `member_handle_uniq` collisions answer join's `HandleTaken` sentence (409).
//!
//! Past message bodies that contain `@<old handle>` are **not rewritten**. A
//! handle is a roster identity going forward, not a search-replace over history.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use momo_messaging::{
    change_own_handle_in_tx, rename_own_display_name_in_tx, HandleChangeRejected, HandleRename,
};
use momo_settings::{
    is_handle_unique_violation, normalized_join_display_name, normalized_requested_handle,
    JoinRejection,
};

use crate::dto::{MemberDto, RenameSelfMemberRequest, SelfMemberResponse};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// Human-only, stated once. An agent's name is its profile, not this path.
const AGENTS_USE_THE_PROFILE_PATH: &str =
    "only a human member can change their display name or handle";

fn member_dto(member: momo_messaging::Member) -> MemberDto {
    MemberDto {
        id: member.id.to_string(),
        workspace_id: member.workspace_id.to_string(),
        kind: member.kind.as_db_label().to_string(),
        display_name: member.display_name,
        handle: member.handle,
    }
}

/// Load-bearing 409. Sabotage: drop the `member_handle_uniq` arm and the
/// taken-handle test must go RED — Postgres would otherwise surface as 500
/// after the aborted tenant transaction.
fn handle_taken(error: DbError) -> ApiError {
    match &error {
        DbError::Sqlx(sqlx_error) if is_handle_unique_violation(sqlx_error) => {
            ApiError::new(StatusCode::CONFLICT, JoinRejection::HandleTaken.to_string())
        }
        _ => ApiError::internal("member.change_handle", error),
    }
}

/// `PATCH /v1/workspaces/{ws}/members/me` — the caller's own display name and/or
/// handle. At least one field is required.
pub async fn rename_self(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RenameSelfMemberRequest>,
) -> Result<Json<SelfMemberResponse>, ApiError> {
    require_human(&principal, AGENTS_USE_THE_PROFILE_PATH)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let display_name = match request.display_name {
        Some(raw) => Some(
            normalized_join_display_name(&raw)
                .map_err(|error| ApiError::bad_request(error.to_string()))?,
        ),
        None => None,
    };
    let handle = match request.handle.as_deref() {
        Some(raw) => Some(
            normalized_requested_handle(Some(raw))
                .map_err(|error| ApiError::bad_request(error.to_string()))?
                .expect("Some(raw) never yields Ok(None)"),
        ),
        None => None,
    };
    if display_name.is_none() && handle.is_none() {
        return Err(ApiError::bad_request("displayName or handle is required"));
    }
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<SelfMemberResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let mut member = None;
                if let Some(display_name) = display_name.as_deref() {
                    match rename_own_display_name_in_tx(conn, workspace_id, member_id, display_name)
                        .await?
                    {
                        Some(applied) => {
                            write_audit(
                                conn,
                                &AuditEntry::new(workspace_id, "member.renamed")
                                    .by(member_id)
                                    .target("member", member_id)
                                    .via_token(via_token)
                                    .with_schema(
                                        "momo.member.renamed.v1",
                                        serde_json::json!({
                                            "old": applied.previous_display_name,
                                            "new": applied.member.display_name,
                                        }),
                                    ),
                            )
                            .await?;
                            member = Some(applied.member);
                        }
                        None => {
                            return Ok(Err(ApiError::forbidden(
                                "not a live member of this workspace",
                            )))
                        }
                    }
                }
                if let Some(handle) = handle.as_deref() {
                    let applied: HandleRename =
                        match change_own_handle_in_tx(conn, workspace_id, member_id, handle).await?
                        {
                            Ok(Some(applied)) => applied,
                            Ok(None) => {
                                return Ok(Err(ApiError::forbidden(
                                    "not a live member of this workspace",
                                )))
                            }
                            Err(HandleChangeRejected::Banned) => {
                                return Ok(Err(ApiError::forbidden(
                                    JoinRejection::Banned.to_string(),
                                )))
                            }
                        };
                    if applied.previous_handle != applied.member.handle {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "member.handle_changed")
                                .by(member_id)
                                .target("member", member_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.member.handle_changed.v1",
                                    serde_json::json!({
                                        "old": applied.previous_handle,
                                        "new": applied.member.handle,
                                    }),
                                ),
                        )
                        .await?;
                    }
                    member = Some(applied.member);
                }
                let member = member.expect("at least one field was set");
                Ok(Ok(SelfMemberResponse {
                    member: member_dto(member),
                }))
            })
        })
        .await;

    let outcome = match outcome {
        Err(error) => return Err(handle_taken(error)),
        other => other,
    };

    Ok(Json(settle_db("member.rename_self", outcome)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use momo_auth::PrincipalKind;
    use uuid::Uuid;

    fn principal(kind: PrincipalKind) -> Principal {
        Principal {
            member_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            token_id: Some(Uuid::from_u128(3)),
            scopes: vec![],
            kind,
        }
    }

    #[test]
    fn an_agent_principal_is_refused_before_any_write() {
        let error = require_human(
            &principal(PrincipalKind::Agent),
            AGENTS_USE_THE_PROFILE_PATH,
        )
        .expect_err("403");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.message, AGENTS_USE_THE_PROFILE_PATH);
        assert!(require_human(
            &principal(PrincipalKind::Human),
            AGENTS_USE_THE_PROFILE_PATH
        )
        .is_ok());
    }

    #[test]
    fn handle_taken_reuses_the_join_sentence() {
        assert_eq!(
            JoinRejection::HandleTaken.to_string(),
            "handle is already in use"
        );
        assert_eq!(JoinRejection::HandleTaken.status_code(), 409);
        assert_eq!(
            JoinRejection::Banned.to_string(),
            "member is banned from this workspace"
        );
        assert_eq!(JoinRejection::Banned.status_code(), 403);
    }

    #[test]
    fn display_name_rejection_reuses_the_join_sentence() {
        use momo_settings::JoinSpecInvalid;
        assert_eq!(
            normalized_join_display_name("")
                .expect_err("empty")
                .to_string(),
            JoinSpecInvalid::DisplayName.to_string()
        );
        assert_eq!(
            JoinSpecInvalid::DisplayName.to_string(),
            "displayName is required"
        );
        assert_eq!(
            normalized_join_display_name(&"모".repeat(101))
                .expect_err("too long")
                .to_string(),
            "displayName is required"
        );
        assert_eq!(
            normalized_join_display_name("  곽성재  ").expect("trim"),
            "곽성재"
        );
    }
}
