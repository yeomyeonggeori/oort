//! ADR-0166 first-owner claim token: mint, hash lookup, atomic consume.
//!
//! The raw token is 32 CSPRNG bytes, base64url without padding (43 chars).
//! Postgres stores only `digest(token, 'sha256')`. Consume sets `consumed_at`
//! and `human.password_hash` in one tenant transaction.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Sealed TTL (ADR-0166). 24 hours.
pub const OWNER_CLAIM_TTL_SECONDS: i64 = 24 * 60 * 60;
const SECRET_BYTES: usize = 32;
/// `encode(32 bytes, base64url no pad)` is always 43 characters.
pub const OWNER_CLAIM_TOKEN_LEN: usize = 43;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimOutcome {
    pub claim_id: Uuid,
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    pub kind: String,
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
        "SELECT oc.id, oc.member_id, oc.expires_at <= now() AS expired, \
                oc.consumed_at IS NOT NULL AS consumed, \
                (h.password_hash IS NOT NULL AND h.password_hash <> '') AS password_present \
           FROM owner_claim oc \
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
    if consumed {
        return Ok(ClaimMutation::AlreadyUsed);
    }
    if expired {
        return Ok(ClaimMutation::Expired);
    }
    if password_present {
        return Ok(ClaimMutation::PasswordPresent);
    }

    let claim_id: Uuid = row.try_get("id")?;
    let member_id: Uuid = row.try_get("member_id")?;

    let updated = sqlx::query(
        "WITH claimed AS ( \
            UPDATE owner_claim oc \
               SET consumed_at = now() \
              FROM human h \
             WHERE oc.id = $1 \
               AND oc.workspace_id = $2 \
               AND oc.consumed_at IS NULL \
               AND oc.expires_at > now() \
               AND h.member_id = oc.member_id \
               AND h.workspace_id = oc.workspace_id \
               AND (h.password_hash IS NULL OR h.password_hash = '') \
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
    .fetch_optional(&mut *conn)
    .await?;

    if updated.is_none() {
        return Ok(ClaimMutation::NotFound);
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
        display_name: member.try_get("display_name")?,
        handle: member.try_get("handle")?,
    }))
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
}
