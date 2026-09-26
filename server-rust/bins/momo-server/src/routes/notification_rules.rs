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
//!
//! 증보 2 (#2850): `dndUntilMs` gives the pause an expiry, judged lazily by the
//! notifier. A PUT that changes the pause breaks a declared-DND bundle (see
//! `momo_messaging::notification_rule`), so ending DND later never overwrites
//! what the member chose here.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{
    get_notification_rule_in_tx, set_notification_rule_in_tx, NotificationRule,
    NotificationRuleUpdate, StatusPatch,
};

use crate::dto::{NotificationRulesResponse, OptionalPatch, UpdateNotificationRulesRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

fn rules_response(rule: NotificationRule) -> NotificationRulesResponse {
    NotificationRulesResponse {
        dnd: rule.dnd,
        dnd_until_ms: rule.dnd_until.map(|at| at.timestamp_millis()),
        mention_overrides_mute: rule.mention_overrides_mute,
    }
}

/// Parse a wire expiry patch (`dndUntilMs`, here and on `PUT /presence`).
/// A value must be a representable instant strictly after `now` — a past
/// expiry would store a pause that is already over, which a client meant as
/// "on" and would read back as "off".
pub(crate) fn parse_until_patch(
    field: &str,
    raw: &OptionalPatch<i64>,
    now: DateTime<Utc>,
) -> Result<StatusPatch<DateTime<Utc>>, ApiError> {
    match raw {
        OptionalPatch::Absent => Ok(StatusPatch::Absent),
        OptionalPatch::Set(None) => Ok(StatusPatch::Set(None)),
        OptionalPatch::Set(Some(ms)) => {
            let at = DateTime::from_timestamp_millis(*ms)
                .ok_or_else(|| ApiError::bad_request(format!("invalid {field}")))?;
            if at <= now {
                return Err(ApiError::bad_request(format!(
                    "{field} must be in the future"
                )));
            }
            Ok(StatusPatch::Set(Some(at)))
        }
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
    let rule = NotificationRuleUpdate {
        dnd: request.dnd,
        // `dnd = false` clears the expiry whatever was sent, so a stale timer in
        // an "off" body is not a 400.
        dnd_until: if request.dnd {
            parse_until_patch("dndUntilMs", &request.dnd_until_ms, Utc::now())?
        } else {
            StatusPatch::Set(None)
        },
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
                                "dnd_until_ms": saved.dnd_until.map(|at| at.timestamp_millis()),
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
            dnd_until: None,
            mention_overrides_mute: false,
        }))
        .expect("serialize");
        assert_eq!(json["dnd"], true);
        assert_eq!(json["dndUntilMs"], serde_json::Value::Null);
        assert_eq!(json["mentionOverridesMute"], false);
    }

    #[test]
    fn a_timed_pause_answers_its_expiry_in_ms() {
        let until = DateTime::from_timestamp_millis(1_800_000_000_000).expect("ms");
        let json = serde_json::to_value(rules_response(NotificationRule {
            dnd: true,
            dnd_until: Some(until),
            mention_overrides_mute: false,
        }))
        .expect("serialize");
        assert_eq!(json["dndUntilMs"], 1_800_000_000_000i64);
    }

    #[test]
    fn the_expiry_patch_is_omitted_null_or_a_future_instant() {
        let now = DateTime::from_timestamp_millis(1_000_000).expect("ms");
        assert_eq!(
            parse_until_patch("dndUntilMs", &OptionalPatch::Absent, now).expect("absent"),
            StatusPatch::Absent
        );
        assert_eq!(
            parse_until_patch("dndUntilMs", &OptionalPatch::Set(None), now).expect("null"),
            StatusPatch::Set(None)
        );
        assert_eq!(
            parse_until_patch("dndUntilMs", &OptionalPatch::Set(Some(1_000_001)), now)
                .expect("future"),
            StatusPatch::Set(DateTime::from_timestamp_millis(1_000_001))
        );
        for past in [1_000_000, 0] {
            let error = parse_until_patch("dndUntilMs", &OptionalPatch::Set(Some(past)), now)
                .expect_err("past is refused");
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(error.message, "dndUntilMs must be in the future");
        }
        assert!(parse_until_patch("dndUntilMs", &OptionalPatch::Set(Some(i64::MAX)), now).is_err());
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
        assert!(matches!(parsed.dnd_until_ms, OptionalPatch::Absent));

        let timed: UpdateNotificationRulesRequest = serde_json::from_value(
            serde_json::json!({"dnd": true, "mentionOverridesMute": false, "dndUntilMs": 5}),
        )
        .expect("parse timed");
        assert!(matches!(timed.dnd_until_ms, OptionalPatch::Set(Some(5))));
        let open: UpdateNotificationRulesRequest = serde_json::from_value(
            serde_json::json!({"dnd": true, "mentionOverridesMute": false, "dndUntilMs": null}),
        )
        .expect("parse open");
        assert!(matches!(open.dnd_until_ms, OptionalPatch::Set(None)));

        // A future switch must not be silently swallowed before it exists.
        assert!(serde_json::from_value::<UpdateNotificationRulesRequest>(
            serde_json::json!({"dnd": false, "mentionOverridesMute": false, "keyword": "x"})
        )
        .is_err());
    }
}
