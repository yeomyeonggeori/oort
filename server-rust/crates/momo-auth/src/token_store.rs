//! The `token` table — issuance records and revocation state (MOMO-300).
//!
//! Ports Swift `Auth/TokenStore.swift` (`record` :50-71, `state` :74-91,
//! `requireActive` :93-106). A JWT signature only proves the token was *issued*;
//! the row proves the session is still *alive*. Without this check a logout or a
//! rotation cannot kill an outstanding token, so the whole revocation story is
//! decorative.
//!
//! **Fail-closed**, exactly like Swift:
//!   * row missing        → 401 `unknown token` (pre-revocation tokens die)
//!   * `revoked_at` set   → 401 `token has been revoked`
//!   * `expires_at` past  → 401 `token has expired` (JWT `exp` already covers
//!     this; the row is belt-and-braces)
//!
//! **Only `sha256(jwt)` is stored** (`token.token_hash bytea`), computed by
//! pgcrypto's `digest()` *inside Postgres* — the raw token never crosses into a
//! table, a log line, or this module's return values.
//!
//! Ownership: this module is the **only** place in the workspace that contains
//! `token` table SQL, mirroring how `momo-outbox` owns `outbox` SQL. It takes a
//! `&mut PgConnection` rather than a pool so the caller opens the tenant scope
//! through `momo_db::with_tenant_tx` — the sole RLS GUC seam stays in `momo-db`
//! (invariant #6), and this crate keeps no DB-topology knowledge. Swift does the
//! same: `TokenStore` runs every query inside `withTenantConnection`, which is
//! literally `withTenantTransaction` (`DB/Database.swift:157-162`) on the api
//! role, scoped by the workspace claimed in the JWT.

use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Why a presented token is not usable. Each variant carries the Swift 401
/// message verbatim so clients see an unchanged contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenRejection {
    Revoked,
    Expired,
    Unknown,
}

impl TokenRejection {
    /// The exact message Swift's `requireActive` throws.
    pub fn message(self) -> &'static str {
        match self {
            TokenRejection::Revoked => "token has been revoked",
            TokenRejection::Expired => "token has expired",
            TokenRejection::Unknown => "unknown token",
        }
    }
}

impl std::fmt::Display for TokenRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for TokenRejection {}

/// Outcome of looking a presented token up in the `token` table (Swift
/// `TokenStore.TokenState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenState {
    Active { id: Uuid },
    Revoked { id: Uuid },
    Expired { id: Uuid },
    Unknown,
}

impl TokenState {
    /// The `requireActive` decision, split from the DB call so the 401 mapping
    /// is unit-testable without a database.
    pub fn require_active(self) -> Result<Uuid, TokenRejection> {
        match self {
            TokenState::Active { id } => Ok(id),
            TokenState::Revoked { .. } => Err(TokenRejection::Revoked),
            TokenState::Expired { .. } => Err(TokenRejection::Expired),
            TokenState::Unknown => Err(TokenRejection::Unknown),
        }
    }

    /// The row id, when the token is known at all (for audit callers).
    pub fn token_id(self) -> Option<Uuid> {
        match self {
            TokenState::Active { id } | TokenState::Revoked { id } | TokenState::Expired { id } => {
                Some(id)
            }
            TokenState::Unknown => None,
        }
    }
}

/// The `label` values Swift records for the two halves of a session
/// (`AuthRoutes.recordSessionTokens` :412-426). `hasActiveRealtimeCredential`
/// (`TokenStore.swift:333`) keys off `label = 'access'`, so these strings are
/// load-bearing, not cosmetic.
pub const SESSION_LABEL_ACCESS: &str = "access";
pub const SESSION_LABEL_REFRESH: &str = "refresh";

/// Look up a presented token's revocation state.
///
/// The revoked/expired decision is made **in SQL** so this crate needs no
/// timestamp decoding (and so expiry is judged by the DB clock, the same
/// authority `hasActiveSessionToken` uses).
///
/// `conn` must already carry the tenant GUC (open it with
/// `momo_db::with_tenant_tx`), so the row is only visible inside its own
/// workspace — a token minted for workspace A is `Unknown` when presented with a
/// workspace B scope.
pub async fn token_state(
    conn: &mut PgConnection,
    raw_token: &str,
) -> Result<TokenState, sqlx::Error> {
    // The one and only `token` lookup in the workspace. `digest(text,'sha256')`
    // is pgcrypto's — the raw token is hashed by Postgres, never by us, and
    // never stored.
    let row = sqlx::query(
        "SELECT id, \
                revoked_at IS NOT NULL AS revoked, \
                (expires_at IS NOT NULL AND expires_at < now()) AS expired \
           FROM token \
          WHERE token_hash = digest($1::text, 'sha256') \
          LIMIT 1",
    )
    .bind(raw_token)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(TokenState::Unknown);
    };
    let id: Uuid = row.try_get("id")?;
    if row.try_get::<bool, _>("revoked")? {
        return Ok(TokenState::Revoked { id });
    }
    if row.try_get::<bool, _>("expired")? {
        return Ok(TokenState::Expired { id });
    }
    Ok(TokenState::Active { id })
}

/// Record a freshly issued session JWT so it can be revoked later (Swift
/// `TokenStore.record`).
///
/// `expires_at_unix` is the JWT's `exp` in unix seconds — the same value
/// [`crate::IssuedToken`] returns, so the row and the token can never disagree.
/// Every App JWT carries a random `jti`, so `ON CONFLICT (token_hash) DO
/// NOTHING` is a defensive guard against a (practically impossible) sha256
/// collision, not a dedupe path.
pub async fn record_session_token(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    raw_token: &str,
    label: &str,
    scopes: &[String],
    expires_at_unix: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO token \
           (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at) \
         VALUES \
           ($1, 'session', $2, digest($3::text, 'sha256'), $4, $5, to_timestamp($6)) \
         ON CONFLICT (token_hash) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(raw_token)
    .bind(scopes)
    .bind(label)
    .bind(expires_at_unix as f64)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejection_messages_match_swift() {
        assert_eq!(TokenRejection::Revoked.message(), "token has been revoked");
        assert_eq!(TokenRejection::Expired.message(), "token has expired");
        assert_eq!(TokenRejection::Unknown.message(), "unknown token");
    }

    #[test]
    fn only_an_active_row_authenticates() {
        let id = Uuid::from_u128(42);
        assert_eq!(TokenState::Active { id }.require_active(), Ok(id));
        assert_eq!(
            TokenState::Revoked { id }.require_active(),
            Err(TokenRejection::Revoked)
        );
        assert_eq!(
            TokenState::Expired { id }.require_active(),
            Err(TokenRejection::Expired)
        );
        // Fail closed: a token with no row is rejected, not waved through.
        assert_eq!(
            TokenState::Unknown.require_active(),
            Err(TokenRejection::Unknown)
        );
    }

    #[test]
    fn session_labels_match_swift() {
        assert_eq!(SESSION_LABEL_ACCESS, "access");
        assert_eq!(SESSION_LABEL_REFRESH, "refresh");
    }
}
