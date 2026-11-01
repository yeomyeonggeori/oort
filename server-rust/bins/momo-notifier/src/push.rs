//! The push-candidate drain — the third `NotifierWorker` loop (ADR-0120 D3).
//!
//! Port of `workers/NotifierWorker/.../NotifierService.swift`. Candidates are
//! enqueued in the same transaction as the write that earns them — the 011 trigger on a
//! message INSERT, and the write that ends a streamed message (ADR-0204 증보 1 D8-a);
//! this loop turns them into id-only dispatches.
//!
//! ## Delivery contract
//!
//! * **Claim** — `FOR UPDATE SKIP LOCKED` on `kind='push_candidate'`
//!   ([`momo_outbox::claim_push_candidate_batch`]). The four consumers' `WHERE`
//!   clauses are disjoint, so they cannot drain each other.
//! * **At least once** — a boot sweep returns rows a crashed run left
//!   `processing`. Safe only because dispatch is idempotent.
//! * **Exactly once in effect** — the 011 partial unique index arbitrates; a
//!   redelivered candidate skips every settled target.
//! * **id-only** — see [`momo_push::PushDispatch`]. Content stays in Postgres.
//!
//! ## Tenant posture
//!
//! The claim itself has no workspace predicate — a single worker must serve
//! every tenant — so it runs on the pool as the BYPASSRLS `momo_notifier` role,
//! exactly as `momo-agent-worker` claims `agent_job`. Everything *after* the
//! claim knows its `workspace_id` and goes through
//! [`momo_db::with_tenant_tx`], so the per-candidate work is RLS-scoped even
//! though the role could bypass it. That is the same shape the agent worker
//! uses, and it means a judgment bug cannot silently read another tenant.
//!
//! Network I/O is deliberately **outside** every transaction: a relay that
//! stops answering must not hold a database connection for its timeout.
//!
//! ## The bulk layer (ADR-0206 증보 1 F6, #4889)
//!
//! A reason that one burst of messages can multiply — today `thread_reply`
//! ([`crate::bulk::is_bulk_reason`]) — goes through [`crate::bulk`] before its dispatch is claimed:
//! a window of six pushes per (member, thread root) and minute with the rest folded under one
//! `o:<root>:<window>` representative, then a server-wide per-minute budget. And a relay `429` for
//! such a push is **dropped, not retried** (its dispatch-log row is settled `429` /
//! `relay_http: dropped`, so a redelivery cannot send it either). Every other reason is untouched:
//! a `429` still requeues the candidate with backoff.

use std::sync::Arc;

use momo_db::sqlx;
use momo_db::{with_tenant_tx, PgPool};
use momo_outbox::{
    backoff_seconds, claim_push_candidate_batch, mark_done, mark_failed,
    reclaim_stuck_push_candidates, requeue, ClaimedPushCandidate,
};
use momo_push::{
    claim_dispatch, is_dispatch_settled, judge_candidate_targets, settle_dispatch,
    settle_dispatch_and_invalidate, settle_relay_refusal, unread_badge, DispatchClaim,
    DispatchOutcome, DispatchTarget, JudgedTarget, PushCandidate, PushDispatch, PushDispatcher,
    RefusalOutcome, RelayRefusal, SettleOutcome,
};
use uuid::Uuid;

use crate::bulk::{self, BulkLayer, Cause, Clock, Verdict};
use crate::config::PushConfig;

/// One drain iteration's tally, for logs and tests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DrainStats {
    pub claimed: usize,
    pub dispatched: usize,
    pub skipped_already_settled: usize,
    pub requeued: usize,
    pub failed: usize,
    /// Bulk-layer targets that were **not** sent: folded under a window's representative, past the
    /// server-wide budget, or dropped on a relay 429 ([`crate::bulk`]).
    pub held_back: usize,
}

/// What became of one target.
enum Dispatched {
    /// Sent (or permanently refused by the relay — settled either way).
    Sent,
    /// The dispatch log already had it.
    AlreadySettled,
    /// A bulk-layer push that is deliberately not sent.
    HeldBack,
}

/// What the bulk layer decided for one target before it is claimed.
enum BulkPlan {
    Send { collapse_id: String },
    AlreadySettled,
    HeldBack,
}

pub struct PushDrain {
    pool: PgPool,
    config: PushConfig,
    dispatcher: Arc<dyn PushDispatcher>,
    bulk: BulkLayer,
    /// The bulk counters already written to the log, so a pass logs only what changed.
    bulk_logged: std::sync::Mutex<std::collections::BTreeMap<(&'static str, &'static str), u64>>,
}

impl PushDrain {
    pub fn new(pool: PgPool, config: PushConfig, dispatcher: Arc<dyn PushDispatcher>) -> Self {
        let bulk = BulkLayer::new(config.bulk_push_per_minute);
        PushDrain {
            pool,
            config,
            dispatcher,
            bulk,
            bulk_logged: Default::default(),
        }
    }

    /// Replace the bulk layer's clock (epoch seconds). Production never calls this; a test holds or
    /// moves the minute so a window cannot straddle a real minute boundary.
    pub fn with_bulk_clock(mut self, clock: Clock) -> Self {
        self.bulk = BulkLayer::new(self.config.bulk_push_per_minute).with_clock(clock);
        self
    }

    /// `(reason, cause) -> pushes the bulk layer did not send since boot` (cause: `window`,
    /// `budget` or `relay_429`).
    pub fn bulk_counters(&self) -> std::collections::BTreeMap<(&'static str, &'static str), u64> {
        self.bulk.counters()
    }

    /// One log line per pass for what the bulk layer held back since the last one, so an operator can
    /// see a thread flood being folded, a budget being hit or the relay pushing back (ADR-0206 D7:
    /// the counters are the "operating metric").
    fn log_bulk_changes(&self) {
        let now = self.bulk.counters();
        let mut logged = self.bulk_logged.lock().expect("bulk log");
        if *logged == now {
            return;
        }
        for ((reason, cause), total) in &now {
            let before = logged.get(&(*reason, *cause)).copied().unwrap_or(0);
            if *total != before {
                tracing::info!(
                    reason = *reason,
                    cause = *cause,
                    since_last = *total - before,
                    total = *total,
                    "bulk push layer held pushes back"
                );
            }
        }
        *logged = now;
    }

    /// Return candidates a previous run left mid-flight. Once, before draining.
    pub async fn reclaim_stuck(&self) {
        match reclaim_stuck_push_candidates(&self.pool).await {
            Ok(0) => {}
            Ok(count) => tracing::info!(count, "reclaimed stuck push candidates"),
            Err(error) => tracing::warn!(
                error = %error,
                "push candidate startup sweep failed; stuck rows wait for the next boot"
            ),
        }
    }

    /// Claim and process one batch.
    pub async fn drain_once(&self, batch_size: i64) -> Result<DrainStats, sqlx::Error> {
        let claimed = claim_push_candidate_batch(&self.pool, batch_size).await?;
        let mut stats = DrainStats {
            claimed: claimed.len(),
            ..DrainStats::default()
        };
        for row in claimed {
            self.process_candidate(row, &mut stats).await;
        }
        Ok(stats)
    }

    /// Drain until a claim comes back short, matching the relay/agent-worker loop.
    pub async fn drain_to_empty(&self, batch_size: i64) -> DrainStats {
        let (total, error) = self.drain_until_error(batch_size).await;
        if let Some(error) = error {
            tracing::error!(error = %error, "push drain iteration failed");
        }
        total
    }

    /// [`PushDrain::drain_to_empty`] that hands the failure back instead of
    /// logging it, so the run loop can back off (#3377).
    pub async fn drain_until_error(&self, batch_size: i64) -> (DrainStats, Option<sqlx::Error>) {
        let mut total = DrainStats::default();
        loop {
            match self.drain_once(batch_size).await {
                Ok(stats) => {
                    let claimed = stats.claimed;
                    total.claimed += stats.claimed;
                    total.dispatched += stats.dispatched;
                    total.skipped_already_settled += stats.skipped_already_settled;
                    total.requeued += stats.requeued;
                    total.failed += stats.failed;
                    total.held_back += stats.held_back;
                    if claimed < batch_size as usize {
                        self.log_bulk_changes();
                        return (total, None);
                    }
                }
                Err(error) => {
                    self.log_bulk_changes();
                    return (total, Some(error));
                }
            }
        }
    }

    async fn process_candidate(&self, row: ClaimedPushCandidate, stats: &mut DrainStats) {
        let candidate = match PushCandidate::decode(&row.payload) {
            Ok(candidate) => candidate,
            Err(error) => {
                // A payload this loop cannot read will never become readable.
                tracing::error!(
                    outbox_id = row.id,
                    error = %error,
                    "push candidate payload decode failed; marking failed"
                );
                self.settle_outbox_failed(row.id, &format!("payload decode: {error}"), stats)
                    .await;
                return;
            }
        };

        let workspace_id = row.workspace_id;
        let judgment_candidate = candidate.clone();
        let targets = match with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                judge_candidate_targets(conn, workspace_id, &judgment_candidate).await
            })
        })
        .await
        {
            Ok(targets) => targets,
            Err(error) => {
                self.requeue_candidate(&row, &format!("judgment failed: {error}"), stats)
                    .await;
                return;
            }
        };

        if targets.is_empty() {
            // Nobody to notify is a completed candidate, not a failure — most
            // messages in a busy channel notify nobody.
            self.settle_outbox_done(row.id, stats).await;
            return;
        }

        let collapse = candidate.collapse_id();
        let mut transient: Vec<String> = Vec::new();

        for target in targets {
            match self
                .dispatch_one(workspace_id, &candidate, &collapse, &target)
                .await
            {
                Ok(Dispatched::Sent) => stats.dispatched += 1,
                Ok(Dispatched::AlreadySettled) => stats.skipped_already_settled += 1,
                Ok(Dispatched::HeldBack) => stats.held_back += 1,
                Err(reason) => transient.push(reason),
            }
        }

        if transient.is_empty() {
            self.settle_outbox_done(row.id, stats).await;
        } else {
            // Retry the whole candidate: settled targets are skipped on
            // redelivery, so only the genuinely failed ones are re-sent.
            self.requeue_candidate(&row, &transient.join("; "), stats)
                .await;
        }
    }

    /// Dispatch one target. `Err(reason)` is transient — the candidate must be retried.
    ///
    /// A bulk-layer reason is **planned** first ([`PushDrain::plan_bulk_push`]): which collapse id it
    /// goes out under, or that it does not go out at all.
    async fn dispatch_one(
        &self,
        workspace_id: Uuid,
        candidate: &PushCandidate,
        collapse: &str,
        target: &JudgedTarget,
    ) -> Result<Dispatched, String> {
        let message_id = candidate.message_id;
        let member_id = target.member_id;
        let token_id = target.token_id;
        let in_bulk_layer = bulk::is_bulk_reason(target.reason);
        let collapse_owned = if in_bulk_layer {
            match self
                .plan_bulk_push(workspace_id, candidate, collapse, target)
                .await?
            {
                BulkPlan::Send { collapse_id } => collapse_id,
                BulkPlan::AlreadySettled => return Ok(Dispatched::AlreadySettled),
                BulkPlan::HeldBack => return Ok(Dispatched::HeldBack),
            }
        } else {
            collapse.to_string()
        };

        // Claim the dispatch slot and read the badge in one tenant transaction,
        // then leave it before touching the network.
        let claim_collapse = collapse_owned.clone();
        let claimed = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let claim = claim_dispatch(
                    conn,
                    workspace_id,
                    message_id,
                    member_id,
                    token_id,
                    &claim_collapse,
                )
                .await?;
                let badge = match claim {
                    DispatchClaim::AlreadySettled => 0,
                    DispatchClaim::Claimed { .. } => {
                        unread_badge(conn, workspace_id, member_id).await?
                    }
                };
                Ok((claim, badge))
            })
        })
        .await;

        let (claim, badge) = match claimed {
            Ok(value) => value,
            Err(error) => return Err(format!("dispatch-log claim failed: {error}")),
        };

        let log_id = match claim {
            DispatchClaim::AlreadySettled => {
                tracing::debug!(
                    collapse_id = %collapse_owned,
                    member_id = %member_id,
                    "dispatch already settled; skipping"
                );
                return Ok(Dispatched::AlreadySettled);
            }
            DispatchClaim::Claimed { log_id } => log_id,
        };

        let dispatch = PushDispatch::new(&DispatchTarget {
            server_id: self.config.server_id.clone(),
            workspace_id,
            device_id: target.device_id,
            device_platform: target.device_platform.clone(),
            apns_token: target.apns_token.clone(),
            apns_env: target.apns_env.clone(),
            apns_topic: target.apns_topic.clone(),
            collapse_id: collapse_owned.clone(),
            badge,
            reason: target.reason,
            thread_id: target.thread_id,
            category: target.category,
            approval_id: target.approval_id,
            channel_id: candidate.channel_id,
            message_id,
        });

        let outcome = self.dispatcher.dispatch(&dispatch).await;

        // A relay 429 for a bulk-layer push is dropped, not retried (ADR-0206 D7): the layer is
        // best-effort and must not spend the retry budget and the backoff queue that approvals and
        // DMs rely on. The claimed row is settled 429 / `relay_http: dropped`, so a redelivery of this
        // candidate finds it `AlreadySettled`.
        if in_bulk_layer && outcome.is_relay_rate_limited() {
            self.settle_dropped(workspace_id, log_id).await;
            self.bulk.count(Cause::Relay429);
            return Ok(Dispatched::HeldBack);
        }

        match outcome {
            DispatchOutcome::Accepted {
                apns_status,
                apns_reason,
            } => {
                self.settle_receipt(workspace_id, log_id, target, apns_status, apns_reason)
                    .await;
                Ok(Dispatched::Sent)
            }
            DispatchOutcome::PermanentFailure {
                relay_http_status,
                reason,
            } => {
                // Settle with the relay's REAL status and a `relay_http:`
                // prefix, so a later token-invalidation pass can never mistake a
                // relay-level 400 for an APNs BadDeviceToken and revoke healthy
                // tokens (review #424 M1). A relay 400 also leaves one audit row
                // per token per hour and NEVER invalidates the token (ADR-0204 D9).
                tracing::error!(
                    collapse_id = %collapse_owned,
                    relay_http_status,
                    reason = %reason,
                    "permanent dispatch failure; settled with the relay status"
                );
                self.settle_refusal(workspace_id, log_id, target, relay_http_status, &reason)
                    .await;
                Ok(Dispatched::Sent)
            }
            DispatchOutcome::TransientFailure(reason) => {
                Err(format!("relay transient failure: {reason}"))
            }
        }
    }

    /// Decide what a bulk-layer target does, **before** its dispatch is claimed (ADR-0206 D7's order):
    ///
    /// 1. the push of this very message is already settled (a redelivery) → nothing to count;
    /// 2. the window's verdict: one of the first six, or folded;
    /// 3. a folded message whose window representative already went out adds nothing;
    /// 4. the server-wide budget. A push past it is not sent and leaves no log row.
    ///
    /// Steps 1–4 leave no `push_dispatch_log` row behind, so a folded or over-budget push can never
    /// strand an unsettled claim that a redelivery would "take over" and send.
    async fn plan_bulk_push(
        &self,
        workspace_id: Uuid,
        candidate: &PushCandidate,
        individual_collapse: &str,
        target: &JudgedTarget,
    ) -> Result<BulkPlan, String> {
        let (member_id, token_id) = (target.member_id, target.token_id);
        if self
            .dispatch_settled(workspace_id, member_id, token_id, individual_collapse)
            .await?
        {
            return Ok(BulkPlan::AlreadySettled);
        }
        let chosen = match self
            .bulk
            .decide(member_id, target.thread_id, candidate.message_id)
        {
            Verdict::Individual => individual_collapse.to_string(),
            Verdict::Folded { window } => {
                let representative = bulk::folded_collapse_id(target.thread_id, window);
                if self
                    .dispatch_settled(workspace_id, member_id, token_id, &representative)
                    .await?
                {
                    return Ok(BulkPlan::HeldBack);
                }
                representative
            }
        };
        if !self.bulk.try_spend() {
            return Ok(BulkPlan::HeldBack);
        }
        Ok(BulkPlan::Send {
            collapse_id: chosen,
        })
    }

    /// [`momo_push::is_dispatch_settled`] in its own short tenant transaction.
    async fn dispatch_settled(
        &self,
        workspace_id: Uuid,
        member_id: Uuid,
        token_id: Uuid,
        collapse_id: &str,
    ) -> Result<bool, String> {
        let collapse_id = collapse_id.to_string();
        with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                is_dispatch_settled(conn, workspace_id, member_id, token_id, &collapse_id).await
            })
        })
        .await
        .map_err(|error| format!("dispatch-log read failed: {error}"))
    }

    /// Settle a claimed bulk-layer dispatch the relay rate-limited as dropped (status 429, reason
    /// `relay_http: dropped`): never sent, never retried, never mistaken for an APNs answer.
    async fn settle_dropped(&self, workspace_id: Uuid, log_id: Uuid) {
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(
                async move { settle_dispatch(conn, log_id, 429, Some(bulk::DROPPED_REASON)).await },
            )
        })
        .await;
        if let Err(error) = result {
            // The next delivery of the candidate finds the claim unsettled and would send it again:
            // loud, but the push itself stays best-effort.
            tracing::error!(%log_id, error = %error, "failed to settle a dropped bulk push");
        }
    }

    /// Record the relay's APNs receipt and, when it says the token is dead,
    /// invalidate the token in the same transaction (ADR-0204 D9).
    async fn settle_receipt(
        &self,
        workspace_id: Uuid,
        log_id: Uuid,
        target: &JudgedTarget,
        apns_status: i32,
        apns_reason: Option<String>,
    ) {
        let token_id = target.token_id;
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                settle_dispatch_and_invalidate(
                    conn,
                    workspace_id,
                    log_id,
                    token_id,
                    apns_status,
                    apns_reason.as_deref(),
                )
                .await
            })
        })
        .await;
        match result {
            Ok(SettleOutcome::Invalidated(reason)) => tracing::warn!(
                %token_id,
                apns_status,
                reason = reason.as_str(),
                "APNs says the push token is dead; invalidated"
            ),
            Ok(SettleOutcome::InvalidationFailed { reason, error }) => tracing::error!(
                %token_id,
                apns_status,
                reason = reason.as_str(),
                error = %error,
                "APNs says the push token is dead but invalidating it failed; the receipt is \
                 recorded. Does momo_notifier have UPDATE (invalidated_at, updated_at) on \
                 push_token (bootstrap_runtime_roles.sql)?"
            ),
            Ok(SettleOutcome::NoLiveToken(_) | SettleOutcome::Settled) => {}
            Err(error) => {
                // The dispatch happened; failing to record it means a redelivered
                // candidate will re-send. Loud, but not fatal.
                tracing::error!(
                    %log_id,
                    error = %error,
                    "failed to settle a dispatch that was already sent"
                );
            }
        }
    }

    /// Record a refusal by the relay itself (not an APNs receipt). Never touches
    /// the token; a relay `400` writes the deduplicated audit row.
    async fn settle_refusal(
        &self,
        workspace_id: Uuid,
        log_id: Uuid,
        target: &JudgedTarget,
        relay_http_status: i32,
        reason: &str,
    ) {
        let token_id = target.token_id;
        let apns_env = target.apns_env.clone();
        let apns_topic = target.apns_topic.clone();
        let device_platform = target.device_platform.clone();
        let reason = reason.to_string();
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                settle_relay_refusal(
                    conn,
                    workspace_id,
                    log_id,
                    &RelayRefusal {
                        relay_http_status,
                        reason: &reason,
                        token_id,
                        apns_env: &apns_env,
                        apns_topic: &apns_topic,
                        device_platform: &device_platform,
                    },
                )
                .await
            })
        })
        .await;
        match result {
            Ok(RefusalOutcome::Audited) => tracing::warn!(
                %token_id,
                relay_http_status,
                "relay refused a dispatch with a 400; audited (push.relay.refused), token kept"
            ),
            Ok(RefusalOutcome::AuditFailed { error }) => tracing::error!(
                %token_id,
                relay_http_status,
                error = %error,
                "relay refused a dispatch with a 400; the refusal is recorded but its audit row failed"
            ),
            Ok(RefusalOutcome::Settled | RefusalOutcome::AuditedRecently) => {}
            Err(error) => {
                tracing::error!(
                    %log_id,
                    error = %error,
                    "failed to settle a dispatch the relay refused"
                );
            }
        }
    }

    async fn settle_outbox_done(&self, id: i64, stats: &mut DrainStats) {
        if let Err(error) = mark_done(&self.pool, id, None).await {
            tracing::error!(outbox_id = id, error = %error, "failed to mark candidate done");
        }
        let _ = stats;
    }

    async fn settle_outbox_failed(&self, id: i64, reason: &str, stats: &mut DrainStats) {
        stats.failed += 1;
        if let Err(error) = mark_failed(&self.pool, id, reason).await {
            tracing::error!(outbox_id = id, error = %error, "failed to mark candidate failed");
        }
    }

    async fn requeue_candidate(
        &self,
        row: &ClaimedPushCandidate,
        reason: &str,
        stats: &mut DrainStats,
    ) {
        if row.attempts >= self.config.max_attempts {
            tracing::error!(
                outbox_id = row.id,
                attempts = row.attempts,
                reason,
                "max attempts reached; parking candidate as failed"
            );
            self.settle_outbox_failed(row.id, &format!("max attempts: {reason}"), stats)
                .await;
            return;
        }
        stats.requeued += 1;
        let backoff = backoff_seconds(row.attempts);
        tracing::warn!(
            outbox_id = row.id,
            attempts = row.attempts,
            backoff_seconds = backoff,
            reason,
            "transient dispatch failure; requeueing candidate"
        );
        if let Err(error) = requeue(&self.pool, row.id, backoff, reason).await {
            tracing::error!(outbox_id = row.id, error = %error, "failed to requeue candidate");
        }
    }
}
