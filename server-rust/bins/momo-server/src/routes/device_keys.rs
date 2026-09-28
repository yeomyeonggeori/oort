//! Device signing keys — ADR-0146 개정 2026-09-28 (R2-E2, #3022).
//!
//! ```text
//! POST /v1/workspaces/{ws}/device-keys                    (bearer, human) register
//! GET  /v1/workspaces/{ws}/device-keys                    (bearer, human) list own
//! POST /v1/workspaces/{ws}/device-keys/{key}/endorsement  (bearer, human) device_endorse.v1
//! POST /v1/workspaces/{ws}/device-keys/{key}/revocation   (bearer, human) device_revoke.v1
//! ```
//!
//! A signed-in device uploads its Secure Enclave P-256 public key. The row is
//! bound to the caller's session lineage and ends with it (logout, unlinking,
//! a refresh-token reuse, every member-wide session end — `crate::session_end`).
//!
//! * **Register.** For the caller only: the member is the bearer's, and a
//!   `memberId` naming anyone else is a 403 `device_key_member_mismatch`. A key
//!   already live in the workspace (under anyone) is a 409
//!   `device_key_already_registered`. The caller's lineage must still be able
//!   to rotate (409 `session_lineage_ended` otherwise). A `macos` key starts as
//!   a **root candidate**; an `ios` key starts **unendorsed** — 「지시 불가」 —
//!   and stays so until a root endorses it.
//! * **Endorse** (D-6 ②). The body carries only the root key id and the
//!   signature; the letter is rebuilt from the stored rows, so a label or key
//!   the request made up cannot be what verified.
//! * **Revoke** (D-7). A root's signed letter. The letter is kept on the row so
//!   workd (E4 #3024) can be handed it; a key a session end already revoked
//!   still takes its letter once.
//!
//! The server's view of the root is advisory: the host Mac's workd pins the
//! real root and is the security boundary (D-10). The server refuses every
//! shape the chain can never take (see `momo_auth::device_key`).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::device_key::{
    endorse_device_key_in_tx, insert_device_key_in_tx, list_member_device_keys_in_tx,
    load_device_key_in_tx, revoke_device_key_signed_in_tx, validated_new_device_key,
    DeviceKeyRecord, DeviceKeyRefusal, REFUSAL_DEVICE_KEY_ALREADY_REGISTERED,
    REFUSAL_DEVICE_KEY_MEMBER_MISMATCH, REFUSAL_SESSION_LINEAGE_ENDED,
};
use momo_auth::{active_workspace_role, lock_live_session_lineage, session_id_of, Principal};
use momo_db::{with_tenant_tx, DbError};
use uuid::Uuid;

use crate::dto::{
    DeviceKeyDto, DeviceKeyListResponse, DeviceKeyResponse, EndorseDeviceKeyRequest,
    RegisterDeviceKeyRequest, RevokeDeviceKeyRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, require_human, workspace_scope};
use crate::AppState;

const HUMAN_ONLY: &str = "device keys belong to a person";

/// A refusal → its named HTTP error.
pub(crate) fn refusal_error(refusal: DeviceKeyRefusal) -> ApiError {
    let (status, message) = match refusal {
        DeviceKeyRefusal::NotFound => (StatusCode::NOT_FOUND, "device key not found"),
        DeviceKeyRefusal::MemberMismatch => (
            StatusCode::FORBIDDEN,
            "a device key belongs to its own member",
        ),
        DeviceKeyRefusal::RootNotEligible => (
            StatusCode::FORBIDDEN,
            "the signing key is not a live root key of this member",
        ),
        DeviceKeyRefusal::NotEndorsable => (
            StatusCode::CONFLICT,
            "only a live, unendorsed phone key can be endorsed",
        ),
        DeviceKeyRefusal::Revoked => (StatusCode::FORBIDDEN, "the device key is revoked"),
        DeviceKeyRefusal::SignatureInvalid => (
            StatusCode::FORBIDDEN,
            "the device signature does not verify",
        ),
    };
    ApiError::coded(status, refusal.code(), message)
}

pub(crate) fn device_key_dto(
    record: DeviceKeyRecord,
    caller_session: Option<Uuid>,
) -> DeviceKeyDto {
    let state = record.state();
    DeviceKeyDto {
        id: record.id.to_string(),
        workspace_id: record.workspace_id.to_string(),
        member_id: record.member_id.to_string(),
        current: caller_session == Some(record.session_id),
        alg: record.alg,
        public_key: record.public_key,
        platform: record.platform,
        label: record.label,
        state: state.as_str(),
        can_instruct: state.can_instruct(),
        endorsed_by_key_id: record.endorsed_by_key_id.map(|id| id.to_string()),
        endorsement_signature: record.endorsement_sig,
        endorsed_at_ms: record.endorsed_at_ms,
        created_at_ms: record.created_at_ms,
        revoked_at_ms: record.revoked_at_ms,
        revoked_reason: record.revoked_reason,
        revoked_by_key_id: record.revoked_by_key_id.map(|id| id.to_string()),
        revocation_signature: record.revocation_sig,
        revocation_signed_at_ms: record.revocation_signed_at_ms,
    }
}

fn not_active() -> ApiError {
    ApiError::forbidden("not an active workspace member")
}

/// `POST /v1/workspaces/{ws}/device-keys` → 201.
pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RegisterDeviceKeyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    if let Some(raw) = request.member_id.as_deref() {
        let named = Uuid::parse_str(raw).map_err(|_| ApiError::bad_request("invalid memberId"))?;
        if named != member_id {
            return Err(ApiError::coded(
                StatusCode::FORBIDDEN,
                REFUSAL_DEVICE_KEY_MEMBER_MISMATCH,
                "a device key can only be registered for yourself",
            ));
        }
    }
    let new = validated_new_device_key(
        &request.alg,
        &request.public_key,
        &request.platform,
        request.label.as_deref(),
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let lineage_ended = || {
        ApiError::coded(
            StatusCode::CONFLICT,
            REFUSAL_SESSION_LINEAGE_ENDED,
            "this sign-in can no longer register a device key; sign in again",
        )
    };
    let Some(token_id) = principal.token_id else {
        return Err(lineage_ended());
    };

    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(not_active()));
            }
            // The key is the lineage's (D-7). A lineage that can no longer
            // rotate is over — an access half can outlive its logout by up to
            // 15 minutes, and a key registered then would outlive the logout.
            let Some(session_id) = session_id_of(conn, token_id).await.map_err(DbError::from)?
            else {
                return Ok(Err(lineage_ended()));
            };
            if !lock_live_session_lineage(conn, workspace_id, member_id, session_id)
                .await
                .map_err(DbError::from)?
            {
                return Ok(Err(lineage_ended()));
            }
            let Some(key_id) =
                insert_device_key_in_tx(conn, workspace_id, member_id, session_id, &new)
                    .await
                    .map_err(DbError::from)?
            else {
                return Ok(Err(ApiError::coded(
                    StatusCode::CONFLICT,
                    REFUSAL_DEVICE_KEY_ALREADY_REGISTERED,
                    "this public key is already registered",
                )));
            };
            let record = load_device_key_in_tx(conn, key_id)
                .await
                .map_err(DbError::from)?;
            Ok::<_, DbError>(Ok(
                record.map(|record| device_key_dto(record, Some(session_id)))
            ))
        })
    })
    .await
    .map_err(|error| ApiError::internal("device_keys.register", error))?;

    let dto = outcome?
        .ok_or_else(|| ApiError::internal("device_keys.register", "device key reload failed"))?;
    Ok((
        StatusCode::CREATED,
        Json(DeviceKeyResponse { device_key: dto }),
    ))
}

/// `GET /v1/workspaces/{ws}/device-keys` — the caller's own keys, newest first,
/// revoked ones included (their letters are what workd is handed).
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<DeviceKeyListResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let token_id = principal.token_id;
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(not_active()));
            }
            let caller_session = match token_id {
                Some(id) => session_id_of(conn, id).await.map_err(DbError::from)?,
                None => None,
            };
            let keys = list_member_device_keys_in_tx(conn, workspace_id, member_id)
                .await
                .map_err(DbError::from)?;
            Ok::<_, DbError>(Ok(keys
                .into_iter()
                .map(|record| device_key_dto(record, caller_session))
                .collect()))
        })
    })
    .await
    .map_err(|error| ApiError::internal("device_keys.list", error))?;
    Ok(Json(DeviceKeyListResponse {
        device_keys: outcome?,
    }))
}

/// `POST /v1/workspaces/{ws}/device-keys/{key}/endorsement` → 200.
pub async fn endorse(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, key)): Path<(String, String)>,
    Json(request): Json<EndorseDeviceKeyRequest>,
) -> Result<Json<DeviceKeyResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let target_id = path_uuid(&key, "invalid device key id")?;
    let root_id = path_uuid(&request.root_key_id, "invalid rootKeyId")?;
    let signature = request.signature;
    let token_id = principal.token_id;
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(not_active()));
            }
            let outcome = endorse_device_key_in_tx(
                conn,
                workspace_id,
                member_id,
                target_id,
                root_id,
                &signature,
            )
            .await
            .map_err(DbError::from)?;
            let caller_session = match token_id {
                Some(id) => session_id_of(conn, id).await.map_err(DbError::from)?,
                None => None,
            };
            Ok::<_, DbError>(
                outcome
                    .map(|record| device_key_dto(record, caller_session))
                    .map_err(refusal_error),
            )
        })
    })
    .await
    .map_err(|error| ApiError::internal("device_keys.endorse", error))?;
    Ok(Json(DeviceKeyResponse {
        device_key: outcome?,
    }))
}

/// `POST /v1/workspaces/{ws}/device-keys/{key}/revocation` → 200.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, key)): Path<(String, String)>,
    Json(request): Json<RevokeDeviceKeyRequest>,
) -> Result<Json<DeviceKeyResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let target_id = path_uuid(&key, "invalid device key id")?;
    let root_id = path_uuid(&request.root_key_id, "invalid rootKeyId")?;
    let revoked_at_ms = request.revoked_at_ms;
    let signature = request.signature;
    let token_id = principal.token_id;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(not_active()));
            }
            let outcome = revoke_device_key_signed_in_tx(
                conn,
                workspace_id,
                member_id,
                target_id,
                root_id,
                revoked_at_ms,
                &signature,
                now_ms,
            )
            .await
            .map_err(DbError::from)?;
            let caller_session = match token_id {
                Some(id) => session_id_of(conn, id).await.map_err(DbError::from)?,
                None => None,
            };
            Ok::<_, DbError>(
                outcome
                    .map(|record| device_key_dto(record, caller_session))
                    .map_err(refusal_error),
            )
        })
    })
    .await
    .map_err(|error| ApiError::internal("device_keys.revoke", error))?;
    Ok(Json(DeviceKeyResponse {
        device_key: outcome?,
    }))
}
