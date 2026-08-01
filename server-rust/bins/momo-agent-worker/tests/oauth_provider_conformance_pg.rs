//! DB-backed conformance for the subscription OAuth provider (B5.4 / ADR-0147).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent-worker --test oauth_provider_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Same harness contract as `agent_worker_conformance_pg.rs` (superuser
//! `DATABASE_URL` applies the migrations + `bootstrap_roles.sql`; the worker runs
//! as the BYPASSRLS `momo_worker` role), with one addition that is the point of
//! this suite: **a real loopback HTTP server plays the provider**, serving
//! `POST /oauth/token` plus **both** provider wires.
//!
//! That server is not decoration. Substituting a `MockTokenRefresher` would leave
//! the shipped `HttpTokenRefresher` — the code that actually builds the RFC 6749
//! §6 body and decodes `invalid_grant` — untested, and every assertion below
//! would be about a fake. So both outbound seams are the real ones, and the only
//! thing replaced is *where they point*, through the per-link `token_endpoint`
//! ADR-0147 already made operator data.
//!
//! **B5.4b note.** The worker here is now built with the production provider
//! (`http_provider`), which routes on the sealed envelope kind — so an
//! `oauth-openai` link reaches `/v1/responses`, not `/v1/chat/completions`.
//! Injecting one adapter by hand, as this suite originally did, would have left
//! these four tests asserting a credential/wire pairing production no longer
//! builds. The mock therefore answers **either** path with that path's own body
//! shape, which keeps every assertion below about the credential machinery
//! (refresh, rotation, re-seal, redaction) and independent of the routing
//! decision — that decision has its own red tests in
//! `responses_adapter_conformance_pg.rs`.
//!
//! The mock **rotates refresh tokens and refuses a spent one**, which is the
//! behaviour ADR-0147 names ("refresh token 회전 시 이전 토큰 무효화는 provider
//! 동작을 따름") and the property that makes `b54_2`'s red test sharp.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b54_1_a_live_access_token_answers_without_touching_the_token_endpoint` | refresh unconditionally instead of on expiry, or stop sending `chatgpt-account-id` |
//! | `b54_2_an_expired_token_refreshes_reseals_and_the_next_turn_reuses_it` | drop `reseal_link` from `refresh_and_reseal`, or keep the refreshed credential in the in-memory cache instead of invalidating it |
//! | `b54_3_a_refused_grant_fails_the_run_with_a_relogin_message` | treat a refused grant as retryable, or reuse `degraded_provider_message` instead of `relogin_message` |
//! | `b54_4_no_vault_plaintext_reaches_a_row_a_message_or_an_error` | remove `redact_secrets` from the refresh path, or start logging/persisting the grant |

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
// harness (same contract as agent_worker_conformance_pg.rs)
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
/// from another suite would land in this one's batch. See the sibling suite's
/// module docs.
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
/// suite's link. Clearing it up front stops a leftover row from deciding this
/// test's provider.
async fn clear_provider_link(worker_pool: &PgPool) {
    sqlx::query("DELETE FROM provider_link WHERE id = true")
        .execute(worker_pool)
        .await
        .expect("clear provider_link");
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const AGENT_MODEL: &str = "hermes-agent";
const HUMAN_DISPLAY: &str = "성재";
const MASTER_KEY: &str = "b54-conformance-master-key";

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
        .bind(format!("b54-{}", &channel_id.simple().to_string()[..8]))
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

/// Seal an OAuth credential into the singleton, exactly as the operator's
/// `PUT /v1/provider/link` does — through `seal_bearer` + `upsert_link`, with no
/// test-only storage path.
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

/// Re-open the stored singleton — the assertion that proves a re-seal happened.
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

/// A worker with **both** real outbound seams: the shipped provider pair (routed
/// on the envelope kind, exactly as `main.rs` builds it) and the shipped HTTP
/// token-endpoint client.
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

async fn agent_messages(su: &PgPool, tenant: &Tenant) -> Vec<(String, Value)> {
    sqlx::query(
        "SELECT COALESCE(body, '') AS body, props FROM message \
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
    .map(|row| (row.get::<String, _>("body"), row.get::<Value, _>("props")))
    .collect()
}

async fn run_status(su: &PgPool, run_id: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run_id)
        .fetch_one(su)
        .await
        .expect("read run status")
}

async fn run_error(su: &PgPool, run_id: Uuid) -> Value {
    sqlx::query_scalar::<_, Option<Value>>("SELECT error FROM agent_run WHERE id = $1")
        .bind(run_id)
        .fetch_one(su)
        .await
        .expect("read run error")
        .unwrap_or(Value::Null)
}

async fn job_row(su: &PgPool, job_id: i64) -> (String, Option<String>) {
    let row = sqlx::query("SELECT status::text AS status, last_error FROM outbox WHERE id = $1")
        .bind(job_id)
        .fetch_one(su)
        .await
        .expect("read outbox job");
    (
        row.get::<String, _>("status"),
        row.get::<Option<String>, _>("last_error"),
    )
}

/// Every string this workspace persisted anywhere a secret could hide, plus the
/// instance-global surfaces a credential could reach.
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
    // `provider_link` carries no workspace_id. Its base_url and mode are the only
    // plaintext columns it has, and both belong in this scan: an implementation
    // that "helpfully" stored the account label or a token beside the ciphertext
    // would be caught here and nowhere else.
    let link: Vec<String> = sqlx::query_scalar("SELECT base_url || ' ' || mode FROM provider_link")
        .fetch_all(su)
        .await
        .expect("read provider_link plaintext columns");
    for row in link {
        buffer.push_str(&row);
        buffer.push('\n');
    }
    buffer
}

// ---------------------------------------------------------------------------
// the mock provider: OAuth token endpoint + OpenAI-compatible chat
// ---------------------------------------------------------------------------

struct MockState {
    /// The only grant the endpoint will accept. Rotated on every refresh, so a
    /// replayed (spent) grant is refused — ADR-0147's "이전 토큰 무효화".
    live_refresh_token: String,
    /// The only Bearer the chat endpoint will accept.
    live_access_token: String,
    /// Refuse every refresh with `invalid_grant` (the dead-grant test).
    refuse_refresh: bool,
    /// `expires_in` handed out on each refresh.
    access_token_ttl_secs: i64,
    rotations: u32,
    /// `(refresh_token, client_id)` per accepted or refused call.
    token_calls: Vec<(String, Option<String>)>,
    /// `(authorization_header, chatgpt_account_id_header)` per chat call.
    chat_calls: Vec<(String, Option<String>)>,
}

impl MockState {
    fn new(refresh_token: &str, access_token: &str) -> MockState {
        MockState {
            live_refresh_token: refresh_token.to_string(),
            live_access_token: access_token.to_string(),
            refuse_refresh: false,
            access_token_ttl_secs: 3_600,
            rotations: 0,
            token_calls: Vec::new(),
            chat_calls: Vec::new(),
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

    fn chat_base_url(&self) -> String {
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

/// One request, one response, then close. `Connection: close` keeps this a
/// request-per-connection server, which is all the suite needs and removes any
/// keep-alive framing subtlety from the assertions.
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

    let (status, payload) = if target.starts_with("/oauth/token") {
        token_response(&state, &body)
    } else if target.starts_with("/v1/chat/completions") {
        chat_response(&state, &headers, Wire::ChatCompletions)
    } else if target.starts_with("/v1/responses") {
        chat_response(&state, &headers, Wire::Responses)
    } else {
        (404, json!({"error": {"message": "no such route"}}))
    };

    let body = payload.to_string();
    let response = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.flush().await;
}

fn token_response(state: &Arc<Mutex<MockState>>, body: &str) -> (u16, Value) {
    let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let refresh_token = request["refresh_token"].as_str().unwrap_or("").to_string();
    let client_id = request["client_id"].as_str().map(str::to_string);

    let mut state = state.lock().expect("mock state");
    state
        .token_calls
        .push((refresh_token.clone(), client_id.clone()));

    // The grant type is part of the contract this suite is measuring: a body
    // that forgot it would still "work" against a lenient mock and then fail
    // against the real endpoint.
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
        // A spent grant. This is what makes b54_2's red test bite.
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

/// Which of the two wires a request arrived on. The suite's assertions are about
/// the credential, so both are accepted and answered in their own shape — see the
/// B5.4b note in the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wire {
    ChatCompletions,
    Responses,
}

const MOCK_REPLY: &str = "구독 OAuth로 답합니다";

fn chat_response(
    state: &Arc<Mutex<MockState>>,
    headers: &HashMap<String, String>,
    wire: Wire,
) -> (u16, Value) {
    let authorization = headers.get("authorization").cloned().unwrap_or_default();
    let account_id = headers.get("chatgpt-account-id").cloned();
    let mut state = state.lock().expect("mock state");
    state
        .chat_calls
        .push((authorization.clone(), account_id.clone()));

    if authorization != format!("Bearer {}", state.live_access_token) {
        return (401, json!({"error": {"message": "invalid access token"}}));
    }
    match wire {
        Wire::ChatCompletions => (
            200,
            json!({
                "choices": [{"message": {"content": MOCK_REPLY}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 5},
            }),
        ),
        Wire::Responses => (
            200,
            json!({
                "id": "resp_b54",
                "object": "response",
                "status": "completed",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": MOCK_REPLY}],
                }],
                "usage": {"input_tokens": 12, "output_tokens": 5},
            }),
        ),
    }
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
// b54_1 — the ordinary turn
// ---------------------------------------------------------------------------

/// A link holding a live access token answers with it, sends the account header,
/// and does **not** call the token endpoint.
///
/// The "no token call" assertion is the one that matters. Refreshing on every
/// turn would still produce a correct answer, so a test that only checked the
/// reply would pass — while every turn burned a rotation and the provider's
/// rate limit, on a personal subscription (ADR-0147 제약).
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54_1_a_live_access_token_answers_without_touching_the_token_endpoint() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let provider = MockProvider::start(MockState::new("rt-seeded", "at-live")).await;

    let mut credential = OpenAiOAuthCredential::from_refresh_token("rt-seeded");
    credential.access_token = Some("at-live".to_string());
    credential.expires_at_ms = Some(now_ms() + 3_600_000);
    credential.account_id = Some("acct-seongjae".to_string());
    credential.account_label = Some("성재 개인 ChatGPT 구독".to_string());
    credential.token_endpoint = Some(provider.token_endpoint());
    seed_oauth_link(&worker_pool, &tenant, &provider.chat_base_url(), credential).await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 구독으로 답해줘").await;
    let worker = build_worker(worker_config()).await;
    let stats = worker.drain_once().await.expect("drain");

    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.answered, 1, "the turn produced an answer");
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    {
        let state = provider.state();
        assert!(
            state.token_calls.is_empty(),
            "a live token must not be refreshed: {} call(s) made",
            state.token_calls.len()
        );
        assert_eq!(state.chat_calls.len(), 1);
        assert_eq!(
            state.chat_calls[0].0, "Bearer at-live",
            "the sealed access token is what authenticated the call"
        );
        assert_eq!(
            state.chat_calls[0].1.as_deref(),
            Some("acct-seongjae"),
            "chatgpt-account-id names which subscription pays for the turn"
        );
    }

    let messages = agent_messages(&su, &tenant).await;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].0, "구독 OAuth로 답합니다");

    let ledger: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM usage_ledger WHERE workspace_id = $1 AND run_id = $2",
    )
    .bind(tenant.workspace_id)
    .bind(run_id)
    .fetch_one(&su)
    .await
    .expect("read ledger");
    assert_eq!(ledger, 1, "the turn is billed exactly once");
}

// ---------------------------------------------------------------------------
// b54_2 — expiry → refresh → RE-SEAL → the next turn reuses it
// ---------------------------------------------------------------------------

/// The batch's central claim (ADR-0147 결정 2): an expired token is refreshed,
/// **the rotated grant goes back into the vault**, and the next turn works from
/// what the vault now holds.
///
/// ## Why this goes red without the re-seal
///
/// The mock rotates the grant and refuses a spent one, exactly as ADR-0147 says a
/// real provider may. So:
///
/// * with the re-seal, turn 2 reads `rt-rotated-1` + a live access token from the
///   DB and answers with **no** second refresh;
/// * without it, the DB still holds `rt-seeded` and an expired access token.
///   Turn 2 refreshes with the spent grant, the endpoint answers
///   `invalid_grant`, and the run fails.
///
/// The same revert is caught a second way: keeping the refreshed credential in
/// the in-memory cache instead of invalidating it would let turn 2 pass on RAM
/// alone, which is why the stored-ciphertext assertion below reads the DB
/// directly rather than trusting the worker's answer.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54_2_an_expired_token_refreshes_reseals_and_the_next_turn_reuses_it() {
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
    seed_oauth_link(&worker_pool, &tenant, &provider.chat_base_url(), credential).await;

    let worker = build_worker(worker_config()).await;

    // --- turn 1: expired → refresh → re-seal → answer ---
    let (run_a, _) = enqueue_mention_turn(&su, &tenant, "@hermes 첫 턴").await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 1, "the refreshed token answered the turn");
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
        assert_eq!(state.chat_calls.len(), 1);
        assert_eq!(
            state.chat_calls[0].0, "Bearer at-minted-1",
            "the call used the freshly minted token, never the expired one"
        );
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
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(
        stats.answered, 1,
        "turn 2 answered from the re-sealed credential"
    );
    assert_eq!(run_status(&su, run_b).await, "succeeded");

    let state = provider.state();
    assert_eq!(
        state.token_calls.len(),
        1,
        "turn 2 must not refresh: the re-sealed token is still live"
    );
    assert_eq!(state.chat_calls.len(), 2);
    assert_eq!(state.chat_calls[1].0, "Bearer at-minted-1");
}

// ---------------------------------------------------------------------------
// b54_3 — the grant is dead
// ---------------------------------------------------------------------------

/// ADR-0147 결정 2's other half: "갱신 실패 = run 실패 + 사용자 가시 오류(재로그인
/// 안내)".
///
/// Two things are asserted that a looser implementation would get wrong. The job
/// settles **failed rather than requeued** — a refused grant repeats identically,
/// and eight backoffs would leave the person waiting minutes for the same
/// outcome. And the channel message names the repair, because "provider error"
/// sends them to look at a provider that is working fine.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54_3_a_refused_grant_fails_the_run_with_a_relogin_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    let mut state = MockState::new("rt-seeded", "at-live");
    state.refuse_refresh = true;
    let provider = MockProvider::start(state).await;

    let mut credential = OpenAiOAuthCredential::from_refresh_token("rt-seeded");
    credential.access_token = Some("at-expired".to_string());
    credential.expires_at_ms = Some(now_ms() - 1_000);
    credential.token_endpoint = Some(provider.token_endpoint());
    seed_oauth_link(&worker_pool, &tenant, &provider.chat_base_url(), credential).await;

    let (run_id, job_id) = enqueue_mention_turn(&su, &tenant, "@hermes 만료된 계정").await;
    let worker = build_worker(worker_config()).await;
    let stats = worker.drain_once().await.expect("drain");

    assert_eq!(
        stats.failed, 1,
        "a refused grant is terminal, not a retry candidate"
    );
    assert_eq!(stats.requeued, 0);
    assert_eq!(run_status(&su, run_id).await, "failed");
    assert_eq!(
        run_error(&su, run_id).await["code"],
        json!("provider_auth_failed"),
        "ADR-0004 §Rotation's reason, distinct from a generic provider failure"
    );

    let (status, _) = job_row(&su, job_id).await;
    assert_eq!(status, "failed", "the job did not go back to pending");

    let messages = agent_messages(&su, &tenant).await;
    assert_eq!(messages.len(), 1, "the user is told, not left in silence");
    let (body, props) = &messages[0];
    assert!(
        body.contains("다시 로그인"),
        "the message names the repair: {body}"
    );
    assert!(body.contains("AI 연결"), "…and where to do it: {body}");
    // goal B8 H2 moved the provider's own words off the timeline. A refused
    // grant answers with a body that can quote the token it refused, so this
    // assertion is inverted on purpose: the channel must NOT carry it.
    assert!(
        !body.contains("invalid_grant"),
        "the provider's raw refusal stays off the channel: {body}"
    );
    assert!(
        run_error(&su, run_id).await["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("invalid_grant"),
        "…and is kept on the run record instead"
    );
    assert!(
        props.get("error").is_none(),
        "…and not in the props the relay broadcasts: {props}"
    );
    assert_eq!(
        props["source"],
        json!("agent_worker.provider_auth_failure.v0"),
        "a client can branch on this without matching Korean prose"
    );
    assert_eq!(props["error_code"], json!("provider_auth_failed"));

    // The chat endpoint was never dialled: there was no credential to dial it
    // with, and calling it anyway would have spent a request to learn that.
    assert!(provider.state().chat_calls.is_empty());
}

// ---------------------------------------------------------------------------
// b54_4 — nothing from the vault reaches anything durable
// ---------------------------------------------------------------------------

/// ADR-0004 Rules #2/#5 under the widened ADR-0147 contents: the grant, the
/// rotated grant, and both access tokens exist on the request boundary and in the
/// sealed box, and nowhere else.
///
/// The test proves it is not vacuous first — the worker really resolved the
/// vault, really refreshed, and really re-sealed — and only then scans. A worker
/// that quietly fell back to the env bearer would pass a naive "the secret is
/// absent" scan while doing nothing this ADR describes.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b54_4_no_vault_plaintext_reaches_a_row_a_message_or_an_error() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = momo_worker_pool().await;
    settle_residual_worker_jobs(&su).await;
    clear_provider_link(&worker_pool).await;
    let tenant = seed_tenant(&su).await;

    const SEEDED_GRANT: &str = "rt-b54-vault-only-grant";
    const SEEDED_ACCESS: &str = "at-b54-vault-only-access";

    let provider = MockProvider::start(MockState::new(SEEDED_GRANT, "at-unused")).await;

    let mut credential = OpenAiOAuthCredential::from_refresh_token(SEEDED_GRANT);
    credential.access_token = Some(SEEDED_ACCESS.to_string());
    // Expired, so this turn exercises the refresh path too — the one that
    // handles the most secret material in the shortest window.
    credential.expires_at_ms = Some(now_ms() - 1_000);
    credential.account_id = Some("acct-b54".to_string());
    credential.token_endpoint = Some(provider.token_endpoint());
    seed_oauth_link(&worker_pool, &tenant, &provider.chat_base_url(), credential).await;

    let (run_id, _) = enqueue_mention_turn(&su, &tenant, "@hermes 금고 확인").await;
    let worker = build_worker(worker_config()).await;
    let stats = worker.drain_once().await.expect("drain");

    // --- not vacuous: the vault was opened, refreshed, and written back ---
    assert_eq!(stats.answered, 1);
    assert_eq!(run_status(&su, run_id).await, "succeeded");
    {
        let state = provider.state();
        assert_eq!(
            state.token_calls[0].0, SEEDED_GRANT,
            "the sealed grant is what the refresh presented — otherwise this test proves nothing"
        );
        assert_eq!(state.chat_calls[0].0, "Bearer at-minted-1");
    }
    let stored = stored_credential(&worker_pool).await;
    assert_eq!(
        stored
            .as_openai_oauth()
            .expect("oauth credential")
            .refresh_token,
        "rt-rotated-1"
    );

    // --- the scan ---
    let persisted = all_persisted_text(&su, &tenant).await;
    for secret in [
        SEEDED_GRANT,
        SEEDED_ACCESS,
        "rt-rotated-1",
        "at-minted-1",
        MASTER_KEY,
    ] {
        assert!(
            !persisted.contains(secret),
            "vault material `{secret}` reached a durable row"
        );
    }

    // The ciphertext is the ONLY place any of it may live. Assert it is still
    // there, so the scan cannot pass by the link having been wiped.
    let sealed_len: i32 =
        sqlx::query_scalar("SELECT octet_length(bearer_ciphertext) FROM provider_link WHERE id")
            .fetch_one(&su)
            .await
            .expect("read the sealed credential");
    assert!(
        sealed_len > 28,
        "the sealed credential is still stored (version + nonce + tag is 29 bytes of framing)"
    );
}
