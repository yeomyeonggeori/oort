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
//! ## Scope (B2.6)
//!
//! The billing spine only: create → progress → complete → charge, plus the
//! summary read. Streaming/partial relay, the `tool_call` work-control branch,
//! approvals, memory-delivery receipts, mention routing semantics and the ACP
//! adapter are **not** ported here — see the PR body's deviation list.
//!
//! ## Verification
//!
//! `tests/conformance_pg.rs` holds this batch's `#[ignore]` red tests, run by the
//! orchestrator against a fresh `pgvector/pg18` database with
//! `infra/e2e/bootstrap_roles.sql` applied. Each is named after the invariant it
//! breaks when reverted.

pub mod effort;
pub mod error;
pub mod run;
pub mod usage;

pub use effort::{
    known_level, ledger_effort, supported_efforts, supports, EFFORT_LEVELS, FALLBACK_EFFORTS,
    MAX_EFFORT_LENGTH,
};
pub use error::AgentError;
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
