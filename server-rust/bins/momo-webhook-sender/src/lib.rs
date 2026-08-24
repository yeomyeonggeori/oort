//! `momo-webhook-sender` — the outbox → subscriber drain loop (#1222 / T13).
//!
//! Semantic parity with the webhook half of Swift
//! `relay/OutboxRelay/.../RelayService.swift` (`processWebhook` and its three
//! settlements), one iteration being:
//!
//! 1. **claim** — `momo_outbox::claim_webhook_delivery_batch` selects pending
//!    `kind='webhook_delivery'` rows `FOR UPDATE SKIP LOCKED` and flips them to
//!    `processing` in the same statement. Loss-free, and two senders can never
//!    grab the same row.
//! 2. **resolve** — read the subscription. Deleted or disabled ⇒ the row is
//!    settled `done` and **nothing is sent**; a queued delivery must not
//!    outlive the admin decision that stopped it.
//! 3. **send** — SSRF-guarded, address-pinned POST with an HMAC signature
//!    (`delivery.rs`).
//! 4. **audit** — `record_event_subscription_delivery` (#1204), *outside* the
//!    settlement transaction. See below.
//! 5. **settle** — success ⇒ `done` + the subscription's failure ledger reset;
//!    5xx ⇒ count the failure, auto-disable at the threshold, retry or fail;
//!    transient ⇒ backoff retry; permanent ⇒ `failed`.
//!
//! Wakeups are `LISTEN outbox` with a poll ticker fallback, so a missed NOTIFY
//! costs latency, never delivery.
//!
//! ## Why the audit is outside the settlement transaction
//!
//! The settlement says what the *queue* should do next. The audit says what
//! already happened on the *wire* — and by the time either runs, the bytes are
//! gone. If they shared a transaction, a queue-side conflict rolling back would
//! erase the record of an egress that really occurred, which is the exact
//! inversion of the atomicity argument that puts a pre-commit audit inside its
//! action's transaction. A failure to write it is loud and never blocks
//! settlement: the payload has already left, and retrying the *send* to fix an
//! audit gap would be strictly worse than the gap.
//!
//! ## Scope guards this crate keeps
//!
//! * **`webhook_delivery` only.** `broadcast` / `push_candidate` / `agent_job`
//!   rows belong to their own consumers and are never claimed here.
//! * **No SQL of its own.** Outbox statements come from `momo-outbox`,
//!   `event_subscription` statements from `momo-webhook`.
//! * **It is not the relay, and that is the point.** The relay is the
//!   workspace's only Centrifugo writer; giving it the ability to POST an
//!   operator-supplied URL would make invariant #2 unprovable from its
//!   dependency graph.

pub mod config;
pub mod delivery;
pub mod doorbell;

use std::future::Future;

use momo_db::sqlx::postgres::PgListener;
use momo_db::PgPool;
use momo_outbox::{
    backoff_seconds, claim_webhook_delivery_batch, mark_done_in_tx, mark_failed_in_tx,
    requeue_in_tx, ClaimedRow, NOTIFY_CHANNEL,
};
use momo_webhook::{DeliveryTarget, RegisteredFailure};
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;

pub use config::SenderConfig;
pub use delivery::{DeliveryResult, DoorbellTransport, SafeWebhookTransport, WebhookTransport};
pub use doorbell::{DoorbellDrainStats, DoorbellWorker};

/// The `momo.webhook_delivery.v1` envelope migration 033 enqueues.
///
/// `event` is kept as a raw `Value` and re-serialized **verbatim** as the request
/// body: the subscriber's signature is computed over those exact bytes, and a
/// round-trip through a typed struct would silently reorder or drop a field that
/// a future migration adds.
#[derive(Debug, Deserialize)]
struct WebhookDeliveryPayload {
    schema: String,
    subscription_id: Uuid,
    event: serde_json::Value,
}

#[derive(Debug, thiserror::Error)]
pub enum SenderError {
    #[error("database error: {0}")]
    Db(#[from] momo_db::sqlx::Error),
}

/// What one drain iteration did — the unit the conformance tests assert on.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DrainStats {
    pub claimed: usize,
    pub delivered: usize,
    pub requeued: usize,
    pub failed: usize,
    /// Settled `done` without sending: the subscription was gone or off.
    pub skipped: usize,
}

pub struct WebhookSender<T: WebhookTransport> {
    pool: PgPool,
    transport: T,
    config: SenderConfig,
}

impl WebhookSender<SafeWebhookTransport> {
    /// Build a sender with its own pool and the real transport. The connection
    /// string must be a BYPASSRLS role: the drain crosses every tenant, which is
    /// exactly why it is a separate credential from the API's `momo_app`.
    pub async fn connect(config: SenderConfig) -> Result<Self, SenderError> {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .max_connections(config.max_connections)
            .connect(&config.database_url)
            .await?;
        let transport =
            SafeWebhookTransport::new(config.allow_development_http, config.request_timeout);
        Ok(WebhookSender {
            pool,
            transport,
            config,
        })
    }
}

impl<T: WebhookTransport> WebhookSender<T> {
    /// Build from an existing pool + transport (conformance tests).
    pub fn new(pool: PgPool, transport: T, config: SenderConfig) -> Self {
        WebhookSender {
            pool,
            transport,
            config,
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Claim one batch and settle every row in it.
    pub async fn drain_once(&self) -> Result<DrainStats, SenderError> {
        let claimed =
            claim_webhook_delivery_batch(&self.pool, self.config.claim_batch_size).await?;
        let mut stats = DrainStats {
            claimed: claimed.len(),
            ..DrainStats::default()
        };
        for row in claimed {
            match self.process(row).await {
                Settlement::Delivered => stats.delivered += 1,
                Settlement::Requeued => stats.requeued += 1,
                Settlement::Failed => stats.failed += 1,
                Settlement::Skipped => stats.skipped += 1,
            }
        }
        Ok(stats)
    }

    /// Drain until a claim comes back short of a full batch. Errors are logged,
    /// not propagated: the next tick retries.
    pub async fn drain_to_empty(&self) -> DrainStats {
        let mut total = DrainStats::default();
        loop {
            match self.drain_once().await {
                Ok(stats) => {
                    total.claimed += stats.claimed;
                    total.delivered += stats.delivered;
                    total.requeued += stats.requeued;
                    total.failed += stats.failed;
                    total.skipped += stats.skipped;
                    if (stats.claimed as i64) < self.config.claim_batch_size {
                        return total;
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "webhook sender drain iteration failed");
                    return total;
                }
            }
        }
    }

    async fn process(&self, row: ClaimedRow) -> Settlement {
        let payload: WebhookDeliveryPayload = match serde_json::from_str(&row.payload) {
            Ok(payload) => payload,
            Err(error) => {
                tracing::error!(outbox_id = row.id, error = %error, "webhook payload decode failed");
                self.settle_alone(
                    row.id,
                    Terminal::Failed(format!("webhook payload decode: {error}")),
                )
                .await;
                return Settlement::Failed;
            }
        };
        if payload.schema != "momo.webhook_delivery.v1" {
            self.settle_alone(
                row.id,
                Terminal::Failed("unsupported webhook schema".to_string()),
            )
            .await;
            return Settlement::Failed;
        }

        let target = match self.load_target(payload.subscription_id).await {
            Ok(Some(target)) => target,
            // Deleted between enqueue and drain. Settled, not sent, not an error.
            Ok(None) => {
                self.settle_alone(row.id, Terminal::Done("subscription missing".to_string()))
                    .await;
                return Settlement::Skipped;
            }
            Err(error) => {
                tracing::error!(outbox_id = row.id, error = %error, "subscription lookup failed");
                self.settle_alone(
                    row.id,
                    Terminal::Requeue("subscription lookup failed".to_string()),
                )
                .await;
                return Settlement::Requeued;
            }
        };
        // An admin turned it off after this row was enqueued. The decision wins.
        if !target.enabled {
            self.settle_alone(row.id, Terminal::Done("subscription disabled".to_string()))
                .await;
            return Settlement::Skipped;
        }

        // SHAPE only. The address policy belongs immediately before the socket
        // (`SafeWebhookTransport::checked_address`), because a name that
        // resolved publicly when the admin saved it can resolve to
        // 169.254.169.254 by the time this row drains — a check here would be
        // the wrong one, run at the wrong moment, in a second place. What this
        // parse buys is the host for the audit line and a permanent failure for
        // a stored string that can never be a request at all.
        let Ok(url) =
            momo_webhook::parse_outbound_url(&target.url, self.config.allow_development_http)
        else {
            self.settle_alone(
                row.id,
                Terminal::Failed("stored destination is not a permitted URL".to_string()),
            )
            .await;
            return Settlement::Failed;
        };

        let event_kind = payload
            .event
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let event_id = payload
            .event
            .get("id")
            .and_then(serde_json::Value::as_str)
            .and_then(|raw| Uuid::parse_str(raw).ok());
        let body = match serde_json::to_vec(&payload.event) {
            Ok(body) => body,
            Err(error) => {
                self.settle_alone(
                    row.id,
                    Terminal::Failed(format!("webhook event encode: {error}")),
                )
                .await;
                return Settlement::Failed;
            }
        };

        let secret =
            momo_webhook::outbound_secret(&self.config.signing_master_key, &target.secret_ref);
        let result = self
            .transport
            .deliver(&url, &row.id.to_string(), &event_kind, &secret, &body)
            .await;

        // #1204 — record that the payload left, before deciding what the queue
        // does next. The mention/approval projections carry the message BODY to
        // an external host; without this line that egress leaves no trace in the
        // workspace at all. The ledger takes no body by construction (063).
        if let Some(status) = result.delivered_status() {
            self.record_audit(&row, &target, &url.host, &event_kind, event_id, status)
                .await;
        }

        match result {
            DeliveryResult::Ok(_) => {
                self.settle_success(row.id, target.id).await;
                Settlement::Delivered
            }
            DeliveryResult::ServerFailure(status) => {
                self.settle_server_failure(&row, &target, status).await
            }
            DeliveryResult::Transient { reason, .. } => {
                if row.attempts >= self.config.max_attempts {
                    self.settle_alone(row.id, Terminal::Failed(format!("max attempts: {reason}")))
                        .await;
                    return Settlement::Failed;
                }
                self.settle_alone(
                    row.id,
                    Terminal::Backoff {
                        seconds: backoff_seconds(row.attempts),
                        reason,
                    },
                )
                .await;
                Settlement::Requeued
            }
            DeliveryResult::Permanent { reason, .. } => {
                self.settle_alone(row.id, Terminal::Failed(reason)).await;
                Settlement::Failed
            }
        }
    }

    async fn load_target(
        &self,
        subscription_id: Uuid,
    ) -> Result<Option<DeliveryTarget>, momo_db::DbError> {
        let mut conn = self.pool.acquire().await.map_err(momo_db::DbError::from)?;
        momo_webhook::load_delivery_target(&mut conn, subscription_id).await
    }

    async fn record_audit(
        &self,
        row: &ClaimedRow,
        target: &DeliveryTarget,
        host: &str,
        event_kind: &str,
        event_id: Option<Uuid>,
        status: u16,
    ) {
        let write = async {
            let mut conn = self.pool.acquire().await.map_err(momo_db::DbError::from)?;
            momo_webhook::record_delivery_audit(
                &mut conn,
                target.workspace_id,
                target.id,
                event_kind,
                event_id,
                host,
                row.id,
                row.attempts,
                i32::from(status),
            )
            .await
        };
        if let Err(error) = write.await {
            // Loud, and never blocking: the payload is already gone.
            tracing::error!(
                outbox_id = row.id,
                subscription_id = %target.id,
                error = %error,
                "webhook delivery audit write failed"
            );
        }
    }

    /// Success: the outbox row and the subscription's failure ledger move
    /// together, so "delivered" and "healthy again" are one fact.
    async fn settle_success(&self, outbox_id: i64, subscription_id: Uuid) {
        let result: Result<(), momo_db::DbError> = async {
            let mut tx = self.pool.begin().await.map_err(momo_db::DbError::from)?;
            momo_webhook::reset_delivery_failures(&mut tx, subscription_id).await?;
            mark_done_in_tx(&mut tx, outbox_id, None).await?;
            tx.commit().await.map_err(momo_db::DbError::from)
        }
        .await;
        if let Err(error) = result {
            // At-least-once: a lost settlement means a re-send, which is the
            // documented delivery contract (the subscriber de-duplicates on
            // `X-Momo-Delivery`).
            tracing::error!(outbox_id, error = %error, "webhook success settlement failed");
        }
    }

    /// A destination-side 5xx. One transaction: count the failure (possibly
    /// disabling the subscription and writing the audit line that says so) and
    /// settle the queue row accordingly.
    async fn settle_server_failure(
        &self,
        row: &ClaimedRow,
        target: &DeliveryTarget,
        status: u16,
    ) -> Settlement {
        let attempts = row.attempts;
        let max_attempts = self.config.max_attempts;
        let disable_after = self.config.disable_after_server_failures;
        let outbox_id = row.id;
        let subscription_id = target.id;

        let outcome: Result<Settlement, momo_db::DbError> = async {
            let mut tx = self.pool.begin().await.map_err(momo_db::DbError::from)?;
            let registered = momo_webhook::register_delivery_failure(
                &mut tx,
                subscription_id,
                i32::from(status),
                outbox_id,
                disable_after,
            )
            .await?;
            let settlement = match registered {
                RegisteredFailure::Missing => {
                    mark_done_in_tx(&mut tx, outbox_id, Some("subscription missing")).await?;
                    Settlement::Skipped
                }
                RegisteredFailure::Disabled => {
                    mark_done_in_tx(&mut tx, outbox_id, Some("subscription disabled")).await?;
                    Settlement::Skipped
                }
                RegisteredFailure::AutoDisabled { .. } => {
                    mark_failed_in_tx(
                        &mut tx,
                        outbox_id,
                        &format!("webhook auto-disabled after HTTP {status}"),
                    )
                    .await?;
                    Settlement::Failed
                }
                RegisteredFailure::Counted { .. } => {
                    if attempts >= max_attempts {
                        mark_failed_in_tx(
                            &mut tx,
                            outbox_id,
                            &format!("max attempts: HTTP {status}"),
                        )
                        .await?;
                        Settlement::Failed
                    } else {
                        requeue_in_tx(
                            &mut tx,
                            outbox_id,
                            backoff_seconds(attempts),
                            &format!("HTTP {status}"),
                        )
                        .await?;
                        Settlement::Requeued
                    }
                }
            };
            tx.commit().await.map_err(momo_db::DbError::from)?;
            Ok(settlement)
        }
        .await;

        match outcome {
            Ok(settlement) => settlement,
            Err(error) => {
                tracing::error!(outbox_id, error = %error, "webhook 5xx settlement failed");
                Settlement::Requeued
            }
        }
    }

    /// Settle the outbox row alone — used by every path that does not touch the
    /// subscription's ledger.
    async fn settle_alone(&self, outbox_id: i64, terminal: Terminal) {
        let result: Result<(), momo_db::DbError> = async {
            let mut conn = self.pool.acquire().await.map_err(momo_db::DbError::from)?;
            match &terminal {
                Terminal::Done(reason) => {
                    mark_done_in_tx(&mut conn, outbox_id, Some(reason)).await?
                }
                Terminal::Failed(reason) => mark_failed_in_tx(&mut conn, outbox_id, reason).await?,
                Terminal::Backoff { seconds, reason } => {
                    requeue_in_tx(&mut conn, outbox_id, *seconds, reason).await?
                }
                Terminal::Requeue(reason) => requeue_in_tx(&mut conn, outbox_id, 1, reason).await?,
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            tracing::error!(outbox_id, error = %error, "webhook settlement failed");
        }
    }

    /// Run until `shutdown` resolves: NOTIFY-driven drains with a poll fallback.
    pub async fn run(&self, shutdown: impl Future<Output = ()>) {
        tracing::info!(
            poll_interval_ms = self.config.poll_interval.as_millis() as u64,
            claim_batch = self.config.claim_batch_size,
            disable_after_5xx = self.config.disable_after_server_failures,
            "webhook sender starting"
        );

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
        tracing::info!("webhook sender stopped");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Settlement {
    Delivered,
    Requeued,
    Failed,
    Skipped,
}

enum Terminal {
    Done(String),
    Failed(String),
    Backoff { seconds: i64, reason: String },
    Requeue(String),
}

/// Hold a dedicated `LISTEN outbox` connection and nudge the drain loop.
///
/// The trigger fires `pg_notify('outbox', kind)` for **every** kind, so this
/// loop is woken by broadcast rows too. That is harmless — the claim filters by
/// kind and an empty drain is one cheap query — and it is why the sender does
/// not need a notification channel of its own.
async fn listen_loop(database_url: String, wake: mpsc::Sender<()>) {
    loop {
        match PgListener::connect(&database_url).await {
            Ok(mut listener) => match listener.listen(NOTIFY_CHANNEL).await {
                Ok(()) => loop {
                    match listener.recv().await {
                        Ok(_notification) => {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The envelope must decode exactly what migration 033 enqueues, and the
    /// event must survive as raw JSON — the subscriber's signature is over those
    /// bytes.
    #[test]
    fn the_033_envelope_decodes_and_the_event_stays_verbatim() {
        let raw = r#"{
          "schema": "momo.webhook_delivery.v1",
          "subscription_id": "00000000-0000-0000-0000-000000000001",
          "event": {
            "schema": "momo.event.v0",
            "id": "00000000-0000-0000-0000-000000000002",
            "kind": "mention",
            "workspace_id": "00000000-0000-0000-0000-000000000003",
            "occurred_at": "2026-08-10T00:00:00Z",
            "data": {"body": "hi", "unknown_future_field": 1}
          }
        }"#;
        let payload: WebhookDeliveryPayload = serde_json::from_str(raw).expect("decode");
        assert_eq!(payload.schema, "momo.webhook_delivery.v1");
        assert_eq!(payload.subscription_id, Uuid::from_u128(1));
        assert_eq!(payload.event["kind"], "mention");
        assert_eq!(
            payload.event["data"]["unknown_future_field"], 1,
            "a field a future migration adds must reach the subscriber, not be dropped \
             by a typed round-trip that would also break the signature"
        );
    }

    /// A payload from another schema version must be failed, not guessed at.
    #[test]
    fn a_foreign_schema_is_recognisable_before_anything_is_sent() {
        let payload: WebhookDeliveryPayload = serde_json::from_str(
            r#"{"schema":"momo.webhook_delivery.v2","subscription_id":"00000000-0000-0000-0000-000000000001","event":{}}"#,
        )
        .expect("decode");
        assert_ne!(payload.schema, "momo.webhook_delivery.v1");
    }
}
