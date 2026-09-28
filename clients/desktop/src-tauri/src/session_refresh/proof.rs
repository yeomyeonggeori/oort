//! `momo.human.refresh_proof.v1` — the bytes the refresh key signs (#3106).
//!
//! Mirrors momo-wire `RefreshProof::signed_bytes` (server-rust
//! `crates/momo-wire/src/human_control.rs`, #3079, ADR-0146 D-7 증보):
//!
//! ```text
//! momo.human.refresh_proof.v1
//! {workspace_id}
//! {member_id}
//! {public_key_b64}         the refresh key (canonical base64, 33-byte SEC1)
//! {refresh_token_sha256}   lowercase hex SHA-256 of the presented refresh token
//! {nonce}                  128 random bits, one-time on the server
//! {signed_at_ms}           server time ±5 min
//! ```
//!
//! This is the ONLY statement the refresh key signs, and the builder is the
//! only way to reach it: there is no "sign these bytes" anywhere in the
//! refresh path, and the device (instruction) key's typed `Statement` has no
//! variant that produces this schema (`tests.rs` asserts both directions).
//! The shared vector is `docs/api/refresh-proof.vector.json`, printed by
//! momo-wire itself.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const REFRESH_PROOF_SCHEMA_V1: &str = "momo.human.refresh_proof.v1";
pub const P256_PUBLIC_KEY_LEN: usize = 33;
/// momo-wire `MAX_SAFE_INTEGER`: `signed_at_ms` must survive a JS number.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Lowercase hex SHA-256 of the raw refresh token (momo-wire
/// `refresh_token_sha256_hex`).
pub fn refresh_token_sha256_hex(raw_refresh_token: &str) -> String {
    hex::encode(Sha256::digest(raw_refresh_token.as_bytes()))
}

/// The typed fields of one proof. The token is the RAW refresh token the
/// request presents; only its hash reaches the signed bytes.
#[derive(Debug, Clone, Copy)]
pub struct ProofFields<'a> {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub refresh_token: &'a str,
    pub nonce: Uuid,
    pub signed_at_ms: i64,
}

/// The proof as `RefreshRequest.deviceProof` carries it (camelCase on the
/// wire, `docs/api/openapi.yaml` `RefreshDeviceProof`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProof {
    /// base64 of the 33-byte compressed SEC1 refresh key.
    pub public_key: String,
    pub nonce: Uuid,
    pub signed_at_ms: i64,
    /// base64 of raw r‖s (64 bytes).
    pub signature: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProofError {
    PublicKey,
    Token,
    SignedAt,
}

/// The exact bytes, for `public_key` (compressed SEC1). Refuses what the
/// server would refuse, so a malformed proof fails here, near its cause.
pub fn refresh_proof_bytes(
    fields: &ProofFields<'_>,
    public_key: &[u8; P256_PUBLIC_KEY_LEN],
) -> Result<Vec<u8>, ProofError> {
    if public_key[0] != 0x02 && public_key[0] != 0x03 {
        return Err(ProofError::PublicKey);
    }
    if fields.refresh_token.is_empty() {
        return Err(ProofError::Token);
    }
    if fields.signed_at_ms <= 0 || fields.signed_at_ms > MAX_SAFE_INTEGER {
        return Err(ProofError::SignedAt);
    }
    Ok(format!(
        "{REFRESH_PROOF_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}\n{}",
        fields.workspace_id,
        fields.member_id,
        BASE64.encode(public_key),
        refresh_token_sha256_hex(fields.refresh_token),
        fields.nonce,
        fields.signed_at_ms,
    )
    .into_bytes())
}
