//! `momo-wire` — the shared server↔workd contract, de-duplicated into one crate.
//!
//! In Swift the WorkHost signing format string is physically duplicated between
//! `workers/WorkHostDaemon/.../Signing.swift:26-64` (signer) and
//! `server/.../Auth/WorkHostAuthenticator.swift:138-149` (verifier). This crate
//! unifies that into a single [`signing`] module so the signer and verifier can
//! never drift. The format is ported **byte-for-byte** (see `tests/signing_bytes.rs`).
//!
//! Modules:
//! * [`signing`] — WorkHost heartbeat/request payload builders + Ed25519 sign/verify.
//! * [`payload`] — outbox / agent_job payload structs (JSON DTOs).
//! * [`provenance`] — ADR-0146 agent-action provenance API skeleton (Proposed;
//!   signature format placeholder + `record_provenance` stub, **no DB table**).

pub mod payload;
pub mod provenance;
pub mod signing;

pub use signing::{
    heartbeat_payload, request_payload, sha256_hex, sign, sign_base64, verify, verify_base64,
    verify_work_host_request, SigningError,
};
