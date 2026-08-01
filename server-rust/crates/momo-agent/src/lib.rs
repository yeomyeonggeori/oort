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
//! Streaming/partial relay, the `tool_call` work-control branch, approvals,
//! memory-delivery receipts (`context_packet`) and the ACP adapter are **not**
//! ported here — see the PR body's deviation list.
//!
//! ## Verification
//!
//! `tests/conformance_pg.rs` holds this batch's `#[ignore]` red tests, run by the
//! orchestrator against a fresh `pgvector/pg18` database with
//! `infra/e2e/bootstrap_roles.sql` applied. Each is named after the invariant it
//! breaks when reverted.

pub mod effort;
pub mod error;
pub mod mention;
pub mod provisioning;
pub mod routing;
pub mod run;
pub mod usage;

pub use effort::{
    known_level, ledger_effort, supported_efforts, supports, EFFORT_LEVELS, FALLBACK_EFFORTS,
    MAX_EFFORT_LENGTH,
};
pub use error::AgentError;
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
    completion_status, create_agent_run_in_tx, find_agent_run_by_trigger_in_tx, finish_run_in_tx,
    is_active_agent_in_tx, is_active_human_channel_member_in_tx, live_run_count_in_tx,
    load_agent_run_in_tx, load_eligible_agent_in_tx, lock_gateway_run_in_tx,
    mark_run_started_in_tx, AgentRunRow, CompletionStatusError, CreatedRun, EligibleAgent,
    GatewayRunSnapshot, NewAgentRun, RunStatus, RunTrigger,
};
pub use usage::{
    budget_state, record_run_usage_in_tx, usage_summary_in_tx, validated_window, ResolvedUsage,
    RunUsageReport, UsageAgentRow, UsageBucket, UsageBucketRow, UsageBudget, UsageModelRow,
    UsageSummary, UsageTotals, UsageWindow, UsageWindowError, DEFAULT_LOOKBACK_DAYS,
    MAX_RANGE_DAYS,
};
