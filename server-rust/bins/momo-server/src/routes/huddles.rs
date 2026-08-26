//! Huddle REST parity with Swift `HuddleRoutes` (ADR-0122 / HD-1).
//!
//! This is translation only: the `momo-messaging` huddle module owns all SQL,
//! audit, lifecycle, and transactional outbox. The sibling `livekit` module
//! owns the credential-shaped grant construction.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    active_huddle, join_huddle, leave_huddle, start_huddle, Huddle, HuddleActor, HuddleError,
};
use serde::Serialize;

use crate::config::LiveKitConfig;
use crate::error::ApiError;
use crate::livekit::issue_livekit_token;
use crate::routes::shared::{audit_via_token_id, path_uuid, workspace_scope};
use crate::AppState;

#[derive(Debug, Serialize)]
pub(crate) struct HuddleResponse {
    huddle: Huddle,
}

#[derive(Debug, Serialize)]
pub(crate) struct ActiveHuddleResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    huddle: Option<Huddle>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JoinHuddleResponse {
    huddle: Huddle,
    livekit_url: String,
    token: String,
    expires_at_ms: i64,
    ttl_seconds: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct LeaveHuddleResponse {
    huddle: Huddle,
    ended: bool,
}

fn configured_livekit(state: &AppState) -> Result<&LiveKitConfig, ApiError> {
    state.livekit.as_deref().ok_or_else(huddles_not_configured)
}

fn huddles_not_configured() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "허들 미구성")
}

fn actor(principal: &Principal) -> HuddleActor {
    HuddleActor {
        member_id: principal.member_id,
        via_token_id: audit_via_token_id(principal),
    }
}

fn huddle_error(context: &str, error: HuddleError) -> ApiError {
    match error {
        HuddleError::ActiveChannelMembershipRequired => {
            ApiError::forbidden("active channel membership required")
        }
        HuddleError::ActiveHuddleChanged => ApiError::new(
            StatusCode::CONFLICT,
            "active huddle changed concurrently — retry",
        ),
        HuddleError::HuddleEnded => ApiError::new(StatusCode::CONFLICT, "huddle has ended"),
        HuddleError::RecordingConsentRequired => ApiError::new(
            StatusCode::CONFLICT,
            "recording consent is required before joining this recorded huddle",
        ),
        HuddleError::MemberNotPresent => {
            ApiError::new(StatusCode::CONFLICT, "member is not in this huddle")
        }
        other => ApiError::internal(context, other),
    }
}

pub(crate) async fn start(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    configured_livekit(&state)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let outcome = start_huddle(&state.pool, workspace_id, channel_id, actor(&principal))
        .await
        .map_err(|error| huddle_error("huddles.start", error))?;
    Ok((
        if outcome.created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(HuddleResponse {
            huddle: outcome.huddle,
        }),
    ))
}

pub(crate) async fn join(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, huddle)): Path<(String, String)>,
) -> Result<Json<JoinHuddleResponse>, ApiError> {
    let livekit = configured_livekit(&state)?.clone();
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let huddle_id = path_uuid(&huddle, "invalid huddle id")?;
    let api_key = livekit.api_key().to_string();
    let api_secret = livekit.api_secret().to_string();
    let outcome = join_huddle(
        &state.pool,
        workspace_id,
        huddle_id,
        actor(&principal),
        move |room_id, member_id, display_name| {
            issue_livekit_token(&api_key, &api_secret, room_id, member_id, display_name)
                .map_err(|_| HuddleError::GrantEncoding)
        },
    )
    .await
    .map_err(|error| huddle_error("huddles.join", error))?;
    Ok(Json(JoinHuddleResponse {
        huddle: outcome.huddle,
        livekit_url: livekit.url.clone(),
        token: outcome.grant.token,
        expires_at_ms: outcome.grant.expires_at_ms,
        ttl_seconds: outcome.grant.ttl_seconds,
    }))
}

pub(crate) async fn leave(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, huddle)): Path<(String, String)>,
) -> Result<Json<LeaveHuddleResponse>, ApiError> {
    configured_livekit(&state)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let huddle_id = path_uuid(&huddle, "invalid huddle id")?;
    let outcome = leave_huddle(&state.pool, workspace_id, huddle_id, actor(&principal))
        .await
        .map_err(|error| huddle_error("huddles.leave", error))?;
    Ok(Json(LeaveHuddleResponse {
        huddle: outcome.huddle,
        ended: outcome.ended,
    }))
}

pub(crate) async fn active(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Json<ActiveHuddleResponse>, ApiError> {
    configured_livekit(&state)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let huddle = active_huddle(&state.pool, workspace_id, channel_id, principal.member_id)
        .await
        .map_err(|error| huddle_error("huddles.active", error))?;
    Ok(Json(ActiveHuddleResponse { huddle }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_livekit_is_the_swift_503() {
        let error = huddles_not_configured();
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.message, "허들 미구성");
    }

    #[test]
    fn domain_rejections_keep_the_swift_status_and_message() {
        for (error, status, message) in [
            (
                HuddleError::ActiveChannelMembershipRequired,
                StatusCode::FORBIDDEN,
                "active channel membership required",
            ),
            (
                HuddleError::HuddleEnded,
                StatusCode::CONFLICT,
                "huddle has ended",
            ),
            (
                HuddleError::ActiveHuddleChanged,
                StatusCode::CONFLICT,
                "active huddle changed concurrently — retry",
            ),
            (
                HuddleError::RecordingConsentRequired,
                StatusCode::CONFLICT,
                "recording consent is required before joining this recorded huddle",
            ),
            (
                HuddleError::MemberNotPresent,
                StatusCode::CONFLICT,
                "member is not in this huddle",
            ),
        ] {
            let api = huddle_error("test", error);
            assert_eq!(api.status, status);
            assert_eq!(api.message, message);
        }
    }
}
