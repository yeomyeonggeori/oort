//! App JWT issuance (HS256) — the mint side of [`crate::jwt`]'s verify.
//!
//! Ports Swift `JWTService.signAccess` / `signRefresh` (`Auth/JWT.swift:112-152`)
//! claim-for-claim so a token minted here verifies in the Swift server and vice
//! versa:
//!   * `sub` = member_id, `ws` = workspace_id, `scopes`, `typ` ∈ {access, refresh}
//!   * `iat`/`exp` in unix seconds; access = 15m, refresh = 30d (L4 §7.1)
//!   * `jti` = a fresh random UUID per issue (MOMO-300): without it a
//!     logout→re-login inside the same second minted a byte-identical JWT whose
//!     `token` row was already revoked.
//!
//! The signing secret is a caller-supplied `&str`. This crate never reads env or
//! a `.env` file — sourcing the secret is the binary's job.

use std::time::{SystemTime, UNIX_EPOCH};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use uuid::Uuid;

use crate::jwt::{AppClaims, AuthError};

/// Access-token lifetime in seconds (Swift `Config.accessTokenTTL`, 15m).
pub const ACCESS_TTL_SECONDS: i64 = 15 * 60;
/// Refresh-token lifetime in seconds (Swift `Config.refreshTokenTTL`, 30d).
pub const REFRESH_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;

/// A minted token plus its expiry, so a caller can persist the `token` row
/// (`token.expires_at`) without re-decoding the JWT. Mirrors Swift
/// `IssuedAppToken`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedToken {
    pub token: String,
    /// Expiry as unix seconds.
    pub expires_at: i64,
}

fn now_unix_seconds() -> i64 {
    // Pre-1970 clocks are not a scenario we serve; clamp rather than panic.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Sign one App JWT with an explicit `typ` and TTL. [`sign_access`] /
/// [`sign_refresh`] are the sanctioned entry points; this is exposed for callers
/// that need a non-default TTL (tests pinning an already-expired token).
pub fn sign_app_token(
    member_id: Uuid,
    workspace_id: Uuid,
    scopes: &[String],
    typ: &str,
    ttl_seconds: i64,
    hmac_secret: &str,
) -> Result<IssuedToken, AuthError> {
    let issued_at = now_unix_seconds();
    let expires_at = issued_at + ttl_seconds;
    let claims = AppClaims {
        sub: member_id.to_string(),
        exp: expires_at.max(0) as usize,
        iat: issued_at.max(0) as usize,
        jti: Uuid::new_v4().to_string(),
        ws: workspace_id.to_string(),
        scopes: scopes.to_vec(),
        typ: typ.to_string(),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(hmac_secret.as_bytes()),
    )?;
    Ok(IssuedToken { token, expires_at })
}

/// Sign an access token (15m, `typ="access"`). The only token
/// [`crate::verify_app_access`] accepts.
pub fn sign_access(
    member_id: Uuid,
    workspace_id: Uuid,
    scopes: &[String],
    hmac_secret: &str,
) -> Result<IssuedToken, AuthError> {
    sign_app_token(
        member_id,
        workspace_id,
        scopes,
        "access",
        ACCESS_TTL_SECONDS,
        hmac_secret,
    )
}

/// Sign a refresh token (30d, `typ="refresh"`, single-use rotation at the
/// refresh endpoint).
pub fn sign_refresh(
    member_id: Uuid,
    workspace_id: Uuid,
    scopes: &[String],
    hmac_secret: &str,
) -> Result<IssuedToken, AuthError> {
    sign_app_token(
        member_id,
        workspace_id,
        scopes,
        "refresh",
        REFRESH_TTL_SECONDS,
        hmac_secret,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jwt::{verify_app_access, PrincipalKind};

    #[test]
    fn access_token_round_trips_through_verify() {
        let member = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        let scopes = vec!["messages:write".to_string(), "messages:read".to_string()];
        let issued = sign_access(member, workspace, &scopes, "s3cr3t").expect("sign");

        let principal = verify_app_access(&issued.token, "s3cr3t").expect("verify");
        assert_eq!(principal.member_id, member);
        assert_eq!(principal.workspace_id, workspace);
        assert_eq!(principal.scopes, scopes);
        assert_eq!(principal.kind, PrincipalKind::Human);
        assert!(
            issued.expires_at - now_unix_seconds() > ACCESS_TTL_SECONDS - 5,
            "access TTL is 15m per L4 §7.1"
        );
    }

    #[test]
    fn refresh_token_is_rejected_on_the_access_path() {
        let issued = sign_refresh(Uuid::new_v4(), Uuid::new_v4(), &[], "s3cr3t").expect("sign");
        assert!(
            matches!(
                verify_app_access(&issued.token, "s3cr3t"),
                Err(AuthError::NotAccessToken)
            ),
            "typ=refresh must never authenticate a request"
        );
    }

    #[test]
    fn every_issue_gets_a_distinct_jti() {
        // MOMO-300: two tokens minted in the same second must differ, or their
        // sha256 `token_hash` collides and a revoked row kills the fresh login.
        let member = Uuid::new_v4();
        let ws = Uuid::new_v4();
        let a = sign_access(member, ws, &[], "s3cr3t").expect("sign a");
        let b = sign_access(member, ws, &[], "s3cr3t").expect("sign b");
        assert_ne!(a.token, b.token, "same-second issues must not be identical");
    }

    #[test]
    fn expired_token_fails_verification() {
        let issued = sign_app_token(
            Uuid::new_v4(),
            Uuid::new_v4(),
            &[],
            "access",
            -3600,
            "s3cr3t",
        )
        .expect("sign");
        assert!(
            verify_app_access(&issued.token, "s3cr3t").is_err(),
            "exp in the past must fail (Swift exp.verifyNotExpired parity)"
        );
    }
}
