//! Drain `unfurl_job`: extract URLs → cache or fetch → upsert → broadcast.
//!
//! HTTP happens *outside* the tenant transaction. Holding a Postgres
//! transaction across a GET is how a slow origin becomes a pool outage.

use std::sync::Arc;

use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_outbox::{emit_outbox, OutboxKind};
use serde_json::{json, Value};
use sqlx::PgConnection;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::card::{build_card, CardFields};
use crate::config::UnfurlConfig;
use crate::extract::extract_urls;
use crate::fetch::{FetchError, FetchKind, Fetched, UnfurlHttp};
use crate::proxy::{icon_path, image_path};
use crate::settings::workspace_fetch_allowed;
use crate::store::{
    cache_lookup, cent_channel, claim_job_batch, finish_job, image_proxy_key, list_unfurls_in_tx,
    load_message, requeue_job, tombstone_exists, upsert_unfurl_and_cache, ClaimedJob, UnfurlRecord,
    UpsertSpec,
};

pub const NOTIFY_CHANNEL: &str = "unfurl";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DrainStats {
    pub claimed: usize,
    pub fetched: usize,
    pub cached: usize,
    pub skipped: usize,
    pub failed: usize,
}

pub struct UnfurlWorker<T: UnfurlHttp> {
    pool: PgPool,
    http: Arc<T>,
    config: UnfurlConfig,
}

impl UnfurlWorker<crate::SafeUnfurlTransport> {
    pub async fn connect(config: UnfurlConfig) -> Result<Self, sqlx::Error> {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .max_connections(config.max_connections)
            .connect(&config.database_url)
            .await?;
        let http = Arc::new(crate::SafeUnfurlTransport::new(
            config.allow_development_http,
            config.request_timeout,
        ));
        Ok(UnfurlWorker { pool, http, config })
    }
}

impl<T: UnfurlHttp + 'static> UnfurlWorker<T> {
    pub fn new(pool: PgPool, http: Arc<T>, config: UnfurlConfig) -> Self {
        UnfurlWorker { pool, http, config }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn drain_once(&self) -> Result<DrainStats, DbError> {
        if !self.config.enabled {
            return Ok(DrainStats::default());
        }
        let claimed = claim_job_batch(&self.pool, self.config.claim_batch_size).await?;
        let mut stats = DrainStats {
            claimed: claimed.len(),
            ..DrainStats::default()
        };
        for job in claimed {
            match self.process(job).await {
                Process::Fetched => stats.fetched += 1,
                Process::Cached => stats.cached += 1,
                Process::Skipped => stats.skipped += 1,
                Process::Failed => stats.failed += 1,
            }
        }
        Ok(stats)
    }

    pub async fn drain_to_empty(&self) -> DrainStats {
        let mut total = DrainStats::default();
        loop {
            match self.drain_once().await {
                Ok(stats) => {
                    total.claimed += stats.claimed;
                    total.fetched += stats.fetched;
                    total.cached += stats.cached;
                    total.skipped += stats.skipped;
                    total.failed += stats.failed;
                    if (stats.claimed as i64) < self.config.claim_batch_size {
                        return total;
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "unfurl drain iteration failed");
                    return total;
                }
            }
        }
    }

    pub async fn run(&self, shutdown: impl std::future::Future<Output = ()>) {
        if !self.config.enabled {
            tracing::info!("unfurl worker idle (MOMO_UNFURL_ENABLED!=1)");
            shutdown.await;
            return;
        }
        tracing::info!(
            poll_interval_ms = self.config.poll_interval.as_millis() as u64,
            claim_batch = self.config.claim_batch_size,
            "unfurl worker starting"
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
                    if wake.is_none() { /* poll fallback */ }
                }
            }
            self.drain_to_empty().await;
        }
        listener.abort();
        tracing::info!("unfurl worker stopped");
    }

    async fn process(&self, job: ClaimedJob) -> Process {
        let prepared = match self.prepare(&job).await {
            Ok(prepared) => prepared,
            Err(error) => {
                tracing::error!(job = %job.id, error = %error, "unfurl prepare failed");
                self.settle_requeue_or_fail(&job, "prepare failed").await;
                return Process::Failed;
            }
        };
        match prepared {
            Prepared::Skip(reason) => {
                let _ = finish_job(&self.pool, job.id, "skipped", Some(reason)).await;
                Process::Skipped
            }
            Prepared::Ready(plan) => {
                let mut fetched_any = false;
                let mut cached_any = false;
                let mut cards: Vec<CardResult> = Vec::new();
                for url in plan.urls {
                    match plan.cache.get(&url).cloned() {
                        Some(hit) => {
                            cached_any = true;
                            cards.push(CardResult::Cached { url, hit });
                        }
                        None => match self.http.fetch(&url, FetchKind::Html).await {
                            Ok(fetched) => {
                                fetched_any = true;
                                // D11: a page with no title and no picture gives a card nothing
                                // to show. It is recorded the way every other quiet end is.
                                let settled = match build_card_off_thread(
                                    fetched,
                                    self.config.allow_development_http,
                                )
                                .await
                                {
                                    Some(card) => Settled::ok(card),
                                    None => Settled::quiet("failed"),
                                };
                                cards.push(CardResult::Fetched { url, card: settled });
                            }
                            Err(error) if error.is_blocked() => {
                                fetched_any = true;
                                cards.push(CardResult::Fetched {
                                    url,
                                    card: Settled::quiet("blocked"),
                                });
                            }
                            // A fetch this server had no room for (`Capacity`) is as transient as
                            // one that timed out: it gets the same later attempt.
                            Err(FetchError::Timeout)
                            | Err(FetchError::Failed(_))
                            | Err(FetchError::Capacity)
                                if job.attempts < self.config.max_attempts =>
                            {
                                self.settle_requeue_or_fail(&job, "transient fetch").await;
                                return Process::Failed;
                            }
                            Err(_) => {
                                fetched_any = true;
                                cards.push(CardResult::Fetched {
                                    url,
                                    card: Settled::quiet("failed"),
                                });
                            }
                        },
                    }
                }
                if let Err(error) = self.commit_cards(&job, &plan.message, cards).await {
                    tracing::error!(job = %job.id, error = %error, "unfurl commit failed");
                    self.settle_requeue_or_fail(&job, "commit failed").await;
                    return Process::Failed;
                }
                if fetched_any {
                    Process::Fetched
                } else if cached_any {
                    Process::Cached
                } else {
                    Process::Skipped
                }
            }
        }
    }

    async fn prepare(&self, job: &ClaimedJob) -> Result<Prepared, DbError> {
        let workspace_id = job.workspace_id;
        let message_id = job.message_id;
        with_tenant_tx(&self.pool, workspace_id, |conn| {
            Box::pin(async move {
                if tombstone_exists(conn, message_id).await? {
                    return Ok(Prepared::Skip("tombstone"));
                }
                if !workspace_fetch_allowed(conn, workspace_id).await? {
                    return Ok(Prepared::Skip("workspace off"));
                }
                let Some(message) = load_message(conn, message_id).await? else {
                    return Ok(Prepared::Skip("message missing"));
                };
                let urls = extract_urls(message.body.as_deref().unwrap_or(""));
                if urls.is_empty() {
                    return Ok(Prepared::Skip("no urls"));
                }
                let mut cache = std::collections::HashMap::new();
                for url in &urls {
                    if let Some(hit) = cache_lookup(conn, workspace_id, url).await? {
                        cache.insert(url.clone(), hit);
                    }
                }
                Ok(Prepared::Ready(Plan {
                    message,
                    urls,
                    cache,
                }))
            })
        })
        .await
    }

    async fn commit_cards(
        &self,
        job: &ClaimedJob,
        message: &crate::store::MessageRef,
        cards: Vec<CardResult>,
    ) -> Result<(), DbError> {
        let workspace_id = job.workspace_id;
        let channel_id = job.channel_id;
        let message_id = job.message_id;
        let job_id = job.id;
        let seq = message.seq;
        with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if tombstone_exists(conn, message_id).await? {
                    finish_job(&mut *conn, job_id, "skipped", Some("tombstone")).await?;
                    return Ok(());
                }
                for card in &cards {
                    match card {
                        CardResult::Cached { url, hit } => {
                            upsert_unfurl_and_cache(
                                conn,
                                UpsertSpec {
                                    workspace_id,
                                    channel_id,
                                    message_id,
                                    url_key: url,
                                    source_url: url,
                                    status: &hit.status,
                                    title: hit.title.as_deref(),
                                    description: hit.description.as_deref(),
                                    domain: hit.domain.as_deref(),
                                    image_proxy_key: hit.image_proxy_key.as_deref(),
                                    image_url: hit.image_url.as_deref(),
                                    site_name: hit.site_name.as_deref(),
                                    icon_proxy_key: hit.icon_proxy_key.as_deref(),
                                    icon_source_url: hit.icon_source_url.as_deref(),
                                    image_width: hit.image_width,
                                    image_height: hit.image_height,
                                    is_video: hit.is_video,
                                },
                            )
                            .await?;
                        }
                        CardResult::Fetched { url, card } => {
                            let image_key = card.image_url.as_ref().map(|u| image_proxy_key(u));
                            let icon_key = card.icon_url.as_ref().map(|u| image_proxy_key(u));
                            upsert_unfurl_and_cache(
                                conn,
                                UpsertSpec {
                                    workspace_id,
                                    channel_id,
                                    message_id,
                                    url_key: url,
                                    source_url: url,
                                    status: card.status,
                                    title: card.title.as_deref(),
                                    description: card.description.as_deref(),
                                    domain: card.domain.as_deref(),
                                    image_proxy_key: image_key.as_deref(),
                                    image_url: card.image_url.as_deref(),
                                    site_name: card.site_name.as_deref(),
                                    icon_proxy_key: icon_key.as_deref(),
                                    icon_source_url: card.icon_url.as_deref(),
                                    image_width: card.image_width,
                                    image_height: card.image_height,
                                    is_video: card.is_video,
                                },
                            )
                            .await?;
                        }
                    }
                }
                let records = list_unfurls_in_tx(conn, message_id).await?;
                emit_unfurl_broadcast(conn, workspace_id, channel_id, message_id, seq, &records)
                    .await?;
                finish_job(&mut *conn, job_id, "done", None).await?;
                Ok(())
            })
        })
        .await
    }

    async fn settle_requeue_or_fail(&self, job: &ClaimedJob, reason: &str) {
        let result = if job.attempts >= self.config.max_attempts {
            finish_job(&self.pool, job.id, "done", Some(reason)).await
        } else {
            requeue_job(&self.pool, job.id, reason).await
        };
        if let Err(error) = result {
            tracing::error!(job = %job.id, error = %error, "unfurl settlement failed");
        }
    }
}

enum Process {
    Fetched,
    Cached,
    Skipped,
    Failed,
}

enum Prepared {
    Skip(&'static str),
    Ready(Plan),
}

struct Plan {
    message: crate::store::MessageRef,
    urls: Vec<String>,
    cache: std::collections::HashMap<String, crate::store::CacheHit>,
}

enum CardResult {
    Cached {
        url: String,
        hit: crate::store::CacheHit,
    },
    Fetched {
        url: String,
        card: Settled,
    },
}

/// What one fetched link ends up as: a card with fields, or one of the quiet ends (no fields).
struct Settled {
    status: &'static str,
    title: Option<String>,
    description: Option<String>,
    domain: Option<String>,
    site_name: Option<String>,
    image_url: Option<String>,
    image_width: Option<i32>,
    image_height: Option<i32>,
    icon_url: Option<String>,
    is_video: bool,
}

impl Settled {
    fn ok(card: CardFields) -> Settled {
        Settled {
            status: "ok",
            title: card.title,
            description: card.description,
            domain: card.domain,
            site_name: card.site_name,
            image_url: card.image_url,
            image_width: card.image_width,
            image_height: card.image_height,
            icon_url: card.icon_url,
            is_video: card.is_video,
        }
    }

    /// `failed` / `blocked`: a row clients already render as nothing (ADR-0170 D5).
    fn quiet(status: &'static str) -> Settled {
        Settled {
            status,
            title: None,
            description: None,
            domain: None,
            site_name: None,
            image_url: None,
            image_width: None,
            image_height: None,
            icon_url: None,
            is_video: false,
        }
    }
}

/// Read one fetched page into a card on the blocking pool (#4881 security review H-1, the second
/// layer behind the linear-time parser).
///
/// Reading a page is CPU work over up to 512 KiB of somebody else's text, and this worker is one
/// branch of the `select!` that `momo-webhook-sender` runs next to webhook delivery and the
/// doorbell. Inline, a page that is slow to read stops all three; on the blocking pool it can
/// only slow its own job. The page's bytes move into the closure, nothing is cloned. A panic in
/// the reading code ends the job as the quiet `failed` a page with nothing to show gets, and is
/// logged without the page's address or text.
async fn build_card_off_thread(
    fetched: Fetched,
    allow_development_http: bool,
) -> Option<CardFields> {
    let built = tokio::task::spawn_blocking(move || {
        build_card(
            &fetched.final_url,
            &fetched.content_type,
            &fetched.body,
            allow_development_http,
        )
    })
    .await;
    match built {
        Ok(card) => card,
        Err(error) => {
            // Not `error`'s text: a `JoinError` carries the panic's message, and the message of a
            // slicing panic can quote the text that was being sliced.
            tracing::error!(
                panicked = error.is_panic(),
                cancelled = error.is_cancelled(),
                "unfurl card builder did not finish"
            );
            None
        }
    }
}

async fn emit_unfurl_broadcast(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    seq: i64,
    records: &[UnfurlRecord],
) -> Result<(), DbError> {
    let channel = cent_channel(workspace_id, channel_id);
    let cards: Vec<Value> = records
        .iter()
        .map(|record| {
            let mut card = serde_json::Map::new();
            card.insert("id".into(), json!(record.id));
            card.insert("message_id".into(), json!(record.message_id));
            card.insert("url".into(), json!(record.source_url));
            card.insert("status".into(), json!(record.status));
            if let Some(title) = &record.title {
                card.insert("title".into(), json!(title));
            }
            if let Some(description) = &record.description {
                card.insert("description".into(), json!(description));
            }
            if let Some(domain) = &record.domain {
                card.insert("domain".into(), json!(domain));
            }
            if record.image_proxy_key.is_some() {
                card.insert(
                    "image_url".into(),
                    json!(image_path(workspace_id, record.id)),
                );
            }
            // ADR-0170 amendment D6: new optional keys. The icon is only ever its proxy path.
            if let Some(site_name) = &record.site_name {
                card.insert("site_name".into(), json!(site_name));
            }
            if record.icon_proxy_key.is_some() {
                card.insert("icon_url".into(), json!(icon_path(workspace_id, record.id)));
            }
            if let (Some(width), Some(height)) = (record.image_width, record.image_height) {
                card.insert("image_width".into(), json!(width));
                card.insert("image_height".into(), json!(height));
            }
            if record.is_video {
                card.insert("is_video".into(), json!(true));
            }
            Value::Object(card)
        })
        .collect();
    let payload = json!({
        "channel": channel,
        "data": {
            "type": "message.unfurl",
            "v": 1,
            "ts": chrono::Utc::now().timestamp_millis(),
            "seq": seq,
            "payload": {
                "message_id": message_id,
                "channel_id": channel_id,
                "unfurls": cards,
            }
        },
        "idempotency_key": format!("{channel}:message.unfurl:{message_id}")
    });
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(channel_id),
    )
    .await?;
    Ok(())
}

async fn listen_loop(database_url: String, wake: mpsc::Sender<()>) {
    loop {
        match momo_db::sqlx::postgres::PgListener::connect(&database_url).await {
            Ok(mut listener) => match listener.listen(NOTIFY_CHANNEL).await {
                Ok(()) => loop {
                    match listener.recv().await {
                        Ok(_) => {
                            let _ = wake.try_send(());
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "unfurl LISTEN lost; poll fallback");
                            break;
                        }
                    }
                },
                Err(error) => {
                    tracing::warn!(error = %error, "unfurl LISTEN register failed");
                }
            },
            Err(error) => {
                tracing::warn!(error = %error, "unfurl LISTEN connect failed");
            }
        }
        if wake.is_closed() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}
