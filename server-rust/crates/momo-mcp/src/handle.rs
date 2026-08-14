//! The opaque `leaseHandle` an Agent Port client is handed (ADR-0162, HAP-E5).
//!
//! A gateway job's authority is the pair `(outbox.id, lease_owner)` — a database
//! row id and a capability uuid. The REST callback surface hands both to its
//! caller because that caller is a trusted in-cluster runtime. A hosted adapter
//! is not: giving it a raw `job_id` teaches it the shape of the queue, and
//! giving it a raw `lease_owner` lets it be replayed under any other connection
//! that learns it.
//!
//! So the Agent Port hands out a **sealed envelope** instead. It carries the
//! same binding plus the identity it was minted for, and it is AEAD-sealed with
//! a server secret, so:
//!
//! * a client cannot read a job id, a lease secret or a run id out of it;
//! * a handle minted for connection A is rejected for connection B before any
//!   database work happens — the identity is inside the sealed plaintext, not
//!   beside it;
//! * a forged or edited handle fails authentication rather than becoming a
//!   probe of which job ids exist.
//!
//! This module is pure: no SQL, no HTTP, no clock. It is the same envelope
//! discipline `momo_messaging::hosted_inbox`'s cursor uses, kept here because
//! the handle is a **protocol** artifact — the thing the wire carries — while
//! the binding it names belongs to the gateway domain.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const HANDLE_PREFIX: &str = "momo_lease_v1.";
const HANDLE_DOMAIN: &[u8] = b"oort/agent-port/lease-handle/v1";
const HANDLE_VERSION: u8 = 1;
const NONCE_BYTES: usize = 12;
/// version + workspace + agent + connection + run + job id.
const PLAINTEXT_BYTES: usize = 1 + 16 + 16 + 16 + 16 + 8;
const ENVELOPE_BYTES: usize = NONCE_BYTES + PLAINTEXT_BYTES + 16;

/// Everything the gateway domain needs, and nothing the client may learn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseHandle {
    pub workspace_id: Uuid,
    pub agent_member_id: Uuid,
    pub connection_id: Uuid,
    pub run_id: Uuid,
    pub job_id: i64,
    pub lease_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LeaseHandleError {
    #[error("invalid lease handle")]
    Invalid,
    #[error("lease handle could not be issued")]
    Crypto,
}

fn handle_key(secret: &str) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(HANDLE_DOMAIN);
    digest.update([0]);
    digest.update(secret.as_bytes());
    digest.finalize().into()
}

/// The associated data: the lease id, bound but **not** encrypted into the
/// plaintext, so an envelope resealed under another lease fails to open.
fn associated_data(lease_id: Uuid) -> Vec<u8> {
    let mut aad = Vec::with_capacity(HANDLE_DOMAIN.len() + 16);
    aad.extend_from_slice(HANDLE_DOMAIN);
    aad.extend_from_slice(lease_id.as_bytes());
    aad
}

pub fn encode_lease_handle(handle: LeaseHandle, secret: &str) -> Result<String, LeaseHandleError> {
    if handle.job_id <= 0 || secret.is_empty() {
        return Err(LeaseHandleError::Invalid);
    }
    let mut plaintext = Vec::with_capacity(PLAINTEXT_BYTES);
    plaintext.push(HANDLE_VERSION);
    plaintext.extend_from_slice(handle.workspace_id.as_bytes());
    plaintext.extend_from_slice(handle.agent_member_id.as_bytes());
    plaintext.extend_from_slice(handle.connection_id.as_bytes());
    plaintext.extend_from_slice(handle.run_id.as_bytes());
    plaintext.extend_from_slice(&handle.job_id.to_be_bytes());

    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    getrandom::getrandom(&mut nonce_bytes).map_err(|_| LeaseHandleError::Crypto)?;
    let cipher =
        Aes256Gcm::new_from_slice(&handle_key(secret)).map_err(|_| LeaseHandleError::Crypto)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            aes_gcm::aead::Payload {
                msg: &plaintext,
                aad: &associated_data(handle.lease_id),
            },
        )
        .map_err(|_| LeaseHandleError::Crypto)?;

    let mut envelope = Vec::with_capacity(nonce_bytes.len() + ciphertext.len() + 16);
    envelope.extend_from_slice(&nonce_bytes);
    envelope.extend_from_slice(&ciphertext);
    // The lease id travels in the clear *only* as the AAD's key material would
    // otherwise be unavailable to the decoder. It is a random uuid with no
    // meaning outside its own row, and the sealed half is what proves the
    // binding, so publishing it teaches a client nothing it can act on.
    envelope.extend_from_slice(handle.lease_id.as_bytes());
    Ok(format!(
        "{HANDLE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(envelope)
    ))
}

pub fn decode_lease_handle(encoded: &str, secret: &str) -> Result<LeaseHandle, LeaseHandleError> {
    let body = encoded
        .strip_prefix(HANDLE_PREFIX)
        .ok_or(LeaseHandleError::Invalid)?;
    if secret.is_empty() {
        return Err(LeaseHandleError::Invalid);
    }
    let envelope = URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| LeaseHandleError::Invalid)?;
    if envelope.len() != ENVELOPE_BYTES + 16 {
        return Err(LeaseHandleError::Invalid);
    }
    let (sealed, lease_bytes) = envelope.split_at(ENVELOPE_BYTES);
    let lease_id = Uuid::from_slice(lease_bytes).map_err(|_| LeaseHandleError::Invalid)?;
    let (nonce, ciphertext) = sealed.split_at(NONCE_BYTES);
    let cipher =
        Aes256Gcm::new_from_slice(&handle_key(secret)).map_err(|_| LeaseHandleError::Crypto)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            aes_gcm::aead::Payload {
                msg: ciphertext,
                aad: &associated_data(lease_id),
            },
        )
        .map_err(|_| LeaseHandleError::Invalid)?;
    if plaintext.len() != PLAINTEXT_BYTES || plaintext[0] != HANDLE_VERSION {
        return Err(LeaseHandleError::Invalid);
    }
    let workspace_id =
        Uuid::from_slice(&plaintext[1..17]).map_err(|_| LeaseHandleError::Invalid)?;
    let agent_member_id =
        Uuid::from_slice(&plaintext[17..33]).map_err(|_| LeaseHandleError::Invalid)?;
    let connection_id =
        Uuid::from_slice(&plaintext[33..49]).map_err(|_| LeaseHandleError::Invalid)?;
    let run_id = Uuid::from_slice(&plaintext[49..65]).map_err(|_| LeaseHandleError::Invalid)?;
    let job_id = i64::from_be_bytes(
        plaintext[65..73]
            .try_into()
            .map_err(|_| LeaseHandleError::Invalid)?,
    );
    if job_id <= 0 {
        return Err(LeaseHandleError::Invalid);
    }
    Ok(LeaseHandle {
        workspace_id,
        agent_member_id,
        connection_id,
        run_id,
        job_id,
        lease_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> LeaseHandle {
        LeaseHandle {
            workspace_id: Uuid::from_u128(1),
            agent_member_id: Uuid::from_u128(2),
            connection_id: Uuid::from_u128(3),
            run_id: Uuid::from_u128(4),
            job_id: 4242,
            lease_id: Uuid::from_u128(5),
        }
    }

    #[test]
    fn a_handle_round_trips_without_publishing_the_job_id() {
        let handle = sample();
        let encoded = encode_lease_handle(handle, "handle-secret").unwrap();
        assert_eq!(decode_lease_handle(&encoded, "handle-secret"), Ok(handle));
        assert!(encoded.starts_with(HANDLE_PREFIX));
        assert!(!encoded.contains("4242"));
        assert!(!encoded.contains(&handle.run_id.to_string()));
    }

    #[test]
    fn a_handle_is_bound_to_its_key_and_its_bytes() {
        let encoded = encode_lease_handle(sample(), "handle-secret").unwrap();
        assert_eq!(
            decode_lease_handle(&encoded, "other-secret"),
            Err(LeaseHandleError::Invalid)
        );
        let mut bytes = encoded.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        assert_eq!(
            decode_lease_handle(&String::from_utf8(bytes).unwrap(), "handle-secret"),
            Err(LeaseHandleError::Invalid)
        );
    }

    /// The clear-text lease id is authenticated, so swapping it for another
    /// lease's does not produce a handle for that lease — it produces nothing.
    #[test]
    fn the_trailing_lease_id_cannot_be_swapped() {
        let encoded = encode_lease_handle(sample(), "handle-secret").unwrap();
        let mut envelope = URL_SAFE_NO_PAD
            .decode(encoded.strip_prefix(HANDLE_PREFIX).unwrap())
            .unwrap();
        let len = envelope.len();
        envelope[len - 16..].copy_from_slice(Uuid::from_u128(99).as_bytes());
        let forged = format!("{HANDLE_PREFIX}{}", URL_SAFE_NO_PAD.encode(envelope));
        assert_eq!(
            decode_lease_handle(&forged, "handle-secret"),
            Err(LeaseHandleError::Invalid)
        );
    }

    #[test]
    fn a_non_positive_job_id_and_an_empty_secret_are_refused() {
        let mut handle = sample();
        handle.job_id = 0;
        assert_eq!(
            encode_lease_handle(handle, "handle-secret"),
            Err(LeaseHandleError::Invalid)
        );
        assert_eq!(
            encode_lease_handle(sample(), ""),
            Err(LeaseHandleError::Invalid)
        );
        assert_eq!(
            decode_lease_handle("momo_lease_v1.AA", ""),
            Err(LeaseHandleError::Invalid)
        );
        assert_eq!(
            decode_lease_handle("not-a-handle", "handle-secret"),
            Err(LeaseHandleError::Invalid)
        );
    }
}
