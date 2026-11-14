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
//! * **one judgment for a room with a read floor** (ADR-0177 증보 D17, [`audience`]):
//!   a room frame whose target is below a live member's floor goes to the
//!   personal channels of the members who can see the target instead of the
//!   room. Nothing else about the row changes.

pub mod audience;
pub mod centrifugo;
pub mod config;

use std::collections::HashSet;
use std::future::Future;

use momo_db::sqlx::postgres::PgListener;
use momo_db::PgPool;
use momo_outbox::{
    backoff_seconds, claim_broadcast_batch, mark_done, mark_failed, requeue, ClaimedRow,
    NOTIFY_CHANNEL,
};
use momo_wire::payload::BroadcastPayload;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::audience::{diverted_data, personal_channel, room_channel_id, room_channel_ids, Route};

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
    /// Of `published`: room frames that went to personal channels instead of the room
    /// (ADR-0177 증보 D17). A frame with no audience left counts here too.
    pub diverted: usize,
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
        let decoded: Vec<(ClaimedRow, Result<BroadcastPayload, serde_json::Error>)> = claimed
            .into_iter()
            .map(|row| {
                let payload = serde_json::from_str(&row.payload);
                (row, payload)
            })
            .collect();
        // ADR-0177 증보 D17: which of this batch's rooms have a live member with a floor, asked once
        // for the whole batch. Unanswered means unjudged, so the batch goes back (closed, and
        // loss-free: every row is requeued, none is left in `processing`).
        let floored = match self.floored_rooms(&decoded).await {
            Ok(floored) => floored,
            Err(error) => {
                tracing::error!(error = %error, "room floor check failed; requeueing the batch");
                for (row, _) in decoded {
                    self.settle_transient(&row, &format!("room floor check: {error}"))
                        .await;
                    stats.requeued += 1;
                }
                return Ok(stats);
            }
        };
        for (row, payload) in decoded {
            match self.process(row, payload, &floored).await {
                Settlement::Published => stats.published += 1,
                Settlement::Diverted => {
                    stats.published += 1;
                    stats.diverted += 1;
                }
                Settlement::Requeued => stats.requeued += 1,
                Settlement::Failed => stats.failed += 1,
            }
        }
        Ok(stats)
    }

    /// The `(workspace, room)` pairs of `rows` with a live member that has a read floor. The
    /// workspace is the outbox row's own (written inside its tenant transaction), never the one
    /// spelled in the channel name.
    async fn floored_rooms(
        &self,
        rows: &[(ClaimedRow, Result<BroadcastPayload, serde_json::Error>)],
    ) -> Result<HashSet<(Uuid, Uuid)>, momo_db::sqlx::Error> {
        let mut rooms: Vec<(Uuid, Uuid)> = rows
            .iter()
            .filter_map(|(row, payload)| {
                let channel = &payload.as_ref().ok()?.channel;
                Some((row.workspace_id, room_channel_id(channel)?))
            })
            .collect();
        rooms.sort();
        rooms.dedup();
        audience::rooms_with_floor(&self.pool, &rooms).await
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
                    total.diverted += stats.diverted;
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
    async fn process(
        &self,
        row: ClaimedRow,
        payload: Result<BroadcastPayload, serde_json::Error>,
        floored: &HashSet<(Uuid, Uuid)>,
    ) -> Settlement {
        let payload = match payload {
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

        // A room channel that spells another workspace than the row's own is never judged against
        // that room and never sent (closed). The app writes the name from the row's own tenant
        // transaction, so such a row is not one of its frames.
        if let Some((named_workspace, _)) = room_channel_ids(&payload.channel) {
            if named_workspace != row.workspace_id {
                tracing::error!(
                    outbox_id = row.id,
                    "room channel names another workspace than its outbox row"
                );
                self.settle_failed(row.id, "room channel names another workspace")
                    .await;
                return Settlement::Failed;
            }
        }
        let room = room_channel_id(&payload.channel)
            .map(|channel_id| (row.workspace_id, channel_id))
            .filter(|room| floored.contains(room));
        if let Some((workspace_id, channel_id)) = room {
            let route = audience::route_in_floored_room(
                &self.pool,
                workspace_id,
                channel_id,
                &payload.data,
            )
            .await;
            match route {
                Ok(Route::Room) => {}
                Ok(Route::Members(members)) => return self.divert(row, &payload, &members).await,
                Err(error) => {
                    tracing::error!(outbox_id = row.id, error = %error, "room audience read failed");
                    return self
                        .settle_transient(&row, &format!("room audience: {error}"))
                        .await;
                }
            }
        }

        let outcome = self.publisher.publish(&payload).await;
        self.settle(&row, outcome, Settlement::Published, &payload.channel)
            .await
    }

    /// Publish a room frame to its audience's personal channels instead of the room (ADR-0177
    /// 증보 D17). Same `data` plus the room's name, same idempotency key, no `version`. An empty
    /// audience publishes nothing and settles the row as done.
    async fn divert(
        &self,
        row: ClaimedRow,
        payload: &BroadcastPayload,
        members: &[Uuid],
    ) -> Settlement {
        if members.is_empty() {
            if let Err(error) = mark_done(&self.pool, row.id, Some("no audience")).await {
                tracing::error!(outbox_id = row.id, error = %error, "mark_done failed");
            }
            return Settlement::Diverted;
        }
        let Some(data) = diverted_data(&payload.data, &payload.channel) else {
            tracing::error!(outbox_id = row.id, "room frame data is not an object");
            self.settle_failed(row.id, "room frame data is not an object")
                .await;
            return Settlement::Failed;
        };
        let channels: Vec<String> = members.iter().copied().map(personal_channel).collect();
        let outcome = self
            .publisher
            .broadcast(&channels, &data, payload.idempotency_key.as_deref())
            .await;
        self.settle(&row, outcome, Settlement::Diverted, &payload.channel)
            .await
    }

    /// Settle a row by its publish outcome. `ok` is what a success counts as.
    async fn settle(
        &self,
        row: &ClaimedRow,
        outcome: PublishOutcome,
        ok: Settlement,
        channel: &str,
    ) -> Settlement {
        match outcome {
            PublishOutcome::Ok => {
                if let Err(error) = mark_done(&self.pool, row.id, None).await {
                    // At-least-once: a lost status write means a re-publish,
                    // which the idempotency_key makes harmless.
                    tracing::error!(outbox_id = row.id, error = %error, "mark_done failed");
                }
                tracing::debug!(
                    outbox_id = row.id,
                    channel = %channel,
                    diverted = matches!(ok, Settlement::Diverted),
                    "published"
                );
                ok
            }
            PublishOutcome::Permanent(reason) => {
                tracing::error!(outbox_id = row.id, reason, "permanent publish failure");
                self.settle_failed(row.id, &reason).await;
                Settlement::Failed
            }
            PublishOutcome::Transient(reason) => self.settle_transient(row, &reason).await,
        }
    }

    /// A retryable failure: back to `pending` with backoff, or `failed` at the attempt limit.
    async fn settle_transient(&self, row: &ClaimedRow, reason: &str) -> Settlement {
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
        if let Err(error) = requeue(&self.pool, row.id, backoff, reason).await {
            tracing::error!(outbox_id = row.id, error = %error, "requeue failed");
        }
        Settlement::Requeued
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
    /// Published to personal channels instead of the room (or to nobody), ADR-0177 증보 D17.
    Diverted,
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
