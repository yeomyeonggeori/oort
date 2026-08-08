//! APNs device / push-token registration (ADR-0120 D4, batch P2).
//!
//!   POST   /v1/workspaces/{ws}/devices           register (idempotent upsert)
//!   GET    /v1/workspaces/{ws}/devices           list the caller's own devices
//!   DELETE /v1/workspaces/{ws}/devices/{device}  revoke (invalidate tokens)
//!
//! Parity: `server/Sources/MomoServer/Routes/DeviceRoutes.swift`.
//!
//! **Path shape.** ADR-0120 D4 sketches `POST /v1/devices`, but every protected
//! tenant-data surface here is workspace-scoped, with the uniform "path ws ==
//! JWT ws else 403" guard, and `device`/`push_token` carry a NOT NULL
//! `workspace_id` under FORCE RLS. The workspace-scoped form is the same
//! operation with the tenant made explicit, so registration keeps the repo-wide
//! guard and RLS path identical to every other route.
//!
//! This module owns no SQL — `momo-push` owns every statement.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_push::{DeviceInputError, DeviceRegistration, DeviceRejection, PushError};

use crate::dto::{
    DeviceDto, DeviceListResponse, RegisterDeviceRequest, RegisterDeviceResponse,
    RevokeDeviceResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{audit_via_token_id, path_uuid, workspace_scope};
use crate::AppState;

/// A validation failure is a 400 carrying the Swift message verbatim.
fn input_error(error: DeviceInputError) -> ApiError {
    ApiError::bad_request(error.to_string())
}

/// Map a caller-fault rejection onto its HTTP status.
///
/// The statuses are Swift's: an actor-binding violation is 403, an immutable
/// platform is 409 (the request is well-formed but conflicts with committed
/// state), a missing device is 404.
fn rejection(rejection: DeviceRejection) -> ApiError {
    let status = match rejection {
        DeviceRejection::NotActiveMember
        | DeviceRejection::DeviceOwnedByAnotherMember
        | DeviceRejection::TokenOwnedByAnotherMember => StatusCode::FORBIDDEN,
        DeviceRejection::PlatformImmutable => StatusCode::CONFLICT,
        DeviceRejection::DeviceNotFound => StatusCode::NOT_FOUND,
    };
    ApiError::new(status, rejection.message())
}

/// Map a failure. A registration conflict is retryable and must read as 409 —
/// surfacing it as a 500 would tell the client to give up on a race it should
/// simply retry (review #422 L1).
fn failure(context: &str, error: PushError) -> ApiError {
    match error {
        PushError::RegistrationConflict => ApiError::new(
            StatusCode::CONFLICT,
            "concurrent registration for this device — retry",
        ),
        PushError::Db(error) => ApiError::internal(context, error),
    }
}

// ---- POST /v1/workspaces/{ws}/devices --------------------------------------

pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RegisterDeviceRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let registration = DeviceRegistration::parse(
        &request.device_id,
        &request.platform,
        request.app_build.as_deref(),
        &request.apns_token,
        &request.env,
        &request.topic,
    )
    .map_err(input_error)?;

    let outcome = momo_push::register_device(
        &state.pool,
        workspace_id,
        principal.member_id,
        audit_via_token_id(&principal),
        &registration,
    )
    .await
    .map_err(|error| failure("devices.register", error))?
    .map_err(rejection)?;

    // 201 on a first registration, 200 on a liveness/token refresh — the
    // client distinguishes "this device is new to the server" from "we rotated".
    let status = if outcome.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(RegisterDeviceResponse {
            device: DeviceDto::from(outcome.device),
        }),
    ))
}

// ---- GET /v1/workspaces/{ws}/devices ----------------------------------------

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<DeviceListResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let devices = momo_push::list_devices(&state.pool, workspace_id, principal.member_id)
        .await
        .map_err(|error| failure("devices.list", error))?
        .map_err(rejection)?;

    Ok(Json(DeviceListResponse {
        devices: devices.into_iter().map(DeviceDto::from).collect(),
    }))
}

// ---- DELETE /v1/workspaces/{ws}/devices/{device} ----------------------------

pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, device)): Path<(String, String)>,
) -> Result<Json<RevokeDeviceResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let device_id = path_uuid(&device, "invalid device id")?;

    let outcome = momo_push::revoke_device(
        &state.pool,
        workspace_id,
        principal.member_id,
        audit_via_token_id(&principal),
        device_id,
    )
    .await
    .map_err(|error| failure("devices.revoke", error))?
    .map_err(rejection)?;

    Ok(Json(RevokeDeviceResponse {
        device: DeviceDto::from(outcome.device),
        invalidated_count: outcome.invalidated as i64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejections_map_to_the_swift_status_codes() {
        assert_eq!(
            rejection(DeviceRejection::DeviceOwnedByAnotherMember).status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            rejection(DeviceRejection::TokenOwnedByAnotherMember).status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            rejection(DeviceRejection::NotActiveMember).status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            rejection(DeviceRejection::PlatformImmutable).status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            rejection(DeviceRejection::DeviceNotFound).status,
            StatusCode::NOT_FOUND
        );
    }

    /// A lost registration race is retryable. If this ever reads 500 the client
    /// stops retrying a conflict it would win on the next attempt.
    #[test]
    fn a_registration_conflict_is_a_retryable_409_not_a_500() {
        let error = failure("devices.register", PushError::RegistrationConflict);
        assert_eq!(error.status, StatusCode::CONFLICT);
    }

    #[test]
    fn validation_messages_match_swift() {
        assert_eq!(
            input_error(DeviceInputError::DeviceId).message,
            "deviceId must be a UUID"
        );
        assert_eq!(
            input_error(DeviceInputError::Platform).message,
            "platform must be ios or macos"
        );
        assert_eq!(
            input_error(DeviceInputError::ApnsToken).message,
            "apnsToken must be a hex device token"
        );
    }
}
