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
//! * [`human_control`] — ADR-0146 개정 2026-09-28 (R2): the human device-key
//!   signing bytes (`momo.human.control.v1`, `device_endorse.v1`,
//!   `device_revoke.v2`) and P-256 verification, shared with Swift/TS through
//!   `docs/api/human-control-signing.vectors.json`.
//! * [`provenance`] — ADR-0146 action provenance (Accepted): the per-surface
//!   signing payloads and `record_provenance`, the **only** `action_signature`
//!   writer in the workspace (migration 060).

pub mod human_control;
pub mod payload;
pub mod permission_preview;
pub mod provenance;
pub mod signing;
pub mod work_host_online;

pub use provenance::{
    record_human_provenance, record_provenance, EntityRef, MessageContent, Provenance,
    ProvenanceError, SignedAction, Signer, ENTITY_MESSAGE, ENTITY_WORK_CONTROL,
    ENTITY_WORK_HOST_HEARTBEAT, ENTITY_WORK_HOST_REGISTER,
    ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE, MESSAGE_SCHEMA_V1,
};
pub use signing::{
    heartbeat_payload, request_payload, sha256_hex, sign, sign_base64, verify, verify_base64,
    verify_work_host_request, SigningError,
};
pub use work_host_online::{work_host_online_sql, ONLINE_WINDOW_SECONDS};
