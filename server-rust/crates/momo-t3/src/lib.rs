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
//! reattach/replay (ADR-0139) or Kata (ADR-0144) — all of that is B2.4+.
//!
//! B2.3 added the **domain half of ADR-0140 D4 convergence** — [`convergence`]
//! (the rule table), [`reconcile`] (claim → revalidate → apply) and [`sweep`]
//! (host loss → `t3_terminate('orphaned')`). The worker that runs them on a
//! timer is `bins/momo-notifier`; it holds no SQL of its own, which is what
//! keeps the rules in one place.
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
pub mod cloud_host;
pub mod convergence;
pub mod error;
pub mod lifecycle;
pub mod provider;
pub mod reconcile;
pub mod sweep;

pub use billing::{
    acquire_slot_in_tx, pause_usage_in_tx, reserve_provisioning_slot_in_tx, resume_usage_in_tx,
    start_usage_in_tx, topup_credit_in_tx, usage_snapshot_in_tx, workspace_credit_balance_in_tx,
    AdmittedSlot, SlotOccupancy, StartedUsage, TopupOutcome, UsageSnapshot,
};
pub use cloud_host::{
    allocate_uuid_v7, bootstrap_token_digest, claim_bootstrap_in_tx,
    cloud_host_id_for_bootstrap_digest, cloud_host_id_for_host, cloud_host_id_for_host_in_tx,
    cloud_host_id_for_session_in_tx, enroll_byoc_cloud_host_in_tx,
    find_enrollment_by_idempotency_key_in_tx, load_cloud_host_in_tx, lock_enrollment_key_in_tx,
    mint_bootstrap_token, BootstrapToken, ClaimedBootstrap, CloudHostEnrollment, CloudHostRecord,
    NewByocEnrollment, BOOTSTRAP_TTL_SECONDS,
};
pub use convergence::{
    after_deadline, after_provider_call, provider_denies_its_own_absence,
    CloudLifecycleConvergence, CloudLifecyclePhase,
};
pub use error::T3Error;
pub use lifecycle::{
    bind_cloud_host_in_tx, cloud_host_state_in_tx, create_resumed_work_session_in_tx,
    create_work_session_in_tx, create_work_session_with_id_in_tx, end_work_session_in_tx,
    is_active_channel_member_in_tx, list_work_session_details_in_tx, load_work_session_in_tx,
    lock_work_session_detail_in_tx, mark_work_session_resumed_in_tx, resolve_cloud_host_id,
    terminate, terminate_in_tx, transition_cloud_host_in_tx, update_session_card_props_in_tx,
    with_t3_lifecycle_tx, work_session_scope_in_tx, work_tool_is_enabled_in_tx, CloudHostState,
    NewWorkSession, T3LockLadder, TerminationReason, WorkSession, WorkSessionDetail,
};
pub use provider::{
    ByocProviderAdapter, MockCall, MockInstanceState, MockProviderAdapter, T3ProviderEndpoint,
};
pub use reconcile::{
    apply_convergence_to_intent, claim_lifecycle_intent, due_lifecycle_candidates,
    ActionableIntent, AppliedConvergence, ClaimedIntent, LifecycleCandidate,
};
pub use sweep::{
    converge_stale_session, stale_session_candidates, StaleConvergence, StaleSessionCandidate,
};
