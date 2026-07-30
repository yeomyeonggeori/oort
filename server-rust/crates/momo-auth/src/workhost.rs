//! WorkHost request signature verification.
//!
//! Thin wrapper over the shared `momo-wire` format so the server verifier and
//! the workd signer are guaranteed to agree (Swift had them duplicated). Mirrors
//! `WorkHostAuthenticator.verifySignature` (`Auth/WorkHostAuthenticator.swift:156-183`):
//! 32-byte base64 public key, 64-byte base64 signature, v2 request payload.
//!
//! The surrounding checks the Swift authenticator also performs — route
//! allow-listing, timestamp skew, one-time request-id consumption, and the
//! `work_host` row lookup under RLS — are DB/HTTP concerns wired in B1's server
//! binary. This crate owns only the cryptographic verdict.

use uuid::Uuid;

/// Verify a WorkHost v2 request signature. Returns `true` iff the base64
/// signature is valid for the reconstructed payload under the base64 public key.
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
    momo_wire::verify_work_host_request(
        public_key_b64,
        signature_b64,
        method,
        path,
        workspace_id,
        host_id,
        sent_at_ms,
        body_digest,
        request_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use ed25519_dalek::{SigningKey, VerifyingKey};
    use momo_wire::signing::{request_payload, sha256_hex, sign};

    #[test]
    fn accepts_a_valid_work_host_signature() {
        let seed = [11u8; 32];
        let public: VerifyingKey = SigningKey::from_bytes(&seed).verifying_key();
        let public_b64 = BASE64.encode(public.to_bytes());

        let ws = Uuid::from_u128(1);
        let host = Uuid::from_u128(2);
        let req = Uuid::from_u128(3);
        let digest = sha256_hex(b"{}");
        let path = "/v1/workspaces/x/work-hosts/y/reconcile";

        let payload = request_payload("POST", path, ws, host, 42, &digest, req);
        let sig_b64 = BASE64.encode(sign(&seed, &payload).unwrap());

        assert!(verify_work_host_request(
            &public_b64,
            &sig_b64,
            "POST",
            path,
            ws,
            host,
            42,
            &digest,
            req
        ));
        // Wrong method breaks the payload → verdict flips.
        assert!(!verify_work_host_request(
            &public_b64,
            &sig_b64,
            "GET",
            path,
            ws,
            host,
            42,
            &digest,
            req
        ));
    }
}
