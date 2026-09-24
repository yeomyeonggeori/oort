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
//! the same way — outside [`crate::auth::require_principal`] — and authenticates
//! inside the handler, exactly like `terminal_attach::validate`.
//!
//! ## ADR-0188 R0.1: the scope is not the registrant's free choice
//!
//! Every ADR-0188 R0 defence — the owner as sole decider, an agent's `kill`
//! only, no standing auto-approval, no shell — keys on `scope = 'member'` (「원격
//! host = `scope='member'`인 모든 host」). A registration that let anybody
//! call their own laptop a team box would therefore switch R0 off from the
//! request body. So `register` refuses two shapes by name, before anything is
//! written (#2582):
//!
//! * `scope = "workspace"` from a member who is not a workspace owner/admin —
//!   403 `error.code: workspace_host_admin_required`. A team host is the
//!   workspace's to add, the same line BYOC enrolment already draws;
//! * `type = "app"` with any scope but `member` — 400 `error.code:
//!   app_host_member_scope_required`, from anybody. An `app` host is the desktop
//!   app on its owner's own machine (tier `local`): a remote host whatever it
//!   calls itself. Refused rather than quietly rewritten, so the scope a client
//!   sent is never silently not the scope it got.
//!
//! Registration only: a row written before this rule keeps the scope it has
//! (an owner or admin can revoke it).
//!
//! ## ADR-0188 D7 (R0): the heartbeat is a v2 signed request
//!
//! It used to sign its own v1 payload, `momo.work_host.heartbeat.v1\n{ws}\n
//! {host}\n{sentAtMs}`, with no request id: freshness was the ±5 minute skew
//! window and nothing else, so one captured heartbeat could be re-sent for five
//! minutes and keep a dead host looking alive — long enough for a phone to hand
//! work to a laptop that is gone. It is now an ordinary signed host request
//! ([`crate::work_host_auth`]): `momo.work_host.request.v2` over method, raw
//! path, workspace, host, clock, **body digest** and a **request id consumed
//! exactly once**, with no query string. v1 is not accepted: a request without
//! the `MomoHost` headers never reaches a verifier. Every failure is still the
//! same 401 sentence as every other signed request.
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

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::{
    active_workspace_role, insert_work_host, list_work_hosts, load_work_host,
    lock_work_host_ownership, mark_work_host_revoked, normalize_public_key_b64,
    touch_work_host_last_seen, NewWorkHost, Principal, WorkHostRecord,
};
use momo_db::{with_tenant_tx, DbError};
use momo_t3::work_control::{
    REFUSAL_APP_HOST_MEMBER_SCOPE_REQUIRED, REFUSAL_WORKSPACE_HOST_ADMIN_REQUIRED,
};
use momo_wire::{
    record_provenance, EntityRef, ProvenanceError, Signer, ENTITY_WORK_HOST_HEARTBEAT,
};
use uuid::Uuid;

use crate::dto::{
    PendingWorkControlsResponse, RegisterWorkHostRequest, WorkHostDto, WorkHostListResponse,
    WorkHostResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, require_human, settle, tenant_tx, workspace_scope};
use crate::routes::work_controls::control_dto;
use crate::work_host_auth::{
    authenticate_signed_host_request, signed_request_unauthorized, MAX_SIGNED_BODY_BYTES,
};
use crate::AppState;

/// The rollback a heartbeat asks for when the provenance chokepoint refuses a
/// signature the authenticator accepted.
///
/// Unreachable while the two verifications agree (they check the same v2 bytes
/// under the same stored key), and it must stay unreachable. If it ever fires,
/// the liveness stamp written a statement earlier has to go too — an `Ok` would
/// commit it — so the transaction is failed with this sentinel and
/// [`heartbeat`] answers the ordinary signed-request 401 rather than a 500.
/// Namespaced and versioned so no genuine driver error can be mistaken for it.
const HEARTBEAT_PROVENANCE_REFUSED: &str = "momo.work_hosts.heartbeat_provenance_refused.v1";

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

/// ADR-0188 R0.1 — an `app` host is always a remote host: it registers
/// member-scoped or not at all (see the module docs). Pure, so it is judged with
/// the other shape checks, before any row is read.
pub(crate) fn validated_scope_for_type(scope: &str, host_type: &str) -> Result<(), ApiError> {
    if host_type == "app" && scope != "member" {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            REFUSAL_APP_HOST_MEMBER_SCOPE_REQUIRED,
            "an app work host is its owner's own machine and registers member-scoped",
        ));
    }
    Ok(())
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

/// `POST /v1/workspaces/{ws}/work-hosts` → 201 (Swift `register`, :120-188),
/// narrowed by ADR-0188 R0.1: a workspace-scoped host needs a workspace
/// owner/admin, and an `app` host is member-scoped (module docs).
pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RegisterWorkHostRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_human(&principal, "work host management requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let scope = validated_scope(&request.scope)?;
    let host_type = validated_type(&request.host_type)?;
    validated_scope_for_type(&scope, &host_type)?;
    let new = NewWorkHost {
        scope,
        owner_member_id: principal.member_id,
        host_type,
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
            // So is the role, for the same reason — an admin demoted mid-flight
            // cannot add a team host on the strength of the role they had.
            let Some(role) = active_workspace_role(conn, workspace_id, member_id).await? else {
                return Ok(Err(ApiError::forbidden("not an active workspace member")));
            };
            if new.scope == "workspace" && !role.is_admin() {
                return Ok(Err(ApiError::coded(
                    StatusCode::FORBIDDEN,
                    REFUSAL_WORKSPACE_HOST_ADMIN_REQUIRED,
                    "a workspace-scoped work host requires a workspace owner or admin",
                )));
            }
            let host_id = insert_work_host(conn, workspace_id, &new).await?;
            Ok::<_, DbError>(Ok(load_work_host(conn, host_id).await?))
        })
    })
    .await
    .map_err(|error| ApiError::internal("work_hosts.register", error))?;

    let record = outcome?
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
///
/// *What* the queue holds is the ledger's answer, not this route's: on a
/// member-scoped host it withholds every non-`kill` control its owner did not
/// request, and every shell (ADR-0188 R0.1 —
/// [`momo_t3::pending_controls_for_host_in_tx`]).
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

/// `POST /v1/workspaces/{ws}/work-hosts/{host}/heartbeat` — PUBLIC, signed v2
/// (Swift `heartbeat`, :218-278; ADR-0188 D7).
///
/// The order is the authenticator's: the query rule, the allow-list, the header
/// shape and the clock window are all judged **before** the database, so a flood
/// of stale or malformed heartbeats costs no query; then the stored key verifies
/// the v2 signature and the request id is consumed, in one transaction. Only
/// after that is `last_seen_at` stamped — guarded on `revoked_at IS NULL`, so a
/// revoke that lands between the two transactions still wins. Every rejection is
/// the same 401 as every other signed host request.
///
/// The body carries nothing the server reads: liveness is the fact of a fresh,
/// signed, never-seen request. Whatever bytes are sent are covered by the
/// signature's body digest, and an empty body is the normal case.
///
/// ## Provenance (ADR-0146, B2.5)
///
/// One of the places in this server where an actor's Ed25519 signature
/// arrives. The v2 signature was already verified for authentication, and
/// `record_provenance` re-derives the same bytes and stores the proof under
/// `work_host.heartbeat` — the same entity the v1 heartbeat recorded, now over
/// `momo.work_host.request.v2` bytes (a fresh request id per beat, so every beat
/// is its own row rather than a v1 signature re-presented inside the window).
/// The liveness stamp is the host-signature-induced state transition ADR-0146
/// §범위 3 names.
///
/// The record is written **after** `touch_work_host_last_seen`, in the same
/// transaction: a host revoked mid-flight leaves neither a stamp nor a
/// provenance row.
pub async fn heartbeat(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    Path((workspace, host)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WorkHostResponse>, ApiError> {
    if body.len() > MAX_SIGNED_BODY_BYTES {
        return Err(signed_request_unauthorized());
    }
    // No principal: a daemon holds a signing key, never a bearer token, so the
    // workspace comes from the path. An id that does not parse cannot have been
    // signed, so it answers the signature 401 rather than a 400 — the caller
    // learns nothing either way (the `terminal_attach::validate` rule).
    let (Ok(workspace_id), Ok(host_id)) = (Uuid::parse_str(&workspace), Uuid::parse_str(&host))
    else {
        return Err(signed_request_unauthorized());
    };

    let signed =
        authenticate_signed_host_request(&state, &method, &uri, &headers, &body, workspace_id)
            .await?;
    // The authenticator pins the signer to the `{host}` segment of this path
    // (`scoped_host_id_from_path`). Restated because a route that stamps a host
    // alive must be able to say which host without deferring to a module.
    if signed.host_id != host_id {
        return Err(signed_request_unauthorized());
    }
    let signature = signed.signature;

    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !touch_work_host_last_seen(conn, host_id).await? {
                return Ok(None);
            }
            // ADR-0146: the same verified signature, recorded as provenance.
            match record_provenance(
                conn,
                workspace_id,
                &EntityRef::new(ENTITY_WORK_HOST_HEARTBEAT, host_id),
                // A host is not a member: the signer is its stored key, and
                // attributing this to the owning human would be a false record.
                &Signer::work_host(&signature.signer_pubkey_b64),
                &signature.signature_b64,
                &signature.action(workspace_id, host_id),
            )
            .await
            {
                Ok(_) => {}
                Err(ProvenanceError::SignatureRejected { .. }) => {
                    return Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                        HEARTBEAT_PROVENANCE_REFUSED.to_string(),
                    )));
                }
                Err(ProvenanceError::Db(error)) => return Err(DbError::from(error)),
            }
            Ok::<_, DbError>(load_work_host(conn, host_id).await?)
        })
    })
    .await;

    let record = match outcome {
        Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(ref message)))
            if message == HEARTBEAT_PROVENANCE_REFUSED =>
        {
            return Err(signed_request_unauthorized());
        }
        outcome => outcome.map_err(|error| ApiError::internal("work_hosts.heartbeat", error))?,
    }
    // `None`: revoked between the authentication and the stamp.
    .ok_or_else(signed_request_unauthorized)?;
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

    /// ADR-0188 R0.1: an `app` host is a remote host whatever scope it asks
    /// for — refused by name with a code, not rewritten. Every other type keeps
    /// both scopes here; who may pick `workspace` is the handler's role check.
    #[test]
    fn an_app_host_registers_member_scoped_or_not_at_all() {
        let refused = validated_scope_for_type("workspace", "app").unwrap_err();
        assert_eq!(refused.status, StatusCode::BAD_REQUEST);
        assert_eq!(refused.code, Some("app_host_member_scope_required"));
        assert!(validated_scope_for_type("member", "app").is_ok());
        for host_type in ["workd", "cloud"] {
            for scope in ["member", "workspace"] {
                assert!(
                    validated_scope_for_type(scope, host_type).is_ok(),
                    "{host_type}/{scope}"
                );
            }
        }
        // It judges the **normalised** values the validators return.
        assert_eq!(
            validated_scope_for_type(
                &validated_scope(" Workspace ").unwrap(),
                &validated_type("APP").unwrap()
            )
            .unwrap_err()
            .code,
            Some(REFUSAL_APP_HOST_MEMBER_SCOPE_REQUIRED)
        );
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

    /// ADR-0188 D7: a heartbeat fails the way every signed host request fails
    /// — one 401 sentence, whichever check refused it — and its rollback
    /// sentinel is namespaced so no driver error reads as it.
    #[test]
    fn every_heartbeat_failure_is_the_signed_request_401() {
        let error = signed_request_unauthorized();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "invalid work host request signature");
        assert!(HEARTBEAT_PROVENANCE_REFUSED.starts_with("momo.work_hosts."));
        assert!(HEARTBEAT_PROVENANCE_REFUSED.ends_with(".v1"));
    }
}
