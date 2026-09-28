//! The refresh key in the Secure Enclave (#3106) — the macOS `RefreshSigner`.
//!
//! A second enclave key beside the instruction key, with its own tag in the
//! same app-only access group (`device_key::enclave::REFRESH_KEY_TAG`):
//! PrivateKeyUsage only, `AfterFirstUnlockThisDeviceOnly`, never
//! synchronised. Made on first use, silently — there is nothing to confirm:
//! it can only narrow what the refresh token already allows (ADR-0146 D-7
//! 증보 #3079, 「신뢰 역할이 없다」).
//!
//! No software fallback: an unsigned build, a build without the access-group
//! entitlement, or a Mac without an enclave has no key, and its refreshes go
//! without a proof (`Ok(None)`).
//!
//! `runtime-unverified` until an owner-approved signed build runs (M7).

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};

use super::proof::{refresh_proof_bytes, DeviceProof, ProofFields};
use super::RefreshSigner;
use crate::device_key::enclave::{self, EnclaveError};
use crate::device_key::payload::der_to_raw_low_s;

pub struct EnclaveRefreshKey;

/// Refusals that mean "no key can exist in this build", not "something broke".
fn no_key_here(error: &EnclaveError) -> bool {
    matches!(
        error,
        EnclaveError::UnsignedBuild
            | EnclaveError::EntitlementMissing
            | EnclaveError::Unsupported(_)
    )
}

impl RefreshSigner for EnclaveRefreshKey {
    fn prove(&self, fields: &ProofFields<'_>) -> Result<Option<DeviceProof>, String> {
        let group = match enclave::access_group() {
            Ok(group) => group,
            Err(error) if no_key_here(&error) => return Ok(None),
            Err(error) => return Err(error.code()),
        };
        let key = match enclave::find_refresh_key(&group) {
            Ok(Some(key)) => key,
            Ok(None) => match enclave::create_refresh_key(&group) {
                Ok(key) => key,
                Err(error) if no_key_here(&error) => return Ok(None),
                Err(error) => return Err(error.code()),
            },
            Err(error) if no_key_here(&error) => return Ok(None),
            Err(error) => return Err(error.code()),
        };
        let public = enclave::public_key(&key).map_err(|e| e.code())?;
        let bytes = refresh_proof_bytes(fields, &public).map_err(|e| format!("{e:?}"))?;
        let der = enclave::sign_der(&key, &bytes).map_err(|e| e.code())?;
        let raw = der_to_raw_low_s(&der).ok_or("refresh key: signature encoding")?;
        // Self-verify: a proof the server would refuse is worse than none —
        // under `require` it would read as another key's.
        let verifying =
            VerifyingKey::from_sec1_bytes(&public).map_err(|_| "refresh key: public")?;
        let signature = Signature::from_slice(&raw).map_err(|_| "refresh key: signature")?;
        verifying
            .verify(&bytes, &signature)
            .map_err(|_| "refresh key: self-verify failed")?;
        Ok(Some(DeviceProof {
            public_key: BASE64.encode(public),
            nonce: fields.nonce,
            signed_at_ms: fields.signed_at_ms,
            signature: BASE64.encode(raw),
        }))
    }
}
