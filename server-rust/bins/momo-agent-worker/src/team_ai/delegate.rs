//! The team AI's **delegation to Hermes**, worker half (ADR-0201 증보 v4 P3~P9, #5370 = P14-S2).
//!
//! S1 (#5369) built the door: whether `ask_hermes` is on a request, and what a call is checked against. This
//! is what sits behind it. A delegation is **one step of the task mode** — not a wait inside the helper's
//! short turn (F3: the turn is 45 s, Hermes is an agent loop; F4: a wait would hold the helper's only
//! concurrent slot):
//!
//! 1. **The first turn ends** ([`AgentWorker::team_ai_delegation_begin`]): one transaction writes the task
//!    row with the delegation marker `pending` and the one request sentence, the progress line, the
//!    `delegate` activity and the resume job. The turn's own spend is on the ledger.
//! 2. **The resume step** ([`AgentWorker::run_team_ai_delegation_step`]) is the only code that calls Hermes:
//!    claim the step → re-judge the things that can change (the bundle, the target, the declarations, the
//!    pin) → **one transaction under the workspace lock** that re-judges the limits and writes `called`
//!    (the at-most-once marker, before any byte leaves) and stretches the claim to the worst time of what
//!    follows → **one request to Hermes** under its own deadline → the merging model call (no tools) →
//!    **one finishing transaction**: the message, the run's end, the helper's ledger row, the Hermes
//!    ledger row, the marker's move, the audit row, the row's end (the sentence gone).
//!
//! | rule | where |
//! |---|---|
//! | `called` before the call; a claim that meets it never calls (A12) | [`mark_called_in_tx`](momo_agent::team_ai_task::mark_called_in_tx) — the `delegation_state = 'pending'` predicate is the guard |
//! | a live claim on a `called` step is waited out, for as long as the lease lives and no longer | [`AgentWorker::team_ai_delegation_wait`] (the review's Low: not 8 attempts) |
//! | an expired claim on a `called` step ends `failed`, once, without a call | [`AgentWorker::team_ai_delegation_reclaimed`] |
//! | the limits are judged again under the lock (A9) | [`AgentWorker::delegation_commit_called`] |
//! | the body to Hermes: fixed instruction, clock, random mark, the sentence | [`momo_workspace_actions::team_ai_hermes_exec::system_message`] — and a [`ChatRequest`] with **no tools** |
//! | the answer is data; the merging call has no tools (A6) | [`merge`](AgentWorker::delegation_merge) |
//! | every ending of a `called` delegation writes one Hermes ledger row (A8, A13) | the settlement in `team_ai_finish`, and `end_in_tx` for the paths that never meet the answer |

use super::*;

use momo_agent::run_event::{append_run_event_in_tx, AppendedRunEvent};
use momo_agent::team_ai_task::{
    self as store, ClaimOutcome, CreateOutcome, DelegationMark, DelegationState, NewDelegation,
    NewTask, TaskRow,
};
use momo_outbox::{
    backoff_seconds, emit_outbox, requeue, OutboxKind, DEFAULT_WORKER_LEASE_SECONDS,
};
use momo_workspace_actions::team_ai_hermes_exec as exec;

/// Room kept between the stretched claim and the outbox job's lease: a job that is re-claimed after its
/// lease expired must always find the dead worker's claim expired too, or it would wait for nothing.
const LEASE_MARGIN_SECS: i64 = 15;
/// Seconds the stretched claim keeps beyond the worst time of the call and the merging (the commit, the
/// scheduler, a slow disk).
const CLAIM_SLACK_SECS: u64 = 30;
/// The activity of a delegation is one ledger id for its whole life (`s1_delegate`): `in_progress` at the
/// start, then `completed` or `failed`. It is the first step's id by design, whatever step ends it.
const ACTIVITY_STEP: i32 = 1;

/// The word of a kind (`web_search` / `image`) as a `&'static str`.
pub(super) fn kind_word(kind: &str) -> &'static str {
    match kind {
        "image" => "image",
        _ => "web_search",
    }
}

/// What the first turn hands to [`AgentWorker::team_ai_delegation_begin`]: the accepted call.
pub(super) struct DelegationStart {
    pub kind: HermesKind,
    /// The cleaned request sentence (2~1,200 characters). Lives in this value and in the task row.
    pub request: String,
    /// The Hermes's current display name, for the progress line (never for the body sent to Hermes).
    pub display_name: String,
}

impl std::fmt::Debug for DelegationStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "DelegationStart {{ kind: {:?}, request: <{} chars> }}",
            self.kind,
            self.request.chars().count()
        )
    }
}

/// How a delegation ended, as the transaction that finishes the run needs it — names and numbers only.
#[derive(Debug, Clone)]
pub(super) struct HermesSettlement {
    pub kind: &'static str,
    pub target: Uuid,
    /// The audit row's closed word: `ok` or one of [`DelegateCode`]'s.
    pub code: &'static str,
    /// `Some(done | failed)`: the marker moves and the Hermes ledger row is written. `None`: the
    /// delegation never reached `called` (nothing to settle, one audit row only).
    pub to: Option<DelegationState>,
    pub ms: i64,
    /// The ledger row: the label Hermes is known by and the tokens it reported, or an estimate.
    pub model: String,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub estimated: bool,
    /// The target's current display name, for the 「위임 결과 수신」 line.
    pub display_name: String,
}

/// One `team_ai.delegate` audit row (P11): run, kind, closed result code, ms, picture bytes (0 — this
/// slice sends no picture), the target agent's id. **Never the request sentence, an answer, or a
/// `MEDIA` line** (H9-I10).
#[allow(clippy::too_many_arguments)]
pub(super) async fn write_delegate_audit(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent: Uuid,
    kind: &str,
    target: Uuid,
    code: &str,
    ms: i64,
) -> Result<(), DbError> {
    audit::write_audit(
        conn,
        &AuditEntry::new(workspace_id, team_ai_hermes::AUDIT_DELEGATE)
            .by(agent)
            .about(target)
            .run(run_id)
            .with_schema(
                team_ai_hermes::AUDIT_DELEGATE_SCHEMA,
                json!({
                    "kind": kind,
                    "code": code,
                    "target": target.to_string(),
                    "ms": ms,
                    "picture_bytes": 0,
                }),
            ),
    )
    .await?;
    Ok(())
}

/// The progress line and the activity of a delegation that ended: 「위임 결과 수신: …」 when the answer came,
/// and the `delegate` activity `completed` / `failed`. A report the shared rule refuses is logged by
/// closed words and the delegation goes on — a decoration must not stop the run.
pub(super) async fn write_delegate_progress(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent: Uuid,
    settle: &HermesSettlement,
    to: DelegationState,
) -> Result<(), DbError> {
    if to == DelegationState::Done {
        append_run_event_in_tx(
            conn,
            workspace_id,
            run_id,
            AppendedRunEvent::Stage(&store::delegation_stage_label(
                &settle.display_name,
                settle.kind,
                true,
            )),
            agent,
        )
        .await?;
    }
    let status = if to == DelegationState::Done {
        "completed"
    } else {
        "failed"
    };
    if let store::ProgressWrite::Refused(fault) = store::record_delegate_activity_in_tx(
        conn,
        workspace_id,
        run_id,
        agent,
        ACTIVITY_STEP,
        status,
    )
    .await?
    {
        tracing::warn!(
            run_id = %run_id,
            field = fault.field.as_str(),
            rule = fault.rule.as_str(),
            "team ai delegation: a progress report was refused by the shared rule"
        );
    }
    Ok(())
}

/// How the first turn's attempt to start a delegation ended.
enum Began {
    Started,
    /// Too many tasks are running, or the run has no step left to spend.
    Busy,
    /// The `hermes` bundle was switched off while the model was thinking (B13-I5).
    RoleOff,
    /// A row for the run already exists: another attempt of this very turn started it.
    AlreadyExists,
    /// The run is cancelled or gone.
    Gone,
}

/// What the `called` commit decided.
enum Called {
    /// This step owns the call: the sentence, the Hermes it goes to, the label to write on its ledger row.
    Go {
        request: String,
        target: Uuid,
        display_name: String,
    },
    /// A limit closed the door at the moment of the commit (P2 G6, judged under the lock).
    Limit(DelegateCode),
    /// A gate that can change (the target, the bundle's pin) no longer holds.
    Unavailable,
    /// The `hermes` bundle is off now (B13-I5).
    RoleOff,
    /// A person stopped the run.
    Cancelled,
    /// The run or the helper is gone.
    Gone,
    /// The marker was not `pending` for this claim any more: someone else holds or has made the call.
    Lost,
}

/// What came back from the one request to Hermes.
enum HermesReply {
    Answer {
        text: String,
        usage: Option<ChatUsage>,
        ms: i64,
        /// The label the Hermes ledger row carries (the pin's model, or the worker's default).
        label: String,
    },
    Failed {
        code: DelegateCode,
        ms: i64,
        label: String,
    },
}

/// The merging call's outcome.
enum Merged {
    Text(String),
    /// The model called a tool it was not offered, or both attempts produced nothing usable.
    Failed,
}

/// The `Ending::Closed` code of a delegation that ends in a fixed sentence — a closed word per code, so a
/// run's error code tells an operator what happened without a line of Hermes's words.
fn closed_code(code: DelegateCode) -> &'static str {
    match code {
        DelegateCode::CapReached => "hermes_cap_reached",
        DelegateCode::RateLimited => "hermes_rate_limited",
        DelegateCode::Busy => "hermes_busy",
        DelegateCode::Timeout => "hermes_timeout",
        DelegateCode::Unavailable => "hermes_unavailable",
        DelegateCode::NoTool => "hermes_no_tool",
        DelegateCode::Refused => "hermes_refused",
        DelegateCode::PictureFailed => "hermes_picture_failed",
        _ => "hermes_failed",
    }
}

/// A transport or HTTP failure of the one request, as the closed code a person is told (P9). Hermes's own
/// words are never kept: the status number is all that is read.
fn reply_code(error: &ProviderError) -> DelegateCode {
    match error {
        ProviderError::TimedOut(_) => DelegateCode::Timeout,
        // A busy Hermes says so with 429/503 (T5): "a moment later", not "it broke".
        ProviderError::HttpStatus(429 | 503, _) => DelegateCode::Busy,
        ProviderError::Unreachable(_) | ProviderError::EgressDenied(_) => DelegateCode::Unavailable,
        ProviderError::HttpStatus(status, _) if *status >= 500 => DelegateCode::Unavailable,
        _ => DelegateCode::Failed,
    }
}

impl AgentWorker {
    /// The first turn's call of `ask_hermes` passed every check: **start the delegation** — one
    /// transaction, or a fixed sentence. Nothing is half-started, and **Hermes is not called here**.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn team_ai_delegation_begin(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        candidates: &[(Uuid, String, String)],
        start: DelegationStart,
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
        let audit_detail = audit_trace.audit_detail(spend, "delegation_started");
        let stage = store::delegation_stage_label(&start.display_name, start.kind.as_str(), false);
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
            let ledger = ledger.clone();
            let model = model_owned.clone();
            let audit_detail = audit_detail.clone();
            let job_payload = job_payload.clone();
            let stage = stage.clone();
            let request = start.request.clone();
            let kind = start.kind;
            Box::pin(async move {
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    store::end_in_tx(conn, workspace_id, run_id, store::END_AGENT_GONE).await?;
                    return Ok(Began::Gone);
                };
                // What this turn spent is real whatever comes of the delegation: written first.
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
                // B13-I5, third fence — and the bundle that matters to a delegation is `hermes`, not
                // `long_research` (F17, P4-4): read as it is NOW.
                if !team_ai::read_roles_in_tx(conn, workspace_id)
                    .await?
                    .is_on(momo_agent::team_ai_roles::HERMES)
                {
                    return Ok(Began::RoleOff);
                }
                let new = NewTask {
                    workspace_id,
                    run_id,
                    agent_member_id: agent,
                    plan: &[],
                    note: "",
                    model_calls,
                    tool_calls,
                    web_searches: searches,
                };
                let delegation = NewDelegation {
                    kind: kind.as_str(),
                    request: &request,
                };
                match store::create_with_delegation_in_tx(
                    conn,
                    &new,
                    requester_id,
                    &limits,
                    Some(&delegation),
                )
                .await?
                {
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
                    AppendedRunEvent::Stage(&stage),
                    agent,
                )
                .await?;
                if let store::ProgressWrite::Refused(fault) = store::record_delegate_activity_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                    agent,
                    ACTIVITY_STEP,
                    "in_progress",
                )
                .await?
                {
                    tracing::warn!(
                        run_id = %run_id,
                        field = fault.field.as_str(),
                        rule = fault.rule.as_str(),
                        "team ai delegation: a progress report was refused by the shared rule"
                    );
                }
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
                tracing::info!(run_id = %run_id, "team ai delegation started");
                self.settle_done(job.id, Some("team ai delegation started"))
                    .await;
                Settlement::Skipped
            }
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
                    Some(momo_agent::tools::ASK_HERMES),
                )
                .await
            }
            Ok(Began::AlreadyExists) => {
                self.settle_done(job.id, Some(store::SkipReason::StepDone.as_str()))
                    .await;
                Settlement::Skipped
            }
            Ok(Began::Gone) => {
                self.settle_done(job.id, Some("team ai delegation: run is gone or cancelled"))
                    .await;
                Settlement::Skipped
            }
            Err(error) => {
                self.settle_retryable(
                    job,
                    &format!("team ai delegation start failed: {error}"),
                    &crate::personal::neutral_endpoint(),
                )
                .await
            }
        }
    }

    /// The seconds the claim is stretched to when `called` is written: the call's own deadline, the
    /// merging's two attempts and a slack — never past the outbox job's lease less a margin (a re-claimed
    /// job must find an expired claim, F18).
    fn delegation_claim_secs(&self, kind: HermesKind) -> i64 {
        let worst = self.config.hermes_deadlines.of(kind).as_secs()
            + 2 * self.config.team_ai_model_timeout.as_secs()
            + CLAIM_SLACK_SECS;
        i64::try_from(worst)
            .unwrap_or(i64::MAX)
            .clamp(1, DEFAULT_WORKER_LEASE_SECONDS - LEASE_MARGIN_SECS)
    }

    /// Run the delegation step (`step >= 2` of a row that carries the marker). `gathered` was read at the
    /// top of the job: the task row, the run's status and the requester derived again from the run row.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_team_ai_delegation_step(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        transport: &mut ResolvedTransport,
        gathered: Gathered,
        step: i32,
        task: TaskRow,
    ) -> Settlement {
        let workspace_id = job.workspace_id;
        let agent = payload.agent_member_id;
        let model = payload.model_or(&self.config.default_model).to_string();
        let wire = transport.endpoint.wire;
        let mut trace = TurnTrace {
            model: model.clone(),
            wire: wire.as_str(),
            task_step: Some(step),
            ..TurnTrace::default()
        };
        let Some(mark) = task.delegation.clone() else {
            self.settle_done(job.id, Some(store::SkipReason::NoTask.as_str()))
                .await;
            return Settlement::Skipped;
        };

        // The run itself: a stop is honoured before anything costs; a run that ended through a path that
        // does not know tasks closes the row (`end_in_tx` settles a called delegation on the way).
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
        // B5-6: no human who asked, no delegation. (Silent, like the quick path's no-requester close.)
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
        if !gathered.state.enabled {
            return self
                .team_ai_close(job, payload, run_id, "team_ai_disabled")
                .await;
        }
        // A marker that already finished while the row is still active is not a thing this code writes
        // (the marker and the row end in one transaction); close the row rather than run anything.
        if matches!(mark.state, DelegationState::Done | DelegationState::Failed) {
            return self
                .team_ai_task_drop(job, payload, run_id, None, 0, &model, store::END_FAILED)
                .await;
        }
        if mark.state == DelegationState::Pending
            && transport.needs_refresh(crate::now_ms())
            && self.refresh_and_reseal(transport).await.is_err()
        {
            return self
                .team_ai_task_interim(
                    job,
                    payload,
                    run_id,
                    team_ai::TASK_PROVIDER_ERROR_SENTENCE,
                    "",
                    store::END_PROVIDER_ERROR,
                    None,
                    &trace,
                )
                .await;
        }

        // The step is executed under a claim: of two jobs for one step, one proceeds.
        let token = job.lease_id;
        let claimed = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                store::claim_step_in_tx(conn, workspace_id, run_id, step, token).await
            })
        })
        .await;
        let claimed_row = match claimed {
            Ok(ClaimOutcome::Claimed(row)) => row,
            Ok(ClaimOutcome::Taken) => {
                return self
                    .team_ai_delegation_wait(job, workspace_id, run_id)
                    .await
            }
            Ok(ClaimOutcome::Gone) => {
                self.settle_done(job.id, Some(store::SkipReason::StepDone.as_str()))
                    .await;
                return Settlement::Skipped;
            }
            Err(error) => {
                return self
                    .settle_retryable(
                        job,
                        &format!("team ai delegation claim failed: {error}"),
                        &transport.endpoint,
                    )
                    .await
            }
        };
        let Some(mark) = claimed_row.delegation.clone() else {
            self.settle_done(job.id, Some(store::SkipReason::NoTask.as_str()))
                .await;
            return Settlement::Skipped;
        };
        let kind = HermesKind::parse(&mark.kind);

        // I5: the marker says a call may have happened. This claim is the one that outlived the first
        // worker's — it never calls again; the honest ending is `failed` (T7: no picture twice).
        if mark.state != DelegationState::Pending {
            return self
                .team_ai_delegation_reclaimed(job, payload, run_id, &model, &mark, trace)
                .await;
        }
        let Some(kind) = kind else {
            return self
                .team_ai_delegation_unavailable(job, payload, run_id, &model, trace, &mark, None)
                .await;
        };

        // The team's own usage limits (B9) judge the merging call this step is about to make, exactly as
        // they judge any step.
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
                    "",
                    store::END_LIMIT,
                    None,
                    &trace,
                )
                .await;
        }

        // P4-5: the gates that can change between the advertisement and now, judged again. The bundle and
        // the target are read inside the `called` transaction; what the process itself holds (the
        // declarations, the kind, the search switches) and the pin are judged here, right before it.
        let web = WebSearch::judge(
            gathered.state.web_search,
            caps.search_off(),
            wire_searches(wire),
            team_ai_limits::search_cap(&gathered.state.limits, &caps)
                .is_some_and(|cap| gathered.searches_today >= cap),
        );
        let gates_hold = self.config.hermes.g4().is_ok()
            && self.config.hermes.declares(kind)
            // `image` waits for the attachment write path (S4): it is never callable before it
            && (kind != HermesKind::Image || team_ai_hermes::ATTACHMENT_WRITE_PATH_READY)
            // T14: the administrator's search switch and the operator's `0` close Hermes's search too,
            // also for a request that was already on its way when they were thrown
            && (kind != HermesKind::WebSearch
                || !matches!(web, WebSearch::Off | WebSearch::OperatorOff));
        let pre_target = if gates_hold {
            self.delegation_pre_target(workspace_id, agent, requester.member_id)
                .await
        } else {
            None
        };
        let Some(pre_target) = pre_target else {
            return self
                .team_ai_delegation_unavailable(
                    job,
                    payload,
                    run_id,
                    &model,
                    trace,
                    &mark,
                    Some(kind),
                )
                .await;
        };

        // The `called` commit (the at-most-once marker) under the workspace lock.
        let claim_secs = self.delegation_claim_secs(kind);
        let called = self
            .delegation_commit_called(
                workspace_id,
                agent,
                run_id,
                token,
                &requester,
                pre_target,
                claim_secs,
                &caps,
            )
            .await;
        let (request, target, display_name) = match called {
            Ok(Called::Go {
                request,
                target,
                display_name,
            }) => (request, target, display_name),
            Ok(Called::Limit(code)) => {
                return self
                    .team_ai_delegation_ended_without_call(
                        job, payload, run_id, &model, trace, &mark, kind, code,
                    )
                    .await
            }
            Ok(Called::Unavailable) => {
                return self
                    .team_ai_delegation_unavailable(
                        job,
                        payload,
                        run_id,
                        &model,
                        trace,
                        &mark,
                        Some(kind),
                    )
                    .await
            }
            Ok(Called::RoleOff) => {
                return self
                    .team_ai_finish(
                        job,
                        payload,
                        run_id,
                        Some(team_ai::ROLE_OFF_SENTENCE.to_string()),
                        json!({}),
                        None,
                        &model,
                        Ending::Closed(store::END_ROLE_OFF),
                        Some(trace),
                    )
                    .await
            }
            Ok(Called::Cancelled) => {
                return self
                    .team_ai_task_drop(job, payload, run_id, None, 0, &model, store::END_CANCELLED)
                    .await
            }
            Ok(Called::Gone) | Ok(Called::Lost) => {
                self.settle_done(job.id, Some("team ai delegation: not ours to call"))
                    .await;
                return Settlement::Skipped;
            }
            Err(error) => {
                self.team_ai_task_release(workspace_id, run_id, token).await;
                return self
                    .settle_retryable(
                        job,
                        &format!("team ai delegation commit failed: {error}"),
                        &transport.endpoint,
                    )
                    .await;
            }
        };

        // From here the sentence has left the database for this worker's memory, and the marker says
        // `called`: whatever happens, nothing in this job (or any other) sends it again.
        let started = Instant::now();
        // A stop that landed between the commit and the request: nothing is sent (the cancel route has
        // already ended the row and settled the ledger).
        if self
            .team_ai_task_stopped(workspace_id, run_id)
            .await
            .unwrap_or(false)
        {
            return self
                .team_ai_task_drop(job, payload, run_id, None, 0, &model, store::END_CANCELLED)
                .await;
        }
        let reply = self
            .delegation_call(workspace_id, target, kind, &request)
            .await;
        trace.hermes = Some(HermesTrace {
            offered: vec![kind.as_str()],
            ..HermesTrace::default()
        });

        let (code, to, usage_row, merge_input) = match reply {
            HermesReply::Failed { code, ms, label } => {
                let settle = HermesSettlement {
                    kind: kind.as_str(),
                    target,
                    code: code.as_str(),
                    to: Some(DelegationState::Failed),
                    ms,
                    model: label,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    estimated: true,
                    display_name,
                };
                if let Some(hermes) = trace.hermes.as_mut() {
                    hermes.results.push(code.as_str());
                    hermes.settle = Some(settle);
                }
                trace.latency_ms = millis(started);
                return self
                    .team_ai_finish(
                        job,
                        payload,
                        run_id,
                        Some(exec::fixed_sentence(code).to_string()),
                        json!({}),
                        None,
                        &model,
                        Ending::Closed(closed_code(code)),
                        Some(trace),
                    )
                    .await;
            }
            HermesReply::Answer {
                text,
                usage,
                ms,
                label: hermes_label,
            } => {
                let answer = exec::clean_answer(&text);
                let (prompt_tokens, completion_tokens, estimated) = match usage {
                    Some(usage) => (usage.prompt_tokens, usage.completion_tokens, false),
                    None => (
                        i32::try_from(request.chars().count() / 3 + 1).unwrap_or(i32::MAX),
                        i32::try_from(text.chars().count() / 3 + 1).unwrap_or(i32::MAX),
                        true,
                    ),
                };
                let usage_row = (
                    hermes_label,
                    prompt_tokens,
                    completion_tokens,
                    estimated,
                    ms,
                );
                if answer.is_empty() {
                    (
                        DelegateCode::Failed,
                        DelegationState::Failed,
                        usage_row,
                        None,
                    )
                } else {
                    let shown =
                        exec::result_for_model(kind, &answer).render(momo_agent::tools::ASK_HERMES);
                    (
                        DelegateCode::Failed,
                        DelegationState::Done,
                        usage_row,
                        Some(shown),
                    )
                }
            }
        };
        let (label, prompt_tokens, completion_tokens, estimated, ms) = usage_row;
        let settle_for = |code: &'static str, to: DelegationState| HermesSettlement {
            kind: kind.as_str(),
            target,
            code,
            to: Some(to),
            ms,
            model: label.clone(),
            prompt_tokens,
            completion_tokens,
            estimated,
            display_name: display_name.clone(),
        };

        // Hermes answered nothing usable: the fixed `failed` sentence, no merging call.
        let Some(shown) = merge_input else {
            if let Some(hermes) = trace.hermes.as_mut() {
                hermes.results.push(code.as_str());
                hermes.settle = Some(settle_for(code.as_str(), to));
            }
            trace.latency_ms = millis(started);
            return self
                .team_ai_finish(
                    job,
                    payload,
                    run_id,
                    Some(exec::fixed_sentence(code).to_string()),
                    json!({}),
                    None,
                    &model,
                    Ending::Closed(closed_code(code)),
                    Some(trace),
                )
                .await;
        };

        // P4-7: the merging call. A stop is read first; the call has NO tool of any kind.
        if self
            .team_ai_task_stopped(workspace_id, run_id)
            .await
            .unwrap_or(false)
        {
            return self
                .team_ai_finish(
                    job,
                    payload,
                    run_id,
                    None,
                    json!({}),
                    None,
                    &model,
                    Ending::Closed(store::END_CANCELLED),
                    Some(trace),
                )
                .await;
        }
        let mut spend: Option<Spend> = None;
        let merged = self
            .delegation_merge(
                transport,
                &model,
                &gathered.trigger_text,
                &shown,
                &mut trace,
                &mut spend,
            )
            .await;
        trace.latency_ms = millis(started);
        match merged {
            Merged::Text(text) => {
                if let Some(hermes) = trace.hermes.as_mut() {
                    hermes.results.push(team_ai_hermes::AUDIT_CODE_OK);
                    hermes.settle = Some(settle_for(
                        team_ai_hermes::AUDIT_CODE_OK,
                        DelegationState::Done,
                    ));
                }
                // P8: the chip. A key only the server writes (`DELEGATED_PROPS_KEY` is stripped from every
                // person's and webhook's props).
                let props = json!({
                    momo_agent::team_ai_task::DELEGATED_PROPS_KEY: [
                        {"kind": kind.as_str(), "agent_member_id": target}
                    ]
                });
                let text: String = text.chars().take(team_ai::ANSWER_CHARS_MAX).collect();
                self.team_ai_finish(
                    job,
                    payload,
                    run_id,
                    Some(text),
                    props,
                    spend,
                    &model,
                    Ending::Answered,
                    Some(trace),
                )
                .await
            }
            Merged::Failed => {
                // Hermes answered but the helper could not write it up: the delegation counts as failed
                // for the person (a fixed sentence — Hermes's words are never posted as they are).
                if let Some(hermes) = trace.hermes.as_mut() {
                    hermes.results.push(DelegateCode::Failed.as_str());
                    hermes.settle = Some(settle_for(
                        DelegateCode::Failed.as_str(),
                        DelegationState::Failed,
                    ));
                }
                self.team_ai_finish(
                    job,
                    payload,
                    run_id,
                    Some(exec::fixed_sentence(DelegateCode::Failed).to_string()),
                    json!({}),
                    spend,
                    &model,
                    Ending::Closed(closed_code(DelegateCode::Failed)),
                    Some(trace),
                )
                .await
            }
        }
    }

    /// G3 (+G5) right before the commit: the one Hermes this requester's delegation goes to, and whether
    /// its `operator_env` pin still resolves — `None` when either fails.
    async fn delegation_pre_target(
        &self,
        workspace_id: Uuid,
        helper: Uuid,
        requester: Uuid,
    ) -> Option<Uuid> {
        let pinned = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                team_ai_hermes::pinned_agents_in_tx(conn, workspace_id, helper).await
            })
        })
        .await
        .ok()?;
        let TargetResolution::One(one) = team_ai_hermes::resolve_target(&pinned, requester) else {
            return None;
        };
        match self.resolve_agent_pin(workspace_id, one.member_id).await {
            crate::PinOutcome::Applied(_, _, momo_settings::PinKind::OperatorEnv) => {
                Some(one.member_id)
            }
            _ => None,
        }
    }

    /// **The `called` commit** (ADR-0201 증보 v4 P4-5, P7): one transaction that, under the workspace lock,
    /// re-judges the bundle and the target, re-counts the day's, the requester's and the concurrent
    /// delegations (a delegation in flight counts — the count reads the marker, not the ledger) and — only
    /// if there is room — writes `called` and stretches the claim. The lock is what makes the overshoot
    /// zero: two delegations that reach the last free slot together are serialised here, and the second
    /// one sees the first one's `called`.
    #[allow(clippy::too_many_arguments)]
    async fn delegation_commit_called(
        &self,
        workspace_id: Uuid,
        helper: Uuid,
        run_id: Uuid,
        token: Uuid,
        requester: &momo_agent::card_suggest::SuggestionRequester,
        pre_target: Uuid,
        claim_secs: i64,
        caps: &team_ai_limits::OperatorCaps,
    ) -> Result<Called, DbError> {
        let requester_id = requester.member_id;
        let caps = *caps;
        let bounds_base = (
            team_ai_hermes::REQUESTER_WINDOW_MAX,
            team_ai_hermes::CONCURRENT_MAX,
            self.config.team_ai_task.max_per_workspace,
            self.config.team_ai_task.max_per_requester,
        );
        with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The same order as the start (the run's row, then the workspace lock): no deadlock between
                // the two writers of a delegation.
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    store::end_in_tx(conn, workspace_id, run_id, store::END_AGENT_GONE).await?;
                    return Ok(Called::Gone);
                };
                if snapshot.status == RunStatus::Cancelled {
                    return Ok(Called::Cancelled);
                }
                // G1, as it is now.
                let state = team_ai::read_state_in_tx(conn, workspace_id).await?;
                if !state.roles.is_on(momo_agent::team_ai_roles::HERMES) {
                    return Ok(Called::RoleOff);
                }
                // G3, as it is now: exactly one Hermes, and the one the pin was checked for.
                let pinned =
                    team_ai_hermes::pinned_agents_in_tx(conn, workspace_id, helper).await?;
                let TargetResolution::One(target) =
                    team_ai_hermes::resolve_target(&pinned, requester_id)
                else {
                    return Ok(Called::Unavailable);
                };
                if target.member_id != pre_target {
                    return Ok(Called::Unavailable);
                }
                // G6, the authoritative judgement, under the workspace lock: counts from the marker, bounds
                // as they are now. The two task bounds were enforced when the row was created under this
                // same lock and a delegation is itself the task they count, so they are not asked again.
                let bounds = team_ai_hermes::DelegationBounds {
                    day_cap: team_ai_limits::delegation_cap(&state.limits, &caps),
                    requester_window_max: bounds_base.0,
                    concurrent_max: bounds_base.1,
                    tasks_workspace_max: bounds_base.2,
                    tasks_requester_max: bounds_base.3,
                };
                let committed = store::commit_called_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                    token,
                    requester_id,
                    target.member_id,
                    claim_secs,
                    team_ai_hermes::REQUESTER_WINDOW_SECS,
                    |counts| {
                        let usage = team_ai_hermes::DelegationUsage {
                            today: counts.today,
                            requester_recent: counts.requester_recent,
                            in_flight: counts.in_flight,
                            tasks_workspace: 0,
                            tasks_requester: 0,
                        };
                        team_ai_hermes::judge_limits(&bounds, &usage)
                            .err()
                            .map(|problem| match problem {
                                team_ai_hermes::LimitProblem::RequesterRate => {
                                    DelegateCode::RateLimited
                                }
                                team_ai_hermes::LimitProblem::Concurrent => DelegateCode::Busy,
                                _ => DelegateCode::CapReached,
                            })
                    },
                )
                .await?;
                Ok(match committed {
                    store::CalledCommit::Go(request) => Called::Go {
                        request,
                        target: target.member_id,
                        display_name: target.display_name,
                    },
                    store::CalledCommit::Refused(code) => Called::Limit(code),
                    store::CalledCommit::Lost => Called::Lost,
                })
            })
        })
        .await
    }

    /// **The one request to Hermes** (P3): a new conversation, `[system, user]`, no history, no `tools`, no
    /// `user` field, no session header — the shipped chat/completions body of an empty-tools request, plus
    /// the pin's `provider` when it chose one. Under its own deadline (kind-wise), once: no retry, whatever
    /// the failure (I5: a repeat is a second picture, a second search, a second charge on the subscription).
    async fn delegation_call(
        &self,
        workspace_id: Uuid,
        target: Uuid,
        kind: HermesKind,
        request: &str,
    ) -> HermesReply {
        let started = Instant::now();
        let pin = self.resolve_agent_pin(workspace_id, target).await;
        let crate::PinOutcome::Applied(hermes, route, momo_settings::PinKind::OperatorEnv) = pin
        else {
            return HermesReply::Failed {
                code: DelegateCode::Unavailable,
                ms: millis(started),
                label: store::HERMES_LEDGER_MODEL.to_string(),
            };
        };
        let (provider, model) = match route {
            Some(route) => (Some(route.provider), route.model),
            None => (None, self.config.default_model.clone()),
        };
        let label = model.clone();
        let mark = Uuid::new_v4().simple().to_string();
        let system = exec::system_message(
            kind,
            &crate::context::now_context_block(crate::now_ms(), self.config.utc_offset_minutes),
            &mark,
        );
        let chat = ChatRequest {
            provider,
            model,
            messages: vec![
                ChatMessage::system(system),
                ChatMessage::user(exec::user_message(request)),
            ],
            max_tokens: Some(exec::HERMES_MAX_TOKENS),
            tools: Vec::new(),
            momo_tools: Vec::new(),
        };
        let deadline = self.config.hermes_deadlines.of(kind);
        let attempt =
            tokio::time::timeout(deadline, self.provider.complete(&hermes.endpoint, &chat)).await;
        let ms = millis(started);
        match attempt {
            Err(_elapsed) => HermesReply::Failed {
                code: DelegateCode::Timeout,
                ms,
                label,
            },
            Ok(Err(error)) => {
                // names only: the error's own words may echo Hermes's body
                tracing::warn!(
                    run_target = %target,
                    code = reply_code(&error).as_str(),
                    "team ai delegation: the request to Hermes failed"
                );
                HermesReply::Failed {
                    code: reply_code(&error),
                    ms,
                    label,
                }
            }
            Ok(Ok(completion)) => HermesReply::Answer {
                text: completion.text,
                usage: completion.usage,
                ms,
                label,
            },
        }
    }

    /// **The merging call** (P4-7, A6): the second model call, and it has no tool of any kind — no read, no
    /// web search, no `task_continue`, no card, no proposal. Hermes's answer reaches it as the fenced data
    /// block and nothing else; a model that calls a tool anyway ends the delegation with the fixed
    /// `failed` sentence. At most two attempts (the first one failing on the provider's side).
    async fn delegation_merge(
        &self,
        transport: &ResolvedTransport,
        model: &str,
        trigger_text: &str,
        shown: &str,
        trace: &mut TurnTrace,
        spend: &mut Option<Spend>,
    ) -> Merged {
        let messages = vec![
            ChatMessage::system(exec::MERGE_SYSTEM_PROMPT.to_string()),
            ChatMessage::user(team_ai::user_turn(trigger_text)),
            ChatMessage {
                role: "assistant".to_string(),
                content: format!("({} 호출)", momo_agent::tools::ASK_HERMES),
            },
            ChatMessage::user(shown.to_string()),
        ];
        let prompt_chars: usize = messages
            .iter()
            .map(|message| message.content.chars().count())
            .sum();
        for _attempt in 0..2 {
            let request = ChatRequest {
                provider: None,
                model: model.to_string(),
                messages: messages.clone(),
                max_tokens: Some(team_ai::MAX_OUTPUT_TOKENS),
                tools: Vec::new(),
                momo_tools: Vec::new(),
            };
            let attempt = tokio::time::timeout(
                self.config.team_ai_model_timeout,
                self.provider.complete(&transport.endpoint, &request),
            )
            .await;
            trace.model_calls += 1;
            match attempt {
                Ok(Ok(completion)) => {
                    *spend = Spend::add(*spend, Spend::of(completion.usage, prompt_chars));
                    trace.web_searches += completion.web_search_requests.max(0);
                    if !completion.tool_calls.is_empty() {
                        // Offered nothing, so any call is off-script: no second chance.
                        return Merged::Failed;
                    }
                    let text = completion.text.trim().to_string();
                    if !text.is_empty() {
                        return Merged::Text(text);
                    }
                }
                _ => {
                    *spend = Spend::add(*spend, Spend::of(None, prompt_chars));
                }
            }
        }
        Merged::Failed
    }

    /// Another worker holds a live claim on this very step. **Wait out the lease and not one attempt
    /// longer, nor shorter** (the review's Low): the job comes back when the claim has expired (or after
    /// the usual backoff if that is sooner), and the attempts count does not end the delegation — a
    /// delegation that ended at attempt 8 (≈182 s of backoff) could end while the first worker's claim
    /// was still alive and its answer on the way. The claim is bounded (`mark_called_in_tx` never stretches
    /// it past the outbox lease), so the wait is too.
    async fn team_ai_delegation_wait(
        &self,
        job: &ClaimedAgentJob,
        workspace_id: Uuid,
        run_id: Uuid,
    ) -> Settlement {
        let remaining = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(
                async move { store::claim_remaining_secs_in_tx(conn, workspace_id, run_id).await },
            )
        })
        .await
        .ok()
        .flatten();
        let delay = match remaining {
            Some(left) => backoff_seconds(job.attempts).clamp(1, left.saturating_add(1)),
            None => 1,
        };
        if let Err(error) = requeue(
            &self.pool,
            job.id,
            delay,
            "team ai delegation step is held by another worker",
        )
        .await
        {
            tracing::error!(outbox_id = job.id, error = %error, "requeue failed");
        }
        Settlement::Requeued
    }

    /// A claim that is ours and a marker that is not `pending`: a worker went before us and may or may not
    /// have called Hermes. **No call, ever** — the delegation ends `failed` with the fixed sentence, once,
    /// and the Hermes ledger row is written by the settlement (T7, A12).
    async fn team_ai_delegation_reclaimed(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        model: &str,
        mark: &DelegationMark,
        mut trace: TurnTrace,
    ) -> Settlement {
        let kind = kind_word(&mark.kind);
        if let Some(target) = mark.target {
            trace.hermes = Some(HermesTrace {
                offered: vec![kind],
                results: vec![DelegateCode::Failed.as_str()],
                settle: Some(HermesSettlement {
                    kind,
                    target,
                    code: DelegateCode::Failed.as_str(),
                    to: Some(DelegationState::Failed),
                    ms: 0,
                    model: store::HERMES_LEDGER_MODEL.to_string(),
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    estimated: true,
                    display_name: String::new(),
                }),
            });
        }
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(exec::fixed_sentence(DelegateCode::Failed).to_string()),
            json!({}),
            None,
            model,
            Ending::Closed(closed_code(DelegateCode::Failed)),
            Some(trace),
        )
        .await
    }

    /// A gate that can change no longer holds (the target, the declarations, the pin, a switch): Hermes is
    /// not called and the person gets the fixed `unavailable` sentence (P4-5). The marker is `pending`, so
    /// there is no ledger row; the audit row says how it ended.
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_delegation_unavailable(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        model: &str,
        trace: TurnTrace,
        mark: &DelegationMark,
        kind: Option<HermesKind>,
    ) -> Settlement {
        let kind = kind
            .or_else(|| HermesKind::parse(&mark.kind))
            .unwrap_or(HermesKind::WebSearch);
        self.team_ai_delegation_ended_without_call(
            job,
            payload,
            run_id,
            model,
            trace,
            mark,
            kind,
            DelegateCode::Unavailable,
        )
        .await
    }

    /// The delegation ends with a fixed sentence and **without a call** — a limit, or a gate that closed
    /// (`pending` marker: nothing to settle, one audit row).
    #[allow(clippy::too_many_arguments)]
    async fn team_ai_delegation_ended_without_call(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        model: &str,
        mut trace: TurnTrace,
        mark: &DelegationMark,
        kind: HermesKind,
        code: DelegateCode,
    ) -> Settlement {
        let target = mark.target;
        trace.hermes = Some(HermesTrace {
            offered: vec![kind.as_str()],
            results: vec![code.as_str()],
            // The audit row needs a target; the marker has none until `called`. The row names the helper's
            // own member when no Hermes was ever resolved — it is an id, not a name.
            settle: Some(HermesSettlement {
                kind: kind.as_str(),
                target: target.unwrap_or(payload.agent_member_id),
                code: code.as_str(),
                to: None,
                ms: 0,
                model: store::HERMES_LEDGER_MODEL.to_string(),
                prompt_tokens: 0,
                completion_tokens: 0,
                estimated: true,
                display_name: String::new(),
            }),
        });
        self.team_ai_finish(
            job,
            payload,
            run_id,
            Some(exec::fixed_sentence(code).to_string()),
            json!({}),
            None,
            model,
            Ending::Closed(closed_code(code)),
            Some(trace),
        )
        .await
    }
}
