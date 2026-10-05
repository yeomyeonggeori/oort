//! Personal cloud box — the runner's identity (migration 119, ADR-0197 M2, D2).
//!
//! ## What a runner credential is
//!
//! One workspace has at most **one live runner** (D2: a runner VM serves one
//! workspace's boxes only). The runner authenticates with an opaque bearer
//!
//! ```text
//! oort_runner.<runner uuid>.<32 random bytes, base64url>
//! ```
//!
//! minted here from the OS CSPRNG. The server stores only `sha256(token)`; the
//! plaintext is returned once, by registration or rotation, and never again. The
//! credential is **not** a `token` row and therefore not a [`momo_auth::Principal`]:
//! no human JWT, agent bearer or work-host signature can be presented in its
//! place, and it opens nothing but the runner's own three routes.
//!
//! ## Who may register (D2 역할 분리)
//!
//! Registration, rotation and revocation are the **instance operator's** (the
//! route enforces `require_instance_operator`): a workspace admin alone cannot
//! mint a runner. This module is the statements; the route is the door.
//!
//! Every statement takes a caller-supplied tenant transaction. Authentication is
//! [`authenticate_runner_in_tx`]: the runner's id comes out of the token, the row
//! is read inside the **path workspace's** tenant (so RLS, not a WHERE clause,
//! hides every other workspace's runner), a revoked runner never matches, and the
//! hash comparison is constant-time.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Audit schema every `cloud_box_runner.*` row carries.
pub const CLOUD_BOX_RUNNER_AUDIT_SCHEMA: &str = "momo.cloud_box_runner.audit.v1";
/// The token's fixed first segment.
pub const RUNNER_TOKEN_PREFIX: &str = "oort_runner";
const SECRET_BYTES: usize = 32;
/// The longest runner name (matches the column CHECK).
pub const MAX_RUNNER_NAME_CHARS: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum RunnerCredentialError {
    #[error("the operating system's random source is unavailable")]
    EntropyUnavailable,
}

/// Mint a runner credential for `runner_id`. 32 bytes from the OS CSPRNG.
pub fn mint_runner_credential(runner_id: Uuid) -> Result<String, RunnerCredentialError> {
    let mut secret = [0_u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret).map_err(|_| RunnerCredentialError::EntropyUnavailable)?;
    Ok(format!(
        "{RUNNER_TOKEN_PREFIX}.{}.{}",
        runner_id.as_hyphenated(),
        URL_SAFE_NO_PAD.encode(secret)
    ))
}

/// The runner id inside a presented token, if the token has the runner shape at
/// all. Shape only: nothing here says the token is valid.
pub fn runner_id_of_token(token: &str) -> Option<Uuid> {
    let mut parts = token.split('.');
    let (prefix, id, secret) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || prefix != RUNNER_TOKEN_PREFIX {
        return None;
    }
    // 32 bytes → 43 base64url characters, no padding.
    if secret.len() != 43 || !secret.bytes().all(is_base64url) {
        return None;
    }
    Uuid::parse_str(id).ok()
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

/// `sha256(token)`: what the table stores.
pub fn hash_runner_credential(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

/// The 16-hex-character display fingerprint of a credential hash.
pub fn fingerprint_of(hash: &[u8; 32]) -> String {
    hash[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Constant-time equality for equal-length byte strings (the length is public).
fn ct_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// A runner as the operator's responses describe it. No hash, no token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerInfo {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub credential_fingerprint: String,
    pub registered_by: Option<Uuid>,
    pub created_at_ms: i64,
    pub rotated_at_ms: Option<i64>,
    pub last_seen_at_ms: Option<i64>,
    pub revoked_at_ms: Option<i64>,
}

fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::bigint")
}

fn runner_columns() -> String {
    format!(
        "id, workspace_id, name, credential_fingerprint, registered_by, {}, {}, {}, {}",
        ms("created_at"),
        ms("rotated_at"),
        ms("last_seen_at"),
        ms("revoked_at"),
    )
}

fn runner_from_row(row: &PgRow) -> Result<RunnerInfo, DbError> {
    Ok(RunnerInfo {
        id: row.try_get(0)?,
        workspace_id: row.try_get(1)?,
        name: row.try_get(2)?,
        credential_fingerprint: row.try_get(3)?,
        registered_by: row.try_get(4)?,
        created_at_ms: row.try_get(5)?,
        rotated_at_ms: row.try_get(6)?,
        last_seen_at_ms: row.try_get(7)?,
        revoked_at_ms: row.try_get(8)?,
    })
}

async fn audit_runner(
    conn: &mut PgConnection,
    info: &RunnerInfo,
    action: &str,
    actor: Uuid,
    via_token: Option<Uuid>,
) -> Result<(), DbError> {
    // Name, fingerprint and ids only: never the token, never the hash.
    let mut entry = AuditEntry::new(info.workspace_id, action)
        .target("cloud_box_runner", info.id)
        .via_token(via_token)
        .with_schema(
            CLOUD_BOX_RUNNER_AUDIT_SCHEMA,
            json!({
                "runner_id": info.id.to_string(),
                "name": info.name,
                "credential_fingerprint": info.credential_fingerprint,
                "actor_role": "instance_operator",
            }),
        );
    entry.actor_member_id = Some(actor);
    write_audit(conn, &entry).await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegisterOutcome {
    Registered(RunnerInfo),
    /// The workspace already has a live runner (one per workspace, D2). Revoke or
    /// rotate it instead.
    AlreadyRegistered,
    /// Empty or over-long name.
    InvalidName,
}

/// Register the workspace's runner. `runner_id` is chosen by the caller because the
/// credential embeds it. One live runner per workspace (the unique index is the
/// fact; the pre-check just gives the caller a name for the refusal).
pub async fn register_runner_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    registrant: Uuid,
    name: &str,
    runner_id: Uuid,
    credential_hash: &[u8; 32],
    via_token: Option<Uuid>,
) -> Result<RegisterOutcome, DbError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_RUNNER_NAME_CHARS {
        return Ok(RegisterOutcome::InvalidName);
    }
    sqlx::query("SAVEPOINT cloud_box_runner_register")
        .execute(&mut *conn)
        .await?;
    let inserted = sqlx::query(&format!(
        "INSERT INTO cloud_box_runner \
           (id, workspace_id, name, credential_hash, credential_fingerprint, registered_by) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING {}",
        runner_columns()
    ))
    .bind(runner_id)
    .bind(workspace_id)
    .bind(name)
    .bind(credential_hash.as_slice())
    .bind(fingerprint_of(credential_hash))
    .bind(registrant)
    .fetch_one(&mut *conn)
    .await;
    let row = match inserted {
        Ok(row) => {
            sqlx::query("RELEASE SAVEPOINT cloud_box_runner_register")
                .execute(&mut *conn)
                .await?;
            row
        }
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            sqlx::query("ROLLBACK TO SAVEPOINT cloud_box_runner_register")
                .execute(&mut *conn)
                .await?;
            sqlx::query("RELEASE SAVEPOINT cloud_box_runner_register")
                .execute(&mut *conn)
                .await?;
            return Ok(RegisterOutcome::AlreadyRegistered);
        }
        Err(error) => return Err(error.into()),
    };
    let info = runner_from_row(&row)?;
    audit_runner(
        conn,
        &info,
        "cloud_box_runner.registered",
        registrant,
        via_token,
    )
    .await?;
    Ok(RegisterOutcome::Registered(info))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RotateOutcome {
    Rotated(RunnerInfo),
    /// No such runner in this workspace, or it is revoked (a revoked runner is
    /// registered anew, not rotated).
    NotFound,
}

/// Replace the runner's credential. The old token stops working at once (the hash
/// is overwritten in one statement); leases the runner holds are untouched — it is
/// the same runner under a new secret.
pub async fn rotate_runner_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    runner_id: Uuid,
    new_hash: &[u8; 32],
    actor: Uuid,
    via_token: Option<Uuid>,
) -> Result<RotateOutcome, DbError> {
    let row = sqlx::query(&format!(
        "UPDATE cloud_box_runner \
            SET credential_hash = $3, credential_fingerprint = $4, rotated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL \
          RETURNING {}",
        runner_columns()
    ))
    .bind(workspace_id)
    .bind(runner_id)
    .bind(new_hash.as_slice())
    .bind(fingerprint_of(new_hash))
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(RotateOutcome::NotFound);
    };
    let info = runner_from_row(&row)?;
    audit_runner(conn, &info, "cloud_box_runner.rotated", actor, via_token).await?;
    Ok(RotateOutcome::Rotated(info))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevokeOutcome {
    Revoked(RunnerInfo),
    /// Already revoked: asking twice is fine and writes nothing.
    AlreadyRevoked(RunnerInfo),
    NotFound,
}

/// Revoke the runner. Controls it still holds go back to `pending` (their lease
/// ends with the credential), so the next runner takes them and the revoked one's
/// late completion is fenced out.
pub async fn revoke_runner_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    runner_id: Uuid,
    actor: Uuid,
    via_token: Option<Uuid>,
) -> Result<RevokeOutcome, DbError> {
    let existing = sqlx::query(&format!(
        "SELECT {} FROM cloud_box_runner WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        runner_columns()
    ))
    .bind(workspace_id)
    .bind(runner_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(existing) = existing else {
        return Ok(RevokeOutcome::NotFound);
    };
    let current = runner_from_row(&existing)?;
    if current.revoked_at_ms.is_some() {
        return Ok(RevokeOutcome::AlreadyRevoked(current));
    }
    let row = sqlx::query(&format!(
        "UPDATE cloud_box_runner SET revoked_at = now() \
          WHERE workspace_id = $1 AND id = $2 RETURNING {}",
        runner_columns()
    ))
    .bind(workspace_id)
    .bind(runner_id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE cloud_box_control \
            SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL, \
                runner_id = NULL, lease_id = NULL \
          WHERE workspace_id = $1 AND runner_id = $2 AND status = 'claimed'",
    )
    .bind(workspace_id)
    .bind(runner_id)
    .execute(&mut *conn)
    .await?;
    let info = runner_from_row(&row)?;
    audit_runner(conn, &info, "cloud_box_runner.revoked", actor, via_token).await?;
    Ok(RevokeOutcome::Revoked(info))
}

/// The workspace's runners, live first. For the operator's view and the consent
/// screen's 「런너 식별자와 운영자」; never a hash.
pub async fn list_runners_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<RunnerInfo>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {} FROM cloud_box_runner WHERE workspace_id = $1 \
          ORDER BY (revoked_at IS NOT NULL), created_at DESC, id DESC",
        runner_columns()
    ))
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(runner_from_row).collect()
}

/// Authenticate a presented runner token inside the **path workspace's** tenant
/// transaction. `None` for every failure alike (malformed, unknown, another
/// workspace's runner — RLS hides it —, revoked, wrong secret), so the caller can
/// answer one uniform 401. On success the runner's `last_seen_at` is touched.
pub async fn authenticate_runner_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    presented_token: &str,
) -> Result<Option<RunnerInfo>, DbError> {
    let Some(runner_id) = runner_id_of_token(presented_token) else {
        return Ok(None);
    };
    let presented = hash_runner_credential(presented_token);
    let row = sqlx::query(&format!(
        "SELECT {}, credential_hash FROM cloud_box_runner \
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL",
        runner_columns()
    ))
    .bind(workspace_id)
    .bind(runner_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let stored: Vec<u8> = row.try_get(9)?;
    if !ct_eq(&stored, &presented) {
        return Ok(None);
    }
    let info = runner_from_row(&row)?;
    sqlx::query(
        "UPDATE cloud_box_runner SET last_seen_at = now() WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(runner_id)
    .execute(&mut *conn)
    .await?;
    Ok(Some(info))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_token_has_the_runner_shape_and_hashes_stably() {
        let id = Uuid::new_v4();
        let token = mint_runner_credential(id).expect("mint");
        assert_eq!(runner_id_of_token(&token), Some(id));
        assert_eq!(
            hash_runner_credential(&token),
            hash_runner_credential(&token)
        );
        assert_ne!(
            hash_runner_credential(&token),
            hash_runner_credential(&mint_runner_credential(id).expect("mint")),
            "two mints for one runner must differ"
        );
        assert_eq!(fingerprint_of(&hash_runner_credential(&token)).len(), 16);
    }

    #[test]
    fn other_credentials_do_not_look_like_runner_tokens() {
        let id = Uuid::new_v4();
        let secret = "A".repeat(43);
        for bad in [
            String::new(),
            "Bearer x".to_string(),
            format!("oort_agent.{id}.{secret}"),
            format!("oort_runner.{id}"),
            format!("oort_runner.{id}.{secret}.extra"),
            format!("oort_runner.not-a-uuid.{secret}"),
            format!("oort_runner.{id}.{}", "A".repeat(42)),
            format!("oort_runner.{id}.{}", "A".repeat(44)),
            format!("oort_runner.{id}.{}", "!".repeat(43)),
        ] {
            assert_eq!(runner_id_of_token(&bad), None, "{bad:?}");
        }
        // A human JWT has dots but is not a runner token.
        assert_eq!(runner_id_of_token("aaa.bbb.ccc"), None);
    }

    #[test]
    fn constant_time_equality_agrees_with_plain_equality() {
        assert!(ct_eq(b"abcd", b"abcd"));
        assert!(!ct_eq(b"abcd", b"abce"));
        assert!(!ct_eq(b"abcd", b"abc"));
        assert!(ct_eq(b"", b""));
    }
}
