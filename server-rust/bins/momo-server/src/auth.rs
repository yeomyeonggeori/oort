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
//!
//! On success the resolved [`Principal`] is inserted as a request extension, so
//! handlers read the tenant scope without re-parsing the token — and
//! `principal.workspace_id` is the only value allowed to drive
//! `momo_db::with_tenant_tx` (invariant #6: the RLS GUC input is the credential,
//! never a client-supplied path parameter).
//!
//! **Not yet ported (deviation, see PR body):** the MOMO-300 `token`-table
//! revocation check, the agent-bearer path, and the work-host Ed25519 path. All
//! three are DB/credential surfaces this batch does not own.

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use momo_auth::{verify_app_access, AuthError};

use crate::error::ApiError;
use crate::AppState;

/// Extract the raw bearer token from an `Authorization` header, case-insensitive
/// on the scheme (Swift lowercases before comparing).
fn bearer_token(header: &str) -> Option<&str> {
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

    let principal = verify_app_access(header, &state.jwt_secret).map_err(|error| match error {
        AuthError::InvalidToken(_) => ApiError::unauthorized("invalid or expired token"),
        AuthError::NotAccessToken => ApiError::unauthorized("not an access token"),
        AuthError::MalformedClaims => ApiError::unauthorized("malformed token claims"),
    })?;

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
