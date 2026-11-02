//! 알림 설정 v2 (ADR-0206 D5·D13, #4494 N3) — the caller's per-kind switches, presentation, work
//! hours, phone delay and pass-through switches, with the server's own `effective` evaluation.
//!
//! ```text
//! GET|PATCH /v1/workspaces/{ws}/notification-prefs     the caller's own preferences
//! ```
//!
//! **Self-scoped by construction**: the member is the credential's, never a path, query or body
//! field, so there is no spelling of either call that reads or writes another member's settings.
//! **Human-only**: the agent-bearer allow-list does not list this path (an agent bearer is 403 at the
//! door), and each handler checks [`require_human`] again, the way a later widening of a table must
//! not widen the route with it. Authorization is an active workspace membership — these are personal
//! preferences, not a workspace policy.
//!
//! `PATCH` merges per field under the row lock (see `momo_messaging::notification_prefs`): `kinds` per
//! cell, `presentation.sounds` per kind, `schedule` whole. Every refusal below is a 400 decided
//! **before the first write**, so the transaction that carries it has nothing to undo:
//!
//! * an empty body;
//! * `approval.phone` true → false without `confirm: ["approval_push_off"]` (`confirmation_required`)
//!   — with it the response carries `warnings: ["approval_push_off"]` and the write is audited as
//!   `notification_prefs.approval_push_off`. The token is a protocol-level guard against a client
//!   that skipped the confirmation step, **not** a security control: any bearer-holding client can
//!   send the fixed string;
//! * a schedule whose zone is not in `pg_timezone_names` (`invalid_time_zone`) or whose shape is
//!   wrong (`invalid_schedule`);
//! * a sound id that is not a bundled one (`unknown_sound`);
//! * a cell of a surface the kind does not have (`surface_not_applicable`);
//! * a `phoneDelaySecs` other than 0, 60 or 300 (`invalid_phone_delay`).
//!
//! An unknown field, kind or confirmation token is a 422 from the JSON extractor.
//!
//! There is no event: another device converges on its next read (ADR-0177).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{
    get_prefs_in_tx, patch_prefs_in_tx, CellPatch, CellsPatch, NotificationKind, PrefsApplied,
    PrefsPatch, PrefsRejection, PrefsView, Schedule,
};

use crate::dto::{
    NotificationConfirmToken, NotificationEffectiveDto, NotificationPrefsResponse,
    NotificationPresentationDto, NotificationQuietDto, NotificationScheduleDto,
    NotificationSurfaceSwitchesDto, OptionalPatch, PatchNotificationKindsRequest,
    PatchNotificationPrefsRequest, PatchNotificationSurfacesRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// The largest `PATCH …/notification-prefs` body the route reads (ADR-0206 D13: 「8KB 이하」). The
/// largest honest body — all ten kinds with both cells, ten sound slots, a schedule and the
/// confirmation — is about 1.5 KiB, so this bounds abuse, not use; axum's default is 2 MiB (#4494
/// review L-1).
pub const MAX_PATCH_BODY_BYTES: usize = 8 * 1024;

/// The audit action of the one write that is audited (D5): approval push turned off.
pub const AUDIT_APPROVAL_PUSH_OFF: &str = "notification_prefs.approval_push_off";
/// Its payload schema.
pub const AUDIT_APPROVAL_PUSH_OFF_SCHEMA: &str = "momo.notification_prefs.approval_push_off.v1";

fn schedule_dto(schedule: &Schedule) -> NotificationScheduleDto {
    NotificationScheduleDto {
        enabled: schedule.enabled,
        tz: schedule.tz.clone(),
        days: schedule.days.clone(),
        start: schedule.start.clone(),
        end: schedule.end.clone(),
        pass_through: schedule.pass_through.clone(),
    }
}

fn prefs_response(view: PrefsView, warnings: Vec<&'static str>) -> NotificationPrefsResponse {
    NotificationPrefsResponse {
        kinds: view
            .kinds
            .iter()
            .map(|(kind, switch)| {
                (
                    kind.as_str(),
                    NotificationSurfaceSwitchesDto {
                        phone: switch.phone,
                        desktop: switch.desktop,
                    },
                )
            })
            .collect(),
        presentation: NotificationPresentationDto {
            sounds: view
                .sounds
                .iter()
                .map(|(kind, sound)| (kind.as_str(), sound.clone()))
                .collect(),
        },
        schedule: view.schedule.as_ref().map(schedule_dto),
        phone_delay_secs: view.phone_delay_secs,
        keyword_overrides_mute: view.keyword_overrides_mute,
        approval_time_sensitive: view.approval_time_sensitive,
        effective: NotificationEffectiveDto {
            paused: view.paused,
            paused_until_ms: view.paused_until.map(|at| at.timestamp_millis()),
            quiet: NotificationQuietDto {
                active: view.quiet.active,
                resumes_at_ms: view.quiet.resumes_at_ms,
            },
        },
        warnings,
    }
}

fn cell_patch(raw: &OptionalPatch<bool>) -> CellPatch {
    match raw {
        OptionalPatch::Absent => CellPatch::Keep,
        OptionalPatch::Set(None) => CellPatch::Reset,
        OptionalPatch::Set(Some(value)) => CellPatch::Set(*value),
    }
}

fn surfaces_patch(raw: &PatchNotificationSurfacesRequest) -> CellsPatch {
    CellsPatch {
        phone: cell_patch(&raw.phone),
        desktop: cell_patch(&raw.desktop),
    }
}

/// The wire patch as the domain's, plus the 400s that need no database. The ten kind fields are
/// spelled out once, here, in the order of the closed table.
fn patch_from_request(request: PatchNotificationPrefsRequest) -> Result<PrefsPatch, ApiError> {
    let mut patch = PrefsPatch::default();

    let PatchNotificationKindsRequest {
        dm,
        mention_human,
        mention_agent,
        agent_answer,
        approval,
        work_done,
        keyword,
        channel_all,
        thread_reply,
        scheduled_failed,
    } = request.kinds.unwrap_or_default();
    for (kind, named) in [
        (NotificationKind::Dm, dm),
        (NotificationKind::MentionHuman, mention_human),
        (NotificationKind::MentionAgent, mention_agent),
        (NotificationKind::AgentAnswer, agent_answer),
        (NotificationKind::Approval, approval),
        (NotificationKind::WorkDone, work_done),
        (NotificationKind::Keyword, keyword),
        (NotificationKind::ChannelAll, channel_all),
        (NotificationKind::ThreadReply, thread_reply),
        (NotificationKind::ScheduledFailed, scheduled_failed),
    ] {
        if let Some(named) = named {
            patch.kinds.insert(kind, surfaces_patch(&named));
        }
    }

    if let Some(presentation) = request.presentation {
        for (key, sound) in presentation.sounds {
            let kind = NotificationKind::from_wire(&key).ok_or_else(|| {
                // A fixed sentence on purpose: the key is the caller's own text, as long as the body
                // limit allows, and an error answer does not echo what it refuses (#4494 review L-2).
                ApiError::coded(
                    StatusCode::BAD_REQUEST,
                    "unknown_kind",
                    "presentation.sounds names a key that is not a notification kind",
                )
            })?;
            patch.sounds.insert(kind, sound);
        }
    }

    patch.schedule = match request.schedule {
        OptionalPatch::Absent => None,
        OptionalPatch::Set(None) => Some(None),
        OptionalPatch::Set(Some(raw)) => {
            let mut pass_through: Vec<NotificationKind> = Vec::new();
            for kind in raw.pass_through {
                if !pass_through.contains(&kind) {
                    pass_through.push(kind);
                }
            }
            Some(Some(Schedule {
                enabled: raw.enabled,
                tz: raw.tz,
                days: raw.days,
                start: raw.start,
                end: raw.end,
                pass_through,
            }))
        }
    };

    // A value outside i16 cannot be a valid delay: -1 is refused by the domain like any other.
    patch.phone_delay_secs = request
        .phone_delay_secs
        .map(|secs| i16::try_from(secs).unwrap_or(-1));
    patch.keyword_overrides_mute = request.keyword_overrides_mute;
    patch.approval_time_sensitive = request.approval_time_sensitive;
    patch.confirm_approval_push_off = request
        .confirm
        .unwrap_or_default()
        .contains(&NotificationConfirmToken::ApprovalPushOff);

    if patch.is_empty() {
        return Err(ApiError::bad_request(
            "name at least one of kinds, presentation, schedule, phoneDelaySecs, \
             keywordOverridesMute, approvalTimeSensitive",
        ));
    }
    Ok(patch)
}

fn rejection_error(rejection: &PrefsRejection) -> ApiError {
    ApiError::coded(
        StatusCode::BAD_REQUEST,
        rejection.code(),
        rejection.message(),
    )
}

/// `GET /v1/workspaces/{ws}/notification-prefs` — the caller's preferences, every kind present with
/// its stored value or its default. No stored row answers today's behavior.
pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<NotificationPrefsResponse>, ApiError> {
    require_human(&principal, "notification prefs require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<PrefsView> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                Ok(Ok(get_prefs_in_tx(conn, workspace_id, member_id).await?))
            })
        })
        .await;

    let view = settle_db("notification_prefs.get", outcome)?;
    log_unknown_zone(&view, workspace_id);
    Ok(Json(prefs_response(view, Vec::new())))
}

/// A stored schedule names a zone this database no longer knows (a tzdata change): it is read as no
/// schedule so a read never breaks, and the operator gets one line (D13).
fn log_unknown_zone(view: &PrefsView, workspace_id: uuid::Uuid) {
    if view.schedule_zone_unknown {
        tracing::warn!(
            workspace_id = %workspace_id,
            "a stored notification schedule names a time zone the database does not know; \
             reading it as no schedule"
        );
    }
}

/// `PATCH /v1/workspaces/{ws}/notification-prefs` — change only the named preferences.
pub async fn patch(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PatchNotificationPrefsRequest>,
) -> Result<Json<NotificationPrefsResponse>, ApiError> {
    require_human(&principal, "notification prefs require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let patch = patch_from_request(request)?;

    let outcome: DbRejectable<PrefsApplied> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                let applied = match patch_prefs_in_tx(conn, workspace_id, member_id, &patch).await?
                {
                    Ok(applied) => applied,
                    // Nothing was written: the rejection is returned before the first write.
                    Err(rejection) => return Ok(Err(rejection_error(&rejection))),
                };
                if applied.approval_push_turned_off {
                    // Same transaction as the write, so an audit row can never record a switch
                    // that rolled back (`momo_db::audit` docs).
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, AUDIT_APPROVAL_PUSH_OFF)
                            .by(member_id)
                            .about(member_id)
                            .via_token(via_token)
                            .with_schema(
                                AUDIT_APPROVAL_PUSH_OFF_SCHEMA,
                                serde_json::json!({ "surface": "phone" }),
                            ),
                    )
                    .await?;
                }
                Ok(Ok(applied))
            })
        })
        .await;

    let applied = settle_db("notification_prefs.patch", outcome)?;
    log_unknown_zone(&applied.view, workspace_id);
    let warnings = if applied.approval_push_turned_off {
        vec!["approval_push_off"]
    } else {
        Vec::new()
    };
    Ok(Json(prefs_response(applied.view, warnings)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_auth::PrincipalKind;
    use serde_json::json;

    fn request(body: serde_json::Value) -> PatchNotificationPrefsRequest {
        serde_json::from_value(body).expect("a well-formed request")
    }

    #[test]
    fn an_empty_body_and_a_body_that_names_no_cell_are_a_400() {
        for body in [
            json!({}),
            json!({"kinds": {}}),
            json!({"confirm": ["approval_push_off"]}),
        ] {
            let error = patch_from_request(request(body)).expect_err("nothing to change");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn unknown_fields_kinds_and_tokens_never_reach_the_domain() {
        for body in [
            json!({"nope": 1}),
            json!({"kinds": {"channel_message": {"phone": false}}}),
            json!({"kinds": {"dm": {"tablet": false}}}),
            json!({"confirm": ["yes_really"]}),
            json!({"schedule": {"enabled": true, "tz": "UTC", "days": [1], "start": "09:00",
                                "end": "18:00", "passThrough": ["approval"], "extra": 1}}),
        ] {
            assert!(
                serde_json::from_value::<PatchNotificationPrefsRequest>(body.clone()).is_err(),
                "{body} must fail to deserialize (the JSON extractor's 422)"
            );
        }
    }

    #[test]
    fn a_null_cell_is_a_reset_and_an_omitted_one_is_kept() {
        let patch = patch_from_request(request(json!({
            "kinds": {"dm": {"phone": null, "desktop": true}, "approval": {"phone": false}},
            "confirm": ["approval_push_off"],
        })))
        .unwrap();
        let dm = patch.kinds[&NotificationKind::Dm];
        assert_eq!(dm.phone, CellPatch::Reset);
        assert_eq!(dm.desktop, CellPatch::Set(true));
        let approval = patch.kinds[&NotificationKind::Approval];
        assert_eq!(approval.phone, CellPatch::Set(false));
        assert_eq!(approval.desktop, CellPatch::Keep);
        assert!(patch.confirm_approval_push_off);
    }

    #[test]
    fn a_sound_key_that_is_not_a_kind_is_a_400_and_null_resets_the_sound() {
        let error = patch_from_request(request(
            json!({"presentation": {"sounds": {"gong": "none"}}}),
        ))
        .expect_err("not a kind");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, Some("unknown_kind"));
        // The answer is a fixed sentence: it never carries the caller's own key back (L-2).
        let probe = "echo-probe-0123456789-presentation-key";
        let error = patch_from_request(request(
            json!({"presentation": {"sounds": {probe: "none"}}}),
        ))
        .expect_err("not a kind");
        assert!(
            !error.message.contains(probe) && !error.message.contains("echo-probe"),
            "the refusal must not echo the key: {}",
            error.message
        );
        let patch =
            patch_from_request(request(json!({"presentation": {"sounds": {"dm": null}}}))).unwrap();
        assert_eq!(patch.sounds[&NotificationKind::Dm], None);
    }

    #[test]
    fn a_delay_outside_the_i16_range_is_carried_as_an_invalid_value() {
        let patch = patch_from_request(request(json!({"phoneDelaySecs": 70000}))).unwrap();
        assert_eq!(patch.phone_delay_secs, Some(-1));
    }

    #[test]
    fn a_schedule_is_carried_whole_with_a_deduplicated_pass_through() {
        let patch = patch_from_request(request(json!({
            "schedule": {"enabled": true, "tz": "Asia/Seoul", "days": [1, 2], "start": "09:00",
                         "end": "18:00", "passThrough": ["approval", "dm", "approval"]},
        })))
        .unwrap();
        let schedule = patch.schedule.unwrap().unwrap();
        assert_eq!(
            schedule.pass_through,
            vec![NotificationKind::Approval, NotificationKind::Dm]
        );
        let removed = patch_from_request(request(json!({"schedule": null}))).unwrap();
        assert_eq!(removed.schedule, Some(None));
    }

    /// A state whose pool never dials: a handler that reached the database would fail with a 500, so
    /// a 400/403 here proves the refusal came first.
    fn lazy_state() -> AppState {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        AppState::new(
            pool,
            "test-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
    }

    fn principal(kind: PrincipalKind, workspace_id: uuid::Uuid) -> Principal {
        Principal {
            member_id: uuid::Uuid::from_u128(1),
            workspace_id,
            token_id: Some(uuid::Uuid::from_u128(2)),
            scopes: vec![],
            kind,
        }
    }

    /// The handler's own second layer (ADR-0206 D13: 「에이전트 403」). The door already answers an
    /// agent bearer 403 because no allow-list names this path; this proves the handlers would refuse a
    /// non-human principal too if a later change put the route on a list, **before** the database.
    #[tokio::test]
    async fn a_non_human_principal_is_refused_before_the_database_on_both_methods() {
        let workspace = uuid::Uuid::from_u128(10);
        for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
            let error = get(
                State(lazy_state()),
                Extension(principal(kind, workspace)),
                Path(workspace.to_string()),
            )
            .await
            .expect_err("GET must refuse a non-human principal");
            assert_eq!(error.status, StatusCode::FORBIDDEN);

            let error = patch(
                State(lazy_state()),
                Extension(principal(kind, workspace)),
                Path(workspace.to_string()),
                Json(request(json!({"phoneDelaySecs": 60}))),
            )
            .await
            .expect_err("PATCH must refuse a non-human principal");
            assert_eq!(error.status, StatusCode::FORBIDDEN);
        }
    }

    /// The tenant is the credential's: a path naming another workspace is refused before any query.
    #[tokio::test]
    async fn a_path_naming_another_workspace_is_refused_before_the_database() {
        let (mine, theirs) = (uuid::Uuid::from_u128(10), uuid::Uuid::from_u128(11));
        let error = get(
            State(lazy_state()),
            Extension(principal(PrincipalKind::Human, mine)),
            Path(theirs.to_string()),
        )
        .await
        .expect_err("a foreign workspace path");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        let error = patch(
            State(lazy_state()),
            Extension(principal(PrincipalKind::Human, mine)),
            Path(theirs.to_string()),
            Json(request(json!({"phoneDelaySecs": 60}))),
        )
        .await
        .expect_err("a foreign workspace path");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }
}
