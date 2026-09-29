// Shared by the #3168 conformance suites via `include!` (Recorder mock, seeding, digests helpers).
// Same shape as the harness in `memory_summary_conformance_pg.rs`, plus a per-call reply hook.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use momo_agent::memory as mem;
use momo_agent_worker::provider::{
    ChatCompletion, ChatProvider, ChatRequest, ChatUsage, ProviderEndpoint, ProviderError,
};
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{delete_message_in_tx, edit_message_in_tx, send_message_in_tx, NewMessage};
use momo_settings::{
    redacted_endpoint_label, seal_bearer, upsert_default_ai, upsert_link, DefaultAiRole,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

const MASTER_KEY: &str = "conformance-3168-master";
const HEAD_URL: &str = "https://team-gw.example/v1";
const HEAD_BEARER: &str = "sk-head-3168-a1b2c3";
const SUMMARY_MODEL: &str = "sum-model";

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

/// The provider link / 기본 AI rows are instance-global: start from empty, leave empty. The
/// sweep looks at every active channel of the database, so channels left behind by sibling
/// suites (or earlier tests of this one) are archived first — this test's tenants are the only
/// live ones.
async fn reset_instance(su: &PgPool) {
    sqlx::query("UPDATE channel SET archived_at = now() WHERE archived_at IS NULL")
        .execute(su)
        .await
        .expect("archive foreign channels");
    for table in [
        "provider_default_ai",
        "provider_link_chain",
        "provider_link",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .expect("empty instance table");
    }
}

struct Fx {
    ws: Uuid,
    human: Uuid,
    human_b: Uuid,
    agent: Uuid,
    channel: Uuid,
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
    .bind((kind != "dm").then(|| format!("c3168-{}", &id.simple().to_string()[..8])))
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
    let human = new_member(su, ws, "human", "김철수").await;
    let human_b = new_member(su, ws, "human", "박영희").await;
    let agent = new_member(su, ws, "agent", "hermes").await;
    let channel = new_channel(su, ws, "public", &[human, human_b, agent]).await;
    Fx {
        ws,
        human,
        human_b,
        agent,
        channel,
    }
}

/// A team link + a 기본 AI `summary` row on it (the only configuration that lets the loop run).
async fn configure_summary_row(su: &PgPool, owner: Uuid) {
    let mut conn = su.acquire().await.unwrap();
    let head = seal_bearer(HEAD_BEARER, MASTER_KEY).unwrap();
    upsert_link(&mut conn, HEAD_URL, &head, "external-hermes", owner)
        .await
        .expect("head link");
    upsert_default_ai(
        &mut conn,
        DefaultAiRole::Summary,
        0,
        &redacted_endpoint_label(HEAD_URL),
        Some(SUMMARY_MODEL),
        owner,
    )
    .await
    .expect("summary row");
}

async fn post(worker_pool: &PgPool, fx: &Fx, author: Uuid, body: &str) -> (Uuid, i64) {
    post_in(worker_pool, fx.ws, fx.channel, author, body).await
}

async fn post_in(pool: &PgPool, ws: Uuid, channel: Uuid, author: Uuid, body: &str) -> (Uuid, i64) {
    let body = body.to_string();
    with_tenant_tx(pool, ws, move |conn| {
        Box::pin(async move {
            let sent =
                send_message_in_tx(conn, ws, NewMessage::text(channel, author, body)).await?;
            Ok((sent.message.id, sent.message.seq))
        })
    })
    .await
    .expect("send")
}

async fn post_reply(pool: &PgPool, fx: &Fx, root: Uuid, author: Uuid, body: &str) -> (Uuid, i64) {
    let (ws, channel) = (fx.ws, fx.channel);
    let body = body.to_string();
    with_tenant_tx(pool, ws, move |conn| {
        Box::pin(async move {
            let mut message = NewMessage::text(channel, author, body);
            message.root_id = Some(root);
            let sent = send_message_in_tx(conn, ws, message).await?;
            Ok((sent.message.id, sent.message.seq))
        })
    })
    .await
    .expect("send reply")
}

fn memory_config() -> WorkerConfig {
    let mut config = WorkerConfig::for_target(database_url());
    config.provider_link_master_key = Some(MASTER_KEY.to_string());
    config.utc_offset_minutes = 0;
    config.memory.window_min_messages = 3;
    config.memory.window_idle_min_messages = 1_000;
    config.memory.thread_min_replies = 3;
    config.memory.thread_idle_min_replies = 1_000;
    // The regeneration throttle (M-1) is tested on its own; everywhere else edits regenerate now.
    config.memory.regen_min_interval_seconds = 0;
    config
}

type HookFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type Hook = Arc<dyn Fn(usize) -> HookFuture + Send + Sync>;
type ReplyFn = Arc<dyn Fn(usize, &str) -> String + Send + Sync>;

/// The mock model: records every request, optionally waits, fails or runs a hook first.
struct Recorder {
    calls: Mutex<Vec<(String, String)>>,
    delay: Mutex<Duration>,
    fail: AtomicBool,
    hook: Mutex<Option<Hook>>,
    /// When set, the model answers with this text instead of `- 요약 #n`.
    reply: Mutex<Option<String>>,
    /// When set, the answer is computed from the call number (1-based) and the user prompt.
    reply_fn: Mutex<Option<ReplyFn>>,
}

impl Recorder {
    fn new() -> Arc<Recorder> {
        Arc::new(Recorder {
            calls: Mutex::new(Vec::new()),
            delay: Mutex::new(Duration::ZERO),
            fail: AtomicBool::new(false),
            hook: Mutex::new(None),
            reply: Mutex::new(None),
            reply_fn: Mutex::new(None),
        })
    }
    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
    fn prompt(&self, index: usize) -> String {
        self.calls.lock().unwrap()[index].1.clone()
    }
    fn model(&self, index: usize) -> String {
        self.calls.lock().unwrap()[index].0.clone()
    }
}

#[async_trait]
impl ChatProvider for Recorder {
    async fn complete(
        &self,
        _endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        let user = request
            .messages
            .iter()
            .filter(|m| m.role == "user")
            .map(|m| m.content.clone())
            .collect::<Vec<_>>()
            .join("\n");
        let n = {
            let mut calls = self.calls.lock().unwrap();
            calls.push((request.model.clone(), user.clone()));
            calls.len()
        };
        let hook = self.hook.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(n).await;
        }
        let delay = *self.delay.lock().unwrap();
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(ProviderError::Unreachable("mock outage".into()));
        }
        let by_call = self.reply_fn.lock().unwrap().clone();
        let text = match by_call {
            Some(f) => f(n, &user),
            None => self
                .reply
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| format!("- 요약 #{n}")),
        };
        Ok(ChatCompletion {
            text,
            usage: Some(ChatUsage {
                prompt_tokens: 100,
                completion_tokens: 50,
                cached_tokens: 0,
                reasoning_tokens: 0,
            }),
            ..Default::default()
        })
    }
}

async fn worker_with(provider: &Arc<Recorder>, config: WorkerConfig) -> AgentWorker {
    AgentWorker::new(
        momo_worker_pool().await,
        provider.clone() as Arc<dyn ChatProvider>,
        config,
    )
}

async fn digests(su: &PgPool, channel: Uuid) -> Vec<sqlx::postgres::PgRow> {
    sqlx::query(
        "SELECT id, level, thread_root_id, from_seq, to_seq, body, source_count, source_digest_ids, \
                model, model_source, prompt_version, stale \
           FROM mem_digest WHERE channel_id = $1 ORDER BY level, to_seq",
    )
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("digests")
}

async fn evidence_of(su: &PgPool, digest: Uuid) -> Vec<Uuid> {
    let mut ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM mem_evidence WHERE digest_id = $1")
            .bind(digest)
            .fetch_all(su)
            .await
            .expect("evidence");
    ids.sort();
    ids
}

async fn cursor_of(su: &PgPool, channel: Uuid) -> Option<(i64, bool)> {
    sqlx::query(
        "SELECT last_seq, (leased_until IS NULL OR leased_until <= now()) AS free \
           FROM mem_cursor WHERE channel_id = $1",
    )
    .bind(channel)
    .fetch_optional(su)
    .await
    .expect("cursor")
    .map(|row| (row.get("last_seq"), row.get("free")))
}

async fn tokens_used_today(su: &PgPool, ws: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(sum(tokens), 0)::bigint FROM mem_usage \
          WHERE workspace_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .expect("usage")
}

async fn audit_count(su: &PgPool, ws: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = $2")
        .bind(ws)
        .bind(action)
        .fetch_one(su)
        .await
        .expect("audit")
}

fn sorted(mut ids: Vec<Uuid>) -> Vec<Uuid> {
    ids.sort();
    ids
}

