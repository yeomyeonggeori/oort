//! #4820 C2b 2부 — the worker's half of the hosted expression door (ADR-0218 증보 G3.7 (b), G3.8, G4, G6).
//!
//! A turn of an agent pinned to the co-hosted Hermes **whose trigger message carries the requester's own
//! photo** is a *door turn*: the model is called without streaming (Hermes turns a `MEDIA:` line into the
//! `data:image/…` address only in a final, non-streamed answer), and the one answer is taken apart by
//! [`momo_workspace_actions::hosted_expression`] — its picture and its one request block — into a card.
//! Every other turn (no photo, a welcome, a resume, any other agent) never reaches this module and is
//! byte-for-byte what it was.
//!
//! The order, and why:
//!
//! 1. **[`AgentWorker::hosted_door_open`], before the model.** Is there a photo (the one definition the
//!    address mint also asks)? Did the operator attest strict media delivery (`OORT_HOSTED_MEDIA_STRICT=1`)?
//!    Is the run still running, did a live person ask, is the agent under its ceiling of waiting cards?
//!    These are the cheap refusals (#4829): none of them costs a model call, a picture or a decoder slot.
//! 2. **The model, non-streaming**, in `process()`.
//! 3. **[`AgentWorker::hosted_door_land`], after it.** The answer is opened; no valid request block means
//!    an ordinary answer (the cleaned text); a valid one becomes candidates and a card, or — when the
//!    picture or the motion failed — a failure card with a closed code. The cleaned text is the only text
//!    ever committed: no picture, no `MEDIA:` line, no request block.

use momo_agent::{
    finish_run_in_tx, lock_gateway_run_in_tx, record_run_usage_in_tx, RunStatus, RunUsageReport,
};
use momo_db::with_tenant_tx;
use momo_workspace_actions::hosted_expression::{
    self as door, Block, DoorRequest, DoorRun, FailureCard, Gate, Prepared, Raised, Refusal,
};
use serde_json::json;
use uuid::Uuid;

use crate::payload::AgentJobPayload;
use crate::provider::{ChatUsage, ProviderEndpoint};
use crate::{emit_terminal_agent_status, AgentWorker, ClaimedAgentJob, Settlement};

/// What the person is told when the agent already has all its cards waiting. Said **before** the
/// model is called, so it is the whole answer.
pub(crate) const CAPPED_SENTENCE: &str = "승인을 기다리는 카드가 이미 많아요. 먼저 처리해 주세요.";
/// …when the same person already has a card of this kind waiting.
const TARGET_BUSY_SENTENCE: &str =
    "같은 사람에게 승인을 기다리는 카드가 있어요. 그 카드를 먼저 처리해 주세요.";
/// …when the card could not be raised from what the answer asked for (a face that is not a person of
/// this conversation, a policy the workspace does not meet).
const NOT_RAISED_SENTENCE: &str =
    "이 요청으로는 카드를 만들 수 없었어요. 사진에 나온 사람이 이 대화의 멤버인지 확인해 주세요.";

/// A turn that opens the door.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DoorTurn;

/// What [`AgentWorker::hosted_door_open`] decided before the model.
pub(crate) enum DoorOpen {
    /// Not a photo turn: nothing about this turn changes.
    NotAPhotoTurn,
    /// A photo turn with the door open: call the model without streaming and land the answer.
    Turn(DoorTurn),
    /// The turn is over (a card, a sentence, a retry, a suppression).
    Settled(Settlement),
}

/// What [`AgentWorker::hosted_door_land`] made of the answer.
pub(crate) enum Landed {
    /// Continue as an ordinary answer with this text (the cleaned text, or a sentence).
    Answer(String),
    /// The turn is over.
    Settled(Settlement),
}

/// How a transaction that raises a card ended.
enum Finished {
    Card(Raised),
    /// The run was cancelled or its agent is no longer eligible: nothing was written.
    Suppressed,
    /// No live person asked.
    NoRequester,
}

fn usage_report(
    usage: Option<ChatUsage>,
    model: &str,
    payload: &AgentJobPayload,
) -> RunUsageReport {
    RunUsageReport {
        model: Some(model.to_string()),
        effort: payload.effort.clone(),
        prompt_tokens: usage.map(|usage| usage.prompt_tokens),
        completion_tokens: usage.map(|usage| usage.completion_tokens),
        cached_tokens: usage.map(|usage| usage.cached_tokens),
        reasoning_tokens: usage.map(|usage| usage.reasoning_tokens),
        // No price table reader exists on this server yet: the token counts are the measured part.
        cost_micro_usd: None,
        was_estimated: Some(usage.is_none()),
    }
}

impl AgentWorker {
    fn door_run(&self, job: &ClaimedAgentJob, payload: &AgentJobPayload, run_id: Uuid) -> DoorRun {
        let now = chrono::Utc::now();
        DoorRun {
            workspace_id: job.workspace_id,
            run_id,
            channel_id: payload.channel_id,
            agent_member_id: payload.agent_member_id,
            now_ms: now.timestamp_millis(),
            expires_at: momo_agent::default_expires_at(now, self.config.approval_ttl_seconds),
        }
    }

    /// Decide, before the model is called, whether this is a door turn — and refuse what is cheap to
    /// refuse. Called only for a turn of an agent pinned to the co-hosted Hermes that is neither a
    /// welcome nor a resume.
    pub(crate) async fn hosted_door_open(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        endpoint: &ProviderEndpoint,
    ) -> DoorOpen {
        let run = self.door_run(job, payload, run_id);
        let workspace_id = job.workspace_id;
        let strict = self.config.hosted_media_strict;
        // One read: is there a photo on the trigger, and (only when the operator attested) do the
        // cheap refusals pass. A database error is transient: the turn is retried.
        let probed = with_tenant_tx(&self.pool, workspace_id, {
            let run = run.clone();
            move |conn| {
                let run = run.clone();
                Box::pin(async move {
                    let photo = momo_messaging::trigger_photo_in_tx(
                        conn,
                        run.workspace_id,
                        run.run_id,
                        run.agent_member_id,
                    )
                    .await?;
                    if photo.is_none() {
                        return Ok(None);
                    }
                    let gate = if strict {
                        door::gate_in_tx(conn, &run).await?
                    } else {
                        Gate::Open
                    };
                    Ok(Some(gate))
                })
            }
        })
        .await;
        let gate = match probed {
            Ok(None) => return DoorOpen::NotAPhotoTurn,
            Ok(Some(gate)) => gate,
            Err(error) => {
                return DoorOpen::Settled(
                    self.settle_retryable(
                        job,
                        &format!("hosted door probe failed: {error}"),
                        endpoint,
                    )
                    .await,
                )
            }
        };
        if !strict {
            // The operator has not attested strict media delivery: the door stays shut, the model is
            // not called, and the person sees one failure card. (The operator sees the reason.)
            tracing::warn!(
                run_id = %run_id,
                "hosted expression door shut: OORT_HOSTED_MEDIA_STRICT is not `1`; a photo turn was answered by a failure card"
            );
            return DoorOpen::Settled(
                self.hosted_door_fail(
                    job,
                    payload,
                    run_id,
                    &run,
                    FailureCard::door_shut(),
                    None,
                    false,
                    endpoint,
                )
                .await,
            );
        }
        match gate {
            Gate::Open => DoorOpen::Turn(DoorTurn),
            Gate::Capped => DoorOpen::Settled(
                self.hosted_door_sentence(job, payload, run_id, CAPPED_SENTENCE)
                    .await,
            ),
            Gate::RunNotUsable | Gate::NoRequester => {
                tracing::info!(run_id = %run_id, gate = ?gate, "hosted expression door: run not usable, turn skipped");
                self.settle_done(job.id, Some("hosted_door_run_not_usable"))
                    .await;
                DoorOpen::Settled(Settlement::Skipped)
            }
        }
    }

    /// End the turn with one ordinary answer made of a fixed sentence (no model was called, so there
    /// is no usage to record).
    async fn hosted_door_sentence(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        sentence: &str,
    ) -> Settlement {
        match self
            .commit_turn(
                job,
                payload,
                run_id,
                Some(sentence.to_string()),
                crate::success_props(payload, run_id),
                None,
                crate::TurnOutcome::Succeeded,
                None,
                None,
            )
            .await
        {
            Ok(crate::TurnCommit::Committed { delegated, blocked }) => {
                self.settle_done(job.id, Some("hosted_door_refused")).await;
                Settlement::Answered { delegated, blocked }
            }
            Ok(crate::TurnCommit::Suppressed(reason)) => {
                self.settle_done(job.id, Some(reason)).await;
                Settlement::Skipped
            }
            Err(error) => {
                tracing::error!(run_id = %run_id, error = %error, "hosted door sentence commit failed");
                self.settle_failed(
                    job.id,
                    &format!("hosted door sentence commit failed: {error}"),
                )
                .await;
                Settlement::Failed
            }
        }
    }

    /// Raise the failure card and end the run in the same transaction. `usage` is the model's, when it
    /// was called (the door left shut called none); `model_called` says whether to write a ledger row.
    #[allow(clippy::too_many_arguments)]
    async fn hosted_door_fail(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        run: &DoorRun,
        card: FailureCard,
        usage: Option<ChatUsage>,
        model_called: bool,
        endpoint: &ProviderEndpoint,
    ) -> Settlement {
        // A shut door is the operator's to see as a failed run; a card the answer itself earned is a
        // delivered one.
        let run_succeeded = card.reason != door::STRICT_UNSET_REASON;
        let workspace_id = job.workspace_id;
        let model = payload.model_or(&self.config.default_model).to_string();
        let ledger = usage_report(usage, &model, payload);
        let finished = with_tenant_tx(&self.pool, workspace_id, {
            let run = run.clone();
            let card = card.clone();
            move |conn| {
                let run = run.clone();
                let card = card.clone();
                let ledger = ledger.clone();
                let model = model.clone();
                Box::pin(async move {
                    let Some(snapshot) =
                        lock_gateway_run_in_tx(conn, run.workspace_id, run.run_id).await?
                    else {
                        return Ok(Finished::Suppressed);
                    };
                    if snapshot.status == RunStatus::Cancelled {
                        return Ok(Finished::Suppressed);
                    }
                    // `None`: nobody (no live person) is left to show a card to — the requester went
                    // while the model worked. The run still ends, as a failed one, with no card.
                    let raised = door::failure_card_in_tx(conn, &run, &card).await?;
                    let run_succeeded = run_succeeded && raised.is_some();
                    let output = json!({
                        "schema": "momo.agent_run.output.v0",
                        "source": "agent_worker.hosted_expression.v0",
                        "message_id": raised.as_ref().map(|raised| raised.card_message_id),
                        "code": card.code,
                    });
                    let error = (!run_succeeded).then(|| {
                        let reason = if raised.is_some() {
                            card.reason
                        } else {
                            "hosted_door_no_requester"
                        };
                        json!({"code": reason, "reason": reason})
                    });
                    finish_run_in_tx(conn, run.run_id, run_succeeded, &output, error.as_ref())
                        .await?;
                    emit_terminal_agent_status(
                        conn,
                        run.workspace_id,
                        snapshot.channel_id,
                        snapshot.agent_member_id,
                        run.run_id,
                        if run_succeeded {
                            RunStatus::Succeeded
                        } else {
                            RunStatus::Failed
                        },
                    )
                    .await?;
                    if model_called {
                        let mut resolved = RunUsageReport::resolve(
                            Some(&ledger),
                            &model,
                            snapshot.requested_effort.as_deref(),
                            snapshot.profile_effort_pref.as_deref(),
                        );
                        resolved.source = momo_agent::UsageSource::Measured;
                        record_run_usage_in_tx(
                            conn,
                            run.workspace_id,
                            run.run_id,
                            snapshot.agent_member_id,
                            snapshot.channel_id,
                            &resolved,
                        )
                        .await?;
                    }
                    Ok(match raised {
                        Some(raised) => Finished::Card(raised),
                        None => Finished::NoRequester,
                    })
                })
            }
        })
        .await;
        match finished {
            Ok(Finished::Card(raised)) => {
                tracing::info!(
                    run_id = %run_id,
                    approval_id = %raised.approval_id,
                    code = card.code,
                    reason = card.reason,
                    "hosted expression failure card raised"
                );
                if run_succeeded {
                    self.settle_done(job.id, Some(card.code)).await;
                    Settlement::Answered {
                        delegated: 0,
                        blocked: 0,
                    }
                } else {
                    self.settle_failed(job.id, card.reason).await;
                    Settlement::Failed
                }
            }
            Ok(Finished::Suppressed) => {
                self.settle_done(job.id, Some(crate::SUPPRESSED_RUN_CANCELLED))
                    .await;
                Settlement::Skipped
            }
            Ok(Finished::NoRequester) => {
                self.settle_done(job.id, Some("hosted_door_no_requester"))
                    .await;
                Settlement::Skipped
            }
            Err(error) => {
                self.settle_retryable(
                    job,
                    &format!("hosted door failure card failed: {error}"),
                    endpoint,
                )
                .await
            }
        }
    }

    /// Land a door turn's one answer: open it, and make a card of it or an ordinary answer.
    ///
    /// `photo_given` is whether the model was handed the requester's photo address this turn — the only
    /// case in which the trigger's attachment is recorded as the picture's source (G1).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn hosted_door_land(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        answer: &str,
        usage: Option<ChatUsage>,
        photo_given: bool,
        endpoint: &ProviderEndpoint,
    ) -> Landed {
        let opened = door::open(answer);
        let request: DoorRequest = match opened.block {
            Block::Request(request) => *request,
            Block::Absent => {
                return Landed::Answer(opened.clean);
            }
            Block::Invalid(refused) => {
                tracing::info!(run_id = %run_id, refused = ?refused, "hosted expression request block refused; answering as an ordinary turn");
                return Landed::Answer(opened.clean);
            }
        };
        let run = self.door_run(job, payload, run_id);
        let program = match &self.config.assembler_program {
            Some(program) => program.clone(),
            None => match momo_expressions::assemble::assembler_path() {
                Ok(program) => program,
                Err(_) => {
                    tracing::error!(run_id = %run_id, "hosted expression door: the assembler is not found");
                    return Landed::Settled(
                        self.hosted_door_retry_or_close(
                            job,
                            payload,
                            run_id,
                            &run,
                            usage,
                            "hosted door assembler not found",
                            endpoint,
                        )
                        .await,
                    );
                }
            },
        };
        let made = match door::prepare(
            &request,
            opened.picture,
            &program,
            &momo_expressions::media::decoder_slots(),
        )
        .await
        {
            Prepared::Ready(made) => made,
            Prepared::Failed(failure) => {
                return Landed::Settled(
                    self.hosted_door_fail(
                        job,
                        payload,
                        run_id,
                        &run,
                        FailureCard::of(&failure),
                        usage,
                        true,
                        endpoint,
                    )
                    .await,
                )
            }
            Prepared::Unavailable => {
                tracing::error!(run_id = %run_id, "hosted expression door: the assembler could not run");
                return Landed::Settled(
                    self.hosted_door_retry_or_close(
                        job,
                        payload,
                        run_id,
                        &run,
                        usage,
                        "hosted door assembler unavailable",
                        endpoint,
                    )
                    .await,
                );
            }
        };
        let workspace_id = job.workspace_id;
        let model = payload.model_or(&self.config.default_model).to_string();
        let ledger = usage_report(usage, &model, payload);
        let proposed = with_tenant_tx(&self.pool, workspace_id, {
            let run = run.clone();
            let request = request.clone();
            move |conn| {
                let run = run.clone();
                let request = request.clone();
                let made = made.clone();
                let ledger = ledger.clone();
                let model = model.clone();
                Box::pin(async move {
                    let outcome =
                        door::propose_in_tx(conn, &run, &request, made, photo_given).await?;
                    // The tokens were spent whether or not a card came of it — but a refusal falls
                    // back to the ordinary answer, whose commit writes the ledger row itself.
                    if outcome.is_ok() {
                        let mut resolved =
                            RunUsageReport::resolve(Some(&ledger), &model, None, None);
                        resolved.source = momo_agent::UsageSource::Measured;
                        record_run_usage_in_tx(
                            conn,
                            run.workspace_id,
                            run.run_id,
                            run.agent_member_id,
                            run.channel_id,
                            &resolved,
                        )
                        .await?;
                    }
                    Ok(outcome)
                })
            }
        })
        .await;
        match proposed {
            Ok(Ok(raised)) => {
                tracing::info!(
                    run_id = %run_id,
                    approval_id = %raised.approval_id,
                    "hosted expression card raised"
                );
                self.settle_done(job.id, Some("awaiting approval")).await;
                Landed::Settled(Settlement::Skipped)
            }
            Ok(Err(refusal)) => {
                tracing::info!(run_id = %run_id, refusal = ?refusal, "hosted expression proposal refused; answering as an ordinary turn");
                Landed::Answer(match refusal {
                    Refusal::TooManyPending => CAPPED_SENTENCE.to_string(),
                    Refusal::TargetBusy => TARGET_BUSY_SENTENCE.to_string(),
                    Refusal::InvalidArguments => NOT_RAISED_SENTENCE.to_string(),
                    // The run is gone or not ours any more: the ordinary commit decides what that means.
                    Refusal::NoHumanRequester | Refusal::RunNotUsable | Refusal::RunNotParkable => {
                        opened.clean
                    }
                })
            }
            Err(error) => Landed::Settled(
                self.hosted_door_retry_or_close(
                    job,
                    payload,
                    run_id,
                    &run,
                    usage,
                    &format!("hosted door proposal failed: {error}"),
                    endpoint,
                )
                .await,
            ),
        }
    }

    /// A door turn's provider call failed with `error`: the part of that the door settles itself.
    /// `None` is every other failure — the ordinary path (`settle_retryable` /
    /// `settle_terminal_failure`) decides it exactly as it does for any turn.
    ///
    /// * [`ProviderError::BodyTooLarge`] — the answer was over the size limit and was not read past it
    ///   (#4820 C2b review, High-1). No picture can be taken from what was not read and asking again
    ///   would ask Hermes for the same amplification: one closed `generation_failed` card.
    /// * [`ProviderError::TimedOut`] — the provider may well have made the picture and simply not
    ///   returned it in time, and every attempt asks for a new one: the attempts are capped at
    ///   [`DOOR_MAX_ATTEMPTS`] (Medium-2), the last of them ending as the same closed card.
    pub(crate) async fn hosted_door_provider_failed(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        error: &crate::provider::ProviderError,
        reason: &str,
        endpoint: &ProviderEndpoint,
    ) -> Option<Settlement> {
        use crate::provider::ProviderError;
        let run = self.door_run(job, payload, run_id);
        match error {
            ProviderError::BodyTooLarge { .. } => {
                tracing::warn!(
                    run_id = %run_id,
                    reason,
                    "hosted expression door: the provider's answer was over the size limit; closing with a failure card"
                );
                Some(
                    self.hosted_door_fail(
                        job,
                        payload,
                        run_id,
                        &run,
                        generation_failed(),
                        None,
                        true,
                        endpoint,
                    )
                    .await,
                )
            }
            ProviderError::TimedOut(_) => Some(
                self.hosted_door_retry_or_close(job, payload, run_id, &run, None, reason, endpoint)
                    .await,
            ),
            _ => None,
        }
    }

    /// A door turn failed in a way a retry may fix but must not be left to fix seven times over: the
    /// assembler could not run, the proposal's transaction failed, the provider ran out of time. Every
    /// attempt asks Hermes for a new picture (a subscription's image allowance), so the turn gets
    /// [`DOOR_MAX_ATTEMPTS`] attempts; the first failure is requeued, the last one ends as the closed
    /// `generation_failed` card (and the run delivered, like every failure card).
    ///
    /// `usage` is what the model reported on the attempt that failed, if it answered at all. When the
    /// attempt is requeued it is written first ([`Self::hosted_door_record_usage`]): the retry's own
    /// commit knows nothing of it.
    #[allow(clippy::too_many_arguments)]
    async fn hosted_door_retry_or_close(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        run: &DoorRun,
        usage: Option<ChatUsage>,
        reason: &str,
        endpoint: &ProviderEndpoint,
    ) -> Settlement {
        if job.attempts < DOOR_MAX_ATTEMPTS {
            self.hosted_door_record_usage(job, payload, run_id, usage)
                .await;
            return self.settle_retryable(job, reason, endpoint).await;
        }
        tracing::warn!(
            run_id = %run_id,
            attempts = job.attempts,
            reason,
            "hosted expression door: its attempts are spent; closing with a failure card"
        );
        self.hosted_door_fail(
            job,
            payload,
            run_id,
            run,
            generation_failed(),
            usage,
            true,
            endpoint,
        )
        .await
    }

    /// Write the ledger row of an attempt that is about to be retried, when the model reported usage.
    /// `usage_ledger` has one row per run (`record_run_usage_in_tx` is `WHERE NOT EXISTS`): this writes
    /// it if the run has none yet and is a no-op if one exists, so a retry can never double-charge —
    /// and the tokens of the attempt that paid for the picture are not lost with the requeue. A failed
    /// write is logged and never stops the retry.
    async fn hosted_door_record_usage(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        usage: Option<ChatUsage>,
    ) {
        if usage.is_none() {
            return;
        }
        let workspace_id = job.workspace_id;
        let model = payload.model_or(&self.config.default_model).to_string();
        let ledger = usage_report(usage, &model, payload);
        let written = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            let ledger = ledger.clone();
            let model = model.clone();
            Box::pin(async move {
                // The run's lock first: the ledger insert is only idempotent under it.
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    return Ok(false);
                };
                let mut resolved = RunUsageReport::resolve(
                    Some(&ledger),
                    &model,
                    snapshot.requested_effort.as_deref(),
                    snapshot.profile_effort_pref.as_deref(),
                );
                resolved.source = momo_agent::UsageSource::Measured;
                record_run_usage_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                    snapshot.agent_member_id,
                    snapshot.channel_id,
                    &resolved,
                )
                .await
            })
        })
        .await;
        match written {
            Ok(wrote) => {
                tracing::debug!(run_id = %run_id, wrote, "hosted door: usage of a retried attempt recorded")
            }
            Err(error) => {
                tracing::warn!(run_id = %run_id, error = %error, "hosted door: usage of a retried attempt not recorded")
            }
        }
    }
}

/// How many attempts a door turn gets when what failed is something every retry pays for again (see
/// [`AgentWorker::hosted_door_retry_or_close`]). `job.attempts` counts the attempt that is running:
/// the first failure (`1`) is requeued, the second (`2`) is the last. The ordinary budget
/// (`WorkerConfig::max_attempts`) still governs every failure that is not one of these.
pub(crate) const DOOR_MAX_ATTEMPTS: i32 = 2;

/// The card of a door turn that ended without a picture for a reason that is the provider's or the
/// operator's rather than the picture's: `generation_failed`, in its golden line.
fn generation_failed() -> FailureCard {
    FailureCard::of(&door::Failure {
        code: "generation_failed",
        bytes: None,
    })
}
