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

use crate::config::UnfurlConfig;
use crate::extract::extract_urls;
use crate::fetch::{FetchError, FetchKind, UnfurlHttp};
use crate::parse::parse_card;
use crate::settings::workspace_fetch_allowed;
use crate::store::{
    cache_lookup, cent_channel, claim_job_batch, domain_of, finish_job, image_proxy_key,
    list_unfurls_in_tx, load_message, requeue_job, tombstone_exists, upsert_unfurl_and_cache,
    ClaimedJob, UnfurlRecord, UpsertSpec,
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
                                let html = String::from_utf8_lossy(&fetched.body);
                                let card = parse_card(&html);
                                let image_url = card
                                    .image_url
                                    .as_ref()
                                    .and_then(|raw| resolve_image(&fetched.final_url, raw));
                                cards.push(CardResult::Fetched {
                                    url,
                                    status: "ok",
                                    title: card.title,
                                    description: card.description,
                                    domain: domain_of(&fetched.final_url),
                                    image_url,
                                });
                            }
                            Err(error) if error.is_blocked() => {
                                fetched_any = true;
                                cards.push(CardResult::Fetched {
                                    url,
                                    status: "blocked",
                                    title: None,
                                    description: None,
                                    domain: None,
                                    image_url: None,
                                });
                            }
                            Err(FetchError::Timeout) | Err(FetchError::Failed(_))
                                if job.attempts < self.config.max_attempts =>
                            {
                                self.settle_requeue_or_fail(&job, "transient fetch").await;
                                return Process::Failed;
                            }
                            Err(_) => {
                                fetched_any = true;
                                cards.push(CardResult::Fetched {
                                    url,
                                    status: "failed",
                                    title: None,
                                    description: None,
                                    domain: None,
                                    image_url: None,
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
                                },
                            )
                            .await?;
                        }
                        CardResult::Fetched {
                            url,
                            status,
                            title,
                            description,
                            domain,
                            image_url,
                        } => {
                            let proxy_key = image_url.as_ref().map(|u| image_proxy_key(u));
                            upsert_unfurl_and_cache(
                                conn,
                                UpsertSpec {
                                    workspace_id,
                                    channel_id,
                                    message_id,
                                    url_key: url,
                                    source_url: url,
                                    status,
                                    title: title.as_deref(),
                                    description: description.as_deref(),
                                    domain: domain.as_deref(),
                                    image_proxy_key: proxy_key.as_deref(),
                                    image_url: image_url.as_deref(),
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
        status: &'static str,
        title: Option<String>,
        description: Option<String>,
        domain: Option<String>,
        image_url: Option<String>,
    },
}

fn resolve_image(page_url: &str, raw: &str) -> Option<String> {
    let joined = url::Url::parse(page_url).ok()?.join(raw).ok()?;
    crate::normalize::normalize_url(joined.as_str()).ok()
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
                    json!(format!(
                        "/v1/workspaces/{workspace_id}/unfurls/{}/image",
                        record.id
                    )),
                );
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
