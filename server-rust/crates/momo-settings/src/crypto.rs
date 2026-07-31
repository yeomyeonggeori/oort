//! Reversible symmetric encryption for the ADR-0004 증보 1 provider bearer.
//!
//! Port of Swift `Provider/ProviderLinkCrypto.swift`. The wire format is the
//! contract, not an implementation detail: migrations 039/042 store a `bytea`
//! that either server must be able to open, so the layout is byte-for-byte the
//! Swift one —
//!
//! ```text
//! byte 0        format version (0x01)
//! bytes 1..13   AES-GCM nonce (96 bit)
//! bytes 13..n   ciphertext
//! last 16 bytes GCM tag
//! ```
//!
//! …which is exactly CryptoKit's `AES.GCM.SealedBox.combined` prefixed with the
//! version byte. The key is `SHA256("momo.provider_link.key.v1\n" || masterKey)`,
//! domain-separated so a leak of one master key cannot open another's boxes.
//!
//! **The plaintext bearer never leaves this module except to its caller.** It is
//! never logged, audited, echoed, or projected — the only thing a response may
//! carry is [`masked_tail`].

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use sha2::{Digest, Sha256};

/// Sealed-box format version. Byte 0 of the stored `bytea` (Swift :26).
pub const SEALED_BOX_VERSION: u8 = 0x01;

/// AES-GCM framing: a 96-bit nonce in front, a 128-bit tag behind.
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    #[error("bearer must not be empty")]
    EmptyPlaintext,
    #[error("sealed box carries an unknown format version")]
    BadVersion,
    #[error("sealed box is malformed")]
    MalformedCiphertext,
    #[error("sealed box did not open to valid UTF-8")]
    InvalidUtf8,
}

/// `SHA256("momo.provider_link.key.v1\n" || masterKey)` (Swift :36-40).
fn symmetric_key(master_key: &str) -> Key<Aes256Gcm> {
    let mut hasher = Sha256::new();
    hasher.update(b"momo.provider_link.key.v1\n");
    hasher.update(master_key.as_bytes());
    let digest = hasher.finalize();
    *Key::<Aes256Gcm>::from_slice(&digest)
}

/// Encrypt a plaintext bearer into `version || nonce || ciphertext || tag`.
///
/// The value is trimmed first, matching Swift, so a bearer pasted with a
/// trailing newline seals to the same secret the operator meant to type.
pub fn seal_bearer(plaintext: &str, master_key: &str) -> Result<Vec<u8>, CryptoError> {
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

/// Open a stored sealed box back to the plaintext bearer (Swift :56-70).
pub fn open_bearer(sealed: &[u8], master_key: &str) -> Result<String, CryptoError> {
    let (version, body) = sealed
        .split_first()
        .ok_or(CryptoError::MalformedCiphertext)?;
    if *version != SEALED_BOX_VERSION {
        return Err(CryptoError::BadVersion);
    }
    // nonce(12) + tag(16) is pure framing; a box with nothing beyond it cannot
    // carry a bearer, and Swift rejects the same boundary (`body.count > 28`).
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

/// The non-secret tail a GET surface may show (Swift :73-77).
///
/// A bearer shorter than 8 characters is masked **entirely**: four of six
/// characters is not a hint, it is most of the secret.
pub fn masked_tail(bearer: &str) -> Option<String> {
    let trimmed = bearer.trim();
    if trimmed.chars().count() < 8 {
        return None;
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Some(tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_bearer_round_trips_under_its_own_master_key() {
        let sealed = seal_bearer("  sk-live-abcdefgh  ", "master-one").expect("seal");
        assert_eq!(sealed[0], SEALED_BOX_VERSION, "version byte leads the box");
        assert_eq!(
            open_bearer(&sealed, "master-one").expect("open"),
            "sk-live-abcdefgh",
            "the stored value is the trimmed one"
        );
    }

    /// Domain separation is the whole reason this key is derived rather than
    /// used raw: another master key must not open these boxes.
    #[test]
    fn another_master_key_cannot_open_the_box() {
        let sealed = seal_bearer("sk-live-abcdefgh", "master-one").expect("seal");
        assert_eq!(
            open_bearer(&sealed, "master-two"),
            Err(CryptoError::MalformedCiphertext)
        );
    }

    /// A tampered tag must fail, not silently return partial plaintext — that is
    /// what makes this AEAD rather than encryption.
    #[test]
    fn a_flipped_byte_fails_authentication() {
        let mut sealed = seal_bearer("sk-live-abcdefgh", "master-one").expect("seal");
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert_eq!(
            open_bearer(&sealed, "master-one"),
            Err(CryptoError::MalformedCiphertext)
        );
    }

    #[test]
    fn framing_is_policed_before_the_cipher_runs() {
        assert_eq!(open_bearer(&[], "k"), Err(CryptoError::MalformedCiphertext));
        assert_eq!(
            open_bearer(&[0x02, 0x03], "k"),
            Err(CryptoError::BadVersion)
        );
        // version + 28 framing bytes and nothing else.
        let framing_only = [vec![SEALED_BOX_VERSION], vec![0u8; NONCE_LEN + TAG_LEN]].concat();
        assert_eq!(
            open_bearer(&framing_only, "k"),
            Err(CryptoError::MalformedCiphertext)
        );
    }

    #[test]
    fn an_empty_bearer_is_refused_rather_than_sealed() {
        assert_eq!(seal_bearer("   ", "k"), Err(CryptoError::EmptyPlaintext));
    }

    /// Swift's rule, kept exactly: below 8 characters there is no safe tail.
    #[test]
    fn a_short_secret_is_masked_entirely() {
        assert_eq!(masked_tail("sk-1234"), None, "7 chars is all secret");
        assert_eq!(masked_tail("sk-12345"), Some("2345".to_string()));
        assert_eq!(
            masked_tail("  sk-live-abcdefgh  "),
            Some("efgh".to_string())
        );
        // Multi-byte input must not be sliced mid-character.
        assert_eq!(
            masked_tail("키키키키키키키키"),
            Some("키키키키".to_string())
        );
    }

    /// Two seals of the same bearer differ — the nonce is fresh per call, so the
    /// stored `bytea` never doubles as a secret-equality oracle.
    #[test]
    fn the_nonce_is_fresh_on_every_seal() {
        let first = seal_bearer("sk-live-abcdefgh", "k").expect("seal");
        let second = seal_bearer("sk-live-abcdefgh", "k").expect("seal");
        assert_ne!(first, second);
        assert_eq!(open_bearer(&first, "k"), open_bearer(&second, "k"));
    }
}
