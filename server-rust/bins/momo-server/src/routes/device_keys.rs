//! Device signing keys — ADR-0146 개정 2026-09-28 (R2-E2, #3022).
//!
//! ```text
//! POST /v1/workspaces/{ws}/device-keys                    (bearer, human) register
//! GET  /v1/workspaces/{ws}/device-keys                    (bearer, human) list own
//! POST /v1/workspaces/{ws}/device-keys/{key}/endorsement  (bearer, human) device_endorse.v1
//! POST /v1/workspaces/{ws}/device-keys/{key}/revocation   (bearer, human) device_revoke.v2
//! GET  /v1/workspaces/{ws}/device-keys/signing-context    (bearer, human) instance id + clock (#3023)
//! ```
//!
//! A signed-in device uploads its Secure Enclave P-256 public key. The row is
//! bound to the caller's session lineage and ends with it (logout, unlinking,
//! every member-wide session end — `crate::session_end`). A refresh-token reuse
//! ends the tokens only (#3097): the key stays, mute, until it is moved.
//!
//! * **Register.** For the caller only: the member is the bearer's, and a
//!   `memberId` naming anyone else is a 403 `device_key_member_mismatch`. A key
//!   already live in the workspace (under anyone) is a 409
//!   `device_key_already_registered`. The caller's lineage must still be able
//!   to rotate (409 `session_lineage_ended` otherwise). A `macos` key starts as
//!   a **root candidate**; an `ios` key starts **unendorsed** — 「지시 불가」 —
//!   and stays so until a root endorses it.
//! * **Rebind** (#3097, ADR-0146 D-7 증보). The same public key, live under
//!   the caller on a sign-in that can no longer rotate (a reuse or an expiry
//!   ended it without revoking the key), is a 409
//!   `device_key_rebind_required`. The device then sends the same register
//!   body with `rebind`: a `device_rebind.v1` letter the key itself signs over
//!   its id, its public key and the caller's sign-in. The row moves onto the
//!   caller's lineage (200) with its id, its endorsement and its history — no
//!   password, because the key's own signature is the proof. A stolen
//!   refresh token cannot produce it.
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
    load_device_key_in_tx, rebind_device_key_in_tx, rebindable_key_id_in_tx,
    revoke_device_key_signed_in_tx, validated_new_device_key, verify_own_password_in_tx,
    DeviceKeyRecord, DeviceKeyRefusal, DEVICE_KEY_PLATFORM_MACOS,
    REFUSAL_DEVICE_KEY_ALREADY_REGISTERED, REFUSAL_DEVICE_KEY_MEMBER_MISMATCH,
    REFUSAL_DEVICE_KEY_REBIND_REQUIRED, REFUSAL_DEVICE_ROOT_LINKED_SESSION,
    REFUSAL_DEVICE_ROOT_PASSWORD_REQUIRED, REFUSAL_SESSION_LINEAGE_ENDED,
};
use momo_auth::human_control::db_now_ms;
use momo_auth::{
    active_workspace_role, lock_live_session_lineage, session_device_label, session_id_of,
    Principal,
};
use momo_db::{with_tenant_tx, DbError};
use uuid::Uuid;

use crate::dto::{
    DeviceKeyDto, DeviceKeyListResponse, DeviceKeyResponse, EndorseDeviceKeyRequest,
    RegisterDeviceKeyRequest, RevokeDeviceKeyRequest, SigningContextResponse,
};
use crate::error::ApiError;
use crate::routes::password::admit_password_change;
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
        DeviceKeyRefusal::LineageLive => (
            StatusCode::CONFLICT,
            "this public key is already registered to a live sign-in",
        ),
        DeviceKeyRefusal::RootLinkedSession => (
            StatusCode::FORBIDDEN,
            "a root key is registered from a password sign-in on the host Mac",
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
        lineage_live: record.lineage_live,
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

fn root_password_refused() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        REFUSAL_DEVICE_ROOT_PASSWORD_REQUIRED,
        "registering a root (macos) key needs your current password",
    )
}

fn not_active() -> ApiError {
    ApiError::forbidden("not an active workspace member")
}

/// `GET /v1/workspaces/{ws}/device-keys/signing-context` → 200 (#3023).
///
/// The `instance_id` line of every `momo.human.control.v1` statement is this
/// instance's `MOMO_INSTANCE_ID`, served verbatim — the one source the
/// `host_register` check (#3022) and every signed instruction verify against;
/// a client never builds it from a URL (D-5). `serverTimeMs` is the clock the
/// ±5 min window is measured on: a device signs `issuedAtMs` from its own
/// clock plus the offset it reads here (D-9 시계 보정). 503
/// `instance_id_unconfigured` when the operator set no instance id — nothing
/// signed could verify.
pub async fn signing_context(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<SigningContextResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let token_id = principal.token_id;
    let (active, session_id) = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let active = active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_some();
            let session_id = match token_id {
                Some(id) => session_id_of(conn, id).await.map_err(DbError::from)?,
                None => None,
            };
            Ok::<_, DbError>((active, session_id))
        })
    })
    .await
    .map_err(|error| ApiError::internal("device_keys.signing_context", error))?;
    if !active {
        return Err(not_active());
    }
    let Some(instance_id) = state.device_keys.instance_id.clone() else {
        return Err(ApiError::coded(
            StatusCode::SERVICE_UNAVAILABLE,
            crate::human_control::REFUSAL_INSTANCE_ID_UNCONFIGURED,
            "this instance has no MOMO_INSTANCE_ID, so no signed statement can verify",
        ));
    };
    Ok(Json(SigningContextResponse {
        instance_id,
        server_time_ms: chrono::Utc::now().timestamp_millis(),
        max_lifetime_ms: momo_wire::human_control::MAX_LIFETIME_MS,
        max_clock_skew_ms: momo_wire::human_control::MAX_CLOCK_SKEW_MS,
        human_control_signature_required: state.device_keys.human_control_signature_required,
        host_register_signature_required: state.device_keys.host_register_signature_required,
        human_control_schema: momo_wire::human_control::HUMAN_CONTROL_SCHEMA_V3,
        session_id: session_id.map(|id| id.to_string()),
    }))
}

/// `POST /v1/workspaces/{ws}/device-keys` → 201.
pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    headers: axum::http::HeaderMap,
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
    if let Some(rebind) = request.rebind {
        return rebind_key(
            &state,
            workspace_id,
            member_id,
            token_id,
            new.public_key,
            rebind.signed_at_ms,
            rebind.signature,
        )
        .await
        .map(|dto| (StatusCode::OK, Json(DeviceKeyResponse { device_key: dto })));
    }
    // A root key (review H1). It signs host registrations and endorses
    // phones, so a bearer token alone — a stolen refresh token, say — must
    // not be able to mint one: the password is re-entered, under the same
    // per-member / per-IP budget as a password change (this is a password
    // check, and must not be a cheaper oracle than that route).
    let root_password = if new.platform == DEVICE_KEY_PLATFORM_MACOS {
        admit_password_change(&state, &headers, member_id)?;
        let password = request.current_password.filter(|p| !p.is_empty());
        Some(password.ok_or_else(root_password_refused)?)
    } else {
        None
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
            if let Some(password) = root_password.as_deref() {
                // A QR-linked session is a phone (ADR-0180): never a root.
                if session_device_label(conn, token_id)
                    .await
                    .map_err(DbError::from)?
                    .is_some()
                {
                    return Ok(Err(ApiError::coded(
                        StatusCode::FORBIDDEN,
                        REFUSAL_DEVICE_ROOT_LINKED_SESSION,
                        "a root key is registered from a password sign-in on the host Mac",
                    )));
                }
                if !verify_own_password_in_tx(conn, workspace_id, member_id, password)
                    .await
                    .map_err(DbError::from)?
                {
                    return Ok(Err(root_password_refused()));
                }
            }
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
                // #3097: the caller's own key, left live on a sign-in that
                // ended without revoking it, is moved — never registered twice.
                if rebindable_key_id_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    session_id,
                    &new.public_key,
                )
                .await
                .map_err(DbError::from)?
                .is_some()
                {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        REFUSAL_DEVICE_KEY_REBIND_REQUIRED,
                        "this key is registered to a sign-in that ended; send a device_rebind letter to move it here",
                    )));
                }
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

/// The `rebind` arm of `register` (#3097): move the caller's live key onto the
/// caller's live sign-in with the key's own `device_rebind.v1` letter.
async fn rebind_key(
    state: &AppState,
    workspace_id: Uuid,
    member_id: Uuid,
    token_id: Uuid,
    public_key: String,
    signed_at_ms: i64,
    signature: String,
) -> Result<DeviceKeyDto, ApiError> {
    let lineage_ended = || {
        ApiError::coded(
            StatusCode::CONFLICT,
            REFUSAL_SESSION_LINEAGE_ENDED,
            "this sign-in can no longer take a device key; sign in again",
        )
    };
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(Err(not_active()));
            }
            let Some(session_id) = session_id_of(conn, token_id).await.map_err(DbError::from)?
            else {
                return Ok(Err(lineage_ended()));
            };
            // The caller's lineage (token rows) first, share-locked for the
            // rest of the transaction, then the key row — the order every
            // session end takes, so a logout of this sign-in cannot commit
            // between the check and the move.
            if !lock_live_session_lineage(conn, workspace_id, member_id, session_id)
                .await
                .map_err(DbError::from)?
            {
                return Ok(Err(lineage_ended()));
            }
            let caller_linked = session_device_label(conn, token_id)
                .await
                .map_err(DbError::from)?
                .is_some();
            let now_ms = db_now_ms(conn).await.map_err(DbError::from)?;
            let outcome = rebind_device_key_in_tx(
                conn,
                workspace_id,
                member_id,
                session_id,
                caller_linked,
                &public_key,
                signed_at_ms,
                &signature,
                now_ms,
            )
            .await
            .map_err(DbError::from)?;
            Ok::<_, DbError>(
                outcome
                    .map(|record| device_key_dto(record, Some(session_id)))
                    .map_err(refusal_error),
            )
        })
    })
    .await
    .map_err(|error| ApiError::internal("device_keys.rebind", error))?;
    outcome
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
