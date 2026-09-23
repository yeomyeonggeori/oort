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

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::VerifyingKey;
use uuid::Uuid;

/// `WorkHostRoutes.heartbeatClockSkewMs` (:90) — ±5 minutes.
pub const HEARTBEAT_CLOCK_SKEW_MS: i64 = 5 * 60 * 1_000;

// There is no heartbeat verifier here any more (ADR-0188 D7, R0). The v1
// heartbeat signed `momo.work_host.heartbeat.v1\n{ws}\n{host}\n{sentAtMs}` with
// no request id, so the ±5 minute window was its whole freshness contract and a
// captured beat could be replayed for all of it. A heartbeat is now a v2 signed
// request like every other host act ([`verify_work_host_request`] + one-time
// request-id consumption), and v1 is not accepted anywhere. The v1 *format*
// still lives in `momo_wire` because historical `action_signature` rows were
// recorded over it and must stay re-verifiable.

/// Swift `validateHeartbeatTimestamp` (:618-628): non-negative and within
/// [`HEARTBEAT_CLOCK_SKEW_MS`] of now, in either direction. Every signed host
/// request's clock window, the heartbeat's included.
pub fn heartbeat_timestamp_is_fresh(sent_at_ms: i64, now_ms: i64) -> bool {
    sent_at_ms >= 0 && (sent_at_ms - now_ms).abs() <= HEARTBEAT_CLOCK_SKEW_MS
}

/// Normalize + validate a registration public key, returning the canonical
/// base64 form. Swift `WorkHostRoutes.validatedPublicKey` (:554-562): trim,
/// base64-decode, require exactly 32 bytes, require it to be a usable Ed25519
/// key, and re-encode so what is stored is the canonical spelling (which is
/// what `work_host_public_key_ck` — `^[A-Za-z0-9+/]{43}=$`, 021:26-27 — accepts).
///
/// Rejecting a structurally invalid key here rather than at the constraint is
/// deliberate: a key that decodes to 32 bytes but is not a valid curve point
/// would satisfy the regex and then fail *every* future signature check, which
/// looks like a broken host instead of a bad registration.
pub fn normalize_public_key_b64(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let bytes = BASE64.decode(trimmed).ok()?;
    let key_bytes: [u8; 32] = bytes.as_slice().try_into().ok()?;
    VerifyingKey::from_bytes(&key_bytes).ok()?;
    Some(BASE64.encode(key_bytes))
}

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
    use ed25519_dalek::SigningKey;
    use momo_wire::signing::{heartbeat_payload, request_payload, sha256_hex, sign};

    /// ADR-0188 D7: a v1 heartbeat signature authenticates nothing. The same
    /// key signing the v1 bytes for the very request a v2 heartbeat makes does
    /// not verify as that request — the schema tag, the missing method/path/
    /// digest and the missing request id all differ — so a daemon still on v1
    /// is refused rather than half-accepted.
    #[test]
    fn a_v1_heartbeat_signature_never_verifies_as_a_v2_request() {
        let seed = [23u8; 32];
        let public_b64 = BASE64.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        let ws = Uuid::from_u128(11);
        let host = Uuid::from_u128(12);
        let sent_at_ms = 1_730_000_000_000i64;
        let path = format!("/v1/workspaces/{ws}/work-hosts/{host}/heartbeat");
        let request_id = Uuid::from_u128(13);
        let digest = sha256_hex(b"");

        let v1 = BASE64.encode(sign(&seed, &heartbeat_payload(ws, host, sent_at_ms)).unwrap());
        assert!(!verify_work_host_request(
            &public_b64,
            &v1,
            "POST",
            &path,
            ws,
            host,
            sent_at_ms,
            &digest,
            request_id,
        ));

        // …while the v2 signature over the same request does — the negative
        // above is about the format, not a broken key.
        let v2 = BASE64.encode(
            sign(
                &seed,
                &request_payload("POST", &path, ws, host, sent_at_ms, &digest, request_id),
            )
            .unwrap(),
        );
        assert!(verify_work_host_request(
            &public_b64,
            &v2,
            "POST",
            &path,
            ws,
            host,
            sent_at_ms,
            &digest,
            request_id,
        ));
    }

    #[test]
    fn heartbeat_freshness_is_a_symmetric_five_minute_window() {
        let now = 1_730_000_000_000i64;
        assert!(heartbeat_timestamp_is_fresh(now, now));
        assert!(heartbeat_timestamp_is_fresh(
            now - HEARTBEAT_CLOCK_SKEW_MS,
            now
        ));
        assert!(heartbeat_timestamp_is_fresh(
            now + HEARTBEAT_CLOCK_SKEW_MS,
            now
        ));
        assert!(!heartbeat_timestamp_is_fresh(
            now - HEARTBEAT_CLOCK_SKEW_MS - 1,
            now
        ));
        assert!(!heartbeat_timestamp_is_fresh(
            now + HEARTBEAT_CLOCK_SKEW_MS + 1,
            now
        ));
        assert!(!heartbeat_timestamp_is_fresh(-1, now));
    }

    #[test]
    fn public_key_validation_matches_the_swift_guard() {
        let key = SigningKey::from_bytes(&[5u8; 32])
            .verifying_key()
            .to_bytes();
        let canonical = BASE64.encode(key);
        assert_eq!(
            normalize_public_key_b64(&format!("  {canonical}  ")).as_deref(),
            Some(canonical.as_str()),
            "surrounding whitespace is trimmed, the canonical spelling is stored"
        );
        assert_eq!(normalize_public_key_b64("not-base64!"), None);
        // 31 bytes: decodes, wrong length.
        assert_eq!(normalize_public_key_b64(&BASE64.encode([7u8; 31])), None);
        // 33 bytes: decodes, wrong length.
        assert_eq!(normalize_public_key_b64(&BASE64.encode([7u8; 33])), None);
        assert_eq!(normalize_public_key_b64(""), None);
    }

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
