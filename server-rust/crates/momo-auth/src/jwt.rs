//! App JWT (HS256) verification + the resolved [`Principal`].
//!
//! Ports `AppJWTPayload` (`Auth/JWT.swift:8-34`) and the principal resolution in
//! `AuthMiddleware.handle` (`Auth/AuthMiddleware.swift:107-137`). The principal
//! is the RLS GUC input: `workspace_id` flows into `momo_db::with_tenant_tx`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

/// App JWT claims (HS256). Mirrors the Swift `AppJWTPayload` field-for-field so
/// tokens verify identically. `jti` is required (MOMO-300): pre-jti tokens fail
/// decoding → 401 → re-login (fail-closed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppClaims {
    /// sub = member_id (UUID string).
    pub sub: String,
    /// exp = expiry (unix seconds).
    pub exp: usize,
    /// iat = issued-at (unix seconds).
    pub iat: usize,
    /// jti = random per-issue UUID.
    pub jti: String,
    /// ws = workspace_id (UUID string), the tenant scope for RLS.
    pub ws: String,
    /// scopes — coarse capability grants.
    pub scopes: Vec<String>,
    /// typ — "access" | "refresh".
    pub typ: String,
}

/// The kind of credential behind a request (Swift `AuthPrincipal.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalKind {
    Human,
    Agent,
    WorkHost,
}

/// The authenticated principal. `workspace_id` is the RLS GUC input; `token_id`
/// is filled by the DB revocation check in B1 (None here).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    pub token_id: Option<Uuid>,
    pub scopes: Vec<String>,
    pub kind: PrincipalKind,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("invalid or expired token")]
    InvalidToken(#[from] jsonwebtoken::errors::Error),
    #[error("not an access token")]
    NotAccessToken,
    #[error("malformed token claims")]
    MalformedClaims,
}

/// Verify an App access JWT (signature + exp) and resolve a [`Principal`].
///
/// SKELETON note: this is the cryptographic + claim half. The MOMO-300
/// revocation check (`token` table lookup that fills `token_id`) is DB-backed
/// and lands in B1's middleware; here `token_id` is `None`.
pub fn verify_app_access(token: &str, hmac_secret: &str) -> Result<Principal, AuthError> {
    // Default HS256 validation requires and checks `exp` (parity with Swift's
    // `exp.verifyNotExpired()`); no audience claim is used.
    let validation = Validation::new(Algorithm::HS256);
    let data = decode::<AppClaims>(
        token,
        &DecodingKey::from_secret(hmac_secret.as_bytes()),
        &validation,
    )?;
    let claims = data.claims;

    if claims.typ != "access" {
        return Err(AuthError::NotAccessToken);
    }
    let member_id = Uuid::parse_str(&claims.sub).map_err(|_| AuthError::MalformedClaims)?;
    let workspace_id = Uuid::parse_str(&claims.ws).map_err(|_| AuthError::MalformedClaims)?;

    Ok(Principal {
        member_id,
        workspace_id,
        token_id: None,
        scopes: claims.scopes,
        kind: PrincipalKind::Human,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};

    fn sign(claims: &AppClaims, secret: &str) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("encode")
    }

    fn base_claims(typ: &str) -> AppClaims {
        AppClaims {
            sub: Uuid::from_u128(10).to_string(),
            // far-future exp so the token is valid
            exp: 4_000_000_000,
            iat: 1_700_000_000,
            jti: Uuid::from_u128(99).to_string(),
            ws: Uuid::from_u128(20).to_string(),
            scopes: vec!["messages:write".to_string()],
            typ: typ.to_string(),
        }
    }

    #[test]
    fn verifies_access_token_and_resolves_principal() {
        let secret = "test-secret";
        let token = sign(&base_claims("access"), secret);
        let principal = verify_app_access(&token, secret).expect("verify");
        assert_eq!(principal.member_id, Uuid::from_u128(10));
        assert_eq!(principal.workspace_id, Uuid::from_u128(20));
        assert_eq!(principal.scopes, vec!["messages:write".to_string()]);
        assert_eq!(principal.kind, PrincipalKind::Human);
        assert_eq!(principal.token_id, None);
    }

    #[test]
    fn rejects_refresh_token_on_access_path() {
        let secret = "test-secret";
        let token = sign(&base_claims("refresh"), secret);
        assert!(matches!(
            verify_app_access(&token, secret),
            Err(AuthError::NotAccessToken)
        ));
    }

    #[test]
    fn rejects_wrong_secret() {
        let token = sign(&base_claims("access"), "right");
        assert!(verify_app_access(&token, "wrong").is_err());
    }
}
