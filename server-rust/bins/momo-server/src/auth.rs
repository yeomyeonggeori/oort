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
//! **Not yet ported (deviation, see PR body):** the agent-bearer path and the
//! work-host Ed25519 path.

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use momo_auth::{token_state, verify_app_access, AuthError};
use momo_db::{with_tenant_tx, DbError};

use crate::error::ApiError;
use crate::AppState;

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

/// Reject the request unless it carries a valid App access JWT.
pub async fn require_principal(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let header = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_token)
        .ok_or_else(|| ApiError::unauthorized("missing bearer token"))?;

    let raw_token = header.to_string();
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
