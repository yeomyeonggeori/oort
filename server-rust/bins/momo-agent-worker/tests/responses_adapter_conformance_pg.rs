//! DB-backed conformance for the OpenAI **Responses** adapter (B5.4b / ADR-0147
//! 이행 완결) and its **SSE** wire (B5.4c).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent-worker --test responses_adapter_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Same harness contract as `oauth_provider_conformance_pg.rs` (superuser
//! `DATABASE_URL` applies the migrations + `bootstrap_roles.sql`; the worker runs
//! as the BYPASSRLS `momo_worker` role), with the mock provider re-shaped for the
//! Responses wire. Five properties of that mock are load-bearing:
//!
//! * **It serves `/v1/responses` and answers a Responses body** — `output[]` of
//!   `message` items whose `content[]` carries `output_text`, and the
//!   `input_tokens`/`output_tokens` usage vocabulary. A mock that answered the
//!   chat shape would let a half-ported parser pass.
//! * **It answers `text/event-stream`, not JSON** (B5.4c): `response.created`,
//!   one `response.output_text.delta` per fragment, then `response.completed`
//!   carrying the whole `Response`. The body has no `Content-Length`, so EOF ends
//!   it — which is how a dropped stream is staged at all.
//! * **It writes that stream 7 bytes at a time.** Korean characters are 3 bytes,
//!   so every reply is cut mid-character several times; an adapter that decoded
//!   each chunk on arrival puts `U+FFFD` in a user's channel and fails `b54c_1`.
//! * **It refuses a request without `stream: true`** with the live backend's own
//!   sentence, `"Stream must be set to true"`, and counts it (`b54c_4`).
//! * **`/v1/chat/completions` answers 404 and is counted.** A routing regression
//!   that sent a subscription token to the legacy wire then fails loudly in every
//!   test here instead of quietly answering from the wrong path.
//!
//! The worker under test is built with the **production** provider
//! ([`momo_agent_worker::provider::http_provider`]), not a hand-picked adapter:
//! the thing this batch adds is the mapping, and a test that chose the adapter
//! itself would prove nothing about which one a real turn picks.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b54b_1_a_mention_is_answered_through_the_responses_wire` | map the `oauth-openai` envelope back to chat/completions, or drop the `chatgpt-account-id` header on the Responses path |
//! | `b54b_2_responses_usage_lands_on_every_ledger_axis` | read `prompt_tokens`/`completion_tokens` (the chat names) out of a Responses body, or drop the `input_tokens_details`/`output_tokens_details` mapping, or stop reporting `was_estimated` for a usage-less turn |
//! | `b54b_3_an_expired_token_refreshes_reseals_and_the_next_responses_turn_reuses_it` | drop `reseal_link` from `refresh_and_reseal`, or keep the refreshed credential in the in-memory cache instead of invalidating it |
//! | `b54b_4_the_responses_request_carries_the_measured_wire_fields` | send the chat body (`messages`/`max_tokens`) to `/responses`, drop `store: false`, or flatten the typed `input` items into bare strings |
//! | `b54c_1_the_streamed_deltas_are_exactly_the_committed_body` | ignore `response.output_text.delta` and read only the terminal payload, concatenate BOTH (the answer doubles), join the deltas with a separator, or decode each TCP chunk with `from_utf8_lossy` |
//! | `b54c_2_the_terminal_events_usage_lands_on_every_ledger_axis` | stop reading `response.completed` once the last delta arrived — every subscription turn then bills as free |
//! | `b54c_3_a_stream_that_dies_mid_answer_is_retried_not_half_published` | commit the accumulated deltas when the stream ends without a terminal event, or classify the cut stream as non-retryable |
//! | `b54c_4_no_non_streamed_request_is_ever_sent` | send `stream: false` (B5.4b's body), or try non-stream first and fall back to SSE |

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
use momo_settings::{
    decrypt_link, read_link, seal_bearer, upsert_link, LinkCredential, OpenAiOAuthCredential,
};
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
            "/../../../infra/e2e/bootstrap_roles.sql"
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

const AGENT_MODEL: &str = "gpt-5.4-codex";
const HUMAN_DISPLAY: &str = "성재";
const SYSTEM_PROMPT: &str = "너는 hermes다";
const MASTER_KEY: &str = "b54b-conformance-master-key";

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
        .bind(format!("b54b-{}", &channel_id.simple().to_string()[..8]))
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

/// Seal an OAuth credential into the singleton through the operator's own path
/// (`seal_bearer` + `upsert_link`) — no test-only storage.
async fn seed_oauth_link(
    worker_pool: &PgPool,
    tenant: &Tenant,
    base_url: &str,
    credential: OpenAiOAuthCredential,
) {
    let sealed = seal_bearer(
        &LinkCredential::OpenAiOAuth(Box::new(credential)).to_sealed_plaintext(),
        MASTER_KEY,
    )
    .expect("seal the oauth credential");
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

async fn stored_credential(worker_pool: &PgPool) -> LinkCredential {
    let mut conn = worker_pool.acquire().await.expect("acquire");
    let stored = read_link(&mut conn)
        .await
        .expect("read provider_link")
        .expect("provider_link row exists");
    decrypt_link(&stored, MASTER_KEY)
        .expect("stored credential opens")
        .credential
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
    let provider = http_provider(config.request_timeout).expect("build the shipped provider pair");
    AgentWorker::new(momo_worker_pool().await, provider, config)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_millis() as i64
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
// the mock provider: OAuth token endpoint + the Responses wire
// ---------------------------------------------------------------------------

/// One captured `/v1/responses` request.
#[derive(Debug, Clone)]
struct ObservedResponsesCall {
    path: String,
    authorization: String,
    account_id: Option<String>,
    body: Value,
    /// `Accept`, so `b54c_4` can show the request asked for a stream at the HTTP
    /// layer as well as in the body.
    accept: Option<String>,
}

struct MockState {
    /// The only grant the endpoint accepts. Rotated on every refresh, so a spent
    /// grant is refused (ADR-0147 "이전 토큰 무효화").
    live_refresh_token: String,
    /// The only Bearer `/v1/responses` accepts.
    live_access_token: String,
    refuse_refresh: bool,
    access_token_ttl_secs: i64,
    rotations: u32,
    /// The assistant text the mock answers with, one entry per
    /// `response.output_text.delta`. Concatenated, they are the whole answer —
    /// which is the property `b54c_1` asserts against what lands in the channel.
    reply_deltas: Vec<String>,
    /// The `usage` object to answer with. `Value::Null` ⇒ the key is omitted,
    /// which is how a provider reports "not measured".
    usage: Value,
    /// Stop the stream after this many deltas and hang up, with no terminal
    /// event — the dropped connection `b54c_3` is about.
    truncate_after_deltas: Option<usize>,
    /// Whether `response.completed` repeats the whole answer in its `output[]`.
    /// Turning it off leaves the accumulated deltas as the ONLY source of the
    /// answer, which is how `b54c_1` proves they are what gets committed.
    terminal_repeats_the_answer: bool,
    token_calls: Vec<(String, Option<String>)>,
    responses_calls: Vec<ObservedResponsesCall>,
    /// Requests that reached the LEGACY chat wire. Must stay 0: a subscription
    /// OAuth link that lands there is the routing regression this suite exists
    /// to catch.
    chat_completions_calls: usize,
    /// Requests refused with the live backend's own sentence, "Stream must be
    /// set to true". Must stay 0 (`b54c_4`): the FIRST request already streams.
    non_stream_rejections: usize,
}

impl MockState {
    fn new(refresh_token: &str, access_token: &str) -> MockState {
        MockState {
            live_refresh_token: refresh_token.to_string(),
            live_access_token: access_token.to_string(),
            refuse_refresh: false,
            access_token_ttl_secs: 3_600,
            rotations: 0,
            reply_deltas: vec!["Responses 와이어로 ".to_string(), "답합니다".to_string()],
            usage: json!({
                "input_tokens": 41,
                "output_tokens": 17,
                "input_tokens_details": {"cached_tokens": 29},
                "output_tokens_details": {"reasoning_tokens": 11},
                "total_tokens": 58,
            }),
            truncate_after_deltas: None,
            terminal_repeats_the_answer: true,
            token_calls: Vec::new(),
            responses_calls: Vec::new(),
            chat_completions_calls: 0,
            non_stream_rejections: 0,
        }
    }

    /// The whole answer the deltas spell.
    fn reply_text(&self) -> String {
        self.reply_deltas.concat()
    }
}

/// What the mock writes back. The Responses wire needs the second arm: an SSE
/// answer is a sequence of events terminated by EOF, not a JSON body with a
/// `Content-Length`.
enum MockAnswer {
    Json(u16, Value),
    EventStream(String),
}

struct MockProvider {
    addr: SocketAddr,
    state: Arc<Mutex<MockState>>,
    handle: tokio::task::JoinHandle<()>,
}

impl MockProvider {
    async fn start(state: MockState) -> MockProvider {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the mock provider");
        let addr = listener.local_addr().expect("mock provider address");
        let state = Arc::new(Mutex::new(state));
        let served = state.clone();
        let handle = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((socket, _)) => {
                        let state = served.clone();
                        tokio::spawn(async move { handle_connection(socket, state).await });
                    }
                    Err(_) => return,
                }
            }
        });
        MockProvider {
            addr,
            state,
            handle,
        }
    }

    /// The operator's `provider_link.base_url`. The adapter appends the wire's
    /// own path, which is exactly the fact `b54b_4` asserts.
    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    fn token_endpoint(&self) -> String {
        format!("http://{}/oauth/token", self.addr)
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

    let answer = if target.starts_with("/oauth/token") {
        let (status, payload) = token_response(&state, &body);
        MockAnswer::Json(status, payload)
    } else if target.starts_with("/v1/responses") {
        responses_response(&state, &target, &headers, &body)
    } else if target.starts_with("/v1/chat/completions") {
        // Counted and refused. A regression that routed a subscription token
        // here would otherwise be invisible — the legacy wire would happily
        // answer and every assertion about the reply would still pass.
        state.lock().expect("mock state").chat_completions_calls += 1;
        MockAnswer::Json(
            404,
            json!({"error": {"message": "this link speaks the responses wire"}}),
        )
    } else {
        MockAnswer::Json(404, json!({"error": {"message": "no such route"}}))
    };

    match answer {
        MockAnswer::Json(status, payload) => {
            let body = payload.to_string();
            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
        }
        MockAnswer::EventStream(events) => {
            let _ = socket.set_nodelay(true);
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                        Cache-Control: no-store\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(head.as_bytes()).await;
            // Written in small slices on purpose: 7 bytes cuts through the
            // middle of the 3-byte Korean characters in the reply, so an adapter
            // that decoded each chunk on arrival would put `U+FFFD` in the
            // channel. The body has no `Content-Length`, so EOF ends it —
            // including when the mock hangs up early (`truncate_after_deltas`).
            for slice in events.as_bytes().chunks(7) {
                if socket.write_all(slice).await.is_err() {
                    return;
                }
                let _ = socket.flush().await;
                tokio::task::yield_now().await;
            }
            let _ = socket.shutdown().await;
        }
    }
}

fn token_response(state: &Arc<Mutex<MockState>>, body: &str) -> (u16, Value) {
    let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let refresh_token = request["refresh_token"].as_str().unwrap_or("").to_string();
    let client_id = request["client_id"].as_str().map(str::to_string);

    let mut state = state.lock().expect("mock state");
    state
        .token_calls
        .push((refresh_token.clone(), client_id.clone()));

    if request["grant_type"].as_str() != Some("refresh_token") {
        return (
            400,
            json!({"error": "unsupported_grant_type", "error_description": "expected refresh_token"}),
        );
    }
    if state.refuse_refresh {
        return (
            400,
            json!({"error": "invalid_grant", "error_description": "account access was revoked"}),
        );
    }
    if refresh_token != state.live_refresh_token {
        return (
            400,
            json!({"error": "invalid_grant", "error_description": "refresh token already rotated"}),
        );
    }

    state.rotations += 1;
    let rotation = state.rotations;
    state.live_refresh_token = format!("rt-rotated-{rotation}");
    state.live_access_token = format!("at-minted-{rotation}");
    (
        200,
        json!({
            "token_type": "Bearer",
            "access_token": state.live_access_token,
            "refresh_token": state.live_refresh_token,
            "expires_in": state.access_token_ttl_secs,
        }),
    )
}

/// The Responses answer, in the measured shape — and, since B5.4c, on the
/// measured wire: a `text/event-stream` of `response.output_text.delta` events
/// closed by `response.completed`, whose `response` is the whole object the
/// non-streamed body used to be.
///
/// The `stream` check is the live backend's own behaviour, reduced from NCP's
/// smoke to one sentence: a Responses request that does not set `stream: true`
/// is refused with 400 "Stream must be set to true".
fn responses_response(
    state: &Arc<Mutex<MockState>>,
    target: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> MockAnswer {
    let authorization = headers.get("authorization").cloned().unwrap_or_default();
    let account_id = headers.get("chatgpt-account-id").cloned();
    let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut state = state.lock().expect("mock state");
    state.responses_calls.push(ObservedResponsesCall {
        path: target.to_string(),
        authorization: authorization.clone(),
        account_id,
        body: request.clone(),
        accept: headers.get("accept").cloned(),
    });

    if authorization != format!("Bearer {}", state.live_access_token) {
        return MockAnswer::Json(401, json!({"error": {"message": "invalid access token"}}));
    }
    if request.get("stream") != Some(&Value::Bool(true)) {
        state.non_stream_rejections += 1;
        return MockAnswer::Json(
            400,
            json!({"error": {"message": "Stream must be set to true"}}),
        );
    }

    let deltas = match state.truncate_after_deltas {
        Some(limit) => &state.reply_deltas[..limit.min(state.reply_deltas.len())],
        None => &state.reply_deltas[..],
    };
    let mut events = sse_event(
        "response.created",
        json!({"type": "response.created", "sequence_number": 0}),
    );
    for (index, delta) in deltas.iter().enumerate() {
        events.push_str(&sse_event(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "sequence_number": index + 1,
                "item_id": "msg_1",
                "output_index": 0,
                "content_index": 0,
                "delta": delta,
                "logprobs": [],
            }),
        ));
    }
    if state.truncate_after_deltas.is_some() {
        // No terminal event: the connection simply ends.
        return MockAnswer::EventStream(events);
    }

    let output = if state.terminal_repeats_the_answer {
        json!([
            {"type": "reasoning", "id": "rs_1", "summary": []},
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": state.reply_text(), "annotations": []}],
            }
        ])
    } else {
        json!([{"type": "reasoning", "id": "rs_1", "summary": []}])
    };
    let mut response = json!({
        "id": "resp_b54b",
        "object": "response",
        "status": "completed",
        "error": null,
        "incomplete_details": null,
        "model": "gpt-5.4-codex",
        "output": output,
    });
    if !state.usage.is_null() {
        response["usage"] = state.usage.clone();
    }
    events.push_str(&sse_event(
        "response.completed",
        json!({
            "type": "response.completed",
            "sequence_number": deltas.len() + 1,
            "response": response,
        }),
    ));
    MockAnswer::EventStream(events)
}

/// One SSE frame: the `event:` name, the `data:` payload, and the blank line
/// that dispatches them.
fn sse_event(name: &str, payload: Value) -> String {
    format!("event: {name}\ndata: {payload}\n\n")
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

/// A live OAuth link: an access token that is not near its deadline, so the turn
/// exercises the wire rather than the refresh.
fn live_credential(provider: &MockProvider, access_token: &str) -> OpenAiOAuthCredential {
    let mut credential = OpenAiOAuthCredential::from_refresh_token("rt-seeded");
    credential.access_token = Some(access_token.to_string());
    credential.expires_at_ms = Some(now_ms() + 3_600_000);
    credential.account_id = Some("acct-seongjae".to_string());
    credential.account_label = Some("성재 개인 ChatGPT 구독".to_string());
    credential.token_endpoint = Some(provider.token_endpoint());
    credential
}

// ---------------------------------------------------------------------------
// b54b_1 — the round trip: a mention becomes a reply over the Responses wire
// ---------------------------------------------------------------------------

/// The batch's headline claim: an `oauth-openai` link answers a mention through
/// `POST {base_url}/responses`, and the answer reaches the channel on the
/// ordinary message spine.
///
/// The wire assertions are what make this more than a "the worker still works"
/// test. Before B5.4b the same fixture would have posted to
/// `/v1/chat/completions` — which the mock now counts and refuses — so a revert
/// of the envelope→adapter mapping fails here on three separate assertions
/// rather than one.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54b_1_a_mention_is_answered_through_the_responses_wire() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new("rt-seeded", "at-live")).await;
    seed_oauth_link(
        &worker_pool,
        &tenant,
        &provider.base_url(),
        live_credential(&provider, "at-live"),
    )
    .await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 구독으로 답해줘").await;
    let worker = build_worker(worker_config()).await;
    let stats = worker.drain_once().await.expect("drain");

    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.answered, 1, "the turn produced an answer");
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    {
        let state = provider.state();
        assert_eq!(
            state.chat_completions_calls, 0,
            "an oauth-openai envelope must never reach the legacy chat wire"
        );
        assert_eq!(state.responses_calls.len(), 1, "exactly one provider call");
        let call = &state.responses_calls[0];
        assert_eq!(
            call.path, "/v1/responses",
            "the adapter appends the Responses path to the operator's base_url"
        );
        assert_eq!(call.authorization, "Bearer at-live");
        assert_eq!(
            call.account_id.as_deref(),
            Some("acct-seongjae"),
            "chatgpt-account-id names which subscription pays — it rides BOTH wires"
        );
        assert!(
            state.token_calls.is_empty(),
            "a live token must not be refreshed just because the wire changed"
        );
    }

    // The reply is an ordinary member message: it has a channel seq, so relay
    // broadcasts it like a human's (invariant #5). Nothing here is agent-special.
    let messages = agent_messages(&su, &tenant).await;
    assert_eq!(messages.len(), 1);
    let (body, seq, props) = &messages[0];
    assert_eq!(body, "Responses 와이어로 답합니다");
    assert!(*seq > 0, "the answer took a channel_seq");
    assert_eq!(props["source"], json!("agent_worker.final_text.v0"));
    assert_eq!(props["run_id"], json!(run_id));
}

// ---------------------------------------------------------------------------
// b54b_2 — the Responses usage vocabulary reaches the ledger
// ---------------------------------------------------------------------------

/// Responses reports `input_tokens`/`output_tokens` (+ `*_tokens_details`) where
/// chat/completions reports `prompt_tokens`/`completion_tokens` (+
/// `*_tokens_details`). An adapter that copied the chat parser would find none of
/// its field names, decode zeros, and bill every subscription turn as free.
///
/// The second half is the other direction: a provider that reports **no** usage
/// must produce `was_estimated = true`, because a run nobody measured is not a
/// run that cost nothing.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54b_2_responses_usage_lands_on_every_ledger_axis() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new("rt-seeded", "at-live")).await;
    seed_oauth_link(
        &worker_pool,
        &tenant,
        &provider.base_url(),
        live_credential(&provider, "at-live"),
    )
    .await;
    let worker = build_worker(worker_config()).await;

    // --- measured turn: all four axes come off the Responses usage object ---
    let (measured_run, _) = enqueue_mention_turn(&su, &tenant, "@hermes 토큰 계산").await;
    assert_eq!(worker.drain_once().await.expect("drain").answered, 1);
    assert_eq!(
        ledger_row(&su, measured_run).await,
        LedgerRow {
            model: AGENT_MODEL.to_string(),
            prompt_tokens: 41,
            completion_tokens: 17,
            cached_tokens: 29,
            reasoning_tokens: 11,
            was_estimated: false,
        },
        "input_tokens→prompt, output_tokens→completion, and both details survive"
    );

    // --- unmeasured turn: the provider omits `usage` entirely ---
    provider.state().usage = Value::Null;
    settle_residual_worker_jobs(&su).await;
    let (unmeasured_run, _) = enqueue_mention_turn(&su, &tenant, "@hermes 사용량 없이").await;
    assert_eq!(worker.drain_once().await.expect("drain").answered, 1);
    let row = ledger_row(&su, unmeasured_run).await;
    assert!(
        row.was_estimated,
        "a turn the provider did not measure must not read as a measured zero"
    );
    assert_eq!(row.prompt_tokens, 0);
    assert_eq!(row.completion_tokens, 0);

    // Exactly one ledger row per run — the turn transaction bills once.
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE workspace_id = $1")
        .bind(tenant.workspace_id)
        .fetch_one(&su)
        .await
        .expect("count ledger rows");
    assert_eq!(rows, 2);
}

// ---------------------------------------------------------------------------
// b54b_3 — expiry → refresh → RE-SEAL, over the Responses wire
// ---------------------------------------------------------------------------

/// B5.4's central red test, re-run against the wire an OAuth link now actually
/// speaks (packet ③: "B5.4 mock을 Responses 형태로").
///
/// ## Why it goes red without the re-seal
///
/// The mock rotates the grant and refuses a spent one, exactly as ADR-0147 says a
/// real provider may. So:
///
/// * with the re-seal, turn 2 reads `rt-rotated-1` + a live access token from the
///   DB and answers with **no** second refresh;
/// * without it, the DB still holds `rt-seeded` and an expired access token. Turn
///   2 refreshes with the spent grant, the endpoint answers `invalid_grant`, and
///   the run fails.
///
/// The same revert is caught a second way: keeping the refreshed credential in
/// the in-memory cache instead of invalidating it would let turn 2 pass on RAM
/// alone, which is why the assertion below decrypts the stored ciphertext rather
/// than trusting the worker's answer.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54b_3_an_expired_token_refreshes_reseals_and_the_next_responses_turn_reuses_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new("rt-seeded", "at-never-valid")).await;

    let mut credential = OpenAiOAuthCredential::from_refresh_token("rt-seeded");
    credential.access_token = Some("at-expired".to_string());
    credential.expires_at_ms = Some(now_ms() - 1_000);
    credential.client_id = Some("client-local-cli".to_string());
    credential.token_endpoint = Some(provider.token_endpoint());
    seed_oauth_link(&worker_pool, &tenant, &provider.base_url(), credential).await;

    let worker = build_worker(worker_config()).await;

    // --- turn 1: expired → refresh → re-seal → answer on the Responses wire ---
    let (run_a, _) = enqueue_mention_turn(&su, &tenant, "@hermes 첫 턴").await;
    assert_eq!(
        worker.drain_once().await.expect("drain").answered,
        1,
        "the refreshed token answered the turn"
    );
    assert_eq!(run_status(&su, run_a).await, "succeeded");

    {
        let state = provider.state();
        assert_eq!(state.token_calls.len(), 1, "exactly one refresh");
        assert_eq!(state.token_calls[0].0, "rt-seeded");
        assert_eq!(
            state.token_calls[0].1.as_deref(),
            Some("client-local-cli"),
            "the operator's own OAuth client is what the refresh presents"
        );
        assert_eq!(state.responses_calls.len(), 1);
        assert_eq!(
            state.responses_calls[0].authorization, "Bearer at-minted-1",
            "the call used the freshly minted token, never the expired one"
        );
        assert_eq!(state.chat_completions_calls, 0);
    }

    // The re-seal itself, read straight out of the vault.
    let stored = stored_credential(&worker_pool).await;
    let oauth = stored
        .as_openai_oauth()
        .expect("the vault still holds an oauth credential");
    assert_eq!(
        oauth.refresh_token, "rt-rotated-1",
        "the ROTATED grant was re-sealed — without this the next turn holds a spent token"
    );
    assert_eq!(oauth.access_token.as_deref(), Some("at-minted-1"));
    assert!(
        oauth.expires_at_ms.unwrap_or(0) > now_ms(),
        "the re-sealed deadline is in the future"
    );

    // --- turn 2: the vault's own credential answers, with no second refresh ---
    settle_residual_worker_jobs(&su).await;
    let (run_b, _) = enqueue_mention_turn(&su, &tenant, "@hermes 둘째 턴").await;
    assert_eq!(
        worker.drain_once().await.expect("drain").answered,
        1,
        "turn 2 answered from the re-sealed credential"
    );
    assert_eq!(run_status(&su, run_b).await, "succeeded");

    let state = provider.state();
    assert_eq!(
        state.token_calls.len(),
        1,
        "turn 2 must not refresh: the re-sealed token is still live"
    );
    assert_eq!(state.responses_calls.len(), 2);
    assert_eq!(state.responses_calls[1].authorization, "Bearer at-minted-1");
}

// ---------------------------------------------------------------------------
// b54b_4 — the request body, field by field
// ---------------------------------------------------------------------------

/// The wire assertion. Every name checked here was measured twice — from the
/// shipped `@openai/codex` 0.144.1 binary and from the public SDK types (see
/// `src/responses.rs` module docs) — and each one is a field whose absence turns
/// into a 400 that reads like a model problem rather than a client bug.
///
/// It asserts the **captured** body, not the builder's return value: a unit test
/// can pass while the adapter posts something else, and the thing this batch
/// changes is precisely what goes on the socket.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54b_4_the_responses_request_carries_the_measured_wire_fields() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new("rt-seeded", "at-live")).await;
    seed_oauth_link(
        &worker_pool,
        &tenant,
        &provider.base_url(),
        live_credential(&provider, "at-live"),
    )
    .await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 와이어 확인").await;
    let worker = build_worker(worker_config()).await;
    let stats = worker.drain_once().await.expect("drain");

    // Not vacuous: the request below is one the provider actually accepted and
    // answered, not one that failed on its way out.
    assert_eq!(stats.answered, 1);
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    let state = provider.state();
    assert_eq!(state.chat_completions_calls, 0);
    assert_eq!(state.responses_calls.len(), 1);
    let call = &state.responses_calls[0];
    assert_eq!(call.path, "/v1/responses");
    let body = &call.body;

    // --- the four scalars ---
    assert_eq!(
        body["model"],
        json!(AGENT_MODEL),
        "ADR-0134 D4: the RESOLVED model is always on the payload"
    );
    assert_eq!(
        body["stream"],
        json!(true),
        "B5.4c: measured — the ChatGPT backend refuses anything else with \
         \"Stream must be set to true\""
    );
    assert_eq!(
        body["store"],
        json!(false),
        "momo's history lives in Postgres (invariant #1); it is not left on a provider"
    );
    assert!(
        body.get("max_output_tokens").is_none(),
        "max_output_tokens는 보내지 않는다 — ChatGPT 백엔드가 Unsupported parameter로 400 (2026-08-02 실측)"
    );
    assert!(
        body["instructions"]
            .as_str()
            .is_some_and(|value| value.starts_with("너는 hermes다")
                && value.contains("현재 시각:")),
        "시스템 프롬프트는 top-level instructions로 가고, B8의 현재 시각 라인이 뒤에 붙는다"
    );

    // --- the chat wire's vocabulary must be absent ---
    assert!(
        body.get("messages").is_none(),
        "a body carrying BOTH vocabularies was assembled by guessing: {body}"
    );
    assert!(body.get("max_tokens").is_none(), "{body}");

    // --- the typed input array ---
    let input = body["input"].as_array().expect("input is an array");
    assert_eq!(input.len(), 1, "one history turn, and no system item");
    assert_eq!(input[0]["type"], json!("message"));
    assert_eq!(input[0]["role"], json!("user"));
    let content = input[0]["content"]
        .as_array()
        .expect("content is an array of typed parts, not a bare string");
    assert_eq!(content.len(), 1);
    assert_eq!(
        content[0]["type"],
        json!("input_text"),
        "the measured ContentItem tag for a user turn"
    );
    assert_eq!(
        content[0]["text"],
        json!(format!("[{HUMAN_DISPLAY}] @hermes 와이어 확인")),
        "the speaker prefix L4 §6.1 requires survives the wire change"
    );

    // --- and the header the subscription needs, on this wire too ---
    assert_eq!(call.account_id.as_deref(), Some("acct-seongjae"));
}

// ---------------------------------------------------------------------------
// B5.4c — the SSE stream (packet 2026-08-02-B5.4c)
// ---------------------------------------------------------------------------

/// `outbox.status`, `attempts` and the recorded reason for one job.
async fn job_row(su: &PgPool, job_id: i64) -> (String, i32, Option<String>) {
    let row = sqlx::query(
        "SELECT status::text AS status, attempts, last_error FROM outbox WHERE id = $1",
    )
    .bind(job_id)
    .fetch_one(su)
    .await
    .expect("read outbox job");
    (
        row.get::<String, _>("status"),
        row.get::<i32, _>("attempts"),
        row.get::<Option<String>, _>("last_error"),
    )
}

/// Bring a requeued job's backoff forward so the retry is observable now.
/// The backoff itself is B5.1's and is asserted there; what this suite is about
/// is what the retry *does*.
async fn release_backoff(su: &PgPool, job_id: i64) {
    sqlx::query("UPDATE outbox SET available_at = now() WHERE id = $1")
        .bind(job_id)
        .execute(su)
        .await
        .expect("release the backoff");
}

async fn ledger_rows(su: &PgPool, run_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(su)
        .await
        .expect("count ledger rows")
}

/// **The batch's headline claim.** What the `response.output_text.delta` events
/// spelled is byte-for-byte what the channel receives — no separator, no
/// duplication, and no `U+FFFD` where a TCP chunk cut a Korean character in half
/// (the mock writes the stream 7 bytes at a time for exactly that reason).
///
/// The second half removes the safety net: the terminal event stops repeating
/// the answer in its `output[]`, so an adapter that quietly ignored the deltas
/// and read the completed payload instead has nothing left to read and fails
/// here rather than passing on a coincidence.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54c_1_the_streamed_deltas_are_exactly_the_committed_body() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let mut state = MockState::new("rt-seeded", "at-live");
    // Split so that a naive "join with a space" or "join with a newline" is
    // visible, and so the answer spans several events.
    state.reply_deltas = vec![
        "성재님".to_string(),
        ", 스트리밍".to_string(),
        "으로 답합니다".to_string(),
        " 🌊".to_string(),
    ];
    let expected = state.reply_deltas.concat();
    let provider = MockProvider::start(state).await;
    seed_oauth_link(
        &worker_pool,
        &tenant,
        &provider.base_url(),
        live_credential(&provider, "at-live"),
    )
    .await;
    let worker = build_worker(worker_config()).await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 스트리밍 확인").await;
    assert_eq!(worker.drain_once().await.expect("drain").answered, 1);
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    let messages = agent_messages(&su, &tenant).await;
    assert_eq!(messages.len(), 1, "one final message, not one per delta");
    let (body, seq, props) = &messages[0];
    assert_eq!(
        body, &expected,
        "the committed body is the concatenation of the deltas — nothing joined, \
         nothing repeated, nothing mangled at a chunk boundary"
    );
    assert!(*seq > 0, "the answer took a channel_seq like any member's");
    assert_eq!(props["source"], json!("agent_worker.final_text.v0"));

    {
        let state = provider.state();
        assert_eq!(state.chat_completions_calls, 0);
        assert_eq!(state.non_stream_rejections, 0);
        assert_eq!(state.responses_calls.len(), 1, "one turn, one round trip");
    }

    // --- the deltas alone, with the terminal event carrying no output ---
    settle_residual_worker_jobs(&su).await;
    {
        let mut state = provider.state();
        state.terminal_repeats_the_answer = false;
        state.reply_deltas = vec!["델타만".to_string(), " 있는 답".to_string()];
    }
    let (delta_only_run, _) = enqueue_mention_turn(&su, &tenant, "@hermes 델타만").await;
    assert_eq!(worker.drain_once().await.expect("drain").answered, 1);
    assert_eq!(run_status(&su, delta_only_run).await, "succeeded");
    let messages = agent_messages(&su, &tenant).await;
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1].0, "델타만 있는 답",
        "the accumulated deltas ARE the answer; the terminal payload is the auditor"
    );
}

/// `usage` exists nowhere in the stream except `response.completed`, so a turn
/// is billed from the terminal event or not at all. An adapter that stopped
/// reading at the last delta would bill every subscription turn as free.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54c_2_the_terminal_events_usage_lands_on_every_ledger_axis() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new("rt-seeded", "at-live")).await;
    seed_oauth_link(
        &worker_pool,
        &tenant,
        &provider.base_url(),
        live_credential(&provider, "at-live"),
    )
    .await;
    let worker = build_worker(worker_config()).await;

    let (measured_run, _) = enqueue_mention_turn(&su, &tenant, "@hermes 토큰 계산").await;
    assert_eq!(worker.drain_once().await.expect("drain").answered, 1);
    assert_eq!(
        ledger_row(&su, measured_run).await,
        LedgerRow {
            model: AGENT_MODEL.to_string(),
            prompt_tokens: 41,
            completion_tokens: 17,
            cached_tokens: 29,
            reasoning_tokens: 11,
            was_estimated: false,
        },
        "the counts on `response.completed` are the counts on the ledger row"
    );
    assert!(
        provider.state().responses_calls.len() == 1,
        "one call, and it was streamed"
    );

    // A terminal event with no `usage` is an unmeasured turn, not a free one.
    settle_residual_worker_jobs(&su).await;
    provider.state().usage = Value::Null;
    let (unmeasured_run, _) = enqueue_mention_turn(&su, &tenant, "@hermes 사용량 없이").await;
    assert_eq!(worker.drain_once().await.expect("drain").answered, 1);
    let row = ledger_row(&su, unmeasured_run).await;
    assert!(
        row.was_estimated,
        "a stream nobody measured is not a free run"
    );
    assert_eq!(row.prompt_tokens, 0);
    assert_eq!(row.completion_tokens, 0);
}

/// A stream that stops before `response.completed` — the provider hung up
/// mid-answer — is retried, and what the reader is left looking at meanwhile is
/// **marked**.
///
/// ## Why half an answer used to be worse than no answer, and what changed
///
/// B5.4c settled this the other way: publish nothing. Its argument was precise
/// and, at the time, correct — the deltas already received spell a real sentence
/// that simply stops, and writing it was *indistinguishable* in the channel from
/// the agent choosing to say that much. "No seq gap, no marker, nothing an
/// operator or a reader could use to tell."
///
/// ADR-0155 built the marker. A message assembled by a stream carries
/// `momo.stream`, and a stopped one carries `outcome` — so the state B5.4c
/// refused to create no longer exists: the half sentence says out loud that it
/// is one. With #1161 the in-process turn streams, which means the choice is no
/// longer between "half an answer" and "no answer" but between a marked half
/// answer and **retracting text the reader has already read** — and ADR-0155
/// rejected retraction by name (B안, tombstone), because the person watching an
/// answer stop is owed the evidence of what stopped.
///
/// So the settlement is unchanged where it was ever load-bearing — requeued with
/// a backoff, no ledger row, the run `failed` between attempts, the operator told
/// in the provider's own words — and the retry still delivers the whole answer as
/// a single message, because `body` is absolute and the second attempt re-states
/// it over the first.
///
/// The shipped Codex CLI names the same condition in its own SSE module:
/// "stream closed before response.completed".
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54c_3_a_stream_that_dies_mid_answer_is_retried_not_half_published() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let mut state = MockState::new("rt-seeded", "at-live");
    state.reply_deltas = vec!["답이 중간에".to_string(), " 끊깁니다".to_string()];
    state.truncate_after_deltas = Some(1); // one delta, then the socket closes
    let provider = MockProvider::start(state).await;
    seed_oauth_link(
        &worker_pool,
        &tenant,
        &provider.base_url(),
        live_credential(&provider, "at-live"),
    )
    .await;

    let mut config = worker_config();
    config.max_attempts = 8; // budget left, so the failure is a requeue
    let worker = build_worker(config).await;

    let (run_id, job_id) = enqueue_mention_turn(&su, &tenant, "@hermes 중간에 끊겨").await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 0);
    assert_eq!(
        stats.requeued, 1,
        "a dropped stream is an availability failure, like a timeout"
    );

    let (status, attempts, last_error) = job_row(&su, job_id).await;
    assert_eq!(status, "pending", "the turn goes back to the queue");
    assert_eq!(attempts, 1);
    let reason = last_error.unwrap_or_default();
    assert!(
        reason.contains("response.completed"),
        "the operator is told the stream ended early, in the provider's own vocabulary: {reason}"
    );
    assert!(
        !reason.contains("답이 중간에"),
        "the half answer is not smuggled into the log either: {reason}"
    );
    // ADR-0155, superseding B5.4c's "publish nothing" (see this test's header).
    let interrupted = agent_messages(&su, &tenant).await;
    assert_eq!(
        interrupted.len(),
        1,
        "the half sentence the reader was already watching is still there — and it \
         is ONE message, not a half answer plus a notice"
    );
    assert_eq!(
        interrupted[0].0, "답이 중간에",
        "frozen exactly where the socket died"
    );
    let stream: Value = sqlx::query_scalar(
        "SELECT props -> $2 FROM message WHERE workspace_id = $1 AND type = 'text' \
           AND run_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
    )
    .bind(tenant.workspace_id)
    .bind(momo_messaging::STREAM_PROPS_KEY)
    .fetch_one(&su)
    .await
    .expect("read the stream block");
    assert_eq!(
        stream["outcome"],
        json!("failed"),
        "THE assertion B5.4c could not make: the half sentence says it is one. \
         Without the mark it wears a finished answer's clothes, which is the \
         state that batch refused to create: {stream}"
    );
    assert_eq!(stream["streaming"], json!(false));
    assert_eq!(
        ledger_rows(&su, run_id).await,
        0,
        "an unfinished turn bills nothing"
    );
    assert_eq!(
        run_status(&su, run_id).await,
        "failed",
        "a run between attempts is `failed`, not `running` (B5.1, Swift :555)"
    );

    // --- the retry: the same job, answered once the provider stops dying ---
    provider.state().truncate_after_deltas = None;
    release_backoff(&su, job_id).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(
        stats.answered, 1,
        "the requeue was a real retry, not a drop"
    );
    assert_eq!(job_row(&su, job_id).await.0, "done");
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    let messages = agent_messages(&su, &tenant).await;
    assert_eq!(
        messages.len(),
        1,
        "exactly one message — the retry must not double-post"
    );
    assert_eq!(
        messages[0].0, "답이 중간에 끊깁니다",
        "the user gets the WHOLE answer, from the attempt that completed"
    );
    assert_eq!(provider.state().responses_calls.len(), 2);
}

/// The first request already streams.
///
/// NCP's live smoke reduced the ChatGPT backend's refusal to one sentence —
/// `"Stream must be set to true"` — so a non-streamed Responses request is not a
/// degraded mode, it is a 400. The mock answers exactly that sentence to any
/// request whose body does not carry `stream: true`, and counts it.
///
/// The counter staying at 0 is the whole assertion: it fails both for an adapter
/// that sends `stream: false` (B5.4b's body) and for one that "helpfully" tries
/// non-stream first and falls back to SSE — which would spend a round trip, and
/// a rate-limit slot, to be told the same thing every single turn.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54c_4_no_non_streamed_request_is_ever_sent() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new("rt-seeded", "at-live")).await;
    seed_oauth_link(
        &worker_pool,
        &tenant,
        &provider.base_url(),
        live_credential(&provider, "at-live"),
    )
    .await;
    let worker = build_worker(worker_config()).await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 스트림 필수").await;
    let stats = worker.drain_once().await.expect("drain");

    // Not vacuous: the turn below is one the provider accepted and answered.
    assert_eq!(stats.answered, 1);
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    let state = provider.state();
    assert_eq!(
        state.non_stream_rejections, 0,
        "not one request was refused with \"Stream must be set to true\""
    );
    assert_eq!(
        state.responses_calls.len(),
        1,
        "one attempt — an SSE retry after a non-stream 400 would be two"
    );
    let call = &state.responses_calls[0];
    assert_eq!(call.path, "/v1/responses");
    assert_eq!(
        call.body["stream"],
        json!(true),
        "the body asks for the stream: {}",
        call.body
    );
    assert_eq!(
        call.accept.as_deref(),
        Some("text/event-stream"),
        "and so does the HTTP layer, so a proxy cannot buffer the answer into one blob"
    );
    // The rest of the measured body is unchanged by B5.4c — B5.4b's `b54b_4`
    // owns those assertions; this one only adds the two facts above.
    assert_eq!(call.body["store"], json!(false));
    assert_eq!(state.chat_completions_calls, 0);
}
