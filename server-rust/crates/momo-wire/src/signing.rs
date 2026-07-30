//! WorkHost signing format + Ed25519 helpers — byte-identical to the Swift
//! signer/verifier.
//!
//! Format strings (UTF-8, `\n`-joined), ported verbatim:
//!   * heartbeat v1: `momo.work_host.heartbeat.v1\n{ws}\n{host}\n{sentAtMs}`
//!   * request  v2: `momo.work_host.request.v2\n{METHOD}\n{path}\n{ws}\n{host}\n{sentAtMs}\n{bodyDigest}\n{requestID}`
//!
//! UUIDs render lowercased+hyphenated (Rust `Uuid` `Display` == Swift
//! `uuidString.lowercased()`); method is upper-cased; `bodyDigest` is the
//! lowercase hex SHA-256 of the raw body. Curve25519 signing in CryptoKit is
//! Ed25519, so `ed25519-dalek` verifies/produces the identical bytes.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const HEARTBEAT_SCHEMA_V1: &str = "momo.work_host.heartbeat.v1";
pub const REQUEST_SCHEMA_V2: &str = "momo.work_host.request.v2";

#[derive(Debug, thiserror::Error)]
pub enum SigningError {
    #[error("invalid Ed25519 public key length: expected 32, got {0}")]
    PublicKeyLength(usize),
    #[error("invalid Ed25519 signature length: expected 64, got {0}")]
    SignatureLength(usize),
    #[error("invalid Ed25519 signing key length: expected 32, got {0}")]
    SigningKeyLength(usize),
    #[error("base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("invalid Ed25519 public key: {0}")]
    PublicKey(#[from] ed25519_dalek::SignatureError),
}

/// Build the heartbeat v1 signing payload (`Signing.swift:26-36`).
pub fn heartbeat_payload(workspace_id: Uuid, host_id: Uuid, sent_at_ms: i64) -> Vec<u8> {
    format!("{HEARTBEAT_SCHEMA_V1}\n{workspace_id}\n{host_id}\n{sent_at_ms}").into_bytes()
}

/// Build the request v2 signing payload (`Signing.swift:38-64` ==
/// `WorkHostAuthenticator.swift:128-154`). `method` is upper-cased to match; the
/// caller supplies `body_digest` as lowercase hex SHA-256 (see [`sha256_hex`]).
pub fn request_payload(
    method: &str,
    path: &str,
    workspace_id: Uuid,
    host_id: Uuid,
    sent_at_ms: i64,
    body_digest: &str,
    request_id: Uuid,
) -> Vec<u8> {
    let method = method.to_uppercase();
    format!(
        "{REQUEST_SCHEMA_V2}\n{method}\n{path}\n{workspace_id}\n{host_id}\n{sent_at_ms}\n{body_digest}\n{request_id}"
    )
    .into_bytes()
}

/// Lowercase hex SHA-256 of a raw body (`Signing.swift:66-68`).
pub fn sha256_hex(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    hex::encode(digest)
}

/// Sign `payload` with a 32-byte Ed25519 seed (CryptoKit `rawRepresentation`).
pub fn sign(signing_key_bytes: &[u8], payload: &[u8]) -> Result<[u8; 64], SigningError> {
    let seed: [u8; 32] = signing_key_bytes
        .try_into()
        .map_err(|_| SigningError::SigningKeyLength(signing_key_bytes.len()))?;
    let key = SigningKey::from_bytes(&seed);
    Ok(key.sign(payload).to_bytes())
}

/// Sign and base64-encode, mirroring `WorkHostSigner.signatureBase64(for:)`.
pub fn sign_base64(signing_key_bytes: &[u8], payload: &[u8]) -> Result<String, SigningError> {
    Ok(BASE64.encode(sign(signing_key_bytes, payload)?))
}

/// Verify a raw 64-byte signature against a 32-byte public key.
pub fn verify(public_key: &[u8], payload: &[u8], signature: &[u8]) -> bool {
    let Ok(key_bytes): Result<[u8; 32], _> = public_key.try_into() else {
        return false;
    };
    let Ok(sig_bytes): Result<[u8; 64], _> = signature.try_into() else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };
    key.verify(payload, &Signature::from_bytes(&sig_bytes))
        .is_ok()
}

/// Verify a base64 public key + base64 signature, matching the server's
/// `WorkHostAuthenticator.verifySignature` guards (32-byte key, 64-byte sig).
pub fn verify_base64(public_key_b64: &str, signature_b64: &str, payload: &[u8]) -> bool {
    let (Ok(key), Ok(sig)) = (BASE64.decode(public_key_b64), BASE64.decode(signature_b64)) else {
        return false;
    };
    verify(&key, payload, &sig)
}

/// High-level WorkHost request verification: rebuild the v2 payload and verify
/// the base64 signature. Mirrors `WorkHostAuthenticator.verifySignature`.
#[allow(clippy::too_many_arguments)]
pub fn verify_work_host_request(
    public_key_b64: &str,
    signature_b64: &str,
    method: &str,
    path: &str,
    workspace_id: Uuid,
    host_id: Uuid,
    sent_at_ms: i64,
    body_digest: &str,
    request_id: Uuid,
) -> bool {
    let payload = request_payload(
        method,
        path,
        workspace_id,
        host_id,
        sent_at_ms,
        body_digest,
        request_id,
    );
    verify_base64(public_key_b64, signature_b64, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixed 32-byte seed (not a real key) — deterministic sign/verify wiring.
    const SEED: [u8; 32] = [7u8; 32];

    #[test]
    fn sign_then_verify_roundtrips() {
        let payload = heartbeat_payload(Uuid::from_u128(1), Uuid::from_u128(2), 1_730_000_000_000);
        let sig = sign(&SEED, &payload).expect("sign");
        let public = SigningKey::from_bytes(&SEED).verifying_key().to_bytes();
        assert!(verify(&public, &payload, &sig));
    }

    #[test]
    fn verify_rejects_tampered_payload() {
        let payload = heartbeat_payload(Uuid::from_u128(1), Uuid::from_u128(2), 1_730_000_000_000);
        let sig = sign(&SEED, &payload).expect("sign");
        let public = SigningKey::from_bytes(&SEED).verifying_key().to_bytes();
        let mut tampered = payload.clone();
        tampered[0] ^= 0xFF;
        assert!(!verify(&public, &tampered, &sig));
    }

    #[test]
    fn sha256_hex_of_empty_matches_known_vector() {
        // Cross-checks against Swift's SHA256.hash + "%02x" hex for an empty body.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
