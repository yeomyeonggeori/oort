//! `momo-notifier` — the durability + notification worker (ADR-0145 B안,
//! batches B2.3 and P2).
//!
//! All three of the Swift `NotifierWorker`'s loops. The first two decide money
//! and session state when a host or a process dies; the third decides who hears
//! about a message:
//!
//! 1. **cloud lifecycle reconciliation** (ADR-0140 D4) — claim a durable intent,
//!    ask the provider, converge. One iteration is
//!    [`Notifier::reconcile_once`].
//! 2. **tier fallback sweep** (ADR-0125 D11 / MOMO-656) — a session whose host
//!    stopped answering settles and stops claiming to be running. One iteration
//!    is [`Notifier::sweep_once`].
//! 3. **push-candidate drain** (ADR-0120, batch P2) — a committed message wakes
//!    the devices that should hear about it, carrying ids only. One iteration is
//!    [`push::PushDrain::drain_once`].
//!
//! The drain holds **no APNs key and contains no APNs code**: a self-hosted
//! server cannot have one, so it hands an id-only dispatch to the relay that
//! does the Apple leg ([`push_relay`]).
//!
//! ## What this binary is not allowed to be
//!
//! **It contains no SQL.** Not a settlement statement, not a transition, not an
//! outbox row, not a `work_session` update. Every statement it causes lives in
//! `momo-t3` (`reconcile`, `sweep`, `lifecycle::terminate_in_tx` →
//! `t3_terminate`), which is what stops a worker from becoming a second, quieter
//! copy of the lifecycle rules — the exact drift ADR-0140 D1-B rejects. What is
//! left here is the part that genuinely belongs to a worker: a cadence, a
//! provider call, and the decision of which convergence rule to ask for.
//!
//! **It decides no convergence of its own.** The table is
//! [`momo_t3::convergence`], compiled by this process and by the REST confirm
//! path alike.
//!
//! ## Serialization
//!
//! Two notifier instances are safe by construction and neither of the two
//! mechanisms is this crate's: `t3_claim_lifecycle_operation` (057:188) takes the
//! host advisory and bumps the intent version, so exactly one instance claims a
//! given row per due window; and `t3_terminate` (058:116) is idempotent on
//! `settled_at`, so even a duplicated convergence bills once.

pub mod approval_sweep;
pub mod config;
pub mod provider;
pub mod push;
pub mod push_relay;

use std::future::Future;
use std::sync::Arc;

use momo_db::sqlx::postgres::PgListener;
use momo_db::PgPool;
use momo_outbox::NOTIFY_CHANNEL;
use momo_provider::CloudInstancePresence;
use momo_t3::convergence::{
    after_deadline, after_provider_call, provider_denies_its_own_absence,
    CloudLifecycleConvergence, CloudLifecyclePhase,
};
use momo_t3::reconcile::{
    apply_convergence_to_intent, claim_lifecycle_intent, due_lifecycle_candidates,
    ActionableIntent, AppliedConvergence,
};
use momo_t3::sweep::{converge_stale_session, stale_session_candidates};
use momo_t3::T3Error;

pub use config::{NotifierConfig, PushConfig, SigningPosture};
pub use provider::{
    AdapterError, FixedAdapterResolver, ProviderAdapterResolver, RegistryAdapterResolver,
};
pub use push::{DrainStats, PushDrain};
pub use push_relay::RelayHttpDispatcher;

#[derive(Debug, thiserror::Error)]
pub enum NotifierError {
    #[error("database error: {0}")]
    Db(#[from] momo_db::sqlx::Error),
    #[error(transparent)]
    T3(#[from] T3Error),
    /// The push drain was asked for but cannot be built — a boot refusal, so a
    /// misconfigured notifier never runs half-deaf.
    #[error("push configuration error: {0}")]
    PushConfig(String),
}

/// What one reconciliation iteration did — the unit the conformance tests assert
/// on. Every field is a *terminal* outcome for one claimed intent, so they sum to
/// `claimed`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileStats {
    pub candidates: usize,
    pub claimed: usize,
    pub confirmed: usize,
    pub reverted: usize,
    pub terminated: usize,
    /// Convergence was [`CloudLifecycleConvergence::Retry`], or the phase had no
    /// revert state: the durable intent *is* the retry.
    pub retried: usize,
    /// Revalidation failed — the response belonged to a superseded intent.
    pub discarded: usize,
    /// ADR-0142 D3.1: the provider denied its own missing instance, so the
    /// settlement was refused and the intent left claimable.
    pub denied: usize,
    /// No adapter could be resolved, or a claim/apply failed. Also left
    /// claimable.
    pub deferred: usize,
}

/// What one sweep iteration did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepStats {
    pub candidates: usize,
    /// Sessions that left `running`/`idle`.
    pub transitioned: usize,
    /// Ledger rows `t3_terminate` closed and billed.
    pub settled: usize,
    pub failed: usize,
}

#[derive(Clone)]
pub struct Notifier {
    pool: PgPool,
    config: NotifierConfig,
    resolver: Arc<dyn ProviderAdapterResolver>,
    /// The ADR-0120 push drain. `None` means the drain is switched off — an
    /// explicit state announced at boot, not a loop that quietly finds nothing.
    push: Option<Arc<PushDrain>>,
}

impl Notifier {
    /// Build a notifier with its own pool. The connection string must be the
    /// BYPASSRLS `momo_notifier` role: both loops scan every tenant, which is
    /// exactly why it is a separate credential from the API's `momo_app`.
    pub async fn connect(config: NotifierConfig) -> Result<Notifier, NotifierError> {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .max_connections(config.max_connections)
            .connect(&config.database_url)
            .await?;
        let drain = build_push_drain(&pool, &config.push)?;
        // ADR-0156 D4-④: built once, from the process env, so every managed
        // substrate the operator configured is reachable and every one they did
        // not is refused by name (`provider::RegistryAdapterResolver`).
        let resolver = RegistryAdapterResolver::from_process_env();
        tracing::info!(
            wired_t3_providers = ?resolver.wired_provider_ids(),
            "cloud lifecycle adapter resolver ready"
        );
        let notifier = Notifier::new(pool, config, Arc::new(resolver));
        Ok(match drain {
            Some(drain) => notifier.with_push(drain),
            None => notifier,
        })
    }

    /// Build from an existing pool + resolver (conformance tests).
    pub fn new(
        pool: PgPool,
        config: NotifierConfig,
        resolver: Arc<dyn ProviderAdapterResolver>,
    ) -> Notifier {
        Notifier {
            pool,
            config,
            resolver,
            push: None,
        }
    }

    /// Attach the push drain.
    ///
    /// A builder rather than a `new` parameter so every existing call site keeps
    /// compiling *and* keeps the fail-closed default: a notifier that was never
    /// given a drain does not push.
    pub fn with_push(mut self, drain: Arc<PushDrain>) -> Notifier {
        self.push = Some(drain);
        self
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn config(&self) -> &NotifierConfig {
        &self.config
    }

    // -----------------------------------------------------------------------
    // loop 1 — ADR-0140 D4 cloud lifecycle reconciliation
    // -----------------------------------------------------------------------

    /// Claim every due durable intent once and converge it.
    ///
    /// Per-intent failures are counted and logged, never propagated: a provider
    /// that is down, a row another instance took first, or a response that
    /// arrived for a superseded operation are all ordinary outcomes, and the
    /// durable intent carries its own retry.
    pub async fn reconcile_once(&self) -> Result<ReconcileStats, NotifierError> {
        let candidates = due_lifecycle_candidates(
            &self.pool,
            self.config.lifecycle_claim_delay_seconds,
            self.config.claim_batch_size,
        )
        .await?;
        let mut stats = ReconcileStats {
            candidates: candidates.len(),
            ..ReconcileStats::default()
        };

        for candidate in candidates {
            let claimed = match claim_lifecycle_intent(
                &self.pool,
                candidate,
                self.config.lifecycle_claim_delay_seconds,
            )
            .await
            {
                Ok(Some(claimed)) => claimed,
                // Another instance claimed it, or it left the claimable state.
                Ok(None) => continue,
                Err(error) => {
                    tracing::warn!(
                        cloud_host_id = %candidate.cloud_host_id,
                        error = %error,
                        "cloud lifecycle intent claim failed"
                    );
                    stats.deferred += 1;
                    continue;
                }
            };
            stats.claimed += 1;

            let Some(intent) = claimed.actionable() else {
                // Nothing to ask a provider about (no sandbox handle, no durable
                // operation, or no bound host). The row keeps its intent.
                tracing::warn!(
                    cloud_host_id = %claimed.cloud_host_id,
                    state = %claimed.state,
                    "claimed intent is not actionable"
                );
                stats.deferred += 1;
                continue;
            };

            match self.converge(&intent).await {
                Ok(outcome) => match outcome {
                    IntentOutcome::Applied(AppliedConvergence::Confirmed(state)) => {
                        tracing::info!(
                            cloud_host_id = %intent.cloud_host_id,
                            from = intent.phase.as_db_label(),
                            to = state.as_db_label(),
                            "cloud lifecycle intent confirmed"
                        );
                        stats.confirmed += 1;
                    }
                    IntentOutcome::Applied(AppliedConvergence::Reverted(state)) => {
                        tracing::info!(
                            cloud_host_id = %intent.cloud_host_id,
                            from = intent.phase.as_db_label(),
                            to = state.as_db_label(),
                            "cloud lifecycle intent abandoned"
                        );
                        stats.reverted += 1;
                    }
                    IntentOutcome::Applied(AppliedConvergence::Terminated { settled }) => {
                        tracing::warn!(
                            cloud_host_id = %intent.cloud_host_id,
                            host_id = %intent.host_id,
                            settled,
                            "provider instance is gone; session settled as provider_missing"
                        );
                        stats.terminated += 1;
                    }
                    IntentOutcome::Applied(AppliedConvergence::StaleDiscarded) => {
                        tracing::warn!(
                            cloud_host_id = %intent.cloud_host_id,
                            operation_id = %intent.operation_id,
                            version = intent.version,
                            "discarded stale provider response"
                        );
                        stats.discarded += 1;
                    }
                    IntentOutcome::Applied(AppliedConvergence::Skipped) => {
                        stats.retried += 1;
                    }
                    IntentOutcome::WillRetry => {
                        tracing::info!(
                            cloud_host_id = %intent.cloud_host_id,
                            state = intent.phase.as_db_label(),
                            attempts = intent.attempts,
                            "cloud lifecycle intent will retry"
                        );
                        stats.retried += 1;
                    }
                    IntentOutcome::DishonestProvider => {
                        // Leaving the intent claimable is the only move that can
                        // neither silently bill nor silently strand the session;
                        // the contradiction is the operator's to resolve.
                        tracing::error!(
                            cloud_host_id = %intent.cloud_host_id,
                            provider = %intent.instance.provider_id,
                            "provider denied its own missing instance; refusing to settle"
                        );
                        stats.denied += 1;
                    }
                },
                Err(error) => {
                    tracing::warn!(
                        cloud_host_id = %intent.cloud_host_id,
                        state = intent.phase.as_db_label(),
                        error = %error,
                        "cloud lifecycle reconciliation will retry"
                    );
                    stats.deferred += 1;
                }
            }
        }
        Ok(stats)
    }

    /// One intent: call the provider (outside any transaction, keyed by the
    /// durable operation), ask the ADR-0140 D4 table what that means, and apply.
    async fn converge(&self, intent: &ActionableIntent) -> Result<IntentOutcome, NotifierError> {
        let adapter = match self.resolver.adapter_for(&intent.instance.provider_id) {
            Ok(adapter) => adapter,
            Err(error) => {
                tracing::warn!(
                    cloud_host_id = %intent.cloud_host_id,
                    error = %error,
                    "no provider adapter; leaving the durable intent claimable"
                );
                return Ok(IntentOutcome::WillRetry);
            }
        };
        let idempotency_key = intent.idempotency_key();

        let mut probe = CloudInstancePresence::Unknown;
        let convergence = if intent.deadline_exceeded {
            // Past the bound the question is no longer "did our call work" but
            // "what is actually true", and only the provider can answer that.
            probe = adapter
                .probe(&intent.instance)
                .await
                .unwrap_or(CloudInstancePresence::Unknown);
            let convergence = after_deadline(intent.phase, probe);
            tracing::info!(
                cloud_host_id = %intent.cloud_host_id,
                state = intent.phase.as_db_label(),
                probe = presence_label(probe),
                convergence = convergence.as_label(),
                attempts = intent.attempts,
                "cloud lifecycle deadline exceeded"
            );
            convergence
        } else {
            let error = match intent.phase {
                CloudLifecyclePhase::Pausing => adapter
                    .pause(&intent.instance, &idempotency_key)
                    .await
                    .err(),
                CloudLifecyclePhase::Resuming => adapter
                    .resume(&intent.instance, &idempotency_key)
                    .await
                    .err(),
                CloudLifecyclePhase::DestroyPending => adapter
                    .destroy(&intent.instance, &idempotency_key)
                    .await
                    .err(),
            };
            after_provider_call(intent.phase, error.as_ref())
        };

        if convergence == CloudLifecycleConvergence::Terminate && !intent.deadline_exceeded {
            // ADR-0142 D3.1: before terminally settling a paid session, ask the
            // adapter for the fact.
            probe = adapter
                .probe(&intent.instance)
                .await
                .unwrap_or(CloudInstancePresence::Unknown);
        }
        if provider_denies_its_own_absence(convergence, probe) {
            return Ok(IntentOutcome::DishonestProvider);
        }
        if convergence == CloudLifecycleConvergence::Retry {
            return Ok(IntentOutcome::WillRetry);
        }

        let applied = apply_convergence_to_intent(&self.pool, intent, convergence).await?;
        Ok(IntentOutcome::Applied(applied))
    }

    // -----------------------------------------------------------------------
    // loop 2 — ADR-0125 D11 / MOMO-656 tier fallback sweep
    // -----------------------------------------------------------------------

    /// Settle and transition every session whose host is gone.
    pub async fn sweep_once(&self) -> Result<SweepStats, NotifierError> {
        let candidates = stale_session_candidates(
            &self.pool,
            self.config.host_offline_grace_seconds,
            self.config.claim_batch_size,
        )
        .await?;
        let mut stats = SweepStats {
            candidates: candidates.len(),
            ..SweepStats::default()
        };

        for candidate in candidates {
            match converge_stale_session(
                &self.pool,
                &candidate,
                self.config.host_offline_grace_seconds,
            )
            .await
            {
                Ok(outcome) => {
                    if outcome.transitioned {
                        stats.transitioned += 1;
                        tracing::info!(
                            session_id = %candidate.session_id,
                            host_id = %candidate.host_id,
                            terminal = candidate.is_terminal(),
                            settled = outcome.settled,
                            orphan_source = candidate.orphan_source(),
                            grace_seconds = self.config.host_offline_grace_seconds,
                            "orphaned a stale work session"
                        );
                    }
                    if outcome.settled {
                        stats.settled += 1;
                    }
                }
                Err(error) => {
                    tracing::error!(
                        session_id = %candidate.session_id,
                        error = %error,
                        "tier fallback session failed"
                    );
                    stats.failed += 1;
                }
            }
        }
        Ok(stats)
    }

    // -----------------------------------------------------------------------
    // supervision
    // -----------------------------------------------------------------------

    /// Run both loops as independent tokio tasks until `shutdown` resolves.
    ///
    /// Independent on purpose: a provider that is timing out must not stop the
    /// sweep from settling a host that died, and the two have different natural
    /// cadences even when the default gives them the same one.
    pub async fn run(&self, shutdown: impl Future<Output = ()>) {
        tracing::info!(
            reconcile_interval_ms = self.config.reconcile_interval.as_millis() as u64,
            sweep_interval_ms = self.config.sweep_interval.as_millis() as u64,
            claim_batch = self.config.claim_batch_size,
            host_offline_grace_seconds = self.config.host_offline_grace_seconds,
            t3_enabled = self.config.t3_enabled,
            "momo notifier starting"
        );

        let reconciler = self.clone();
        let reconcile_task = tokio::spawn(async move {
            if !reconciler.config.t3_enabled {
                // T3 is unreleased and default-off. Do not even enter the
                // reconciler — an empty claim poll every 300 ms is still a poll.
                tracing::info!("t3 disabled; cloud lifecycle reconciler idle");
                return;
            }
            let mut ticker = tokio::time::interval(reconciler.config.reconcile_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if let Err(error) = reconciler.reconcile_once().await {
                    tracing::error!(error = %error, "cloud lifecycle reconciliation iteration failed");
                }
            }
        });

        let sweeper = self.clone();
        let sweep_task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(sweeper.config.sweep_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if let Err(error) = sweeper.sweep_once().await {
                    tracing::error!(error = %error, "tier fallback sweep iteration failed");
                }
            }
        });

        // ---- loop 2b: the approval expiry sweep (goal SRV-T1) --------------
        //
        // Its own task, and NOT folded into the tier sweep above, for the
        // reason that split exists: a T3 provider timing out must not stop an
        // approval deadline from releasing an agent's only concurrency slot.
        // It runs regardless of `t3_enabled` — approvals are not a T3 feature.
        let approvals = self.clone();
        let approval_sweep_task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(approvals.config.sweep_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if let Err(error) = approval_sweep::sweep_expired_approvals(
                    &approvals.pool,
                    approvals.config.claim_batch_size,
                )
                .await
                {
                    tracing::error!(error = %error, "approval expiry sweep iteration failed");
                }
            }
        });

        // ---- loop 3: ADR-0120 push-candidate drain -------------------------
        let (push_task, push_listener) = match self.push.clone() {
            None => {
                // Say so out loud. A disabled drain that logged nothing would be
                // indistinguishable from a drain that is running and delivering.
                tracing::info!(
                    "push drain disabled (set MOMO_PUSH_NOTIFIER_ENABLED=1 to enable);                      push candidates will accumulate unclaimed"
                );
                (None, None)
            }
            Some(drain) => {
                let batch = self.config.claim_batch_size;
                let interval = self.config.push.drain_interval;
                let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel::<()>(1);
                let listener =
                    tokio::spawn(push_listen_loop(self.config.database_url.clone(), wake_tx));
                let task = tokio::spawn(async move {
                    // At-least-once recovery before the first claim.
                    drain.reclaim_stuck().await;
                    let mut ticker = tokio::time::interval(interval);
                    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    loop {
                        tokio::select! {
                            _ = ticker.tick() => {}
                            wake = wake_rx.recv() => {
                                // A closed channel means the listener died; the
                                // ticker alone still drains, just less promptly.
                                if wake.is_none() {
                                    tracing::debug!("push wake channel closed; poll only");
                                }
                            }
                        }
                        drain.drain_to_empty(batch).await;
                    }
                });
                (Some(task), Some(listener))
            }
        };

        shutdown.await;
        reconcile_task.abort();
        sweep_task.abort();
        approval_sweep_task.abort();
        if let Some(task) = push_task {
            task.abort();
        }
        if let Some(listener) = push_listener {
            listener.abort();
        }
        tracing::info!("momo notifier stopped");
    }
}

/// Build the push drain for this configuration, or `None` when it is off.
///
/// The signing posture is resolved here, once, at boot — a missing credential
/// is a startup failure rather than a per-notification surprise.
fn build_push_drain(
    pool: &PgPool,
    config: &PushConfig,
) -> Result<Option<Arc<PushDrain>>, NotifierError> {
    let posture = config::resolve_signing_posture(
        config.enabled,
        config.signing_key_path.as_deref(),
        config.allow_unsigned,
    )
    .map_err(|error| NotifierError::PushConfig(error.to_string()))?;

    let seed = match posture {
        SigningPosture::Disabled => return Ok(None),
        SigningPosture::Signed(path) => {
            Some(push_relay::load_signing_seed(&path).map_err(|error| {
                // The path may be operator-supplied; the *key bytes* never
                // appear in this message.
                NotifierError::PushConfig(error.to_string())
            })?)
        }
        SigningPosture::UnsignedByOptIn => {
            tracing::warn!(
                "push dispatches will be sent UNSIGNED by explicit opt-in                  (MOMO_PUSH_RELAY_ALLOW_UNSIGNED=1); only a local mock relay accepts these"
            );
            None
        }
    };

    let dispatcher = RelayHttpDispatcher::new(&config.relay_url, &config.server_id, seed)
        .map_err(|error| NotifierError::PushConfig(error.to_string()))?;
    Ok(Some(Arc::new(PushDrain::new(
        pool.clone(),
        config.clone(),
        Arc::new(dispatcher),
    ))))
}

/// Hold a dedicated `LISTEN outbox` connection and nudge the push drain.
///
/// A dropped connection degrades to poll-only (Swift parity): latency suffers,
/// delivery does not.
async fn push_listen_loop(database_url: String, wake: tokio::sync::mpsc::Sender<()>) {
    loop {
        match PgListener::connect(&database_url).await {
            Ok(mut listener) => match listener.listen(NOTIFY_CHANNEL).await {
                Ok(()) => loop {
                    match listener.recv().await {
                        Ok(notification) => {
                            // The outbox trigger publishes the row's kind; only
                            // push candidates concern this loop.
                            if notification.payload() == "push_candidate" {
                                let _ = wake.try_send(());
                            }
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "push LISTEN connection lost; poll fallback");
                            break;
                        }
                    }
                },
                Err(error) => {
                    tracing::warn!(error = %error, "push LISTEN registration failed; poll fallback");
                }
            },
            Err(error) => {
                tracing::warn!(error = %error, "push LISTEN connect failed; poll fallback");
            }
        }
        if wake.is_closed() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// What happened to one claimed intent before/at the apply step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IntentOutcome {
    Applied(AppliedConvergence),
    /// Nothing was written; the claim already scheduled the next attempt.
    WillRetry,
    /// ADR-0142 D3.1 refusal.
    DishonestProvider,
}

fn presence_label(presence: CloudInstancePresence) -> &'static str {
    match presence {
        CloudInstancePresence::Present => "present",
        CloudInstancePresence::Absent => "absent",
        CloudInstancePresence::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_labels_are_the_three_values() {
        assert_eq!(presence_label(CloudInstancePresence::Present), "present");
        assert_eq!(presence_label(CloudInstancePresence::Absent), "absent");
        assert_eq!(presence_label(CloudInstancePresence::Unknown), "unknown");
    }
}
