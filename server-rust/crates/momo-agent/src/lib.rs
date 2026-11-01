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
//! **LIVE-4 선행 (#1425) adds the control-window hold**
//! ([`run::park_runs_for_control_window_in_tx`],
//! [`run::resume_runs_from_control_window_in_tx`]) — ADR-0004 증보 3 D6's
//! 「정지되는 것은 에이전트 런 층」, written where every other `agent_run`
//! transition is. They read that same `audit_log ⋈ work_control` relation in the
//! opposite direction (one join, one place) and the resume additionally reads
//! `display_control_window` so a run held by two windows is resumed by the
//! second close rather than the first. `RunStatus::Paused` was reachable in the
//! enum and unreachable in the database until these two; nothing about what
//! `Paused` *means* moved with them.
//!
//! Both take the driver runs `FOR UPDATE` first
//! (`run::lock_driver_runs_in_tx`, which is where the argument lives): a run
//! that drives two sessions is worked on by two transactions that share no other
//! lock, and a `display_control_window` read decides both statements — so
//! without it the answer depended on which of the two committed first.
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
//! `infra/rust/sql/bootstrap_roles.sql` applied. Each is named after the invariant it
//! breaks when reverted.

pub mod a2a;
pub mod actions;
pub mod app_notice;
pub mod app_tool_grants;
pub mod approval;
pub mod approval_outcome;
pub mod approval_sentence;
pub mod card_suggest;
pub mod connector_trial;
pub mod decider;
pub mod dm;
pub mod effort;
pub mod error;
pub mod hosted_cadence;
pub mod hosted_dm;
pub mod hosted_liveness;
pub mod hosted_notice;
pub mod in_place_grant;
pub mod initiative;
pub mod korean;
pub mod memory;
pub mod memory_cons;
pub mod memory_items;
pub mod memory_suggest;
pub mod mention;
pub mod owner_key;
pub mod personal;
pub mod provisioning;
pub mod routing;
pub mod run;
pub mod run_activity;
pub mod run_event;
pub mod run_progress;
pub mod status;
pub mod subscription;
pub mod subscription_transition;
pub mod team_ai_roles;
pub mod thread_wake;
pub mod tools;
pub mod usage;
pub mod welcome;
pub mod woken;

// NOTE the two names this block deliberately does **not** flatten:
// `actions::DECLARED_NOT_EXECUTABLE` and `actions::ACTIONS` live one module down
// because `tools::DECLARED_NOT_EXECUTABLE` already owns that name at the crate
// root and the two lists answer different questions — one is "which internal
// worker tools exist", the other is "which workspace actions may be proposed".
// Callers say `momo_agent::actions::…` so the reader always knows which.
pub use actions::{
    action_block, action_by_id, action_ids, action_ref, action_result_props, card_client_msg_id,
    channel_create_result_body, channel_create_result_rows, channel_create_rows,
    channel_member_add_result_body, channel_member_add_rows, invite_create_rows,
    invite_result_body, invite_result_rows, last_attempt_patch, proposal_summary,
    result_client_msg_id, workspace_action_payload, workspace_action_request_body,
    workspace_action_request_props, ActionResult, ActionResultNext, DeclaredAction, RequiredRole,
    Risk, WorkspaceAction, ACTION_APPROVED_AUDIT_SCHEMA, ACTION_INVITE_CREATE,
    ACTION_RESULT_EXECUTED, ACTION_RESULT_NEXT_HREF, ACTION_RESULT_NEXT_LABEL,
    ACTION_RESULT_PROPS_KEY, ACTION_RESULT_VERSION, ACTION_TYPE_WORKSPACE_ACTION,
    AUDIT_ACTION_APPROVED, AUDIT_CHANNELS_GRANTED, AUDIT_CHANNELS_GRANTED_SCHEMA,
    AUDIT_CHANNEL_CREATED, AUDIT_CHANNEL_CREATED_SCHEMA, AUDIT_CHANNEL_MEMBER_ADDED,
    AUDIT_CHANNEL_MEMBER_ADDED_SCHEMA, DEFAULT_INVITE_EXPIRES_IN_DAYS, INVITE_RESULT_NEXT,
    LAST_ATTEMPT_PROPS_KEY, MAX_PENDING_WORKSPACE_ACTIONS, REF_TYPE_INVITE, ROLE_REQUIRED,
    SECRET_ONCE_INVITE_LINK,
};
pub use approval::{
    approval_payload, approval_request_body, approval_request_props, attach_request_message_in_tx,
    cancel_pending_approvals_for_run_in_tx, count_pending_workspace_actions_in_tx,
    create_pending_approval_in_tx, decided_props_patch, decision_broadcast_payload,
    decision_event_payload, decision_receipt, default_expires_at, existing_decision_in_tx,
    grant_secret_claim_in_tx, is_active_channel_member_in_tx, is_active_human_member_in_tx,
    list_approvals_in_tx, lock_agent_and_count_pending_workspace_actions_in_tx,
    lock_approval_in_tx, lock_target_and_find_pending_action_in_tx, login_handoff_session_id,
    login_handoff_session_id_dropped_detail, mark_approval_decided_in_tx,
    mark_approval_expired_in_tx, normalized_reason, overdue_approvals_in_tx, record_decision_in_tx,
    resume_job_payload, stamp_secret_claimed_in_tx, tool_grants_from_payload, validated_limit,
    validated_status, workspaces_with_overdue_approvals, ApprovalListRow, ExistingDecision,
    HandoffSessionId, LockedApproval, NewApproval, OverdueApproval, PendingWorkspaceActions,
    AUDIT_LOGIN_HANDOFF_SESSION_ID_DROPPED, AUDIT_SCHEMA_LOGIN_HANDOFF_SESSION_ID_DROPPED,
    DEFAULT_TTL_SECONDS, LISTABLE_STATUSES, RESUME_MODEL, RUN_CANCELLED_DECISION_REASON,
};
pub use card_suggest::{
    command_suggest_props, suggestable_command, suggestable_command_ids,
    suggestion_requester_in_tx, validate_suggestion, SuggestableCommand, SuggestionRefusal,
    SuggestionRequester, ValidatedSuggestion, COMMAND_AI_CONNECT, COMMAND_SUGGEST_PROPS_KEY,
    SUGGESTABLE_COMMANDS,
};
pub use decider::{
    action_required_role, decider_gate, gate_plan, pinned_expression_subject, pinned_target_agent,
    pinned_target_member, GatePlan,
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
pub use app_notice::{
    app_result_policy, attach_app_result_policy, connection_unavailable_app_notice, is_notice_host,
    stall_app_notice, AppNotice, AppNoticeKind, AppNoticeSite, APP_RESULT_POLICY_KEY,
    MAX_NOTICE_HOST_BYTES, MAX_REQUESTED_APPS, MAX_REQUESTED_APPS_INPUT, PERSONAL_APP_PLUGIN_IDS,
    PROP_APPS_USED, PROP_APPS_USED_ALIAS, PROP_APP_NOTICE, PROP_REQUESTED_APPS,
    SERVER_OWNED_APP_PROPS_KEYS, SUMMARY_ONLY_INSTRUCTION,
};
pub use app_tool_grants::{
    attach_tool_grants, granted_apps_from_payload, host_app_tools, load_app_tool_grants_in_tx,
    AppToolGrant, TOOL_GRANTS_KEY,
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
// ADR-0200 증보 6 (#4621) — how often a hosted agent comes to the Agent Port.
pub use hosted_cadence::{
    derive_cadence, load_agent_call_times_in_tx, Cadence, CadenceKind, CadenceParams,
    AGENT_PORT_CALL_ACTION, AGENT_PORT_CALL_PATH, CALL_READ_TIMEOUT, CALL_TIMES_SQL,
};
pub use hosted_dm::{
    hosted_dm_approval_state, hosted_dm_delivery, list_hosted_agent_dms_in_tx,
    load_hosted_dm_connection_in_tx, set_hosted_dm_approval_in_tx, unapproved_dm_reason,
    HostedDmApprovalError, HostedDmApprovalState, HostedDmConnection, HostedDmDelivery,
    HostedDmRow,
};
pub use hosted_liveness::{
    collected_since, derive_liveness, liveness_target_for_viewer_in_tx, load_liveness_rows_in_tx,
    record_ping_in_tx, record_tool_error_in_tx, record_tool_success_in_tx, DoorbellFact, Liveness,
    LivenessRow, LivenessState, LivenessThresholds, PingState, Touch,
};
pub use hosted_notice::{
    hosted_skip_notice_body, hosted_skip_notice_body_with_owner, hosted_skip_notice_key,
    hosted_skip_notice_props, inert_display_name, HostedSkipReason, HOSTED_DELIVERY_GUIDE_URL,
    HOSTED_SKIP_ACTION_HREF, HOSTED_SKIP_NOTICE_AUDIT_SCHEMA, HOSTED_SKIP_NOTICE_KIND,
    HOSTED_SKIP_NOTICE_POSTED_ACTION, HOSTED_SKIP_NOTICE_SOURCE,
    HOSTED_SKIP_NOTICE_THROTTLED_ACTION, HOSTED_SKIP_NOTICE_THROTTLE_SECONDS,
    PROVIDER_REQUIRED_ACTION_HREF, PROVIDER_REQUIRED_ACTION_LABEL,
};
pub use korean::{attach_particle, has_final_consonant, particle_for, ParticlePair};
pub use mention::{
    agent_display_name_in_tx, allowed_agent_models, context_window_size, effective_system_prompt,
    load_mention_candidates_in_tx, max_output_tokens, mention_diagnostic_detail,
    mention_job_broadcast_payload, mention_job_payload, mention_run_input, message_source,
    paused_mention_body, paused_mention_props, resolve_mention_routing, MentionCandidate,
    MentionRouting, MentionTrigger, AGENT_CONVERSATION_PREAMBLE, AGENT_INTERACTION_SAFETY_PREAMBLE,
    AGENT_PROFILE_POLICY_PREAMBLE, MENTION_JOB_CREATED_FROM, MENTION_JOB_METHOD_GATEWAY,
    MENTION_JOB_METHOD_WORKER, MENTION_RUN_INPUT_SCHEMA,
};
pub use owner_key::{agent_owner_only_brain_in_tx, mark_agent_owner_key_in_tx, OwnerOnlyBrain};
pub use personal::{
    find_owned_personal_agent_in_tx, find_owner_personal_agent_in_tx,
    list_owner_personal_agents_in_tx, lock_personal_agent_in_tx, mark_personal_agent_in_tx,
    personal_agent_label, set_personal_agent_enabled_in_tx, MarkOutcome, PersonalAgentRow,
};
pub use provisioning::{
    agent_owner_in_tx, create_agent_identity_in_tx, default_enabled_tools,
    load_agent_model_policy_in_tx, load_agent_profile_in_tx, normalized_model,
    normalized_system_prompt, reject_credential_shaped_fields, set_agent_model_source_in_tx,
    set_agent_paused_in_tx, set_agent_thread_reply_wake_in_tx, upsert_agent_profile_in_tx,
    validate_agent_profile, validated_config, AgentCreation, AgentMember, AgentProfile,
    AgentProfileSpec, AgentSpecInvalid, ModelSource, NewAgentMember, DEFAULT_ENABLED_TOOLS,
};
pub use routing::{
    validate_request_routing, RequestedRouting, RoutingInvalid, MAX_ROUTING_MODEL_LENGTH,
    ROUTING_KEYS,
};
pub use run::{
    agent_run_cursor_is_visible_in_tx, authorize_run_binding_in_tx, cancel_run_in_tx,
    completion_status, consume_run_step_in_tx, create_agent_run_in_tx, create_held_agent_run_in_tx,
    end_parked_run_in_tx, end_stalled_run_in_tx, find_agent_run_by_trigger_in_tx, finish_run_in_tx,
    is_active_agent_in_tx, is_active_human_channel_member_in_tx, is_guest_in_channel_in_tx,
    linked_work_session_ids_in_tx, list_agent_run_summaries_in_tx, list_channel_work_runs_in_tx,
    live_run_count_in_tx, load_agent_run_in_tx, load_agent_run_with_visibility_in_tx,
    load_eligible_agent_in_tx, lock_gateway_run_in_tx, lock_run_for_cancel_in_tx,
    mark_run_started_in_tx, park_run_for_approval_in_tx, park_runs_for_control_window_in_tx,
    requeue_run_from_approval_in_tx, resume_runs_from_control_window_in_tx,
    run_trigger_message_in_tx, succeed_parked_run_in_tx, terminal_run_ids_in_tx, trigger_summary,
    validated_run_limit, AgentRunRow, AgentRunSummaryPage, AgentRunSummaryRow, CancellableRun,
    CompletionStatusError, CreatedRun, EligibleAgent, GatewayRunSnapshot, NewAgentRun, ParkedRun,
    RunBindingRejected, RunStatus, RunTrigger, WelcomeKind, PROP_ANSWERS_MESSAGE_ID,
    TRIGGER_SUMMARY_LIMIT,
};
pub use run_activity::{
    id_alphabet_ok, record_run_activity_in_tx, ActivityReport, RawActivity, RawPlanItem,
    ReportFault, ReportField, ReportRule, ACTIVITY_KINDS, ACTIVITY_ROWS_PER_RUN, ACTIVITY_STATUSES,
    MAX_ACTIVITIES_PER_CALL, MAX_ACTIVITY_ID_CHARS, MAX_ACTIVITY_LABEL_CHARS, MAX_ACTIVITY_N,
    MAX_PLAN_ITEMS, MAX_PLAN_TEXT_CHARS, PLAN_ROWS_PER_RUN, PLAN_STATUSES,
};
pub use run_event::{
    append_run_event_in_tx, delete_expired_run_events_in_tx, record_tool_call_in_tx,
    workspaces_with_expired_run_events, AppendedRunEvent, ToolCallRecord, RUN_EVENT_RETENTION_DAYS,
    TOOL_CALL_DURATION_MS_MAX, TOOL_CALL_ROWS_PER_RUN,
};
pub use run_progress::{
    approval_is_named_to_viewer, assemble_run_progress, list_channel_run_progress_base_in_tx,
    list_run_events_in_tx, list_run_ledger_in_tx, redact_unseen_approvals_in_tx,
    visible_channels_in_tx, ActivityTallyRow, ActivityView, AheadRun, JobFacts, LeaseState,
    PlanStepView, QueueEntry, RunEventInclude, RunEventRow, RunLedger, RunPhase, RunProgressBase,
    RunProgressRow, ToolTallyRow,
};
pub use woken::{
    active_hosted_connection_id_in_tx, load_woken_agent_facts_in_tx, woken_clock_start,
    woken_uncollected_verdict, WokenAgentFacts, WokenVerdictInput,
};
// ADR-0200 증보 2026-10-15 R1 — the workspace "running now" read (#3847).
pub use connector_trial::{
    agent_is_operator_env_pinned_in_tx, connector_trial_facts_in_tx, connector_trial_notice_body,
    connector_trial_stop, other_operator_env_pinned_in_tx, parse_connector_apps,
    trial_candidate_facts_in_tx, ungranted_apps, workspace_has_other_trial_agent_in_tx,
    ConnectorTrialAttest, ConnectorTrialFacts, ConnectorTrialStop,
};
pub use run_progress::{
    active_run_cursor_in_tx, list_active_run_progress_base_in_tx, validated_active_run_limit,
    visible_active_run_counts_in_tx, workspace_active_run_totals_in_tx, ActiveRunScope,
    VisibleAgentRunCounts, ACTIVE_RUN_PAGE_MAX,
};
pub use status::{
    agent_partial_payload, agent_partial_tool_call_payload, agent_status_channel,
    opening_agent_status_payload, progress_agent_status_payload, terminal_agent_status_payload,
    terminal_phase, AgentPhase, AgentRunAddress, AGENT_PARTIAL_EVENT_TYPE, AGENT_STATUS_EVENT_TYPE,
    AGENT_STATUS_EVENT_VERSION,
};
pub use subscription::{
    agent_claude_subscription_blocked_in_tx, agent_connector_owner_in_tx,
    agent_is_owner_only_in_tx, callable_by, claude_subscription_blocked,
    connector_owner_notice_body, count_owner_subscription_agents_in_tx, default_name_candidates,
    derive_brain, device_slug, find_subscription_agent_by_device_in_tx, harness_name_suffix,
    load_agent_read_facts_in_tx, load_invocation_scopes_in_tx, load_member_naming_in_tx,
    lock_and_find_recent_notice_in_tx, lock_and_find_recent_server_notice_in_tx,
    lock_subscription_registration_in_tx, mark_agent_owner_only_in_tx, notice_root,
    notice_thread_key, owner_only_gate, release_subscription_device_in_tx,
    set_connector_owner_in_tx, set_subscription_device_in_tx, subscription_notice_body,
    subscription_notice_key, subscription_notice_props, valid_device_id, AgentBrain,
    AgentReadFacts, ConnectorOwner, ConnectorOwnerChange, OwnerOnlyScope, PersonalAgentFacts,
    RecentNotice, SubscriptionHarness, SubscriptionNoticeKind, CALLABLE_BY_EVERYONE,
    CALLABLE_BY_OWNER_ONLY, CLAUDE_SUBSCRIPTION_AGENT_PAUSED, HOSTED_RECENTLY_SEEN_SQL,
    INVOCATION_SCOPE_OWNER_ONLY, INVOCATION_SCOPE_WORKSPACE, SKIP_CONNECTOR_OWNER_NON_OWNER,
    SKIP_OWNER_ONLY_NON_OWNER, SKIP_PERSONAL_AGENT_CLIENT_SIGNS, SKIP_SUBSCRIPTION_AGENTS_DISABLED,
    SUBSCRIPTION_AGENTS_PER_HARNESS_LIMIT, SUBSCRIPTION_AGENT_ONLINE_WINDOW_SECONDS,
    SUBSCRIPTION_NOTICE_AUDIT_SCHEMA, SUBSCRIPTION_NOTICE_POSTED_ACTION,
    SUBSCRIPTION_NOTICE_SOURCE, SUBSCRIPTION_NOTICE_THROTTLED_ACTION,
    SUBSCRIPTION_NOTICE_THROTTLE_SECONDS,
};
pub use thread_wake::{
    find_unclaimed_dm_run_in_tx, find_unclaimed_thread_run_in_tx, load_thread_wake_target_in_tx,
    UnclaimedThreadTurn, THREAD_REPLY_WAKE_REASON,
};
pub use usage::{
    agent_month_spend_in_tx, agent_usage_in_tx, budget_state, chain_usage_in_tx,
    latest_ledger_model_in_tx, pricing_available_for_model_in_tx, provider_spend_in_tx,
    record_run_usage_in_tx, usage_summary_in_tx, usage_summary_visible_in_tx, validated_window,
    AgentMonthSpend, AgentUsageRow, ChainUsage, ProviderModelSpend, ResolvedUsage, RunUsageReport,
    UsageAgentRow, UsageBucket, UsageBucketRow, UsageBudget, UsageModelRow, UsageSource,
    UsageSummary, UsageTotals, UsageWindow, UsageWindowError, DEFAULT_LOOKBACK_DAYS,
    MAX_RANGE_DAYS,
};
pub use welcome::{
    configure_welcome_hosted_signal_hours, ensure_agent_in_general_in_tx,
    lock_welcome_opener_in_tx, resolve_welcome_owner_in_tx, resolve_welcome_target_in_tx,
    welcome_job_payload, welcome_opener_already_queued_in_tx, welcome_opener_idempotency_key,
    welcome_run_input, WelcomeTarget, DEFAULT_WELCOME_PROMPT, PROVIDER_REQUIRED_BODY,
    WELCOME_AUDIT_PROVIDER_REQUIRED, WELCOME_AUDIT_QUEUED, WELCOME_AUDIT_SCHEMA,
    WELCOME_JOB_CREATED_FROM, WELCOME_RUN_INPUT_SCHEMA,
};
