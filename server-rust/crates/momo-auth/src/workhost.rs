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

/// Verify a WorkHost **heartbeat v1** signature (B2.2).
///
/// A heartbeat is signed over a different payload than a host *request*: the
/// v1 format `momo.work_host.heartbeat.v1\n{ws}\n{host}\n{sentAtMs}`
/// (`momo_wire::signing::heartbeat_payload`), which is why
/// [`verify_work_host_request`] cannot serve this route. Mirrors Swift
/// `WorkHostRoutes.verifyHeartbeatSignature` (:597-616), including its two
/// length guards (32-byte key, 64-byte signature) — both are inside
/// `momo_wire::verify_base64`.
///
/// Note the asymmetry with the request path: a heartbeat carries no request id
/// and is therefore **not** replay-protected by a one-time id — the skew window
/// ([`heartbeat_timestamp_is_fresh`]) is the whole of its freshness contract,
/// exactly as in Swift. A replayed heartbeat can only re-stamp `last_seen_at`
/// inside that window.
pub fn verify_work_host_heartbeat(
    public_key_b64: &str,
    signature_b64: &str,
    workspace_id: Uuid,
    host_id: Uuid,
    sent_at_ms: i64,
) -> bool {
    let payload = momo_wire::signing::heartbeat_payload(workspace_id, host_id, sent_at_ms);
    momo_wire::verify_base64(public_key_b64, signature_b64, &payload)
}

/// Swift `validateHeartbeatTimestamp` (:618-628): non-negative and within
/// [`HEARTBEAT_CLOCK_SKEW_MS`] of now, in either direction.
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

    #[test]
    fn accepts_a_valid_heartbeat_signature_and_rejects_a_shifted_clock() {
        let seed = [23u8; 32];
        let public_b64 = BASE64.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        let ws = Uuid::from_u128(11);
        let host = Uuid::from_u128(12);
        let sent_at_ms = 1_730_000_000_000i64;

        let signature =
            BASE64.encode(sign(&seed, &heartbeat_payload(ws, host, sent_at_ms)).unwrap());
        assert!(verify_work_host_heartbeat(
            &public_b64,
            &signature,
            ws,
            host,
            sent_at_ms
        ));
        // The timestamp is inside the signed payload: shifting it invalidates
        // the signature rather than merely failing the skew check.
        assert!(!verify_work_host_heartbeat(
            &public_b64,
            &signature,
            ws,
            host,
            sent_at_ms + 1
        ));
        // A request-format signature must not pass as a heartbeat.
        let request_signature = BASE64.encode(
            sign(
                &seed,
                &request_payload("POST", "/x", ws, host, sent_at_ms, &sha256_hex(b""), ws),
            )
            .unwrap(),
        );
        assert!(!verify_work_host_heartbeat(
            &public_b64,
            &request_signature,
            ws,
            host,
            sent_at_ms
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
