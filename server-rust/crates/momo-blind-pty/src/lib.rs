//! ADR-0197 S2 (#3409): blind-relay PTY prototype. **Test-only, not wired into any route.**
//!
//! Three parties: the owner **device** (P-256 ECDSA key, ADR-0146 R2), the
//! **box-agent** (Ed25519 host key, attested by the runner's Ed25519 key and
//! endorsed by an owner device), and the **relay** (the oort server), which is
//! modelled as an adversary that forwards opaque bytes. Every security decision
//! is made by the two endpoints; the relay is never consulted.
//!
//! One fixed suite, no negotiation ([`SCHEMA`]): P-256 ECDH (ephemeral) ->
//! HKDF-SHA256 -> AES-256-GCM with strictly increasing per-direction counters.
//! See `docs/planning/research/2026-10-03-blind-pty-spike-s2.md`.

pub mod codec;
pub mod crypto;
pub mod handshake;
pub mod harness;
pub mod session;
pub mod trust;

/// Domain/version string mixed into every signed byte string and HKDF info.
pub const SCHEMA: &str = "momo.blind_pty.v1";

/// Attach challenges live at most this long (ADR-0197 D5: 60 s or less).
pub const CHALLENGE_TTL_MS: u64 = 60_000;

/// Largest PTY payload per frame; larger input is split by the caller.
pub const MAX_PAYLOAD: usize = 16 * 1024;

/// Box-agent keeps at most this many unanswered challenges (pre-auth DoS cap).
pub const MAX_PENDING: usize = 8;

/// Every way an endpoint can refuse. Variants are distinct so tests can assert
/// *why* something was refused, not merely that it was.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("malformed message")]
    Malformed,
    #[error("runner fingerprint does not match the value typed in out-of-band")]
    RunnerFingerprintMismatch,
    #[error("host key has no valid runner attestation")]
    HostNotAttested,
    #[error("host key has no valid owner-device endorsement")]
    HostNotEndorsed,
    #[error("no pinned host key for this box: compare the runner fingerprint first")]
    HostNotPinned,
    #[error("box identity changed: owner re-endorsement required")]
    HostKeyChanged,
    #[error("host signature over the transcript is invalid")]
    BadHostSignature,
    #[error("device is not on the box-agent's owner device list")]
    UnknownDevice,
    #[error("device signature over the transcript is invalid")]
    BadDeviceSignature,
    #[error("challenge unknown, already used, or from before a restart")]
    ChallengeUnknown,
    #[error("challenge expired")]
    Expired,
    #[error("too many unanswered challenges")]
    TooManyPending,
    #[error("device list rejected: version not newer")]
    DeviceListRollback,
    #[error("device list rejected: signer is not on the current list or signature invalid")]
    DeviceListBadSigner,
    #[error("frame failed authentication")]
    Decrypt,
    #[error("frame counter is not the expected next value")]
    Counter,
    #[error("session is closed")]
    Closed,
    #[error("payload too large")]
    TooLarge,
    #[error("box-agent holds a device list the owner never approved")]
    BoxListUntrusted,
    #[error("message addressed to a different box")]
    WrongBox,
    #[error("entropy source failed")]
    Entropy,
}
