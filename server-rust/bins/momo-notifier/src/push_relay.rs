//! The push relay transport — the notifier's only outbound HTTP.
//!
//! Port of `workers/NotifierWorker/.../PushRelayClient.swift` and
//! `PushRelaySigning.swift`.
//!
//! ## Why this hop exists at all
//!
//! APNs keys (`.p8`) belong to the App Store distributor. A self-hosted momo
//! server has no Apple Developer account, so it *cannot* talk to
//! `api.push.apple.com` — it hands an id-only dispatch to a relay that holds the
//! key and does the HTTP/2 leg (ADR-0120 D1-A, "구조적 필연"). Consequently
//! **there is no APNs code in this binary and no `.p8` anywhere in this repo.**
//! What lives here is the client half of the relay boundary.
//!
//! ## Authentication
//!
//! The relay identifies a server by an Ed25519 signature over the **raw request
//! body**, carried in `X-Momo-Push-Signature` alongside `X-Momo-Server-Id`. The
//! bytes signed must be the exact bytes sent, so the payload is serialized once
//! and both the signature and the body come from that buffer.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher};

/// The two headers the relay authenticates with (`App.swift:31-32`).
const SERVER_ID_HEADER: &str = "X-Momo-Server-Id";
const SIGNATURE_HEADER: &str = "X-Momo-Push-Signature";

/// Matches the Swift client's `timeout: .seconds(10)`.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum RelayKeyError {
    #[error("cannot read the push relay signing key at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "the push relay signing key is not Ed25519 material: expected a raw 32-byte seed or an \
         RFC 8410 PKCS#8 PEM"
    )]
    InvalidKey,
}

/// RFC 8410 PKCS#8 prefix for an Ed25519 private key:
/// `302e020100300506032b657004220420` followed by the 32-byte seed. This is what
/// `openssl genpkey -algorithm ED25519` emits.
const PKCS8_ED25519_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// Load a 32-byte Ed25519 seed from a key file.
///
/// Accepts the two shapes the Swift loader does (`PushRelaySigning.swift:28-45`):
/// a raw 32-byte seed (operators exporting from an HSM) or a PKCS#8 PEM.
pub fn load_signing_seed(path: &str) -> Result<[u8; 32], RelayKeyError> {
    let bytes = std::fs::read(path).map_err(|source| RelayKeyError::Io {
        path: path.to_string(),
        source,
    })?;
    parse_signing_seed(&bytes)
}

/// The parsing half, separated from the filesystem so it can be tested.
pub fn parse_signing_seed(bytes: &[u8]) -> Result<[u8; 32], RelayKeyError> {
    if bytes.len() == 32 {
        return bytes.try_into().map_err(|_| RelayKeyError::InvalidKey);
    }

    let text = std::str::from_utf8(bytes).map_err(|_| RelayKeyError::InvalidKey)?;
    let begin = text
        .find("-----BEGIN PRIVATE KEY-----")
        .ok_or(RelayKeyError::InvalidKey)?
        + "-----BEGIN PRIVATE KEY-----".len();
    let end = text
        .find("-----END PRIVATE KEY-----")
        .ok_or(RelayKeyError::InvalidKey)?;
    if end < begin {
        return Err(RelayKeyError::InvalidKey);
    }

    let body: String = text[begin..end]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let der = BASE64.decode(body).map_err(|_| RelayKeyError::InvalidKey)?;
    if der.len() != PKCS8_ED25519_PREFIX.len() + 32 || !der.starts_with(&PKCS8_ED25519_PREFIX) {
        return Err(RelayKeyError::InvalidKey);
    }
    der[PKCS8_ED25519_PREFIX.len()..]
        .try_into()
        .map_err(|_| RelayKeyError::InvalidKey)
}

/// The production dispatcher: signed HTTP POST to the relay.
pub struct RelayHttpDispatcher {
    client: reqwest::Client,
    url: String,
    server_id: String,
    /// `None` only when an operator explicitly allowed unsigned dispatches.
    signing_seed: Option<[u8; 32]>,
}

impl RelayHttpDispatcher {
    pub fn new(
        url: impl Into<String>,
        server_id: impl Into<String>,
        signing_seed: Option<[u8; 32]>,
    ) -> Result<Self, reqwest::Error> {
        Ok(RelayHttpDispatcher {
            client: reqwest::Client::builder()
                .timeout(DISPATCH_TIMEOUT)
                .build()?,
            url: url.into(),
            server_id: server_id.into(),
            signing_seed,
        })
    }
}

/// Classify a relay HTTP status.
///
/// `429`/`5xx` are transient — the candidate is requeued with backoff. Every
/// other non-200 is permanent: a malformed dispatch or a rejected signature will
/// not start succeeding on retry.
///
/// Parity: `PushRelayClient.swift:106-111`.
pub fn classify_relay_status(status: u16) -> Option<DispatchOutcome> {
    if status == 200 {
        return None;
    }
    if status == 429 || status >= 500 {
        return Some(DispatchOutcome::TransientFailure(format!("HTTP {status}")));
    }
    Some(DispatchOutcome::PermanentFailure {
        relay_http_status: status as i32,
        reason: format!("HTTP {status}"),
    })
}

/// Decode the relay receipt `{apns_status, apns_reason?}`.
///
/// A 200 with an unparseable body still counts as accepted, recorded as 200 —
/// the relay said yes, and inventing a failure would strand the candidate.
pub fn decode_receipt(body: &[u8]) -> DispatchOutcome {
    let parsed: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let (status, reason) = match parsed.as_ref().and_then(|value| value.as_object()) {
        Some(object) => (
            object
                .get("apns_status")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(200) as i32,
            object
                .get("apns_reason")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        ),
        None => (200, None),
    };
    DispatchOutcome::Accepted {
        apns_status: status,
        apns_reason: reason,
    }
}

#[async_trait::async_trait]
impl PushDispatcher for RelayHttpDispatcher {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        // Serialize once: the signature must cover exactly the bytes sent.
        let body = match serde_json::to_vec(dispatch) {
            Ok(body) => body,
            Err(error) => {
                return DispatchOutcome::TransientFailure(format!(
                    "dispatch serialization failed: {error}"
                ))
            }
        };

        let mut request = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json");

        if let Some(seed) = self.signing_seed.as_ref() {
            match momo_wire::sign_base64(seed, &body) {
                Ok(signature) => {
                    request = request
                        .header(SERVER_ID_HEADER, &self.server_id)
                        .header(SIGNATURE_HEADER, signature);
                }
                Err(error) => {
                    return DispatchOutcome::TransientFailure(format!(
                        "relay signature failed: {error}"
                    ))
                }
            }
        }

        let response = match request.body(body).send().await {
            Ok(response) => response,
            Err(error) => {
                return DispatchOutcome::TransientFailure(format!("relay dispatch failed: {error}"))
            }
        };

        let status = response.status().as_u16();
        if let Some(outcome) = classify_relay_status(status) {
            return outcome;
        }
        match response.bytes().await {
            Ok(bytes) => decode_receipt(&bytes),
            // The relay already answered 200; a truncated body is not a reason
            // to re-send a notification the device may already have.
            Err(_) => DispatchOutcome::Accepted {
                apns_status: 200,
                apns_reason: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_and_permanent_relay_statuses_match_swift() {
        assert!(classify_relay_status(200).is_none());
        assert_eq!(
            classify_relay_status(429),
            Some(DispatchOutcome::TransientFailure("HTTP 429".to_string()))
        );
        assert_eq!(
            classify_relay_status(503),
            Some(DispatchOutcome::TransientFailure("HTTP 503".to_string()))
        );
        // A rejected signature (403) must not retry forever.
        assert_eq!(
            classify_relay_status(403),
            Some(DispatchOutcome::PermanentFailure {
                relay_http_status: 403,
                reason: "HTTP 403".to_string(),
            })
        );
        assert_eq!(
            classify_relay_status(400),
            Some(DispatchOutcome::PermanentFailure {
                relay_http_status: 400,
                reason: "HTTP 400".to_string(),
            })
        );
    }

    #[test]
    fn a_receipt_without_fields_still_counts_as_accepted() {
        assert_eq!(
            decode_receipt(b"not json"),
            DispatchOutcome::Accepted {
                apns_status: 200,
                apns_reason: None
            }
        );
        assert_eq!(
            decode_receipt(br#"{"apns_status":410,"apns_reason":"BadDeviceToken"}"#),
            DispatchOutcome::Accepted {
                apns_status: 410,
                apns_reason: Some("BadDeviceToken".to_string())
            }
        );
    }

    #[test]
    fn a_raw_32_byte_seed_is_accepted() {
        let seed = [7u8; 32];
        assert_eq!(parse_signing_seed(&seed).unwrap(), seed);
    }

    #[test]
    fn a_pkcs8_pem_yields_the_same_seed_as_the_raw_form() {
        let seed = [9u8; 32];
        let mut der = PKCS8_ED25519_PREFIX.to_vec();
        der.extend_from_slice(&seed);
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            BASE64.encode(&der)
        );
        assert_eq!(parse_signing_seed(pem.as_bytes()).unwrap(), seed);
    }

    #[test]
    fn a_key_that_is_not_ed25519_material_is_rejected() {
        assert!(parse_signing_seed(b"hello").is_err());
        assert!(parse_signing_seed(&[0u8; 31]).is_err());
        // Right envelope, wrong algorithm prefix.
        let mut der = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x71, 0x04, 0x22,
            0x04, 0x20,
        ];
        der.extend_from_slice(&[1u8; 32]);
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            BASE64.encode(&der)
        );
        assert!(parse_signing_seed(pem.as_bytes()).is_err());
    }

    /// The relay verifies the signature over the raw body, so a signature that
    /// does not verify against the matching public key is a 403 in production.
    #[test]
    fn the_signature_verifies_against_the_public_key_for_the_seed() {
        let seed = [3u8; 32];
        let body = br#"{"schema":"momo.push.dispatch.v2"}"#;
        let signature = momo_wire::sign_base64(&seed, body).expect("sign");
        let raw = BASE64.decode(signature).expect("base64");
        let public = ed25519_dalek::SigningKey::from_bytes(&seed)
            .verifying_key()
            .to_bytes();
        assert!(momo_wire::verify(&public, body, &raw));
    }
}
