//! `momo-relay` — the outbox → Centrifugo drain loop (ADR-0145 B안, batch B1.5).
//!
//! Semantic parity with Swift `relay/OutboxRelay/.../RelayService.swift`, one
//! iteration being:
//!
//! 1. **claim** — `momo_outbox::claim_broadcast_batch` selects pending
//!    `kind='broadcast'` rows `FOR UPDATE SKIP LOCKED` and flips them to
//!    `processing` in the same statement/transaction. A claim is therefore
//!    loss-free (it depends only on commit visibility) and two relay instances
//!    can never grab the same row — a high-water-mark cursor WOULD lose rows and
//!    is forbidden (L4 §3.5).
//! 2. **publish** — `POST /api/publish` with `version = seq` and
//!    `idempotency_key`, payload forwarded verbatim.
//! 3. **settle** — success → `done`; transient failure → `pending` with
//!    exponential backoff (`available_at`, `attempts` already incremented by the
//!    claim); `attempts >= max_attempts` or a permanent failure → `failed`.
//!
//! Wakeups are `LISTEN outbox` (the schema's `outbox_notify_trg` fires
//! `pg_notify` AFTER INSERT) with a 300 ms poll ticker as the fallback, so a
//! missed NOTIFY costs latency, never delivery.
//!
//! Scope guards this crate keeps:
//! * **broadcast only.** `webhook_delivery`, `push_candidate` and `agent_job`
//!   rows belong to their own consumers and are never claimed here (B1 lesson).
//! * **no outbox SQL.** Every statement lives in `momo-outbox`; this crate calls
//!   its API (invariant #3 stays a single-crate chokepoint).
//! * **the only Centrifugo writer in the workspace** (invariant #2).

pub mod centrifugo;
pub mod config;

use std::future::Future;

use momo_db::sqlx::postgres::PgListener;
use momo_db::PgPool;
use momo_outbox::{
    backoff_seconds, claim_broadcast_batch, mark_done, mark_failed, requeue, ClaimedRow,
    NOTIFY_CHANNEL,
};
use momo_wire::payload::BroadcastPayload;
use tokio::sync::mpsc;

pub use centrifugo::{CentrifugoClient, PublishOutcome};
pub use config::RelayConfig;

#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("database error: {0}")]
    Db(#[from] momo_db::sqlx::Error),
    #[error("centrifugo client build failed: {0}")]
    Http(#[from] reqwest::Error),
}

/// What one drain iteration did — the unit the conformance tests assert on.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DrainStats {
    pub claimed: usize,
    pub published: usize,
    pub requeued: usize,
    pub failed: usize,
}

pub struct Relay {
    pool: PgPool,
    publisher: CentrifugoClient,
    config: RelayConfig,
}

impl Relay {
    /// Build a relay with its own pool. The connection string must be the
    /// BYPASSRLS `momo_relay` role: the relay drains every tenant, which is
    /// exactly why it is a separate credential from the API's `momo_app`.
    pub async fn connect(config: RelayConfig) -> Result<Relay, RelayError> {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .max_connections(config.max_connections)
            .connect(&config.database_url)
            .await?;
        let publisher = CentrifugoClient::new(&config.cent_api_url, config.cent_api_key.clone())?;
        Ok(Relay {
            pool,
            publisher,
            config,
        })
    }

    /// Build from an existing pool + publisher (conformance tests).
    pub fn new(pool: PgPool, publisher: CentrifugoClient, config: RelayConfig) -> Relay {
        Relay {
            pool,
            publisher,
            config,
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Claim one batch and settle every row in it. Returns what happened.
    pub async fn drain_once(&self) -> Result<DrainStats, RelayError> {
        let claimed = claim_broadcast_batch(&self.pool, self.config.claim_batch_size).await?;
        let mut stats = DrainStats {
            claimed: claimed.len(),
            ..DrainStats::default()
        };
        for row in claimed {
            match self.process(row).await {
                Settlement::Published => stats.published += 1,
                Settlement::Requeued => stats.requeued += 1,
                Settlement::Failed => stats.failed += 1,
            }
        }
        Ok(stats)
    }

    /// Drain until a claim comes back short of a full batch (nothing left for
    /// now). Errors are logged, not propagated: the next tick retries.
    pub async fn drain_to_empty(&self) -> DrainStats {
        let mut total = DrainStats::default();
        loop {
            match self.drain_once().await {
                Ok(stats) => {
                    total.claimed += stats.claimed;
                    total.published += stats.published;
                    total.requeued += stats.requeued;
                    total.failed += stats.failed;
                    if (stats.claimed as i64) < self.config.claim_batch_size {
                        return total;
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "relay drain iteration failed");
                    return total;
                }
            }
        }
    }

    /// Publish one claimed row and settle its status.
    async fn process(&self, row: ClaimedRow) -> Settlement {
        let payload: BroadcastPayload = match serde_json::from_str(&row.payload) {
            Ok(payload) => payload,
            Err(error) => {
                // A malformed payload can never succeed — fail it permanently
                // rather than looping on poison. The row is kept for postmortem.
                tracing::error!(outbox_id = row.id, error = %error, "outbox payload decode failed");
                self.settle_failed(row.id, &format!("payload decode: {error}"))
                    .await;
                return Settlement::Failed;
            }
        };

        match self.publisher.publish(&payload).await {
            PublishOutcome::Ok => {
                if let Err(error) = mark_done(&self.pool, row.id, None).await {
                    // At-least-once: a lost status write means a re-publish,
                    // which the idempotency_key makes harmless.
                    tracing::error!(outbox_id = row.id, error = %error, "mark_done failed");
                }
                tracing::debug!(
                    outbox_id = row.id,
                    channel = %payload.channel,
                    version = payload.version.unwrap_or(-1),
                    "published"
                );
                Settlement::Published
            }
            PublishOutcome::Permanent(reason) => {
                tracing::error!(outbox_id = row.id, reason, "permanent publish failure");
                self.settle_failed(row.id, &reason).await;
                Settlement::Failed
            }
            PublishOutcome::Transient(reason) => {
                // `attempts` was incremented by the claim, so the retry count is
                // deterministic and the give-up point is exact.
                if row.attempts >= self.config.max_attempts {
                    tracing::error!(
                        outbox_id = row.id,
                        attempts = row.attempts,
                        reason,
                        "max attempts reached"
                    );
                    self.settle_failed(row.id, &format!("max attempts: {reason}"))
                        .await;
                    return Settlement::Failed;
                }
                let backoff = backoff_seconds(row.attempts);
                tracing::warn!(
                    outbox_id = row.id,
                    attempts = row.attempts,
                    backoff_seconds = backoff,
                    reason,
                    "transient publish failure; requeueing"
                );
                if let Err(error) = requeue(&self.pool, row.id, backoff, &reason).await {
                    tracing::error!(outbox_id = row.id, error = %error, "requeue failed");
                }
                Settlement::Requeued
            }
        }
    }

    async fn settle_failed(&self, id: i64, reason: &str) {
        if let Err(error) = mark_failed(&self.pool, id, reason).await {
            tracing::error!(outbox_id = id, error = %error, "mark_failed failed");
        }
    }

    /// Run until `shutdown` resolves: NOTIFY-driven drains with a poll fallback.
    pub async fn run(&self, shutdown: impl Future<Output = ()>) {
        tracing::info!(
            poll_interval_ms = self.config.poll_interval.as_millis() as u64,
            claim_batch = self.config.claim_batch_size,
            "outbox relay starting"
        );

        // Capacity 1 + `try_send` coalesces a NOTIFY burst into "one drain
        // pending"; each drain runs to empty, so nothing is left behind.
        let (wake_tx, mut wake_rx) = mpsc::channel::<()>(1);
        let listener = tokio::spawn(listen_loop(self.config.database_url.clone(), wake_tx));

        let mut ticker = tokio::time::interval(self.config.poll_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                _ = ticker.tick() => {}
                wake = wake_rx.recv() => {
                    if wake.is_none() { /* listener gone; poll keeps us alive */ }
                }
            }
            self.drain_to_empty().await;
        }

        listener.abort();
        tracing::info!("outbox relay stopped");
    }
}

#[derive(Debug, Clone, Copy)]
enum Settlement {
    Published,
    Requeued,
    Failed,
}

/// Hold a dedicated `LISTEN outbox` connection and nudge the drain loop on every
/// notification. A dropped connection degrades to poll-only (Swift parity):
/// latency suffers, delivery does not.
async fn listen_loop(database_url: String, wake: mpsc::Sender<()>) {
    loop {
        match PgListener::connect(&database_url).await {
            Ok(mut listener) => match listener.listen(NOTIFY_CHANNEL).await {
                Ok(()) => loop {
                    match listener.recv().await {
                        Ok(_notification) => {
                            // Full channel = a drain is already pending.
                            let _ = wake.try_send(());
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "LISTEN connection lost; poll fallback");
                            break;
                        }
                    }
                },
                Err(error) => {
                    tracing::warn!(error = %error, "LISTEN registration failed; poll fallback");
                }
            },
            Err(error) => {
                tracing::warn!(error = %error, "LISTEN connect failed; poll fallback");
            }
        }
        if wake.is_closed() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}
