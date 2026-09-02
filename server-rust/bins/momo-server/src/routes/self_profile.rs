//! Self member profile writes — BZ-4e (#1873).
//!
//! ```text
//! PATCH /v1/workspaces/{ws}/members/me    {"displayName": string}
//! ```
//!
//! Human only. Agent display names stay on the agent profile path; the
//! middleware already refuses an agent bearer that is not on the allow-list
//! (`agent bearer is not allowed for this route`), and [`require_human`] is the
//! handler-level backstop so a later allow-list slip cannot widen this surface.
//! Normalization is [`momo_settings::normalized_join_display_name`] — the same
//! function join uses — so a 400 here is the same sentence a 400 there is.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::rename_own_display_name_in_tx;
use momo_settings::normalized_join_display_name;

use crate::dto::{MemberDto, RenameSelfMemberRequest, SelfMemberResponse};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// Human-only, stated once. An agent's name is its profile, not this path.
const AGENTS_USE_THE_PROFILE_PATH: &str = "only a human member can change their display name";

/// `PATCH /v1/workspaces/{ws}/members/me` — the caller's own display name.
pub async fn rename_self(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RenameSelfMemberRequest>,
) -> Result<Json<SelfMemberResponse>, ApiError> {
    require_human(&principal, AGENTS_USE_THE_PROFILE_PATH)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let display_name = normalized_join_display_name(&request.display_name)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<SelfMemberResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match rename_own_display_name_in_tx(conn, workspace_id, member_id, &display_name)
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
                        Ok(Ok(SelfMemberResponse {
                            member: MemberDto {
                                id: applied.member.id.to_string(),
                                workspace_id: applied.member.workspace_id.to_string(),
                                kind: applied.member.kind.as_db_label().to_string(),
                                display_name: applied.member.display_name,
                                handle: applied.member.handle,
                            },
                        }))
                    }
                    None => Ok(Err(ApiError::forbidden(
                        "not a live member of this workspace",
                    ))),
                }
            })
        })
        .await;

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
