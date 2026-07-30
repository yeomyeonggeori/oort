//! `momo-notifier` — the T3 durability worker (ADR-0145 B안, batch B2.3).
//!
//! Two of the Swift `NotifierWorker`'s three loops, the two that decide money
//! and session state when a host or a process dies:
//!
//! 1. **cloud lifecycle reconciliation** (ADR-0140 D4) — claim a durable intent,
//!    ask the provider, converge. One iteration is
//!    [`Notifier::reconcile_once`].
//! 2. **tier fallback sweep** (ADR-0125 D11 / MOMO-656) — a session whose host
//!    stopped answering settles and stops claiming to be running. One iteration
//!    is [`Notifier::sweep_once`].
//!
//! The third loop, the push-candidate drain (ADR-0120), is **not** here: the push
//! relay contract is its own batch.
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

pub mod config;
pub mod provider;

use std::future::Future;
use std::sync::Arc;

use momo_db::PgPool;
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

pub use config::NotifierConfig;
pub use provider::{
    AdapterError, FixedAdapterResolver, ProviderAdapterResolver, RegistryAdapterResolver,
};

#[derive(Debug, thiserror::Error)]
pub enum NotifierError {
    #[error("database error: {0}")]
    Db(#[from] momo_db::sqlx::Error),
    #[error(transparent)]
    T3(#[from] T3Error),
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
        Ok(Notifier::new(
            pool,
            config,
            Arc::new(RegistryAdapterResolver),
        ))
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
        }
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

        shutdown.await;
        reconcile_task.abort();
        sweep_task.abort();
        tracing::info!("momo notifier stopped");
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
