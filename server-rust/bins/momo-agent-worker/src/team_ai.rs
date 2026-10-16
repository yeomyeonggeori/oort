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

use std::time::Instant;

use momo_agent::{
    finish_run_in_tx, lock_gateway_run_in_tx, record_run_usage_in_tx, RunStatus, RunUsageReport,
};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_outbox::ClaimedAgentJob;
use momo_workspace_actions::team_ai::{
    self, FallbackReason, ProposalContext, ProposalRefusal, TeamAiWorkspace, ViaAi,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::payload::AgentJobPayload;
use crate::provider::{ChatMessage, ChatRequest, ChatUsage};
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
        let request = ChatRequest {
            model: model.clone(),
            messages: vec![
                ChatMessage::system(team_ai::system_prompt(&gathered.roster)),
                ChatMessage::user(team_ai::user_turn(&gathered.trigger_text)),
            ],
            max_tokens: Some(team_ai::MAX_OUTPUT_TOKENS),
            // The profile's own `tool_schema` is operator JSON; the team AI is
            // offered exactly one tool and nothing an operator can add.
            tools: Vec::new(),
            momo_tools: momo_agent::tools::enabled_tool_definitions(&[
                momo_agent::tools::WORKSPACE_ACTION_PROPOSE.to_string(),
            ]),
        };

        let prompt_chars: usize = request
            .messages
            .iter()
            .map(|message| message.content.chars().count())
            .sum();
        let started = Instant::now();
        let attempt = tokio::time::timeout(
            self.config.team_ai_model_timeout,
            self.provider.complete(&transport.endpoint, &request),
        )
        .await;
        let latency_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        let completion = match attempt {
            Ok(Ok(completion))
                if !(completion.text.trim().is_empty() && completion.tool_calls.is_empty()) =>
            {
                completion
            }
            // Timed out, errored, or said nothing: hand off, do not retry (a retry
            // would spend the 20 seconds again and still miss the budget).
            other => {
                tracing::warn!(
                    run_id = %run_id,
                    timed_out = other.is_err(),
                    latency_ms,
                    "team ai model call produced no usable answer"
                );
                return Some(
                    self.team_ai_fallback(
                        job,
                        payload,
                        run_id,
                        &requester,
                        &gathered.candidates,
                        FallbackReason::Slow,
                        // The provider may well have spent tokens before it timed
                        // out or failed: charge a conservative estimate so the
                        // daily ceiling still moves.
                        Some(Spend::of(None, prompt_chars)),
                        &model,
                    )
                    .await,
                );
            }
        };
        let usage = Some(Spend::of(completion.usage, prompt_chars));

        let Some(call) = completion.tool_calls.first().cloned() else {
            // A plain answer (workspace facts). Bounded, posted as one message.
            let text: String = completion.text.trim().chars().take(1_500).collect();
            return Some(
                self.team_ai_finish(
                    job,
                    payload,
                    run_id,
                    Some(text),
                    json!({}),
                    usage,
                    &model,
                    Ending::Answered,
                )
                .await,
            );
        };

        // Exactly one tool exists; anything else is the model going off script.
        if momo_agent::tools::normalize(&call.name)
            != momo_agent::tools::normalize(momo_agent::tools::WORKSPACE_ACTION_PROPOSE)
        {
            return Some(
                self.team_ai_fallback(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    FallbackReason::OutOfScope,
                    usage,
                    &model,
                )
                .await,
            );
        }
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
            // ADR-0201 증보 v2 H7: an app install has no route yet — say so, no card.
            if let ProposalRefusal::NotYetAvailable(line) = refusal {
                return Some(
                    self.team_ai_finish(
                        job,
                        payload,
                        run_id,
                        Some(line),
                        json!({}),
                        usage,
                        &model,
                        Ending::Answered,
                    )
                    .await,
                );
            }
            let reason = match refusal {
                ProposalRefusal::NotAllowed => FallbackReason::OutOfScope,
                _ => FallbackReason::CouldNotPropose,
            };
            return Some(
                self.team_ai_fallback(
                    job,
                    payload,
                    run_id,
                    &requester,
                    &gathered.candidates,
                    reason,
                    usage,
                    &model,
                )
                .await,
            );
        }

        let now = chrono::Utc::now();
        let expires_at = momo_agent::default_expires_at(now, self.config.approval_ttl_seconds);
        let via = ViaAi {
            model: model.clone(),
            latency_ms,
            prompt_tokens: usage.map(|u| u.usage.prompt_tokens).unwrap_or(0),
            completion_tokens: usage.map(|u| u.usage.completion_tokens).unwrap_or(0),
        };
        let ledger = ledger_report(usage, &model, payload);
        let fallback_model = model.clone();
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
                let outcome =
                    team_ai::propose_in_tx(conn, &context, &action_id, &args, rationale.as_deref())
                        .await?;
                // The ledger row is written whether or not a card came of it: the
                // tokens were spent, and the daily ceiling reads this table.
                let resolved = RunUsageReport::resolve(Some(&ledger), &fallback_model, None, None);
                record_run_usage_in_tx(conn, workspace_id, run_id, agent, channel_id, &resolved)
                    .await?;
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
                    "team ai proposal card raised"
                );
                self.settle_done(job.id, Some("awaiting approval")).await;
                Some(Settlement::Skipped)
            }
            Ok(Err(refusal)) => Some(match refusal {
                ProposalRefusal::NotAllowed => {
                    self.team_ai_fallback(job, payload, run_id, &requester, &gathered.candidates, FallbackReason::OutOfScope, None, &model).await
                }
                ProposalRefusal::InvalidArguments | ProposalRefusal::AvatarNotAllowed => {
                    self.team_ai_fallback(job, payload, run_id, &requester, &gathered.candidates, FallbackReason::CouldNotPropose, None, &model).await
                }
                ProposalRefusal::RequesterLacksRole => {
                    self.team_ai_finish(job, payload, run_id,
                        Some("이 일은 관리자만 승인할 수 있어요. 관리자에게 부탁해 볼까요?".to_string()),
                        json!({}), None, &model, Ending::Answered).await
                }
                ProposalRefusal::TooManyPending => {
                    self.team_ai_finish(job, payload, run_id,
                        Some("승인을 기다리는 카드가 이미 많아요. 먼저 처리해 주세요.".to_string()),
                        json!({}), None, &model, Ending::Answered).await
                }
                ProposalRefusal::TargetBusy => {
                    self.team_ai_finish(job, payload, run_id,
                        Some("같은 대상에 승인을 기다리는 카드가 있어요. 그 카드를 먼저 처리해 주세요.".to_string()),
                        json!({}), None, &model, Ending::Answered).await
                }
                ProposalRefusal::NoHumanRequester | ProposalRefusal::RunNotParkable => {
                    self.team_ai_close(job, payload, run_id, "team_ai_not_proposable").await
                }
                ProposalRefusal::NotYetAvailable(line) => {
                    self.team_ai_finish(job, payload, run_id, Some(line), json!({}), None, &model, Ending::Answered).await
                }
            }),
            Err(error) => Some(
                self.settle_retryable(job, &format!("team ai proposal failed: {error}"), &transport.endpoint).await,
            ),
        }
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
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
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
                    }
                    let sent = send_message_in_tx(
                        conn,
                        workspace_id,
                        NewMessage {
                            channel_id,
                            author_member_id: agent,
                            message_type: MessageType::Text,
                            body: Some(text),
                            props,
                            root_id: None,
                            reply_to_id: snapshot.trigger_message_id,
                            client_msg_id: Some(run_id),
                            run_id: Some(run_id),
                            hlc_ts: None,
                            hlc_count: None,
                        },
                    )
                    .await?;
                    message_id = Some(sent.message.id);
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
                    let resolved = RunUsageReport::resolve(Some(&report), &model, None, None);
                    record_run_usage_in_tx(
                        conn,
                        workspace_id,
                        run_id,
                        agent,
                        channel_id,
                        &resolved,
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
    Ok(body.unwrap_or_default())
}
