//! The push-candidate drain — the third `NotifierWorker` loop (ADR-0120 D3).
//!
//! Port of `workers/NotifierWorker/.../NotifierService.swift`. Candidates are
//! enqueued by the 011 trigger in the same transaction as their source message;
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

use std::sync::Arc;

use momo_db::sqlx;
use momo_db::{with_tenant_tx, PgPool};
use momo_outbox::{
    backoff_seconds, claim_push_candidate_batch, mark_done, mark_failed,
    reclaim_stuck_push_candidates, requeue, ClaimedPushCandidate,
};
use momo_push::{
    claim_dispatch, collapse_id, judge_targets, settle_dispatch, unread_badge, DispatchClaim,
    DispatchOutcome, DispatchTarget, JudgedTarget, PushCandidate, PushDispatch, PushDispatcher,
};
use uuid::Uuid;

use crate::config::PushConfig;

/// One drain iteration's tally, for logs and tests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DrainStats {
    pub claimed: usize,
    pub dispatched: usize,
    pub skipped_already_settled: usize,
    pub requeued: usize,
    pub failed: usize,
}

pub struct PushDrain {
    pool: PgPool,
    config: PushConfig,
    dispatcher: Arc<dyn PushDispatcher>,
}

impl PushDrain {
    pub fn new(pool: PgPool, config: PushConfig, dispatcher: Arc<dyn PushDispatcher>) -> Self {
        PushDrain {
            pool,
            config,
            dispatcher,
        }
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
                    if claimed < batch_size as usize {
                        return total;
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "push drain iteration failed");
                    return total;
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
        let targets = match with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move { judge_targets(conn, workspace_id, candidate.message_id).await })
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

        let collapse = collapse_id(candidate.message_id);
        let mut transient: Vec<String> = Vec::new();

        for target in targets {
            match self
                .dispatch_one(workspace_id, &candidate, &collapse, &target)
                .await
            {
                Ok(true) => stats.dispatched += 1,
                Ok(false) => stats.skipped_already_settled += 1,
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

    /// Dispatch one target. `Ok(true)` sent, `Ok(false)` already settled,
    /// `Err(reason)` transient — the candidate must be retried.
    async fn dispatch_one(
        &self,
        workspace_id: Uuid,
        candidate: &PushCandidate,
        collapse: &str,
        target: &JudgedTarget,
    ) -> Result<bool, String> {
        let message_id = candidate.message_id;
        let member_id = target.member_id;
        let token_id = target.token_id;
        let collapse_owned = collapse.to_string();

        // Claim the dispatch slot and read the badge in one tenant transaction,
        // then leave it before touching the network.
        let claimed = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let claim = claim_dispatch(
                    conn,
                    workspace_id,
                    message_id,
                    member_id,
                    token_id,
                    &collapse_owned,
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
                    collapse_id = %collapse,
                    member_id = %member_id,
                    "dispatch already settled; skipping"
                );
                return Ok(false);
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
            collapse_id: collapse.to_string(),
            badge,
            reason: target.reason,
            thread_id: target.thread_id,
            category: target.category,
            approval_id: target.approval_id,
            channel_id: candidate.channel_id,
            message_id,
        });

        let outcome = self.dispatcher.dispatch(&dispatch).await;

        match outcome {
            DispatchOutcome::Accepted {
                apns_status,
                apns_reason,
            } => {
                self.settle(workspace_id, log_id, apns_status, apns_reason)
                    .await;
                Ok(true)
            }
            DispatchOutcome::PermanentFailure {
                relay_http_status,
                reason,
            } => {
                // Settle with the relay's REAL status and a `relay_http:`
                // prefix, so a later token-invalidation pass can never mistake a
                // relay-level 400 for an APNs BadDeviceToken and revoke healthy
                // tokens (review #424 M1).
                tracing::error!(
                    collapse_id = %collapse,
                    relay_http_status,
                    reason = %reason,
                    "permanent dispatch failure; settled with the relay status"
                );
                self.settle(
                    workspace_id,
                    log_id,
                    relay_http_status,
                    Some(format!("relay_http: {reason}")),
                )
                .await;
                Ok(true)
            }
            DispatchOutcome::TransientFailure(reason) => {
                Err(format!("relay transient failure: {reason}"))
            }
        }
    }

    async fn settle(
        &self,
        workspace_id: Uuid,
        log_id: Uuid,
        apns_status: i32,
        apns_reason: Option<String>,
    ) {
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                settle_dispatch(conn, log_id, apns_status, apns_reason.as_deref()).await
            })
        })
        .await;
        if let Err(error) = result {
            // The dispatch happened; failing to record it means a redelivered
            // candidate will re-send. Loud, but not fatal.
            tracing::error!(
                %log_id,
                error = %error,
                "failed to settle a dispatch that was already sent"
            );
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
