//! `momo-agent` — the agent-run + LLM-billing spine (ADR-0145 B안, batch B2.6).
//!
//! ## What this crate is
//!
//! The domain half of the AgentGateway: an `agent_run` is created by a trigger,
//! moves through the state machine as a gateway reports on it, and on completion
//! writes **one immutable `usage_ledger` row** — the system of record every spend
//! surface reads. B2.2 established that `GET …/usage/summary` aggregates that
//! ledger; this batch supplies the writer that was missing, so the number the
//! surface reports is now produced by this server rather than inherited.
//!
//! It owns exactly two tables' SQL, and nothing else touches them:
//!
//! | table | module | Swift source |
//! |---|---|---|
//! | `agent_run` | [`run`] | `AgentRunRoutes` / `MessageRoutes.recordMentionRun` / `AgentGatewayRoutes` |
//! | `usage_ledger` | [`usage`] | `AgentGatewayRoutes.reconcileUsage` (the **only** writer) + `UsageSummaryRoutes` |
//!
//! ## What it deliberately does not own
//!
//! | concern | owner | why not here |
//! |---|---|---|
//! | the gateway job lease | `momo_outbox::gateway` | a lease is columns on an `outbox` row |
//! | the final timeline message | `momo_messaging::send_message_in_tx` | it is a message: same `channel_seq` bump, same `client_msg_id` idempotency, same broadcast |
//! | the outbox row itself | `momo_outbox::emit_outbox` | invariant #3, one egress |
//! | the agent bearer credential | `momo_auth::agent_bearer` | it is a `token` row |
//! | the RLS GUC | `momo_db::with_tenant_tx` | invariant #6, one wiring point |
//!
//! That split is why this crate has **no `INSERT INTO outbox` and no `INSERT INTO
//! message`**: the two invariant-bearing writes stay behind their chokepoints,
//! and a caller composes all of them inside a single `with_tenant_tx` so the run,
//! its message, its broadcast and its bill commit together or not at all.
//!
//! ## Scope (B2.6 → B5.2)
//!
//! B2.6 brought the billing spine only: create → progress → complete → charge,
//! plus the summary read.
//!
//! **B5.2 adds the two agent-domain surfaces the spine was missing**, and both
//! keep the split above rather than widening it:
//!
//! | module | tables it reads/writes | still not owned |
//! |---|---|---|
//! | [`mention`] | reads `member`/`agent`/`agent_profile`/`membership`/`workspace` | the outbox row, the message, the audit row — it returns JSON, the caller writes |
//! | [`provisioning`] | writes `member`/`agent`/`workspace_membership`/`agent_profile` | `workspace_ban` (momo-settings), the audit row (momo-db) |
//!
//! **B5.3a adds the per-request routing tier** ([`routing`]) and the profile's
//! write half ([`provisioning::set_agent_paused_in_tx`]). Routing is a module of
//! its own rather than a second resolver inside [`mention`] because Swift shares
//! one `RunRoutingInput`/`RunRoutingResolution` across both surfaces that start a
//! run, and a per-surface copy is how the same three words come to mean two
//! things.
//!
//! **B7.2 adds the A2A delegation policy** ([`a2a`]): the §3.4 hop-depth cap,
//! the §3.3 loop gates G1/G2/G3 measured off Swift `LoopGuards.swift`, and a
//! per-root-trigger spend ceiling summed over a whole delegation tree
//! ([`usage::chain_usage_in_tx`]). It is a module of its own, and — like
//! [`mention`] — it owns **no `INSERT`**: it reads counters, returns a verdict
//! and builds the strings, and `momo-agent-worker` composes that with the
//! message spine, the outbox and `audit_log` inside the turn's transaction.
//!
//! The one counter it does not read is G2's, because that one counts `message`
//! rows: `momo_messaging::agent_auto_reply_streak_in_tx` owns it and the caller
//! passes the number in. That is the same boundary this crate has kept since
//! B2.6, held under pressure again.
//!
//! **B13 adds implicit addressing in a 1:1 DM** ([`dm`]): a human alone with one
//! agent does not have to type `@handle`. It is a *routing* rule and not a new
//! `agent_profile.triggers` key on purpose — see that module's header — and its
//! author gate is what keeps two agents from auto-answering each other forever
//! in a room no A2A gate is watching.
//!
//! **goal SRV-T1 adds the approval axis** ([`approval`], [`tools`]) and with it
//! the crate's third and fourth tables, `approval` and `approval_decision`. It
//! is the batch that gave `RunStatus::AwaitingApproval` a writer: before it, the
//! enum variant, the two gateway refusals that read it, the `approval` table and
//! the push notifier's approval join all existed, and no row could ever reach
//! any of them because nothing transitioned a run into that status.
//!
//! [`tools`] holds the catalog and the §3.3 G6 policy (both pure); [`approval`]
//! holds the SQL. Neither owns a message or an outbox row — the same split this
//! crate has kept since B2.6 — so the producer composes
//! `approval` + `send_message_in_tx` + `emit_outbox` + `write_audit` inside one
//! `with_tenant_tx`, and a parked run without its approval, or an approval
//! without its card, is unrepresentable.
//!
//! The three run transitions that batch needed ([`run::park_run_for_approval_in_tx`],
//! [`run::requeue_run_from_approval_in_tx`], [`run::end_parked_run_in_tx`]) are
//! separate statements rather than parameters on the existing writers; see the
//! comment above them for why widening `mark_run_started_in_tx` would have
//! removed the guard that keeps a late progress event from ending an approval
//! hold.
//!
//! **goal SRV-C2 adds the human stop** ([`run::lock_run_for_cancel_in_tx`],
//! [`run::cancel_run_in_tx`], [`approval::cancel_pending_approvals_for_run_in_tx`]).
//! Every transition this crate had until now belonged to the machine — a gateway
//! reports, an approval resolves, a deadline passes. This one belongs to a
//! person, and it is the first write here authorized by **being in the room**
//! (an active member of the run's channel) rather than by owning the agent or
//! the workspace: ADR-0132's 휴먼 정지권. `RunStatus::Cancelled` was reachable
//! before it only as the *outcome of a rejected approval*, never as something
//! anyone could ask for.
//!
//! It also adds the crate's one read outside its own tables that is neither an
//! eligibility predicate nor a counter — [`run::linked_work_session_ids_in_tx`],
//! the `audit_log ⋈ work_control` join whose result the cancel response reports.
//! Both tables belong elsewhere and neither is written here; see that function
//! for why it lives in this crate anyway, and for what its (currently always
//! empty) answer means while `work_control` has no writer on this server.
//!
//! Streaming/partial relay, the `tool_call` **work-control** branch (Swift routes
//! `work.spawn` through `work_control`, which is not ported — see
//! [`tools`]), memory-delivery receipts (`context_packet`), G4's SimHash
//! semantic-loop detector (a stub in Swift too) and the ACP adapter are **not**
//! ported here — see the PR body's deviation list.
//!
//! ## Verification
//!
//! `tests/conformance_pg.rs` holds this batch's `#[ignore]` red tests, run by the
//! orchestrator against a fresh `pgvector/pg18` database with
//! `infra/e2e/bootstrap_roles.sql` applied. Each is named after the invariant it
//! breaks when reverted.

pub mod a2a;
pub mod approval;
pub mod dm;
pub mod effort;
pub mod error;
pub mod korean;
pub mod mention;
pub mod provisioning;
pub mod routing;
pub mod run;
pub mod status;
pub mod tools;
pub mod usage;

pub use approval::{
    approval_payload, approval_request_body, approval_request_props, attach_request_message_in_tx,
    cancel_pending_approvals_for_run_in_tx, create_pending_approval_in_tx, decided_props_patch,
    decision_broadcast_payload, decision_event_payload, decision_receipt, default_expires_at,
    existing_decision_in_tx, is_active_channel_member_in_tx, is_active_human_member_in_tx,
    list_approvals_in_tx, lock_approval_in_tx, mark_approval_decided_in_tx,
    mark_approval_expired_in_tx, normalized_reason, overdue_approvals_in_tx, record_decision_in_tx,
    resume_job_payload, tool_grants_from_payload, validated_limit, validated_status,
    workspaces_with_overdue_approvals, ApprovalListRow, ExistingDecision, LockedApproval,
    NewApproval, OverdueApproval, DEFAULT_TTL_SECONDS, LISTABLE_STATUSES, RESUME_MODEL,
    RUN_CANCELLED_DECISION_REASON,
};
pub use tools::{
    approval_reason, is_executable, requires_approval, ApprovalReason, ToolCall, ToolGrant,
    ToolResult, ACTION_TYPE_TOOL_CALL, AUDIT_APPROVAL_REQUESTED, AUDIT_TOOL_EXECUTED,
    AUDIT_TOOL_FAILED, CATALOG, DECLARED_NOT_EXECUTABLE, TOOL_AUDIT_SCHEMA, WORK_SESSION_END,
};

pub use a2a::{
    evaluate_a2a_spawn, inherited_depth, load_a2a_gate_snapshot_in_tx, A2aBlock, A2aGateSnapshot,
    A2aLimits, DEFAULT_A2A_MAX_DEPTH, DEFAULT_G1_STALE_RUNNING_SECONDS,
    DEFAULT_MAX_CHAIN_COST_MICRO_USD, DEFAULT_MAX_CHAIN_TOKENS, DEFAULT_MAX_CONSECUTIVE_AUTO,
    DEFAULT_MAX_STEPS, SCHEMA_DEPTH_CEILING,
};
pub use dm::{
    load_dm_audience_in_tx, resolve_dm_addressing, stamp_addressing, Addressing,
    ChannelParticipant, DmAddressing, DmAudience,
};
pub use effort::{
    known_level, ledger_effort, supported_efforts, supports, EFFORT_LEVELS, FALLBACK_EFFORTS,
    MAX_EFFORT_LENGTH,
};
pub use error::AgentError;
pub use korean::{attach_particle, has_final_consonant, particle_for, ParticlePair};
pub use mention::{
    allowed_agent_models, context_window_size, effective_system_prompt,
    load_mention_candidates_in_tx, max_output_tokens, mention_diagnostic_detail,
    mention_job_broadcast_payload, mention_job_payload, mention_run_input, message_source,
    paused_mention_body, paused_mention_props, resolve_mention_routing, MentionCandidate,
    MentionRouting, MentionTrigger, AGENT_INTERACTION_SAFETY_PREAMBLE,
    AGENT_PROFILE_POLICY_PREAMBLE, MENTION_JOB_CREATED_FROM, MENTION_JOB_METHOD_GATEWAY,
    MENTION_JOB_METHOD_WORKER, MENTION_RUN_INPUT_SCHEMA,
};
pub use provisioning::{
    agent_owner_in_tx, create_agent_identity_in_tx, load_agent_model_policy_in_tx,
    load_agent_profile_in_tx, normalized_model, normalized_system_prompt,
    reject_credential_shaped_fields, set_agent_paused_in_tx, upsert_agent_profile_in_tx,
    validate_agent_profile, validated_config, AgentCreation, AgentMember, AgentProfile,
    AgentProfileSpec, AgentSpecInvalid, NewAgentMember,
};
pub use routing::{
    validate_request_routing, RequestedRouting, RoutingInvalid, MAX_ROUTING_MODEL_LENGTH,
    ROUTING_KEYS,
};
pub use run::{
    cancel_run_in_tx, completion_status, consume_run_step_in_tx, create_agent_run_in_tx,
    end_parked_run_in_tx, find_agent_run_by_trigger_in_tx, finish_run_in_tx, is_active_agent_in_tx,
    is_active_human_channel_member_in_tx, linked_work_session_ids_in_tx, live_run_count_in_tx,
    load_agent_run_in_tx, load_eligible_agent_in_tx, lock_gateway_run_in_tx,
    lock_run_for_cancel_in_tx, mark_run_started_in_tx, park_run_for_approval_in_tx,
    requeue_run_from_approval_in_tx, terminal_run_ids_in_tx, AgentRunRow, CancellableRun,
    CompletionStatusError, CreatedRun, EligibleAgent, GatewayRunSnapshot, NewAgentRun, RunStatus,
    RunTrigger,
};
pub use status::{
    agent_partial_payload, agent_partial_tool_call_payload, agent_status_channel,
    opening_agent_status_payload, progress_agent_status_payload, terminal_agent_status_payload,
    terminal_phase, AgentPhase, AgentRunAddress, AGENT_PARTIAL_EVENT_TYPE, AGENT_STATUS_EVENT_TYPE,
    AGENT_STATUS_EVENT_VERSION,
};
pub use usage::{
    budget_state, chain_usage_in_tx, record_run_usage_in_tx, usage_summary_in_tx, validated_window,
    ChainUsage, ResolvedUsage, RunUsageReport, UsageAgentRow, UsageBucket, UsageBucketRow,
    UsageBudget, UsageModelRow, UsageSummary, UsageTotals, UsageWindow, UsageWindowError,
    DEFAULT_LOOKBACK_DAYS, MAX_RANGE_DAYS,
};
