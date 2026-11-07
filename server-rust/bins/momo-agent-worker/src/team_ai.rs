//! The team AI's turn (ADR-0201): a short, bounded model call whose only tool
//! raises an ADR-0186 approval card.
//!
//! Everything that *decides* lives in `momo_workspace_actions::team_ai` (allow-list, context
//! builder, proposal transaction, fallback copy). This module is the plumbing the
//! worker owns: read the switch, enforce the daily ceiling, call the model under
//! the 20-second cut, and settle the job.
//!
//! What this turn deliberately does **not** do, compared with an ordinary agent
//! turn: no channel history in the prompt, no memory block, no streaming, no
//! completion-report protocol, no A2A routing of what it says. Its text is
//! posted by [`AgentWorker::team_ai_finish`], which writes one message and the
//! ledger row and routes nothing.
//!
//! ## ADR-0201 증보 v2 (#3894): a bounded read loop
//!
//! The helper may now read before it answers (H4) and, on a wire that has one,
//! let the provider search the web (H5). The loop is bounded on every axis
//! (H9-I11, H10): at most [`team_ai::MAX_MODEL_CALLS`] model calls, at most
//! [`team_ai::MAX_TOOL_CALLS`] read calls, each call under the 20-second cut and
//! the whole request under [`crate::WorkerConfig::team_ai_request_deadline`].
//!
//! * Each read runs in its own transaction **as the requester**:
//!   `SET LOCAL ROLE momo_helper_read` first (NOBYPASSRLS, SELECT only), then the
//!   same domain function the REST read uses, with the requester id the server
//!   decided. Nothing is written in that transaction.
//! * A result goes back to the model as a fenced data block in a user turn — the
//!   one shape all three wires carry without adapter changes. The fence says it
//!   is data; [`team_ai_tools::data_text`] makes it impossible to close.
//! * Once any workspace read has happened in a request, no later call in that
//!   request is offered web search (H5: workspace text never rides a search
//!   query out).
//! * Tool names, counts and token sums are recorded (audit `team_ai.turn`,
//!   `via_ai` on a card); prompts, results and answers are not (H9-I10).
//!
//! ## ADR-0201 증보 v3 B5 (#4967): the task mode
//!
//! A request that cannot finish inside this short turn may end it with `task_continue {plan,
//! note}` (offered only while the `long_research` bundle is on). That starts a **task**: the
//! `team_ai_task` row and the first resume job are written in one transaction
//! ([`AgentWorker::team_ai_task_begin`]), and every later step is a job of the same run
//! ([`AgentWorker::run_team_ai_task_step`], in the child module). Whether a job is a first turn, a
//! step to run or a duplicate to drop is the **row's** verdict (`decide_step`), read at the top of
//! [`AgentWorker::run_team_ai_turn`].

mod delegate;
mod task;

use std::time::Instant;

use momo_agent::{
    finish_run_in_tx, lock_gateway_run_in_tx, record_run_usage_in_tx, RunStatus, RunUsageReport,
};
use momo_db::audit::{self, AuditEntry};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{send_thread_notice_in_tx, MessageType, NewMessage};
use momo_outbox::ClaimedAgentJob;
use momo_workspace_actions::team_ai::{
    self, FallbackReason, ProposalContext, ProposalRefusal, TeamAiWorkspace, ViaAi, WebSearch,
};
use momo_workspace_actions::team_ai_attachments as team_ai_files;
use momo_workspace_actions::team_ai_hermes::{
    self, DelegateCode, DelegationBounds, DelegationUsage, DoorFacts, HermesKind, HermesPrompt,
    PinnedAgent, RequesterFacts, TargetResolution,
};
use momo_workspace_actions::team_ai_hermes_request::{self, CallVerdict, IdentityContext};
use momo_workspace_actions::team_ai_limits::{self, LimitHit, Usage};
use momo_workspace_actions::team_ai_tools::{self, ToolOutcome};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::payload::AgentJobPayload;
use crate::provider::{
    ChatMessage, ChatRequest, ChatUsage, ModelImage, ProviderError, ProviderToolCall, ProviderWire,
};
use crate::{
    emit_awaiting_approval_agent_status, emit_terminal_agent_status, AgentWorker,
    ResolvedTransport, Settlement,
};

/// What the first read of a team-AI turn found.
struct Gathered {
    state: TeamAiWorkspace,
    requester: Option<momo_agent::card_suggest::SuggestionRequester>,
    trigger_text: String,
    used_today: i64,
    /// This month's list-price spend in micro-dollars — read only when the workspace set a monthly
    /// dollar limit (B9), otherwise `0` and never queried.
    month_micro_usd: i64,
    roster: team_ai::Roster,
    candidates: Vec<(Uuid, String, String)>,
    recent_requests: i64,
    searches_today: i64,
    /// B5-2 (#4967): the run's task row — **its existence is task mode** — and the run's status as
    /// this job reads it (the cooperative cancel check).
    task: Option<momo_agent::team_ai_task::TaskRow>,
    run_status: Option<RunStatus>,
    /// ADR-0201 증보 v4 (#5369): what the delegation door reads from the database — present only when
    /// the operator opened the delegation on this process, the `hermes` bundle is on and a human asked
    /// ([`HermesGather::wanted`]). `None` is a closed door that was not even looked at.
    hermes: Option<HermesGather>,
}

/// What the delegation door reads from the database (ADR-0201 증보 v4 P2, #5369), in the request's first
/// read transaction. Read-only; every query is a tenant read under RLS.
struct HermesGather {
    /// The workspace's agents pinned to the operator's own link (G3's input).
    pinned: Vec<PinnedAgent>,
    /// The requester is a guest of the workspace or of the channel (G2).
    guest: bool,
    /// The workspace's own name, for the identity filter's list of names that only the context holds.
    workspace_name: String,
    /// What the requester **wrote** — the raw message body, without the lines the server appends to the
    /// trigger turn (ids, types, sizes). The only text a name may legitimately come from (P1).
    trigger_body: String,
    /// Tasks running in this workspace / for this requester (G6's task bounds; a delegation is a task).
    tasks_workspace: i64,
    tasks_requester: i64,
    /// ADR-0201 증보 v4 P7 (#5370): the day's, the requester's last ten minutes' and the running
    /// delegations, from the marker on the task rows. An advertisement-time estimate (no lock); the `called`
    /// commit counts again under the workspace lock.
    delegations: momo_agent::team_ai_task::DelegationCounts,
}

impl HermesGather {
    /// Read the door's inputs. Called only when the operator opened the delegation on this process, the
    /// bundle is on and a human asked: otherwise the door is shut whatever the database says, and nothing
    /// is read (an instance that never opted in pays nothing).
    async fn read(
        conn: &mut momo_db::PgConnection,
        workspace_id: Uuid,
        helper: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        trigger_message_id: Option<Uuid>,
    ) -> Result<HermesGather, DbError> {
        let pinned = team_ai_hermes::pinned_agents_in_tx(conn, workspace_id, helper).await?;
        let guest = momo_agent::is_guest_in_channel_in_tx(
            conn,
            workspace_id,
            requester.channel_id,
            requester.member_id,
        )
        .await?;
        let workspace_name: String =
            momo_db::sqlx::query_scalar("SELECT name FROM workspace WHERE id = $1")
                .bind(workspace_id)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or_default();
        let trigger_body: String = match trigger_message_id {
            Some(id) => momo_db::sqlx::query_scalar(
                "SELECT body FROM message WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL",
            )
            .bind(workspace_id)
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
            .flatten()
            .unwrap_or_default(),
            None => String::new(),
        };
        let (tasks_workspace, tasks_requester) = momo_agent::team_ai_task::running_counts_in_tx(
            conn,
            workspace_id,
            requester.member_id,
            None,
        )
        .await?;
        let delegations = momo_agent::team_ai_task::delegation_counts_in_tx(
            conn,
            workspace_id,
            requester.member_id,
            team_ai_hermes::REQUESTER_WINDOW_SECS,
        )
        .await?;
        Ok(HermesGather {
            pinned,
            guest,
            workspace_name,
            trigger_body,
            tasks_workspace,
            tasks_requester,
            delegations,
        })
    }
}

/// What the delegation door did in one request, as names and numbers only (H9-I10, P11): the kinds it
/// offered, and the closed word of what happened to a call of the tool. **Never the request sentence, a
/// result, or the target's name.**
#[derive(Debug, Clone, Default)]
struct HermesTrace {
    /// The kinds this request was offered at any call.
    offered: Vec<&'static str>,
    /// How the request's calls of `ask_hermes` went, in order: `not_offered`, `invalid_arguments`, and the
    /// one that ends the turn — `accepted` (the call became the delegation step) or, in the step itself,
    /// the delegation's own closed word. Closed words from [`DelegateCode`] and the two audit words.
    results: Vec<&'static str>,
    /// How the delegation ended, for the transaction that finishes the run: one `team_ai.delegate` audit
    /// row, the marker's move and the Hermes ledger row (ADR-0201 증보 v4 P4-8, P11).
    settle: Option<delegate::HermesSettlement>,
}

/// What one request did, for the audit row and `via_ai` (H9-I10). Names and
/// numbers only — never a prompt, a result or an answer.
#[derive(Debug, Clone, Default)]
struct TurnTrace {
    model: String,
    wire: &'static str,
    tools: Vec<String>,
    tool_codes: Vec<&'static str>,
    model_calls: i32,
    web_searches: i32,
    latency_ms: i64,
    /// The registry id of a card the helper refused to raise (a bundle that is off, a card after
    /// a read). It comes from the registry's own `&'static str`, never from the model's text.
    refused_action: Option<&'static str>,
    /// B5 (#4967): the step of a task this request is (`None` for an ordinary request and for the
    /// first turn that starts a task). A task's replies are answers the whole task read for, so
    /// they never get link previews, whatever this one step called.
    task_step: Option<i32>,
    /// The `card_suggest` command id of the card this turn ended with (`work.request.open`): the
    /// registry's `&'static str`, so a count of suggestions needs no text. **Never the prompt**
    /// the card carries, and never the card's label or body (H9-I10).
    suggested_command: Option<&'static str>,
    /// ADR-0201 증보 v4 (#5369): what the delegation door offered and how a call of `ask_hermes` went.
    /// `None` (the default, and every request of an instance that did not open the delegation) adds
    /// nothing to the audit row.
    hermes: Option<HermesTrace>,
}

impl TurnTrace {
    fn audit_detail(&self, spend: Option<Spend>, outcome: &str) -> Value {
        let mut detail = json!({
            "schema": "momo.team_ai_turn.v1",
            "outcome": outcome,
            "model": self.model,
            "wire": self.wire,
            "tools": self.tools,
            "tool_results": self.tool_codes,
            "model_calls": self.model_calls,
            "web_searches": self.web_searches,
            "latency_ms": self.latency_ms,
            "prompt_tokens": spend.map(|s| s.usage.prompt_tokens),
            "completion_tokens": spend.map(|s| s.usage.completion_tokens),
        });
        if let Some(action) = self.refused_action {
            detail["refused_action"] = json!(action);
        }
        if let Some(step) = self.task_step {
            detail["task_step"] = json!(step);
        }
        if let Some(command) = self.suggested_command {
            detail["suggested_command"] = json!(command);
        }
        if let Some(hermes) = &self.hermes {
            // names and closed words only — never the request sentence, a result or a target's name
            detail["hermes"] = json!({"offered": hermes.offered, "results": hermes.results});
        }
        detail
    }
}

/// H5: can this wire search on the provider's side? Decided by the wire, never
/// by a provider's name. `Responses` stays "no" until its tool type is verified
/// against the live API (runtime-unverified follow-up).
fn wire_searches(wire: ProviderWire) -> bool {
    matches!(wire, ProviderWire::AnthropicMessages)
}

/// [`team_ai_hermes_request::judge_call`] under the name this module's loop reads it by.
use team_ai_hermes_request::judge_call as team_ai_request_judge;

/// `team_ai.turn`'s `outcome` for a card the helper refused to raise (B13-I5, B4-3): a reason
/// code and nothing else, so refusals can be counted.
const OUTCOME_REFUSED_ROLE_OFF: &str = "refused_role_off";
const OUTCOME_REFUSED_AFTER_READ: &str = "refused_after_read";
/// B4-4 구현 확정 (#4965): an admin invite link, which a person makes on the screen.
const OUTCOME_REFUSED_INVITE_ROLE: &str = "refused_invite_role";
/// `team_ai.turn`'s `outcome` for a turn that ended with a `card_suggest` card (B8 C1, #4972).
const OUTCOME_SUGGESTED_CARD: &str = "suggested_card";

/// How a settled team-AI turn ends the run.
enum Ending {
    /// A reply was posted and the run succeeded.
    Answered,
    /// A reply was posted and the run succeeded, and the reply is a refusal of the card the model
    /// proposed: the audit row's `outcome` is this reason code.
    Refused(&'static str),
    /// A reply was posted with a `card_suggest` card — the payload is the command's registry id
    /// (`work.request.open`) — and the run succeeded. **The finishing transaction judges the card
    /// once more** against the role switches as they are by then (B13-I5, the wall a suggestion has
    /// in place of the proposal transaction's): a bundle switched off while the model thought
    /// turns the card into the refusal sentence, and the audit row says so.
    Suggested(&'static str),
    /// The run ends as a hand-off / refusal (`failed` with a code), nothing else to do.
    Closed(&'static str),
}

impl AgentWorker {
    /// `None` means "this agent is not the workspace's team AI — run the ordinary
    /// turn". `Some(settlement)` means the team-AI path handled (and settled) it.
    pub(crate) async fn run_team_ai_turn(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        transport: &mut ResolvedTransport,
    ) -> Option<Settlement> {
        let workspace_id = job.workspace_id;
        let agent = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let trigger_message_id = payload.trigger_message_id;

        // ADR-0201 증보 v4 (#5369): has the operator opened the delegation on this process? Without it the
        // door is shut whatever the database says, so nothing of it is read.
        let hermes_delegation_opened = self.config.hermes_delegation_opened();
        let gathered = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let state = team_ai::read_state_in_tx(conn, workspace_id).await?;
                if !state.is_team_ai(agent) {
                    return Ok(None);
                }
                let requester = momo_agent::card_suggest::suggestion_requester_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                )
                .await?;
                // #4970: the trigger turn lists the message's readable files — ids, types, sizes —
                // only while the `files` bundle is on (no sentence, no id for a bundle that is off).
                // A task step (#4967: no trigger in its payload) reads no attachments, so it lists none.
                let files_on = state.roles.is_on(momo_agent::team_ai_roles::FILES)
                    && trigger_message_id.is_some();
                // A step job carries no trigger (B5-1: the requester and the request text come
                // from the **run row**, the one place they are derived), so read it from there.
                let trigger_message_id = match trigger_message_id {
                    Some(id) => Some(id),
                    None => {
                        momo_agent::run_trigger_message_in_tx(conn, workspace_id, run_id).await?
                    }
                };
                let trigger_text: String = match trigger_message_id {
                    Some(id) => sqlx_body(conn, workspace_id, id, files_on).await?,
                    None => String::new(),
                };
                let task = momo_agent::team_ai_task::load_in_tx(conn, workspace_id, run_id).await?;
                let run_status =
                    momo_agent::team_ai_task::run_status_in_tx(conn, workspace_id, run_id).await?;
                let used_today =
                    team_ai::tokens_used_today_in_tx(conn, workspace_id, agent).await?;
                let month_micro_usd = team_ai_limits::month_spend_if_limited_in_tx(
                    conn,
                    workspace_id,
                    agent,
                    &state.limits,
                )
                .await?
                .cost_micro_usd;
                let (roster, candidates) = match &requester {
                    Some(requester) => (
                        team_ai::load_roster_in_tx(
                            conn,
                            workspace_id,
                            requester.member_id,
                            channel_id,
                        )
                        .await?,
                        team_ai::delegation_candidates_in_tx(
                            conn,
                            workspace_id,
                            agent,
                            channel_id,
                            requester.member_id,
                        )
                        .await?,
                    ),
                    None => (team_ai::Roster::default(), Vec::new()),
                };
                let searches_today =
                    team_ai::searches_used_today_in_tx(conn, workspace_id, agent).await?;
                let recent_requests = match &requester {
                    Some(requester) => {
                        team_ai::recent_requests_by_in_tx(
                            conn,
                            workspace_id,
                            agent,
                            requester.member_id,
                        )
                        .await?
                    }
                    None => 0,
                };
                let hermes = match &requester {
                    Some(requester)
                        if hermes_delegation_opened
                            && state.roles.is_on(momo_agent::team_ai_roles::HERMES) =>
                    {
                        Some(
                            HermesGather::read(
                                conn,
                                workspace_id,
                                agent,
                                requester,
                                trigger_message_id,
                            )
                            .await?,
                        )
                    }
                    _ => None,
                };
                Ok(Some(Gathered {
                    searches_today,
                    recent_requests,
                    state,
                    requester,
                    trigger_text,
                    used_today,
                    month_micro_usd,
                    roster,
                    candidates,
                    task,
                    run_status,
                    hermes,
                }))
            })
        })
        .await;
        let gathered = match gathered {
            Ok(None) => return None,
            Ok(Some(gathered)) => gathered,
            Err(error) => {
                return Some(
                    self.settle_retryable(
                        job,
                        &format!("team ai read failed: {error}"),
                        &transport.endpoint,
                    )
                    .await,
                )
            }
        };

        // ADR-0201 증보 v3 B5-2 (#4967): is this job a first turn, a task step to run, or a job to
        // drop? The row of the run decides — not the payload — so a re-claimed first-turn job
        // (its task already started), a duplicated step job and a late job of an ended task read
        // the same row and none of them runs a step twice.
        match momo_agent::team_ai_task::decide_step(gathered.task.as_ref(), payload.task_step()) {
            momo_agent::team_ai_task::StepDecision::FirstTurn => {}
            momo_agent::team_ai_task::StepDecision::Skip(reason) => {
                tracing::info!(
                    run_id = %run_id,
                    step = payload.task_step(),
                    reason = reason.as_str(),
                    "team ai task job dropped: the run's row says there is nothing to run"
                );
                self.settle_done(job.id, Some(reason.as_str())).await;
                return Some(Settlement::Skipped);
            }
            momo_agent::team_ai_task::StepDecision::RunStep(step) => {
                return Some(
                    self.run_team_ai_task_step(job, payload, run_id, transport, gathered, step)
                        .await,
                );
            }
        }

        // The switch is off (or the job outlived it): the member is paused, so a
        // new mention never reaches here; a straggler is closed without a word.
        if !gathered.state.enabled {
            return Some(
                self.team_ai_close(job, payload, run_id, "team_ai_disabled")
                    .await,
            );
        }
        // D6-5: only a human's own message is an instruction. An agent-authored
        // trigger (or a human who left the channel) ends the run silently — this is
        // also the loop guard between agents.
        let Some(requester) = gathered.requester.clone() else {
            return Some(
                self.team_ai_close(job, payload, run_id, "team_ai_no_human_requester")
                    .await,
            );
        };
        // ADR-0201 증보 v3 B9 (#4944): BYOK — the team decides. With no limit set and no operator
        // ceiling nothing here ever stops a turn; the limits are judged BEFORE the model is asked,
        // so a limit that is hit means zero model calls.
        let caps = self.config.team_ai_caps();
        let usage = Usage {
            tokens_today: gathered.used_today,
            month_micro_usd: gathered.month_micro_usd,
        };
        if let Some(hit) = team_ai_limits::judge(&gathered.state.limits, &caps, &usage) {
            return Some(
                self.team_ai_limit_reached(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    hit,
                )
                .await,
            );
        }

        // D6-5: asking faster than a person plausibly does is refused before any
        // model call (the count includes this run, hence `>`).
        if gathered.recent_requests > team_ai::MAX_REQUESTS_PER_10_MIN {
            return Some(
                self.team_ai_fallback(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    FallbackReason::RateLimited,
                    None,
                    "",
                )
                .await,
            );
        }

        // D4 pre-flight for an OAuth link (internal dogfood only): refresh first.
        if transport.needs_refresh(crate::now_ms())
            && self.refresh_and_reseal(transport).await.is_err()
        {
            return Some(
                self.team_ai_fallback(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    FallbackReason::Slow,
                    None,
                    "",
                )
                .await,
            );
        }

        let model = payload.model_or(&self.config.default_model).to_string();
        let wire = transport.endpoint.wire;
        // ADR-0201 증보 v4 P2 (#5369): one reading of "may this request search", shared with the task
        // steps. The administrator's switch and the operator's `0` come BEFORE the wire, so a wire that
        // cannot search never turns a switch into `NotSupported` (the state Hermes may answer, T14).
        let web = WebSearch::judge(
            gathered.state.web_search,
            caps.search_off(),
            wire_searches(wire),
            team_ai_limits::search_cap(&gathered.state.limits, &caps)
                .is_some_and(|cap| gathered.searches_today >= cap),
        );
        // ADR-0201 증보 v4 (#5369): the delegation door for this request — judged by ONE function over
        // ten gates, from facts gathered once. `None` = the operator did not open the delegation on this
        // process (or the bundle is off, or nobody human asked): the tool is not on any call of this
        // request and the prompt says nothing about Hermes.
        let door = match (&gathered.hermes, &gathered.requester) {
            (Some(hermes), Some(requester)) => Some(
                self.hermes_door_facts(
                    workspace_id,
                    &gathered.state,
                    &caps,
                    requester,
                    hermes,
                    web,
                )
                .await,
            ),
            _ => None,
        };
        let identity = gathered
            .hermes
            .as_ref()
            .map(|hermes| IdentityContext::from_roster(&gathered.roster, &hermes.workspace_name))
            .unwrap_or_default();
        let mut trace = TurnTrace {
            model: model.clone(),
            wire: wire.as_str(),
            ..TurnTrace::default()
        };
        // ADR-0201 증보 v3 B3: the workspace's role bundles, as this request read them. What the
        // model is offered (the tool's `actionId` enum, the tool list, the prompt) is built from
        // them; the proposal transaction and the decision read them again.
        //
        // The system prompt is built before anything is read from `advertised_action_ids(false)`.
        // After the request has read something (B4-3) it is built ONCE more from the same function
        // with `tainted = true`, and from nothing else: the sensitive sentences leave it and the one
        // sentence to answer with takes their place (`team_ai::system_prompt_for`). The task-mode
        // sentence stays: `task_continue` is reading work, not behind the read rule, so the rebuilt
        // prompt gets the same `task_prompt` the first call got (merge of #4965 and #4967).
        // `a10_text_inside_a_read_is_never_an_instruction` pins that nothing the read returned is in
        // either prompt. The tool's enum, below, is cut by the same function on the same boolean.
        let roles = gathered.state.roles;
        // B5-3 / B15-A16: the task-mode sentences exist only while the bundle that owns the tool is on.
        let task_prompt = if roles.tool_allowed(momo_agent::tools::TASK_CONTINUE) {
            team_ai::TaskPrompt::Offer
        } else {
            team_ai::TaskPrompt::Off
        };
        // B8 C1: the `card_suggest` commands this request is offered (`code` on = the work-request
        // card). The tool, the prompt and the check on what the model names all read this one list.
        let card_commands = roles.advertised_command_ids();
        let hermes_prompt = |tainted: bool| match &door {
            Some(door) => door.prompt(tainted),
            None => HermesPrompt::Off,
        };
        let mut messages = vec![
            ChatMessage::system(team_ai::system_prompt_full(
                &gathered.roster,
                web,
                &roles.advertised_action_ids(false),
                &card_commands,
                &[],
                task_prompt,
                roles.is_on(momo_agent::team_ai_roles::FILES),
                &hermes_prompt(false),
            )),
            ChatMessage::user(team_ai::user_turn(&gathered.trigger_text)),
        ];
        let mut spend: Option<Spend> = None;
        let mut read_used = false;
        // #4970: the one picture this request may hold. It rides **every** model call after the read
        // (the call re-sends it), so there is at most one, and it is dropped with this function.
        let mut attached: Vec<ModelImage> = Vec::new();
        let mut prompt_after_read = false;
        let started = Instant::now();
        let deadline = self.config.team_ai_request_deadline;

        let mut card_call: Option<ProviderToolCall> = None;
        // ADR-0201 증보 v4 P4-4 (#5370): a call of the delegation tool that passed every check ends this
        // turn and starts the delegation step (kind, the cleaned sentence, the Hermes it goes to).
        let mut hermes_call: Option<(HermesKind, String, Uuid)> = None;
        let (completion, call) = loop {
            let elapsed = started.elapsed();
            if trace.model_calls as usize >= team_ai::MAX_MODEL_CALLS || elapsed >= deadline {
                trace.latency_ms = millis(started);
                return Some(
                    self.team_ai_fallback_traced(
                        job,
                        payload,
                        run_id,
                        &requester,
                        &gathered.candidates,
                        FallbackReason::TooLong,
                        spend,
                        &trace,
                    )
                    .await,
                );
            }
            // The tools this call may use. Reads stop being offered once the read
            // budget is spent; web search is never offered after a read (H5).
            //
            // B3 / B4-3: the proposal tool's `actionId` enum is the allow-list minus every
            // bundle that is off, and — once this request has read anything (a workspace read, or
            // a search the provider ran) — minus the sensitive ids too. A tool with nothing left
            // to offer is not offered at all.
            let tainted = read_used || trace.web_searches > 0;
            let offered = roles.advertised_action_ids(tainted);
            if tainted && !prompt_after_read {
                messages[0] = ChatMessage::system(team_ai::system_prompt_full(
                    &gathered.roster,
                    web,
                    &offered,
                    &card_commands,
                    &roles.withheld_by_read(),
                    task_prompt,
                    roles.is_on(momo_agent::team_ai_roles::FILES),
                    &hermes_prompt(true),
                ));
                prompt_after_read = true;
            }
            // ADR-0201 증보 v4 G1~G10: the delegation tool is on this call only if the door is open for
            // the request as it stands now (`tainted` is G7). Its `kind` enum holds exactly the kinds
            // offered; the same list is what the answer is judged against below (P4-4).
            let hermes_verdict = match &door {
                Some(door) => door.judge(tainted),
                None => team_ai_hermes::DoorVerdict::Closed(team_ai_hermes::DoorClosed::BundleOff),
            };
            let hermes_offered: Vec<HermesKind> = hermes_verdict.kinds().to_vec();
            if !hermes_offered.is_empty() {
                let hermes_trace = trace.hermes.get_or_insert_with(HermesTrace::default);
                for kind in hermes_verdict.kind_names() {
                    if !hermes_trace.offered.contains(&kind) {
                        hermes_trace.offered.push(kind);
                    }
                }
            }
            let mut momo_tools: Vec<momo_agent::tools::ToolDefinition> =
                momo_agent::tools::workspace_action_propose_definition(&offered)
                    .into_iter()
                    .collect();
            if trace.tools.len() < team_ai::MAX_TOOL_CALLS {
                momo_tools.extend(team_ai_tools::read_tool_definitions());
            }
            // B5-3: the task-mode tool, owned by `long_research`.
            momo_tools.push(momo_agent::tools::task_continue_definition());
            // B8 C1: the work-request card, offered only while a bundle that owns it is on. Not
            // behind the taint rule (B4-3): it changes no server state and a person sends what it
            // fills in, so a request that read something may still give it.
            momo_tools.extend(momo_agent::tools::card_suggest_definition(&card_commands));
            // ADR-0201 증보 v4: the delegation tool, with the kinds the door offers (none = no tool).
            momo_tools.extend(momo_agent::tools::ask_hermes_definition(
                &hermes_verdict.kind_names(),
            ));
            // The seam later slices fill: a tool a bundle owns leaves with it.
            momo_tools.retain(|tool| roles.tool_allowed(tool.name));
            let mut tools: Vec<Value> = Vec::new();
            if web == WebSearch::Available && !read_used {
                tools.push(crate::anthropic::web_search_tool(
                    &model,
                    &transport.endpoint.base_url,
                    team_ai::WEB_SEARCH_MAX_USES,
                ));
            }
            let request = ChatRequest {
                provider: None,
                model: model.clone(),
                messages: messages.clone(),
                max_tokens: Some(team_ai::MAX_OUTPUT_TOKENS),
                // The profile's own `tool_schema` is operator JSON; the team AI is
                // offered exactly these tools and nothing an operator can add.
                tools,
                momo_tools,
            };
            let prompt_chars: usize = request
                .messages
                .iter()
                .map(|message| message.content.chars().count())
                .sum();
            let cut = self
                .config
                .team_ai_model_timeout
                .min(deadline.saturating_sub(elapsed));
            let call_started = Instant::now();
            let attempt = tokio::time::timeout(cut, async {
                if attached.is_empty() {
                    self.provider.complete(&transport.endpoint, &request).await
                } else {
                    self.provider
                        .complete_with_images(&transport.endpoint, &request, &attached)
                        .await
                }
            })
            .await;
            trace.model_calls += 1;
            let call_ms = millis(call_started);
            let completion = match attempt {
                Ok(Ok(completion))
                    if !(completion.text.trim().is_empty() && completion.tool_calls.is_empty()) =>
                {
                    completion
                }
                // Timed out, errored, or said nothing: hand off, do not retry (a
                // retry would spend the budget again and still miss it).
                other => {
                    tracing::warn!(
                        run_id = %run_id,
                        timed_out = other.is_err(),
                        latency_ms = call_ms,
                        model_calls = trace.model_calls,
                        "team ai model call produced no usable answer"
                    );
                    // The provider may well have spent tokens before it timed out
                    // or failed: charge a conservative estimate so the daily
                    // ceiling still moves.
                    spend = Spend::add(spend, Spend::of(None, prompt_chars));
                    trace.latency_ms = millis(started);
                    let reason = if !attached.is_empty() && image_was_refused(&other) {
                        FallbackReason::ImageRefused
                    } else if started.elapsed() >= deadline && trace.model_calls > 1 {
                        FallbackReason::TooLong
                    } else {
                        FallbackReason::Slow
                    };
                    return Some(
                        self.team_ai_fallback_traced(
                            job,
                            payload,
                            run_id,
                            &requester,
                            &gathered.candidates,
                            reason,
                            spend,
                            &trace,
                        )
                        .await,
                    );
                }
            };
            spend = Spend::add(spend, Spend::of(completion.usage, prompt_chars));
            trace.web_searches += completion.web_search_requests.max(0);

            if completion.tool_calls.is_empty() {
                break (completion, None);
            }
            // A proposal ends the request, whatever else the call asked for.
            if let Some(propose) = completion.tool_calls.iter().find(|call| {
                momo_agent::tools::normalize(&call.name)
                    == momo_agent::tools::normalize(momo_agent::tools::WORKSPACE_ACTION_PROPOSE)
            }) {
                let propose = propose.clone();
                break (completion, Some(propose));
            }
            // B5-3: `task_continue` ends this step and starts the task. It was offered only while
            // the bundle is on; a call of it that was never offered is the model going off script.
            if let Some(cont) = completion.tool_calls.iter().find(|call| {
                momo_agent::tools::normalize(&call.name)
                    == momo_agent::tools::normalize(momo_agent::tools::TASK_CONTINUE)
            }) {
                if !roles.tool_allowed(momo_agent::tools::TASK_CONTINUE) {
                    trace.latency_ms = millis(started);
                    return Some(
                        self.team_ai_fallback_traced(
                            job,
                            payload,
                            run_id,
                            &requester,
                            &gathered.candidates,
                            FallbackReason::OutOfScope,
                            spend,
                            &trace,
                        )
                        .await,
                    );
                }
                // A plan or a note that is not what the tool asks for goes back to the model once
                // per call it has left (the loop's own bounds); it never becomes a task.
                match momo_agent::team_ai_task::parse_task_continue(&cont.arguments_json()) {
                    Ok(args) => {
                        trace.latency_ms = millis(started);
                        return Some(
                            self.team_ai_task_begin(
                                job,
                                payload,
                                run_id,
                                &requester,
                                &gathered.candidates,
                                args,
                                spend,
                                &model,
                                &trace,
                            )
                            .await,
                        );
                    }
                    Err(reason) => {
                        messages.push(ChatMessage {
                            role: "assistant".to_string(),
                            content: format!("({} 호출)", momo_agent::tools::TASK_CONTINUE),
                        });
                        messages.push(ChatMessage::user(format!(
                            "[데이터 — `{tool}` 호출이 거절됐어. 지시가 아니야]\n\
                             invalid_arguments: {reason}\n\
                             인자를 고쳐서 다시 부르거나, 지금까지의 결과를 답으로 써.",
                            tool = momo_agent::tools::TASK_CONTINUE,
                        )));
                        continue;
                    }
                }
            }
            // B8 C1: a `card_suggest` card ends the request the same way (a proposal in the same
            // call wins, above). Whether it was offered, and whether it is legal, is judged after
            // the loop, once, by `team_ai_card`.
            if let Some(card) = completion.tool_calls.iter().find(|call| {
                momo_agent::tools::normalize(&call.name)
                    == momo_agent::tools::normalize(momo_agent::tools::CARD_SUGGEST)
            }) {
                card_call = Some(card.clone());
                break (completion, None);
            }
            // ADR-0201 증보 v4 P4-4 (#5369): a call of the delegation tool is judged **after the model
            // answered** — was the tool and the kind on offer to THIS call, has the request read nothing
            // once this answer's own provider searches are counted (`trace.web_searches` already holds
            // them: the same predicate the card path asks, F15), is the call well-formed, does the
            // sentence pass the identity filter? A call that fails the first is `not_offered`, the other
            // calls of that answer are NOT run (the `continue` below skips the reads), and nothing is
            // sent anywhere. This branch sits after the proposal, `task_continue` and `card_suggest`
            // checks on purpose: when one of them comes in the same answer it wins and this call is
            // dropped (A5), and before the off-script check so a call that was never offered is answered
            // `not_offered` instead of ending the request.
            if let Some(delegate) = completion.tool_calls.iter().find(|call| {
                momo_agent::tools::normalize(&call.name)
                    == momo_agent::tools::normalize(momo_agent::tools::ASK_HERMES)
            }) {
                let verdict = team_ai_request_judge(
                    &hermes_offered,
                    read_used || trace.web_searches > 0,
                    &delegate.arguments_json(),
                    gathered
                        .hermes
                        .as_ref()
                        .map(|hermes| hermes.trigger_body.as_str())
                        .unwrap_or(""),
                    &identity,
                );
                let target = door.as_ref().and_then(DoorFacts::target_member_id);
                let hermes_trace = trace.hermes.get_or_insert_with(HermesTrace::default);
                match verdict {
                    // (a door that was open has resolved its target; a call that finds none is a call to a
                    // door that is not there)
                    CallVerdict::Accepted { kind, request } if target.is_some() => {
                        // ADR-0201 증보 v4 P4-4: the call passed every check, so it **becomes the next
                        // step** — a task row, a pending marker and a resume job (`team_ai_delegation_begin`,
                        // after the loop). The request sentence is carried in memory to that one
                        // transaction; this loop writes it nowhere.
                        hermes_trace
                            .results
                            .push(team_ai_hermes::AUDIT_CODE_ACCEPTED);
                        hermes_call = target.map(|target| (kind, request, target));
                        break (completion, None);
                    }
                    CallVerdict::NotOffered | CallVerdict::Accepted { .. } => {
                        hermes_trace.results.push(DelegateCode::NotOffered.as_str());
                        messages.push(ChatMessage {
                            role: "assistant".to_string(),
                            content: format!("({} 호출)", momo_agent::tools::ASK_HERMES),
                        });
                        messages.push(ChatMessage::user(
                            ToolOutcome::Notice {
                                code: DelegateCode::NotOffered.as_str(),
                                sentence: DelegateCode::NotOffered.sentence().unwrap_or_default(),
                            }
                            .render(momo_agent::tools::ASK_HERMES),
                        ));
                        continue;
                    }
                    CallVerdict::Invalid(why) => {
                        hermes_trace
                            .results
                            .push(DelegateCode::InvalidArguments.as_str());
                        messages.push(ChatMessage {
                            role: "assistant".to_string(),
                            content: format!("({} 호출)", momo_agent::tools::ASK_HERMES),
                        });
                        messages.push(ChatMessage::user(
                            ToolOutcome::Invalid(why.sentence())
                                .render(momo_agent::tools::ASK_HERMES),
                        ));
                        continue;
                    }
                }
            }
            // Anything that is neither a read nor the proposal is the model going
            // off script.
            if completion
                .tool_calls
                .iter()
                .any(|call| !team_ai_tools::is_read_tool(&call.name))
            {
                trace.latency_ms = millis(started);
                return Some(
                    self.team_ai_fallback_traced(
                        job,
                        payload,
                        run_id,
                        &requester,
                        &gathered.candidates,
                        FallbackReason::OutOfScope,
                        spend,
                        &trace,
                    )
                    .await,
                );
            }

            // The reads, as the requester. One transaction each, nothing written.
            let mut results = Vec::with_capacity(completion.tool_calls.len());
            let mut called = Vec::with_capacity(completion.tool_calls.len());
            for tool_call in &completion.tool_calls {
                let name = momo_agent::tools::normalize(&tool_call.name);
                if trace.tools.len() >= team_ai::MAX_TOOL_CALLS {
                    results.push(
                        ToolOutcome::Invalid("read budget for this request is spent").render(&name),
                    );
                    continue;
                }
                let read =
                    if name == momo_agent::tools::normalize(team_ai_tools::TOOL_READ_ATTACHMENT) {
                        // The `files` bundle's tool (#4970). A request that was not offered it does not
                        // get it by naming it (B13-I5); the lookup re-reads the switch as well.
                        if !roles.tool_allowed(team_ai_tools::TOOL_READ_ATTACHMENT) {
                            Ok(team_ai_files::FILES_OFF)
                        } else {
                            match self
                                .team_ai_read_attachment(
                                    workspace_id,
                                    agent,
                                    requester.member_id,
                                    channel_id,
                                    run_id,
                                    &tool_call.arguments_json(),
                                    wire,
                                    !attached.is_empty(),
                                )
                                .await
                            {
                                Ok(read) => {
                                    // a picture is only ever handed back for a wire that can carry it
                                    // (`team_ai_read_attachment` says so before it reads a byte)
                                    if let Some(image) = read.image {
                                        attached.push(image);
                                    }
                                    Ok(read.outcome)
                                }
                                Err(error) => Err(error),
                            }
                        }
                    } else {
                        self.team_ai_read(
                            workspace_id,
                            agent,
                            requester.member_id,
                            channel_id,
                            &name,
                            &tool_call.arguments_json(),
                        )
                        .await
                    };
                let outcome = match read {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        return Some(
                            self.settle_retryable(
                                job,
                                &format!("team ai read tool failed: {error}"),
                                &transport.endpoint,
                            )
                            .await,
                        )
                    }
                };
                trace.tools.push(name.clone());
                trace.tool_codes.push(outcome.code());
                results.push(outcome.render(&name));
                called.push(name);
            }
            read_used = true;
            // The model's own call, in words (no structured tool turn exists on
            // every wire), then the data — as a user turn the fence calls data.
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: format!("(읽기 도구 호출: {})", called.join(", ")),
            });
            messages.push(ChatMessage::user(results.join("\n\n")));
        };
        trace.latency_ms = millis(started);
        let latency_ms = trace.latency_ms;

        // ADR-0201 증보 v4 P4 (#5370): the model called `ask_hermes` and the call passed every check. The
        // turn ends here and the delegation is the NEXT step: one transaction writes the task row (with the
        // pending marker and the sentence), the stage line, the `delegate` activity and the resume job. Hermes
        // is not called in this turn (F3: the helper's turn is 45 s, Hermes is an agent loop).
        if let Some((kind, request, target)) = hermes_call {
            trace.latency_ms = millis(started);
            let display_name = gathered
                .hermes
                .as_ref()
                .and_then(|hermes| {
                    hermes
                        .pinned
                        .iter()
                        .find(|pinned| pinned.member_id == target)
                        .map(|pinned| pinned.display_name.clone())
                })
                .unwrap_or_default();
            return Some(
                self.team_ai_delegation_begin(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    delegate::DelegationStart {
                        kind,
                        request,
                        display_name,
                    },
                    spend,
                    &model,
                    &trace,
                )
                .await,
            );
        }

        if let Some(card) = card_call {
            return Some(
                self.team_ai_card(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    &card,
                    &card_commands,
                    spend,
                    &model,
                    &trace,
                )
                .await,
            );
        }

        let Some(call) = call else {
            // A plain answer. Bounded, posted as one message.
            let text: String = completion
                .text
                .trim()
                .chars()
                .take(team_ai::ANSWER_CHARS_MAX)
                .collect();
            return Some(
                self.team_ai_finish(
                    job,
                    payload,
                    run_id,
                    Some(text),
                    json!({}),
                    spend,
                    &model,
                    Ending::Answered,
                    Some(trace),
                )
                .await,
            );
        };
        let usage = spend;

        let arguments = call.arguments_json();
        let action_id = arguments
            .get("actionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = arguments.get("args").cloned().unwrap_or_else(|| json!({}));
        let rationale: Option<String> = arguments
            .get("rationale")
            .and_then(Value::as_str)
            .map(|text| text.chars().take(280).collect());
        if let Err(refusal) =
            team_ai::validate_pure(&action_id, &args, chrono::Utc::now().timestamp_millis())
        {
            let reason = match refusal {
                ProposalRefusal::NotAllowed => FallbackReason::OutOfScope,
                _ => FallbackReason::CouldNotPropose,
            };
            return Some(
                self.team_ai_fallback_traced(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    reason,
                    usage,
                    &trace,
                )
                .await,
            );
        }

        // ADR-0201 증보 v3 B13-I5: a card of a bundle that was off when this request began was not
        // offered, so the model named an id it was not shown. Say no here, before any picture work
        // (the lookup, the Drive read, the decode, the refusal row `prepare` writes); the proposal
        // transaction below judges again with the switches as they are by then. The tokens this
        // request spent are charged by this hand-off, like every refusal that comes before the
        // transaction.
        let proposed_action: Option<&'static str> =
            momo_agent::actions::action_by_id(&action_id).map(|action| action.id);
        if !roles.action_allowed(&action_id) {
            return Some(
                self.team_ai_refused(
                    job,
                    payload,
                    run_id,
                    team_ai::ROLE_OFF_SENTENCE,
                    usage,
                    &model,
                    OUTCOME_REFUSED_ROLE_OFF,
                    &trace,
                    proposed_action,
                )
                .await,
            );
        }

        let prepared_avatar = if let Some(action) = momo_agent::actions::action_by_id(&action_id) {
            match momo_workspace_actions::action_resolve::validated_action_args(
                action,
                &args,
                chrono::Utc::now().timestamp_millis(),
            ) {
                Ok(validated) => {
                    // #4934: the source picture is read from the api when its private address is
                    // configured, from the worker's own archive otherwise.
                    let attachments = self.attachment_reader();
                    momo_workspace_actions::profile_avatar::prepare_with(
                        &self.pool,
                        &attachments,
                        workspace_id,
                        run_id,
                        agent,
                        &validated.args,
                    )
                    .await
                }
                Err(_) => Err("invalid_arguments"),
            }
        } else {
            Err("invalid_arguments")
        };
        let prepared_avatar = match prepared_avatar {
            Ok(prepared) => prepared,
            Err(_) => {
                return Some(
                    self.team_ai_fallback_traced(
                        job,
                        payload,
                        run_id,
                        &requester,
                        &gathered.candidates,
                        FallbackReason::CouldNotPropose,
                        usage,
                        &trace,
                    )
                    .await,
                )
            }
        };
        let now = chrono::Utc::now();
        let expires_at = momo_agent::default_expires_at(now, self.config.approval_ttl_seconds);
        let via = ViaAi {
            model: model.clone(),
            latency_ms,
            prompt_tokens: usage.map(|u| u.usage.prompt_tokens).unwrap_or(0),
            completion_tokens: usage.map(|u| u.usage.completion_tokens).unwrap_or(0),
            tools: trace.tools.clone(),
            model_calls: trace.model_calls,
            web_searches: trace.web_searches,
        };
        let ledger = ledger_report(usage, &model, payload);
        let fallback_model = model.clone();
        let searches = trace.web_searches;
        let proposed = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let via = via.clone();
            let action_id = action_id.clone();
            let args = args.clone();
            let rationale = rationale.clone();
            let ledger = ledger.clone();
            let fallback_model = fallback_model.clone();
            Box::pin(async move {
                let context = ProposalContext {
                    workspace_id,
                    run_id,
                    channel_id,
                    agent_member_id: agent,
                    trigger_message_id,
                    now_ms: now.timestamp_millis(),
                    expires_at,
                    via,
                };
                let outcome = team_ai::propose_with_avatar_in_tx(
                    conn,
                    &context,
                    &action_id,
                    &args,
                    rationale.as_deref(),
                    prepared_avatar.as_ref(),
                )
                .await?;
                // #5084 — a raised card is a run parked on a person (the proposal parks the run
                // before the card and either returns `ProposalOk` or errors, so `Ok` is exactly
                // "parked"): the rail is told in this same transaction, after the card.
                if let Ok(ok) = &outcome {
                    emit_awaiting_approval_agent_status(
                        conn,
                        momo_agent::AgentRunAddress {
                            workspace_id,
                            channel_id,
                            agent_member_id: agent,
                            run_id,
                        },
                        ok.approval_id,
                    )
                    .await?;
                }
                // The ledger row is written whether or not a card came of it: the
                // tokens were spent, and the daily ceiling reads this table.
                let mut resolved =
                    RunUsageReport::resolve(Some(&ledger), &fallback_model, None, None);
                resolved.source = momo_agent::UsageSource::Measured;
                record_run_usage_in_tx(conn, workspace_id, run_id, agent, channel_id, &resolved)
                    .await?;
                team_ai::record_web_searches_in_tx(conn, workspace_id, run_id, searches).await?;
                Ok(outcome)
            })
        })
        .await;
        match proposed {
            Ok(Ok(ok)) => {
                tracing::info!(
                    run_id = %run_id,
                    approval_id = %ok.approval_id,
                    run_to_card_ms = ?ok.run_to_card_ms,
                    model_ms = latency_ms,
                    model_calls = trace.model_calls,
                    "team ai proposal card raised"
                );
                self.settle_done(job.id, Some("awaiting approval")).await;
                Some(Settlement::Skipped)
            }
            // The tokens are already on the ledger (the proposal transaction wrote
            // the row), so the hand-off below charges nothing twice.
            Ok(Err(refusal)) => Some(match refusal {
                ProposalRefusal::NotAllowed => {
                    self.team_ai_fallback_traced(job, payload, run_id, &requester, &gathered.candidates, FallbackReason::OutOfScope, None, &trace).await
                }
                ProposalRefusal::InvalidArguments | ProposalRefusal::AvatarNotAllowed => {
                    self.team_ai_fallback_traced(job, payload, run_id, &requester, &gathered.candidates, FallbackReason::CouldNotPropose, None, &trace).await
                }
                ProposalRefusal::RequesterLacksRole => {
                    self.team_ai_finish(job, payload, run_id,
                        Some("이 일은 관리자만 승인할 수 있어요. 관리자에게 부탁해 볼까요?".to_string()),
                        json!({}), None, &model, Ending::Answered, Some(trace.clone())).await
                }
                ProposalRefusal::TooManyPending => {
                    self.team_ai_finish(job, payload, run_id,
                        Some("승인을 기다리는 카드가 이미 많아요. 먼저 처리해 주세요.".to_string()),
                        json!({}), None, &model, Ending::Answered, Some(trace.clone())).await
                }
                ProposalRefusal::TargetBusy => {
                    self.team_ai_finish(job, payload, run_id,
                        Some("같은 대상에 승인을 기다리는 카드가 있어요. 그 카드를 먼저 처리해 주세요.".to_string()),
                        json!({}), None, &model, Ending::Answered, Some(trace.clone())).await
                }
                // B13-I5: the bundle that owns this card was switched off while the model was
                // thinking (or the model named an id it was not offered). Say so, once.
                ProposalRefusal::RoleOff => {
                    self.team_ai_refused(job, payload, run_id, team_ai::ROLE_OFF_SENTENCE, None,
                        &model, OUTCOME_REFUSED_ROLE_OFF, &trace, proposed_action).await
                }
                // B4-3: this request read something, so this card is not one it may raise.
                ProposalRefusal::AfterRead => {
                    self.team_ai_refused(job, payload, run_id,
                        team_ai::after_read_sentence(proposed_action.unwrap_or("")),
                        None, &model, OUTCOME_REFUSED_AFTER_READ, &trace, proposed_action).await
                }
                // B4-4 구현 확정: the helper does not make an admin invite link — it says where a
                // person does. No card, no hand-off to another agent (nobody else can raise it).
                ProposalRefusal::InviteRoleNotOffered => {
                    self.team_ai_refused(job, payload, run_id, team_ai::ADMIN_INVITE_SENTENCE,
                        None, &model, OUTCOME_REFUSED_INVITE_ROLE, &trace, proposed_action).await
                }
                ProposalRefusal::NoHumanRequester | ProposalRefusal::RunNotParkable => {
                    self.team_ai_close(job, payload, run_id, "team_ai_not_proposable").await
                }
            }),
            Err(error) => Some(
                self.settle_retryable(job, &format!("team ai proposal failed: {error}"), &transport.endpoint).await,
            ),
        }
    }

    /// One read tool, as the requester (H4-2): `SET LOCAL ROLE momo_helper_read`
    /// first, the audience computed from the reply channel, then the domain
    /// function. The authenticated helper also binds the agent read floor: the
    /// requester's access and reply audience cannot widen its current DM seat.
    /// Read-only; nothing else happens in this transaction.
    async fn team_ai_read(
        &self,
        workspace_id: Uuid,
        helper: Uuid,
        requester: Uuid,
        reply_channel: Uuid,
        tool: &str,
        args: &Value,
    ) -> Result<ToolOutcome, DbError> {
        let tool = tool.to_string();
        let args = args.clone();
        momo_db::tenant::REQUEST_AGENT_MEMBER
            .scope(
                helper,
                with_tenant_tx(&self.pool, workspace_id, move |conn| {
                    Box::pin(async move {
                        team_ai_tools::enter_helper_read_role(conn).await?;
                        let scope = team_ai_tools::load_scope_in_tx(
                            conn,
                            workspace_id,
                            helper,
                            requester,
                            reply_channel,
                        )
                        .await?;
                        team_ai_tools::execute_read_tool_in_tx(conn, &scope, &tool, &args).await
                    })
                }),
            )
            .await
    }

    /// A reply that says no to the card the model proposed: the run succeeds with the sentence
    /// posted, and the audit row's `outcome` is `outcome` (a reason code) with the registry id of
    /// the refused card — never the text. `usage` is what is still to be charged: `None` when the
    /// proposal transaction already wrote the ledger row.
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_refused(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        sentence: &str,
        usage: Option<Spend>,
        model: &str,
        outcome: &'static str,
        trace: &TurnTrace,
        refused_action: Option<&'static str>,
    ) -> Settlement {
        let mut trace = trace.clone();
        trace.refused_action = refused_action;
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(sentence.to_string()),
            json!({}),
            usage,
            model,
            Ending::Refused(outcome),
            Some(trace),
        )
        .await
    }

    /// The helper's `card_suggest` (ADR-0201 증보 v3 B8 C1, #4972): judge what the model named
    /// against what this request **offered**, then post the card as the turn's one message.
    ///
    /// * a command of a bundle that was off when the request began was not on the tool's enum, so
    ///   the model named one it was not shown: the same refusal sentence as a card of an off
    ///   bundle, before anything else;
    /// * anything else illegal (a command the helper never gives, an argument the normaliser
    ///   refuses — the prompt included) is the model failing to build a card: the hand-off line;
    /// * a legal card goes through [`Self::team_ai_finish`], whose transaction reads the switches
    ///   once more ([`Ending::Suggested`]) and posts `command_suggest_props` — five server-built
    ///   keys, `for_member_id` the run's requester — with the model's one sentence as the body.
    ///
    /// No approval row and no `action.*` audit row are written: a suggestion is a message. The
    /// turn's own `team_ai.turn` row carries the command id, never the prompt (H9-I10).
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_card(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        candidates: &[(Uuid, String, String)],
        call: &ProviderToolCall,
        offered: &[&'static str],
        usage: Option<Spend>,
        model: &str,
        trace: &TurnTrace,
    ) -> Settlement {
        use momo_agent::card_suggest::{
            command_suggest_props, validate_suggestion_among, TEAM_AI_SUGGESTABLE_COMMAND_IDS,
        };
        let arguments = call.arguments_json();
        // The helper-list command the model named, as the registry spells it (`None` for any
        // other id or a missing one — never the model's own string).
        let named: Option<&'static str> = arguments
            .get("commandId")
            .and_then(Value::as_str)
            .and_then(|id| {
                TEAM_AI_SUGGESTABLE_COMMAND_IDS
                    .iter()
                    .copied()
                    .find(|command| *command == id)
            });
        if let Some(command) = named.filter(|command| !offered.contains(command)) {
            return self
                .team_ai_refused(
                    job,
                    payload,
                    run_id,
                    team_ai::ROLE_OFF_SENTENCE,
                    usage,
                    model,
                    OUTCOME_REFUSED_ROLE_OFF,
                    trace,
                    Some(command),
                )
                .await;
        }
        let suggestion = match validate_suggestion_among(&arguments, &[], Some(offered)) {
            Ok(suggestion) => suggestion,
            Err(_) => {
                let reason = if named.is_some() {
                    FallbackReason::CouldNotPropose
                } else {
                    FallbackReason::OutOfScope
                };
                return self
                    .team_ai_fallback_traced(
                        job, payload, run_id, requester, candidates, reason, usage, trace,
                    )
                    .await;
            }
        };
        let mut trace = trace.clone();
        trace.suggested_command = Some(suggestion.command_id);
        let props = command_suggest_props(&suggestion, requester.member_id);
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(suggestion.body.clone()),
            props,
            usage,
            model,
            Ending::Suggested(suggestion.command_id),
            Some(trace),
        )
        .await
    }

    /// End the run without posting anything (switch off, no human asked).
    async fn team_ai_close(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        code: &'static str,
    ) -> Settlement {
        self.team_ai_finish(
            job,
            payload,
            run_id,
            None,
            json!({}),
            None,
            "",
            Ending::Closed(code),
            None,
        )
        .await
    }

    /// Say why the team AI is handing a request over, with the 「맡기기」 candidates.
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_fallback(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        candidates: &[(Uuid, String, String)],
        reason: FallbackReason,
        usage: Option<Spend>,
        model: &str,
    ) -> Settlement {
        let props = team_ai::fallback_props(
            reason,
            payload.agent_member_id,
            requester.member_id,
            payload.trigger_message_id,
            candidates,
        );
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(reason.sentence().to_string()),
            props,
            usage,
            model,
            Ending::Closed(reason.as_str()),
            None,
        )
        .await
    }

    /// A usage limit was hit before the model was asked (B9): one honest sentence that says whose
    /// limit it was, the ordinary 「맡기기」 buttons (D5), and no model call. The reason stays
    /// `over_budget` — a code every client knows — and `props.limit` adds the source and window.
    async fn team_ai_limit_reached(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        candidates: &[(Uuid, String, String)],
        hit: LimitHit,
    ) -> Settlement {
        let props = team_ai_limits::limit_fallback_props(
            hit,
            payload.agent_member_id,
            requester.member_id,
            payload.trigger_message_id,
            candidates,
        );
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(hit.sentence().to_string()),
            props,
            None,
            "",
            Ending::Closed(FallbackReason::OverBudget.as_str()),
            None,
        )
        .await
    }

    /// [`Self::team_ai_fallback`] after one or more model calls: the trace (tool
    /// names, counts) goes to the audit row and the model label to the line.
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_fallback_traced(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        candidates: &[(Uuid, String, String)],
        reason: FallbackReason,
        usage: Option<Spend>,
        trace: &TurnTrace,
    ) -> Settlement {
        let props = team_ai::fallback_props(
            reason,
            payload.agent_member_id,
            requester.member_id,
            payload.trigger_message_id,
            candidates,
        );
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(reason.sentence().to_string()),
            props,
            usage,
            &trace.model.clone(),
            Ending::Closed(reason.as_str()),
            Some(trace.clone()),
        )
        .await
    }

    /// ADR-0201 증보 v4 P2 (#5369): what the delegation door judges, gathered once for this request. The
    /// database facts came in the first read transaction ([`HermesGather`]); the two that are not the
    /// database's are the config's (`G4`'s declarations, the bounds) and the pin's (G5: does the target's
    /// `operator_env` link resolve — the same function a mention of the agent resolves it by).
    ///
    /// The delegation counters (today, last ten minutes, running) are read from the marker on the task
    /// rows (migration 177) in the request's first read transaction, so G6 judges the real numbers at
    /// advertisement; the authoritative judgement is the `called` commit under the workspace lock (P7).
    /// `delegated` (G10) is `false`: a request delegates once, and the call that does ends this turn. This
    /// function runs for a request's **first turn** only — a task step is routed away before it
    /// (`decide_step`) and its loop offers no delegation tool (G9, structurally).
    async fn hermes_door_facts(
        &self,
        workspace_id: Uuid,
        state: &TeamAiWorkspace,
        caps: &team_ai_limits::OperatorCaps,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        gather: &HermesGather,
        web: WebSearch,
    ) -> DoorFacts {
        let target = team_ai_hermes::resolve_target(&gather.pinned, requester.member_id);
        // G5 is worth a read only when there is a target and the declarations hold.
        let pin_resolves = match &target {
            TargetResolution::One(one) if self.config.hermes.g4().is_ok() => matches!(
                self.resolve_agent_pin(workspace_id, one.member_id).await,
                crate::PinOutcome::Applied(_, _, momo_settings::PinKind::OperatorEnv)
            ),
            _ => false,
        };
        let direct_mention = match &target {
            TargetResolution::One(one) => {
                team_ai_hermes::mentions_target(&gather.trigger_body, one)
            }
            _ => false,
        };
        DoorFacts {
            roles: state.roles,
            requester: RequesterFacts {
                human: true,
                guest: gather.guest,
            },
            target,
            declarations: self.config.hermes.clone(),
            pin_resolves,
            bounds: DelegationBounds {
                day_cap: team_ai_limits::delegation_cap(&state.limits, caps),
                requester_window_max: team_ai_hermes::REQUESTER_WINDOW_MAX,
                concurrent_max: team_ai_hermes::CONCURRENT_MAX,
                tasks_workspace_max: self.config.team_ai_task.max_per_workspace,
                tasks_requester_max: self.config.team_ai_task.max_per_requester,
            },
            usage: DelegationUsage {
                today: gather.delegations.today,
                requester_recent: gather.delegations.requester_recent,
                in_flight: gather.delegations.in_flight,
                tasks_workspace: gather.tasks_workspace,
                tasks_requester: gather.tasks_requester,
            },
            direct_mention,
            task_step: false,
            delegated: false,
            web,
            image_path_ready: team_ai_hermes::ATTACHMENT_WRITE_PATH_READY,
        }
    }

    /// One transaction: the message (if any), the run's end, the ledger row (if
    /// tokens were spent), the rail's terminal frame. **Routes nothing** — what
    /// the team AI says does not start another agent.
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_finish(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        body: Option<String>,
        props: Value,
        usage: Option<Spend>,
        model: &str,
        ending: Ending,
        trace: Option<TurnTrace>,
    ) -> Settlement {
        let workspace_id = job.workspace_id;
        let agent = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let model = model.to_string();
        let ledger = usage.map(|usage| ledger_report(Some(usage), &model, payload));
        // B13-I5 for a suggestion: the command the card names, so the transaction below can judge
        // it against the switches as they are when it commits.
        let suggested_command: Option<&'static str> = match &ending {
            Ending::Suggested(command) => Some(*command),
            _ => None,
        };
        let (succeeded, error_code, outcome) = match ending {
            Ending::Answered => (true, None, "answered"),
            Ending::Refused(reason) => (true, None, reason),
            Ending::Suggested(_) => (true, None, OUTCOME_SUGGESTED_CARD),
            Ending::Closed(code) => (false, Some(code), code),
        };
        // H2-8 / H9-I9: whoever answers to `@claude`, the line says which model on
        // which wire actually spoke (a plain id — no key, no URL).
        let label = trace
            .as_ref()
            .filter(|trace| !trace.model.is_empty())
            .map(|trace| json!({"model": trace.model, "wire": trace.wire}));
        let audit_detail = trace
            .as_ref()
            .map(|trace| trace.audit_detail(usage, outcome));
        // What the audit row says instead when the card is refused in the transaction.
        let refused_audit_detail = suggested_command.and_then(|command| {
            trace.as_ref().map(|trace| {
                let mut trace = trace.clone();
                trace.suggested_command = None;
                trace.refused_action = Some(command);
                trace.audit_detail(usage, OUTCOME_REFUSED_ROLE_OFF)
            })
        });
        let searches = trace.as_ref().map(|trace| trace.web_searches).unwrap_or(0);
        // ADR-0201 증보 v4 P11 (#5370): how the delegation ended — one `team_ai.delegate` row (kind, closed
        // code, ms, the target agent's id; never the request sentence, a result or a picture), the marker's
        // move and the Hermes ledger row, all in the finishing transaction.
        let delegate_settle: Option<delegate::HermesSettlement> = trace
            .as_ref()
            .and_then(|trace| trace.hermes.as_ref())
            .and_then(|hermes| hermes.settle.clone());
        // ADR-0201 증보 v4 P6 (#5372): a delegation that wrote a picture posts its answer **with** the run's
        // picture, in this one transaction; every other ending posts the plain answer it always did.
        let picture_expected = delegate_settle
            .as_ref()
            .is_some_and(|settle| settle.picture_bytes > 0);
        // Workspace data or web text reached the model in this request: the answer
        // must not make the server fetch a URL the model was steered into writing.
        let withhold_previews = trace.as_ref().is_some_and(|trace| {
            !trace.tools.is_empty() || trace.web_searches > 0 || trace.task_step.is_some()
        });
        // B5 (#4968): the step this request is, and what it did — a task's last step reports its
        // reads like every step before it (the ledger rows are per step, B5-7).
        let task_progress = trace
            .as_ref()
            .and_then(|trace| trace.task_step.map(|step| (step, task::step_counts(trace))));
        // B5 (#4967): the code a task row is closed with — the run's own ending, by its word.
        let task_end_reason: &'static str = match &ending {
            // A `card_suggest` card is a first-turn ending (a step is offered no card tool), and it
            // is a successful one: were a row ever open here, it would end done like an answer.
            Ending::Answered | Ending::Suggested(_) => momo_agent::team_ai_task::END_DONE,
            Ending::Refused(reason) => reason,
            Ending::Closed(code) => code,
        };
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let label = label.clone();
            let mut audit_detail = audit_detail.clone();
            let refused_audit_detail = refused_audit_detail.clone();
            let body = body.clone();
            let props = props.clone();
            let ledger = ledger.clone();
            let model = model.clone();
            let delegate_settle = delegate_settle.clone();
            Box::pin(async move {
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    // A run that cannot be called any more (its helper left the room or was
                    // deactivated) keeps no task row: the task ends with it (#5029). A run without
                    // a task has no row, and this is then a no-op.
                    momo_agent::team_ai_task::end_in_tx(
                        conn,
                        workspace_id,
                        run_id,
                        momo_agent::team_ai_task::END_AGENT_GONE,
                    )
                    .await?;
                    return Ok(false);
                };
                // B5-2: a run with a task row is in task mode — its ledger rows are per step and
                // its row ends with it.
                let task_row =
                    momo_agent::team_ai_task::load_in_tx(conn, workspace_id, run_id).await?;
                let in_task = task_row.is_some();
                // A delegation that was called and that nobody has settled yet (a requester who left, a
                // helper that left, a path that never met Hermes's answer): `end_in_tx` below writes its
                // estimated ledger row; this is what the audit row of that ending names.
                let called_unsettled = task_row
                    .as_ref()
                    .and_then(|row| row.delegation.as_ref())
                    .filter(|mark| mark.state == momo_agent::team_ai_task::DelegationState::Called)
                    .cloned();
                if snapshot.status == RunStatus::Cancelled {
                    if in_task {
                        // B5-8: a stop that lands while a step is finishing still leaves what the
                        // step spent on the ledger, and the task ends (idempotent with the route's).
                        if let Some(report) = ledger {
                            let mut resolved =
                                RunUsageReport::resolve(Some(&report), &model, None, None);
                            resolved.source = momo_agent::UsageSource::Measured;
                            momo_agent::team_ai_task::record_step_usage_in_tx(
                                conn,
                                workspace_id,
                                run_id,
                                agent,
                                channel_id,
                                &resolved,
                                searches,
                            )
                            .await?;
                        }
                        momo_agent::team_ai_task::end_in_tx(
                            conn,
                            workspace_id,
                            run_id,
                            momo_agent::team_ai_task::END_CANCELLED,
                        )
                        .await?;
                    }
                    return Ok(false);
                }
                // A suggestion is judged against the switches **as they are now**: the bundle that
                // owns the command was on when the request began and may have been switched off
                // while the model thought. Then the person gets the refusal sentence, not the
                // card, and the audit row says `refused_role_off` with the command's id.
                let (body, props) = match suggested_command {
                    Some(command) => {
                        let roles = team_ai::read_roles_in_tx(conn, workspace_id).await?;
                        if roles.command_allowed(command) {
                            (body, props)
                        } else {
                            audit_detail = refused_audit_detail;
                            (Some(team_ai::ROLE_OFF_SENTENCE.to_string()), json!({}))
                        }
                    }
                    None => (body, props),
                };
                let mut message_id: Option<Uuid> = None;
                // `false` only when the run's picture was written and binding it was refused (the answer then
                // went without it, with the fixed sentence): the delegation's audit row says so.
                let mut picture_posted = true;
                if let Some(text) = body {
                    let mut props = if props.is_object() { props } else { json!({}) };
                    if let Some(object) = props.as_object_mut() {
                        object.insert("run_id".into(), json!(run_id));
                        object.entry("source").or_insert_with(|| json!("team_ai"));
                        if let Some(label) = label {
                            object.insert("team_ai_model".into(), label);
                        }
                    }
                    // #4622 (ADR-0148 증보 2026-10-27): the same place and the same spine
                    // as every other final answer — inside the thread the request was
                    // made in (the rollup moves with it), the main flow otherwise.
                    let answer = NewMessage {
                        channel_id,
                        author_member_id: agent,
                        message_type: MessageType::Text,
                        body: Some(text),
                        props,
                        root_id: snapshot.trigger_root_id,
                        reply_to_id: snapshot.trigger_message_id,
                        client_msg_id: Some(run_id),
                        run_id: Some(run_id),
                        hlc_ts: None,
                        hlc_count: None,
                    };
                    let sent = if picture_expected {
                        // the pictures are not named here: they are the ones this run's write recorded
                        let posted = crate::agent_picture::send_answer_with_run_pictures_in_tx(
                            conn,
                            workspace_id,
                            answer,
                        )
                        .await?;
                        picture_posted = posted.pictures_bound;
                        posted.sent
                    } else {
                        send_thread_notice_in_tx(conn, workspace_id, answer).await?
                    };
                    message_id = Some(sent.message.id);
                    if withhold_previews {
                        team_ai::withhold_link_previews_in_tx(
                            conn,
                            workspace_id,
                            sent.message.id,
                            agent,
                        )
                        .await?;
                    }
                }
                let output = json!({
                    "schema": "momo.agent_run.output.v0",
                    "source": "team_ai.turn.v0",
                    "message_id": message_id,
                });
                let error =
                    error_code.map(|code| json!({"code": code, "reason": "team ai hand-off"}));
                finish_run_in_tx(conn, run_id, succeeded, &output, error.as_ref()).await?;
                emit_terminal_agent_status(
                    conn,
                    workspace_id,
                    snapshot.channel_id,
                    snapshot.agent_member_id,
                    run_id,
                    if succeeded {
                        RunStatus::Succeeded
                    } else {
                        RunStatus::Failed
                    },
                )
                .await?;
                if let Some(report) = ledger {
                    let mut resolved = RunUsageReport::resolve(Some(&report), &model, None, None);
                    resolved.source = momo_agent::UsageSource::Measured;
                    if in_task {
                        // One row per step: the run-level writer keeps one row per run, which the
                        // task's earlier steps have already taken.
                        momo_agent::team_ai_task::record_step_usage_in_tx(
                            conn,
                            workspace_id,
                            run_id,
                            agent,
                            channel_id,
                            &resolved,
                            searches,
                        )
                        .await?;
                    } else {
                        record_run_usage_in_tx(
                            conn,
                            workspace_id,
                            run_id,
                            agent,
                            channel_id,
                            &resolved,
                        )
                        .await?;
                        team_ai::record_web_searches_in_tx(conn, workspace_id, run_id, searches)
                            .await?;
                    }
                }
                // ADR-0201 증보 v4 P4-8 (#5370): the delegation is settled BEFORE the row ends, in the same
                // transaction as the message and the run's end — the marker's move is the compare-and-swap that
                // makes the Hermes ledger row exactly one (a cancel that ended the row first has already
                // settled it, and this finds nothing to move).
                if in_task {
                    if let Some(settle) = &delegate_settle {
                        if let Some(to) = settle.to {
                            let usage = momo_agent::team_ai_task::HermesUsageRow {
                                model: &settle.model,
                                prompt_tokens: settle.prompt_tokens,
                                completion_tokens: settle.completion_tokens,
                                was_estimated: settle.estimated,
                            };
                            let moved = momo_agent::team_ai_task::settle_delegation_in_tx(
                                conn,
                                workspace_id,
                                run_id,
                                to,
                                &usage,
                            )
                            .await?;
                            if moved {
                                delegate::write_delegate_progress(
                                    conn,
                                    workspace_id,
                                    run_id,
                                    agent,
                                    settle,
                                    to,
                                )
                                .await?;
                            }
                        }
                    }
                }
                if in_task {
                    // The step that ends the task reports its activities too. The visible plan is
                    // left as the previous step wrote it: the ledger records what was said, and a
                    // reader does not draw a finished run's plan as in progress (ADR-0200 증보 7 7-7).
                    if let Some((step, counts)) = task_progress {
                        task::record_step_progress(
                            conn,
                            workspace_id,
                            run_id,
                            agent,
                            step,
                            counts,
                            None,
                        )
                        .await?;
                    }
                    // B13-I7: the task ends with the run, and its plan and note go with it.
                    momo_agent::team_ai_task::end_in_tx(
                        conn,
                        workspace_id,
                        run_id,
                        task_end_reason,
                    )
                    .await?;
                }
                // H9-I10: which tools, how many calls and searches, tokens, ms.
                // Never the prompt, a tool result or the answer.
                if let Some(detail) = audit_detail {
                    audit::write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "team_ai.turn")
                            .by(agent)
                            .run(run_id)
                            .with_schema("momo.team_ai_turn.v1", detail),
                    )
                    .await?;
                }
                if let Some(settle) = &delegate_settle {
                    // the picture was written and could not be bound: the audit row says so (`picture_failed`),
                    // with the bytes that were stored — the person was told by the fixed sentence
                    let code = if picture_posted {
                        settle.code
                    } else {
                        DelegateCode::PictureFailed.as_str()
                    };
                    delegate::write_delegate_audit(
                        conn,
                        workspace_id,
                        run_id,
                        agent,
                        settle.kind,
                        settle.target,
                        code,
                        settle.ms,
                        settle.picture_bytes,
                    )
                    .await?;
                } else if let Some(mark) = &called_unsettled {
                    // The row ended by a path that never met Hermes's answer (the person left, the helper
                    // left, a stop landed with the step): the ledger row is the store's estimate, and the
                    // audit says how it ended in the closed words.
                    if let Some(target) = mark.target {
                        let code = match task_end_reason {
                            momo_agent::team_ai_task::END_REQUESTER_GONE
                            | momo_agent::team_ai_task::END_AGENT_GONE
                            | momo_agent::team_ai_task::END_CANCELLED => DelegateCode::Cancelled,
                            _ => DelegateCode::Failed,
                        };
                        delegate::write_delegate_audit(
                            conn,
                            workspace_id,
                            run_id,
                            agent,
                            delegate::kind_word(&mark.kind),
                            target,
                            code.as_str(),
                            0,
                            0,
                        )
                        .await?;
                    }
                }
                Ok(true)
            })
        })
        .await;
        match result {
            Ok(_) => {
                self.settle_done(job.id, error_code).await;
                Settlement::Answered {
                    delegated: 0,
                    blocked: 0,
                }
            }
            Err(error) => {
                self.settle_retryable(
                    job,
                    &format!("team ai finish failed: {error}"),
                    &crate::personal::neutral_endpoint(),
                )
                .await
            }
        }
    }
}

/// Tokens a team-AI turn is charged for the daily ceiling.
#[derive(Debug, Clone, Copy)]
struct Spend {
    usage: ChatUsage,
    /// `true` when the provider reported nothing and this is our estimate.
    estimated: bool,
}

impl Spend {
    /// The request's running total across its model calls (one ledger row per
    /// run). An estimate anywhere makes the sum an estimate.
    fn add(total: Option<Spend>, next: Spend) -> Option<Spend> {
        Some(match total {
            None => next,
            Some(total) => Spend {
                usage: ChatUsage {
                    prompt_tokens: total
                        .usage
                        .prompt_tokens
                        .saturating_add(next.usage.prompt_tokens),
                    completion_tokens: total
                        .usage
                        .completion_tokens
                        .saturating_add(next.usage.completion_tokens),
                    cached_tokens: total
                        .usage
                        .cached_tokens
                        .saturating_add(next.usage.cached_tokens),
                    reasoning_tokens: total
                        .usage
                        .reasoning_tokens
                        .saturating_add(next.usage.reasoning_tokens),
                },
                estimated: total.estimated || next.estimated,
            },
        })
    }

    /// What the provider reported, or — when it reported nothing (timeout, error,
    /// no `usage` object) — a conservative estimate: ~3 characters per prompt
    /// token plus the full output allowance. Never zero, so the ceiling cannot be
    /// walked past by a provider that omits usage.
    fn of(reported: Option<ChatUsage>, prompt_chars: usize) -> Spend {
        match reported {
            Some(usage) => Spend {
                usage,
                estimated: false,
            },
            None => Spend {
                usage: ChatUsage {
                    prompt_tokens: i32::try_from(prompt_chars / 3 + 1).unwrap_or(i32::MAX),
                    completion_tokens: momo_workspace_actions::team_ai::MAX_OUTPUT_TOKENS,
                    cached_tokens: 0,
                    reasoning_tokens: 0,
                },
                estimated: true,
            },
        }
    }
}

fn ledger_report(spend: Option<Spend>, model: &str, payload: &AgentJobPayload) -> RunUsageReport {
    RunUsageReport {
        model: Some(model.to_string()),
        effort: payload.effort.clone(),
        prompt_tokens: spend.map(|s| s.usage.prompt_tokens),
        completion_tokens: spend.map(|s| s.usage.completion_tokens),
        cached_tokens: spend.map(|s| s.usage.cached_tokens),
        reasoning_tokens: spend.map(|s| s.usage.reasoning_tokens),
        cost_micro_usd: None,
        was_estimated: Some(spend.map(|s| s.estimated).unwrap_or(true)),
    }
}

/// The trigger's own text, from the database (not from the job payload, which
/// carries a window of other people's messages).
async fn sqlx_body(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    files_on: bool,
) -> Result<String, DbError> {
    let body: Option<String> = momo_db::sqlx::query_scalar(
        "SELECT body FROM message WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(message_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    let images =
        momo_messaging::image_attachments_for_messages_in_tx(conn, workspace_id, &[message_id])
            .await?;
    let ids = images
        .into_iter()
        .filter_map(|(_, id, _, _, size)| {
            (size <= momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT as i64).then_some(id)
        })
        .take(20)
        .collect::<Vec<_>>();
    // #4970: the readable files of the message (ids, types, sizes — never a name) while `files` is on.
    let listed = if files_on {
        team_ai_files::attachment_list_block(
            &team_ai_files::readable_attachments_of_message_in_tx(conn, workspace_id, message_id)
                .await?,
        )
    } else {
        String::new()
    };
    Ok(trigger_turn_with_attachments(
        &body.unwrap_or_default(),
        &ids,
        &listed,
    ))
}

// Reserve room for this trigger's server-owned image ids. The caller bounds the
// final user turn again; appending after truncation would silently lose the ids.
#[cfg(test)]
fn trigger_turn_with_images(body: &str, ids: &[Uuid]) -> String {
    trigger_turn_with_attachments(body, ids, "")
}

/// The least of the final turn that stays the person's own words, whatever is listed after them.
const MIN_REQUEST_CHARS: usize = 600;

/// The whole lines of `block` that fit in `room` characters (an empty string when not even one entry
/// does: a header with nothing under it names no id).
fn whole_lines_within(block: &str, room: usize) -> String {
    if block.chars().count() <= room {
        return block.to_string();
    }
    let mut kept = String::new();
    for line in block.split_inclusive('\n') {
        if kept.chars().count() + line.chars().count() > room {
            break;
        }
        kept.push_str(line);
    }
    if kept.matches(" · ").count() == 0 {
        return String::new();
    }
    kept
}

/// [`trigger_turn_with_images`] plus the readable-files block (#4970), which is server-owned too. The
/// suffix is reserved **first**, so a long request is cut before an id is — but the files block yields
/// to a floor of [`MIN_REQUEST_CHARS`] for the person's own words (a message with twenty pictures and a
/// few documents must not squeeze its request down to a few characters): whole entries only.
fn trigger_turn_with_attachments(body: &str, ids: &[Uuid], files_block: &str) -> String {
    let mut suffix = String::new();
    if !ids.is_empty() {
        suffix.push_str("\n[데이터: 이 메시지의 이미지 attachmentId]\n");
        for id in ids.iter().take(20) {
            suffix.push_str(&format!("{id}\n"));
        }
    }
    let room = team_ai::MAX_TRIGGER_CHARS
        .saturating_sub(MIN_REQUEST_CHARS)
        .saturating_sub(suffix.chars().count());
    suffix.push_str(&whole_lines_within(files_block, room));
    let body_budget = team_ai::MAX_TRIGGER_CHARS.saturating_sub(suffix.chars().count());
    let mut turn: String = body.chars().take(body_budget).collect();
    turn.push_str(&suffix);
    turn
}

/// Did the provider refuse a call **that carried a picture** because of the picture? The wire can carry one
/// (`wire_sees_images`), but the model behind a compatible gateway may not read it, and then the provider
/// answers the image block itself with a 4xx. Only the statuses that mean 「this request, as written, is
/// not acceptable」 count — 400, 413, 415, 422: the same request without the picture had just been accepted
/// (it is the call after the read that failed), so the picture is the difference. A 401/403 (the key),
/// 404 (the model), 408 or 429 (time, rate) or any 5xx says nothing about pictures and stays what it was.
fn image_was_refused<E>(
    attempt: &Result<Result<crate::provider::ChatCompletion, ProviderError>, E>,
) -> bool {
    matches!(
        attempt,
        Ok(Err(ProviderError::HttpStatus(400 | 413 | 415 | 422, _)))
    )
}

fn millis(since: Instant) -> i64 {
    i64::try_from(since.elapsed().as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod profile_tests_4791 {
    use super::*;
    #[test]
    fn a_long_profile_request_keeps_its_image_ids_inside_the_final_turn_budget() {
        let ids = (1..=20).map(Uuid::from_u128).collect::<Vec<_>>();
        let turn = trigger_turn_with_images(&"가".repeat(2000), &ids);
        let final_turn = team_ai::user_turn(&turn);
        assert_eq!(final_turn.chars().count(), team_ai::MAX_TRIGGER_CHARS);
        for id in ids {
            assert!(final_turn.contains(&id.to_string()));
        }
        assert_eq!(trigger_turn_with_images("짧은 부탁", &[]), "짧은 부탁");
    }

    /// #4970: the readable-files block is reserved **before** the request's own text is cut, like the
    /// image ids, so a long request loses its tail and never an id; and a message with no files adds
    /// nothing.
    #[test]
    fn a_long_request_keeps_its_file_list_inside_the_final_turn_budget() {
        let files: Vec<(Uuid, String, i64)> = (1..=8)
            .map(|i| (Uuid::from_u128(i), "application/pdf".to_string(), 123_456))
            .collect();
        let block = momo_workspace_actions::team_ai_attachments::attachment_list_block(&files);
        let turn = trigger_turn_with_attachments(&"가".repeat(3000), &[], &block);
        let final_turn = team_ai::user_turn(&turn);
        assert_eq!(final_turn.chars().count(), team_ai::MAX_TRIGGER_CHARS);
        for (id, _, _) in &files {
            assert!(final_turn.contains(&id.to_string()), "{id} was cut");
        }
        assert!(final_turn.contains("read_attachment"));
        // the person's own words still get most of the turn
        assert!(
            final_turn.chars().filter(|c| *c == '가').count() > 700,
            "the request was squeezed out"
        );
        assert_eq!(
            trigger_turn_with_attachments("짧은 부탁", &[], ""),
            "짧은 부탁"
        );
    }

    /// #4970: twenty pictures (the image-id block) and eight documents (the files block) in one message
    /// still leave the person's request its floor; the pictures' ids are never cut, and the files block
    /// keeps whole entries only.
    #[test]
    fn many_attachments_never_squeeze_the_request_below_its_floor() {
        let ids: Vec<Uuid> = (1..=20).map(Uuid::from_u128).collect();
        let files: Vec<(Uuid, String, i64)> = (101..=108)
            .map(|i| (Uuid::from_u128(i), "application/pdf".to_string(), 123_456))
            .collect();
        let block = momo_workspace_actions::team_ai_attachments::attachment_list_block(&files);
        let turn = trigger_turn_with_attachments(&"가".repeat(3000), &ids, &block);
        let final_turn = team_ai::user_turn(&turn);
        assert_eq!(final_turn.chars().count(), team_ai::MAX_TRIGGER_CHARS);
        assert!(
            final_turn.chars().filter(|c| *c == '가').count() >= MIN_REQUEST_CHARS,
            "the request kept less than its floor"
        );
        for id in &ids {
            assert!(
                final_turn.contains(&id.to_string()),
                "picture id {id} was cut"
            );
        }
        // some entries fit, and each one that is there is whole
        let listed = final_turn.matches("application/pdf · 123456바이트").count();
        assert!(listed >= 1 && listed < files.len(), "{listed} entries");
        for line in final_turn.lines().filter(|l| l.contains(" · ")) {
            assert!(line.ends_with("바이트"), "a half-listed entry: {line}");
        }
        // room for nothing is no block, not a header over nothing
        assert_eq!(whole_lines_within(&block, 10), "");
        assert_eq!(whole_lines_within(&block, 10_000), block);
    }

    /// #4970 review L4: only a 4xx that says 「this request, as written, is not acceptable」 is the
    /// picture's doing; the key, the model, time, rate and the provider's own faults are not.
    #[test]
    fn only_a_refusal_of_the_request_itself_counts_as_the_model_not_reading_pictures() {
        use crate::provider::ChatCompletion;
        type Attempt = Result<Result<ChatCompletion, ProviderError>, ()>;
        let refused = |status: u16| -> Attempt {
            Ok(Err(ProviderError::HttpStatus(
                status,
                "no images".to_string(),
            )))
        };
        for status in [400, 413, 415, 422] {
            assert!(image_was_refused(&refused(status)), "{status}");
        }
        for status in [401, 403, 404, 408, 429, 500, 502, 503] {
            assert!(!image_was_refused(&refused(status)), "{status}");
        }
        let unreachable: Attempt = Ok(Err(ProviderError::Unreachable("down".into())));
        assert!(!image_was_refused(&unreachable));
        let timed_out: Attempt = Err(());
        assert!(!image_was_refused(&timed_out));
        let answered: Attempt = Ok(Ok(ChatCompletion {
            text: "ok".into(),
            usage: None,
            tool_calls: Vec::new(),
            web_search_requests: 0,
        }));
        assert!(!image_was_refused(&answered));
    }
}
