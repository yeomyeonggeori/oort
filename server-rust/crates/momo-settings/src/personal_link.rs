//! Personal API keys — an owner-scoped BYOK (migration 116, ADR-0147 증보
//! 2026-10-03, 성재 결재 2026-10-03).
//!
//! The organisation (a workspace admin) issues one provider API key to one
//! person. Only that person's own `owner_only` agent (`agent.uses_owner_key`)
//! ever resolves it. The team link (`provider_link`, 039) and the chain (042)
//! are a different store with a different reader; nothing in this module is
//! reachable from the team resolver, and nothing in the team resolver reads
//! this table (`personal_credential_isolation.rs` pins both halves).
//!
//! What this module owns
//!
//! * the **fingerprint** that makes "one key, one member" a database fact:
//!   sealed boxes carry a fresh nonce, so two ciphertexts of the same key never
//!   compare equal. The fingerprint is a domain-separated SHA-256 over the
//!   master key and the key; it is unique among *active* rows and is not a
//!   usable derivative of the key without the master key;
//! * issue / revoke / list statements. Every read that serves an API response
//!   selects columns **by name** and never the sealed box; the one statement
//!   that does select it ([`read_owner_key_for_agent`]) is the worker's;
//! * [`decrypt_personal_link`], which refuses any envelope that is not a plain
//!   API key of the stored `format` (no subscription OAuth grant can ride in).
//!
//! Authorization (who may issue, revoke, list) is the route's decision. The
//! statements here only enforce the structural rules.

use momo_db::DbError;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::crypto::{open_bearer, CryptoError};
use crate::oauth::LinkCredential;
use crate::presets::ProviderFormat;

pub const PERSONAL_LINK_ISSUED_ACTION: &str = "provider.personal_link.issued";
pub const PERSONAL_LINK_REVOKED_ACTION: &str = "provider.personal_link.revoked";
pub const PERSONAL_LINK_AUDIT_SCHEMA: &str = "momo.provider_personal_link.audit.v1";

/// `hex(SHA-256("momo.personal_link.fp.v1\n" || masterKey || "\n" || key))`.
///
/// The key is trimmed first (the same normalisation `seal_bearer` applies), so
/// a key pasted with a trailing newline fingerprints like the key that was
/// meant.
pub fn key_fingerprint(secret: &str, master_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"momo.personal_link.fp.v1\n");
    hasher.update(master_key.as_bytes());
    hasher.update(b"\n");
    hasher.update(secret.trim().as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// One issued key as every response and audit row may describe it: no sealed
/// box, no fingerprint, no key material of any kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonalLinkInfo {
    pub id: Uuid,
    pub owner_member_id: Uuid,
    pub format: String,
    pub base_url: String,
    pub label: Option<String>,
    pub issued_by: Option<Uuid>,
    pub issued_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
}

type InfoRow = (
    Uuid,
    Uuid,
    String,
    String,
    Option<String>,
    Option<Uuid>,
    i64,
    Option<i64>,
);

const INFO_COLUMNS: &str = "id, owner_member_id, format, base_url, label, issued_by, \
     floor(extract(epoch from issued_at) * 1000)::bigint, \
     floor(extract(epoch from revoked_at) * 1000)::bigint";

fn info(row: InfoRow) -> PersonalLinkInfo {
    PersonalLinkInfo {
        id: row.0,
        owner_member_id: row.1,
        format: row.2,
        base_url: row.3,
        label: row.4,
        issued_by: row.5,
        issued_at_ms: row.6,
        revoked_at_ms: row.7,
    }
}

/// Everything an issue writes. `bearer_ciphertext` is already sealed.
pub struct NewPersonalLink<'a> {
    pub owner_member_id: Uuid,
    pub format: ProviderFormat,
    pub base_url: &'a str,
    pub bearer_ciphertext: &'a [u8],
    pub key_fingerprint: &'a str,
    pub label: Option<&'a str>,
    pub issued_by: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueOutcome {
    Issued(PersonalLinkInfo),
    /// The owner is not an active human of this workspace.
    OwnerNotHuman,
    /// The owner already has an active key; revoke it first.
    OwnerHasActiveKey,
    /// This exact key is already attached to a member (any workspace).
    KeyAlreadyAttached,
}

/// Issue a key. The structural rules are enforced by the table; the savepoint
/// turns their violations into a result instead of an aborted transaction.
pub async fn issue_personal_link_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: &NewPersonalLink<'_>,
) -> Result<IssueOutcome, DbError> {
    let owner: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM member \
          WHERE id = $1 AND workspace_id = $2 AND kind = 'human' \
            AND status = 'active' AND deleted_at IS NULL",
    )
    .bind(new.owner_member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    if owner.is_none() {
        return Ok(IssueOutcome::OwnerNotHuman);
    }

    sqlx::query("SAVEPOINT personal_link_issue")
        .execute(&mut *conn)
        .await?;
    let inserted: Result<InfoRow, sqlx::Error> = sqlx::query_as(&format!(
        "INSERT INTO personal_provider_link \
           (workspace_id, owner_member_id, format, base_url, bearer_ciphertext, \
            key_fingerprint, label, issued_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         RETURNING {INFO_COLUMNS}"
    ))
    .bind(workspace_id)
    .bind(new.owner_member_id)
    .bind(new.format.as_str())
    .bind(new.base_url)
    .bind(new.bearer_ciphertext)
    .bind(new.key_fingerprint)
    .bind(new.label)
    .bind(new.issued_by)
    .fetch_one(&mut *conn)
    .await;
    match inserted {
        Ok(row) => {
            sqlx::query("RELEASE SAVEPOINT personal_link_issue")
                .execute(&mut *conn)
                .await?;
            Ok(IssueOutcome::Issued(info(row)))
        }
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            sqlx::query("ROLLBACK TO SAVEPOINT personal_link_issue")
                .execute(&mut *conn)
                .await?;
            sqlx::query("RELEASE SAVEPOINT personal_link_issue")
                .execute(&mut *conn)
                .await?;
            match db.constraint() {
                Some("personal_provider_link_fp_active_uk") => Ok(IssueOutcome::KeyAlreadyAttached),
                _ => Ok(IssueOutcome::OwnerHasActiveKey),
            }
        }
        Err(error) => Err(error.into()),
    }
}

/// Keys of one workspace, optionally only one person's. Columns by name: the
/// sealed box and the fingerprint are never selected here.
pub async fn list_personal_links_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Option<Uuid>,
) -> Result<Vec<PersonalLinkInfo>, DbError> {
    let rows: Vec<InfoRow> = sqlx::query_as(&format!(
        "SELECT {INFO_COLUMNS} FROM personal_provider_link \
          WHERE workspace_id = $1 AND ($2::uuid IS NULL OR owner_member_id = $2) \
          ORDER BY issued_at DESC, id DESC"
    ))
    .bind(workspace_id)
    .bind(owner_member_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(info).collect())
}

pub async fn find_personal_link_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    link_id: Uuid,
) -> Result<Option<PersonalLinkInfo>, DbError> {
    let row: Option<InfoRow> = sqlx::query_as(&format!(
        "SELECT {INFO_COLUMNS} FROM personal_provider_link \
          WHERE workspace_id = $1 AND id = $2"
    ))
    .bind(workspace_id)
    .bind(link_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(info))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevokeOutcome {
    Revoked(PersonalLinkInfo),
    AlreadyRevoked(PersonalLinkInfo),
    NotFound,
}

/// Revoke (one way). The row is locked first so two concurrent revokes agree on
/// who revoked it.
pub async fn revoke_personal_link_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    link_id: Uuid,
    revoked_by: Uuid,
) -> Result<RevokeOutcome, DbError> {
    let locked: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT floor(extract(epoch from revoked_at) * 1000)::bigint \
           FROM personal_provider_link \
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(link_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((revoked_at,)) = locked else {
        return Ok(RevokeOutcome::NotFound);
    };
    if revoked_at.is_none() {
        sqlx::query(
            "UPDATE personal_provider_link SET revoked_at = now(), revoked_by = $3 \
              WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL",
        )
        .bind(workspace_id)
        .bind(link_id)
        .bind(revoked_by)
        .execute(&mut *conn)
        .await?;
    }
    let row = find_personal_link_in_tx(conn, workspace_id, link_id).await?;
    Ok(match (row, revoked_at.is_some()) {
        (Some(row), false) => RevokeOutcome::Revoked(row),
        (Some(row), true) => RevokeOutcome::AlreadyRevoked(row),
        (None, _) => RevokeOutcome::NotFound,
    })
}

/// The worker's row: the sealed key of **the agent's own owner**, and only when
/// every link in the chain holds — the agent is `owner_only`, its brain is the
/// owner's key, the key is that owner's, issued in this workspace, not revoked,
/// and the owner is still an active human member. Anything else is `None`, and
/// `None` means the turn is refused — never that some other credential answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredOwnerKey {
    pub link_id: Uuid,
    pub owner_member_id: Uuid,
    pub format: String,
    pub base_url: String,
    pub bearer_ciphertext: Vec<u8>,
}

pub async fn read_owner_key_for_agent(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<StoredOwnerKey>, DbError> {
    let row: Option<(Uuid, Uuid, String, String, Vec<u8>)> = sqlx::query_as(
        "SELECT l.id, l.owner_member_id, l.format, l.base_url, l.bearer_ciphertext \
           FROM agent a \
           JOIN personal_provider_link l \
             ON l.workspace_id = a.workspace_id \
            AND l.owner_member_id = a.owner_human_id \
            AND l.revoked_at IS NULL \
           JOIN member o \
             ON o.id = l.owner_member_id AND o.workspace_id = l.workspace_id \
            AND o.kind = 'human' AND o.status = 'active' AND o.deleted_at IS NULL \
          WHERE a.workspace_id = $1 AND a.member_id = $2 \
            AND a.invocation_scope = 'owner_only' AND a.uses_owner_key",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(
        |(link_id, owner_member_id, format, base_url, bearer_ciphertext)| StoredOwnerKey {
            link_id,
            owner_member_id,
            format,
            base_url,
            bearer_ciphertext,
        },
    ))
}

/// A stored key with its envelope opened. Never serialize this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedOwnerKey {
    pub base_url: String,
    pub credential: LinkCredential,
}

#[derive(Debug, thiserror::Error)]
pub enum PersonalKeyUnusable {
    #[error("personal key could not be opened: {0}")]
    Crypto(#[from] CryptoError),
    #[error("personal key envelope does not match its format")]
    EnvelopeMismatch,
}

/// Open the sealed box and check it is a plain API key of the stored format. A
/// subscription OAuth grant, a mismatched envelope or an empty key is refused —
/// a personal key is an API key, never a person's subscription.
pub fn decrypt_personal_link(
    stored: &StoredOwnerKey,
    master_key: &str,
) -> Result<DecryptedOwnerKey, PersonalKeyUnusable> {
    let plaintext = open_bearer(&stored.bearer_ciphertext, master_key)?;
    let credential = LinkCredential::parse(&plaintext);
    let matches = match (&credential, stored.format.as_str()) {
        (LinkCredential::Bearer(key), "openai") => !key.trim().is_empty(),
        (LinkCredential::AnthropicKey(key), "anthropic") => !key.trim().is_empty(),
        _ => false,
    };
    if !matches {
        return Err(PersonalKeyUnusable::EnvelopeMismatch);
    }
    Ok(DecryptedOwnerKey {
        base_url: stored.base_url.clone(),
        credential,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::seal_bearer;

    #[test]
    fn the_fingerprint_is_stable_trimmed_and_keyed() {
        let a = key_fingerprint("sk-live-abc", "master-one");
        assert_eq!(a, key_fingerprint("  sk-live-abc\n", "master-one"));
        assert_ne!(a, key_fingerprint("sk-live-abd", "master-one"));
        assert_ne!(a, key_fingerprint("sk-live-abc", "master-two"));
        assert_eq!(a.len(), 64);
        assert!(!a.contains("sk-live"));
    }

    fn stored(format: &str, plaintext: &str) -> StoredOwnerKey {
        StoredOwnerKey {
            link_id: Uuid::nil(),
            owner_member_id: Uuid::nil(),
            format: format.into(),
            base_url: "https://api.example.com/v1".into(),
            bearer_ciphertext: seal_bearer(plaintext, "master").unwrap(),
        }
    }

    #[test]
    fn only_a_plain_api_key_of_the_stored_format_opens() {
        let ok = decrypt_personal_link(&stored("openai", "sk-test-1"), "master").unwrap();
        assert!(matches!(ok.credential, LinkCredential::Bearer(ref key) if key == "sk-test-1"));

        let anthropic = LinkCredential::AnthropicKey("sk-ant-1".into()).to_sealed_plaintext();
        assert!(decrypt_personal_link(&stored("anthropic", &anthropic), "master").is_ok());
        // wrong format for the envelope, in both directions
        assert!(decrypt_personal_link(&stored("openai", &anthropic), "master").is_err());
        assert!(decrypt_personal_link(&stored("anthropic", "sk-test-1"), "master").is_err());
        // a subscription grant can never be a personal key
        let grant = r#"{"kind":"oauth-openai","refresh_token":"r","access_token":"a"}"#;
        assert!(decrypt_personal_link(&stored("openai", grant), "master").is_err());
        // wrong master key
        assert!(decrypt_personal_link(&stored("openai", "sk-test-1"), "other").is_err());
    }
}
