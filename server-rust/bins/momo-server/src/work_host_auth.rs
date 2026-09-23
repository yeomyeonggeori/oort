//! Signed work-host **request** authentication (MOMO-657 / migration 048),
//! ported from Swift `Auth/WorkHostAuthenticator.swift`.
//!
//! ## Two entry points, one authenticator
//!
//! Swift runs this as an authenticator over an allow-listed set of eight paths,
//! mounted ahead of the bearer middleware. This server reaches the same rule
//! from two directions, because its routes are split across two routers:
//!
//! * [`crate::auth::require_principal`] calls it for the **protected** routes a
//!   daemon uses (`…/work-hosts/{host}/pending-controls`,
//!   `…/work-controls/{control}/ack`), installing a
//!   [`momo_auth::PrincipalKind::WorkHost`] principal exactly as Swift's
//!   middleware does (`AuthMiddleware.swift:43-62`);
//! * `routes::terminal_attach::validate` calls it directly, because that route
//!   is mounted **outside** the bearer middleware (a PTY host asking whether a
//!   capability is still good holds no bearer at all). `display_attach::validate`
//!   and — since ADR-0188 R0 — `work_hosts::heartbeat` do the same, for the same
//!   reason.
//!
//! [`is_allowed_signed_path`] is what both consult, so a path is signable in one
//! place or neither. Adding the next route stays a one-line, visible decision.
//!
//! ## ADR-0188 D7 (R0): no query string, and a v2 heartbeat
//!
//! The v2 payload signs the **path**, not the query. A signed request that also
//! carried `?…` would have bytes the signature does not cover — an unsigned
//! parameter riding on a signed request, which is the #875 shape (body not
//! covered) moved one field over. No signed route reads a query, so the rule is
//! the whole of it: any query string, even an empty `?`, is the same 401 as a
//! bad signature. [`authenticate_signed_host_request`] takes the whole [`Uri`]
//! rather than a path for exactly this reason — a caller cannot hand it a path
//! with the query already stripped off.
//!
//! The heartbeat used to sign its own v1 payload
//! (`momo.work_host.heartbeat.v1`) with no request id, so a captured heartbeat
//! could be replayed for the whole ±5 minute window and keep a dead host looking
//! alive. It is now an ordinary v2 request on this allow-list — body digest,
//! one-time request id — and v1 is not accepted anywhere.
//!
//! The approval **decision** route is deliberately *not* on the allow-list
//! (ADR-0188 D3: 「host 서명 allow-list에 넣지 않는다」): a signed host's
//! principal carries its owner's `member_id`, so a host that could reach the
//! decision route could approve work onto itself as its owner.
//!
//! The **still-unported two** (each refused by absence): `GET
//! …/work-hosts/{host}/live-sessions`, `POST …/work-hosts/{host}/reconcile`.
//! `#1777` ported the session-mutation pair (`POST …/work-sessions`,
//! `PATCH …/work-sessions/{session}`) and the daemon-boot `GET
//! …/work-tool-profiles` (enabled projection only — without it `momo-workd`
//! exits at `transport_failed` before it can create a session). `#1785` serves
//! ACP event ingestion on that same signed PATCH. Observation is #1778.
//!
//! ## The check, in Swift's order (`:29-125`)
//!
//! 0. the request carries no query string (ADR-0188 D7 — see above);
//! 1. the path/method is allow-listed — before anything is parsed;
//! 2. `Authorization: MomoHost <hostId>` parses, and equals the `{host}` in the
//!    path **when the path names one** ([`scoped_host_id_from_path`], Swift
//!    `scopedHostID` :283-289) — a host may only act as itself;
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
//!
//! ## The paths whose `{…}` segment is not a host
//!
//! `POST …/work-controls/{control}/ack` addresses a *control*, so step 2 has
//! nothing in the path to pin the signer against — and Swift's `scopedHostID`
//! returns nil there for the same reason (it only reads segment 4 of a
//! `work-hosts` path). The pin that route needs is a different one and it lives
//! in the handler, where the ledger can be read: the signing host must be the
//! control's own `target_host_id`. Answering "authenticated, therefore
//! authorised" here would let any registered host in the workspace acknowledge
//! any other host's control.
//!
//! LIVE-1 added the second: `POST …/work-sessions/{session}/display-binding`
//! addresses a *session*, and its handler pins the signer to that session's
//! `host_id` for the same reason — otherwise any host could point every future
//! observer of someone else's session at a screen of its choosing.
//!
//! ## Provenance (ADR-0146, B2.5)
//!
//! Nothing above changes. The one addition is that a *successful* verification
//! now hands the route a [`VerifiedHostSignature`] so the route can record the
//! proof against the entity its own transaction produces. Authentication and
//! provenance stay separate: this function still decides only "may this host
//! act", and `momo_wire::record_provenance` still re-verifies from scratch
//! before it writes — the chokepoint trusts no caller's word that a signature
//! was checked.

use axum::http::{HeaderMap, Method, Uri};
use momo_auth::{
    consume_work_host_request_id, heartbeat_timestamp_is_fresh, load_work_host_signing_credential,
    verify_work_host_request,
};
use momo_db::{with_tenant_tx, DbError};
use momo_wire::SignedAction;
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedHostRequest {
    pub workspace_id: Uuid,
    pub host_id: Uuid,
    pub owner_member_id: Uuid,
    /// ADR-0146 provenance carrier — see [`VerifiedHostSignature`].
    pub signature: VerifiedHostSignature,
}

/// Everything needed to re-derive the exact bytes this host signed.
///
/// It exists because authentication and provenance happen in **different
/// transactions**: the v2 signature is verified (and its request id consumed)
/// before the route knows which entity the action will land on — `validate`
/// learns the `work_session_id` only from its own query. Carrying the verified
/// material forward lets the route write the provenance row next to the entity
/// it names, instead of guessing an entity at authentication time.
///
/// The fields are the v2 payload's, not a re-encoding: `path` is the raw request
/// path and `body_digest` the digest that was actually signed, so
/// [`Self::action`] reproduces the identical bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedHostSignature {
    /// The **stored** host key the signature verified against.
    pub signer_pubkey_b64: String,
    pub signature_b64: String,
    pub method: String,
    pub path: String,
    pub sent_at_ms: i64,
    pub body_digest: String,
    pub request_id: Uuid,
}

impl VerifiedHostSignature {
    /// The signed action, for `momo_wire::record_provenance`.
    pub fn action(&self, workspace_id: Uuid, host_id: Uuid) -> SignedAction<'_> {
        SignedAction::WorkHostRequest {
            method: &self.method,
            path: &self.path,
            workspace_id,
            host_id,
            sent_at_ms: self.sent_at_ms,
            body_digest: &self.body_digest,
            request_id: self.request_id,
        }
    }
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
/// actually serves — see the module docs for the five that are not ported.
pub(crate) fn is_allowed_signed_path(method: &Method, path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if segments.len() < 4 || segments[0] != "v1" || segments[1] != "workspaces" {
        return false;
    }
    // `POST …/work-hosts/{host}/terminal-attach/validate` (B2.4).
    if method == Method::POST
        && segments.len() == 7
        && segments[3] == "work-hosts"
        && segments[5] == "terminal-attach"
        && segments[6] == "validate"
    {
        return true;
    }
    // `POST …/work-hosts/{host}/heartbeat` (ADR-0188 D7, R0) — liveness, signed
    // v2 like every other host act so a captured beat cannot be replayed. The
    // path names the host, so the `{host}` pin applies.
    if method == Method::POST
        && segments.len() == 6
        && segments[3] == "work-hosts"
        && segments[5] == "heartbeat"
    {
        return true;
    }
    // `GET …/work-hosts/{host}/pending-controls` — how a daemon learns what a
    // person approved (#1114).
    if method == Method::GET
        && segments.len() == 6
        && segments[3] == "work-hosts"
        && segments[5] == "pending-controls"
    {
        return true;
    }
    // `POST …/work-controls/{control}/ack` — and how it reports back (#1114).
    if method == Method::POST
        && segments.len() == 6
        && segments[3] == "work-controls"
        && segments[5] == "ack"
    {
        return true;
    }
    // `POST …/work-hosts/{host}/display-attach/validate` (LIVE-1) — the WebRTC
    // producer asking whether a view-only capability is still good.
    if method == Method::POST
        && segments.len() == 7
        && segments[3] == "work-hosts"
        && segments[5] == "display-attach"
        && segments[6] == "validate"
    {
        return true;
    }
    // `POST …/work-sessions/{session}/display-binding` (LIVE-1) — the daemon
    // publishing which screen this session serves.
    //
    // **Second path whose `{…}` is not a host**, after `…/work-controls/{c}/ack`
    // and for the same reason: it addresses a session. `scoped_host_id_from_path`
    // therefore returns `None` here, and the pin that matters lives in the
    // handler where the ledger can be read — the signing host must be the
    // session's own `host_id`. Answering "authenticated, therefore authorised"
    // at this layer would let any registered host in the workspace publish a
    // screen onto any other host's session.
    if method == Method::POST
        && segments.len() == 6
        && segments[3] == "work-sessions"
        && segments[5] == "display-binding"
    {
        return true;
    }
    // `POST …/work-sessions` (#1777) — host-signed create against a dispatched
    // spawn control. The path names no host; the handler pins `hostId` in the
    // body to the signer and the control's `target_host_id`.
    if method == Method::POST && segments.len() == 4 && segments[3] == "work-sessions" {
        return true;
    }
    // `PATCH …/work-sessions/{session}` (#1777) — bindRemotePTY, idle/running,
    // and host-signed end. Same "path names a session" shape as display-binding:
    // the pin lives in the handler against the session's `host_id`.
    if method == Method::PATCH && segments.len() == 5 && segments[3] == "work-sessions" {
        return true;
    }
    // `GET …/work-tool-profiles` (#1777) — the daemon's boot catalog. The path
    // names no host; the handler serves the enabled projection to any signed
    // host in the workspace (Swift `WorkToolProfileRoutes.list`).
    if method == Method::GET && segments.len() == 4 && segments[3] == "work-tool-profiles" {
        return true;
    }
    false
}

/// The host id a path pins the signer to, when it names one (Swift
/// `scopedHostID(fromPath:)` :283-289).
///
/// `None` is **not** "any host may act": it means the path carries no host
/// segment, so the pin has to come from somewhere else — see the module docs.
/// Returning `None` for a malformed host id would silently drop the pin, so a
/// `work-hosts` path whose segment 4 does not parse is instead treated as a
/// mismatch by [`authenticate_signed_host_request`].
pub(crate) fn scoped_host_id_from_path(path: &str) -> Option<Result<Uuid, ()>> {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if segments.len() < 5 || segments[3] != "work-hosts" {
        return None;
    }
    Some(Uuid::parse_str(segments[4]).map_err(|_| ()))
}

/// Authenticate a signed host request, returning the verified identity.
///
/// `uri` is the **request's own URI**. Its raw path (`Uri::path()`) is what is
/// inside the signature: reconstructing it from route parameters would re-encode
/// it and silently invalidate every signature from a host that spelled it
/// differently. It is also where the scoped-host pin is read from, so the raw
/// path is the one input this function trusts about the request's shape.
///
/// The whole `Uri`, not just its path, because of what the path leaves out: the
/// query string is not signed, so a signed request may not carry one at all
/// (ADR-0188 D7). Taking the path alone would let a caller strip the query
/// before this function could see it.
pub(crate) async fn authenticate_signed_host_request(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
    workspace_id: Uuid,
) -> Result<SignedHostRequest, ApiError> {
    // ADR-0188 D7 — nothing unsigned rides on a signed request. `query()` is
    // `Some("")` for a bare trailing `?`, which is refused too: it is still a
    // byte the signature does not cover.
    if uri.query().is_some() {
        return Err(signed_request_unauthorized());
    }
    let path = uri.path();
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
    // A host may only ever act as itself, on the paths that name a host
    // (`scopedHostID`, :56-60). A path that names none carries its pin in the
    // handler instead — see the module docs.
    if let Some(scoped) = scoped_host_id_from_path(path) {
        if scoped != Ok(host_id) {
            return Err(signed_request_unauthorized());
        }
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
                signature: VerifiedHostSignature {
                    signer_pubkey_b64: credential.public_key,
                    signature_b64: signature,
                    method: method_text,
                    path: path_text,
                    sent_at_ms,
                    body_digest,
                    request_id,
                },
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
    fn signed_allow_list_covers_the_ported_workd_loop_and_the_method_is_part_of_the_rule() {
        let ws = Uuid::from_u128(1);
        let host = Uuid::from_u128(2);
        let control = Uuid::from_u128(3);
        let validate = format!("/v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate");
        let pending = format!("/v1/workspaces/{ws}/work-hosts/{host}/pending-controls");
        let ack = format!("/v1/workspaces/{ws}/work-controls/{control}/ack");
        let create = format!("/v1/workspaces/{ws}/work-sessions");
        let patch = format!("/v1/workspaces/{ws}/work-sessions/{host}");
        let profiles = format!("/v1/workspaces/{ws}/work-tool-profiles");
        let heartbeat = format!("/v1/workspaces/{ws}/work-hosts/{host}/heartbeat");

        // ADR-0188 D7 (R0): the heartbeat is an ordinary v2 request now, POST
        // only, and its path names the host so the pin applies to it.
        assert!(is_allowed_signed_path(&Method::POST, &heartbeat));
        assert!(!is_allowed_signed_path(&Method::GET, &heartbeat));
        assert_eq!(scoped_host_id_from_path(&heartbeat), Some(Ok(host)));

        assert!(is_allowed_signed_path(&Method::POST, &validate));
        assert!(is_allowed_signed_path(&Method::GET, &pending));
        assert!(is_allowed_signed_path(&Method::POST, &ack));
        assert!(is_allowed_signed_path(&Method::POST, &create));
        assert!(is_allowed_signed_path(&Method::PATCH, &patch));
        assert!(is_allowed_signed_path(&Method::GET, &profiles));
        assert!(!is_allowed_signed_path(&Method::POST, &profiles));
        assert!(!is_allowed_signed_path(&Method::GET, &create));
        assert!(!is_allowed_signed_path(&Method::POST, &patch));

        // Method is part of the signed payload, and of the allow-list: the same
        // path under the wrong verb is a different request.
        assert!(!is_allowed_signed_path(&Method::GET, &validate));
        assert!(!is_allowed_signed_path(&Method::POST, &pending));
        assert!(!is_allowed_signed_path(&Method::GET, &ack));

        // The two Swift allow-lists that still have no handler here must NOT
        // be signable: an authenticated 404 would be a promise this server
        // cannot keep. work-tool-profiles GET landed in #1777 with the session
        // arms — the daemon cannot boot without it.
        for (method, unported) in [
            (
                Method::GET,
                format!("/v1/workspaces/{ws}/work-hosts/{host}/live-sessions"),
            ),
            (
                Method::POST,
                format!("/v1/workspaces/{ws}/work-hosts/{host}/reconcile"),
            ),
        ] {
            assert!(
                !is_allowed_signed_path(&method, &unported),
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
        assert!(!is_allowed_signed_path(
            &Method::POST,
            &format!("/v1/workspaces/{ws}/work-controls/{control}/ack/extra")
        ));
        // A trailing slash produces an empty final segment, which the filter
        // drops — the same path, still allowed.
        assert!(is_allowed_signed_path(
            &Method::POST,
            &format!("{validate}/")
        ));
    }

    /// The generalisation #1114 needed: the pin exists where the path names a
    /// host, and is deliberately absent — not silently satisfied — where it does
    /// not.
    #[test]
    fn the_scoped_host_pin_follows_the_path_shape() {
        let ws = Uuid::from_u128(1);
        let host = Uuid::from_u128(2);
        let control = Uuid::from_u128(3);
        assert_eq!(
            scoped_host_id_from_path(&format!(
                "/v1/workspaces/{ws}/work-hosts/{host}/pending-controls"
            )),
            Some(Ok(host))
        );
        assert_eq!(
            scoped_host_id_from_path(&format!(
                "/v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate"
            )),
            Some(Ok(host))
        );
        // A control id is not a host id, and pretending otherwise is exactly the
        // confusion that kept this route unported.
        assert_eq!(
            scoped_host_id_from_path(&format!("/v1/workspaces/{ws}/work-controls/{control}/ack")),
            None
        );
        assert_eq!(
            scoped_host_id_from_path(&format!("/v1/workspaces/{ws}/work-sessions")),
            None
        );
        assert_eq!(
            scoped_host_id_from_path(&format!("/v1/workspaces/{ws}/work-sessions/{control}")),
            None
        );
        assert_eq!(
            scoped_host_id_from_path(&format!("/v1/workspaces/{ws}/work-tool-profiles")),
            None
        );
        // A malformed host segment must NOT read as "no pin".
        assert_eq!(
            scoped_host_id_from_path(&format!(
                "/v1/workspaces/{ws}/work-hosts/nope/live-sessions"
            )),
            Some(Err(()))
        );
        assert_eq!(scoped_host_id_from_path("/healthz"), None);
    }

    /// ADR-0188 D3: 「host 서명 allow-list에 넣지 않는다」. A signed host's
    /// principal carries its owner's `member_id`; a decision route on this list
    /// would let a laptop approve work onto itself as its owner. Every spelling
    /// and verb of both decision routes — and the inbox beside them — stays off.
    #[test]
    fn no_approval_route_is_signable() {
        let ws = Uuid::from_u128(1);
        let approval = Uuid::from_u128(4);
        let run = Uuid::from_u128(5);
        for path in [
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision"),
            format!("/v1/workspaces/{ws}/approvals"),
            format!("/v1/agent-runs/{run}/approval-decisions"),
        ] {
            for method in [Method::GET, Method::POST, Method::PUT, Method::PATCH] {
                assert!(
                    !is_allowed_signed_path(&method, &path),
                    "{method} {path} must never authenticate a work host"
                );
            }
        }
    }

    /// ADR-0188 D7 — a signed request carries no query string, not even a bare
    /// `?`. Refused before the allow-list, the headers and the database: the
    /// pool below never dials, and each request is otherwise shaped to get past
    /// every cheaper check (allow-listed path, well-formed headers, fresh
    /// clock), so without the query rule it would reach the database — a 500
    /// here — rather than the 401 asserted.
    #[tokio::test]
    async fn a_query_string_is_refused_before_anything_else() {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(500))
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        let state = AppState::new(
            pool,
            "test-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        );
        let ws = Uuid::from_u128(1);
        let host = Uuid::from_u128(2);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("MomoHost {host}").parse().expect("header"),
        );
        headers.insert(SENT_AT_HEADER, now_ms.to_string().parse().expect("header"));
        headers.insert(SIGNATURE_HEADER, "c2lnbmF0dXJl".parse().expect("header"));
        headers.insert(
            REQUEST_ID_HEADER,
            Uuid::from_u128(3).to_string().parse().expect("header"),
        );

        for (method, raw) in [
            (
                Method::GET,
                format!("/v1/workspaces/{ws}/work-hosts/{host}/pending-controls?limit=1"),
            ),
            (
                Method::GET,
                format!("/v1/workspaces/{ws}/work-hosts/{host}/pending-controls?"),
            ),
            (
                Method::POST,
                format!("/v1/workspaces/{ws}/work-hosts/{host}/heartbeat?stale=1"),
            ),
        ] {
            let uri: Uri = raw.parse().expect("uri");
            assert!(uri.query().is_some(), "{raw} carries a query");
            let error = authenticate_signed_host_request(&state, &method, &uri, &headers, b"", ws)
                .await
                .expect_err("a query string is never signed");
            assert_eq!(error.status, axum::http::StatusCode::UNAUTHORIZED, "{raw}");
            assert_eq!(
                error.message, "invalid work host request signature",
                "{raw}"
            );
        }
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
