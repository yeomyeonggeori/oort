//! 알림 규칙 (ADR-0124 증보 1) — the member-global notification rules surface.
//!
//! ```text
//! GET|PUT|PATCH /v1/workspaces/{ws}/notification-rules    the caller's own rules
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
//!
//! #3012: `PATCH` changes only the fields its body names, merged under the row
//! lock onto what is stored when the write lands. `PUT` stays for compatibility
//! (older clients), but a PUT is a whole snapshot: when the web panel and the
//! phone each PUT what they last read, the later one reverts the earlier one's
//! switch. New client code uses PATCH.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{
    get_notification_rule_in_tx, get_push_kinds_in_tx, patch_notification_rule_in_tx,
    patch_push_kinds_in_tx, set_notification_rule_in_tx, NotificationRule, NotificationRulePatch,
    NotificationRuleUpdate, PushKinds, PushKindsPatch, StatusPatch,
};

use crate::dto::{
    NotificationRulesResponse, OptionalPatch, PatchNotificationRulesRequest, PatchPushKindsRequest,
    PushKindsResponse, UpdateNotificationRulesRequest,
};
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

/// The PATCH body as a domain patch. An empty body is a 400: it would write an
/// audit row for a change nobody asked for.
fn patch_from_request(
    request: &PatchNotificationRulesRequest,
    now: DateTime<Utc>,
) -> Result<NotificationRulePatch, ApiError> {
    let patch = NotificationRulePatch {
        dnd: request.dnd,
        dnd_until: parse_until_patch("dndUntilMs", &request.dnd_until_ms, now)?,
        mention_overrides_mute: request.mention_overrides_mute,
    };
    if patch.is_empty() {
        return Err(ApiError::bad_request(
            "name at least one of dnd, dndUntilMs, mentionOverridesMute",
        ));
    }
    Ok(patch)
}

/// `PATCH /v1/workspaces/{ws}/notification-rules` — change only the named
/// fields of the caller's rules (#3012).
pub async fn patch(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PatchNotificationRulesRequest>,
) -> Result<Json<NotificationRulesResponse>, ApiError> {
    require_human(&principal, "notification rules require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let patch = patch_from_request(&request, Utc::now())?;
    let fields: Vec<&'static str> = [
        patch.dnd.map(|_| "dnd"),
        (patch.dnd_until != StatusPatch::Absent).then_some("dndUntilMs"),
        patch.mention_overrides_mute.map(|_| "mentionOverridesMute"),
    ]
    .into_iter()
    .flatten()
    .collect();

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
                    patch_notification_rule_in_tx(conn, workspace_id, member_id, patch).await?;
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
                                // Which fields the request named (#3012).
                                "patched": fields,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await;

    let rule = settle_db("notification_rules.patch", outcome)?;
    Ok(Json(rules_response(rule)))
}

// ---------------------------------------------------------------------------
// push kinds (ADR-0120 부록 A, #3341)
// ---------------------------------------------------------------------------

fn push_kinds_response(kinds: PushKinds) -> PushKindsResponse {
    PushKindsResponse {
        work_complete: kinds.work_complete,
    }
}

/// `GET /v1/workspaces/{ws}/notification-rules/push-kinds` — which kinds of push
/// the caller wants. No stored row answers every kind on.
pub async fn get_push_kinds(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<PushKindsResponse>, ApiError> {
    require_human(&principal, "notification rules require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<PushKinds> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                Ok(Ok(
                    get_push_kinds_in_tx(conn, workspace_id, member_id).await?
                ))
            })
        })
        .await;
    let kinds = settle_db("notification_rules.push_kinds.get", outcome)?;
    Ok(Json(push_kinds_response(kinds)))
}

/// `PATCH /v1/workspaces/{ws}/notification-rules/push-kinds` — change only the
/// named switches. Self-scoped like the rest of this module: the member is the
/// credential's, so there is no spelling that edits someone else's switches.
pub async fn patch_push_kinds(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PatchPushKindsRequest>,
) -> Result<Json<PushKindsResponse>, ApiError> {
    require_human(&principal, "notification rules require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let patch = PushKindsPatch {
        work_complete: request.work_complete,
    };
    if patch.is_empty() {
        return Err(ApiError::bad_request("name at least one of workComplete"));
    }

    let outcome: DbRejectable<PushKinds> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                let saved = patch_push_kinds_in_tx(conn, workspace_id, member_id, patch).await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "notification_rule.push_kinds.updated")
                        .by(member_id)
                        .about(member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.notification_rule.push_kinds.updated.v1",
                            serde_json::json!({ "work_complete": saved.work_complete }),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await;
    let kinds = settle_db("notification_rules.push_kinds.patch", outcome)?;
    Ok(Json(push_kinds_response(kinds)))
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
    fn push_kinds_answer_camel_case_and_default_on() {
        let json = serde_json::to_value(push_kinds_response(PushKinds::default())).expect("json");
        assert_eq!(json, serde_json::json!({"workComplete": true}));
        assert!(serde_json::from_value::<PatchPushKindsRequest>(
            serde_json::json!({"workComplete": false, "keyword": "x"})
        )
        .is_err());
        let empty: PatchPushKindsRequest =
            serde_json::from_value(serde_json::json!({})).expect("ok");
        assert!(PushKindsPatch {
            work_complete: empty.work_complete
        }
        .is_empty());
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

    #[test]
    fn a_patch_names_only_what_it_changes_and_an_empty_one_is_refused() {
        let now = DateTime::from_timestamp_millis(1_000_000).expect("ms");
        let parse = |body: serde_json::Value| {
            serde_json::from_value::<PatchNotificationRulesRequest>(body).expect("parse")
        };
        let only_mention = patch_from_request(
            &parse(serde_json::json!({"mentionOverridesMute": true})),
            now,
        )
        .expect("mention only");
        assert_eq!(
            only_mention,
            NotificationRulePatch {
                dnd: None,
                dnd_until: StatusPatch::Absent,
                mention_overrides_mute: Some(true),
            }
        );
        let timed = patch_from_request(
            &parse(serde_json::json!({"dnd": true, "dndUntilMs": 1_000_001})),
            now,
        )
        .expect("timed");
        assert_eq!(timed.dnd, Some(true));
        assert_eq!(
            timed.dnd_until,
            StatusPatch::Set(DateTime::from_timestamp_millis(1_000_001))
        );
        assert_eq!(timed.mention_overrides_mute, None);

        for empty in [serde_json::json!({}), serde_json::json!({"dnd": null})] {
            let error = patch_from_request(&parse(empty), now).expect_err("empty");
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        }
        assert!(patch_from_request(&parse(serde_json::json!({"dndUntilMs": 5})), now).is_err());
        assert!(serde_json::from_value::<PatchNotificationRulesRequest>(
            serde_json::json!({"dnd": true, "keyword": "x"})
        )
        .is_err());
    }
}
