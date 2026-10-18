//! GitHub App credentials at rest, the registration manifest and the one-time
//! state that guards it (#3947 E-GH1 / ADR-0205 D1·D2·D6).
//!
//! ## What this module holds on to
//!
//! 1. **The instance's own integration credential, sealed.** The App's private
//!    key (`pem`) and webhook secrets are stored as AES-GCM sealed boxes under
//!    a key derived from the dedicated `GITHUB_APP_MASTER_KEY` with its own
//!    domain (`momo.github_app.key.v1\n`) — a leak of any other master key
//!    cannot open them, and this one cannot open any other. The wire layout is
//!    the same `version(0x01) || nonce(12) || ct || tag(16)` the provider link
//!    uses ([`crate::crypto`]).
//! 2. **Phase 1 never opens the PEM.** [`open_github_pem`] exists because phase 2
//!    (installation tokens) will need it and because the seal must round-trip in
//!    tests, but it has **zero call sites** in non-test code. `tests::
//!    the_pem_open_function_has_no_call_site_outside_this_file` greps the whole
//!    Rust tree for the identifier and fails the moment a handler, worker or
//!    binary names it (ADR-0205 D1, acceptance 7).
//! 3. **The manifest asks for five read permissions and nothing else.**
//!    [`GITHUB_DEFAULT_PERMISSIONS`] is the whole `default_permissions` object
//!    (owner decision 2026-10-16 evening, ADR-0205 D6, acceptance 12). Adding a
//!    write permission, or dropping `contents`, fails a test by name.
//! 4. **The state is one-time and stored as a hash.** The manifest flow's CSRF
//!    state is `<workspace uuid>.<32 random bytes>`; only SHA-256 of the whole
//!    string is stored, and [`consume_manifest_claim`] spends it atomically.
//!
//! Every function takes a caller-supplied `&mut PgConnection`: the GUC that
//! unlocks `github_app` (`app.github_app_admin`) is bound only by
//! `momo_db::with_github_app_admin_tx`, after the route's instance-operator gate.

use momo_db::DbError;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};

use crate::crypto::{CryptoError, SEALED_BOX_VERSION};

/// Sealing domain for every GitHub App secret (ADR-0205 D1).
pub const GITHUB_KEY_DOMAIN: &[u8] = b"momo.github_app.key.v1\n";

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// The webhook secret rotation overlap (ADR-0205 D7: 「초안 24시간」).
pub const WEBHOOK_SECRET_OVERLAP_HOURS: i64 = 24;

/// GitHub allows an hour between the manifest POST and the code conversion;
/// the one-time state lives exactly as long.
pub const MANIFEST_STATE_TTL_SECONDS: i64 = 3600;

/// `default_permissions` of the registration manifest — ADR-0205 D6, fixed by
/// the owner's decision 「이슈·PR·체크+코드 읽기」. **Read only, five lines.**
/// `contents: read` is what lets the App receive `push` and `release` events;
/// it is also why a key leak is worse than it was without it, which is why
/// phase 1 never opens the PEM.
pub const GITHUB_DEFAULT_PERMISSIONS: [(&str, &str); 5] = [
    ("metadata", "read"),
    ("issues", "read"),
    ("pull_requests", "read"),
    ("checks", "read"),
    ("contents", "read"),
];

/// `default_events` of the manifest (ADR-0205 D6). `installation` and
/// `installation_repositories` are delivered to every App and are not listed.
pub const GITHUB_DEFAULT_EVENTS: [&str; 7] = [
    "pull_request",
    "pull_request_review",
    "issues",
    "issue_comment",
    "check_suite",
    "push",
    "release",
];

// ---------------------------------------------------------------------------
// sealing
// ---------------------------------------------------------------------------

/// `SHA256("momo.github_app.key.v1\n" || masterKey)`.
fn symmetric_key(master_key: &str) -> Key<Aes256Gcm> {
    let mut hasher = Sha256::new();
    hasher.update(GITHUB_KEY_DOMAIN);
    hasher.update(master_key.as_bytes());
    let digest = hasher.finalize();
    *Key::<Aes256Gcm>::from_slice(&digest)
}

/// Seal a GitHub App secret (the PEM or a webhook secret). Trimmed first, so a
/// value pasted with a trailing newline seals to the secret the operator meant.
pub fn seal_github_secret(plaintext: &str, master_key: &str) -> Result<Vec<u8>, CryptoError> {
    let trimmed = plaintext.trim();
    if trimmed.is_empty() {
        return Err(CryptoError::EmptyPlaintext);
    }
    let cipher = Aes256Gcm::new(&symmetric_key(master_key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, trimmed.as_bytes())
        .map_err(|_| CryptoError::MalformedCiphertext)?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(SEALED_BOX_VERSION);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn open_github_secret(sealed: &[u8], master_key: &str) -> Result<String, CryptoError> {
    let (version, body) = sealed
        .split_first()
        .ok_or(CryptoError::MalformedCiphertext)?;
    if *version != SEALED_BOX_VERSION {
        return Err(CryptoError::BadVersion);
    }
    if body.len() <= NONCE_LEN + TAG_LEN {
        return Err(CryptoError::MalformedCiphertext);
    }
    let (nonce_bytes, ciphertext) = body.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(&symmetric_key(master_key));
    let opened = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| CryptoError::MalformedCiphertext)?;
    String::from_utf8(opened).map_err(|_| CryptoError::InvalidUtf8)
}

/// Open a sealed webhook secret (signature verification — E-GH2).
pub fn open_github_webhook_secret(sealed: &[u8], master_key: &str) -> Result<String, CryptoError> {
    open_github_secret(sealed, master_key)
}

/// Open the sealed App private key.
///
/// **Phase 1 has no caller.** Do not add one outside `#[cfg(test)]`: the
/// grep guard in this file's tests fails the build of the PR that does.
pub fn open_github_pem(sealed: &[u8], master_key: &str) -> Result<String, CryptoError> {
    open_github_secret(sealed, master_key)
}

/// Does `value` look like a PEM private key block? A paste-form sanity check,
/// not a validation of the key.
pub fn looks_like_pem_private_key(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("-----BEGIN ")
        && trimmed.contains("PRIVATE KEY-----")
        && trimmed.contains("-----END ")
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

/// Who will own the App on GitHub: a personal account or an organization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestOwner {
    User,
    Organization(String),
}

/// A GitHub organization login: 1-39 of `[A-Za-z0-9-]`, no edge hyphen.
pub fn is_valid_org_login(value: &str) -> bool {
    let len = value.len();
    (1..=39).contains(&len)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

/// Where the operator's browser POSTs the manifest.
pub fn manifest_registration_url(owner: &ManifestOwner, state: &str) -> String {
    let state = percent_encode(state);
    match owner {
        ManifestOwner::User => format!("https://github.com/settings/apps/new?state={state}"),
        ManifestOwner::Organization(org) => {
            format!("https://github.com/organizations/{org}/settings/apps/new?state={state}")
        }
    }
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The manifest GitHub receives (ADR-0205 D2). `public_base_url` is the
/// instance's public https origin (no trailing slash).
///
/// `public: false` — the App installs only on the account that owns it — and
/// `request_oauth_on_install: false`: oort never asks for, receives or keeps a
/// person's GitHub token (ADR-0113 D1-B stays rejected).
pub fn build_manifest(public_base_url: &str, app_name: &str) -> serde_json::Value {
    let base = public_base_url.trim_end_matches('/');
    let permissions: serde_json::Map<String, serde_json::Value> = GITHUB_DEFAULT_PERMISSIONS
        .iter()
        .map(|(name, level)| ((*name).to_string(), serde_json::Value::from(*level)))
        .collect();
    serde_json::json!({
        "name": app_name,
        "url": base,
        "hook_attributes": {
            "url": format!("{base}/v1/integrations/github/webhook"),
            "active": true,
        },
        "redirect_url": format!("{base}/v1/integrations/github/app/callback"),
        "setup_url": format!("{base}/v1/integrations/github/setup"),
        "description": "oort가 저장소의 PR·이슈·체크 소식을 채널로 받아 와요. 코드는 읽지 않아요.",
        "public": false,
        "request_oauth_on_install": false,
        "default_events": GITHUB_DEFAULT_EVENTS,
        "default_permissions": permissions,
    })
}

/// A GitHub App name (≤ 34 chars, `[A-Za-z0-9 -]`) derived from the instance
/// host, e.g. `oort-team-example-com`. The operator can rename it on GitHub.
pub fn default_app_name(public_base_url: &str) -> String {
    let host = public_base_url
        .trim()
        .trim_start_matches("https://")
        .split(['/', ':'])
        .next()
        .unwrap_or("");
    let slug: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-');
    let mut name = if slug.is_empty() {
        "oort".to_string()
    } else {
        format!("oort-{slug}")
    };
    name.truncate(34);
    name.trim_end_matches('-').to_string()
}

// ---------------------------------------------------------------------------
// one-time state
// ---------------------------------------------------------------------------

/// A fresh state token, `<workspace uuid>.<64 hex chars of CSPRNG>`. The uuid is
/// a **lookup hint** for the unauthenticated callback (it must know which tenant
/// to open); it grants nothing — the hash match does.
pub fn new_state_token(workspace_id: Uuid) -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)?;
    let mut random = String::with_capacity(64);
    for byte in bytes {
        random.push_str(&format!("{byte:02x}"));
    }
    Ok(format!("{workspace_id}.{random}"))
}

/// SHA-256 of the whole token — the only form that is stored.
pub fn state_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// The workspace hint in a token, if the token has the right shape.
pub fn state_workspace_hint(token: &str) -> Option<Uuid> {
    let (workspace, random) = token.split_once('.')?;
    if random.len() != 64 || !random.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Uuid::parse_str(workspace).ok()
}

/// Record a manifest-flow state for `member` (the operator who pressed 「GitHub
/// 앱 만들기」). Runs inside the operator's tenant transaction.
pub async fn insert_manifest_claim(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    hash: &[u8],
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO github_link_claim (workspace_id, member_id, purpose, state_hash, expires_at) \
         VALUES ($1, $2, 'app_manifest', $3, now() + make_interval(secs => $4))",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(hash)
    .bind(MANIFEST_STATE_TTL_SECONDS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Spend a manifest-flow state: exactly one caller can win, and only before the
/// state expires. Returns the member who minted it.
pub async fn consume_manifest_claim(
    conn: &mut PgConnection,
    hash: &[u8],
) -> Result<Option<Uuid>, DbError> {
    let member: Option<Uuid> = sqlx::query_scalar(
        "UPDATE github_link_claim \
            SET consumed_at = now() \
          WHERE state_hash = $1 \
            AND purpose = 'app_manifest' \
            AND consumed_at IS NULL \
            AND expires_at > now() \
          RETURNING member_id",
    )
    .bind(hash)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(member)
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/// Everything a registration stores. The two ciphertexts are already sealed by
/// the caller — this module's SQL never sees a plaintext secret.
pub struct NewGithubApp<'a> {
    pub app_id: i64,
    pub slug: &'a str,
    pub client_id: &'a str,
    pub owner_login: &'a str,
    pub owner_type: &'a str,
    pub pem_sealed: &'a [u8],
    pub webhook_secret_sealed: &'a [u8],
    /// `manifest` or `paste`.
    pub source: &'a str,
    pub created_by: Option<Uuid>,
}

/// Insert the singleton. Returns `false` (and writes nothing) when an App is
/// already registered — the manifest callback never overwrites a live App.
pub async fn insert_github_app(
    conn: &mut PgConnection,
    app: &NewGithubApp<'_>,
) -> Result<bool, DbError> {
    let inserted = sqlx::query(
        "INSERT INTO github_app \
           (app_id, slug, client_id, owner_login, owner_type, pem_ciphertext, \
            webhook_secret_ciphertext, source, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(app.app_id)
    .bind(app.slug)
    .bind(app.client_id)
    .bind(app.owner_login)
    .bind(app.owner_type)
    .bind(app.pem_sealed)
    .bind(app.webhook_secret_sealed)
    .bind(app.source)
    .bind(app.created_by)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(inserted == 1)
}

/// Paste-form write: insert, or replace the singleton. When the App id is
/// unchanged the previous webhook secret keeps verifying for the overlap window
/// (ADR-0205 D7); a different App id starts clean.
pub async fn upsert_github_app(
    conn: &mut PgConnection,
    app: &NewGithubApp<'_>,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO github_app \
           (app_id, slug, client_id, owner_login, owner_type, pem_ciphertext, \
            webhook_secret_ciphertext, source, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (id) DO UPDATE SET \
           webhook_secret_previous_ciphertext = \
             CASE WHEN github_app.app_id = EXCLUDED.app_id \
                  THEN github_app.webhook_secret_ciphertext END, \
           previous_valid_until = \
             CASE WHEN github_app.app_id = EXCLUDED.app_id \
                  THEN now() + make_interval(hours => $10) END, \
           app_id = EXCLUDED.app_id, \
           slug = EXCLUDED.slug, \
           client_id = EXCLUDED.client_id, \
           owner_login = EXCLUDED.owner_login, \
           owner_type = EXCLUDED.owner_type, \
           pem_ciphertext = EXCLUDED.pem_ciphertext, \
           webhook_secret_ciphertext = EXCLUDED.webhook_secret_ciphertext, \
           source = EXCLUDED.source, \
           created_by = EXCLUDED.created_by, \
           updated_at = now()",
    )
    .bind(app.app_id)
    .bind(app.slug)
    .bind(app.client_id)
    .bind(app.owner_login)
    .bind(app.owner_type)
    .bind(app.pem_sealed)
    .bind(app.webhook_secret_sealed)
    .bind(app.source)
    .bind(app.created_by)
    .bind(WEBHOOK_SECRET_OVERLAP_HOURS as i32)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// What the operator surface may show about the registered App. No ciphertext
/// column is selected, so none can reach a response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubAppStatus {
    pub app_id: i64,
    pub slug: String,
    pub client_id: String,
    pub owner_login: String,
    pub owner_type: String,
    pub source: String,
    pub created_by: Option<Uuid>,
    pub created_at_ms: i64,
    /// A previous webhook secret still verifies (rotation overlap window open).
    pub rotation_window_open: bool,
}

type StatusRow = (
    i64,
    String,
    String,
    String,
    String,
    String,
    Option<Uuid>,
    i64,
    bool,
);

pub async fn read_github_app_status(
    conn: &mut PgConnection,
) -> Result<Option<GithubAppStatus>, DbError> {
    let row: Option<StatusRow> = sqlx::query_as(
        "SELECT app_id, slug, client_id, owner_login, owner_type, source, created_by, \
                floor(extract(epoch from created_at) * 1000)::bigint, \
                (previous_valid_until IS NOT NULL AND previous_valid_until > now()) \
           FROM github_app \
          WHERE id = true \
          LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(
        |(
            app_id,
            slug,
            client_id,
            owner_login,
            owner_type,
            source,
            created_by,
            created_at_ms,
            rotation_window_open,
        )| GithubAppStatus {
            app_id,
            slug,
            client_id,
            owner_login,
            owner_type,
            source,
            created_by,
            created_at_ms,
            rotation_window_open,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    const PEM: &str =
        "-----BEGIN RSA PRIVATE KEY-----\nPEM-MARKER-0001\n-----END RSA PRIVATE KEY-----";

    #[test]
    fn a_sealed_secret_round_trips_under_its_own_master_key() {
        let sealed = seal_github_secret(&format!("  {PEM}\n"), "github-master").expect("seal");
        assert_eq!(sealed[0], SEALED_BOX_VERSION);
        assert_eq!(
            open_github_pem(&sealed, "github-master").expect("open"),
            PEM
        );
        assert!(
            !sealed.windows(10).any(|w| w == b"PEM-MARKER"),
            "the plaintext must not appear in the box"
        );
    }

    /// The domain is the point of a dedicated key: the provider-link key (same
    /// string!) must not open a GitHub box, and the reverse.
    #[test]
    fn the_provider_link_domain_cannot_open_a_github_box_even_with_the_same_key_string() {
        let sealed = seal_github_secret("whsec-marker-0001", "same-string").expect("seal");
        assert_eq!(
            crate::crypto::open_bearer(&sealed, "same-string"),
            Err(CryptoError::MalformedCiphertext)
        );
        let provider = crate::crypto::seal_bearer("sk-live-abcdefgh", "same-string").expect("seal");
        assert_eq!(
            open_github_webhook_secret(&provider, "same-string"),
            Err(CryptoError::MalformedCiphertext)
        );
    }

    #[test]
    fn another_master_key_and_a_flipped_byte_both_fail() {
        let mut sealed = seal_github_secret("whsec-marker-0001", "one").expect("seal");
        assert!(open_github_webhook_secret(&sealed, "two").is_err());
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(open_github_webhook_secret(&sealed, "one").is_err());
        assert_eq!(
            seal_github_secret("  ", "one"),
            Err(CryptoError::EmptyPlaintext)
        );
    }

    /// ADR-0205 D6 / acceptance 12. The set is compared whole: adding any
    /// permission (a write one above all), changing a level, or removing
    /// `contents` makes this fail.
    #[test]
    fn the_manifest_asks_for_exactly_five_read_permissions() {
        let manifest = build_manifest("https://oort.example.com", "oort-test");
        let permissions: BTreeMap<String, String> = manifest["default_permissions"]
            .as_object()
            .expect("default_permissions is an object")
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.as_str().expect("level is a string").to_string(),
                )
            })
            .collect();
        let expected: BTreeMap<String, String> =
            ["metadata", "issues", "pull_requests", "checks", "contents"]
                .iter()
                .map(|name| ((*name).to_string(), "read".to_string()))
                .collect();
        assert_eq!(permissions, expected);
        assert!(
            permissions.values().all(|level| level == "read"),
            "no write or admin permission, ever"
        );
        // The constant and the manifest are the same thing.
        assert_eq!(GITHUB_DEFAULT_PERMISSIONS.len(), 5);
    }

    #[test]
    fn the_manifest_is_private_takes_no_user_token_and_lists_the_d6_events() {
        let manifest = build_manifest("https://oort.example.com/", "oort-test");
        assert_eq!(manifest["public"], false);
        assert_eq!(manifest["request_oauth_on_install"], false);
        assert_eq!(
            manifest["hook_attributes"]["url"],
            "https://oort.example.com/v1/integrations/github/webhook"
        );
        assert_eq!(
            manifest["redirect_url"],
            "https://oort.example.com/v1/integrations/github/app/callback"
        );
        let events: Vec<&str> = manifest["default_events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(events, GITHUB_DEFAULT_EVENTS.to_vec());
        // No client-credential or callback_urls field: no user OAuth is asked for.
        assert!(manifest.get("callback_urls").is_none());
    }

    #[test]
    fn org_logins_and_app_names_are_policed() {
        assert!(is_valid_org_login("yeomyeonggeori"));
        assert!(is_valid_org_login("a-b-1"));
        for bad in ["", "-a", "a-", "a/b", "a b", "a?x=1", &"x".repeat(40)] {
            assert!(!is_valid_org_login(bad), "{bad}");
        }
        assert_eq!(
            default_app_name("https://momo.example.com"),
            "oort-momo-example-com"
        );
        assert!(default_app_name("https://a.very-long-host-name.example.com:8443/x").len() <= 34);
        assert_eq!(
            manifest_registration_url(&ManifestOwner::Organization("acme".into()), "a b"),
            "https://github.com/organizations/acme/settings/apps/new?state=a%20b"
        );
    }

    #[test]
    fn a_state_token_carries_a_hint_and_only_its_hash_is_kept() {
        let workspace = Uuid::new_v4();
        let token = new_state_token(workspace).expect("state");
        assert_eq!(state_workspace_hint(&token), Some(workspace));
        assert_ne!(token, new_state_token(workspace).expect("state"));
        assert_eq!(state_hash(&token).len(), 32);
        assert!(!state_hash(&token)
            .windows(8)
            .any(|w| token.as_bytes().windows(8).any(|t| t == w)));
        for bad in ["", "x", "not-a-uuid.abcd", &format!("{workspace}.short")] {
            assert_eq!(state_workspace_hint(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_pem_paste_check_is_a_shape_check() {
        assert!(looks_like_pem_private_key(PEM));
        assert!(looks_like_pem_private_key(
            "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
        ));
        assert!(!looks_like_pem_private_key("whsec-not-a-pem"));
        assert!(!looks_like_pem_private_key(
            "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"
        ));
    }

    // -- acceptance 7: the grep guard ---------------------------------------

    fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                if name == "target" || name.starts_with('.') {
                    continue;
                }
                rust_sources(&path, out);
            } else if name.ends_with(".rs") {
                out.push(path);
            }
        }
    }

    /// Every `.rs` file under `server-rust/` except this one must not contain the
    /// identifier — that covers handlers, workers, binaries, other crates **and**
    /// their integration tests. Inside this file the identifier may appear only
    /// at its definition (before the `#[cfg(test)]` marker) and in tests.
    #[test]
    fn the_pem_open_function_has_no_call_site_outside_this_file() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .expect("canonical manifest dir");
        let root = manifest
            .join("../..")
            .canonicalize()
            .expect("server-rust root");
        let mut files = Vec::new();
        rust_sources(&root, &mut files);
        assert!(files.len() > 100, "the walk found {} files", files.len());
        // Exactly this file, by canonical path: a second `github_app.rs` elsewhere (the route
        // module has the same name) must NOT inherit the exemption.
        let this_file = manifest.join("src/github_app.rs");
        assert!(
            files.contains(&this_file),
            "the walk must reach this very file"
        );
        let needle = ["open_github", "_pem"].concat();
        let mut offenders = Vec::new();
        for path in &files {
            if *path == this_file {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            if text.contains(&needle) {
                offenders.push(path.display().to_string());
            }
        }
        assert!(
            offenders.is_empty(),
            "PEM-opening function named outside momo-settings/src/github_app.rs: {offenders:?} \
             (ADR-0205 D1: phase 1 never opens the PEM)"
        );

        // Inside this file: the production half (before the test module) names it once, at the definition.
        let own = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/github_app.rs"),
        )
        .expect("read self");
        let production = own
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production half");
        let in_prod: Vec<&str> = production
            .lines()
            .filter(|line| line.contains(&needle) && !line.trim_start().starts_with("//"))
            .collect();
        assert_eq!(
            in_prod.len(),
            1,
            "only the definition may name the PEM opener in production code: {in_prod:?}"
        );
        assert!(in_prod[0].contains("pub fn "));
    }
}
