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
use momo_workspace_actions::team_ai_tools::{self, ToolOutcome};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::payload::AgentJobPayload;
use crate::provider::{ChatMessage, ChatRequest, ChatUsage, ProviderWire};
use crate::{emit_terminal_agent_status, AgentWorker, ResolvedTransport, Settlement};

/// What the first read of a team-AI turn found.
struct Gathered {
    state: TeamAiWorkspace,
    requester: Option<momo_agent::card_suggest::SuggestionRequester>,
    trigger_text: String,
    used_today: i64,
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
}

impl TurnTrace {
    fn audit_detail(&self, spend: Option<Spend>, outcome: &str) -> Value {
        json!({
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
        })
    }
}

/// H5: can this wire search on the provider's side? Decided by the wire, never
/// by a provider's name. `Responses` stays "no" until its tool type is verified
/// against the live API (runtime-unverified follow-up).
fn wire_searches(wire: ProviderWire) -> bool {
    matches!(wire, ProviderWire::AnthropicMessages)
}

/// How a settled team-AI turn ends the run.
enum Ending {
    /// A reply was posted and the run succeeded.
    Answered,
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
                let trigger_text: String = match trigger_message_id {
                    Some(id) => sqlx_body(conn, workspace_id, id).await?,
                    None => String::new(),
                };
                let used_today =
                    team_ai::tokens_used_today_in_tx(conn, workspace_id, agent).await?;
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
        let cap = self.config.team_ai_daily_token_cap;
        if gathered.used_today >= cap {
            return Some(
                self.team_ai_fallback(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    FallbackReason::OverBudget,
                    None,
                    "",
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
        } else if gathered.searches_today >= self.config.team_ai_daily_search_cap {
            WebSearch::DailyCapReached
        } else {
            WebSearch::Available
        };
        let mut trace = TurnTrace {
            model: model.clone(),
            wire: wire.as_str(),
            ..TurnTrace::default()
        };
        let mut messages = vec![
            ChatMessage::system(team_ai::system_prompt(&gathered.roster, web)),
            ChatMessage::user(team_ai::user_turn(&gathered.trigger_text)),
        ];
        let mut spend: Option<Spend> = None;
        let mut read_used = false;
        let started = Instant::now();
        let deadline = self.config.team_ai_request_deadline;

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
            let mut momo_tools = momo_agent::tools::enabled_tool_definitions(&[
                momo_agent::tools::WORKSPACE_ACTION_PROPOSE.to_string(),
            ]);
            if trace.tools.len() < team_ai::MAX_TOOL_CALLS {
                momo_tools.extend(team_ai_tools::read_tool_definitions());
            }
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
            let attempt =
                tokio::time::timeout(cut, self.provider.complete(&transport.endpoint, &request))
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
                let outcome = match self
                    .team_ai_read(
                        workspace_id,
                        agent,
                        requester.member_id,
                        channel_id,
                        &name,
                        &tool_call.arguments_json(),
                    )
                    .await
                {
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

        let prepared_avatar = if let Some(action) = momo_agent::actions::action_by_id(&action_id) {
            match momo_workspace_actions::action_resolve::validated_action_args(
                action,
                &args,
                chrono::Utc::now().timestamp_millis(),
            ) {
                Ok(validated) => {
                    momo_workspace_actions::profile_avatar::prepare(
                        &self.pool,
                        self.drive.as_ref(),
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
    /// function. Read-only; nothing else happens in this transaction.
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
        })
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
        let (succeeded, error_code) = match ending {
            Ending::Answered => (true, None),
            Ending::Closed(code) => (false, Some(code)),
        };
        // H2-8 / H9-I9: whoever answers to `@claude`, the line says which model on
        // which wire actually spoke (a plain id — no key, no URL).
        let label = trace
            .as_ref()
            .filter(|trace| !trace.model.is_empty())
            .map(|trace| json!({"model": trace.model, "wire": trace.wire}));
        let audit_detail = trace
            .as_ref()
            .map(|trace| trace.audit_detail(usage, error_code.unwrap_or("answered")));
        let searches = trace.as_ref().map(|trace| trace.web_searches).unwrap_or(0);
        // Workspace data or web text reached the model in this request: the answer
        // must not make the server fetch a URL the model was steered into writing.
        let withhold_previews = trace
            .as_ref()
            .is_some_and(|trace| !trace.tools.is_empty() || trace.web_searches > 0);
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let label = label.clone();
            let audit_detail = audit_detail.clone();
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
    Ok(trigger_turn_with_images(&body.unwrap_or_default(), &ids))
}

// Reserve room for this trigger's server-owned image ids. The caller bounds the
// final user turn again; appending after truncation would silently lose the ids.
fn trigger_turn_with_images(body: &str, ids: &[Uuid]) -> String {
    let mut suffix = String::new();
    if !ids.is_empty() {
        suffix.push_str("\n[데이터: 이 메시지의 이미지 attachmentId]\n");
        for id in ids.iter().take(20) {
            suffix.push_str(&format!("{id}\n"));
        }
    }
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
}
