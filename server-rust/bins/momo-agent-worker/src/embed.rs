//! Local embeddings for team-memory vector search (#3173, ADR-0196 D8 증보).
//!
//! Two jobs, one model, both inside this process:
//!
//! * **Serving** — [`EmbedService::embed_query`] turns the question of an agent turn into a
//!   vector under a strict budget (`MEMORY_EMBED_QUERY_TIMEOUT_MS`). It never waits for the model
//!   to load, never queues behind more than a couple of other queries, and answers `None` on
//!   *anything* wrong (no model, timeout, error). The caller then serves keyword-only: the reply
//!   never depends on this module (memory is an enhancement, ADR-0196 D7).
//! * **Backfill / new items** — [`AgentWorker::embed_sweep`] embeds live items that have no vector
//!   for the current model yet, in small batches with a per-workspace cap per sweep. New items,
//!   edited copies, accepted proposals and old history are the same code path: "no embedding row
//!   for this model". Nothing here decides who may see an item — the vector is only a ranking
//!   signal, and every candidate it produces still passes `mem_item_readable_by` and the audience
//!   rule inside SQL (migration 107).
//!
//! ## The model is a seam
//!
//! [`EmbedService`] holds a loader for a [`TextEmbedder`]; production loads the ONNX model from
//! `MEMORY_EMBED_MODEL_DIR`, tests inject `momo_embed::testing::MockEmbedder`. The real model loads
//! **once, lazily, on the blocking pool**, is warmed in the background when the worker starts (so
//! the first reply does not pay ~0.5 s), and a load failure is logged once and remembered.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use momo_agent::memory as mem;
use momo_embed::{vector_literal, EmbedError, TextEmbedder};
use tokio::sync::{OnceCell, Semaphore};
use uuid::Uuid;

use crate::config::MemoryConfig;
use crate::AgentWorker;

type Loader = dyn Fn() -> Result<Arc<dyn TextEmbedder>, EmbedError> + Send + Sync;

/// Concurrent serving-side embeddings allowed. A third simultaneous reply serves keyword-only
/// rather than queue behind a saturated model.
const MAX_QUERY_INFLIGHT: usize = 2;
/// A workspace with nothing to embed is not asked again for this long (unless this process
/// stored a new item, which wakes it).
const IDLE_RECHECK: Duration = Duration::from_secs(300);
/// Wall-clock cap on one batch of stored items (a saturated machine must not hang a sweep).
const BATCH_TIMEOUT: Duration = Duration::from_secs(60);

/// A query embedding ready for SQL: pgvector text plus the model it belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryVector {
    pub literal: String,
    pub model: String,
}

struct Inner {
    enabled: bool,
    query_timeout: Duration,
    loader: Box<Loader>,
    slot: OnceCell<Option<Arc<dyn TextEmbedder>>>,
    inflight: Arc<Semaphore>,
    idle: Mutex<HashMap<Uuid, Instant>>,
    load_failed_logged: AtomicBool,
}

/// Cheap to clone; one per worker.
#[derive(Clone)]
pub struct EmbedService {
    inner: Arc<Inner>,
}

impl EmbedService {
    /// Never embeds; serving is keyword-only. (Tests and `MEMORY_EMBED_ENABLED=0`.)
    pub fn disabled() -> EmbedService {
        EmbedService::build(
            false,
            Duration::from_millis(250),
            Box::new(|| Err(EmbedError::Load("embedding is disabled".to_string()))),
        )
    }

    /// The production service: the ONNX model in `cfg.embed_model_dir`, loaded on first need.
    pub fn from_config(cfg: &MemoryConfig) -> EmbedService {
        if !cfg.embed_enabled {
            return EmbedService::disabled();
        }
        let dir = PathBuf::from(&cfg.embed_model_dir);
        let threads = cfg.embed_threads;
        EmbedService::build(
            true,
            cfg.embed_query_timeout,
            Box::new(move || {
                let model = momo_embed::OnnxEmbedder::load(&dir, Some(threads))?;
                Ok(Arc::new(model) as Arc<dyn TextEmbedder>)
            }),
        )
    }

    /// A service around an already-built embedder (tests: a mock, a slow one, a failing one).
    pub fn with_embedder(embedder: Arc<dyn TextEmbedder>, query_timeout: Duration) -> EmbedService {
        EmbedService::build(true, query_timeout, Box::new(move || Ok(embedder.clone())))
    }

    fn build(enabled: bool, query_timeout: Duration, loader: Box<Loader>) -> EmbedService {
        EmbedService {
            inner: Arc::new(Inner {
                enabled,
                query_timeout,
                loader,
                slot: OnceCell::new(),
                inflight: Arc::new(Semaphore::new(MAX_QUERY_INFLIGHT)),
                idle: Mutex::new(HashMap::new()),
                load_failed_logged: AtomicBool::new(false),
            }),
        }
    }

    pub fn enabled(&self) -> bool {
        self.inner.enabled
    }

    /// The embedder, loading it now if nobody has (blocking pool). `None` = unavailable; the reason
    /// is logged once.
    pub async fn embedder(&self) -> Option<Arc<dyn TextEmbedder>> {
        if !self.inner.enabled {
            return None;
        }
        let inner = self.inner.clone();
        self.inner
            .slot
            .get_or_init(|| async move {
                let loader_inner = inner.clone();
                let loaded = tokio::task::spawn_blocking(move || (loader_inner.loader)())
                    .await
                    .map_err(|e| EmbedError::Load(format!("loader task failed: {e}")))
                    .and_then(|r| r);
                match loaded {
                    Ok(embedder) => {
                        tracing::info!(model = embedder.model_id(), "memory embedder loaded");
                        Some(embedder)
                    }
                    Err(error) => {
                        if !inner.load_failed_logged.swap(true, Ordering::SeqCst) {
                            tracing::warn!(
                                error = %error,
                                "memory embedder unavailable: item serving stays keyword-only \
                                 (set MEMORY_EMBED_ENABLED=0 to silence this)"
                            );
                        }
                        None
                    }
                }
            })
            .await
            .clone()
    }

    /// The embedder only if it is already loaded — serving never waits for a load.
    pub fn ready(&self) -> Option<Arc<dyn TextEmbedder>> {
        self.inner.slot.get().and_then(|slot| slot.clone())
    }

    /// Start loading in the background (worker start-up), so the first reply finds it ready.
    pub fn warm(&self) {
        if !self.inner.enabled {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let _ = this.embedder().await;
        });
    }

    /// Embed a search question for SQL. `None` for every kind of trouble — disabled, not loaded
    /// yet, too many in flight, model error, timeout — and the caller serves keyword-only. The
    /// timeout is real: the blocking task is abandoned (it finishes on its own) and the reply
    /// moves on.
    pub async fn embed_query(&self, text: &str) -> Option<QueryVector> {
        let embedder = self.ready()?;
        // The permit travels with the blocking task, not with this future: an abandoned (timed
        // out) task keeps its slot until it really finishes, so a saturated model cannot pile up
        // an unbounded queue of stale queries behind the timeouts.
        let permit = match self.inner.inflight.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                tracing::debug!("memory embed: model busy; serving keyword-only");
                return None;
            }
        };
        let model = embedder.model_id().to_string();
        let owned = text.to_string();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            embedder
                .embed_query(&owned)
                .and_then(|v| vector_literal(&v))
        });
        let outcome = tokio::time::timeout(self.inner.query_timeout, task).await;
        match outcome {
            Ok(Ok(Ok(literal))) => Some(QueryVector { literal, model }),
            Ok(Ok(Err(error))) => {
                tracing::warn!(error = %error, "memory query embedding failed; serving keyword-only");
                None
            }
            Ok(Err(join)) => {
                tracing::warn!(error = %join, "memory query embedding task failed; serving keyword-only");
                None
            }
            Err(_) => {
                tracing::warn!(
                    timeout_ms = self.inner.query_timeout.as_millis() as u64,
                    "memory query embedding timed out; serving keyword-only"
                );
                None
            }
        }
    }

    fn idle_skip(&self, ws: Uuid) -> bool {
        let map = self.inner.idle.lock().unwrap_or_else(|p| p.into_inner());
        map.get(&ws).is_some_and(|at| at.elapsed() < IDLE_RECHECK)
    }

    fn mark_idle(&self, ws: Uuid) {
        let mut map = self.inner.idle.lock().unwrap_or_else(|p| p.into_inner());
        map.insert(ws, Instant::now());
    }

    /// Something new was stored: look at every workspace again on the next sweep.
    pub fn forget_idle(&self) {
        self.inner
            .idle
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
}

/// What one embedding sweep did (tests and logs read it).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EmbedSweepStats {
    pub workspaces: usize,
    pub embedded: usize,
    /// The item was retired/replaced between the read and the write (nothing stored).
    pub skipped: usize,
    pub failures: usize,
    /// The model was not available: nothing was attempted.
    pub unavailable: bool,
}

impl AgentWorker {
    /// The embedding service (tests inject a mock through [`AgentWorker::with_embedder`]).
    pub fn embed_service(&self) -> &EmbedService {
        &self.embed
    }

    /// The embedding loop: warm the model, then a sweep every `MEMORY_EMBED_POLL_SECONDS` or as
    /// soon as this process stores an item. Ends at once when embedding is off or the model
    /// cannot be loaded (the worker keeps serving keyword-only).
    pub(crate) async fn run_embed_loop(&self, mut stop: tokio::sync::watch::Receiver<bool>) {
        let cfg = &self.config.memory;
        if !cfg.embed_enabled {
            tracing::info!("memory embedding disabled (MEMORY_EMBED_ENABLED)");
            return;
        }
        let embedder = tokio::select! {
            _ = stop.changed() => return,
            embedder = self.embed.embedder() => embedder,
        };
        let Some(embedder) = embedder else {
            return;
        };
        tracing::info!(
            model = embedder.model_id(),
            poll_seconds = cfg.embed_poll_interval.as_secs(),
            batch = cfg.embed_batch,
            per_workspace_per_sweep = cfg.embed_max_per_sweep,
            "memory embedding loop starting"
        );
        let mut ticker = tokio::time::interval(cfg.embed_poll_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                _ = ticker.tick() => {}
                _ = self.items_stored.notified() => {}
            }
            tokio::select! {
                _ = stop.changed() => break,
                stats = self.embed_sweep() => {
                    if stats.embedded > 0 || stats.failures > 0 {
                        tracing::info!(?stats, "memory embedding sweep");
                    }
                }
            }
        }
        tracing::info!("memory embedding loop stopped");
    }

    /// One pass: for each workspace, embed up to `MEMORY_EMBED_MAX_PER_SWEEP` live items that have
    /// no vector for the current model. Failures are counted and the sweep moves on; the rows stay
    /// unembedded (search simply does not see a vector for them) and are retried next sweep.
    pub async fn embed_sweep(&self) -> EmbedSweepStats {
        let mut stats = EmbedSweepStats::default();
        let cfg = &self.config.memory;
        let Some(embedder) = self.embed.embedder().await else {
            stats.unavailable = true;
            return stats;
        };
        let model = embedder.model_id().to_string();
        let workspaces = match mem::workspace_ids(&self.pool, cfg.embed_max_workspaces).await {
            Ok(ids) => ids,
            Err(error) => {
                tracing::warn!(error = %error, "memory embed sweep: workspace list failed");
                stats.failures += 1;
                return stats;
            }
        };
        for ws in workspaces {
            if self.embed.idle_skip(ws) {
                continue;
            }
            stats.workspaces += 1;
            let mut budget = cfg.embed_max_per_sweep;
            let mut drained = false;
            while budget > 0 {
                let want = cfg.embed_batch.min(budget);
                match self
                    .embed_batch(ws, &embedder, &model, want, &mut stats)
                    .await
                {
                    BatchOutcome::Done(0) => {
                        drained = true;
                        break;
                    }
                    BatchOutcome::Done(n) => budget = budget.saturating_sub(n),
                    BatchOutcome::Failed => break,
                }
            }
            if drained {
                self.embed.mark_idle(ws);
            }
        }
        stats
    }

    async fn embed_batch(
        &self,
        ws: Uuid,
        embedder: &Arc<dyn TextEmbedder>,
        model: &str,
        want: usize,
        stats: &mut EmbedSweepStats,
    ) -> BatchOutcome {
        let model_owned = model.to_string();
        let limit = i32::try_from(want).unwrap_or(16);
        let rows = match mem::with_memory_tx(&self.pool, ws, move |conn| {
            Box::pin(async move { mem::items_to_embed(conn, &model_owned, limit).await })
        })
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(workspace_id = %ws, error = %error, "memory embed sweep: read failed");
                stats.failures += 1;
                return BatchOutcome::Failed;
            }
        };
        if rows.is_empty() {
            return BatchOutcome::Done(0);
        }
        let texts: Vec<String> = rows.iter().map(|(_, body)| body.clone()).collect();
        let worker_embedder = embedder.clone();
        let task = tokio::task::spawn_blocking(move || worker_embedder.embed_passages(&texts));
        let vectors = match tokio::time::timeout(BATCH_TIMEOUT, task).await {
            Ok(Ok(Ok(vectors))) if vectors.len() == rows.len() => vectors,
            Ok(Ok(Ok(_))) | Ok(Ok(Err(_))) | Ok(Err(_)) | Err(_) => {
                tracing::warn!(workspace_id = %ws, "memory embed sweep: model call failed; retrying next sweep");
                stats.failures += 1;
                return BatchOutcome::Failed;
            }
        };
        let mut pairs: Vec<(Uuid, String)> = Vec::with_capacity(rows.len());
        for ((id, _), vector) in rows.iter().zip(&vectors) {
            match vector_literal(vector) {
                Ok(literal) => pairs.push((*id, literal)),
                Err(error) => {
                    tracing::warn!(workspace_id = %ws, error = %error, "memory embed sweep: bad vector");
                    stats.failures += 1;
                }
            }
        }
        let model_owned = model.to_string();
        let written = mem::with_memory_tx(&self.pool, ws, move |conn| {
            Box::pin(async move {
                let mut ok = 0usize;
                let mut skipped = 0usize;
                for (id, literal) in &pairs {
                    if mem::set_item_embedding(conn, *id, &model_owned, literal).await? {
                        ok += 1;
                    } else {
                        skipped += 1;
                    }
                }
                Ok((ok, skipped))
            })
        })
        .await;
        match written {
            Ok((ok, skipped)) => {
                stats.embedded += ok;
                stats.skipped += skipped;
                // A batch that stored nothing (everything skipped) must not spin: report progress
                // only for rows actually handled so the budget still drains.
                BatchOutcome::Done(rows.len())
            }
            Err(error) => {
                tracing::warn!(workspace_id = %ws, error = %error, "memory embed sweep: write failed");
                stats.failures += 1;
                BatchOutcome::Failed
            }
        }
    }
}

enum BatchOutcome {
    /// Rows handled (0 = nothing left to embed in this workspace).
    Done(usize),
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_embed::testing::{MockEmbedder, Mode};

    fn service(mode: Mode, timeout_ms: u64) -> EmbedService {
        EmbedService::with_embedder(
            Arc::new(MockEmbedder::new(&[]).with_mode(mode)),
            Duration::from_millis(timeout_ms),
        )
    }

    #[tokio::test]
    async fn a_disabled_or_unloaded_service_answers_none_and_never_loads_on_the_serving_path() {
        assert!(EmbedService::disabled().embed_query("배포").await.is_none());
        let s = service(Mode::Works, 500);
        // Not loaded yet: serving must not wait for (or trigger) the load.
        assert!(s.embed_query("배포").await.is_none());
        assert!(s.ready().is_none());
        assert!(s.embedder().await.is_some());
        let v = s.embed_query("배포").await.expect("loaded now");
        assert_eq!(v.model, "mock-concepts:v1");
        assert!(v.literal.starts_with('[') && v.literal.ends_with(']'));
    }

    #[tokio::test]
    async fn a_failing_embedder_gives_none_not_an_error() {
        let s = service(Mode::Fails, 500);
        s.embedder().await;
        assert!(s.embed_query("배포").await.is_none());
    }

    #[tokio::test]
    async fn a_slow_embedder_is_cut_off_at_the_budget() {
        let s = service(Mode::Slow(Duration::from_millis(400)), 50);
        s.embedder().await;
        let started = Instant::now();
        assert!(s.embed_query("배포").await.is_none());
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "the reply must not wait for a slow model: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_missing_model_directory_is_remembered_and_serving_stays_keyword_only() {
        let cfg = MemoryConfig {
            embed_model_dir: "/nonexistent/momo-models".to_string(),
            ..MemoryConfig::default()
        };
        let s = EmbedService::from_config(&cfg);
        assert!(s.embedder().await.is_none());
        assert!(s.embedder().await.is_none());
        assert!(s.embed_query("배포").await.is_none());
    }
}
