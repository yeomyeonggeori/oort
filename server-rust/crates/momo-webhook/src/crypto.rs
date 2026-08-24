//! ADR-0115 webhook cryptography — a byte-for-byte port of Swift
//! `server/Sources/MomoServer/Webhook/WebhookCrypto.swift` and the two static
//! helpers on `relay/OutboxRelay/.../WebhookDeliveryClient.swift`.
//!
//! ## Why this is a port and not a redesign
//!
//! Every subscriber that already holds a credential holds one the *Swift* server
//! issued. #1222 replaces the server, not the subscribers: an outbound
//! subscription's secret is derived on demand from `(master key, secret_ref)`
//! and the row keeps only the reference, so the day this crate computes a
//! different string is the day every live subscription starts rejecting
//! signatures with no row anywhere recording that anything changed. The tests at
//! the bottom pin the exact vectors rather than merely asserting self-consistency.
//!
//! ## The shape, in one place
//!
//! ```text
//! secret_ref            43 chars, base64url(32 random bytes), no padding
//! native  (inbound)     "momo_whsec_v1."  || b64url(HMAC-SHA256(master, "momo.webhook.native.v1\n"   || ref))
//! outbound (event sub)  "momo_evtsec_v1." || b64url(HMAC-SHA256(master, "momo.webhook.outbound.v1\n" || ref))
//! slack token           "momo_hook_v1." || <workspace uuid> || "." || <43-char ref>
//! stored slack material "sha256:" || hex(SHA-256(token))     — the token itself is never stored
//! delivery signature    hex(HMAC-SHA256(secret, "<unix seconds>." || body))
//! ```
//!
//! The two domain separators are the reason one master key can serve both
//! directions: an inbound secret and an outbound secret derived from the *same*
//! reference are unrelated values, so a leak of one direction's material cannot
//! be replayed into the other.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// Inbound (ADR-0115 native ingress) one-time secret prefix.
pub const NATIVE_SECRET_PREFIX: &str = "momo_whsec_v1";
/// Outbound (event subscription) one-time secret prefix.
pub const OUTBOUND_SECRET_PREFIX: &str = "momo_evtsec_v1";
/// Slack-compatible URL token prefix.
pub const SLACK_TOKEN_PREFIX: &str = "momo_hook_v1";

const NATIVE_DOMAIN: &str = "momo.webhook.native.v1\n";
const OUTBOUND_DOMAIN: &str = "momo.webhook.outbound.v1\n";

/// 32 bytes of OS entropy, base64url-encoded without padding — exactly the 43
/// characters `webhook_secret_key_ref_ck` and `event_subscription_secret_ref_ck`
/// both spell as `^[A-Za-z0-9_-]{43}$`.
///
/// This value is **not** a secret: it is stored in the clear and is only half of
/// the derivation. That is the whole point of the design — a database dump
/// yields no credential without the master key, which never enters Postgres.
///
/// # Panics
/// If the operating system cannot supply entropy. Continuing from that state
/// would mean minting a webhook credential from a degraded source; a crash on
/// boot-grade breakage is the safer failure.
pub fn random_reference() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .expect("OS entropy unavailable; refusing to mint a credential");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn derive(master_key: &str, domain: &str, secret_ref: &str, prefix: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(master_key.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(domain.as_bytes());
    mac.update(secret_ref.as_bytes());
    let code = mac.finalize().into_bytes();
    format!("{prefix}.{}", URL_SAFE_NO_PAD.encode(code))
}

/// The inbound native HMAC secret revealed once by create/rotate.
pub fn native_secret(master_key: &str, secret_ref: &str) -> String {
    derive(master_key, NATIVE_DOMAIN, secret_ref, NATIVE_SECRET_PREFIX)
}

/// The outbound signing secret revealed once by `POST …/event-subscriptions`
/// and recomputed by the sender for every delivery.
pub fn outbound_secret(master_key: &str, secret_ref: &str) -> String {
    derive(
        master_key,
        OUTBOUND_DOMAIN,
        secret_ref,
        OUTBOUND_SECRET_PREFIX,
    )
}

/// The Slack-compatible URL token: prefix, workspace, reference. The workspace
/// segment is what lets `/hooks/{token}` find its tenant before any DB read.
pub fn slack_token(workspace_id: Uuid) -> String {
    format!(
        "{SLACK_TOKEN_PREFIX}.{}.{}",
        hyphenated(workspace_id),
        random_reference()
    )
}

/// Recover the tenant from a Slack-compatible token without trusting it: the
/// shape is checked (three segments, known prefix, 43-char reference) and the
/// answer is still only a *lookup* key — authentication is the stored digest.
pub fn workspace_id_from_slack_token(token: &str) -> Option<Uuid> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != SLACK_TOKEN_PREFIX || parts[2].len() != 43 {
        return None;
    }
    Uuid::parse_str(parts[1]).ok()
}

/// `sha256:<hex>` — the only form of a Slack URL token that reaches Postgres
/// (`webhook_secret_key_hash_ck`).
pub fn token_hash(token: &str) -> String {
    format!("sha256:{}", sha256_hex(token.as_bytes()))
}

/// Lowercase hex SHA-256, the spelling every `*_sha256` column uses.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

/// The **outbound** delivery signature: `hex(HMAC-SHA256(secret, "<ts>." || body))`,
/// sent as `X-Momo-Signature: v1=<hex>`.
///
/// The timestamp is inside the signed material rather than beside it, which is
/// what makes the header a replay bound and not just a hint: a subscriber that
/// checks the clock is checking a value the attacker cannot move without
/// invalidating the signature. Ported from
/// `SafeWebhookDeliveryClient.signature(secret:timestamp:body:)`.
pub fn delivery_signature(secret: &str, timestamp: &str, body: &[u8]) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// The lowercase hyphenated uuid spelling every wire field and every derivation
/// input in this family uses. Swift reaches `uuidString.lowercased()`; `uuid`'s
/// `Display` is already that, so this exists to make the intent greppable.
pub(crate) fn hyphenated(id: Uuid) -> String {
    id.hyphenated().to_string()
}

// ---------------------------------------------------------------------------
// ADR-0171 doorbell AEAD — operator-supplied Bearer, reversible, domain-separated
//
// Event-subscription secrets are derived and never stored. A doorbell secret is
// the opposite: the operator pastes a vendor webhook key that we must replay as
// `Authorization: Bearer`. That needs authenticated reversible encryption, the
// same framing `momo-settings` uses for provider links, with a *different*
// domain so a leaked provider box cannot open a doorbell box.
// ---------------------------------------------------------------------------

/// Sealed-box format version. Byte 0 of the stored `bytea`.
pub const DOORBELL_SEALED_VERSION: u8 = 0x01;
const DOORBELL_NONCE_LEN: usize = 12;
const DOORBELL_TAG_LEN: usize = 16;
const DOORBELL_KEY_DOMAIN: &[u8] = b"momo.hosted_doorbell.key.v1\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DoorbellSealError {
    #[error("doorbell secret must not be empty")]
    EmptyPlaintext,
    #[error("doorbell secret exceeds the sealed-box bound")]
    TooLong,
    #[error("sealed doorbell box carries an unknown format version")]
    BadVersion,
    #[error("sealed doorbell box is malformed")]
    MalformedCiphertext,
    #[error("sealed doorbell box did not open to valid UTF-8")]
    InvalidUtf8,
}

/// Maximum operator-supplied Bearer length. Far above a Cursor sender key;
/// short enough that a pasted dump cannot become an unbounded `bytea`.
pub const DOORBELL_SECRET_MAX_BYTES: usize = 4_096;

fn doorbell_symmetric_key(master_key: &str) -> Key<Aes256Gcm> {
    let mut hasher = Sha256::new();
    hasher.update(DOORBELL_KEY_DOMAIN);
    hasher.update(master_key.as_bytes());
    let digest = hasher.finalize();
    *Key::<Aes256Gcm>::from_slice(&digest)
}

/// Encrypt an operator doorbell Bearer into `version || nonce || ciphertext || tag`.
pub fn seal_doorbell_secret(
    plaintext: &str,
    master_key: &str,
) -> Result<Vec<u8>, DoorbellSealError> {
    let trimmed = plaintext.trim();
    if trimmed.is_empty() {
        return Err(DoorbellSealError::EmptyPlaintext);
    }
    if trimmed.len() > DOORBELL_SECRET_MAX_BYTES {
        return Err(DoorbellSealError::TooLong);
    }
    let cipher = Aes256Gcm::new(&doorbell_symmetric_key(master_key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, trimmed.as_bytes())
        .map_err(|_| DoorbellSealError::MalformedCiphertext)?;
    let mut out = Vec::with_capacity(1 + DOORBELL_NONCE_LEN + ciphertext.len());
    out.push(DOORBELL_SEALED_VERSION);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a stored doorbell box back to the Bearer the sender will present.
pub fn open_doorbell_secret(sealed: &[u8], master_key: &str) -> Result<String, DoorbellSealError> {
    let (version, body) = sealed
        .split_first()
        .ok_or(DoorbellSealError::MalformedCiphertext)?;
    if *version != DOORBELL_SEALED_VERSION {
        return Err(DoorbellSealError::BadVersion);
    }
    if body.len() <= DOORBELL_NONCE_LEN + DOORBELL_TAG_LEN {
        return Err(DoorbellSealError::MalformedCiphertext);
    }
    let (nonce_bytes, ciphertext) = body.split_at(DOORBELL_NONCE_LEN);
    let cipher = Aes256Gcm::new(&doorbell_symmetric_key(master_key));
    let opened = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| DoorbellSealError::MalformedCiphertext)?;
    String::from_utf8(opened).map_err(|_| DoorbellSealError::InvalidUtf8)
}

/// Non-secret display for GET. Short secrets are fully masked; otherwise the
/// last four characters ride behind a bullet prefix. Never the plaintext.
pub fn masked_doorbell_secret(secret: &str) -> String {
    let trimmed = secret.trim();
    if trimmed.chars().count() < 8 {
        return "••••".to_string();
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frozen vectors. These are not "whatever the code does today" — they are
    /// what the Swift implementation produces for the same inputs, and a diff
    /// here means every live subscriber's signature check has just broken.
    #[test]
    fn derivations_match_the_swift_vectors() {
        let master = "test-master-key";
        let reference = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(
            native_secret(master, reference),
            "momo_whsec_v1.ZkAKc81cBF2YwDtDQs9byd5Ohj_zUPOMIyEiKA_iyP0"
        );
        assert_eq!(
            outbound_secret(master, reference),
            "momo_evtsec_v1.W-mvW7bBsnIJAyjhdxFvUlwZM88xi5dD-9Fe_N53PUA"
        );
    }

    /// One reference, two directions, two unrelated secrets — the reason a single
    /// master key is not a shared fate between inbound and outbound.
    #[test]
    fn the_two_domains_never_produce_the_same_secret() {
        let reference = random_reference();
        let native = native_secret("k", &reference);
        let outbound = outbound_secret("k", &reference);
        assert_ne!(
            native.split_once('.').unwrap().1,
            outbound.split_once('.').unwrap().1,
            "a shared master key must not make one direction's leak the other's"
        );
    }

    #[test]
    fn a_reference_is_the_43_chars_the_check_constraint_demands() {
        for _ in 0..16 {
            let reference = random_reference();
            assert_eq!(reference.len(), 43);
            assert!(
                reference
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "secret_ref must satisfy ^[A-Za-z0-9_-]{{43}}$ — got {reference}"
            );
        }
    }

    #[test]
    fn a_slack_token_names_its_tenant_and_a_broken_one_names_nobody() {
        let workspace = Uuid::from_u128(0x4242);
        let token = slack_token(workspace);
        assert_eq!(workspace_id_from_slack_token(&token), Some(workspace));
        assert_eq!(workspace_id_from_slack_token("nope"), None);
        assert_eq!(
            workspace_id_from_slack_token(&format!("other_v1.{workspace}.{}", random_reference())),
            None,
            "a foreign prefix must not be read as one of ours"
        );
        assert_eq!(
            workspace_id_from_slack_token(&format!("{SLACK_TOKEN_PREFIX}.{workspace}.short")),
            None
        );
    }

    #[test]
    fn the_stored_slack_material_is_a_digest_in_the_columns_spelling() {
        let hash = token_hash("momo_hook_v1.abc.def");
        assert!(hash.starts_with("sha256:"));
        assert_eq!(hash.len(), "sha256:".len() + 64);
        assert!(hash["sha256:".len()..]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    /// The timestamp is *inside* the signed bytes; moving it must break the
    /// signature, which is the replay bound the header claims to be.
    #[test]
    fn the_delivery_signature_binds_the_timestamp_to_the_body() {
        let secret = "momo_evtsec_v1.whatever";
        let body = br#"{"kind":"mention"}"#;
        let at_100 = delivery_signature(secret, "100", body);
        let at_101 = delivery_signature(secret, "101", body);
        assert_ne!(at_100, at_101);
        assert_eq!(at_100.len(), 64);
        assert_eq!(
            at_100,
            delivery_signature(secret, "100", body),
            "the signature must be deterministic or a retry looks like a forgery"
        );
        assert_ne!(
            at_100,
            delivery_signature(secret, "100", br#"{"kind":"approval_request"}"#)
        );
    }

    #[test]
    fn a_doorbell_secret_round_trips_under_its_own_master_key() {
        let sealed = seal_doorbell_secret("  crsr_live_abcdefgh  ", "master-one").expect("seal");
        assert_eq!(sealed[0], DOORBELL_SEALED_VERSION);
        assert_eq!(
            open_doorbell_secret(&sealed, "master-one").expect("open"),
            "crsr_live_abcdefgh"
        );
    }

    #[test]
    fn a_provider_link_master_key_cannot_open_a_doorbell_box() {
        let sealed = seal_doorbell_secret("crsr_live_abcdefgh", "master-one").expect("seal");
        assert_eq!(
            open_doorbell_secret(&sealed, "master-two"),
            Err(DoorbellSealError::MalformedCiphertext)
        );
    }

    #[test]
    fn a_short_doorbell_secret_is_masked_entirely() {
        assert_eq!(masked_doorbell_secret("crsr_12"), "••••");
        assert_eq!(masked_doorbell_secret("crsr_12345"), "••••2345");
        assert!(
            !masked_doorbell_secret("crsr_live_abcdefgh").contains("crsr_live_abcdefgh"),
            "the display string must never be the plaintext"
        );
    }

    /// RED of the unguarded path: echoing the pasted Bearer in a response body
    /// is exactly the leak AC1 forbids. The masked helper is what makes that
    /// assertion fail if someone swaps it for the raw secret.
    #[test]
    fn an_unguarded_echo_would_put_the_secret_on_the_wire() {
        let secret = "crsr_live_super_secret_value";
        let unguarded = serde_json::json!({"secret": secret}).to_string();
        let guarded =
            serde_json::json!({"secretMasked": masked_doorbell_secret(secret)}).to_string();
        assert!(unguarded.contains(secret), "the unguarded body is the red");
        assert!(
            !guarded.contains(secret),
            "removing the mask helper would fail this assertion"
        );
    }
}
