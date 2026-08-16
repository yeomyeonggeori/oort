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
//! AgentGateway, tier policy, pool policy, approvals or Kata (ADR-0144).
//!
//! B2.4 added the two ADR-0139 halves: [`reattach`] (session snapshot + the
//! `message.seq` replay cursor, and the D3 reattach-vs-lineage branch) and
//! [`terminal_attach`] (the ADR-0125 D10 capability control plane — mint,
//! sweep, validate). Neither carries a terminal byte: the PTY ring buffer and
//! its `replay_end` splice stay on the host daemon (D2), which is B5.
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
/// ADR-0004 증보 3 — the control-window ledger: what must be true while a
/// person is typing into a live screen, and the predicate the agent's run path
/// is refused by.
pub mod display_control;
pub mod error;
/// #1197 H1 — instance lease renewal, on a substrate that expires instances on
/// a clock momo does not otherwise touch.
pub mod lease;
pub mod lifecycle;
pub mod provider;
/// ADR-0136 D1 / ADR-0156 D4-④ — the managed half of cloud-host acquisition.
pub mod provision;
pub mod reattach;
pub mod reconcile;
pub mod sweep;
pub mod terminal_attach;
/// ADR-0114 D4/D5 + ADR-0125 D6-A — the host-control ledger and the spawn
/// approval card's host candidates.
pub mod work_control;

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
pub use display_control::{
    active_control_window_in_tx, close_control_window_in_tx, control_window_payload,
    expire_lapsed_control_windows_for_workspace_in_tx, expire_lapsed_control_windows_in_tx,
    latest_control_window_in_tx, open_control_window_in_tx, renew_control_window_lease_in_tx,
    stamp_control_window_on_cards_in_tx, workspaces_with_lapsed_control_windows, ControlWindow,
    ControlWindowEndReason, LapsedControlWindow, AUDIT_ACTION_CONTROL_CLOSED,
    AUDIT_SCHEMA_CONTROL_CLOSED, CONTROL_WINDOW_LEASE_SECONDS,
};
pub use error::T3Error;
pub use lease::{renewable_lease_candidates, LeaseRenewalCandidate};
pub use lifecycle::{
    bind_cloud_host_in_tx, card_props, cloud_host_state_in_tx, create_resumed_work_session_in_tx,
    create_work_session_in_tx, create_work_session_with_id_in_tx, end_work_session_in_tx,
    is_active_channel_member_in_tx, lifecycle_payload, list_work_session_details_in_tx,
    load_work_session_in_tx, lock_work_session_detail_in_tx, mark_work_session_resumed_in_tx,
    resolve_cloud_host_id, terminate, terminate_in_tx, transition_cloud_host_in_tx,
    update_session_card_props_in_tx, with_t3_lifecycle_tx, work_session_scope_in_tx,
    work_tool_is_enabled_in_tx, CloudHostState, NewWorkSession, T3LockLadder, TerminationReason,
    WorkSession, WorkSessionDetail,
};
/// The B0 provider vocabulary, re-exported because this crate's public API
/// speaks it (`CloudProvisioner::capabilities`, `provision_instance`). A caller
/// that already depends on `momo-t3` should not have to take a second dependency
/// to name the types it is handed — and letting `momo-server` depend on
/// `momo-provider` directly would put the adapter trait, whose implementors own
/// HTTP clients, back inside the route layer's reach (invariant #2).
pub use momo_provider::{
    CloudInstancePresence, CloudInstanceRef, CloudProviderCapabilities, CloudProviderError,
    CloudProviderOperation,
};
pub use provider::{
    managed_adapters_from_env, managed_adapters_from_process_env, provisioner_from_env,
    provisioner_from_process_env, ByocProviderAdapter, CubeSandboxProviderAdapter,
    CubeSandboxTuning, MockCall, MockInstanceState, MockProviderAdapter, T3ProviderEndpoint,
};
pub use provision::{
    enroll_managed_cloud_host_in_tx, find_managed_provision_by_idempotency_key_in_tx,
    load_managed_provision_in_tx, record_provider_instance_in_tx, BootstrapDerivationSecret,
    CloudProvisioner, ManagedProvision, NewManagedProvision, ProvisionRequest,
};
pub use reattach::{
    clamp_replay_limit, list_session_events_in_tx, load_session_reattach_state_in_tx,
    ReattachVerdict, SessionEvent, SessionReattachState, REPLAY_LIMIT_DEFAULT, REPLAY_LIMIT_MAX,
};
pub use reconcile::{
    apply_convergence_to_intent, claim_lifecycle_intent, due_lifecycle_candidates,
    ActionableIntent, AppliedConvergence, ClaimedIntent, LifecycleCandidate,
};
pub use sweep::{
    converge_stale_session, stale_session_candidates, StaleConvergence, StaleSessionCandidate,
};
pub use terminal_attach::{
    active_observer_capability_count_in_tx, is_valid_capability_token,
    issue_attach_capability_in_tx, lock_attach_target_in_tx, lock_display_binding_target_in_tx,
    mint_capability_token, sweep_spent_observer_capabilities_in_tx,
    validate_attach_capability_in_tx, validated_binding, validated_display_binding,
    write_display_binding_in_tx, AttachKind, AttachMode, AttachTarget, DisplayBindingTarget,
    IssuedCapability, RemoteDisplayBinding, RemotePtyBinding, ValidatedAttach, CAPABILITY_PREFIX,
    CAPABILITY_TTL_SECONDS, HOST_DISPLAY_CAPABILITY_KEY, OBSERVER_CAPABILITY_RETENTION,
};
pub use work_control::{
    active_host_owner_in_tx, agent_owner_human_in_tx, apply_spawn_approval_decision_in_tx,
    bind_control_approval_message_in_tx, bind_control_session_in_tx, control_event_payload,
    control_run_binding_in_tx, default_spawn_host, disable_auto_approve_in_tx,
    enable_auto_approve_in_tx, fail_approved_control_in_tx, fetch_work_control_in_tx, host_tier,
    insert_work_control_in_tx, last_used_spawn_host_in_tx, list_auto_approvals_in_tx,
    lock_work_control_in_tx, mark_control_dispatched_in_tx, pending_controls_for_host_in_tx,
    record_host_last_used_in_tx, resume_target_rejection_in_tx, retarget_control_host_in_tx,
    session_control_lineage_status_in_tx, settle_control_ack_in_tx,
    spawn_ack_session_matches_in_tx, spawn_execution_object, spawn_host_candidates_in_tx,
    spawn_host_ineligible_reason_in_tx, spawn_is_auto_approved_in_tx, target_host_scope_allows,
    target_work_host_in_tx, validated_error_label, validated_label, validated_payload,
    validated_session_shape, validated_tool_key, work_control_id, work_host_is_active_in_tx,
    ControlRunBinding, NewWorkControl, PayloadRejection, ResumeTargetRejection, SpawnHostCandidate,
    TargetWorkHost, WorkControlRow, ACTION_TYPE_WORK_SPAWN, APPROVAL_SOURCE_WORK_CONTROL,
    KIND_INPUT, KIND_KILL, KIND_READ, KIND_SPAWN, STATUS_ACKED, STATUS_APPROVED, STATUS_DENIED,
    STATUS_DISPATCHED, STATUS_FAILED, STATUS_PENDING_APPROVAL, T3_SPAWN_ENABLED,
};
