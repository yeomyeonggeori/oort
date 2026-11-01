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
use momo_workspace_actions::team_ai_limits::{self, LimitHit, Usage};
use momo_workspace_actions::team_ai_tools::{self, ToolOutcome};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::payload::AgentJobPayload;
use crate::provider::{
    ChatMessage, ChatRequest, ChatUsage, ModelImage, ProviderToolCall, ProviderWire,
};
use crate::{emit_terminal_agent_status, AgentWorker, ResolvedTransport, Settlement};

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
    /// The `card_suggest` command id of the card this turn ended with (`work.request.open`): the
    /// registry's `&'static str`, so a count of suggestions needs no text. **Never the prompt**
    /// the card carries, and never the card's label or body (H9-I10).
    suggested_command: Option<&'static str>,
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
        if let Some(command) = self.suggested_command {
            detail["suggested_command"] = json!(command);
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

/// `team_ai.turn`'s `outcome` for a card the helper refused to raise (B13-I5, B4-3): a reason
/// code and nothing else, so refusals can be counted.
const OUTCOME_REFUSED_ROLE_OFF: &str = "refused_role_off";
const OUTCOME_REFUSED_AFTER_READ: &str = "refused_after_read";
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
                let files_on = state.roles.is_on(momo_agent::team_ai_roles::FILES);
                let trigger_text: String = match trigger_message_id {
                    Some(id) => sqlx_body(conn, workspace_id, id, files_on).await?,
                    None => String::new(),
                };
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
                        team_ai::delegation_candidates_in_tx(conn, workspace_id, agent, channel_id)
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
        let web = if !gathered.state.web_search {
            WebSearch::Off
        } else if !wire_searches(wire) {
            WebSearch::NotSupported
        } else if team_ai_limits::search_cap(&gathered.state.limits, &caps)
            .is_some_and(|cap| gathered.searches_today >= cap)
        {
            WebSearch::DailyCapReached
        } else {
            WebSearch::Available
        };
        let mut trace = TurnTrace {
            model: model.clone(),
            wire: wire.as_str(),
            ..TurnTrace::default()
        };
        // ADR-0201 증보 v3 B3: the workspace's role bundles, as this request read them. What the
        // model is offered (the tool's `actionId` enum, the tool list, the prompt) is built from
        // them; the proposal transaction and the decision read them again.
        //
        // The system prompt is built ONCE, before anything is read, and is the same on every call
        // of the request (`a10_text_inside_a_read_is_never_an_instruction` pins that: what was read
        // never touches it). What changes after a read is the tool's enum, below — and the prompt
        // already says the sensitive card leaves it.
        let roles = gathered.state.roles;
        // B8 C1: the `card_suggest` commands this request is offered (`code` on = the work-request
        // card). The tool, the prompt and the check on what the model names all read this one list.
        let card_commands = roles.advertised_command_ids();
        let mut messages = vec![
            ChatMessage::system(team_ai::system_prompt_for(
                &gathered.roster,
                web,
                &roles.advertised_action_ids(false),
                &card_commands,
                roles.is_on(momo_agent::team_ai_roles::FILES),
            )),
            ChatMessage::user(team_ai::user_turn(&gathered.trigger_text)),
        ];
        let mut spend: Option<Spend> = None;
        let mut read_used = false;
        // #4970: the one picture this request may hold. It rides **every** model call after the read
        // (the call re-sends it), so there is at most one, and it is dropped with this function.
        let mut attached: Vec<ModelImage> = Vec::new();
        let started = Instant::now();
        let deadline = self.config.team_ai_request_deadline;

        let mut card_call: Option<ProviderToolCall> = None;
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
            let mut momo_tools: Vec<momo_agent::tools::ToolDefinition> =
                momo_agent::tools::workspace_action_propose_definition(&offered)
                    .into_iter()
                    .collect();
            if trace.tools.len() < team_ai::MAX_TOOL_CALLS {
                momo_tools.extend(team_ai_tools::read_tool_definitions());
            }
            // B8 C1: the work-request card, offered only while a bundle that owns it is on. Not
            // behind the taint rule (B4-3): it changes no server state and a person sends what it
            // fills in, so a request that read something may still give it.
            momo_tools.extend(momo_agent::tools::card_suggest_definition(&card_commands));
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
                    let reason = if started.elapsed() >= deadline && trace.model_calls > 1 {
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
                    self.team_ai_refused(job, payload, run_id, team_ai::AFTER_READ_ROLES_SENTENCE,
                        None, &model, OUTCOME_REFUSED_AFTER_READ, &trace, proposed_action).await
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
        // Workspace data or web text reached the model in this request: the answer
        // must not make the server fetch a URL the model was steered into writing.
        let withhold_previews = trace
            .as_ref()
            .is_some_and(|trace| !trace.tools.is_empty() || trace.web_searches > 0);
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let label = label.clone();
            let mut audit_detail = audit_detail.clone();
            let refused_audit_detail = refused_audit_detail.clone();
            let body = body.clone();
            let props = props.clone();
            let ledger = ledger.clone();
            let model = model.clone();
            Box::pin(async move {
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    return Ok(false);
                };
                if snapshot.status == RunStatus::Cancelled {
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
                    let sent = send_thread_notice_in_tx(
                        conn,
                        workspace_id,
                        NewMessage {
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
                        },
                    )
                    .await?;
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
}
