//! The team AI's **task mode**, worker half (ADR-0201 증보 v3 B5·B13-I7·B14-S4, #4967).
//!
//! `super` is the quick request: one short, bounded turn. This module is what lets that turn be
//! *continued* instead of handed off: the model ends a step with `task_continue {plan, note}`, the
//! plan and note are kept in the run's `team_ai_task` row, and the next step is a job of the **same
//! run** — so the requester, the room and the reply place all stay the ones the request began with.
//!
//! What is deliberately the same as the quick path: the limits of one step (model calls ≤4, reads
//! ≤6, 45 seconds, 20 seconds a call), the reads (as the requester, through `momo_helper_read`), the
//! one reply message, the single-writer ledger rule (a reply is written by `team_ai_finish`).
//!
//! What a task adds, and where each rule is kept:
//!
//! | rule | where |
//! |---|---|
//! | the row's existence is the judgement; a step runs once | `momo_agent::team_ai_task::decide_step` + [`AgentWorker::run_team_ai_task_step`]'s claim |
//! | the requester is derived again every step | `Gathered::requester` (read from the run row at the top of every job) → `task_requester_gone` |
//! | a task never raises a card | the proposal tool is not offered to a step, and a call of it is off-script |
//! | workspace text never rides a web search out | a task that has read gets no search from then on (`WebSearch::AfterRead`) |
//! | cooperative cancel | the run's status is read before every model call and again in the commit |
//! | bounded | the task's bounds are checked at the start of a step and before a commit |
//! | one progress line per step | the `stage` row is written in the step's own commit |
//!
//! Every ending goes through `team_ai_finish` (one message, the run's end, the ledger, the row's
//! end in one transaction) except a cancel, whose message the cancel route already wrote.

use super::*;

use momo_agent::run_event::{append_run_event_in_tx, AppendedRunEvent};
use momo_agent::team_ai_task::{
    self as store, ClaimOutcome, CreateOutcome, NewTask, StepCommit, TaskContinueArgs,
};
use momo_outbox::{backoff_seconds, emit_outbox, requeue, OutboxKind};

/// How the first turn's attempt to start a task ended.
enum Began {
    Started,
    /// Too many tasks are running (workspace or requester), or the run has no step left to spend.
    Busy,
    /// The `long_research` bundle was switched off while the model was thinking (B13-I5).
    RoleOff,
    /// A row for the run already exists: another attempt of this very turn started the task.
    AlreadyExists,
    /// The run is cancelled or gone.
    Gone,
}

/// How a step's commit ended.
enum Committed {
    /// `steps_done` moved, the progress line and the next step's job were written.
    Continued,
    /// The run has no G3 step left: nothing was written but the ledger row.
    StepsExhausted,
    /// The step lost: the task ended or the claim was taken over. Only the ledger row was written.
    Lost,
    /// A person stopped the run; the task ended, the ledger row stays.
    Cancelled,
    /// The run is gone.
    Gone,
}

/// How a step's model loop ended.
enum StepEnd {
    /// A plain answer: the final report.
    Answer(String),
    /// `task_continue`, validated.
    Continue(TaskContinueArgs),
    /// The step used its own budget (calls or seconds) without answering or continuing.
    OutOfBudget,
    /// The provider timed out, failed, said nothing, or the model went off script.
    ProviderError,
    /// A person stopped the run.
    Cancelled,
    /// The database failed mid-step; the job is retried.
    Retry(String),
}

impl AgentWorker {
    /// The first turn asked to continue: write the task row (`steps_done = 1`), the first progress
    /// line and the job of step 2 — **one transaction** — or refuse honestly. Every refusal is a
    /// reply with a fixed sentence; nothing is half-started.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn team_ai_task_begin(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        candidates: &[(Uuid, String, String)],
        args: TaskContinueArgs,
        spend: Option<Spend>,
        model: &str,
        trace: &TurnTrace,
    ) -> Settlement {
        let workspace_id = job.workspace_id;
        let agent = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let requester_id = requester.member_id;
        let limits = self.config.team_ai_task;
        let ledger = spend.map(|usage| ledger_report(Some(usage), model, payload));
        let (model_calls, tool_calls, searches) = (
            trace.model_calls,
            i32::try_from(trace.tools.len()).unwrap_or(i32::MAX),
            trace.web_searches,
        );
        let mut audit_trace = trace.clone();
        audit_trace.task_step = Some(1);
        let audit_detail = audit_trace.audit_detail(spend, "task_started");
        let job_payload = store::step_job_payload(
            workspace_id,
            run_id,
            agent,
            channel_id,
            2,
            &payload.model,
            payload.model_source.as_deref(),
        );
        let model_owned = model.to_string();
        let began = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let args = args.clone();
            let ledger = ledger.clone();
            let model = model_owned.clone();
            let audit_detail = audit_detail.clone();
            let job_payload = job_payload.clone();
            Box::pin(async move {
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    return Ok(Began::Gone);
                };
                // What this step spent is real whatever comes of the task: it is written first and
                // stays in every outcome below.
                if let Some(report) = ledger {
                    let mut resolved = RunUsageReport::resolve(Some(&report), &model, None, None);
                    resolved.source = momo_agent::UsageSource::Measured;
                    store::record_step_usage_in_tx(
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
                if snapshot.status == RunStatus::Cancelled {
                    return Ok(Began::Gone);
                }
                // B13-I5, third fence: the bundle as it is *now*, not as the request read it.
                if !team_ai::read_roles_in_tx(conn, workspace_id)
                    .await?
                    .is_on(momo_agent::team_ai_roles::LONG_RESEARCH)
                {
                    return Ok(Began::RoleOff);
                }
                let new = NewTask {
                    workspace_id,
                    run_id,
                    agent_member_id: agent,
                    plan: &args.plan,
                    note: &args.note,
                    model_calls,
                    tool_calls,
                    web_searches: searches,
                };
                match store::create_in_tx(conn, &new, requester_id, &limits).await? {
                    CreateOutcome::Created => {}
                    CreateOutcome::AlreadyExists => return Ok(Began::AlreadyExists),
                    CreateOutcome::WorkspaceBusy | CreateOutcome::RequesterBusy => {
                        return Ok(Began::Busy)
                    }
                }
                // G3: the first step spends one of the run's own steps (B5-11).
                if !momo_agent::consume_run_step_in_tx(conn, run_id, limits.max_steps).await? {
                    store::end_in_tx(conn, workspace_id, run_id, store::END_LIMIT).await?;
                    return Ok(Began::Busy);
                }
                append_run_event_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                    AppendedRunEvent::Stage(&store::stage_label(1, &args.plan)),
                    agent,
                )
                .await?;
                emit_outbox(
                    &mut *conn,
                    workspace_id,
                    OutboxKind::AgentJob,
                    "publish",
                    &job_payload,
                    Some(agent),
                )
                .await
                .map_err(DbError::from)?;
                audit::write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "team_ai.turn")
                        .by(agent)
                        .run(run_id)
                        .with_schema("momo.team_ai_turn.v1", audit_detail),
                )
                .await?;
                Ok(Began::Started)
            })
        })
        .await;
        match began {
            Ok(Began::Started) => {
                tracing::info!(run_id = %run_id, "team ai task started");
                self.settle_done(job.id, Some("team ai task started")).await;
                Settlement::Skipped
            }
            // The spend is already on the ledger (written first, above), so the reply charges nothing.
            Ok(Began::Busy) => {
                self.team_ai_fallback_traced(
                    job,
                    payload,
                    run_id,
                    requester,
                    candidates,
                    FallbackReason::TaskBusy,
                    None,
                    trace,
                )
                .await
            }
            Ok(Began::RoleOff) => {
                self.team_ai_refused(
                    job,
                    payload,
                    run_id,
                    team_ai::ROLE_OFF_SENTENCE,
                    None,
                    model,
                    OUTCOME_REFUSED_ROLE_OFF,
                    trace,
                    Some(momo_agent::tools::TASK_CONTINUE),
                )
                .await
            }
            Ok(Began::AlreadyExists) => {
                self.settle_done(job.id, Some(store::SkipReason::StepDone.as_str()))
                    .await;
                Settlement::Skipped
            }
            Ok(Began::Gone) => {
                self.settle_done(job.id, Some("team ai task: run is gone or cancelled"))
                    .await;
                Settlement::Skipped
            }
            Err(error) => {
                self.settle_retryable(
                    job,
                    &format!("team ai task start failed: {error}"),
                    &crate::personal::neutral_endpoint(),
                )
                .await
            }
        }
    }

    /// Run one later step of a task (`step >= 2`). `gathered` was read at the top of the job: the
    /// task row, the run's status and the requester **derived again from the run row** — a person
    /// who has left the room is `None` here, and the task ends (B5-6).
    pub(super) async fn run_team_ai_task_step(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        transport: &mut ResolvedTransport,
        gathered: Gathered,
        step: i32,
    ) -> Settlement {
        let workspace_id = job.workspace_id;
        let agent = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let limits = self.config.team_ai_task;
        let model = payload.model_or(&self.config.default_model).to_string();
        let wire = transport.endpoint.wire;
        let mut trace = TurnTrace {
            model: model.clone(),
            wire: wire.as_str(),
            task_step: Some(step),
            ..TurnTrace::default()
        };
        let Some(task) = gathered.task.clone() else {
            self.settle_done(job.id, Some(store::SkipReason::NoTask.as_str()))
                .await;
            return Settlement::Skipped;
        };

        // The run itself. A stop is honoured before anything costs (B5-8); a run that ended
        // through a path that does not know tasks closes the row; `failed` is not an ending here —
        // it is what the retry path marks a run between attempts.
        match gathered.run_status {
            Some(RunStatus::Cancelled) => {
                return self
                    .team_ai_task_drop(job, payload, run_id, None, 0, &model, store::END_CANCELLED)
                    .await
            }
            Some(RunStatus::Succeeded) | Some(RunStatus::TimedOut) | None => {
                return self
                    .team_ai_task_drop(job, payload, run_id, None, 0, &model, store::END_RUN_ENDED)
                    .await
            }
            Some(_) => {}
        }
        // B5-6: no human who asked, no task. (Silent, like the quick path's no-requester close.)
        let Some(requester) = gathered.requester.clone() else {
            return self
                .team_ai_finish(
                    job,
                    payload,
                    run_id,
                    None,
                    json!({}),
                    None,
                    &model,
                    Ending::Closed(store::END_REQUESTER_GONE),
                    Some(trace),
                )
                .await;
        };
        // The switch is off: the member is paused and a straggler closes without a word.
        if !gathered.state.enabled {
            return self
                .team_ai_close(job, payload, run_id, "team_ai_disabled")
                .await;
        }
        let roles = gathered.state.roles;
        // B13-I5: a bundle that is off is not advertised **and its work does not continue**.
        if !roles.is_on(momo_agent::team_ai_roles::LONG_RESEARCH) {
            return self
                .team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    team_ai::TASK_ROLE_OFF_SENTENCE,
                    &task.note,
                    store::END_ROLE_OFF,
                    None,
                    &trace,
                )
                .await;
        }
        // B9-2 (#4944): the usage limits end a task with what it has found, like any other bound —
        // and they are judged by the very function the quick path is judged by (nothing set and no
        // operator ceiling = never; the operator's switch and ceiling first; then the team's own
        // daily tokens and monthly dollars), before this step asks the model for anything.
        let caps = self.config.team_ai_caps();
        let usage = Usage {
            tokens_today: gathered.used_today,
            month_micro_usd: gathered.month_micro_usd,
        };
        if let Some(hit) = team_ai_limits::judge(&gathered.state.limits, &caps, &usage) {
            return self
                .team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    hit.task_sentence(),
                    &task.note,
                    store::END_LIMIT,
                    None,
                    &trace,
                )
                .await;
        }
        // B5-5: a bound reached by the steps already done (or by the clock while the job waited).
        if limits
            .hit(
                task.steps_done,
                task.model_calls,
                task.tool_calls,
                task.elapsed_secs,
            )
            .is_some()
        {
            return self
                .team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    team_ai::TASK_LIMIT_SENTENCE,
                    &task.note,
                    store::END_LIMIT,
                    None,
                    &trace,
                )
                .await;
        }
        if transport.needs_refresh(crate::now_ms())
            && self.refresh_and_reseal(transport).await.is_err()
        {
            return self
                .team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    team_ai::TASK_PROVIDER_ERROR_SENTENCE,
                    &task.note,
                    store::END_PROVIDER_ERROR,
                    None,
                    &trace,
                )
                .await;
        }

        // The step is executed under a claim: of two jobs for one step, one calls the model.
        let token = job.lease_id;
        let claimed = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                store::claim_step_in_tx(conn, workspace_id, run_id, step, token).await
            })
        })
        .await;
        let task = match claimed {
            Ok(ClaimOutcome::Claimed(row)) => row,
            Ok(ClaimOutcome::Taken) => return self.team_ai_task_wait(job).await,
            Ok(ClaimOutcome::Gone) => {
                self.settle_done(job.id, Some(store::SkipReason::StepDone.as_str()))
                    .await;
                return Settlement::Skipped;
            }
            Err(error) => {
                return self
                    .settle_retryable(
                        job,
                        &format!("team ai task claim failed: {error}"),
                        &transport.endpoint,
                    )
                    .await
            }
        };

        // H5, for the whole task: once a step has read the workspace, no later step searches the web.
        let web = if !gathered.state.web_search {
            WebSearch::Off
        } else if !wire_searches(wire) {
            WebSearch::NotSupported
        } else if team_ai_limits::search_cap(&gathered.state.limits, &caps)
            .is_some_and(|cap| gathered.searches_today >= cap)
        {
            WebSearch::DailyCapReached
        } else if task.tool_calls > 0 {
            WebSearch::AfterRead
        } else {
            WebSearch::Available
        };
        // No card is offered to a step of a task (B5-6: a task is reading work, and the sensitive
        // set — whatever `SENSITIVE_ACTION_IDS` holds — is never offered inside one), and neither is
        // the `card_suggest` work-request card (B8 C1: the tool list below carries no `card_suggest`,
        // and a call of it is off-script). The two empty lists are also what makes the prompt say so.
        let mut messages = vec![
            ChatMessage::system(team_ai::system_prompt_with_task(
                &gathered.roster,
                web,
                &[],
                &[],
                team_ai::TaskPrompt::InTask {
                    step,
                    max_steps: limits.max_steps,
                },
            )),
            ChatMessage::user(team_ai::task_user_turn(
                &gathered.trigger_text,
                step,
                &task.plan,
                &task.note,
            )),
        ];
        let mut spend: Option<Spend> = None;
        let mut read_used = false;
        let started = Instant::now();
        let deadline = self.config.team_ai_request_deadline;

        let end = loop {
            let elapsed = started.elapsed();
            if trace.model_calls as usize >= team_ai::MAX_MODEL_CALLS || elapsed >= deadline {
                break StepEnd::OutOfBudget;
            }
            // B5-8: a stop is read before every model call, so a cancelled task spends nothing more.
            match self.team_ai_task_stopped(workspace_id, run_id).await {
                Ok(true) => break StepEnd::Cancelled,
                Ok(false) => {}
                Err(error) => {
                    break StepEnd::Retry(format!("team ai task status read failed: {error}"))
                }
            }
            // The last call a step may make is for deciding: no reads, no search — continue or answer.
            let last_call = trace.model_calls as usize + 1 >= team_ai::MAX_MODEL_CALLS;
            let mut momo_tools = vec![momo_agent::tools::task_continue_definition()];
            if !last_call && trace.tools.len() < team_ai::MAX_TOOL_CALLS {
                momo_tools.extend(team_ai_tools::read_tool_definitions());
            }
            momo_tools.retain(|tool| roles.tool_allowed(tool.name));
            // #4970 × #4967: a step reads no attachments. The bytes path (`team_ai_files`) runs in the
            // first turn only, the step's prompt has no files sentence and its user turn lists no
            // attachment; what the first turn read reaches a step through the task's note.
            momo_tools.retain(|tool| tool.name != team_ai_tools::TOOL_READ_ATTACHMENT);
            let mut tools: Vec<Value> = Vec::new();
            if web == WebSearch::Available && !read_used && !last_call {
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
            let attempt =
                tokio::time::timeout(cut, self.provider.complete(&transport.endpoint, &request))
                    .await;
            trace.model_calls += 1;
            let completion = match attempt {
                Ok(Ok(completion))
                    if !(completion.text.trim().is_empty() && completion.tool_calls.is_empty()) =>
                {
                    completion
                }
                other => {
                    tracing::warn!(
                        run_id = %run_id,
                        step,
                        timed_out = other.is_err(),
                        "team ai task step: the model call produced no usable answer"
                    );
                    // The provider may have spent tokens before it failed: charge the estimate.
                    spend = Spend::add(spend, Spend::of(None, prompt_chars));
                    break StepEnd::ProviderError;
                }
            };
            spend = Spend::add(spend, Spend::of(completion.usage, prompt_chars));
            trace.web_searches += completion.web_search_requests.max(0);

            if completion.tool_calls.is_empty() {
                let text: String = completion
                    .text
                    .trim()
                    .chars()
                    .take(team_ai::TASK_REPORT_CHARS_MAX)
                    .collect();
                break StepEnd::Answer(text);
            }
            // `task_continue` ends the step. Whatever else the call asked for is not run.
            if let Some(cont) = completion.tool_calls.iter().find(|call| {
                momo_agent::tools::normalize(&call.name)
                    == momo_agent::tools::normalize(momo_agent::tools::TASK_CONTINUE)
            }) {
                match momo_agent::team_ai_task::parse_task_continue(&cont.arguments_json()) {
                    Ok(args) => break StepEnd::Continue(args),
                    Err(reason) => {
                        // Back to the model, once per call it has left.
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
            // Anything that is not a read here is the model going off script — the proposal tool
            // included: it was not offered to a step of a task.
            if completion
                .tool_calls
                .iter()
                .any(|call| !team_ai_tools::is_read_tool(&call.name))
            {
                break StepEnd::ProviderError;
            }

            // The reads, as the requester derived at the top of THIS step. Nothing is written.
            let mut results = Vec::with_capacity(completion.tool_calls.len());
            let mut called = Vec::with_capacity(completion.tool_calls.len());
            let mut retry: Option<String> = None;
            for tool_call in &completion.tool_calls {
                let name = momo_agent::tools::normalize(&tool_call.name);
                if trace.tools.len() >= team_ai::MAX_TOOL_CALLS || last_call {
                    results.push(
                        ToolOutcome::Invalid("read budget for this step is spent").render(&name),
                    );
                    continue;
                }
                match self
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
                    Ok(outcome) => {
                        trace.tools.push(name.clone());
                        trace.tool_codes.push(outcome.code());
                        results.push(outcome.render(&name));
                        called.push(name);
                    }
                    Err(error) => {
                        retry = Some(format!("team ai task read tool failed: {error}"));
                        break;
                    }
                }
            }
            if let Some(reason) = retry {
                break StepEnd::Retry(reason);
            }
            read_used = true;
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: format!("(읽기 도구 호출: {})", called.join(", ")),
            });
            messages.push(ChatMessage::user(results.join("\n\n")));
        };
        trace.latency_ms = millis(started);

        match end {
            StepEnd::Answer(text) => {
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
                .await
            }
            StepEnd::Continue(args) => {
                // B5-5: a bound this step has just reached ends the task *now*, with the note the
                // model has just written — not one more step later.
                let reached = limits.hit(
                    step,
                    task.model_calls + trace.model_calls,
                    task.tool_calls + i32::try_from(trace.tools.len()).unwrap_or(i32::MAX),
                    task.elapsed_secs
                        .saturating_add(i64::try_from(started.elapsed().as_secs()).unwrap_or(0)),
                );
                if reached.is_some() {
                    return self
                        .team_ai_task_interim(
                            job,
                            payload,
                            run_id,
                            team_ai::TASK_LIMIT_SENTENCE,
                            &args.note,
                            store::END_LIMIT,
                            spend,
                            &trace,
                        )
                        .await;
                }
                self.team_ai_task_commit(
                    job, payload, run_id, step, token, args, spend, &model, &trace, transport,
                )
                .await
            }
            StepEnd::OutOfBudget => {
                self.team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    team_ai::TASK_LIMIT_SENTENCE,
                    &task.note,
                    store::END_LIMIT,
                    spend,
                    &trace,
                )
                .await
            }
            StepEnd::ProviderError => {
                self.team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    team_ai::TASK_PROVIDER_ERROR_SENTENCE,
                    &task.note,
                    store::END_PROVIDER_ERROR,
                    spend,
                    &trace,
                )
                .await
            }
            StepEnd::Cancelled => {
                // The calls this step made before the stop was read spent tokens AND searches.
                self.team_ai_task_drop(
                    job,
                    payload,
                    run_id,
                    spend,
                    trace.web_searches,
                    &model,
                    store::END_CANCELLED,
                )
                .await
            }
            StepEnd::Retry(reason) => {
                // Give the claim back so the retry does not wait it out, then retry the job.
                self.team_ai_task_release(workspace_id, run_id, token).await;
                self.settle_retryable(job, &reason, &transport.endpoint)
                    .await
            }
        }
    }

    /// Commit a step that continues: the spend, the new plan and note, the progress line and the next
    /// step's job — one transaction, and only the holder of the claim writes any of it but the spend.
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_task_commit(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        step: i32,
        token: Uuid,
        args: TaskContinueArgs,
        spend: Option<Spend>,
        model: &str,
        trace: &TurnTrace,
        transport: &ResolvedTransport,
    ) -> Settlement {
        let workspace_id = job.workspace_id;
        let agent = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let limits = self.config.team_ai_task;
        let ledger = spend.map(|usage| ledger_report(Some(usage), model, payload));
        let (model_calls, tool_calls, searches) = (
            trace.model_calls,
            i32::try_from(trace.tools.len()).unwrap_or(i32::MAX),
            trace.web_searches,
        );
        let audit_detail = trace.audit_detail(spend, "task_step");
        let job_payload = store::step_job_payload(
            workspace_id,
            run_id,
            agent,
            channel_id,
            step + 1,
            &payload.model,
            payload.model_source.as_deref(),
        );
        let model_owned = model.to_string();
        let committed = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let args = args.clone();
            let ledger = ledger.clone();
            let model = model_owned.clone();
            let audit_detail = audit_detail.clone();
            let job_payload = job_payload.clone();
            Box::pin(async move {
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    return Ok(Committed::Gone);
                };
                // Spent is spent: the row is written before any judgement and stays in every outcome.
                if let Some(report) = ledger {
                    let mut resolved = RunUsageReport::resolve(Some(&report), &model, None, None);
                    resolved.source = momo_agent::UsageSource::Measured;
                    store::record_step_usage_in_tx(
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
                if snapshot.status == RunStatus::Cancelled {
                    store::end_in_tx(conn, workspace_id, run_id, store::END_CANCELLED).await?;
                    return Ok(Committed::Cancelled);
                }
                // G3: a read under the run's lock, before anything is written for the step.
                if !store::step_room_in_tx(conn, workspace_id, run_id, limits.max_steps).await? {
                    return Ok(Committed::StepsExhausted);
                }
                let commit = StepCommit {
                    workspace_id,
                    run_id,
                    token,
                    step,
                    plan: &args.plan,
                    note: &args.note,
                    model_calls,
                    tool_calls,
                    web_searches: searches,
                };
                // The compare-and-swap: `steps_done` moves only for the holder of the claim.
                if store::commit_step_in_tx(conn, &commit).await?.is_none() {
                    return Ok(Committed::Lost);
                }
                momo_agent::consume_run_step_in_tx(conn, run_id, limits.max_steps).await?;
                // A retried attempt left the run reading `failed`; a task that goes on is `running`.
                momo_agent::run::resume_run_between_attempts_in_tx(conn, run_id).await?;
                append_run_event_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                    AppendedRunEvent::Stage(&store::stage_label(step, &args.plan)),
                    agent,
                )
                .await?;
                emit_outbox(
                    &mut *conn,
                    workspace_id,
                    OutboxKind::AgentJob,
                    "publish",
                    &job_payload,
                    Some(agent),
                )
                .await
                .map_err(DbError::from)?;
                audit::write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "team_ai.turn")
                        .by(agent)
                        .run(run_id)
                        .with_schema("momo.team_ai_turn.v1", audit_detail),
                )
                .await?;
                Ok(Committed::Continued)
            })
        })
        .await;
        match committed {
            Ok(Committed::Continued) => {
                tracing::info!(run_id = %run_id, step, "team ai task step committed");
                self.settle_done(job.id, Some("team ai task step done"))
                    .await;
                Settlement::Skipped
            }
            // The row is already at its last note; what the person gets is that note.
            Ok(Committed::StepsExhausted) => {
                let note = self.team_ai_task_note(workspace_id, run_id).await;
                self.team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    team_ai::TASK_LIMIT_SENTENCE,
                    &note,
                    store::END_LIMIT,
                    None,
                    trace,
                )
                .await
            }
            Ok(Committed::Lost) | Ok(Committed::Cancelled) | Ok(Committed::Gone) => {
                self.settle_done(job.id, Some("team ai task step not committed"))
                    .await;
                Settlement::Skipped
            }
            Err(error) => {
                self.team_ai_task_release(workspace_id, run_id, token).await;
                self.settle_retryable(
                    job,
                    &format!("team ai task commit failed: {error}"),
                    &transport.endpoint,
                )
                .await
            }
        }
    }

    /// End the run with an interim report: a fixed sentence and the note — all that survives of the
    /// work (B5-5). `usage` is what is still to be charged (`None` when a transaction already wrote
    /// the ledger row). The run ends `failed` with `code`, one message is posted, the row ends.
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_task_interim(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        sentence: &str,
        note: &str,
        code: &'static str,
        usage: Option<Spend>,
        trace: &TurnTrace,
    ) -> Settlement {
        let body = team_ai::interim_report(sentence, note);
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(body),
            json!({}),
            usage,
            &trace.model.clone(),
            Ending::Closed(code),
            Some(trace.clone()),
        )
        .await
    }

    /// A step ends without a message: a stop (the cancel route already wrote its own line and ended
    /// the row — this only keeps what the step spent on the ledger and makes sure the row is ended)
    /// or a run that ended through a path that does not know tasks. `searches` are the web searches
    /// the cut-short step had already made: they are on the ledger row like its tokens, so the day's
    /// search allowance (B9-2) counts them (security review r1 L4a).
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_task_drop(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        spend: Option<Spend>,
        searches: i32,
        model: &str,
        reason: &'static str,
    ) -> Settlement {
        let workspace_id = job.workspace_id;
        let agent = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let ledger = spend.map(|usage| ledger_report(Some(usage), model, payload));
        let model_owned = model.to_string();
        let done = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let ledger = ledger.clone();
            let model = model_owned.clone();
            Box::pin(async move {
                if let Some(report) = ledger {
                    let mut resolved = RunUsageReport::resolve(Some(&report), &model, None, None);
                    resolved.source = momo_agent::UsageSource::Measured;
                    store::record_step_usage_in_tx(
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
                store::end_in_tx(conn, workspace_id, run_id, reason).await?;
                Ok(())
            })
        })
        .await;
        match done {
            Ok(()) => {
                self.settle_done(job.id, Some(reason)).await;
                Settlement::Skipped
            }
            Err(error) => {
                self.settle_retryable(
                    job,
                    &format!("team ai task close failed: {error}"),
                    &crate::personal::neutral_endpoint(),
                )
                .await
            }
        }
    }

    /// Another worker holds a live claim on this very step: do not call the model, come back later.
    /// A job that has been back often enough is dropped — the holder either commits (and this job is
    /// moot) or lets the claim expire (and the holder's own job is re-claimed to take it over).
    async fn team_ai_task_wait(&self, job: &ClaimedAgentJob) -> Settlement {
        if job.attempts >= self.config.max_attempts {
            self.settle_done(job.id, Some("team ai task step is held by another worker"))
                .await;
            return Settlement::Skipped;
        }
        let backoff = backoff_seconds(job.attempts);
        if let Err(error) = requeue(
            &self.pool,
            job.id,
            backoff,
            "team ai task step is held by another worker",
        )
        .await
        {
            tracing::error!(outbox_id = job.id, error = %error, "requeue failed");
        }
        Settlement::Requeued
    }

    /// Has a person stopped this run? (B5-8, read before every model call of a step.)
    async fn team_ai_task_stopped(
        &self,
        workspace_id: Uuid,
        run_id: Uuid,
    ) -> Result<bool, DbError> {
        let status = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                momo_agent::team_ai_task::run_status_in_tx(conn, workspace_id, run_id).await
            })
        })
        .await?;
        Ok(status == Some(RunStatus::Cancelled))
    }

    /// The note a task holds now (empty when the row is gone or ended).
    async fn team_ai_task_note(&self, workspace_id: Uuid, run_id: Uuid) -> String {
        with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move { store::load_in_tx(conn, workspace_id, run_id).await })
        })
        .await
        .ok()
        .flatten()
        .map(|row| row.note)
        .unwrap_or_default()
    }

    /// Give a step's claim back (best effort: an expired claim is taken over anyway).
    async fn team_ai_task_release(&self, workspace_id: Uuid, run_id: Uuid, token: Uuid) {
        let released = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(
                async move { store::release_claim_in_tx(conn, workspace_id, run_id, token).await },
            )
        })
        .await;
        if let Err(error) = released {
            tracing::warn!(run_id = %run_id, error = %error, "team ai task claim not released");
        }
    }

    /// The job ran out of attempts and the run failed for good (`settle_retryable`'s last attempt):
    /// end the run's task, if it has one, so its note does not outlive the run. Best effort — the
    /// sweep below closes whatever this misses.
    pub(crate) async fn team_ai_task_end_failed(&self, workspace_id: Uuid, run_id: Uuid) {
        let ended = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                store::end_in_tx(conn, workspace_id, run_id, store::END_FAILED).await
            })
        })
        .await;
        if let Err(error) = ended {
            tracing::warn!(run_id = %run_id, error = %error, "team ai task not ended with its failed run");
        }
    }

    /// The orphan sweep (B13-I7): close every active task whose run ended through a path that does
    /// not know tasks, so no note outlives its run. The read is cross-tenant (the worker's own
    /// BYPASSRLS connection, like the job claim); each write is one workspace's tenant transaction.
    /// Returns how many rows it closed.
    pub async fn sweep_orphan_tasks(&self) -> Result<u64, DbError> {
        let workspaces = {
            let mut conn = self.pool.acquire().await.map_err(DbError::from)?;
            store::workspaces_with_orphan_tasks(&mut conn, 50).await?
        };
        let mut closed = 0;
        for workspace_id in workspaces {
            closed += with_tenant_tx(&self.pool, workspace_id, move |conn| {
                Box::pin(async move { store::end_orphan_tasks_in_tx(conn, workspace_id).await })
            })
            .await?;
        }
        Ok(closed)
    }
}
