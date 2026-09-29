//! #3173 / ADR-0196 D8 증보 — local embeddings and fused (weighted-RRF) item search, against a real
//! Postgres and the real worker (`AgentWorker::drain_once`, `embed_sweep`) with a deterministic mock
//! embedder (`momo_embed::testing`). The real model has its own ignored test
//! (`real_model_recall_through_the_serving_sql`).
//!
//! `#[ignore]`d like its siblings; run against an isolated `pgvector/pgvector:pg18` (container
//! `3173-pg`, removed with `docker rm -f -v` afterwards):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-agent-worker --test memory_embed_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `fused_serving_finds_a_paraphrase_that_keyword_only_misses` | the vector side of the fusion, the embedding sweep, the query embedding, the similarity floor |
//! | `audience_and_membership_narrowing_hold_with_vectors` | `mem_item_audience_ok` / membership narrowing in the vector loop |
//! | `embedder_trouble_means_keyword_only_and_the_reply_always_goes_out` | the query-embedding budget, the not-loaded fallback, the fused-call fallback |
//! | `the_backfill_is_bounded_idempotent_and_follows_the_model` | per-sweep cap, model-keyed rows, FK cascade on forget |
//! | `the_api_role_and_the_worker_login_cannot_reach_the_vector_functions` | worker-only EXECUTE, no table privilege (RED by GRANT) |
//! | `each_new_sql_guard_is_load_bearing` | audience rule, filter-then-cut (L-3), membership narrowing, similarity floor, x2 keyword weight — each sabotaged, RED printed |

#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use momo_agent::memory as mem;
use momo_agent::memory_items::{self as mem_items, ItemOutcome, NewItem};
use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::memory as api;
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

// --- harness -------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated pgvector/pg18 DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn role_pool(user: &str, password_env: &str, default_pw: &str) -> PgPool {
    let opts: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(
            opts.username(user)
                .password(&std::env::var(password_env).unwrap_or_else(|_| default_pw.to_string())),
        )
        .await
        .unwrap_or_else(|e| panic!("connect as {user} (bootstrap_roles.sql): {e}"))
}

async fn momo_worker_pool() -> PgPool {
    role_pool("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await
}

async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("MOMO_APP_POSTGRES_PASSWORD", "momo_app_dev_pw")
        .env("RELAY_POSTGRES_PASSWORD", "momo_relay_dev_pw")
        .env("WORKER_POSTGRES_PASSWORD", "momo_worker_dev_pw")
        .env("NOTIFIER_POSTGRES_PASSWORD", "momo_notifier_dev_pw")
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

/// `claim_agent_job_batch` is a global claim: retire jobs other suites left behind.
async fn settle_residual_worker_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = ANY($1) AND status IN ('pending', 'processing')",
    )
    .bind(momo_outbox::WORKER_JOB_METHODS.map(str::to_string).to_vec())
    .execute(su)
    .await
    .expect("sweep residual worker agent_jobs");
}

// --- fixtures ------------------------------------------------------------------

/// alice (the requester X), bob, carol; an agent. Channels:
/// * `general` (public)  alice, bob, carol, agent
/// * `hr`      (private) alice, bob             — carol and the agent are outside
/// * `secret`  (private) bob                    — alice cannot read it
/// * `dm`      (dm)      alice, agent
struct Fx {
    ws: Uuid,
    alice: Uuid,
    bob: Uuid,
    carol: Uuid,
    agent: Uuid,
    general: Uuid,
    hr: Uuid,
    secret: Uuid,
    dm: Uuid,
}

async fn new_member(su: &PgPool, ws: Uuid, kind: &str, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(name)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(ws)
    .bind(id)
    .execute(su)
    .await
    .expect("workspace_membership");
    id
}

async fn new_channel(su: &PgPool, ws: Uuid, kind: &str, members: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, $3::channel_kind, $4, $5)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind((kind != "dm").then(|| format!("c3163-{}", &id.simple().to_string()[..8])))
    .bind((kind == "dm").then(|| id.to_string()))
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(id)
        .bind(ws)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(ws)
        .bind(id)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
    }
    id
}

async fn seed(su: &PgPool) -> Fx {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("workspace");
    let alice = new_member(su, ws, "human", "앨리스").await;
    let bob = new_member(su, ws, "human", "밥").await;
    let carol = new_member(su, ws, "human", "캐롤").await;
    let agent = new_member(su, ws, "agent", "hermes").await;
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50)",
    )
    .bind(agent)
    .bind(ws)
    .execute(su)
    .await
    .expect("agent");
    let general = new_channel(su, ws, "public", &[alice, bob, carol, agent]).await;
    let hr = new_channel(su, ws, "private", &[alice, bob]).await;
    let secret = new_channel(su, ws, "private", &[bob]).await;
    let dm = new_channel(su, ws, "dm", &[alice, agent]).await;
    Fx {
        ws,
        alice,
        bob,
        carol,
        agent,
        general,
        hr,
        secret,
        dm,
    }
}

async fn post_in(
    pool: &PgPool,
    ws: Uuid,
    channel: Uuid,
    author: Uuid,
    body: &str,
    root: Option<Uuid>,
) -> (Uuid, i64) {
    let body = body.to_string();
    with_tenant_tx(pool, ws, move |conn| {
        Box::pin(async move {
            let mut message = NewMessage::text(channel, author, body);
            message.root_id = root;
            let sent = send_message_in_tx(conn, ws, message).await?;
            Ok((sent.message.id, sent.message.seq))
        })
    })
    .await
    .expect("send")
}

/// A digest written the way the summary worker writes it: through `mem_apply_digest` in a memory
/// tx, with evidence that is real, live messages of the channel.
struct Written {
    id: Uuid,
    evidence: Vec<(Uuid, i64)>,
}

#[allow(clippy::too_many_arguments)]
async fn write_digest(
    wp: &PgPool,
    ws: Uuid,
    channel: Uuid,
    author: Uuid,
    level: &str,
    body: &str,
    messages: usize,
    thread_root: Option<Uuid>,
    sources: &[&Written],
) -> Written {
    let mut evidence: Vec<(Uuid, i64)> = Vec::new();
    for source in sources {
        evidence.extend(source.evidence.iter().copied());
    }
    for n in 0..messages {
        let (id, seq) = post_in(
            wp,
            ws,
            channel,
            author,
            &format!("근거 메시지 {n}"),
            thread_root,
        )
        .await;
        evidence.push((id, seq));
    }
    evidence.sort_by_key(|e| e.1);
    let refs: Vec<mem::EvidenceRef> = evidence
        .iter()
        .map(|(id, seq)| mem::EvidenceRef {
            message_id: *id,
            seq: *seq,
            edited_at: None,
        })
        .collect();
    let source_ids: Vec<Uuid> = sources.iter().map(|w| w.id).collect();
    let (from, to) = (evidence.first().unwrap().1, evidence.last().unwrap().1);
    let level = level.to_string();
    let body = body.to_string();
    let read_at = with_tenant_tx(wp, ws, |conn| {
        Box::pin(async move { mem::read_clock(conn).await })
    })
    .await
    .expect("clock");
    let id = mem::with_memory_tx(wp, ws, move |conn| {
        Box::pin(async move {
            mem::apply_digest(
                conn,
                &mem::NewDigest {
                    channel_id: channel,
                    thread_root_id: thread_root,
                    level: &level,
                    from_seq: from,
                    to_seq: to,
                    body: &body,
                    source_digest_ids: &source_ids,
                    model: "test-model",
                    model_source: "instance_default",
                    evidence: &refs,
                    read_at,
                },
            )
            .await
        })
    })
    .await
    .expect("apply digest");
    Written { id, evidence }
}

#[allow(dead_code)]
struct Turn {
    run_id: Uuid,
    job_id: i64,
    trigger: Uuid,
}

/// A mention turn: the server-side rows (message, run, outbox job) exactly as the send path
/// writes them. `payload_author` is what the *payload* claims — the worker must ignore it.
#[allow(clippy::too_many_arguments)]
async fn enqueue_turn(
    wp: &PgPool,
    fx: &Fx,
    channel: Uuid,
    author: Uuid,
    payload_author: Option<Uuid>,
    body: &str,
    root: Option<Uuid>,
) -> Turn {
    enqueue_turn_with(
        wp,
        fx,
        channel,
        author,
        payload_author,
        body,
        root,
        json!({}),
    )
    .await
}

/// [`enqueue_turn`] with extra payload keys (`enabled_tools`, a wider `recent_messages`, …) merged
/// over the ones a plain mention carries.
#[allow(clippy::too_many_arguments)]
async fn enqueue_turn_with(
    wp: &PgPool,
    fx: &Fx,
    channel: Uuid,
    author: Uuid,
    payload_author: Option<Uuid>,
    body: &str,
    root: Option<Uuid>,
    extra: serde_json::Value,
) -> Turn {
    let (ws, agent) = (fx.ws, fx.agent);
    let body = body.to_string();
    let payload_author = payload_author.unwrap_or(author);
    with_tenant_tx(wp, ws, move |conn| {
        Box::pin(async move {
            let mut message = NewMessage::text(channel, author, body.clone());
            message.root_id = root;
            let trigger = send_message_in_tx(conn, ws, message).await?;
            let created = create_agent_run_in_tx(
                conn,
                ws,
                NewAgentRun {
                    channel_id: channel,
                    trigger: RunTrigger::Mention {
                        message_id: trigger.message.id,
                        agent_member_id: agent,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention", "prompt": body}),
                },
            )
            .await?;
            let mut payload = json!({
                "run_id": created.id,
                "workspace_id": ws,
                "channel_id": channel,
                "agent_member_id": agent,
                "author_member_id": payload_author,
                "trigger_message_id": trigger.message.id,
                "trigger_message_seq": trigger.message.seq,
                "model": "hermes-agent",
                "prompt": body,
                "recent_messages": [{
                    "message_id": trigger.message.id,
                    "channel_id": channel,
                    "seq": trigger.message.seq,
                    "author_member_id": author,
                    "author_kind": "human",
                    "author_display": "사람",
                    "type": "text",
                    "body": body,
                }],
                "max_output_tokens": 512,
                "delivery": "worker",
                "created_from": "server.message_send.agent_mention.v0",
            });
            if let (Some(base), Some(more)) = (payload.as_object_mut(), extra.as_object()) {
                for (key, value) in more {
                    base.insert(key.clone(), value.clone());
                }
            }
            let job_id = emit_outbox(
                &mut *conn,
                ws,
                OutboxKind::AgentJob,
                "publish",
                &payload,
                Some(agent),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(Turn {
                run_id: created.id,
                job_id,
                trigger: trigger.message.id,
            })
        })
    })
    .await
    .expect("enqueue a mention turn")
}

fn config() -> WorkerConfig {
    let mut config =
        WorkerConfig::for_target(database_url()).with_env_bearer("sk-conformance-team-key");
    config.claim_batch_size = 10;
    config.utc_offset_minutes = 0;
    config
}

async fn worker(provider: &Arc<MockChatProvider>, config: WorkerConfig) -> AgentWorker {
    AgentWorker::new(
        momo_worker_pool().await,
        provider.clone() as Arc<dyn ChatProvider>,
        config,
    )
}

/// The one memory system turn of the first model call, if any.
fn memory_turn(provider: &MockChatProvider) -> Option<String> {
    provider
        .calls()
        .first()?
        .messages
        .iter()
        .find(|m| m.role == "system" && m.content.contains("<기억 참고자료>"))
        .map(|m| m.content.clone())
}

fn whole_prompt(provider: &MockChatProvider) -> String {
    provider
        .calls()
        .first()
        .map(|c| {
            c.messages
                .iter()
                .map(|m| format!("[{}] {}", m.role, m.content))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

async fn receipt(su: &PgPool, run: Uuid) -> Option<(Vec<Uuid>, i32, i32, i32)> {
    sqlx::query(
        "SELECT digest_ids, withheld_count, budget_chars, used_chars FROM mem_serving WHERE run_id = $1",
    )
    .bind(run)
    .fetch_optional(su)
    .await
    .unwrap()
    .map(|r| {
        (
            r.get("digest_ids"),
            r.get("withheld_count"),
            r.get("budget_chars"),
            r.get("used_chars"),
        )
    })
}

async fn agent_replies(su: &PgPool, fx: &Fx, channel: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3",
    )
    .bind(fx.ws)
    .bind(channel)
    .bind(fx.agent)
    .fetch_one(su)
    .await
    .unwrap()
}

/// What `GET /runs/{id}/memory` reads, as `viewer` on `momo_app` (RLS on).
async fn api_receipt(app: &PgPool, fx: &Fx, viewer: Uuid, run: Uuid) -> Option<api::MemServing> {
    let ws = fx.ws;
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            api::bind_mem_reader_guc(conn, viewer).await?;
            api::get_serving_in_tx(conn, run).await
        })
    })
    .await
    .expect("api receipt")
}

#[allow(clippy::too_many_arguments)]
async fn set_setting(
    su: &PgPool,
    fx: &Fx,
    scope: &str,
    channel: Option<Uuid>,
    member: Option<Uuid>,
    paused: bool,
    enabled: bool,
    excluded: bool,
) {
    sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, channel_id, member_id, enabled, paused, excluded) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(fx.ws)
    .bind(scope)
    .bind(channel)
    .bind(member)
    .bind(enabled)
    .bind(paused)
    .bind(excluded)
    .execute(su)
    .await
    .expect("mem_settings");
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

// --- tests ---------------------------------------------------------------------

/// An extracted item, written the way the summary worker writes one: a window digest (which is
/// served too) and `mem_add_item` in the same memory tx.
async fn write_item(wp: &PgPool, fx: &Fx, channel: Uuid, author: Uuid, body: &str) -> Uuid {
    let digest = write_digest(
        wp,
        fx.ws,
        channel,
        author,
        "window",
        "구간 요약이에요",
        3,
        None,
        &[],
    )
    .await;
    let item = NewItem {
        kind: "fact",
        body: body.to_string(),
        subject_key: None,
        evidence: digest.evidence.iter().map(|e| e.0).take(2).collect(),
        confidence: 0.8,
        ephemeral: false,
    };
    let digest_id = digest.id;
    let outcome = mem::with_memory_tx(wp, fx.ws, move |conn| {
        Box::pin(async move { mem_items::add_item(conn, digest_id, &item, "test-model").await })
    })
    .await
    .expect("add item");
    match outcome {
        ItemOutcome::Added(id) => id,
        other => panic!("expected a new item, got {other:?}"),
    }
}

/// One more item on a digest that already exists: the digest set does not change, only the items do.
async fn add_item_to(wp: &PgPool, fx: &Fx, digest: &Written, body: &str) -> Uuid {
    let item = NewItem {
        kind: "fact",
        body: body.to_string(),
        subject_key: None,
        evidence: digest.evidence.iter().map(|e| e.0).take(2).collect(),
        confidence: 0.8,
        ephemeral: false,
    };
    let digest_id = digest.id;
    let outcome = mem::with_memory_tx(wp, fx.ws, move |conn| {
        Box::pin(async move { mem_items::add_item(conn, digest_id, &item, "test-model").await })
    })
    .await
    .expect("add item");
    match outcome {
        ItemOutcome::Added(id) => id,
        other => panic!("expected a new item, got {other:?}"),
    }
}

const ITEM_OPEN_TAG: &str = "<기억 항목 참고자료>";

/// The item section of the first model call's memory turn, if any.
fn item_section(provider: &MockChatProvider) -> Option<String> {
    let turn = provider
        .calls()
        .first()?
        .messages
        .iter()
        .find(|m| m.role == "system" && m.content.contains(ITEM_OPEN_TAG))
        .map(|m| m.content.clone())?;
    let at = turn.find(ITEM_OPEN_TAG)?;
    Some(turn[at..].to_string())
}

/// The summary part of the same turn (empty when only items ride).
fn digest_section(provider: &MockChatProvider) -> String {
    memory_turn(provider)
        .map(|turn| match turn.find(ITEM_OPEN_TAG) {
            Some(at) => turn[..at].trim_end_matches('\n').to_string(),
            None => turn,
        })
        .unwrap_or_default()
}

async fn receipt_items(su: &PgPool, run: Uuid) -> Option<Vec<Uuid>> {
    sqlx::query_scalar("SELECT item_ids FROM mem_serving WHERE run_id = $1")
        .bind(run)
        .fetch_optional(su)
        .await
        .unwrap()
}

async fn answered(w: &AgentWorker) -> usize {
    w.drain_once().await.expect("drain").answered as usize
}

// =============================================================================
// #3173 — embeddings, fused search, and what the embedder's trouble may not do
// =============================================================================

use momo_agent_worker::embed::EmbedService;
use momo_embed::testing::{MockEmbedder, Mode};
use momo_embed::{vector_literal, TextEmbedder};

const MOCK_MODEL: &str = "mock-concepts:v1";

/// Concept groups: words in one group share a meaning for the mock embedder, the way a real
/// sentence model puts a paraphrase near its source while keyword search finds no common word.
fn synonyms() -> Vec<&'static [&'static str]> {
    vec![
        &["배포", "릴리스", "릴리즈", "출시"],
        &["미루기", "연기", "지연"],
        &["예산", "비용"],
        &["담당", "책임자"],
    ]
}

fn mock_embedder() -> MockEmbedder {
    MockEmbedder::new(&synonyms())
}

fn service(embedder: MockEmbedder, timeout_ms: u64) -> EmbedService {
    EmbedService::with_embedder(Arc::new(embedder), Duration::from_millis(timeout_ms))
}

fn vec_config() -> WorkerConfig {
    let mut cfg = config();
    // The mock's similarity scale is not the real model's; a paraphrase scores ~0.47 here.
    cfg.memory.embed_min_similarity = 0.30;
    cfg.memory.embed_query_timeout = Duration::from_millis(2_000);
    cfg
}

async fn worker_vec(
    provider: &Arc<MockChatProvider>,
    cfg: WorkerConfig,
    svc: EmbedService,
) -> AgentWorker {
    worker(provider, cfg).await.with_embed_service(svc)
}

/// Load the mock and embed everything unembedded (the worker's own backfill path).
async fn embed_everything(w: &AgentWorker) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("warn")
        .with_test_writer()
        .try_init();
    assert!(
        w.embed_service().embedder().await.is_some(),
        "embedder loads"
    );
    for _ in 0..40 {
        let stats = w.embed_sweep().await;
        assert_eq!(stats.failures, 0, "{stats:?}");
        if stats.embedded == 0 {
            return;
        }
    }
    panic!("the backfill did not drain in 40 sweeps");
}

async fn embedded_of(su: &PgPool, ws: Uuid, model: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM mem_item_embedding WHERE workspace_id = $1 AND model = $2",
    )
    .bind(ws)
    .bind(model)
    .fetch_one(su)
    .await
    .unwrap()
}

/// The fusion body called directly as the superuser (it is owner-only), in one tx with the
/// tenant GUC set — the same SQL the serving entry point runs.
#[allow(clippy::too_many_arguments)]
async fn fused_rows(
    su: &PgPool,
    ws: Uuid,
    viewer: Uuid,
    query: &str,
    limit: i32,
    channel: Uuid,
    vector: Option<&str>,
    model: &str,
    min_similarity: f32,
) -> Vec<(Uuid, String)> {
    let mut tx = su.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let rows =
        sqlx::query("SELECT id, body FROM mem_search_items_fused($1, $2, $3, $4, $5, $6, $7)")
            .bind(viewer)
            .bind(query)
            .bind(limit)
            .bind(channel)
            .bind(vector)
            .bind(model)
            .bind(min_similarity)
            .fetch_all(&mut *tx)
            .await
            .expect("mem_search_items_fused");
    tx.rollback().await.unwrap();
    rows.iter().map(|r| (r.get("id"), r.get("body"))).collect()
}

fn qvec(text: &str) -> String {
    vector_literal(&mock_embedder().embed_query(text).unwrap()).unwrap()
}

fn migration_107() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../server/Migrations/107_mem_item_embedding.sql"
    ))
    .expect("read 107")
}

/// The `CREATE OR REPLACE FUNCTION name(...) ... $$;` text of one function in migration 107.
fn function_sql(name: &str) -> String {
    let text = migration_107();
    let start = text
        .find(&format!("CREATE OR REPLACE FUNCTION {name}("))
        .unwrap_or_else(|| panic!("{name} in 107"));
    let rest = &text[start..];
    let body_at = rest.find("AS $$").expect("body");
    let end = rest[body_at + 5..].find("\n$$;").expect("end") + body_at + 5 + 4;
    rest[..end].to_string()
}

/// A sabotaged fusion body must be undone even when the previous run died mid-test.
async fn restore_fused(su: &PgPool) {
    sqlx::raw_sql(&function_sql("mem_search_items_fused"))
        .execute(su)
        .await
        .expect("restore the fusion body");
}

async fn sabotage_fused(su: &PgPool, from: &str, to: &str) {
    let original = function_sql("mem_search_items_fused");
    assert!(
        original.contains(from),
        "the sabotage target exists: {from}"
    );
    sqlx::raw_sql(&original.replacen(from, to, 1))
        .execute(su)
        .await
        .expect("apply the sabotaged body");
}

async fn set_deleted(su: &PgPool, ids: &[Uuid]) {
    sqlx::query("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = ANY($1)")
        .bind(ids.to_vec())
        .execute(su)
        .await
        .expect("delete messages");
}

const PARAPHRASE_TARGET: &str = "릴리스 연기 결정 QA 일정 때문";
const PARAPHRASE_QUERY: &str = "@hermes 배포 미루기 언제";

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn fused_serving_finds_a_paraphrase_that_keyword_only_misses() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    restore_fused(&su).await;
    let fx = seed(&su).await;
    let wp = momo_worker_pool().await;
    let target = write_item(&wp, &fx, fx.general, fx.bob, PARAPHRASE_TARGET).await;
    let lunch = write_item(&wp, &fx, fx.general, fx.bob, "점심 메뉴 김밥 결정").await;
    let room = write_item(&wp, &fx, fx.general, fx.bob, "회의실 예약 담당 밥").await;

    // Keyword-only (no embedder): the paraphrase shares no word with the item, so nothing rides.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker_vec(&provider, vec_config(), EmbedService::disabled()).await;
    let turn = enqueue_turn(&wp, &fx, fx.general, fx.alice, None, PARAPHRASE_QUERY, None).await;
    assert_eq!(answered(&w).await, 1);
    assert!(
        item_section(&provider).is_none(),
        "keyword search alone misses the paraphrase:\n{:?}",
        item_section(&provider)
    );
    assert_eq!(
        receipt_items(&su, turn.run_id).await.unwrap_or_default(),
        vec![] as Vec<Uuid>
    );

    // With the embedder: the backfill sweep embeds the three items, and the same question finds it.
    let provider = Arc::new(MockChatProvider::echo());
    let svc = service(mock_embedder(), 2_000);
    let w = worker_vec(&provider, vec_config(), svc).await;
    embed_everything(&w).await;
    assert_eq!(embedded_of(&su, fx.ws, MOCK_MODEL).await, 3);
    let turn = enqueue_turn(&wp, &fx, fx.general, fx.alice, None, PARAPHRASE_QUERY, None).await;
    assert_eq!(answered(&w).await, 1);
    let section = item_section(&provider).expect("the paraphrase is now found");
    assert!(section.contains(PARAPHRASE_TARGET), "{section}");
    assert!(
        !section.contains("김밥") && !section.contains("회의실"),
        "unrelated items stay out (the similarity floor):\n{section}"
    );
    let ids = receipt_items(&su, turn.run_id).await.expect("receipt");
    assert_eq!(ids, vec![target], "the receipt names exactly what rode");
    assert!(!ids.contains(&lunch) && !ids.contains(&room));

    // A literal question still works with vectors on (keyword contributes; nothing regresses).
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker_vec(&provider, vec_config(), service(mock_embedder(), 2_000)).await;
    embed_everything(&w).await;
    let _ = enqueue_turn(
        &wp,
        &fx,
        fx.general,
        fx.alice,
        None,
        "@hermes 점심 메뉴 뭐였지",
        None,
    )
    .await;
    assert_eq!(answered(&w).await, 1);
    assert!(item_section(&provider).unwrap().contains("김밥"));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn audience_and_membership_narrowing_hold_with_vectors() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    restore_fused(&su).await;
    let fx = seed(&su).await;
    let wp = momo_worker_pool().await;
    // Four items that all sit right next to the question in embedding space.
    let general = write_item(&wp, &fx, fx.general, fx.bob, "릴리스 연기 결정 공개 채널").await;
    let hr = write_item(&wp, &fx, fx.hr, fx.bob, "릴리스 연기 결정 인사 채널").await;
    let secret = write_item(&wp, &fx, fx.secret, fx.bob, "릴리스 연기 결정 비밀 채널").await;
    let personal = write_item(&wp, &fx, fx.dm, fx.alice, "릴리스 연기 결정 개인 대화").await;

    let provider = Arc::new(MockChatProvider::echo());
    let w = worker_vec(&provider, vec_config(), service(mock_embedder(), 2_000)).await;
    embed_everything(&w).await;
    assert_eq!(embedded_of(&su, fx.ws, MOCK_MODEL).await, 4);

    let served = |ids: Vec<Uuid>| {
        let mut ids = ids;
        ids.sort();
        ids
    };
    // alice asks in the group channel: only the group channel's own item rides. alice IS a member
    // of hr and owns the personal item — the audience rule (not membership) keeps them out.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker_vec(&provider, vec_config(), service(mock_embedder(), 2_000)).await;
    w.embed_service().embedder().await;
    let t = enqueue_turn(&wp, &fx, fx.general, fx.alice, None, PARAPHRASE_QUERY, None).await;
    assert_eq!(answered(&w).await, 1);
    assert_eq!(receipt_items(&su, t.run_id).await.unwrap(), vec![general]);

    // carol is not in hr or secret and does not own the personal item.
    let t = enqueue_turn(&wp, &fx, fx.general, fx.carol, None, PARAPHRASE_QUERY, None).await;
    assert_eq!(answered(&w).await, 1);
    assert_eq!(receipt_items(&su, t.run_id).await.unwrap(), vec![general]);

    // In alice's 1:1 DM with the agent her own permission union applies: general, hr and her
    // personal item — but never bob's private channel she cannot read.
    let t = enqueue_turn(&wp, &fx, fx.dm, fx.alice, None, PARAPHRASE_QUERY, None).await;
    assert_eq!(answered(&w).await, 1);
    let ids = served(receipt_items(&su, t.run_id).await.unwrap());
    assert_eq!(ids, served(vec![general, hr, personal]));
    assert!(!ids.contains(&secret));

    // Independent oracle: whatever the fusion returns is inside {readable ∩ audience-ok}, computed
    // by the two SQL rules for every item in the workspace — for every viewer/answer pair.
    let every = [general, hr, secret, personal];
    for (viewer, channel) in [
        (fx.alice, fx.general),
        (fx.carol, fx.general),
        (fx.bob, fx.general),
        (fx.bob, fx.hr),
        (fx.alice, fx.dm),
    ] {
        let got = fused_rows(
            &su,
            fx.ws,
            viewer,
            "배포 미루기 언제",
            20,
            channel,
            Some(&qvec("배포 미루기 언제")),
            MOCK_MODEL,
            0.0,
        )
        .await;
        let mut allowed: Vec<Uuid> = Vec::new();
        for item in every {
            let ok: bool = with_memory_tx_ok(&wp, fx.ws, item, channel, viewer).await;
            if ok {
                allowed.push(item);
            }
        }
        for (id, _) in &got {
            assert!(
                allowed.contains(id),
                "viewer {viewer} in {channel}: {id} is served but the SQL rules do not allow it"
            );
        }
        // And with the floor at 0 every allowed embedded item is a candidate (nothing hidden by mistake).
        let mut got_ids: Vec<Uuid> = got.iter().map(|r| r.0).collect();
        got_ids.sort();
        assert_eq!(got_ids, served(allowed), "viewer {viewer} in {channel}");
    }
}

/// `mem_item_readable_by AND mem_item_audience_ok` for one (viewer, answer channel), as the worker
/// role would ask.
async fn with_memory_tx_ok(wp: &PgPool, ws: Uuid, item: Uuid, channel: Uuid, viewer: Uuid) -> bool {
    mem::with_memory_tx(wp, ws, move |conn| {
        Box::pin(async move {
            let ok: bool = sqlx::query_scalar(
                "SELECT mem_item_readable_by($1, $3) AND mem_item_audience_ok($1, $2, $3)",
            )
            .bind(item)
            .bind(channel)
            .bind(viewer)
            .fetch_one(&mut *conn)
            .await?;
            Ok(ok)
        })
    })
    .await
    .expect("rules")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn embedder_trouble_means_keyword_only_and_the_reply_always_goes_out() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    restore_fused(&su).await;
    let fx = seed(&su).await;
    let wp = momo_worker_pool().await;
    let dated = write_item(
        &wp,
        &fx,
        fx.general,
        fx.bob,
        "배포일은 2026-10-02 금요일로 정했다",
    )
    .await;
    let question = "@hermes 배포 언제 하기로 했지";

    // (label, service, warm it first?, longest acceptable time for the whole drain)
    let cases: Vec<(&str, EmbedService, bool, Duration)> = vec![
        (
            "embedder fails",
            service(mock_embedder().with_mode(Mode::Fails), 500),
            true,
            Duration::from_secs(3),
        ),
        (
            "embedder is far slower than its budget",
            service(
                mock_embedder().with_mode(Mode::Slow(Duration::from_secs(5))),
                150,
            ),
            true,
            Duration::from_millis(2_500),
        ),
        (
            "model is not loaded yet",
            service(mock_embedder(), 500),
            false,
            Duration::from_secs(3),
        ),
        (
            "model directory missing",
            EmbedService::from_config(&momo_agent_worker::config::MemoryConfig {
                embed_model_dir: "/nonexistent/momo-models".to_string(),
                ..vec_config().memory
            }),
            true,
            Duration::from_secs(3),
        ),
    ];
    for (label, svc, warm, bound) in cases {
        if warm {
            svc.embedder().await;
        }
        let provider = Arc::new(MockChatProvider::echo());
        let w = worker_vec(&provider, vec_config(), svc).await;
        let turn = enqueue_turn(&wp, &fx, fx.general, fx.alice, None, question, None).await;
        let started = Instant::now();
        assert_eq!(answered(&w).await, 1, "{label}: the reply goes out");
        let took = started.elapsed();
        assert!(
            took < bound,
            "{label}: the reply waited {took:?} (bound {bound:?})"
        );
        assert_eq!(
            agent_replies(&su, &fx, fx.general).await >= 1,
            true,
            "{label}"
        );
        let section = item_section(&provider).unwrap_or_else(|| {
            panic!("{label}: keyword-only serving still finds the literal match")
        });
        assert!(section.contains("2026-10-02"), "{label}: {section}");
        assert_eq!(
            receipt_items(&su, turn.run_id).await.unwrap(),
            vec![dated],
            "{label}"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn the_backfill_is_bounded_idempotent_and_follows_the_model() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    restore_fused(&su).await;
    let fx = seed(&su).await;
    let wp = momo_worker_pool().await;
    let digest = write_digest(
        &wp,
        fx.ws,
        fx.general,
        fx.bob,
        "window",
        "구간 요약이에요",
        3,
        None,
        &[],
    )
    .await;
    let mut ids = Vec::new();
    for n in 0..25 {
        ids.push(add_item_to(&wp, &fx, &digest, &format!("릴리스 연기 결정 번호 {n}")).await);
    }
    // A retired item is not embedded (nothing to search).
    sqlx::query("UPDATE mem_item SET retired_at = now(), retired_reason = 'wrong' WHERE id = $1")
        .bind(ids[0])
        .execute(&su)
        .await
        .unwrap();

    let provider = Arc::new(MockChatProvider::echo());
    let mut cfg = vec_config();
    cfg.memory.embed_batch = 4;
    cfg.memory.embed_max_per_sweep = 10;
    let w = worker_vec(&provider, cfg, service(mock_embedder(), 2_000)).await;
    assert!(w.embed_service().embedder().await.is_some());

    // Rate limit: at most `embed_max_per_sweep` (10) per workspace per sweep.
    let mut per_sweep = Vec::new();
    for _ in 0..6 {
        let before = embedded_of(&su, fx.ws, MOCK_MODEL).await;
        w.embed_sweep().await;
        per_sweep.push(embedded_of(&su, fx.ws, MOCK_MODEL).await - before);
    }
    assert_eq!(
        per_sweep[..3],
        [10, 10, 4],
        "10 + 10 + the 4 left (24 live items): {per_sweep:?}"
    );
    assert_eq!(per_sweep[3..], [0, 0, 0]);
    assert_eq!(
        embedded_of(&su, fx.ws, MOCK_MODEL).await,
        24,
        "the retired item is skipped"
    );
    let retired_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_item_embedding WHERE item_id = $1")
            .bind(ids[0])
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(retired_rows, 0);
    let (live, done) = mem::with_memory_tx(&wp, fx.ws, |conn| {
        Box::pin(async move { mem::embedding_stats(conn, MOCK_MODEL).await })
    })
    .await
    .unwrap();
    assert_eq!((live, done), (24, 24));

    // Idempotent: a re-run writes nothing, and a manual duplicate write is a no-op.
    let again: bool = mem::with_memory_tx(&wp, fx.ws, {
        let id = ids[1];
        let lit = qvec("아무 문장");
        move |conn| {
            Box::pin(async move { mem::set_item_embedding(conn, id, MOCK_MODEL, &lit).await })
        }
    })
    .await
    .unwrap();
    assert!(!again, "the vector already exists");

    // A new item, an edited copy and a model change all flow through the same path.
    let fresh = add_item_to(&wp, &fx, &digest, "예산 비용 승인 새 항목").await;
    let w2 = worker_vec(
        &provider,
        vec_config(),
        service(mock_embedder().with_model_id("mock-concepts:v2"), 2_000),
    )
    .await;
    w2.embed_service().embedder().await;
    w.embed_service().forget_idle();
    w.embed_sweep().await;
    assert_eq!(
        embedded_of(&su, fx.ws, MOCK_MODEL).await,
        25,
        "the new item, model v1"
    );
    let row: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_item_embedding WHERE item_id = $1")
        .bind(fresh)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(row, 1);
    // Model v2: parallel backfill; v1 rows stay until a later cleanup, search only reads its own model.
    for _ in 0..8 {
        w2.embed_sweep().await;
    }
    assert_eq!(embedded_of(&su, fx.ws, "mock-concepts:v2").await, 25);
    assert_eq!(embedded_of(&su, fx.ws, MOCK_MODEL).await, 25);
    let no_rows = fused_rows(
        &su,
        fx.ws,
        fx.alice,
        "zzzz",
        5,
        fx.general,
        Some(&qvec("배포 미루기")),
        "no-such-model",
        0.0,
    )
    .await;
    assert!(
        no_rows.is_empty(),
        "a model with no rows finds nothing (keyword has no hit either)"
    );

    // Forgetting an item takes its vectors with it (FK cascade — no orphan inversion material).
    let victim = ids[2];
    let before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_item_embedding WHERE item_id = $1")
            .bind(victim)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(before, 2, "one row per model");
    sqlx::query("DELETE FROM mem_item WHERE id = $1")
        .bind(victim)
        .execute(&su)
        .await
        .unwrap();
    let after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_item_embedding WHERE item_id = $1")
            .bind(victim)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(after, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn the_api_role_and_the_worker_login_cannot_reach_the_vector_functions() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    restore_fused(&su).await;
    let fx = seed(&su).await;
    let wp = momo_worker_pool().await;
    let item = write_item(&wp, &fx, fx.general, fx.bob, PARAPHRASE_TARGET).await;
    let lit = qvec("배포");
    let app = momo_app_pool().await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker_vec(&provider, vec_config(), service(mock_embedder(), 2_000)).await;
    embed_everything(&w).await;
    assert!(
        embedded_of(&su, fx.ws, MOCK_MODEL).await >= 1,
        "there is a vector to protect"
    );

    let calls: Vec<(&str, String)> = vec![
        (
            "mem_set_item_embedding",
            format!("SELECT mem_set_item_embedding('{item}', 'm', '{lit}')"),
        ),
        (
            "mem_items_to_embed",
            "SELECT * FROM mem_items_to_embed('m', 5)".to_string(),
        ),
        (
            "mem_embedding_stats",
            "SELECT * FROM mem_embedding_stats('m')".to_string(),
        ),
        (
            "mem_serve_query",
            format!("SELECT mem_serve_query('{}')", Uuid::new_v4()),
        ),
        (
            "mem_serve_items_fused",
            format!(
                "SELECT * FROM mem_serve_items_fused('{}', 5, 600, '{lit}', 'm', 0.3)",
                Uuid::new_v4()
            ),
        ),
        (
            "mem_search_items_fused",
            format!(
                "SELECT * FROM mem_search_items_fused('{}', 'x', 5, '{}', '{lit}', 'm', 0.3)",
                fx.alice, fx.general
            ),
        ),
        (
            "mem_serve_gate",
            format!("SELECT * FROM mem_serve_gate('{}')", Uuid::new_v4()),
        ),
    ];
    for (name, sql) in &calls {
        for (who, pool) in [("momo_app", &app), ("momo_worker (login role)", &wp)] {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
                .bind(fx.ws.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let err = sqlx::query(sql)
                .fetch_all(&mut *tx)
                .await
                .expect_err(&format!("{who} must not call {name}"));
            let text = err.to_string();
            assert!(text.contains("permission denied"), "{who} {name}: {text}");
        }
    }
    // The table itself: no privilege at all for the API role, RLS or not.
    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(fx.ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    // Either the privilege is absent (permission denied) or — if a broad GRANT ran after the
    // migration — FORCE RLS with no policy for the API role shows zero rows. Never a vector.
    match sqlx::query_scalar::<_, i64>("SELECT count(*) FROM mem_item_embedding")
        .fetch_one(&mut *tx)
        .await
    {
        Err(err) => assert!(err.to_string().contains("permission denied"), "{err}"),
        Ok(n) => assert_eq!(n, 0, "the API role sees no embedding rows"),
    }
    drop(tx);
    let mut tx = wp.begin().await.unwrap();
    let err = sqlx::query("SELECT count(*) FROM mem_item_embedding")
        .fetch_one(&mut *tx)
        .await
        .expect_err("the BYPASSRLS worker login has no SELECT either");
    assert!(err.to_string().contains("permission denied"), "{err}");
    drop(tx);

    // SABOTAGE: a GRANT to the API role makes the call succeed (RED for the guard above).
    sqlx::query("GRANT EXECUTE ON FUNCTION mem_items_to_embed(text, integer) TO momo_app")
        .execute(&su)
        .await
        .unwrap();
    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(fx.ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let leaked = sqlx::query("SELECT * FROM mem_items_to_embed('m', 5)")
        .fetch_all(&mut *tx)
        .await;
    drop(tx);
    sqlx::query("REVOKE EXECUTE ON FUNCTION mem_items_to_embed(text, integer) FROM momo_app")
        .execute(&su)
        .await
        .unwrap();
    let leaked = leaked.expect("sabotaged: momo_app can now call it");
    eprintln!("RED (sabotage GRANT to momo_app): mem_items_to_embed returned {} item bodies to the API role", leaked.len());
    assert!(!leaked.is_empty(), "the sabotage really exposed bodies");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn each_new_sql_guard_is_load_bearing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    restore_fused(&su).await;
    let fx = seed(&su).await;
    let wp = momo_worker_pool().await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker_vec(&provider, vec_config(), service(mock_embedder(), 2_000)).await;

    // hr items sit closest to the question; the general item is a weaker match.
    let mut hr_items = Vec::new();
    for n in 1..=5 {
        hr_items.push(
            write_item(
                &wp,
                &fx,
                fx.hr,
                fx.bob,
                &format!("배포 미루기 언제 결정 {n}"),
            )
            .await,
        );
    }
    let general = write_item(&wp, &fx, fx.general, fx.bob, PARAPHRASE_TARGET).await;
    // 40 items in bob's private channel, which alice cannot read.
    let digest = write_digest(
        &wp,
        fx.ws,
        fx.secret,
        fx.bob,
        "window",
        "비밀 요약",
        3,
        None,
        &[],
    )
    .await;
    for n in 0..40 {
        add_item_to(&wp, &fx, &digest, &format!("배포 미루기 언제 비밀 {n}")).await;
    }
    embed_everything(&w).await;
    let query = "배포 미루기 언제";
    let lit = qvec(query);
    let run = |limit: i32| {
        let (su, lit) = (su.clone(), lit.clone());
        async move {
            fused_rows(
                &su,
                fx.ws,
                fx.alice,
                "zzzz",
                limit,
                fx.general,
                Some(&lit),
                MOCK_MODEL,
                0.30,
            )
            .await
        }
    };

    // Baseline (the real function): alice answering in #general sees the general item, nothing else.
    let base = run(3).await;
    assert_eq!(
        base.iter().map(|r| r.0).collect::<Vec<_>>(),
        vec![general],
        "{base:?}"
    );

    // 1) audience rule removed: alice is a member of hr, so its items leak into a #general answer.
    sabotage_fused(
        &su,
        "IF NOT public.mem_item_audience_ok(r.eid, p_answer_channel_id, p_viewer) THEN\n      CONTINUE;\n    END IF;",
        "",
    )
    .await;
    let red = run(3).await;
    eprintln!(
        "RED (audience rule removed): {} rows, hr items leaked = {}",
        red.len(),
        red.iter().filter(|r| hr_items.contains(&r.0)).count()
    );
    assert!(
        red.iter().any(|r| hr_items.contains(&r.0)),
        "the audience guard is load-bearing"
    );
    restore_fused(&su).await;

    // 2) top-N before the filters (L-3): only the 3 nearest rows are ever looked at, all hr → the
    // servable general item is lost.
    sabotage_fused(
        &su,
        "ORDER BY e.embedding OPERATOR(public.<=>) v_q, i.id\n  LOOP",
        "ORDER BY e.embedding OPERATOR(public.<=>) v_q, i.id LIMIT 3\n  LOOP",
    )
    .await;
    let red = run(3).await;
    eprintln!(
        "RED (top-N before the filters): got {} rows, the general item is missing = {}",
        red.len(),
        !red.iter().any(|r| r.0 == general)
    );
    assert!(
        !red.iter().any(|r| r.0 == general),
        "filter-then-cut is load-bearing"
    );
    restore_fused(&su).await;
    assert_eq!(
        run(3).await.iter().map(|r| r.0).collect::<Vec<_>>(),
        vec![general]
    );

    // 3) membership narrowing before the scan: items of channels the viewer is not in must not even
    // reach the permission functions (their number would show in the response time). Counted with
    // transaction-local function statistics.
    let calls = |limit: i32| {
        let (su, lit) = (su.clone(), lit.clone());
        async move {
            let mut tx = su.begin().await.unwrap();
            sqlx::query("SET LOCAL track_functions = 'all'")
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
                .bind(fx.ws.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query(
                "SELECT count(*) FROM mem_search_items_fused($1, 'zzzz', $2, $3, $4, $5, 0.0)",
            )
            .bind(fx.alice)
            .bind(limit)
            .bind(fx.general)
            .bind(&lit)
            .bind(MOCK_MODEL)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            let n: i64 = sqlx::query_scalar(
                "SELECT COALESCE(pg_stat_get_xact_function_calls('public.mem_item_readable_by(uuid, uuid)'::regprocedure), 0)",
            )
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            tx.rollback().await.unwrap();
            n
        }
    };
    let narrowed = calls(20).await;
    assert!(
        narrowed <= 8,
        "only alice's own channels reach the rule check: {narrowed}"
    );
    sabotage_fused(
        &su,
        "AND (i.channel_id IN (SELECT ms.channel_id FROM public.membership ms\n                              WHERE ms.workspace_id = v_ws AND ms.member_id = p_viewer\n                                AND ms.left_at IS NULL)\n            OR (i.space_kind = 'personal' AND i.owner_member_id = p_viewer))",
        "",
    )
    .await;
    let wide = calls(20).await;
    eprintln!("RED (membership narrowing removed): readable_by calls {narrowed} -> {wide}");
    assert!(
        wide >= narrowed + 40,
        "the private channel's 40 items now reach the rule check: {wide}"
    );
    restore_fused(&su).await;

    // 4) the similarity floor keeps unrelated neighbours out.
    let unrelated = fused_rows(
        &su,
        fx.ws,
        fx.alice,
        "zzzz",
        5,
        fx.general,
        Some(&qvec("점심 김밥 메뉴")),
        MOCK_MODEL,
        0.30,
    )
    .await;
    assert!(unrelated.is_empty(), "{unrelated:?}");
    sabotage_fused(&su, ">= v_min\n", ">= -1\n").await;
    let red = fused_rows(
        &su,
        fx.ws,
        fx.alice,
        "zzzz",
        5,
        fx.general,
        Some(&qvec("점심 김밥 메뉴")),
        MOCK_MODEL,
        0.30,
    )
    .await;
    eprintln!(
        "RED (similarity floor removed): an unrelated question now pulls {} item(s)",
        red.len()
    );
    assert!(!red.is_empty());
    restore_fused(&su).await;

    // 5) weighted RRF: a keyword-only hit outranks a vector-only hit of the same rank even when the
    // vector-only item is newer (equal weights would fall through to the recency tie-break).
    let kw_only = write_item(&wp, &fx, fx.general, fx.bob, "회의록 정리 마감 금요일").await; // keyword hit, far in vector space
    let vec_only = write_item(&wp, &fx, fx.general, fx.bob, "출시 지연 판단 QA").await; // paraphrase of the query below, newer
    let w2 = worker_vec(&provider, vec_config(), service(mock_embedder(), 2_000)).await;
    embed_everything(&w2).await;
    let q = "회의록 정리 마감 릴리스 연기";
    let want = fused_rows(
        &su,
        fx.ws,
        fx.alice,
        q,
        5,
        fx.general,
        Some(&qvec("출시 지연 판단 QA")),
        MOCK_MODEL,
        0.20,
    )
    .await;
    let pos = |rows: &[(Uuid, String)], id: Uuid| rows.iter().position(|r| r.0 == id);
    assert!(
        pos(&want, kw_only).is_some() && pos(&want, vec_only).is_some(),
        "{want:?}"
    );
    assert!(
        pos(&want, kw_only) < pos(&want, vec_only),
        "keyword x2 outranks vector x1: {want:?}"
    );
    sabotage_fused(
        &su,
        "COALESCE(2.0 / (60 + kw.krank), 0)",
        "COALESCE(1.0 / (60 + kw.krank), 0)",
    )
    .await;
    let red = fused_rows(
        &su,
        fx.ws,
        fx.alice,
        q,
        5,
        fx.general,
        Some(&qvec("출시 지연 판단 QA")),
        MOCK_MODEL,
        0.20,
    )
    .await;
    eprintln!(
        "RED (equal weights): order flips = {}",
        pos(&red, kw_only) > pos(&red, vec_only)
    );
    assert!(
        pos(&red, kw_only) > pos(&red, vec_only),
        "the x2 keyword weight is load-bearing: {red:?}"
    );
    restore_fused(&su).await;
}
