//! 알림 진단과 시험 알림 (ADR-0206 D11, #4341) — 「왜 알림이 안 와요」.
//!
//! ```text
//! GET  /v1/workspaces/{ws}/notification-diagnostics?channelId=&kind=   the caller's blockers
//! POST /v1/workspaces/{ws}/notification-diagnostics/test               a test push to the caller's own devices
//! ```
//!
//! Both are **self-scoped**: the member is the credential's, never a path, query or body field, so
//! there is no spelling of either call that reads or pushes another member's devices. Both are
//! human-only: the agent-bearer allow-list does not list these paths (an agent bearer is 403 at the
//! door) and each handler checks [`require_human`] again, the way a later widening of a table must
//! not widen the route with it.
//!
//! The `GET` answers with the closed codes the *server* can know (`momo_push::diagnostics`). `ok`
//! means "the server holds nothing back" — the device may still not show it.
//!
//! The `POST` **bypasses the push judgment** on purpose: a test exists to answer "does the delivery
//! path work", so it is sent even while the caller's notifications are paused (the pause is what the
//! `GET` reports). What keeps that from being a way to push anyone else is that the one row it
//! writes — a `push_system` outbox row (ADR-0206 D15) — names only the caller, id-only, and the
//! notifier sends it to that member's own active tokens. The per-member budget (3 per minute) is
//! counted on the caller's `notification_rule` row under a row lock, in the same transaction as the
//! outbox row, so a burst cannot overspend it and a rollback undoes both.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_messaging::is_channel_member;
use momo_outbox::{emit_push_system, PushSystemReason};
use momo_push::{
    compute_diagnostics, reserve_test_push_in_tx, test_notification_collapse_id, Blocker,
    Diagnostics, TestPushSlot, NOTIFICATION_KINDS, TEST_PUSH_PER_WINDOW,
};
use uuid::Uuid;

use crate::dto::{
    NotificationBlockerDto, NotificationDevicesDto, NotificationDiagnosticsQuery,
    NotificationDiagnosticsResponse, NotificationLastTestDto, SendTestNotificationResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

fn blocker_dto(blocker: Blocker) -> NotificationBlockerDto {
    NotificationBlockerDto {
        code: blocker.code.as_str(),
        until_ms: blocker.until_ms,
        since_ms: blocker.since_ms,
        at_ms: blocker.at_ms,
        channel_id: blocker.channel_id,
        apns_status: blocker.apns_status,
        apns_reason: blocker.apns_reason,
    }
}

fn diagnostics_response(diagnostics: Diagnostics) -> NotificationDiagnosticsResponse {
    NotificationDiagnosticsResponse {
        checked_at_ms: diagnostics.checked_at_ms,
        ok: diagnostics.ok,
        blockers: diagnostics.blockers.into_iter().map(blocker_dto).collect(),
        devices: NotificationDevicesDto {
            active: diagnostics.devices.active,
            invalidated: diagnostics.devices.invalidated,
        },
        last_test: diagnostics.last_test.map(|test| NotificationLastTestDto {
            id: test.id,
            status: test.status.as_str(),
            at_ms: test.at_ms,
            apns_status: test.apns_status,
        }),
    }
}

/// `GET /v1/workspaces/{ws}/notification-diagnostics` — why a push might not arrive, as closed
/// codes, for the caller. A `channelId` the caller is not a member of — or that does not exist —
/// is the same 404, so the endpoint is no oracle for which channels exist.
pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<NotificationDiagnosticsQuery>,
) -> Result<Json<NotificationDiagnosticsResponse>, ApiError> {
    require_human(
        &principal,
        "notification diagnostics require a human bearer",
    )?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let channel_id: Option<Uuid> = match query.channel_id.as_deref() {
        None => None,
        Some(raw) => {
            Some(Uuid::parse_str(raw).map_err(|_| ApiError::bad_request("invalid channelId"))?)
        }
    };
    // Validated now (400 for an unknown kind) so the contract is stable; `kind_off` and the
    // work-hours pass-through read it when the slices that store those land.
    if let Some(kind) = query.kind.as_deref() {
        if !NOTIFICATION_KINDS.contains(&kind) {
            return Err(ApiError::bad_request("invalid kind"));
        }
    }

    let outcome: DbRejectable<Diagnostics> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                if let Some(channel_id) = channel_id {
                    if !is_channel_member(conn, channel_id, member_id).await? {
                        return Ok(Err(ApiError::not_found("channel not found")));
                    }
                }
                Ok(Ok(compute_diagnostics(
                    conn,
                    workspace_id,
                    member_id,
                    channel_id,
                )
                .await?))
            })
        })
        .await;

    let diagnostics = settle_db("notification_diagnostics.get", outcome)?;
    Ok(Json(diagnostics_response(diagnostics)))
}

/// `POST /v1/workspaces/{ws}/notification-diagnostics/test` — send a test push to the caller's own
/// devices. 202 `{testId, deviceCount}`; 409 `no_device` when the caller has no live push token
/// (no budget is spent); 429 `rate_limited` past 3 per minute.
pub async fn test(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<(StatusCode, Json<SendTestNotificationResponse>), ApiError> {
    require_human(
        &principal,
        "notification diagnostics require a human bearer",
    )?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<SendTestNotificationResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active human membership required")));
                }
                match reserve_test_push_in_tx(conn, workspace_id, member_id).await? {
                    TestPushSlot::NoDevice => Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "no_device",
                        "no active push device to send a test notification to",
                    ))),
                    TestPushSlot::RateLimited { retry_after_secs } => {
                        let mut error = ApiError::coded(
                            StatusCode::TOO_MANY_REQUESTS,
                            "rate_limited",
                            format!(
                                "at most {TEST_PUSH_PER_WINDOW} test notifications per minute; \
                                 try again shortly"
                            ),
                        );
                        error.retry_after_seconds = Some(retry_after_secs);
                        Ok(Err(error))
                    }
                    TestPushSlot::Reserved {
                        test_id,
                        device_count,
                    } => {
                        // The outbox row and the counter commit — or roll back — together, and the
                        // row names this member and ids only: no body, no name, no channel.
                        emit_push_system(
                            conn,
                            workspace_id,
                            PushSystemReason::TestNotification,
                            member_id,
                            None,
                            test_id,
                            &test_notification_collapse_id(test_id),
                        )
                        .await?;
                        Ok(Ok(SendTestNotificationResponse {
                            test_id,
                            device_count,
                        }))
                    }
                }
            })
        })
        .await;

    let sent = settle_db("notification_diagnostics.test", outcome)?;
    Ok((StatusCode::ACCEPTED, Json(sent)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_auth::PrincipalKind;

    /// A state whose pool never dials: a handler that reached the database would fail with a 500,
    /// so a 400/403 here proves the refusal came first.
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

    fn principal(kind: PrincipalKind, workspace_id: Uuid) -> Principal {
        Principal {
            member_id: Uuid::from_u128(1),
            workspace_id,
            token_id: Some(Uuid::from_u128(2)),
            scopes: vec![],
            kind,
        }
    }

    fn query(channel_id: Option<&str>, kind: Option<&str>) -> NotificationDiagnosticsQuery {
        NotificationDiagnosticsQuery {
            channel_id: channel_id.map(str::to_string),
            kind: kind.map(str::to_string),
        }
    }

    /// The handler's own second layer (ADR-0206 D11: 「에이전트 bearer는 403」). The door already
    /// answers an agent bearer 403 because no allow-list names these paths; this proves the handler
    /// would refuse an agent principal too if a later change put the route on a list — and that it
    /// does so **before** the database.
    #[tokio::test]
    async fn an_agent_principal_is_refused_before_the_database_on_both_routes() {
        let workspace = Uuid::from_u128(10);
        for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
            let error = get(
                State(lazy_state()),
                Extension(principal(kind, workspace)),
                Path(workspace.to_string()),
                Query(query(None, None)),
            )
            .await
            .expect_err("GET must refuse a non-human principal");
            assert_eq!(error.status, StatusCode::FORBIDDEN);

            let error = test(
                State(lazy_state()),
                Extension(principal(kind, workspace)),
                Path(workspace.to_string()),
            )
            .await
            .expect_err("POST must refuse a non-human principal");
            assert_eq!(error.status, StatusCode::FORBIDDEN);
        }
    }

    /// The tenant is the credential's: a path naming another workspace is refused before any query.
    #[tokio::test]
    async fn a_path_naming_another_workspace_is_refused_before_the_database() {
        let (mine, theirs) = (Uuid::from_u128(10), Uuid::from_u128(11));
        let error = get(
            State(lazy_state()),
            Extension(principal(PrincipalKind::Human, mine)),
            Path(theirs.to_string()),
            Query(query(None, None)),
        )
        .await
        .expect_err("a foreign workspace path");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        let error = test(
            State(lazy_state()),
            Extension(principal(PrincipalKind::Human, mine)),
            Path(theirs.to_string()),
        )
        .await
        .expect_err("a foreign workspace path");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }

    /// A malformed `channelId` and an unknown `kind` are the caller's mistakes: 400 before the
    /// database, with the closed kind list as the only thing a `kind` may be.
    #[tokio::test]
    async fn a_bad_channel_id_or_kind_is_a_400_before_the_database() {
        let workspace = Uuid::from_u128(10);
        for (channel, kind, sentence) in [
            (Some("not-a-uuid"), None, "invalid channelId"),
            (Some(""), None, "invalid channelId"),
            (None, Some("bogus"), "invalid kind"),
            (None, Some(""), "invalid kind"),
            (None, Some("channel_message"), "invalid kind"),
        ] {
            let error = get(
                State(lazy_state()),
                Extension(principal(PrincipalKind::Human, workspace)),
                Path(workspace.to_string()),
                Query(query(channel, kind)),
            )
            .await
            .expect_err("a malformed query");
            assert_eq!(
                error.status,
                StatusCode::BAD_REQUEST,
                "{channel:?} {kind:?}"
            );
            assert_eq!(error.message, sentence);
        }
    }
}
