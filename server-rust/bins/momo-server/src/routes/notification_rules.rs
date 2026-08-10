//! 알림 규칙 (ADR-0124 증보 1) — the member-global notification rules surface.
//!
//! ```text
//! GET|PUT /v1/workspaces/{ws}/notification-rules    the caller's own rules
//! ```
//!
//! This is the second input to the P9 notifier judgment. 018's
//! `PUT …/channels/{ch}/notification-pref` silences ONE channel; this silences
//! (DND) or re-opens (mention exception) across the whole workspace for the
//! signed-in member. Client: `clients/web/src/features/settings/NotificationRulesSection.tsx`
//! via `packages/momo-core/src/features/settings/notificationRules.ts`.
//!
//! Like `work-tier-policy/me`, the scope is the caller and only the caller: the
//! member id is the credential's, never the request's, so there is no spelling of
//! this API that edits another member's rules. Authorization is an active
//! workspace membership (a human may always speak for themselves), not owner or
//! admin — these are personal preferences, not a workspace policy.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{get_notification_rule_in_tx, set_notification_rule_in_tx, NotificationRule};

use crate::dto::{NotificationRulesResponse, UpdateNotificationRulesRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

fn rules_response(rule: NotificationRule) -> NotificationRulesResponse {
    NotificationRulesResponse {
        dnd: rule.dnd,
        mention_overrides_mute: rule.mention_overrides_mute,
    }
}

/// `GET /v1/workspaces/{ws}/notification-rules` — the caller's effective rules.
/// No stored row answers as both `false` (the pre-증보 default).
pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<NotificationRulesResponse>, ApiError> {
    require_human(&principal, "notification rules require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<NotificationRule> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                Ok(Ok(get_notification_rule_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                )
                .await?))
            })
        })
        .await;

    let rule = settle_db("notification_rules.get", outcome)?;
    Ok(Json(rules_response(rule)))
}

/// `PUT /v1/workspaces/{ws}/notification-rules` — replace the caller's rules.
pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<UpdateNotificationRulesRequest>,
) -> Result<Json<NotificationRulesResponse>, ApiError> {
    require_human(&principal, "notification rules require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let rule = NotificationRule {
        dnd: request.dnd,
        mention_overrides_mute: request.mention_overrides_mute,
    };

    let outcome: DbRejectable<NotificationRule> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                let saved =
                    set_notification_rule_in_tx(conn, workspace_id, member_id, rule).await?;
                // Same transaction as the write, so an audit row can never record
                // a rule change that rolled back (`momo_db::audit` docs).
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "notification_rule.updated")
                        .by(member_id)
                        .about(member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.notification_rule.updated.v1",
                            serde_json::json!({
                                "dnd": saved.dnd,
                                "mention_overrides_mute": saved.mention_overrides_mute,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await;

    let rule = settle_db("notification_rules.put", outcome)?;
    Ok(Json(rules_response(rule)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_response_is_the_two_flags_in_camel_case() {
        let json = serde_json::to_value(rules_response(NotificationRule {
            dnd: true,
            mention_overrides_mute: false,
        }))
        .expect("serialize");
        assert_eq!(json["dnd"], true);
        assert_eq!(json["mentionOverridesMute"], false);
    }

    #[test]
    fn an_absent_row_defaults_to_both_off() {
        let json =
            serde_json::to_value(rules_response(NotificationRule::default())).expect("serialize");
        assert_eq!(json["dnd"], false);
        assert_eq!(json["mentionOverridesMute"], false);
    }

    #[test]
    fn the_request_parses_both_flags_and_rejects_extras() {
        let parsed: UpdateNotificationRulesRequest =
            serde_json::from_value(serde_json::json!({"dnd": true, "mentionOverridesMute": true}))
                .expect("parse");
        assert!(parsed.dnd);
        assert!(parsed.mention_overrides_mute);

        // A future switch must not be silently swallowed before it exists.
        assert!(serde_json::from_value::<UpdateNotificationRulesRequest>(
            serde_json::json!({"dnd": false, "mentionOverridesMute": false, "keyword": "x"})
        )
        .is_err());
    }
}
