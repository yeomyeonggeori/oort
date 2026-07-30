//! Signed work-host **request** authentication (MOMO-657 / migration 048),
//! ported from Swift `Auth/WorkHostAuthenticator.swift`.
//!
//! ## Why this is a route-scoped function and not a middleware
//!
//! Swift runs this as an authenticator over an allow-listed set of eight paths.
//! Only one of those eight has a handler in this server (`…/work-hosts/{host}/
//! terminal-attach/validate`), so mounting it as a middleware would advertise an
//! authentication surface for seven routes that answer 404 — and the day one of
//! them lands, its author would inherit an authenticator they never read. It is
//! therefore a function the one route that needs it calls explicitly, with
//! [`is_allowed_signed_path`] still holding Swift's allow-list shape so adding
//! the next route is a one-line, visible decision.
//!
//! The **unported seven** (each already refused by absence, listed so the gap is
//! named rather than discovered): `GET …/work-hosts/{host}/pending-controls`,
//! `GET …/work-hosts/{host}/live-sessions`, `POST …/work-hosts/{host}/reconcile`,
//! `GET …/work-tool-profiles`, `POST …/work-sessions`,
//! `PATCH …/work-sessions/{session}`, `POST …/work-controls/{control}/ack`.
//!
//! ## The check, in Swift's order (`:29-125`)
//!
//! 1. the path/method is allow-listed — before anything is parsed;
//! 2. `Authorization: MomoHost <hostId>` parses, and equals the `{host}` in the
//!    path (`scopedHostID`, :56-60) — a host may only act as itself;
//! 3. the three `X-Momo-Work-Host-*` headers parse;
//! 4. the timestamp is inside the ±5 minute window — checked **before** the
//!    database, so a flood of stale requests costs no query;
//! 5. the host row exists, is unrevoked, and its owner is still an active human;
//! 6. the Ed25519 signature verifies over the v2 payload, which binds method,
//!    path, workspace, host, timestamp, **the raw body's SHA-256**, and the
//!    request id;
//! 7. the request id is consumed exactly once — the replay barrier.
//!
//! Every failure is the same 401 with the same sentence, so the response tells
//! an attacker nothing about which check failed.

use axum::http::{HeaderMap, Method};
use momo_auth::{
    consume_work_host_request_id, heartbeat_timestamp_is_fresh, load_work_host_signing_credential,
    verify_work_host_request,
};
use momo_db::{with_tenant_tx, DbError};
use uuid::Uuid;

use crate::error::ApiError;
use crate::AppState;

/// `WorkHostAuthenticator.sentAtHeader` (:21). Axum lowercases header names.
const SENT_AT_HEADER: &str = "x-momo-work-host-sent-at";
/// `WorkHostAuthenticator.signatureHeader` (:22).
const SIGNATURE_HEADER: &str = "x-momo-work-host-signature";
/// `WorkHostAuthenticator.requestIDHeader` (:23).
const REQUEST_ID_HEADER: &str = "x-momo-work-host-request-id";
/// `WorkHostAuthenticator.maximumSignedBodyBytes` (:24) — 1 MiB. A body larger
/// than this is refused rather than hashed, so an unauthenticated caller cannot
/// make the server digest arbitrary volume.
pub(crate) const MAX_SIGNED_BODY_BYTES: usize = 1_048_576;

/// The 401 every signed-request failure answers with (`unauthorized`, :299-301).
pub(crate) fn signed_request_unauthorized() -> ApiError {
    ApiError::unauthorized("invalid work host request signature")
}

/// A verified host identity. Named rather than a bare `Uuid` so a handler cannot
/// mistake "the host in the path" for "the host that signed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedHostRequest {
    pub workspace_id: Uuid,
    pub host_id: Uuid,
    pub owner_member_id: Uuid,
}

/// `hostID(fromAuthorization:)` (:277-281): `MomoHost <uuid>`, scheme compared
/// case-insensitively.
pub(crate) fn host_id_from_authorization(raw: &str) -> Option<Uuid> {
    let (scheme, value) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("momohost") {
        return None;
    }
    Uuid::parse_str(value.trim()).ok()
}

/// Swift `isAllowed(method:path:)` (:186-275), reduced to the paths this server
/// actually serves — see the module docs for the seven that are not ported.
pub(crate) fn is_allowed_signed_path(method: &Method, path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    method == Method::POST
        && segments.len() == 7
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "work-hosts"
        && segments[5] == "terminal-attach"
        && segments[6] == "validate"
}

/// Authenticate a signed host request, returning the verified identity.
///
/// `path` must be the **raw request path** (`Uri::path()`), because it is inside
/// the signature: reconstructing it from route parameters would re-encode it and
/// silently invalidate every signature from a host that spelled it differently.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn authenticate_signed_host_request(
    state: &AppState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    body: &[u8],
    workspace_id: Uuid,
    path_host_id: Uuid,
) -> Result<SignedHostRequest, ApiError> {
    if !is_allowed_signed_path(method, path) {
        return Err(signed_request_unauthorized());
    }
    if body.len() > MAX_SIGNED_BODY_BYTES {
        return Err(signed_request_unauthorized());
    }

    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let Some(host_id) = header("authorization").and_then(host_id_from_authorization) else {
        return Err(signed_request_unauthorized());
    };
    // A host may only ever act as itself (`scopedHostID`, :56-60).
    if host_id != path_host_id {
        return Err(signed_request_unauthorized());
    }
    let (Some(sent_at_ms), Some(signature), Some(request_id)) = (
        header(SENT_AT_HEADER).and_then(|raw| raw.parse::<i64>().ok()),
        header(SIGNATURE_HEADER).map(str::to_string),
        header(REQUEST_ID_HEADER).and_then(|raw| Uuid::parse_str(raw).ok()),
    ) else {
        return Err(signed_request_unauthorized());
    };

    // Clock window before the database (`validateTimestamp`, :51).
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    if !heartbeat_timestamp_is_fresh(sent_at_ms, now_ms) {
        return Err(signed_request_unauthorized());
    }

    let body_digest = momo_wire::signing::sha256_hex(body);
    let method_text = method.as_str().to_string();
    let path_text = path.to_string();

    // Verification and consumption share ONE transaction: a signature that
    // verifies but whose id could not be consumed must not authorize anything,
    // and an id consumed for a request that then failed verification would burn
    // a legitimate retry.
    let identity = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let Some(credential) =
                load_work_host_signing_credential(conn, workspace_id, host_id).await?
            else {
                return Ok(None);
            };
            if !verify_work_host_request(
                &credential.public_key,
                &signature,
                &method_text,
                &path_text,
                workspace_id,
                host_id,
                sent_at_ms,
                &body_digest,
                request_id,
            ) {
                return Ok(None);
            }
            if !consume_work_host_request_id(conn, workspace_id, host_id, request_id).await? {
                return Ok(None);
            }
            Ok::<_, DbError>(Some(SignedHostRequest {
                workspace_id,
                host_id,
                owner_member_id: credential.owner_member_id,
            }))
        })
    })
    .await
    .map_err(|error| ApiError::internal("work_host_auth.verify", error))?;

    identity.ok_or_else(signed_request_unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_scheme_is_momohost_and_case_insensitive() {
        let host = Uuid::from_u128(42);
        assert_eq!(
            host_id_from_authorization(&format!("MomoHost {host}")),
            Some(host)
        );
        assert_eq!(
            host_id_from_authorization(&format!("momohost {host}")),
            Some(host)
        );
        assert_eq!(host_id_from_authorization(&format!("Bearer {host}")), None);
        assert_eq!(host_id_from_authorization("MomoHost not-a-uuid"), None);
        assert_eq!(host_id_from_authorization("MomoHost"), None);
    }

    #[test]
    fn only_the_validate_path_is_signable_in_this_batch() {
        let ws = Uuid::from_u128(1);
        let host = Uuid::from_u128(2);
        let validate = format!("/v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate");
        assert!(is_allowed_signed_path(&Method::POST, &validate));
        // Method is part of the signed payload, and of the allow-list.
        assert!(!is_allowed_signed_path(&Method::GET, &validate));
        // The seven Swift allow-lists that have no handler here must NOT be
        // signable: an authenticated 404 would be a promise this server cannot
        // keep.
        for unported in [
            format!("/v1/workspaces/{ws}/work-hosts/{host}/pending-controls"),
            format!("/v1/workspaces/{ws}/work-hosts/{host}/live-sessions"),
            format!("/v1/workspaces/{ws}/work-hosts/{host}/reconcile"),
            format!("/v1/workspaces/{ws}/work-tool-profiles"),
            format!("/v1/workspaces/{ws}/work-sessions"),
            format!("/v1/workspaces/{ws}/work-controls/{host}/ack"),
        ] {
            assert!(
                !is_allowed_signed_path(&Method::POST, &unported),
                "{unported} has no handler in this server"
            );
        }
        // Shape guards: a shorter or longer path never matches by accident.
        assert!(!is_allowed_signed_path(
            &Method::POST,
            &format!("/v1/workspaces/{ws}/work-hosts/{host}/terminal-attach")
        ));
        assert!(!is_allowed_signed_path(
            &Method::POST,
            &format!("/v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate/extra")
        ));
        // A trailing slash produces an empty final segment, which the filter
        // drops — the same path, still allowed.
        assert!(is_allowed_signed_path(
            &Method::POST,
            &format!("{validate}/")
        ));
    }

    #[test]
    fn the_signed_body_ceiling_matches_swift() {
        assert_eq!(MAX_SIGNED_BODY_BYTES, 1_048_576);
    }

    #[test]
    fn every_failure_answers_the_same_sentence() {
        let error = signed_request_unauthorized();
        assert_eq!(error.status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "invalid work host request signature");
    }
}
