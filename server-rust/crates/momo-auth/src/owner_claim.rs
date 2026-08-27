//! Credential claim tokens: mint, hash lookup, atomic consume (#1767).
//!
//! 078's first-owner claim is now `credential_claim.kind = owner_bootstrap`.
//! Operator-issued password reset is the same table with `kind = password_reset`.
//! The raw token is 32 CSPRNG bytes, base64url without padding (43 chars).
//! Postgres stores only `digest(token, 'sha256')`. Consume sets `consumed_at`
//! and `human.password_hash` in one tenant transaction.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::token_store::revoke_member_session_tokens;
use crate::workspace_authorization::active_workspace_role;

/// Sealed TTL (ADR-0166). 24 hours. Shared by both kinds — do not invent a
/// second clock for password_reset.
pub const OWNER_CLAIM_TTL_SECONDS: i64 = 24 * 60 * 60;
const SECRET_BYTES: usize = 32;
/// `encode(32 bytes, base64url no pad)` is always 43 characters.
pub const OWNER_CLAIM_TOKEN_LEN: usize = 43;

pub const CLAIM_KIND_OWNER_BOOTSTRAP: &str = "owner_bootstrap";
pub const CLAIM_KIND_PASSWORD_RESET: &str = "password_reset";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimOutcome {
    pub claim_id: Uuid,
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    pub kind: String,
    pub claim_kind: String,
    pub display_name: String,
    pub handle: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimMutation {
    Applied(ClaimOutcome),
    NotFound,
    Expired,
    AlreadyUsed,
    PasswordPresent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ClaimSpecInvalid {
    #[error("claim token is invalid")]
    Token,
    #[error("password is required")]
    PasswordMissing,
    #[error("password is too long")]
    PasswordTooLong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ClaimInputError {
    #[error("credential entropy unavailable")]
    Entropy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedPasswordReset {
    pub claim_id: Uuid,
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    pub token: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordResetIssueError {
    NotFound,
    NotHuman,
    NotActive,
    Forbidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordChangeMutation {
    Applied { sessions_revoked: u64 },
    CurrentMismatch,
    NoPassword,
}

pub fn mint_owner_claim_token() -> Result<String, ClaimInputError> {
    let mut secret = [0_u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret).map_err(|_| ClaimInputError::Entropy)?;
    Ok(URL_SAFE_NO_PAD.encode(secret))
}

/// Trim and accept only the sealed 32-byte base64url shape. Anything else is
/// the same 400 as a missing token: this surface must not become an oracle
/// for "almost" tokens.
pub fn normalized_claim_token(raw: &str) -> Result<String, ClaimSpecInvalid> {
    let value = raw.trim();
    if value.chars().count() != OWNER_CLAIM_TOKEN_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(ClaimSpecInvalid::Token);
    }
    Ok(value.to_string())
}

pub fn normalized_claim_password(raw: &str) -> Result<String, ClaimSpecInvalid> {
    if raw.is_empty() {
        return Err(ClaimSpecInvalid::PasswordMissing);
    }
    if raw.chars().count() > 1024 {
        return Err(ClaimSpecInvalid::PasswordTooLong);
    }
    Ok(raw.to_string())
}

pub async fn resolve_claim_workspace(
    conn: &mut PgConnection,
    token: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT momo_join_private.owner_claim_workspace_id($1::text)")
        .bind(token)
        .fetch_one(&mut *conn)
        .await
}

pub async fn consume_claim_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    token: &str,
    password: &str,
) -> Result<ClaimMutation, sqlx::Error> {
    let row = sqlx::query(
        "SELECT oc.id, oc.member_id, oc.kind::text AS claim_kind, \
                oc.expires_at <= now() AS expired, \
                oc.consumed_at IS NOT NULL AS consumed, \
                (h.password_hash IS NOT NULL AND h.password_hash <> '') AS password_present \
           FROM credential_claim oc \
           JOIN human h \
             ON h.member_id = oc.member_id \
            AND h.workspace_id = oc.workspace_id \
          WHERE oc.workspace_id = $1 \
            AND oc.token_hash = digest($2::text, 'sha256') \
          FOR UPDATE OF oc",
    )
    .bind(workspace_id)
    .bind(token)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(ClaimMutation::NotFound);
    };
    let expired: bool = row.try_get("expired")?;
    let consumed: bool = row.try_get("consumed")?;
    let password_present: bool = row.try_get("password_present")?;
    let claim_kind: String = row.try_get("claim_kind")?;
    if consumed {
        return Ok(ClaimMutation::AlreadyUsed);
    }
    if expired {
        return Ok(ClaimMutation::Expired);
    }
    if claim_kind == CLAIM_KIND_OWNER_BOOTSTRAP && password_present {
        return Ok(ClaimMutation::PasswordPresent);
    }

    let claim_id: Uuid = row.try_get("id")?;
    let member_id: Uuid = row.try_get("member_id")?;

    let bootstrap_guard = claim_kind == CLAIM_KIND_OWNER_BOOTSTRAP;
    let updated = sqlx::query(
        "WITH claimed AS ( \
            UPDATE credential_claim oc \
               SET consumed_at = now() \
              FROM human h \
             WHERE oc.id = $1 \
               AND oc.workspace_id = $2 \
               AND oc.consumed_at IS NULL \
               AND oc.expires_at > now() \
               AND h.member_id = oc.member_id \
               AND h.workspace_id = oc.workspace_id \
               AND (NOT $4 OR h.password_hash IS NULL OR h.password_hash = '') \
         RETURNING oc.id, oc.member_id, oc.workspace_id \
         ) \
         UPDATE human h \
            SET password_hash = momo_password_hash($3::text) \
           FROM claimed c \
          WHERE h.member_id = c.member_id \
            AND h.workspace_id = c.workspace_id \
         RETURNING h.member_id",
    )
    .bind(claim_id)
    .bind(workspace_id)
    .bind(password)
    .bind(bootstrap_guard)
    .fetch_optional(&mut *conn)
    .await?;

    if updated.is_none() {
        return Ok(ClaimMutation::NotFound);
    }

    if claim_kind == CLAIM_KIND_PASSWORD_RESET {
        revoke_member_session_tokens(conn, workspace_id, member_id).await?;
    }

    let member = sqlx::query(
        "SELECT m.id, m.workspace_id, m.kind::text AS kind, \
                m.display_name, m.handle \
           FROM member m \
          WHERE m.id = $1 \
            AND m.workspace_id = $2 \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
            AND m.kind = 'human'",
    )
    .bind(member_id)
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;

    Ok(ClaimMutation::Applied(ClaimOutcome {
        claim_id,
        member_id,
        workspace_id: member.try_get("workspace_id")?,
        kind: member.try_get("kind")?,
        claim_kind,
        display_name: member.try_get("display_name")?,
        handle: member.try_get("handle")?,
    }))
}

/// Issue a password_reset claim for one active human. Reissue consumes any
/// previous live token for that member first (single live row + audit trail).
///
/// Hierarchy (ADR-0128 D2) is judged here, in the same tenant transaction:
/// actor and target roles are loaded under this `workspace_id` GUC. The
/// route-layer `require_admin` is not the authority.
pub async fn issue_password_reset_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_id: Uuid,
    member_id: Uuid,
    token: &str,
) -> Result<Result<IssuedPasswordReset, PasswordResetIssueError>, sqlx::Error> {
    if actor_id == member_id {
        return Ok(Err(PasswordResetIssueError::Forbidden));
    }

    let Some(actor_role) = active_workspace_role(conn, workspace_id, actor_id).await? else {
        return Ok(Err(PasswordResetIssueError::Forbidden));
    };

    let target = sqlx::query(
        "SELECT m.kind::text AS kind, m.status::text AS status, \
                m.deleted_at IS NOT NULL AS deleted \
           FROM member m \
           JOIN human h \
             ON h.member_id = m.id \
            AND h.workspace_id = m.workspace_id \
          WHERE m.id = $1 \
            AND m.workspace_id = $2 \
          FOR UPDATE OF m",
    )
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(target) = target else {
        return Ok(Err(PasswordResetIssueError::NotFound));
    };
    let kind: String = target.try_get("kind")?;
    let status: String = target.try_get("status")?;
    let deleted: bool = target.try_get("deleted")?;
    if kind != "human" {
        return Ok(Err(PasswordResetIssueError::NotHuman));
    }
    if deleted || status != "active" {
        return Ok(Err(PasswordResetIssueError::NotActive));
    }

    let Some(target_role) = active_workspace_role(conn, workspace_id, member_id).await? else {
        return Ok(Err(PasswordResetIssueError::Forbidden));
    };
    if !actor_role.can_issue_password_reset_for(target_role) {
        return Ok(Err(PasswordResetIssueError::Forbidden));
    }

    sqlx::query(
        "UPDATE credential_claim \
            SET consumed_at = now() \
          WHERE workspace_id = $1 \
            AND member_id = $2 \
            AND kind = 'password_reset' \
            AND consumed_at IS NULL",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;

    let row = sqlx::query(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, expires_at, kind) \
         VALUES \
            ($1, $2, digest($3::text, 'sha256'), \
             now() + make_interval(secs => $4::double precision), \
             'password_reset') \
         RETURNING id, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(token)
    .bind(OWNER_CLAIM_TTL_SECONDS as f64)
    .fetch_one(&mut *conn)
    .await?;

    Ok(Ok(IssuedPasswordReset {
        claim_id: row.try_get("id")?,
        member_id,
        workspace_id,
        token: token.to_string(),
        expires_at_ms: row.try_get("expires_at_ms")?,
    }))
}

/// Change the caller's password after re-checking the current one. Revokes
/// every live session token of this member in the same transaction.
pub async fn change_own_password_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    current_password: &str,
    new_password: &str,
) -> Result<PasswordChangeMutation, sqlx::Error> {
    let row = sqlx::query(
        "SELECT (h.password_hash IS NOT NULL AND h.password_hash <> '') AS has_password, \
                momo_password_verify($3, h.password_hash) AS password_ok \
           FROM human h \
          WHERE h.member_id = $1 \
            AND h.workspace_id = $2 \
          FOR UPDATE",
    )
    .bind(member_id)
    .bind(workspace_id)
    .bind(current_password)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(PasswordChangeMutation::NoPassword);
    };
    let has_password: bool = row.try_get("has_password")?;
    let password_ok: Option<bool> = row.try_get("password_ok")?;
    if !has_password {
        return Ok(PasswordChangeMutation::NoPassword);
    }
    if password_ok != Some(true) {
        return Ok(PasswordChangeMutation::CurrentMismatch);
    }

    sqlx::query(
        "UPDATE human \
            SET password_hash = momo_password_hash($3::text) \
          WHERE member_id = $1 \
            AND workspace_id = $2",
    )
    .bind(member_id)
    .bind(workspace_id)
    .bind(new_password)
    .execute(&mut *conn)
    .await?;

    let sessions_revoked = revoke_member_session_tokens(conn, workspace_id, member_id).await?;
    Ok(PasswordChangeMutation::Applied { sessions_revoked })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_tokens_are_the_sealed_shape() {
        let token = mint_owner_claim_token().expect("entropy");
        assert_eq!(token.len(), OWNER_CLAIM_TOKEN_LEN);
        assert_eq!(normalized_claim_token(&token), Ok(token));
    }

    #[test]
    fn a_short_or_padded_token_is_the_same_400_as_garbage() {
        assert_eq!(normalized_claim_token("abc"), Err(ClaimSpecInvalid::Token));
        assert_eq!(
            normalized_claim_token(&format!("{}=", "A".repeat(43))),
            Err(ClaimSpecInvalid::Token)
        );
        assert_eq!(normalized_claim_token(&"A".repeat(43)), Ok("A".repeat(43)));
    }

    #[test]
    fn an_empty_password_is_refused_before_the_database() {
        assert_eq!(
            normalized_claim_password(""),
            Err(ClaimSpecInvalid::PasswordMissing)
        );
        assert_eq!(
            normalized_claim_password(&"a".repeat(1025)),
            Err(ClaimSpecInvalid::PasswordTooLong)
        );
        assert_eq!(
            normalized_claim_password("hunter2"),
            Ok("hunter2".to_string())
        );
    }

    #[test]
    fn the_sealed_ttl_is_24_hours() {
        assert_eq!(OWNER_CLAIM_TTL_SECONDS, 24 * 60 * 60);
    }

    #[test]
    fn kinds_are_the_two_sealed_labels() {
        assert_eq!(CLAIM_KIND_OWNER_BOOTSTRAP, "owner_bootstrap");
        assert_eq!(CLAIM_KIND_PASSWORD_RESET, "password_reset");
    }
}
