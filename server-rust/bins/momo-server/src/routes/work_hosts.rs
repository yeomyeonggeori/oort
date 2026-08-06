//! Work-host registry (ADR-0125 D1/D8) — Swift `WorkHostRoutes.swift` parity.
//!
//! ```text
//! POST   /v1/workspaces/{ws}/work-hosts                      (bearer, human)
//! GET    /v1/workspaces/{ws}/work-hosts                      (bearer, human)
//! DELETE /v1/workspaces/{ws}/work-hosts/{host}               (bearer, human)
//! POST   /v1/workspaces/{ws}/work-hosts/{host}/heartbeat     (PUBLIC, signed)
//! ```
//!
//! ## Measured: registration is direct, not a token exchange
//!
//! The packet asked which of the two this route is. It is **direct**: the caller
//! supplies the Ed25519 public key its host generated and the server stores it
//! (`register` :143-154). The one-shot *bootstrap token* flow is a different
//! surface entirely — `CloudProvisionerRoutes.enroll` mints the token and
//! `.../work-hosts/cloud/register` spends it (see [`super::cloud_hosts`]). Both
//! end at a `work_host` row; only the cloud path has a token.
//!
//! ## Measured: heartbeat sits OUTSIDE the auth middleware
//!
//! Swift mounts it via `addPublic` (:116-118) while every other host route goes
//! through `addProtected` (:94-110), and the handler resolves no principal: a
//! daemon holds no bearer token, only its signing key. The route is mounted here
//! the same way — outside [`crate::auth::require_principal`] — and its whole
//! authorization is: the row exists, is unrevoked, and the Ed25519 signature
//! over `momo.work_host.heartbeat.v1` verifies under the *stored* key, all under
//! one `FOR UPDATE` so a concurrent revoke cannot be raced. Every failure is the
//! same 401 sentence, so the route tells an attacker nothing about which check
//! failed.
//!
//! ## The signed poll (#1114)
//!
//! `GET .../{host}/pending-controls` (:97-100) is a **work-host-signed** route:
//! Swift's handler begins `guard principal.kind == .workHost`. B2.2 left it out
//! because `auth.rs` had no `MomoHost` branch; it has one now, so the route is
//! mounted on the same protected router as its Swift twin and reads its
//! principal the ordinary way. Its whole authorization is that the signature
//! verified (`work_host_auth`) and that the path names **that** host in **that**
//! workspace — a host may poll only its own queue.
//!
//! ## Still not served (deliberate, named)
//!
//! `GET .../{host}/live-sessions` (:101-104) and `POST .../{host}/reconcile`
//! (:105-108) are signed the same way and remain unported: they serve MOMO-656
//! restart reconciliation, which is a different goal with its own sweep
//! semantics (`host_lost_at`). `work_host_auth::is_allowed_signed_path` still
//! refuses both, so neither is an authenticated 404.

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::{
    active_workspace_role, heartbeat_timestamp_is_fresh, insert_work_host, list_work_hosts,
    load_work_host, lock_work_host_credential, lock_work_host_ownership, mark_work_host_revoked,
    normalize_public_key_b64, touch_work_host_last_seen, verify_work_host_heartbeat, NewWorkHost,
    Principal, WorkHostRecord,
};
use momo_db::{with_tenant_tx, DbError};
use momo_wire::{
    record_provenance, EntityRef, ProvenanceError, SignedAction, Signer, ENTITY_WORK_HOST_HEARTBEAT,
};

use crate::dto::{
    PendingWorkControlsResponse, RegisterWorkHostRequest, WorkHostDto, WorkHostHeartbeatRequest,
    WorkHostListResponse, WorkHostResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, require_human, settle, tenant_tx, workspace_scope};
use crate::routes::work_controls::control_dto;
use crate::AppState;

/// The 401 every heartbeat failure answers with — unknown host, revoked host,
/// bad signature and stale clock are indistinguishable on the wire
/// (Swift `heartbeatUnauthorized`, :630-632).
fn heartbeat_unauthorized() -> ApiError {
    ApiError::unauthorized("invalid work host heartbeat signature")
}

pub(crate) fn validated_scope(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim().to_lowercase();
    if value == "member" || value == "workspace" {
        Ok(value)
    } else {
        Err(ApiError::bad_request("scope must be member or workspace"))
    }
}

pub(crate) fn validated_type(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim().to_lowercase();
    if ["app", "workd", "cloud"].contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(ApiError::bad_request("type must be app, workd, or cloud"))
    }
}

pub(crate) fn validated_display_name(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim().to_string();
    let length = value.chars().count();
    if (1..=80).contains(&length) {
        Ok(value)
    } else {
        Err(ApiError::bad_request(
            "displayName must contain 1...80 characters",
        ))
    }
}

pub(crate) fn validated_public_key(raw: &str) -> Result<String, ApiError> {
    normalize_public_key_b64(raw).ok_or_else(|| {
        ApiError::bad_request("publicKey must be a 32-byte Ed25519 raw key in base64")
    })
}

/// Boolean availability flags only, at most 64, with conservative keys
/// (Swift `validatedCapabilities`, :564-579).
///
/// Serialized from a `BTreeMap`, so the stored JSON has sorted keys exactly like
/// Swift's `.sortedKeys` — two servers writing the same capability set produce
/// the same bytes.
pub(crate) fn validated_capabilities(
    raw: Option<&BTreeMap<String, bool>>,
) -> Result<String, ApiError> {
    let empty = BTreeMap::new();
    let capabilities = raw.unwrap_or(&empty);
    if capabilities.len() > 64 {
        return Err(ApiError::bad_request(
            "capabilities accepts at most 64 boolean flags",
        ));
    }
    for key in capabilities.keys() {
        let length = key.chars().count();
        let valid = (1..=64).contains(&length)
            && key.chars().all(|character| {
                character.is_ascii()
                    && (character.is_ascii_alphanumeric() || ".-_".contains(character))
            });
        if !valid {
            return Err(ApiError::bad_request(
                "capability keys must be 1...64 ASCII letters, digits, dot, underscore, or dash",
            ));
        }
    }
    Ok(serde_json::to_string(capabilities).unwrap_or_else(|_| "{}".to_string()))
}

/// `WorkHostRecord` → wire DTO. A capabilities column that does not parse is a
/// 500 with Swift's wording (:714-721), never a silently emptied object.
pub(crate) fn work_host_dto(record: WorkHostRecord) -> Result<WorkHostDto, ApiError> {
    let capabilities = serde_json::from_str(&record.capabilities_json)
        .map_err(|_| ApiError::internal("work_hosts.decode", "work host JSON decoding failed"))?;
    Ok(WorkHostDto {
        id: record.id.to_string(),
        workspace_id: record.workspace_id.to_string(),
        scope: record.scope,
        owner_member_id: record.owner_member_id.to_string(),
        host_type: record.host_type,
        display_name: record.display_name,
        public_key: record.public_key,
        capabilities,
        last_seen_at_ms: record.last_seen_at_ms,
        revoked_at_ms: record.revoked_at_ms,
        created_at_ms: record.created_at_ms,
        online: record.online,
    })
}

/// `POST /v1/workspaces/{ws}/work-hosts` → 201 (Swift `register`, :120-188).
pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RegisterWorkHostRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_human(&principal, "work host management requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let new = NewWorkHost {
        scope: validated_scope(&request.scope)?,
        owner_member_id: principal.member_id,
        host_type: validated_type(&request.host_type)?,
        display_name: validated_display_name(&request.display_name)?,
        public_key: validated_public_key(&request.public_key)?,
        capabilities_json: validated_capabilities(request.capabilities.as_ref())?,
        seen_now: false,
    };

    let member_id = principal.member_id;
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // Membership is checked inside the same transaction as the insert
            // (Swift :138-142): a member removed mid-flight cannot register.
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(None);
            }
            let host_id = insert_work_host(conn, workspace_id, &new).await?;
            let record = load_work_host(conn, host_id).await?;
            Ok::<_, DbError>(Some(record))
        })
    })
    .await
    .map_err(|error| ApiError::internal("work_hosts.register", error))?;

    let record = outcome
        .ok_or_else(|| ApiError::forbidden("not an active workspace member"))?
        .ok_or_else(|| ApiError::internal("work_hosts.register", "work host reload failed"))?;
    Ok((
        StatusCode::CREATED,
        Json(WorkHostResponse {
            work_host: work_host_dto(record)?,
        }),
    ))
}

/// `GET /v1/workspaces/{ws}/work-hosts` (Swift `list`, :190-216).
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<WorkHostListResponse>, ApiError> {
    require_human(&principal, "work host management requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let records = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_none()
            {
                return Ok(None);
            }
            Ok::<_, DbError>(Some(list_work_hosts(conn).await?))
        })
    })
    .await
    .map_err(|error| ApiError::internal("work_hosts.list", error))?
    .ok_or_else(|| ApiError::forbidden("not an active workspace member"))?;

    Ok(Json(WorkHostListResponse {
        work_hosts: records
            .into_iter()
            .map(work_host_dto)
            .collect::<Result<Vec<_>, _>>()?,
    }))
}

/// `GET /v1/workspaces/{ws}/work-hosts/{host}/pending-controls` (Swift
/// `pendingControls`, :280-322) — the daemon's queue.
///
/// This route is the half of the spawn closed loop that #1132 had to leave open:
/// a control could reach `dispatched`, and the room was told, but the host had
/// no way to *learn* it. Everything after — running the tool, acknowledging,
/// binding the session — hangs off this read.
///
/// Authorization is three facts and nothing else, all of them already proven or
/// checked before a row is read:
///   * the caller signed as a work host (`PrincipalKind::WorkHost` — only
///     [`crate::auth::require_principal`]'s signed branch installs one);
///   * the `{ws}` in the path is the workspace that signature was verified in;
///   * the `{host}` in the path is the signer.
///
/// The last two are redundant with the authenticator today (it pins both), and
/// they are written anyway: they are the checks that stay correct if the pin
/// ever moves, and a route that reads a queue must be able to state whose queue
/// it is without deferring to a module.
pub async fn pending_controls(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, host)): Path<(String, String)>,
) -> Result<Json<PendingWorkControlsResponse>, ApiError> {
    if principal.kind != momo_auth::PrincipalKind::WorkHost {
        return Err(ApiError::forbidden(
            "pending controls require work host signature",
        ));
    }
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let host_id = path_uuid(&host, "invalid work host id")?;
    if Some(host_id) != principal.token_id {
        // A host asking for another host's queue learns only that its signature
        // was fine — the same sentence a bad signature gets.
        return Err(crate::work_host_auth::signed_request_unauthorized());
    }

    let controls = settle(
        "work_hosts.pending_controls",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(momo_t3::pending_controls_for_host_in_tx(
                    conn,
                    workspace_id,
                    host_id,
                )
                .await?))
            })
        })
        .await,
    )?;

    Ok(Json(PendingWorkControlsResponse {
        work_controls: controls.into_iter().map(control_dto).collect(),
    }))
}

/// `DELETE /v1/workspaces/{ws}/work-hosts/{host}` (Swift `revoke`, :460-528).
///
/// Owner **or** workspace admin, idempotent: revoking twice keeps the first
/// timestamp and answers 200 with the same row.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, host)): Path<(String, String)>,
) -> Result<Json<WorkHostResponse>, ApiError> {
    require_human(&principal, "work host management requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let host_id = path_uuid(&host, "invalid work host id")?;
    let member_id = principal.member_id;

    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let Some(role) = active_workspace_role(conn, workspace_id, member_id).await? else {
                return Ok(Err(ApiError::forbidden("not a workspace member")));
            };
            let Some(ownership) = lock_work_host_ownership(conn, host_id).await? else {
                return Ok(Err(ApiError::not_found("work host not found")));
            };
            if ownership.owner_member_id != member_id && !role.is_admin() {
                return Ok(Err(ApiError::forbidden(
                    "work host revoke requires owner or workspace admin",
                )));
            }
            mark_work_host_revoked(conn, host_id).await?;
            Ok::<_, DbError>(Ok(load_work_host(conn, host_id).await?))
        })
    })
    .await
    .map_err(|error| ApiError::internal("work_hosts.revoke", error))?;

    let record = outcome?
        .ok_or_else(|| ApiError::internal("work_hosts.revoke", "work host reload failed"))?;
    Ok(Json(WorkHostResponse {
        work_host: work_host_dto(record)?,
    }))
}

/// `POST /v1/workspaces/{ws}/work-hosts/{host}/heartbeat` — PUBLIC, signed
/// (Swift `heartbeat`, :218-278).
///
/// Note the order, which is Swift's: the clock window is checked *before* the
/// database is touched, so a flood of stale heartbeats costs no row lock; then
/// the row is locked, the signature verified against the stored key, and only
/// then is `last_seen_at` stamped. Every rejection is the same 401.
///
/// ## Provenance (ADR-0146, B2.5)
///
/// This is one of exactly **two** places in this server where an Ed25519
/// signature from an actor actually arrives (the other is
/// [`crate::work_host_auth`]'s v2 request signature). Measured, not assumed:
/// `register`/`revoke` above are bearer-authenticated humans, and the cloud
/// register path spends a bootstrap token — none of the three carries a
/// signature, so none of them can be given provenance without a human device key
/// (fast-follow). So the heartbeat is wired, and the wiring is *additive*: the
/// signature was already verified for authentication, and `record_provenance`
/// re-derives the same bytes and stores the proof. The liveness stamp is the
/// host-signature-induced state transition ADR-0146 §범위 3 names, and it is the
/// only one this build has.
///
/// The record is written **after** `touch_work_host_last_seen`, in the same
/// transaction: a host revoked mid-flight leaves neither a stamp nor a
/// provenance row.
pub async fn heartbeat(
    State(state): State<AppState>,
    Path((workspace, host)): Path<(String, String)>,
    Json(request): Json<WorkHostHeartbeatRequest>,
) -> Result<Json<WorkHostResponse>, ApiError> {
    // No principal: a daemon holds a signing key, never a bearer token, so the
    // workspace comes from the path and is validated as a UUID only. RLS still
    // confines every statement below to it.
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;
    let host_id = path_uuid(&host, "invalid work host id")?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    if !heartbeat_timestamp_is_fresh(request.sent_at_ms, now_ms) {
        return Err(heartbeat_unauthorized());
    }

    let sent_at_ms = request.sent_at_ms;
    let signature = request.signature.clone();
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let Some(credential) = lock_work_host_credential(conn, host_id).await? else {
                return Ok(None);
            };
            if !credential.active
                || !verify_work_host_heartbeat(
                    &credential.public_key,
                    &signature,
                    workspace_id,
                    host_id,
                    sent_at_ms,
                )
            {
                return Ok(None);
            }
            if !touch_work_host_last_seen(conn, host_id).await? {
                return Ok(None);
            }
            // ADR-0146: the same verified signature, recorded as provenance.
            // A re-presented heartbeat inside the skew window hits
            // `action_signature_signature_uniq` and records once, not twice.
            let action = SignedAction::WorkHostHeartbeat {
                workspace_id,
                host_id,
                sent_at_ms,
            };
            match record_provenance(
                conn,
                workspace_id,
                &EntityRef::new(ENTITY_WORK_HOST_HEARTBEAT, host_id),
                // A host is not a member: the signer is its stored key, and
                // attributing this to the owning human would be a false record.
                &Signer::work_host(&credential.public_key),
                &signature,
                &action,
            )
            .await
            {
                Ok(_) => {}
                // Unreachable while the two verifications agree, and it must
                // stay unreachable: if it ever fires, the heartbeat answers the
                // same indistinguishable 401 rather than 500ing or — worse —
                // stamping liveness for a signature the sidecar refused.
                Err(ProvenanceError::SignatureRejected { .. }) => return Ok(None),
                Err(ProvenanceError::Db(error)) => return Err(DbError::from(error)),
            }
            Ok::<_, DbError>(load_work_host(conn, host_id).await?)
        })
    })
    .await
    .map_err(|error| ApiError::internal("work_hosts.heartbeat", error))?;

    let record = outcome.ok_or_else(heartbeat_unauthorized)?;
    Ok(Json(WorkHostResponse {
        work_host: work_host_dto(record)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_and_type_are_closed_vocabularies() {
        assert_eq!(validated_scope(" Workspace ").unwrap(), "workspace");
        assert_eq!(validated_scope("member").unwrap(), "member");
        assert_eq!(
            validated_scope("everyone").unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(validated_type("CLOUD").unwrap(), "cloud");
        assert!(validated_type("vm").is_err());
    }

    #[test]
    fn display_name_bounds_match_the_check_constraint() {
        assert!(validated_display_name("  ").is_err());
        assert_eq!(validated_display_name(" box ").unwrap(), "box");
        assert!(validated_display_name(&"x".repeat(80)).is_ok());
        assert!(validated_display_name(&"x".repeat(81)).is_err());
    }

    #[test]
    fn capabilities_are_sorted_boolean_flags_only() {
        let mut capabilities = BTreeMap::new();
        capabilities.insert("terminal_attach".to_string(), true);
        capabilities.insert("a.b-c".to_string(), false);
        let json = validated_capabilities(Some(&capabilities)).unwrap();
        assert_eq!(json, r#"{"a.b-c":false,"terminal_attach":true}"#);
        assert_eq!(validated_capabilities(None).unwrap(), "{}");

        let mut bad_key = BTreeMap::new();
        bad_key.insert("has space".to_string(), true);
        assert!(validated_capabilities(Some(&bad_key)).is_err());

        let mut too_many = BTreeMap::new();
        for index in 0..65 {
            too_many.insert(format!("k{index}"), true);
        }
        assert!(validated_capabilities(Some(&too_many)).is_err());
    }

    #[test]
    fn every_heartbeat_failure_is_the_same_401() {
        let error = heartbeat_unauthorized();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "invalid work host heartbeat signature");
    }
}
