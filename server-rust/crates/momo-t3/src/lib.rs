//! `momo-t3` — the T3 lifecycle and billing spine (ADR-0145 B안, batch B2.1).
//!
//! ## What this crate is
//!
//! ADR-0140's finding, after three adversarial review rounds, was that **rules
//! enforced by a database constraint survived and rules enforced by code
//! convention did not**. The redesign therefore put the final enforcement in
//! PostgreSQL — migrations 045/049/051/052/053/057/058 — and left the
//! application one job: **be wired so it cannot go around them.**
//!
//! This crate is that wiring. It re-implements none of the following:
//!
//! | invariant | enforced by | wired here |
//! |---|---|---|
//! | one settlement statement | `t3_terminate` (058:116) | [`lifecycle::terminate_in_tx`] calls it and contains no settlement SQL |
//! | `settled_at` is sealed | `work_host_usage_settlement_guard` (053:86) | any direct write surfaces as [`T3Error::SettlementSealed`] |
//! | legal state transitions | `work_cloud_host_transition_guard` (053:68) | [`lifecycle::transition_cloud_host_in_tx`] issues a plain `UPDATE`; the trigger judges |
//! | host serialization | `acquire_t3_lifecycle_lock` (052:14) | [`lifecycle::with_t3_lifecycle_tx`] takes it as statement #1 — the only way to get a connection |
//! | one paid session per host | `work_host_usage_one_unsettled_per_host_idx` (051:33) | surfaces as [`T3Error::HostAlreadyBilling`] |
//! | pause bills zero | `active_micros` GENERATED (058:59) | [`billing`] never subtracts pause time; there is nothing to subtract |
//! | one truncation | `t3_terminate` divides once (058:219) | [`billing`] never rounds |
//! | provider credentials stay out | no credential column exists | [`provider::registry`] keeps keys in the process env namespace, redacted in `Debug` |
//!
//! ## What this crate is not
//!
//! No HTTP surface (this is a domain crate — a route layer mounts it), no
//! AgentGateway, terminal attach, tier policy, pool policy, approvals,
//! reattach/replay (ADR-0139), Kata (ADR-0144), or reconciliation worker
//! (ADR-0140 D4 convergence) — all of that is B2.2+.
//!
//! It owns **no `outbox` SQL**: `momo-outbox::emit_outbox` remains the single
//! egress (invariant #3), and the lifecycle events a route layer wants to
//! broadcast are emitted there, in the same transaction.
//!
//! ## Verification
//!
//! `tests/conformance_pg.rs` holds the five `#[ignore]` red tests the
//! orchestrator runs against a fresh `pgvector/pg18` database with
//! `infra/e2e/bootstrap_roles.sql` applied. Each is named after the invariant it
//! breaks when reverted.

pub mod billing;
pub mod error;
pub mod lifecycle;
pub mod provider;

pub use billing::{
    pause_usage_in_tx, reserve_provisioning_slot_in_tx, resume_usage_in_tx, start_usage_in_tx,
    usage_snapshot_in_tx, workspace_credit_balance_in_tx, AdmittedSlot, StartedUsage,
    UsageSnapshot,
};
pub use error::T3Error;
pub use lifecycle::{
    bind_cloud_host_in_tx, cloud_host_state_in_tx, create_work_session_in_tx,
    load_work_session_in_tx, resolve_cloud_host_id, terminate, terminate_in_tx,
    transition_cloud_host_in_tx, with_t3_lifecycle_tx, CloudHostState, NewWorkSession,
    T3LockLadder, TerminationReason, WorkSession,
};
pub use provider::{
    ByocProviderAdapter, MockCall, MockInstanceState, MockProviderAdapter, T3ProviderEndpoint,
};
