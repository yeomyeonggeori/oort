//! The `provider_link` singleton (migration 039) and the DB-over-env resolution.
//!
//! Port of Swift `Provider/ProviderLinkStore.swift` + `ProviderLinkResolver.swift`.
//!
//! Two properties from the migration header are load-bearing here:
//!
//! * **The table is instance-global** — no `workspace_id`, a `boolean` primary
//!   key pinned to `true`. So every statement is a plain singleton read/write and
//!   none of them takes a workspace argument.
//! * **Its RLS policy is GUC-gated, not tenant-scoped**: a session sees the row
//!   only when `app.provider_link_admin = 'on'`. That GUC is set exclusively by
//!   [`momo_db::with_provider_link_admin_tx`], and only after the route has
//!   already decided the caller is an instance operator — the GUC is the last
//!   gate, never the first (ADR-0004 증보 1 D3).

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::crypto::{open_bearer, CryptoError};
use crate::oauth::LinkCredential;
use crate::provider::{ProviderConfig, ProviderMode};

/// The stored singleton, bearer still sealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredProviderLink {
    pub base_url: String,
    pub bearer_ciphertext: Vec<u8>,
    pub mode: String,
    pub updated_by_member_id: Option<Uuid>,
    pub updated_at_ms: i64,
}

/// A stored row with its bearer opened. Never serialize this — the REST
/// projection carries a masked tail instead (ADR-0004).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedProviderLink {
    pub base_url: String,
    /// The `Authorization: Bearer` value to present **right now**. For a legacy
    /// link that is the stored secret itself; for an ADR-0147 OAuth link it is
    /// the current access token, and it is empty until the worker mints one.
    /// Read [`DecryptedProviderLink::credential`] to know which.
    pub bearer: String,
    /// What the vault actually holds (ADR-0147 결정 1). A legacy row parses as
    /// [`LinkCredential::Bearer`], so this field is additive for every existing
    /// deployment.
    pub credential: LinkCredential,
    pub mode: ProviderMode,
    pub updated_by_member_id: Option<Uuid>,
    pub updated_at_ms: i64,
}

impl DecryptedProviderLink {
    /// Swift `isUsable` (`ProviderLinkResolver.swift:12-16`): a half-written row
    /// falls back to env rather than losing the provider entirely — fail safe,
    /// not fail blank.
    ///
    /// ADR-0147 widens "has a secret" to "has a secret **or** a grant it can
    /// exchange for one". A freshly registered OAuth link has no access token
    /// until its first turn; calling that half-written would silently send the
    /// instance back to the env bearer the operator had just replaced.
    pub fn is_usable(&self) -> bool {
        !self.base_url.trim().is_empty() && self.credential.is_present()
    }
}

/// Which tier won the DB-over-env precedence (Swift `ResolvedProviderConfig.Source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderSource {
    Database,
    Environment,
}

impl ProviderSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderSource::Database => "database",
            ProviderSource::Environment => "environment",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProvider {
    pub config: ProviderConfig,
    pub source: ProviderSource,
}

/// ADR-0004 증보 1: **a present and usable DB link beats env**, and nothing else
/// does (Swift `ProviderLinkResolver.resolve` :44-54).
///
/// The env config supplies the fields the operator link does not carry; the link
/// overrides mode, base URL, and bearer. Pure, so the precedence is testable
/// without a database.
pub fn resolve_link(
    env: &ProviderConfig,
    link: Option<&DecryptedProviderLink>,
) -> ResolvedProvider {
    match link.filter(|link| link.is_usable()) {
        None => ResolvedProvider {
            config: env.clone(),
            source: ProviderSource::Environment,
        },
        Some(link) => ResolvedProvider {
            config: ProviderConfig {
                mode: link.mode,
                base_url: link.base_url.clone(),
                bearer: link.bearer.clone(),
                allow_local_loopback: env.allow_local_loopback,
            },
            source: ProviderSource::Database,
        },
    }
}

/// Open a stored row (Swift `ProviderLinkStore.decrypt` :116-134).
///
/// A row whose ciphertext will not open — the usual cause is a rotated
/// `PROVIDER_LINK_MASTER_KEY` — is reported as `Err` and the caller treats it as
/// *absent for resolution* while keeping it *visible for editing*. Silently
/// erasing it would let the next replace-all delete a hop the operator can still
/// see.
pub fn decrypt_link(
    stored: &StoredProviderLink,
    master_key: &str,
) -> Result<DecryptedProviderLink, CryptoError> {
    let credential = LinkCredential::parse(&open_bearer(&stored.bearer_ciphertext, master_key)?);
    Ok(DecryptedProviderLink {
        base_url: stored.base_url.clone(),
        bearer: credential.presentable_bearer().to_string(),
        credential,
        mode: ProviderMode::from_label(&stored.mode).unwrap_or(ProviderMode::LocalMock),
        updated_by_member_id: stored.updated_by_member_id,
        updated_at_ms: stored.updated_at_ms,
    })
}

/// The `provider_link` projection as it comes off the wire: base URL, sealed
/// bearer, mode, last editor, and the monotonic `updated_at` the GUI polls on.
type ProviderLinkRow = (String, Vec<u8>, String, Option<Uuid>, i64);

/// Read the singleton, or `None` when the operator has configured no link.
pub async fn read_link(conn: &mut PgConnection) -> Result<Option<StoredProviderLink>, DbError> {
    let row: Option<ProviderLinkRow> = sqlx::query_as(
        "SELECT base_url, \
                bearer_ciphertext, \
                mode, \
                updated_by, \
                floor(extract(epoch from updated_at) * 1000)::bigint \
           FROM provider_link \
          WHERE id = true \
          LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(
        |(base_url, bearer_ciphertext, mode, updated_by, updated_at_ms)| StoredProviderLink {
            base_url,
            bearer_ciphertext,
            mode,
            updated_by_member_id: updated_by,
            updated_at_ms,
        },
    ))
}

/// Upsert the singleton. `bearer_ciphertext` is already sealed by the caller —
/// this function never sees a plaintext bearer, which is what keeps the
/// plaintext out of any query log.
///
/// `updated_at` advances **monotonically** (`greatest(clock_timestamp(), prev +
/// 1ms)`), the same trick the Swift store uses, so a same-millisecond re-save
/// still moves the timestamp the GUI polls on.
pub async fn upsert_link(
    conn: &mut PgConnection,
    base_url: &str,
    bearer_ciphertext: &[u8],
    mode: &str,
    updated_by: Uuid,
) -> Result<StoredProviderLink, DbError> {
    let (base_url, bearer_ciphertext, mode, updated_by, updated_at_ms): ProviderLinkRow =
        sqlx::query_as(
            "INSERT INTO provider_link \
           (id, base_url, bearer_ciphertext, mode, updated_by, updated_at) \
         VALUES (true, $1, $2, $3, $4, now()) \
         ON CONFLICT (id) DO UPDATE \
           SET base_url = EXCLUDED.base_url, \
               bearer_ciphertext = EXCLUDED.bearer_ciphertext, \
               mode = EXCLUDED.mode, \
               updated_by = EXCLUDED.updated_by, \
               updated_at = greatest( \
                 clock_timestamp(), \
                 provider_link.updated_at + interval '1 millisecond' \
               ) \
         RETURNING base_url, \
                   bearer_ciphertext, \
                   mode, \
                   updated_by, \
                   floor(extract(epoch from updated_at) * 1000)::bigint",
        )
        .bind(base_url)
        .bind(bearer_ciphertext)
        .bind(mode)
        .bind(updated_by)
        .fetch_one(&mut *conn)
        .await?;
    Ok(StoredProviderLink {
        base_url,
        bearer_ciphertext,
        mode,
        updated_by_member_id: updated_by,
        updated_at_ms,
    })
}

/// Replace **only** the sealed credential of the singleton — the worker's
/// refresh write-back (ADR-0147 결정 2, "갱신된 토큰은 금고에 재봉인").
///
/// Three properties make this a different statement from [`upsert_link`] rather
/// than a call into it:
///
/// * **It writes no operator fields.** `base_url`, `mode` and `updated_by` are
///   the operator's; a background refresh must not restate them, and it has no
///   member identity to put in `updated_by` in the first place.
/// * **It is guarded on `expected_updated_at_ms`.** A worker seals the
///   credential it read some milliseconds ago. If the operator replaced the link
///   in between, that read is stale, and writing it would resurrect a credential
///   they just revoked. The guard makes that a no-op (`Ok(None)`) instead, and
///   the worker simply re-reads on its next job.
/// * **It never inserts.** A link deleted mid-turn stays deleted.
///
/// `updated_at` advances monotonically, like the upsert, so the readers that
/// poll on it (the GUI, and the worker's own decrypt cache) see the rotation.
pub async fn reseal_link_credential(
    conn: &mut PgConnection,
    bearer_ciphertext: &[u8],
    expected_updated_at_ms: i64,
) -> Result<Option<StoredProviderLink>, DbError> {
    let row: Option<ProviderLinkRow> = sqlx::query_as(
        "UPDATE provider_link \
            SET bearer_ciphertext = $1, \
                updated_at = greatest( \
                  clock_timestamp(), \
                  provider_link.updated_at + interval '1 millisecond' \
                ) \
          WHERE id = true \
            AND floor(extract(epoch from updated_at) * 1000)::bigint = $2 \
      RETURNING base_url, \
                bearer_ciphertext, \
                mode, \
                updated_by, \
                floor(extract(epoch from updated_at) * 1000)::bigint",
    )
    .bind(bearer_ciphertext)
    .bind(expected_updated_at_ms)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(
        |(base_url, bearer_ciphertext, mode, updated_by, updated_at_ms)| StoredProviderLink {
            base_url,
            bearer_ciphertext,
            mode,
            updated_by_member_id: updated_by,
            updated_at_ms,
        },
    ))
}

/// Delete the singleton (revert to the env fallback). `true` when a row existed,
/// which is what decides whether an audit row is written — a DELETE that removed
/// nothing changed nothing.
pub async fn delete_link(conn: &mut PgConnection) -> Result<bool, DbError> {
    let removed: Option<bool> =
        sqlx::query_scalar("DELETE FROM provider_link WHERE id = true RETURNING true")
            .fetch_optional(&mut *conn)
            .await?;
    Ok(removed.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_config() -> ProviderConfig {
        ProviderConfig {
            mode: ProviderMode::LocalMock,
            base_url: "http://localhost:8088/v1".into(),
            bearer: "dev-insecure-hermes-bearer".into(),
            allow_local_loopback: true,
        }
    }

    fn link(base_url: &str, bearer: &str) -> DecryptedProviderLink {
        let credential = LinkCredential::Bearer(bearer.into());
        DecryptedProviderLink {
            base_url: base_url.into(),
            bearer: credential.presentable_bearer().to_string(),
            credential,
            mode: ProviderMode::ExternalHermes,
            updated_by_member_id: Some(Uuid::from_u128(7)),
            updated_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn a_usable_db_link_wins_over_env() {
        let resolved = resolve_link(
            &env_config(),
            Some(&link("https://api.example.com/v1", "sk-live-9f2c4a")),
        );
        assert_eq!(resolved.source, ProviderSource::Database);
        assert_eq!(resolved.config.mode, ProviderMode::ExternalHermes);
        assert_eq!(resolved.config.base_url, "https://api.example.com/v1");
        assert!(
            resolved.config.allow_local_loopback,
            "the loopback flag is an env/process fact the link does not carry"
        );
    }

    /// Fail **safe**, not blank: a half-written row must not take the provider
    /// away from a process that still has a working env trio.
    #[test]
    fn a_half_written_link_falls_back_to_env() {
        for broken in [
            link("", "sk-live-9f2c4a"),
            link("https://a.example/v1", "  "),
        ] {
            let resolved = resolve_link(&env_config(), Some(&broken));
            assert_eq!(resolved.source, ProviderSource::Environment);
            assert_eq!(resolved.config, env_config());
        }
        assert_eq!(
            resolve_link(&env_config(), None).source,
            ProviderSource::Environment
        );
    }

    /// ADR-0147 결정 1 end to end at the storage layer: an OAuth grant seals into
    /// the *existing* box, opens as an OAuth credential, and — crucially — is
    /// usable before it has ever produced an access token.
    #[test]
    fn an_oauth_grant_seals_into_the_existing_vault_and_resolves_as_a_db_link() {
        let credential = LinkCredential::OpenAiOAuth(Box::new(
            crate::oauth::OpenAiOAuthCredential::from_refresh_token("rt-operator"),
        ));
        let sealed =
            crate::crypto::seal_bearer(&credential.to_sealed_plaintext(), "master").expect("seal");
        let stored = StoredProviderLink {
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            bearer_ciphertext: sealed,
            // The row stays on one of migration 039's three CHECK labels: the
            // kind lives in the payload precisely so no DDL has to change.
            mode: "external-hermes".into(),
            updated_by_member_id: None,
            updated_at_ms: 42,
        };

        let decrypted = decrypt_link(&stored, "master").expect("open");
        assert_eq!(decrypted.credential, credential);
        assert_eq!(decrypted.bearer, "", "no access token has been minted yet");
        assert!(
            decrypted.is_usable(),
            "a grant-only link must not fall back to env — the worker mints the token"
        );
        assert_eq!(
            resolve_link(&env_config(), Some(&decrypted)).source,
            ProviderSource::Database
        );
    }

    #[test]
    fn an_unknown_stored_mode_reads_as_the_mock_not_as_external() {
        let sealed = crate::crypto::seal_bearer("sk-live-9f2c4a", "master").expect("seal");
        let stored = StoredProviderLink {
            base_url: "https://api.example.com/v1".into(),
            bearer_ciphertext: sealed,
            mode: "quantum-hermes".into(),
            updated_by_member_id: None,
            updated_at_ms: 1,
        };
        let decrypted = decrypt_link(&stored, "master").expect("open");
        assert_eq!(
            decrypted.mode,
            ProviderMode::LocalMock,
            "an unreadable mode must not promote the row to the external boundary"
        );
        assert_eq!(
            decrypt_link(&stored, "rotated-away"),
            Err(CryptoError::MalformedCiphertext)
        );
    }
}
