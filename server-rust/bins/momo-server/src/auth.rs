//! Bearer-token authentication middleware.
//!
//! Semantic parity with Swift `Auth/AuthMiddleware.swift:64-137` for the App JWT
//! path, including the exact 401 messages:
//!
//! | condition                       | status | message                    |
//! |---------------------------------|--------|----------------------------|
//! | no / non-`Bearer` Authorization | 401    | `missing bearer token`     |
//! | bad signature or expired        | 401    | `invalid or expired token` |
//! | `typ != "access"`               | 401    | `not an access token`      |
//! | `sub`/`ws` not a UUID           | 401    | `malformed token claims`   |
//! | `token` row missing             | 401    | `unknown token`            |
//! | `token.revoked_at` set          | 401    | `token has been revoked`   |
//! | `token.expires_at` past         | 401    | `token has expired`        |
//!
//! The last three are the MOMO-300 revocation check (Swift `AuthMiddleware`
//! :122-127 → `TokenStore.requireActive`): **the signature only proves issuance;
//! the row proves the session is still alive.** Without it a logout or rotation
//! cannot kill an outstanding token. It is deliberately ordered *after* the
//! signature/typ checks, like Swift, so an unverifiable token never reaches the
//! database.
//!
//! The lookup runs inside `momo_db::with_tenant_tx` scoped by the JWT's `ws`
//! claim — measured parity with Swift, whose `TokenStore` uses
//! `withTenantConnection`, itself literally `withTenantTransaction`
//! (`DB/Database.swift:157-162`) on the same NOBYPASSRLS api role. So a token
//! row is only visible inside its own workspace, and the tenant GUC still has
//! exactly one wiring point (invariant #6).
//!
//! On success the resolved [`Principal`] — now carrying `token_id` — is inserted
//! as a request extension, so handlers read the tenant scope without re-parsing
//! the token, and `principal.workspace_id` is the only value allowed to drive
//! `with_tenant_tx` (never a client-supplied path parameter).
//!
//! ## B2.6: the second and third credentials
//!
//! [`require_principal`] now dispatches the way Swift's middleware does
//! (`AuthMiddleware.swift:64-105`), in this order:
//!
//! 1. **no `Bearer` header** → the deprecated gateway shared secret
//!    (`X-Momo-Agent-Gateway-Secret`), accepted only when
//!    [`crate::config::AgentGatewaySettings::legacy_secret_enabled`] and only on
//!    a gateway callback route. It identifies a *process*, not a member, so it
//!    installs **no** [`Principal`] — exactly like Swift, whose
//!    `usedLegacyAgentGatewaySecret` flag makes `gatewayPrincipal` return nil.
//! 2. **`momo_agent_v1.…` envelope** → the agent bearer. The route must be on the
//!    allow-list (`momo_auth::required_agent_scope`) *before* the database is
//!    touched, and the row must carry that scope.
//! 3. **anything else** → the App JWT path above.
//!
//! **Still not ported (deviation, see PR body):** the work-host Ed25519 bearer
//! branch, which `work_host_auth` handles per-route instead.

use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;
use momo_auth::{
    agent_bearer_workspace_id, authenticate_agent_bearer_in_tx, is_gateway_callback_route,
    required_agent_scope, token_state, verify_app_access, AgentBearerResolution, AuthError,
    Principal, PrincipalKind, AUDIT_DETAIL_SCHEMA,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};
use serde_json::json;

use crate::config::constant_time_eq;
use crate::error::ApiError;
use crate::AppState;

/// The deprecated shared-secret header (Swift
/// `AgentGatewayRoutes.gatewaySecretHeader` :33).
pub const GATEWAY_SECRET_HEADER: &str = "x-momo-agent-gateway-secret";

/// Marker inserted when a request authenticated with the **legacy gateway shared
/// secret** rather than a credential naming a member.
///
/// Its presence is what lets a gateway handler distinguish "no principal because
/// the process secret was used" from "no principal at all", which would be a bug.
/// Swift carries the same bit as `AppRequestContext.usedLegacyAgentGatewaySecret`.
#[derive(Debug, Clone, Copy)]
pub struct LegacyGatewaySecret;

/// The credential behind a gateway callback: a member-naming agent bearer, or
/// the process-level legacy secret.
///
/// A dedicated extractor rather than `Option<Extension<Principal>>` because a
/// **missing** principal must be a 401, not the 500 a failed `Extension`
/// extraction produces — and because `None` here is only reachable when the
/// middleware deliberately allowed it.
#[derive(Debug, Clone)]
pub struct GatewayCaller(pub Option<Principal>);

impl<S> FromRequestParts<S> for GatewayCaller
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        if let Some(principal) = parts.extensions.get::<Principal>() {
            return Ok(GatewayCaller(Some(principal.clone())));
        }
        if parts.extensions.get::<LegacyGatewaySecret>().is_some() {
            return Ok(GatewayCaller(None));
        }
        Err(ApiError::unauthorized("authentication required"))
    }
}

impl GatewayCaller {
    /// Swift `gatewayPrincipal` (:1421-1436): the legacy secret yields no
    /// principal; anything else must be an **agent** credential scoped to this
    /// workspace.
    ///
    /// The workspace check is not redundant with the middleware: the middleware
    /// proved the credential's own workspace, and this proves the *path* names
    /// that same one, so a valid agent of workspace A cannot address workspace B.
    pub fn require_gateway_principal(
        &self,
        workspace_id: uuid::Uuid,
    ) -> Result<Option<&Principal>, ApiError> {
        let Some(principal) = self.0.as_ref() else {
            return Ok(None);
        };
        if principal.kind != PrincipalKind::Agent {
            return Err(ApiError::forbidden("agent bearer required"));
        }
        if principal.workspace_id != workspace_id {
            return Err(ApiError::forbidden("workspace scope mismatch"));
        }
        Ok(Some(principal))
    }
}

/// Extract the raw bearer token from an `Authorization` header, case-insensitive
/// on the scheme (Swift lowercases before comparing).
///
/// `pub(crate)` because `POST /v1/auth/logout` sits *outside* this middleware
/// (Swift `AuthRoutes.add(to:)` :36-44) yet must read the header by the exact
/// same rule — two parsers would be two contracts.
pub(crate) fn bearer_token(header: &str) -> Option<&str> {
    let (scheme, token) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Reject the request unless it carries a credential this server accepts.
pub async fn require_principal(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();

    let presented = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_token);

    let Some(header) = presented else {
        // Swift `AuthMiddleware.swift:64-80`: only a request with NO bearer at
        // all may fall through to the deprecated shared secret.
        if accept_legacy_gateway_secret(&state, &request, &method, &path) {
            tracing::warn!(
                %path,
                "deprecated agent gateway shared secret accepted; rotate to agent_bearer"
            );
            request.extensions_mut().insert(LegacyGatewaySecret);
            return Ok(next.run(request).await);
        }
        return Err(ApiError::unauthorized("missing bearer token"));
    };

    let raw_token = header.to_string();

    if let Some(claimed_workspace) = agent_bearer_workspace_id(&raw_token) {
        let principal =
            authenticate_agent(&state, &raw_token, claimed_workspace, &method, &path).await?;
        request.extensions_mut().insert(principal);
        return Ok(next.run(request).await);
    }
    let mut principal =
        verify_app_access(&raw_token, &state.jwt_secret).map_err(|error| match error {
            AuthError::InvalidToken(_) => ApiError::unauthorized("invalid or expired token"),
            AuthError::NotAccessToken => ApiError::unauthorized("not an access token"),
            // Unreachable on this path (`verify_app_access` never returns it),
            // but named rather than caught by a wildcard so a future variant
            // fails the build instead of silently reusing another message.
            AuthError::NotRefreshToken => ApiError::unauthorized("not a refresh token"),
            AuthError::MalformedClaims => ApiError::unauthorized("malformed token claims"),
        })?;

    // MOMO-300 revocation check, fail-closed: an unknown/revoked/expired row is
    // a 401, and so is a token that was never recorded.
    let workspace_id = principal.workspace_id;
    let state_of_token = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { token_state(conn, &raw_token).await.map_err(DbError::from) })
    })
    .await
    .map_err(|error| ApiError::internal("auth.token_state", error))?;

    principal.token_id = Some(
        state_of_token
            .require_active()
            .map_err(|rejection| ApiError::unauthorized(rejection.message()))?,
    );

    request.extensions_mut().insert(principal);
    Ok(next.run(request).await)
}

/// Whether the deprecated shared secret authenticates this request.
///
/// Four conditions, and none of them is optional:
///   1. gateway mode is on, the operator opted in, and the secret is a real value
///      ([`crate::config::AgentGatewaySettings::legacy_secret_enabled`]);
///   2. the route is a **gateway callback** — the secret names a process, so it
///      cannot stand in for a member anywhere else;
///   3. the header is present and decodes as text;
///   4. it matches in **constant time** (`ConstantTime.equals`) — a `==` would
///      leak the secret one byte at a time to anyone who can time the response,
///      and a bare shared secret has no other binding to fall back on.
fn accept_legacy_gateway_secret(
    state: &AppState,
    request: &Request,
    method: &str,
    path: &str,
) -> bool {
    if !state.agent_gateway.legacy_secret_enabled() {
        return false;
    }
    if !is_gateway_callback_route(method, path) {
        return false;
    }
    request
        .headers()
        .get(GATEWAY_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|presented| constant_time_eq(presented, &state.agent_gateway.secret))
}

/// Resolve an agent bearer to a [`Principal`], auditing the attempt.
///
/// The **allow-list is checked before the database** (Swift :84-89): a route no
/// agent may reach is a 403 that never becomes a query, so an agent credential
/// cannot be used to probe for the existence of rows on surfaces it has no
/// business touching.
///
/// The lookup, the `last_used_at` touch and the audit row share one tenant
/// transaction keyed by the workspace **the envelope claims** — which RLS then
/// makes true or empty. There is no way for this to read a token row belonging to
/// another tenant.
async fn authenticate_agent(
    state: &AppState,
    raw_token: &str,
    claimed_workspace: uuid::Uuid,
    method: &str,
    path: &str,
) -> Result<Principal, ApiError> {
    let Some(required_scope) = required_agent_scope(method, path) else {
        return Err(ApiError::forbidden(
            "agent bearer is not allowed for this route",
        ));
    };

    let token = raw_token.to_string();
    let audited_method = method.to_string();
    let audited_path = path.to_string();
    let resolution: AgentBearerResolution = with_tenant_tx(&state.pool, claimed_workspace, {
        move |conn| {
            Box::pin(async move {
                let resolution = authenticate_agent_bearer_in_tx(
                    conn,
                    claimed_workspace,
                    &token,
                    required_scope,
                )
                .await
                .map_err(DbError::from)?;

                // Swift records the use AND the denial, in this transaction, so
                // the audit trail cannot survive a rolled-back touch (or vice
                // versa). `momo-auth` returns the decision instead of writing it
                // because `audit_log` is `momo-db`'s.
                if let Some(action) = resolution.audit_action() {
                    if let AgentBearerResolution::Active { identity, .. } = &resolution {
                        let mut entry = AuditEntry::new(claimed_workspace, action)
                            .by(identity.member_id)
                            .via_token(Some(identity.token_id))
                            .with_schema(
                                AUDIT_DETAIL_SCHEMA,
                                json!({
                                    "method": audited_method,
                                    "path": audited_path,
                                    "required_scope": required_scope,
                                    "granted": resolution.audit_action()
                                        == Some(momo_auth::AUDIT_ACTION_USED),
                                }),
                            );
                        // Swift writes `target_type = 'route'` with no target id.
                        entry.target_type = Some("route".to_string());
                        write_audit(conn, &entry).await?;
                    }
                }
                Ok(resolution)
            })
        }
    })
    .await
    .map_err(|error| ApiError::internal("auth.agent_bearer", error))?;

    let identity = resolution
        .require_scoped(required_scope)
        .map_err(|rejection| {
            if rejection.is_forbidden() {
                ApiError::forbidden(rejection.to_string())
            } else {
                ApiError::unauthorized(rejection.to_string())
            }
        })?;

    Ok(Principal {
        member_id: identity.member_id,
        workspace_id: identity.workspace_id,
        token_id: Some(identity.token_id),
        scopes: identity.scopes,
        kind: PrincipalKind::Agent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_any_case_of_the_bearer_scheme() {
        assert_eq!(bearer_token("Bearer abc.def.ghi"), Some("abc.def.ghi"));
        assert_eq!(bearer_token("bearer abc.def.ghi"), Some("abc.def.ghi"));
        assert_eq!(bearer_token("BEARER  abc "), Some("abc"));
    }

    #[test]
    fn rejects_other_schemes_and_empty_tokens() {
        assert_eq!(bearer_token("Basic dXNlcjpwYXNz"), None);
        assert_eq!(bearer_token("Bearer "), None);
        assert_eq!(bearer_token("abc.def.ghi"), None);
    }
}
