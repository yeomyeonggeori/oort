//! DB-backed conformance for the Anthropic **Messages** wire (#2872): an
//! `anthropic-key` provider_link answers a mention through
//! `POST {base_url}/messages`, streamed, with `x-api-key` auth — and the key
//! reaches no durable row, no error, and no message.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent-worker --test anthropic_adapter_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Same harness contract as `responses_adapter_conformance_pg.rs`. The mock
//! speaks Anthropic's documented Messages SSE shape (runtime-unverified against
//! the live API), writes 7 bytes at a time so Korean characters are split, and
//! counts every request that reaches `/v1/chat/completions` or carries an
//! `Authorization` header — both must stay zero.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `anth_1_a_mention_is_answered_through_the_messages_wire` | map `anthropic-key` to chat/completions, send the key as `Authorization: Bearer`, drop `anthropic-version`, send `system` as a message, or drop the streamed deltas |
//! | `anth_2_usage_lands_on_the_ledger` | read `prompt_tokens` names out of an Anthropic body, or drop the cache-read sum |
//! | `anth_3_the_key_never_reaches_a_durable_row_even_when_echoed` | stop scrubbing the key out of provider error bodies |

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::http_provider;
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{seal_bearer, upsert_link, LinkCredential};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as oauth_provider_conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB")
}

fn momo_worker_password() -> String {
    std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_worker_pool() -> PgPool {
    let opts: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let opts = opts
        .username("momo_worker")
        .password(&momo_worker_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .expect("connect as momo_worker (run bootstrap_roles.sql first)")
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
    panic!("psql client not found on PATH or Homebrew libpq locations");
}

fn apply_bootstrap_roles() {
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations on a fresh pgvector/pg18 DB");
    apply_bootstrap_roles();
    *ready = true;
}

/// The agent-job claim is global (no workspace predicate), so a leftover row
/// from another suite would land in this one's batch.
async fn settle_residual_worker_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = 'publish' \
            AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual worker agent_jobs");
}

/// `provider_link` is an instance-global singleton, so one suite's link is every
/// suite's link.
async fn clear_provider_link(worker_pool: &PgPool) {
    sqlx::query("DELETE FROM provider_link WHERE id = true")
        .execute(worker_pool)
        .await
        .expect("clear provider_link");
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const AGENT_MODEL: &str = "claude-sonnet-4-5";
const HUMAN_DISPLAY: &str = "성재";
const SYSTEM_PROMPT: &str = "너는 hermes다";
const MASTER_KEY: &str = "anthropic-conformance-master-key";
const ANTHROPIC_KEY: &str = "sk-ant-api03-conformance-LEAKCANARY-4c1d";

struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    agent_id: Uuid,
    channel_id: Uuid,
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace_id = Uuid::new_v4();
    let human_id = Uuid::new_v4();
    let agent_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    for (id, kind, display) in [
        (human_id, "human", HUMAN_DISPLAY.to_string()),
        (agent_id, "agent", "hermes".to_string()),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $5)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(kind)
        .bind(display)
        .bind(id.to_string())
        .execute(su)
        .await
        .expect("seed member");
    }
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50)",
    )
    .bind(agent_id)
    .bind(workspace_id)
    .bind(AGENT_MODEL)
    .execute(su)
    .await
    .expect("seed agent");

    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("anth-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member_id in [human_id, agent_id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .execute(su)
        .await
        .expect("seed membership");
    }

    Tenant {
        workspace_id,
        human_id,
        agent_id,
        channel_id,
    }
}

/// The exact object `MessageRoutes.mentionJobPayload` writes, including the
/// `system_prompt` that becomes the Responses request's `instructions`.
async fn enqueue_mention_turn(pool: &PgPool, tenant: &Tenant, body: &str) -> (Uuid, i64) {
    let workspace_id = tenant.workspace_id;
    let channel_id = tenant.channel_id;
    let human_id = tenant.human_id;
    let agent_id = tenant.agent_id;
    let body = body.to_string();

    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            let trigger = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, human_id, body.clone()),
            )
            .await?;
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger: RunTrigger::Mention {
                        message_id: trigger.message.id,
                        agent_member_id: agent_id,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({
                        "schema": "momo.agent_run.input.v0",
                        "surface": "mention",
                        "prompt": body,
                    }),
                },
            )
            .await?;
            let payload = json!({
                "run_id": created.id,
                "workspace_id": workspace_id,
                "channel_id": channel_id,
                "agent_member_id": agent_id,
                "author_member_id": human_id,
                "trigger_message_id": trigger.message.id,
                "trigger_message_seq": trigger.message.seq,
                "model": AGENT_MODEL,
                "prompt": body,
                "system_prompt": SYSTEM_PROMPT,
                "recent_messages": [{
                    "message_id": trigger.message.id,
                    "channel_id": channel_id,
                    "seq": trigger.message.seq,
                    "author_member_id": human_id,
                    "author_kind": "human",
                    "author_display": HUMAN_DISPLAY,
                    "type": "text",
                    "body": body,
                }],
                "max_output_tokens": 512,
                "delivery": "worker",
                "created_from": "server.message_send.agent_mention.v0",
            });
            let job_id = emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &payload,
                Some(agent_id),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok((created.id, job_id))
        })
    })
    .await
    .expect("enqueue a mention turn")
}

fn worker_config() -> WorkerConfig {
    let mut config = WorkerConfig::for_target(database_url());
    config.provider_link_master_key = Some(MASTER_KEY.to_string());
    config
}

/// A worker wired exactly as `main.rs` wires one: the real token-endpoint client
/// and the real **routed** provider, so the envelope-kind mapping is part of what
/// is under test rather than something the harness decided.
async fn build_worker(config: WorkerConfig) -> AgentWorker {
    // #2852: the mock provider is a loopback listener, which the egress guard
    // only admits under the operator's ADR-0004 증보 opt-in.
    let egress = momo_settings::EgressPolicy {
        allow_local: true,
        ..Default::default()
    };
    let provider =
        http_provider(config.request_timeout, egress).expect("build the shipped provider pair");
    AgentWorker::new(momo_worker_pool().await, provider, config)
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

async fn agent_messages(su: &PgPool, tenant: &Tenant) -> Vec<(String, i64, Value)> {
    sqlx::query(
        "SELECT COALESCE(body, '') AS body, seq, props FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
          ORDER BY seq",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.channel_id)
    .bind(tenant.agent_id)
    .fetch_all(su)
    .await
    .expect("read agent messages")
    .into_iter()
    .map(|row| {
        (
            row.get::<String, _>("body"),
            row.get::<i64, _>("seq"),
            row.get::<Value, _>("props"),
        )
    })
    .collect()
}

async fn run_status(su: &PgPool, run_id: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run_id)
        .fetch_one(su)
        .await
        .expect("read run status")
}

#[derive(Debug, PartialEq, Eq)]
struct LedgerRow {
    model: String,
    prompt_tokens: i32,
    completion_tokens: i32,
    cached_tokens: i32,
    reasoning_tokens: i32,
    was_estimated: bool,
}

async fn ledger_row(su: &PgPool, run_id: Uuid) -> LedgerRow {
    let row = sqlx::query(
        "SELECT model, prompt_tokens, completion_tokens, cached_tokens, \
                reasoning_tokens, was_estimated FROM usage_ledger WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(su)
    .await
    .expect("read the ledger row");
    LedgerRow {
        model: row.get("model"),
        prompt_tokens: row.get("prompt_tokens"),
        completion_tokens: row.get("completion_tokens"),
        cached_tokens: row.get("cached_tokens"),
        reasoning_tokens: row.get("reasoning_tokens"),
        was_estimated: row.get("was_estimated"),
    }
}

// ---------------------------------------------------------------------------
// seeding + the mock Anthropic provider
// ---------------------------------------------------------------------------

/// Seal the key through the operator's own path (`seal_bearer` + `upsert_link`).
async fn seed_anthropic_link(worker_pool: &PgPool, tenant: &Tenant, base_url: &str) {
    let sealed = seal_bearer(
        &LinkCredential::AnthropicKey(ANTHROPIC_KEY.to_string()).to_sealed_plaintext(),
        MASTER_KEY,
    )
    .expect("seal the anthropic key");
    let mut conn = worker_pool.acquire().await.expect("acquire");
    upsert_link(
        &mut conn,
        base_url,
        &sealed,
        "external-hermes",
        tenant.human_id,
    )
    .await
    .expect("seed provider_link");
}

#[derive(Debug, Clone)]
struct ObservedCall {
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

struct MockState {
    reply_deltas: Vec<String>,
    /// Answer 401 with an error body that echoes the presented key.
    echo_key_in_401: bool,
    calls: Vec<ObservedCall>,
    chat_completions_calls: usize,
    authorization_headers: usize,
}

impl MockState {
    fn new() -> MockState {
        MockState {
            reply_deltas: vec![
                "클로드가 ".to_string(),
                "메시지 와이어로 답합니다".to_string(),
            ],
            echo_key_in_401: false,
            calls: Vec::new(),
            chat_completions_calls: 0,
            authorization_headers: 0,
        }
    }
}

struct MockProvider {
    addr: SocketAddr,
    state: Arc<Mutex<MockState>>,
    handle: tokio::task::JoinHandle<()>,
}

impl MockProvider {
    async fn start(state: MockState) -> MockProvider {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock");
        let addr = listener.local_addr().expect("mock address");
        let state = Arc::new(Mutex::new(state));
        let served = state.clone();
        let handle = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let state = served.clone();
                tokio::spawn(async move { handle_connection(socket, state).await });
            }
        });
        MockProvider {
            addr,
            state,
            handle,
        }
    }

    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state.lock().expect("mock state")
    }
}

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

fn sse(name: &str, data: Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

async fn write_json(socket: &mut TcpStream, status: u16, payload: Value) {
    let body = payload.to_string();
    let response = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.flush().await;
}

async fn handle_connection(mut socket: TcpStream, state: Arc<Mutex<MockState>>) {
    let Some((head, body)) = read_request(&mut socket).await else {
        return;
    };
    let target = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("")
        .to_string();
    let headers = parse_headers(&head);
    let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

    let (echo, deltas) = {
        let mut state = state.lock().expect("mock state");
        if headers.contains_key("authorization") {
            state.authorization_headers += 1;
        }
        if target.starts_with("/v1/chat/completions") {
            state.chat_completions_calls += 1;
        }
        state.calls.push(ObservedCall {
            path: target.clone(),
            headers: headers.clone(),
            body: request.clone(),
        });
        (state.echo_key_in_401, state.reply_deltas.clone())
    };

    if !target.starts_with("/v1/messages") {
        write_json(
            &mut socket,
            404,
            json!({"type":"error","error":{"type":"not_found_error","message":"no such route"}}),
        )
        .await;
        return;
    }
    let presented = headers.get("x-api-key").cloned().unwrap_or_default();
    if echo || presented != ANTHROPIC_KEY {
        write_json(
            &mut socket,
            401,
            json!({"type":"error","error":{"type":"authentication_error",
                   "message": format!("invalid x-api-key: {presented}")}}),
        )
        .await;
        return;
    }

    let mut events = sse(
        "message_start",
        json!({"type":"message_start","message":{"id":"msg_anth","type":"message","role":"assistant",
               "model": AGENT_MODEL, "content":[],
               "usage":{"input_tokens":30,"cache_read_input_tokens":12,"cache_creation_input_tokens":0,"output_tokens":1}}}),
    );
    events.push_str(&sse(
        "content_block_start",
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
    ));
    events.push_str(&sse("ping", json!({"type":"ping"})));
    for delta in &deltas {
        events.push_str(&sse(
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":delta}}),
        ));
    }
    events.push_str(&sse(
        "content_block_stop",
        json!({"type":"content_block_stop","index":0}),
    ));
    events.push_str(&sse(
        "message_delta",
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":19}}),
    ));
    events.push_str(&sse("message_stop", json!({"type":"message_stop"})));

    let _ = socket.set_nodelay(true);
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    let _ = socket.write_all(head.as_bytes()).await;
    for slice in events.as_bytes().chunks(7) {
        if socket.write_all(slice).await.is_err() {
            return;
        }
        let _ = socket.flush().await;
        tokio::task::yield_now().await;
    }
    let _ = socket.shutdown().await;
}

/// A `tracing` writer that keeps everything in memory.
#[derive(Clone, Default)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);

impl LogCapture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("log buffer")).to_string()
    }
}

impl std::io::Write for LogCapture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("log buffer").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = LogCapture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Every durable place a key could land, as one string.
async fn all_persisted_text(su: &PgPool, tenant: &Tenant) -> String {
    let mut buffer = String::new();
    for sql in [
        "SELECT COALESCE(body, '') || ' ' || props::text FROM message WHERE workspace_id = $1",
        "SELECT payload::text || ' ' || COALESCE(last_error, '') FROM outbox WHERE workspace_id = $1",
        "SELECT COALESCE(input::text, '') || ' ' || COALESCE(output::text, '') || ' ' \
              || COALESCE(error::text, '') FROM agent_run WHERE workspace_id = $1",
        "SELECT model || ' ' || COALESCE(effort, '') FROM usage_ledger WHERE workspace_id = $1",
        "SELECT action || ' ' || COALESCE(detail::text, '') FROM audit_log WHERE workspace_id = $1",
    ] {
        let rows: Vec<String> = sqlx::query_scalar(sql)
            .bind(tenant.workspace_id)
            .fetch_all(su)
            .await
            .expect("read persisted text");
        for row in rows {
            buffer.push_str(&row);
            buffer.push('\n');
        }
    }
    let link: Vec<String> = sqlx::query_scalar("SELECT base_url || ' ' || mode FROM provider_link")
        .fetch_all(su)
        .await
        .expect("provider_link plaintext");
    buffer.push_str(&link.join("\n"));
    buffer
}

/// Read one HTTP/1.1 request: headers to the blank line, then `Content-Length`
/// bytes of body.
async fn read_request(socket: &mut TcpStream) -> Option<(String, String)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(offset) = find_subslice(&buffer, b"\r\n\r\n") {
            break offset;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);

    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < content_length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some((head, String::from_utf8_lossy(&body).to_string()))
}

fn parse_headers(head: &str) -> HashMap<String, String> {
    head.lines()
        .skip(1)
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------
// the tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn anth_1_a_mention_is_answered_through_the_messages_wire() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new()).await;
    seed_anthropic_link(&worker_pool, &tenant, &provider.base_url()).await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 클로드로 답해줘").await;
    let worker = build_worker(worker_config()).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.answered, 1, "the turn produced an answer");
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    {
        let state = provider.state();
        assert_eq!(state.chat_completions_calls, 0, "never the chat wire");
        assert_eq!(
            state.authorization_headers, 0,
            "the key never rides as Bearer"
        );
        assert_eq!(state.calls.len(), 1, "exactly one provider call");
        let call = &state.calls[0];
        assert_eq!(call.path, "/v1/messages");
        assert_eq!(
            call.headers.get("x-api-key").map(String::as_str),
            Some(ANTHROPIC_KEY)
        );
        assert_eq!(
            call.headers.get("anthropic-version").map(String::as_str),
            Some("2023-06-01")
        );
        assert_eq!(call.body["model"], json!(AGENT_MODEL));
        assert_eq!(call.body["stream"], json!(true));
        assert_eq!(call.body["max_tokens"], json!(512));
        assert!(
            call.body["system"]
                .as_str()
                .unwrap_or("")
                .contains(SYSTEM_PROMPT),
            "system is top-level: {}",
            call.body
        );
        let messages = call.body["messages"].as_array().expect("messages");
        assert!(messages
            .iter()
            .all(|m| m["role"] == "user" || m["role"] == "assistant"));
        assert_eq!(messages.first().unwrap()["role"], "user");
    }

    let messages = agent_messages(&su, &tenant).await;
    assert_eq!(messages.len(), 1);
    let (body, seq, props) = &messages[0];
    assert_eq!(
        body, "클로드가 메시지 와이어로 답합니다",
        "the streamed deltas, split mid-character on the socket, are the committed body"
    );
    assert!(*seq > 0);
    assert_eq!(props["run_id"], json!(run_id));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn anth_2_usage_lands_on_the_ledger() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;
    let provider = MockProvider::start(MockState::new()).await;
    seed_anthropic_link(&worker_pool, &tenant, &provider.base_url()).await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 사용량").await;
    build_worker(worker_config())
        .await
        .drain_once()
        .await
        .expect("drain");
    assert_eq!(run_status(&su, run_id).await, "succeeded");
    assert_eq!(
        ledger_row(&su, run_id).await,
        LedgerRow {
            model: AGENT_MODEL.to_string(),
            prompt_tokens: 42,
            completion_tokens: 19,
            cached_tokens: 12,
            reasoning_tokens: 0,
            was_estimated: false,
        }
    );
}

/// The provider echoes the presented key into its 401 body. The run fails, and
/// the key reaches no durable row — not the run error, not a failure notice,
/// not the outbox, not the audit log.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn anth_3_the_key_never_reaches_a_durable_row_even_when_echoed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let mut state = MockState::new();
    state.echo_key_in_401 = true;
    let provider = MockProvider::start(state).await;
    seed_anthropic_link(&worker_pool, &tenant, &provider.base_url()).await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 실패해봐").await;
    let mut config = worker_config();
    config.max_attempts = 1;
    // Every log line the turn emits, at every level, is captured and scanned
    // too: a key that never reaches a row but reaches stdout is still leaked.
    let logs = LogCapture::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(logs.clone())
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    build_worker(config)
        .await
        .drain_once()
        .await
        .expect("drain");
    drop(guard);
    let logged = logs.text();
    assert!(
        logged.contains("401"),
        "the provider failure was logged, so the log scan is not vacuous: {logged}"
    );
    assert!(
        !logged.contains("LEAKCANARY"),
        "the Anthropic key reached a log line: {logged}"
    );
    assert_ne!(run_status(&su, run_id).await, "succeeded");
    assert!(
        !provider.state().calls.is_empty(),
        "the provider was reached"
    );

    let persisted = all_persisted_text(&su, &tenant).await;
    assert!(
        persisted.contains("redacted") || persisted.contains("401"),
        "the failure was recorded somewhere, so the scan is not vacuous: {persisted}"
    );
    assert!(
        !persisted.contains("LEAKCANARY"),
        "the Anthropic key reached a durable row: {persisted}"
    );
}
