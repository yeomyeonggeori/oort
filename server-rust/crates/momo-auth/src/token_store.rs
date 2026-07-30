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

// ---------------------------------------------------------------------------
// revocation (B1.6) — the write side of the MOMO-300 story
// ---------------------------------------------------------------------------

/// Result of a revoke attempt (Swift `TokenStore.revoke`'s
/// `(id: UUID?, revokedNow: Bool)`).
///
/// `revoked_now == false` means the row was **already** revoked or was never
/// recorded — logout stays idempotent (200), while refresh treats it as the
/// single-use gate failing (401).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevokeOutcome {
    /// The affected `token.id`, when the token is known at all (for auditing).
    pub id: Option<Uuid>,
    /// Whether *this* call is the one that flipped `revoked_at`.
    pub revoked_now: bool,
}

/// Revoke the presented token (idempotent). Ports Swift `TokenStore.revoke`
/// (`TokenStore.swift:215-245`).
///
/// The `UPDATE … WHERE revoked_at IS NULL RETURNING id` is **the atomic
/// single-use gate**, not a convenience: under concurrent presentations of the
/// same refresh token exactly one caller sees `revoked_now == true` and may mint
/// a replacement pair; every loser sees `false`. A read-then-write
/// (`token_state` → update) would be TOCTOU-racy and let N concurrent replays
/// all rotate — the exact MOMO-300 review finding recorded in
/// `AuthRoutes.swift:169-176`.
pub async fn revoke_token(
    conn: &mut PgConnection,
    raw_token: &str,
) -> Result<RevokeOutcome, sqlx::Error> {
    let revoked: Option<Uuid> = sqlx::query_scalar(
        "UPDATE token \
            SET revoked_at = now() \
          WHERE token_hash = digest($1::text, 'sha256') \
            AND revoked_at IS NULL \
        RETURNING id",
    )
    .bind(raw_token)
    .fetch_optional(&mut *conn)
    .await?;

    if let Some(id) = revoked {
        return Ok(RevokeOutcome {
            id: Some(id),
            revoked_now: true,
        });
    }

    // Already revoked (or never recorded) — resolve the id for auditing.
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM token \
          WHERE token_hash = digest($1::text, 'sha256') \
          LIMIT 1",
    )
    .bind(raw_token)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(RevokeOutcome {
        id: existing,
        revoked_now: false,
    })
}

/// The instance-privileged scopes (Swift `AuthRoutes.privilegedScopes` :17 =
/// `["platform:read", CloudCreditRoutes.writeScope]`, and
/// `CloudCreditRoutes.swift:23` = `"platform:credits:write"`).
///
/// This list and the `ANY(scopes)` predicate in
/// [`revoke_privileged_session_tokens`] must always name the same set; the unit
/// test below asserts it, so adding a scope here without widening the sweep (or
/// vice versa) fails the build's test step rather than silently leaving a
/// privileged session alive.
pub const PRIVILEGED_SCOPES: [&str; 2] = ["platform:read", "platform:credits:write"];

/// The bulk privileged-session sweep, kept as a `const` so the unit test can
/// assert it mentions every [`PRIVILEGED_SCOPES`] entry.
const REVOKE_PRIVILEGED_SQL: &str = "UPDATE token \
        SET revoked_at = COALESCE(revoked_at, now()) \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'session' \
        AND revoked_at IS NULL \
        AND ( \
          'platform:read' = ANY(scopes) \
          OR 'platform:credits:write' = ANY(scopes) \
        ) \
    RETURNING id";

/// Revoke every still-live **session** token of one member that carries an
/// instance-privileged scope, returning how many rows this call killed. Ports
/// Swift `TokenStore.revokePrivilegedSessionTokens` (`TokenStore.swift:254-277`).
///
/// Ordinary `messages:*`-only sessions are deliberately preserved: losing
/// operator standing must end the operator's *privileged* sessions, not log the
/// human out of the messenger. Swift calls this from two places — a fresh login
/// (bulk rotation of the previous privileged generation) and a refresh that
/// discovers the member is no longer eligible; the Rust refresh route uses the
/// second (`routes::auth_routes::refresh`).
pub async fn revoke_privileged_session_tokens(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let rows = sqlx::query(REVOKE_PRIVILEGED_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.len() as u64)
}

/// Whether `scopes` carries any instance-privileged scope (Swift
/// `carriedPrivilegedScopes` :183-185).
pub fn carries_privileged_scope(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| PRIVILEGED_SCOPES.contains(&scope.as_str()))
}

/// `scopes` minus every privileged scope — Swift `AuthRoutes.refreshedScopes`
/// (`AuthRoutes.swift:361-368`) with `remainsPrivileged == false`. Order is
/// preserved so a refreshed token's scope list stays comparable to the original.
pub fn without_privileged_scopes(scopes: &[String]) -> Vec<String> {
    scopes
        .iter()
        .filter(|scope| !PRIVILEGED_SCOPES.contains(&scope.as_str()))
        .cloned()
        .collect()
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

    #[test]
    fn privileged_scopes_match_swift() {
        // Swift AuthRoutes.privilegedScopes :17 + CloudCreditRoutes.writeScope :23.
        assert_eq!(
            PRIVILEGED_SCOPES,
            ["platform:read", "platform:credits:write"]
        );
    }

    /// Drift guard: the Rust-side scope predicate and the SQL sweep must name
    /// the same set, or a scope could be stripped from a refreshed token while
    /// its sibling sessions stay alive (or vice versa).
    #[test]
    fn the_sweep_sql_covers_every_privileged_scope() {
        for scope in PRIVILEGED_SCOPES {
            assert!(
                REVOKE_PRIVILEGED_SQL.contains(&format!("'{scope}' = ANY(scopes)")),
                "revoke_privileged_session_tokens must sweep '{scope}'"
            );
        }
        assert!(
            REVOKE_PRIVILEGED_SQL.contains("kind = 'session'"),
            "the sweep is scoped to session tokens (agent bearers are not touched)"
        );
    }

    #[test]
    fn only_privileged_scopes_are_stripped() {
        let scopes = vec![
            "messages:write".to_string(),
            "platform:read".to_string(),
            "messages:read".to_string(),
            "platform:credits:write".to_string(),
        ];
        assert!(carries_privileged_scope(&scopes));
        assert_eq!(
            without_privileged_scopes(&scopes),
            vec!["messages:write".to_string(), "messages:read".to_string()],
            "ordinary scopes survive a downgrade, in order"
        );

        let ordinary = vec!["messages:write".to_string(), "messages:read".to_string()];
        assert!(!carries_privileged_scope(&ordinary));
        assert_eq!(
            without_privileged_scopes(&ordinary),
            ordinary,
            "a non-privileged token is unchanged by the filter"
        );
    }

    #[test]
    fn revoke_outcome_distinguishes_the_first_call() {
        let id = Uuid::from_u128(7);
        let first = RevokeOutcome {
            id: Some(id),
            revoked_now: true,
        };
        let repeat = RevokeOutcome {
            id: Some(id),
            revoked_now: false,
        };
        assert_ne!(
            first, repeat,
            "logout idempotency and the refresh single-use gate both read revoked_now"
        );
    }
}
