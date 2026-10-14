//! Hosted-connection doorbell drain (ADR-0171).
//!
//! Consumes `hosted_agent_inbox_counter` against `hosted_agent_doorbell`.
//! No outbox rows are claimed or produced.

use std::time::Duration;

use chrono::{TimeDelta, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgPool};
use momo_webhook::{
    claim_doorbell_batch, coalesce_action_with_jobs, consume_for_fire_in_tx, doorbell_body,
    mark_trailing_in_tx, open_claimed_secret, parse_outbound_url, record_doorbell_fire_in_tx,
    record_doorbell_rung_in_tx, CoalesceAction, DoorbellClaim,
};
use serde_json::json;
use uuid::Uuid;

use crate::config::SenderConfig;
use crate::delivery::{DeliveryResult, DoorbellTransport};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DoorbellDrainStats {
    pub claimed: usize,
    pub fired: usize,
    pub coalesced: usize,
    pub failed: usize,
    pub skipped: usize,
    /// #3822: job wakes that skipped the message cooldown.
    pub urgent: usize,
    /// #3822: job wakes held back by the urgent minimum gap (re-decided next poll).
    pub deferred: usize,
}

pub struct DoorbellWorker<T: DoorbellTransport> {
    pool: PgPool,
    transport: T,
    config: SenderConfig,
}

impl<T: DoorbellTransport> DoorbellWorker<T> {
    pub fn new(pool: PgPool, transport: T, config: SenderConfig) -> Self {
        DoorbellWorker {
            pool,
            transport,
            config,
        }
    }

    pub async fn drain_once(&self) -> Result<DoorbellDrainStats, DbError> {
        if !self.config.doorbell_enabled {
            return Ok(DoorbellDrainStats::default());
        }
        let cooldown_ms = self.config.doorbell_cooldown.as_millis() as i64;
        // never longer than the cooldown: a gap past the window would hold back a plain leading edge
        let urgent_gap = self
            .config
            .doorbell_urgent_gap
            .min(self.config.doorbell_cooldown);
        let urgent_gap_ms = urgent_gap.as_millis() as i64;
        let mut tx = self.pool.begin().await.map_err(DbError::from)?;
        let claims = claim_doorbell_batch(
            &mut tx,
            self.config.claim_batch_size,
            cooldown_ms,
            urgent_gap_ms,
        )
        .await?;
        let mut stats = DoorbellDrainStats {
            claimed: claims.len(),
            ..DoorbellDrainStats::default()
        };
        let now = Utc::now();
        let mut to_fire = Vec::new();
        for claim in claims {
            let new_events = claim.inbox_last_seq > claim.last_seen_inbox_seq;
            let window_open =
                window_still_open(claim.window_started_at, self.config.doorbell_cooldown, now);
            let urgent_gap_open = window_still_open(
                claim.window_started_at,
                self.config.doorbell_urgent_gap,
                now,
            );
            let action = coalesce_action_with_jobs(
                new_events,
                claim.has_new_job,
                claim.pending_trailing,
                window_open,
                urgent_gap_open,
            );
            match action {
                CoalesceAction::MarkTrailing => {
                    mark_trailing_in_tx(
                        &mut tx,
                        claim.workspace_id,
                        claim.connection_id,
                        claim.inbox_last_seq,
                    )
                    .await?;
                    stats.coalesced += 1;
                }
                CoalesceAction::Leading | CoalesceAction::Trailing | CoalesceAction::Urgent => {
                    consume_for_fire_in_tx(
                        &mut tx,
                        claim.workspace_id,
                        claim.connection_id,
                        claim.inbox_last_seq,
                    )
                    .await?;
                    if action == CoalesceAction::Urgent {
                        stats.urgent += 1;
                    }
                    to_fire.push((claim, action));
                }
                CoalesceAction::Defer => stats.deferred += 1,
                CoalesceAction::Idle => stats.skipped += 1,
            }
        }
        tx.commit().await.map_err(DbError::from)?;

        for (claim, action) in to_fire {
            match self.ring(&claim, action.edge().unwrap_or("leading")).await {
                Ok(()) => stats.fired += 1,
                Err(()) => stats.failed += 1,
            }
        }
        Ok(stats)
    }

    pub async fn drain_to_empty(&self) -> DoorbellDrainStats {
        let mut total = DoorbellDrainStats::default();
        loop {
            match self.drain_once().await {
                Ok(stats) => {
                    total.claimed += stats.claimed;
                    total.fired += stats.fired;
                    total.coalesced += stats.coalesced;
                    total.failed += stats.failed;
                    total.skipped += stats.skipped;
                    total.urgent += stats.urgent;
                    total.deferred += stats.deferred;
                    // a pass that consumed nothing would be identical to the next one: wait for the
                    // next poll instead of spinning on rows that are being held back
                    if (stats.claimed as i64) < self.config.claim_batch_size
                        || stats.fired + stats.failed + stats.coalesced == 0
                    {
                        return total;
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "doorbell drain iteration failed");
                    return total;
                }
            }
        }
    }

    pub async fn run(&self, shutdown: impl std::future::Future<Output = ()>) {
        if !self.config.doorbell_enabled {
            tracing::info!("doorbell drain idle (MOMO_DOORBELL_ENABLED!=true)");
            shutdown.await;
            return;
        }
        tracing::info!(
            cooldown_ms = self.config.doorbell_cooldown.as_millis() as u64,
            timeout_ms = self.config.doorbell_timeout.as_millis() as u64,
            "doorbell drain starting"
        );
        let mut ticker = tokio::time::interval(self.config.poll_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                _ = ticker.tick() => {}
            }
            self.drain_to_empty().await;
        }
        tracing::info!("doorbell drain stopped");
    }

    async fn ring(&self, claim: &DoorbellClaim, edge: &str) -> Result<(), ()> {
        let secret = match open_claimed_secret(claim, &self.config.signing_master_key) {
            Ok(secret) => secret,
            Err(error) => {
                tracing::error!(
                    connection_id = %claim.connection_id,
                    error = %error,
                    "doorbell sealed box would not open"
                );
                self.finish(claim, edge, "sealed_box_invalid", false).await;
                return Err(());
            }
        };
        let Ok(url) = parse_outbound_url(&claim.url, self.config.allow_development_http) else {
            self.finish(claim, edge, "invalid_url", false).await;
            return Err(());
        };

        let retries = self.config.doorbell_retries;
        let mut last_status = "abandoned".to_string();
        let mut delivered = false;
        for attempt in 0..=retries {
            let result = self.transport.ring(&url, &secret, doorbell_body()).await;
            match classify_doorbell(&result) {
                DoorbellAttempt::Ok(status) => {
                    last_status = format!("ok_{status}");
                    delivered = true;
                    self.audit(claim, &url.host, &last_status, attempt, true)
                        .await;
                    break;
                }
                DoorbellAttempt::Retry(label) => {
                    last_status = label;
                    if attempt < retries {
                        tokio::time::sleep(doorbell_backoff(attempt)).await;
                        continue;
                    }
                }
                DoorbellAttempt::GiveUp(label) => {
                    last_status = label;
                    break;
                }
            }
        }
        if !delivered {
            self.audit(claim, &url.host, &last_status, retries, false)
                .await;
        }
        self.finish(claim, edge, &last_status, delivered).await;
        if delivered {
            Ok(())
        } else {
            Err(())
        }
    }

    async fn finish(&self, claim: &DoorbellClaim, edge: &str, status: &str, delivered: bool) {
        let write = async {
            let mut conn = self.pool.acquire().await.map_err(DbError::from)?;
            record_doorbell_fire_in_tx(&mut conn, claim.workspace_id, claim.connection_id, status)
                .await
        };
        if let Err(error) = write.await {
            tracing::error!(
                connection_id = %claim.connection_id,
                error = %error,
                "doorbell fire projection write failed"
            );
        }
        // #3822: the run ledger learns the ring (best effort; a ledger failure must not
        // change what the ring already did).
        let ledger = async {
            let mut tx = self.pool.begin().await.map_err(DbError::from)?;
            record_doorbell_rung_in_tx(
                &mut tx,
                claim.workspace_id,
                claim.connection_id,
                edge,
                delivered,
            )
            .await?;
            tx.commit().await.map_err(DbError::from)
        };
        if let Err(error) = ledger.await {
            tracing::error!(
                connection_id = %claim.connection_id,
                error = %error,
                "doorbell_rung ledger write failed"
            );
        }
    }

    async fn audit(
        &self,
        claim: &DoorbellClaim,
        host: &str,
        status: &str,
        attempt: u32,
        success: bool,
    ) {
        let action = if success {
            "hosted_agent.doorbell.fired"
        } else {
            "hosted_agent.doorbell.abandoned"
        };
        let workspace_id = claim.workspace_id;
        let connection_id = claim.connection_id;
        let host = host.to_string();
        let status = status.to_string();
        let write = async {
            let mut conn = self.pool.acquire().await.map_err(DbError::from)?;
            write_audit(
                &mut conn,
                &AuditEntry::new(workspace_id, action)
                    .target("hosted_agent_connection", connection_id)
                    .with_schema(
                        if success {
                            "momo.hosted_agent.doorbell.fired.v1"
                        } else {
                            "momo.hosted_agent.doorbell.abandoned.v1"
                        },
                        json!({
                            "host": host,
                            "status": status,
                            "attempt": attempt,
                        }),
                    ),
            )
            .await
        };
        if let Err(error) = write.await {
            tracing::error!(
                connection_id = %connection_id,
                error = %error,
                "doorbell audit write failed"
            );
        }
    }
}

fn window_still_open(
    started: Option<chrono::DateTime<Utc>>,
    cooldown: Duration,
    now: chrono::DateTime<Utc>,
) -> bool {
    let Some(started) = started else {
        return false;
    };
    let Ok(window) = TimeDelta::from_std(cooldown) else {
        return false;
    };
    now < started + window
}

enum DoorbellAttempt {
    Ok(u16),
    Retry(String),
    GiveUp(String),
}

fn classify_doorbell(result: &DeliveryResult) -> DoorbellAttempt {
    match result {
        DeliveryResult::Ok(status) => DoorbellAttempt::Ok(*status),
        DeliveryResult::ServerFailure(status) => DoorbellAttempt::Retry(format!("http_{status}")),
        DeliveryResult::Transient { reason, status } => {
            let label = status
                .map(|code| format!("http_{code}"))
                .unwrap_or_else(|| {
                    if reason.contains("timed out") {
                        "timeout".to_string()
                    } else {
                        "transient".to_string()
                    }
                });
            DoorbellAttempt::Retry(label)
        }
        DeliveryResult::Permanent { reason, status } => {
            if reason.contains("SSRF") {
                DoorbellAttempt::GiveUp("ssrf".to_string())
            } else {
                DoorbellAttempt::GiveUp(
                    status
                        .map(|code| format!("http_{code}"))
                        .unwrap_or_else(|| "permanent".to_string()),
                )
            }
        }
    }
}

fn doorbell_backoff(attempt: u32) -> Duration {
    Duration::from_millis(200 * 2u64.pow(attempt))
}

/// Q-LOOP helper: an agent's own utterance must not wake its doorbell.
pub fn agent_may_wake_own_doorbell(author_member_id: Uuid, agent_member_id: Uuid) -> bool {
    author_member_id != agent_member_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q_loop_refuses_self_authored_wake() {
        let agent = Uuid::from_u128(7);
        assert!(
            !agent_may_wake_own_doorbell(agent, agent),
            "removing this inequality is the Q-LOOP red"
        );
        assert!(agent_may_wake_own_doorbell(Uuid::from_u128(1), agent));
    }

    #[test]
    fn flag_off_drain_is_a_no_op_shape() {
        let stats = DoorbellDrainStats::default();
        assert_eq!(stats.claimed, 0);
        assert_eq!(stats.fired, 0);
    }
}
