//! #4079 L-S2 — 운영자 전용 로그인 중계 API와 「토큰 0바이트」 경계 (ADR-0203 증보 2026-10-19 L4, ADR-0004 증보 7).
//!
//! Real Axum router on a `momo_app` (NOBYPASSRLS) pool, the real `GuardedLoginRelay` client, and a loopback
//! **mock sidecar** that plays `infra/hermes/login_relay.py` (key check, `X-Operator` ownership, state check,
//! one-shot paste) and keeps its own "volume" of mock tokens. The co-hosted agent is created through the real
//! `connect` route (a loopback mock Hermes), so the owner / `operator_env` pin the routes check are real rows.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `markers_never_cross_oort_in_any_channel` | red proofs 1 + 2: after Claude (paste), Codex (device) and MCP-app logins, the marker code and the mock tokens are in **0** places of: every response body, the api log at TRACE (with the request struct `debug!`-ed), a dump of every table, the audit rows; the device code and the authorization URL are in the start response **only**. Positive controls: the sidecar received the pasted bytes unchanged and holds the tokens; the log carries the masked request line | `Pasted` is a `String` (the log line prints it), any code path that stores / logs / audits / echoes the pasted value, the device code or the URL |
//! | `only_the_instance_operator_reaches_the_relay_routes` | non-operator 403 on all ten routes with the sidecar untouched; relay off → `409 login_relay_off`; an agent the caller does not own / that is not pinned `operator_env` is refused | the operator gate, the off switch, the owner / pin checks |
//! | `an_app_login_needs_one_person_and_a_sole_pinned_hermes` | a second active person → `409 connector_trial_members`, another agent pinned to the same Hermes → `409 connector_trial_shared`, the sidecar untouched; one person → 200 | the K2 rules on the app family |
//! | `a_refused_paste_and_malformed_ids_surface_fixed_errors` | state mismatch → 400 with no echo of the pasted value; newline / empty / oversize / unknown-field bodies 400 before the sidecar; a login id that is not the sidecar's shape → 404; the second `complete` → 409; another operator cannot reach the login | the shape checks, the error mapping, the operator header |
//! | `starts_are_throttled_and_every_call_leaves_one_closed_audit_line` | the 7th start in a minute is 429 with no sidecar call; audit detail holds only `kind/target/result` | the throttle, the audit shape |
//!
//! Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo PGHOST=127.0.0.1 PGPORT=<port> \
//!   PGUSER=momo PGPASSWORD=momo PGDATABASE=momo \
//!   cargo test -p momo-server --test login_relay_conformance_pg -- --ignored --test-threads=1
//! ```

use std::collections::HashMap;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_provider_probe::{GuardedLoginRelay, GuardedProviderProbe};
use momo_server::config::{CohostedAgentConfig, LoginRelayConfig, SettingsConfig};
use momo_server::{build_app, AppState};
use momo_settings::{EgressPolicy, ProviderConfig, ProviderMode};
use serde_json::{json, Value};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "login-relay-conformance-app-signing-secret";
const TEST_PROVIDER_MASTER_KEY: &str = "login-relay-conformance-provider-master-key";
const TEST_PASSWORD: &str = "login-relay-conformance-password";
const HERMES_KEY: &str = "sk-hermes-chat-key-4079-0002";
const RELAY_KEY: &str = "relay-key-4079-0123456789abcdef0123456789abcdef";
/// The one-time authorization code the operator pastes. Must be in 0 places after the login.
const MARKER_CODE: &str = "MARKER-CODE-4079-7f3a91";
/// What the sidecar's "vendor exchange" writes to its own volume. Must never reach oort.
const MOCK_ACCESS: &str = "MOCK-ACCESS-TOKEN-4079";
const MOCK_REFRESH: &str = "MOCK-REFRESH-TOKEN-4079";
/// The Codex device code: in the start response only.
const DEVICE_CODE: &str = "DEV4-9X7K";
/// Inside every authorization URL the mock hands out: in the start response only.
/// What the mock sidecar says the login time was (a fixed clock reading, 2025-10).
const MOCK_ISSUED_AT: i64 = 1_760_000_000;
const URL_MARKER: &str = "MOCKURL4079";
const MOCK_STATE: &str = "MOCKSTATE4079";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
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
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

struct Fixture {
    workspace: Uuid,
    email: String,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, hint: &str) -> (Uuid, String) {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    let email = format!("{member}@{hint}.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    (member, email)
}

/// One workspace with one verified-email owner.
async fn seed(su: &PgPool, slug_hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let (_owner, email) = seed_human(su, workspace, "owner", slug_hint).await;
    Fixture { workspace, email }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

// ---------------------------------------------------------------------------
// the mock co-hosted Hermes (for `connect`) and the mock login relay sidecar
// ---------------------------------------------------------------------------

fn chrono_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn mock_hermes() -> u16 {
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"status": "ok"})) }))
        .route(
            "/v1/models",
            get(|| async { Json(json!({"object": "list", "data": [{"id": "hermes-agent"}]})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

struct MockLogin {
    operator: String,
    kind: String,
    target: String,
    mode: &'static str,
    submitted: bool,
    polls: u32,
}

#[derive(Default)]
struct MockRelay {
    logins: Mutex<HashMap<String, MockLogin>>,
    /// "METHOD /path" of every request that reached the sidecar (any key).
    requests: Mutex<Vec<String>>,
    /// Every `pasted` value the sidecar received (the positive control: it is forwarded unchanged).
    received: Mutex<Vec<String>>,
    /// The sidecar's own volume: tokens live here and nowhere else.
    tokens: Mutex<Vec<String>>,
    /// The operator label of every request (`X-Operator`, or the start body's `operator`).
    labels: Mutex<Vec<String>>,
    next: Mutex<u64>,
}

impl MockRelay {
    fn reached(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

type Shared = Arc<MockRelay>;

fn relay_authed(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {RELAY_KEY}"))
}

fn relay_error(status: StatusCode, code: &str) -> axum::response::Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

async fn mock_start(
    State(m): State<Shared>,
    headers: HeaderMap,
    Json(b): Json<Value>,
) -> axum::response::Response {
    m.requests.lock().unwrap().push("POST /v1/login".into());
    if !relay_authed(&headers) {
        return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let (kind, target) = (
        b["kind"].as_str().unwrap_or("").to_string(),
        b["target"].as_str().unwrap_or("").to_string(),
    );
    let operator = b["operator"].as_str().unwrap_or("").to_string();
    m.labels.lock().unwrap().push(operator.clone());
    let mut next = m.next.lock().unwrap();
    *next += 1;
    let login_id = format!("LOGIN{:011}-mockrelay", *next);
    let (mode, url) = match (kind.as_str(), target.as_str()) {
        ("provider", "openai-codex") => (
            "device",
            format!("https://auth.openai.com/codex/device?{URL_MARKER}"),
        ),
        ("provider", _) => (
            "paste",
            format!("https://claude.ai/oauth/authorize?state={MOCK_STATE}&{URL_MARKER}"),
        ),
        _ => (
            "paste",
            format!("https://mock-mcp.example/authorize?state={MOCK_STATE}&{URL_MARKER}"),
        ),
    };
    m.logins.lock().unwrap().insert(
        login_id.clone(),
        MockLogin {
            operator,
            kind,
            target,
            mode,
            submitted: false,
            polls: 0,
        },
    );
    let mut out =
        json!({"login_id": login_id, "mode": mode, "url": url, "expires_at": 1_900_000_000_i64});
    if mode == "device" {
        out["user_code"] = json!(DEVICE_CODE);
    }
    Json(out).into_response()
}

async fn mock_complete(
    State(m): State<Shared>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(b): Json<Value>,
) -> axum::response::Response {
    m.requests
        .lock()
        .unwrap()
        .push("POST /v1/login/{id}/complete".into());
    m.labels
        .lock()
        .unwrap()
        .push(header(&headers, "x-operator"));
    if !relay_authed(&headers) {
        return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let mut logins = m.logins.lock().unwrap();
    let Some(login) = logins.get_mut(&id) else {
        return relay_error(StatusCode::NOT_FOUND, "not_found");
    };
    if login.operator != header(&headers, "x-operator") {
        return relay_error(StatusCode::FORBIDDEN, "operator_mismatch");
    }
    if login.mode != "paste" {
        return relay_error(StatusCode::CONFLICT, "not_paste_mode");
    }
    if login.submitted {
        return relay_error(StatusCode::CONFLICT, "already_submitted");
    }
    let pasted = b["pasted"].as_str().unwrap_or("").to_string();
    if !pasted.contains(MOCK_STATE) {
        // An error body that echoes the request: oort must not forward a word of it.
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "state_mismatch", "detail": format!("got {pasted}")})),
        )
            .into_response();
    }
    login.submitted = true;
    m.received.lock().unwrap().push(pasted);
    // The "vendor exchange": the tokens land on the sidecar's volume, never in a response.
    m.tokens
        .lock()
        .unwrap()
        .extend([MOCK_ACCESS.to_string(), MOCK_REFRESH.to_string()]);
    Json(json!({"status": "submitted"})).into_response()
}

async fn mock_poll(
    State(m): State<Shared>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    m.requests.lock().unwrap().push("GET /v1/login/{id}".into());
    m.labels
        .lock()
        .unwrap()
        .push(header(&headers, "x-operator"));
    if !relay_authed(&headers) {
        return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let mut logins = m.logins.lock().unwrap();
    let Some(login) = logins.get_mut(&id) else {
        return relay_error(StatusCode::NOT_FOUND, "not_found");
    };
    if login.operator != header(&headers, "x-operator") {
        return relay_error(StatusCode::FORBIDDEN, "operator_mismatch");
    }
    login.polls += 1;
    let done = login.submitted || (login.mode == "device" && login.polls >= 2);
    if login.mode == "device" && done && login.polls == 2 {
        m.tokens
            .lock()
            .unwrap()
            .extend([MOCK_ACCESS.to_string(), MOCK_REFRESH.to_string()]);
    }
    Json(json!({"status": if done { "done" } else { "pending" }})).into_response()
}

async fn mock_cancel(
    State(m): State<Shared>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    m.requests
        .lock()
        .unwrap()
        .push("DELETE /v1/login/{id}".into());
    m.labels
        .lock()
        .unwrap()
        .push(header(&headers, "x-operator"));
    if !relay_authed(&headers) {
        return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let logins = m.logins.lock().unwrap();
    match logins.get(&id) {
        None => relay_error(StatusCode::NOT_FOUND, "not_found"),
        Some(l) if l.operator != header(&headers, "x-operator") => {
            relay_error(StatusCode::FORBIDDEN, "operator_mismatch")
        }
        Some(_) => Json(json!({"status": "cancelled"})).into_response(),
    }
}

async fn mock_status(State(m): State<Shared>, headers: HeaderMap) -> axum::response::Response {
    m.requests.lock().unwrap().push("GET /v1/status".into());
    if !relay_authed(&headers) {
        return relay_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let connected = !m.tokens.lock().unwrap().is_empty();
    Json(json!({"targets": [
        {"kind": "provider", "target": "openai-codex", "connected": connected},
        {"kind": "provider", "target": "anthropic", "connected": connected},
        {"kind": "mcp", "target": "gmail", "connected": connected, "estimated": {
            "basis": "relay_observed_login",
            "issuedAt": MOCK_ISSUED_AT,
            // A sidecar that put anything else here (a token, a code, a log line) must not get it past oort.
            "note": MARKER_CODE,
            "token": MOCK_ACCESS,
        }},
    ]}))
    .into_response()
}

async fn mock_relay() -> (u16, Shared) {
    let m: Shared = Arc::default();
    let app = Router::new()
        .route("/v1/login", post(mock_start))
        .route("/v1/login/{id}", get(mock_poll))
        .route("/v1/login/{id}", delete(mock_cancel))
        .route("/v1/login/{id}/complete", post(mock_complete))
        .route("/v1/status", get(mock_status))
        .with_state(m.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, m)
}

// ---------------------------------------------------------------------------
// server + client plumbing
// ---------------------------------------------------------------------------

struct Declared<'a> {
    operator_email: &'a str,
    /// More listed instance operators (PLATFORM_ADMIN_EMAILS), for the two-operator proofs.
    other_operators: Vec<String>,
    /// The Docker harness' mock authorization server is plain `http://127.0.0.1`.
    loopback_http_urls: bool,
    hermes_port: u16,
    /// `None` = the relay is not configured (off).
    relay_url: Option<String>,
    relay_key: &'a str,
    /// `HERMES_APP_LOGIN_GOOGLE_PUBLISHING=testing`: the operator declares the Google OAuth project External + Testing.
    google_testing: bool,
}

async fn start_server(pool: PgPool, d: Declared<'_>) -> String {
    let local_policy = || EgressPolicy {
        allow_local: true,
        local_hosts: Vec::new(),
        operator_hosts: Vec::new(),
    };
    let relay_config = match d.relay_url {
        Some(url) => LoginRelayConfig::new(url, d.relay_key).with_google_testing(d.google_testing),
        None => LoginRelayConfig::default(),
    };
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(TEST_PROVIDER_MASTER_KEY.to_string()),
        env_provider: ProviderConfig {
            mode: ProviderMode::ExternalHermes,
            base_url: format!("http://127.0.0.1:{}/v1", d.hermes_port),
            bearer: HERMES_KEY.to_string(),
            allow_local_loopback: true,
        },
        platform_admin_emails: std::iter::once(d.operator_email)
            .chain(d.other_operators.iter().map(String::as_str))
            .map(str::to_ascii_lowercase)
            .collect(),
        environment: "local".to_string(),
    })
    .with_cohosted(
        CohostedAgentConfig {
            declared: true,
            tools_locked: true,
            ..Default::default()
        },
        Arc::new(GuardedProviderProbe::new(
            local_policy(),
            std::time::Duration::from_secs(5),
        )),
    )
    .with_login_relay(
        relay_config,
        Arc::new(
            GuardedLoginRelay::new(local_policy(), std::time::Duration::from_secs(10))
                .with_loopback_http_urls(d.loopback_http_urls),
        ),
    );
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

/// Every response body this test ever saw (success and error), for the zero-byte scan.
#[derive(Default)]
struct Seen(Mutex<Vec<String>>);

struct Api<'a> {
    http: &'a reqwest::Client,
    base: &'a str,
    workspace: Uuid,
    seen: &'a Seen,
}

struct Reply {
    code: u16,
    body: Value,
    text: String,
    no_store: bool,
}

impl Api<'_> {
    fn url(&self, agent: Uuid, tail: &str) -> String {
        format!(
            "{}/v1/workspaces/{}/agents/{agent}/{tail}",
            self.base, self.workspace
        )
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Reply {
        let r = req.send().await.unwrap();
        let code = r.status().as_u16();
        let no_store = r
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("no-store"));
        let text = r.text().await.unwrap();
        self.seen.0.lock().unwrap().push(text.clone());
        Reply {
            code,
            body: serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
            no_store,
        }
    }

    async fn get(&self, token: &str, agent: Uuid, tail: &str) -> Reply {
        self.send(self.http.get(self.url(agent, tail)).bearer_auth(token))
            .await
    }

    async fn post_raw(&self, token: &str, agent: Uuid, tail: &str, body: &str) -> Reply {
        self.send(
            self.http
                .post(self.url(agent, tail))
                .bearer_auth(token)
                .header("content-type", "application/json")
                .body(body.to_string()),
        )
        .await
    }

    async fn post(&self, token: &str, agent: Uuid, tail: &str, body: Value) -> Reply {
        self.post_raw(token, agent, tail, &body.to_string()).await
    }

    async fn delete(&self, token: &str, agent: Uuid, tail: &str) -> Reply {
        self.send(self.http.delete(self.url(agent, tail)).bearer_auth(token))
            .await
    }

    /// The real `connect` route: a member + the `operator_env` pin. Returns the agent id.
    async fn connect_hermes(&self, token: &str, name: &str, handle: &str) -> Uuid {
        let r = self
            .send(
                self.http
                    .post(format!(
                        "{}/v1/workspaces/{}/cohosted-agent/connect",
                        self.base, self.workspace
                    ))
                    .bearer_auth(token)
                    .json(&json!({"displayName": name, "handle": handle})),
            )
            .await;
        assert_eq!(r.code, 201, "{}", r.text);
        r.body["agentId"].as_str().unwrap().parse().unwrap()
    }
}

#[derive(Clone)]
struct BufferWriter(Arc<Mutex<Vec<u8>>>);

impl Write for BufferWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for BufferWriter {
    type Writer = BufferWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Every row of every base table in `public`, as text — the "DB dump" of the zero-byte proof.
async fn db_dump(su: &PgPool) -> String {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables \
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
    )
    .fetch_all(su)
    .await
    .unwrap();
    let mut out = String::new();
    for table in tables {
        let rows: Vec<String> = sqlx::query_scalar(&format!("SELECT t::text FROM \"{table}\" t"))
            .fetch_all(su)
            .await
            .unwrap_or_default();
        for row in rows {
            out.push_str(&row);
            out.push('\n');
        }
    }
    out
}

async fn audit_rows(su: &PgPool, workspace: Uuid) -> Vec<(String, Value)> {
    sqlx::query_as::<_, (String, Value)>(
        "SELECT action, detail FROM audit_log WHERE workspace_id = $1 AND action LIKE 'agent.%\\_login.%' ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .unwrap()
}

struct World {
    /// A second listed instance operator in the same workspace, when asked for: (member id, email).
    second: Option<(Uuid, String)>,
    su: PgPool,
    f: Fixture,
    base: String,
    http: reqwest::Client,
    op: String,
    relay: Shared,
    agent: Uuid,
    seen: Seen,
}

async fn world(slug: &str, relay_on: bool) -> World {
    world_with(slug, relay_on, false).await
}

async fn world_with(slug: &str, relay_on: bool, second_operator: bool) -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, slug).await;
    let second = if second_operator {
        Some(seed_human(&su, f.workspace, "admin", "relay-op2").await)
    } else {
        None
    };
    let hermes_port = mock_hermes().await;
    let (relay_port, relay) = mock_relay().await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            other_operators: second.iter().map(|(_, email)| email.clone()).collect(),
            loopback_http_urls: false,
            hermes_port,
            relay_url: relay_on.then(|| format!("http://127.0.0.1:{relay_port}")),
            relay_key: RELAY_KEY,
            google_testing: true,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let op = login(&http, &base, f.workspace, &f.email).await;
    let seen = Seen::default();
    let agent = {
        let api = Api {
            http: &http,
            base: &base,
            workspace: f.workspace,
            seen: &seen,
        };
        api.connect_hermes(&op, "Hermes", "hermes").await
    };
    World {
        second,
        su,
        f,
        base,
        http,
        op,
        relay,
        agent,
        seen,
    }
}

impl World {
    fn api(&self) -> Api<'_> {
        Api {
            http: &self.http,
            base: &self.base,
            workspace: self.f.workspace,
            seen: &self.seen,
        }
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn markers_never_cross_oort_in_any_channel() {
    ensure_schema_and_roles();
    let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
    let _guard = tracing_subscriber::fmt()
        .with_writer(BufferWriter(logs.clone()))
        .with_max_level(tracing::Level::TRACE)
        .set_default();
    let w = world("login-relay-markers", true).await;
    let api = w.api();

    // --- Claude: open the URL, paste `code#state` ---
    let start = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"}),
        )
        .await;
    assert_eq!(start.code, 200, "{}", start.text);
    assert!(start.no_store, "the start response must be no-store");
    assert_eq!(start.body["mode"], "paste");
    assert!(start.body["url"].as_str().unwrap().contains(URL_MARKER));
    let claude = start.body["loginId"].as_str().unwrap().to_string();
    let pasted = format!("{MARKER_CODE}#{MOCK_STATE}");
    let done = api
        .post(
            &w.op,
            w.agent,
            &format!("model-login/{claude}/complete"),
            json!({"pasted": pasted}),
        )
        .await;
    assert_eq!(
        (done.code, done.body["status"].as_str()),
        (200, Some("submitted")),
        "{}",
        done.text
    );
    let poll = api
        .get(&w.op, w.agent, &format!("model-login/{claude}"))
        .await;
    assert_eq!(
        (poll.code, poll.body["status"].as_str()),
        (200, Some("done"))
    );
    assert!(poll.no_store);

    // --- Codex: a device code, polled to the end ---
    let start = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "openai-codex"}),
        )
        .await;
    assert_eq!(start.code, 200, "{}", start.text);
    assert_eq!(
        (start.body["mode"].as_str(), start.body["userCode"].as_str()),
        (Some("device"), Some(DEVICE_CODE))
    );
    let codex = start.body["loginId"].as_str().unwrap().to_string();
    let first = api
        .get(&w.op, w.agent, &format!("model-login/{codex}"))
        .await;
    assert_eq!(first.body["status"], "pending");
    let second = api
        .get(&w.op, w.agent, &format!("model-login/{codex}"))
        .await;
    assert_eq!(second.body["status"], "done");

    // --- an MCP app, pasted back as the address-bar URL ---
    let start = api
        .post(&w.op, w.agent, "app-login", json!({"app": "gmail"}))
        .await;
    assert_eq!(start.code, 200, "{}", start.text);
    let app_login = start.body["loginId"].as_str().unwrap().to_string();
    let app_paste =
        format!("http://127.0.0.1:27890/callback?code={MARKER_CODE}&state={MOCK_STATE}");
    let done = api
        .post(
            &w.op,
            w.agent,
            &format!("app-login/{app_login}/complete"),
            json!({"pasted": app_paste}),
        )
        .await;
    assert_eq!(done.code, 200, "{}", done.text);

    // --- a cancel, a status read ---
    let again = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"}),
        )
        .await;
    let cancelled = api
        .delete(
            &w.op,
            w.agent,
            &format!("model-login/{}", again.body["loginId"].as_str().unwrap()),
        )
        .await;
    assert_eq!(cancelled.body["status"], "cancelled");
    let targets = api.get(&w.op, w.agent, "model-login").await;
    assert_eq!(targets.code, 200, "{}", targets.text);
    assert_eq!(
        targets.body["targets"].as_array().unwrap().len(),
        2,
        "model-login lists the providers only"
    );
    assert!(targets.no_store);
    // The app list carries the estimate: allow-listed words and clock readings, never what the sidecar tacked on.
    let apps = api.get(&w.op, w.agent, "app-login").await;
    assert_eq!(apps.code, 200, "{}", apps.text);
    assert_eq!(
        apps.body["targets"],
        json!([{
            "target": "gmail",
            "connected": true,
            "estimated": {
                "basis": "relay_observed_login",
                "issuedAt": MOCK_ISSUED_AT,
                "testMode": true,
                "expiresAt": MOCK_ISSUED_AT + 604_800,
                "note": "google_testing_refresh_7d"
            }
        }]),
        "{}",
        apps.text
    );
    assert!(apps.no_store);
    // A provider list never carries one.
    assert!(targets.body["targets"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t.get("estimated").is_none()));

    // --- positive controls: the flows really ran ---
    assert_eq!(
        w.relay.received.lock().unwrap().clone(),
        vec![pasted.clone(), app_paste.clone()],
        "the sidecar must receive the pasted bytes unchanged"
    );
    assert!(
        w.relay
            .tokens
            .lock()
            .unwrap()
            .contains(&MOCK_ACCESS.to_string()),
        "the tokens are on the sidecar's volume"
    );
    let log_text = String::from_utf8_lossy(&logs.lock().unwrap()).to_string();
    assert!(
        log_text.contains("login relay complete requested") && log_text.contains("<redacted>"),
        "positive control: the request struct was logged, masked"
    );

    // --- the zero-byte scan ---
    let responses = w.seen.0.lock().unwrap().join("\n");
    let dump = db_dump(&w.su).await;
    let audit = audit_rows(&w.su, w.f.workspace).await;
    let audit_text = serde_json::to_string(&audit).unwrap();
    for (what, text) in [
        ("a response body", &responses),
        ("the api log (TRACE)", &log_text),
        ("a table dump", &dump),
        ("the audit rows", &audit_text),
    ] {
        for marker in [MARKER_CODE, MOCK_ACCESS, MOCK_REFRESH] {
            assert!(!text.contains(marker), "{marker} reached {what}");
        }
    }
    // The device code and the authorization URL are for the screen once: the start response, nothing else.
    for (what, text) in [
        ("the api log", &log_text),
        ("a table dump", &dump),
        ("the audit rows", &audit_text),
    ] {
        for marker in [DEVICE_CODE, URL_MARKER] {
            assert!(!text.contains(marker), "{marker} reached {what}");
        }
    }
    let hits = |needle: &str| {
        w.seen
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b.contains(needle))
            .count()
    };
    assert_eq!(
        hits(DEVICE_CODE),
        1,
        "the device code is in exactly the one start response"
    );
    assert_eq!(
        hits(URL_MARKER),
        4,
        "each authorization URL is in exactly its own start response"
    );
    for login in [&claude, &codex, &app_login] {
        assert!(
            !dump.contains(login.as_str()) && !audit_text.contains(login.as_str()),
            "a login id was stored"
        );
    }
    // Nothing new was stored for the login: one closed audit line per step, no table of its own.
    let actions: Vec<&str> = audit.iter().map(|(a, _)| a.as_str()).collect();
    assert!(
        actions.contains(&"agent.model_login.started")
            && actions.contains(&"agent.app_login.started"),
        "{actions:?}"
    );
    assert!(
        actions.contains(&"agent.model_login.submitted")
            && actions.contains(&"agent.model_login.cancelled"),
        "{actions:?}"
    );
    for (_, detail) in &audit {
        let keys: std::collections::BTreeSet<&str> = detail
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(
            keys.is_subset(&["schema", "kind", "target", "result"].into_iter().collect()),
            "audit detail grew a field: {detail}"
        );
    }
}

/// The same boundary, but against the REAL sidecar (`infra/hermes/login_relay.py`) running the real `hermes mcp
/// login` / `mcp_login_probe.py` against a mock OAuth MCP inside the Hermes image. Driven by
/// `scripts/tests/test_login_relay_oort_e2e.sh`, which publishes the sidecar on loopback and sets
/// `LOGIN_RELAY_E2E_URL` / `LOGIN_RELAY_E2E_KEY`; skipped when they are absent.
#[tokio::test]
#[ignore = "needs the Docker harness scripts/tests/test_login_relay_oort_e2e.sh"]
async fn the_real_sidecar_logs_an_app_in_and_no_secret_crosses_oort() {
    let (Ok(url), Ok(key)) = (
        std::env::var("LOGIN_RELAY_E2E_URL"),
        std::env::var("LOGIN_RELAY_E2E_KEY"),
    ) else {
        eprintln!("LOGIN_RELAY_E2E_URL / LOGIN_RELAY_E2E_KEY not set: skipped");
        return;
    };
    ensure_schema_and_roles();
    let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
    let _guard = tracing_subscriber::fmt()
        .with_writer(BufferWriter(logs.clone()))
        .with_max_level(tracing::Level::TRACE)
        .set_default();
    let su = superuser_pool().await;
    let f = seed(&su, "login-relay-e2e").await;
    let hermes_port = mock_hermes().await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            other_operators: Vec::new(),
            loopback_http_urls: true,
            hermes_port,
            relay_url: Some(url),
            relay_key: &key,
            google_testing: true,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let op = login(&http, &base, f.workspace, &f.email).await;
    let seen = Seen::default();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
        seen: &seen,
    };
    let agent = api.connect_hermes(&op, "Hermes", "hermes").await;
    let marker = format!("MARKER-CODE-e2e-{}", Uuid::new_v4().simple());
    let mut finished = Vec::new();
    for app in ["mock", "gmail"] {
        let start = api.post(&op, agent, "app-login", json!({"app": app})).await;
        assert_eq!(start.code, 200, "{app}: {}", start.text);
        assert_eq!(start.body["mode"], "paste");
        let authorize = reqwest::Url::parse(start.body["url"].as_str().unwrap()).unwrap();
        let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
        let pasted = format!(
            "{}?code={marker}&state={}",
            query["redirect_uri"], query["state"]
        );
        let id = start.body["loginId"].as_str().unwrap().to_string();
        if app == "gmail" {
            // #4081 redirect_uri: the pinned Google loopback address survives Hermes -> sidecar -> oort unchanged,
            // and a paste that names any other port / host is refused (fixed text, nothing reaches the child).
            assert_eq!(
                query["redirect_uri"], "http://127.0.0.1:41821/callback",
                "the authorization URL's redirect_uri"
            );
            for other in [
                "http://127.0.0.1:41822/callback",
                "http://localhost:41821/callback",
            ] {
                let wrong = format!("{other}?code={marker}&state={}", query["state"]);
                let refused = api
                    .post(
                        &op,
                        agent,
                        &format!("app-login/{id}/complete"),
                        json!({"pasted": wrong}),
                    )
                    .await;
                assert_eq!(
                    (refused.code, refused.body["error"]["code"].as_str()),
                    (400, Some("redirect_mismatch")),
                    "{other}: {}",
                    refused.text
                );
            }
        }
        let done = api
            .post(
                &op,
                agent,
                &format!("app-login/{id}/complete"),
                json!({"pasted": pasted}),
            )
            .await;
        assert_eq!(
            (done.code, done.body["status"].as_str()),
            (200, Some("submitted")),
            "{app}: {}",
            done.text
        );
        let mut status = String::new();
        for _ in 0..60 {
            let poll = api.get(&op, agent, &format!("app-login/{id}")).await;
            status = poll.body["status"].as_str().unwrap_or("").to_string();
            if status != "pending" && status != "submitted" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        assert_eq!(status, "done", "{app} login did not finish");
        finished.push(app);
    }
    // Real vendor URLs (one outbound call to auth.openai.com for the Codex device code; NOTHING is approved):
    // skipped with LOGIN_RELAY_E2E_NO_VENDOR=1.
    let mut screen_only: Vec<String> = Vec::new();
    if std::env::var("LOGIN_RELAY_E2E_NO_VENDOR").is_err() {
        let codex = api
            .post(
                &op,
                agent,
                "model-login",
                json!({"provider": "openai-codex"}),
            )
            .await;
        assert_eq!(codex.code, 200, "{}", codex.text);
        assert_eq!(codex.body["mode"], "device");
        let code = codex.body["userCode"].as_str().unwrap().to_string();
        assert!(
            code.len() >= 9
                && code.contains('-')
                && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "device code shape"
        );
        assert_eq!(
            reqwest::Url::parse(codex.body["url"].as_str().unwrap())
                .unwrap()
                .host_str(),
            Some("auth.openai.com")
        );
        let codex_id = codex.body["loginId"].as_str().unwrap().to_string();
        let pending = api
            .get(&op, agent, &format!("model-login/{codex_id}"))
            .await;
        assert_eq!(pending.body["status"], "pending");
        assert!(
            !pending.text.contains(&code),
            "the poll echoed the device code"
        );
        assert_eq!(
            api.delete(&op, agent, &format!("model-login/{codex_id}"))
                .await
                .body["status"],
            "cancelled"
        );

        let claude = api
            .post(&op, agent, "model-login", json!({"provider": "anthropic"}))
            .await;
        assert_eq!(claude.code, 200, "{}", claude.text);
        let claude_url = claude.body["url"].as_str().unwrap().to_string();
        assert_eq!(
            reqwest::Url::parse(&claude_url).unwrap().host_str(),
            Some("claude.ai")
        );
        let claude_id = claude.body["loginId"].as_str().unwrap().to_string();
        let wrong = api
            .post(
                &op,
                agent,
                &format!("model-login/{claude_id}/complete"),
                json!({"pasted": format!("{marker}#WRONGSTATE")}),
            )
            .await;
        assert_eq!(
            (wrong.code, wrong.body["error"]["code"].as_str()),
            (400, Some("state_mismatch")),
            "{}",
            wrong.text
        );
        assert!(
            !wrong.text.contains(&marker),
            "the refusal echoed the pasted value"
        );
        assert_eq!(
            api.delete(&op, agent, &format!("model-login/{claude_id}"))
                .await
                .body["status"],
            "cancelled"
        );
        screen_only.extend([
            code,
            codex.body["url"].as_str().unwrap().to_string(),
            claude_url,
        ]);
    }

    // The sidecar (as the hermes uid) sees the token files the real CLI wrote.
    let targets = api.get(&op, agent, "app-login").await;
    let connected: Vec<&str> = targets.body["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["connected"] == true)
        .map(|t| t["target"].as_str().unwrap())
        .collect();
    let mut finished_sorted = finished.clone();
    finished_sorted.sort_unstable();
    assert_eq!(connected, finished_sorted, "{}", targets.text);
    // #4081: every app this run logged in was WATCHED by the real sidecar, so each carries its login time; the
    // 7-day rule appears for the Google apps only (declared Testing above), and nothing else rides along.
    for t in targets.body["targets"].as_array().unwrap() {
        if t["connected"] != true {
            assert!(t.get("estimated").is_none(), "{}", targets.text);
            continue;
        }
        let est = &t["estimated"];
        assert_eq!(est["basis"], "relay_observed_login", "{}", targets.text);
        let at = est["issuedAt"].as_i64().expect("issuedAt");
        assert!((at - chrono_now_secs()).abs() < 3_600, "{at}");
        if ["gmail", "google_calendar", "google_drive"].contains(&t["target"].as_str().unwrap()) {
            assert_eq!(
                est["expiresAt"].as_i64(),
                Some(at + 604_800),
                "{}",
                targets.text
            );
        } else {
            assert!(est.get("expiresAt").is_none() && est.get("testMode").is_none());
        }
    }

    let log_text = String::from_utf8_lossy(&logs.lock().unwrap()).to_string();
    let responses = seen.0.lock().unwrap().join("\n");
    let dump = db_dump(&su).await;
    let audit_text = serde_json::to_string(&audit_rows(&su, f.workspace).await).unwrap();
    assert!(
        log_text.contains("login relay complete requested"),
        "positive control: the masked request line"
    );
    for (what, text) in [
        ("a response", &responses),
        ("the api log", &log_text),
        ("a table dump", &dump),
        ("the audit rows", &audit_text),
    ] {
        for needle in [marker.as_str(), "MOCK-ACCESS-TOKEN", "MOCK-REFRESH-TOKEN"] {
            assert!(!text.contains(needle), "{needle} reached {what}");
        }
    }
    // What may be on the screen but nowhere else (device code, vendor URLs): none of it in the api log, a table
    // dump or the audit rows.
    for secret in &screen_only {
        for (what, text) in [
            ("the api log", &log_text),
            ("a table dump", &dump),
            ("the audit rows", &audit_text),
        ] {
            assert!(
                !text.contains(secret.as_str()),
                "a screen-only value reached {what}"
            );
        }
    }
    // The script greps the sidecar's stderr for these (written to a file, never printed).
    if let Ok(path) = std::env::var("LOGIN_RELAY_E2E_OUT") {
        let mut lines = vec![marker.clone()];
        lines.extend(screen_only);
        std::fs::write(path, lines.join("\n")).unwrap();
    }
    println!("E2E_MARKER=recorded");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_the_instance_operator_reaches_the_relay_routes() {
    let w = world("login-relay-gate", true).await;
    let api = w.api();
    let (_, admin_email) = seed_human(&w.su, w.f.workspace, "admin", "relay-admin").await;
    let stranger = seed(&w.su, "login-relay-stranger").await;
    let admin = login(&w.http, &w.base, w.f.workspace, &admin_email).await;
    let other = login(&w.http, &w.base, stranger.workspace, &stranger.email).await;
    let id = "LOGIN00000000001-mockrelay";
    let before = w.relay.reached();
    // A workspace admin who is not on PLATFORM_ADMIN_EMAILS, and another tenant's operator: 403 on all ten
    // routes, the sidecar never reached.
    for token in [&admin, &other] {
        assert_eq!(api.get(token, w.agent, "model-login").await.code, 403);
        assert_eq!(
            api.post(
                token,
                w.agent,
                "model-login",
                json!({"provider": "anthropic"})
            )
            .await
            .code,
            403
        );
        assert_eq!(
            api.post(
                token,
                w.agent,
                &format!("model-login/{id}/complete"),
                json!({"pasted": "c#s"})
            )
            .await
            .code,
            403
        );
        assert_eq!(
            api.get(token, w.agent, &format!("model-login/{id}"))
                .await
                .code,
            403
        );
        assert_eq!(
            api.delete(token, w.agent, &format!("model-login/{id}"))
                .await
                .code,
            403
        );
        assert_eq!(api.get(token, w.agent, "app-login").await.code, 403);
        assert_eq!(
            api.post(token, w.agent, "app-login", json!({"app": "gmail"}))
                .await
                .code,
            403
        );
        assert_eq!(
            api.post(
                token,
                w.agent,
                &format!("app-login/{id}/complete"),
                json!({"pasted": "c#s"})
            )
            .await
            .code,
            403
        );
        assert_eq!(
            api.get(token, w.agent, &format!("app-login/{id}"))
                .await
                .code,
            403
        );
        assert_eq!(
            api.delete(token, w.agent, &format!("app-login/{id}"))
                .await
                .code,
            403
        );
    }
    assert_eq!(w.relay.reached(), before, "a stranger reached the sidecar");
    // Authority comes before the body: a stranger gets 403 even for garbage, never a 400 that shows the shape.
    for token in [&admin, &other] {
        assert_eq!(
            api.post_raw(token, w.agent, "model-login", "not json")
                .await
                .code,
            403
        );
        assert_eq!(
            api.post_raw(
                token,
                w.agent,
                &format!("model-login/{id}/complete"),
                r#"{"pasted":5}"#
            )
            .await
            .code,
            403
        );
        assert_eq!(
            api.post_raw(token, w.agent, "app-login", "").await.code,
            403
        );
    }
    // The operator gate is its own check, not the owner check in disguise: make the listed-operator-less admin
    // the agent's OWNER (and nothing else changes) — every route must still be 403.
    let admin_id: Uuid =
        sqlx::query_scalar("SELECT member_id FROM human WHERE workspace_id = $1 AND email = $2")
            .bind(w.f.workspace)
            .bind(&admin_email)
            .fetch_one(&w.su)
            .await
            .unwrap();
    let operator_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT owner_human_id FROM agent WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(w.f.workspace)
    .bind(w.agent)
    .fetch_one(&w.su)
    .await
    .unwrap();
    sqlx::query("UPDATE agent SET owner_human_id = $3 WHERE workspace_id = $1 AND member_id = $2")
        .bind(w.f.workspace)
        .bind(w.agent)
        .bind(admin_id)
        .execute(&w.su)
        .await
        .unwrap();
    assert_eq!(
        api.post(
            &admin,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"})
        )
        .await
        .code,
        403
    );
    assert_eq!(
        api.post(&admin, w.agent, "app-login", json!({"app": "gmail"}))
            .await
            .code,
        403
    );
    assert_eq!(api.get(&admin, w.agent, "model-login").await.code, 403);
    sqlx::query("UPDATE agent SET owner_human_id = $3 WHERE workspace_id = $1 AND member_id = $2")
        .bind(w.f.workspace)
        .bind(w.agent)
        .bind(operator_id)
        .execute(&w.su)
        .await
        .unwrap();
    assert_eq!(
        w.relay.reached(),
        before,
        "an owner who is not a listed operator reached the sidecar"
    );
    // Positive control: the operator gets through.
    assert_eq!(api.get(&w.op, w.agent, "model-login").await.code, 200);

    // An agent the operator does not own, a made-up agent, an unpinned agent.
    let (member, _) = seed_human(&w.su, w.f.workspace, "member", "relay-member").await;
    sqlx::query("UPDATE agent SET owner_human_id = $3 WHERE workspace_id = $1 AND member_id = $2")
        .bind(w.f.workspace)
        .bind(w.agent)
        .bind(member)
        .execute(&w.su)
        .await
        .unwrap();
    let r = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"}),
        )
        .await;
    assert_eq!(r.code, 403, "someone else's agent: {}", r.text);
    sqlx::query("UPDATE agent SET owner_human_id = (SELECT member_id FROM human WHERE workspace_id = $1 AND email = $3) WHERE workspace_id = $1 AND member_id = $2")
        .bind(w.f.workspace)
        .bind(w.agent)
        .bind(&w.f.email)
        .execute(&w.su)
        .await
        .unwrap();
    assert_eq!(
        api.post(
            &w.op,
            Uuid::new_v4(),
            "model-login",
            json!({"provider": "anthropic"})
        )
        .await
        .code,
        404
    );
    sqlx::query("DELETE FROM agent_provider_pin WHERE workspace_id = $1 AND agent_member_id = $2")
        .bind(w.f.workspace)
        .bind(w.agent)
        .execute(&w.su)
        .await
        .unwrap();
    let r = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"}),
        )
        .await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (409, Some("login_not_cohosted")),
        "{}",
        r.text
    );

    // Relay off: the operator sees 409 login_relay_off on every route and nothing is dialled.
    let off = world("login-relay-off", false).await;
    let off_api = off.api();
    let id = "LOGIN00000000001-mockrelay";
    for r in [
        off_api.get(&off.op, off.agent, "model-login").await,
        off_api
            .post(
                &off.op,
                off.agent,
                "model-login",
                json!({"provider": "anthropic"}),
            )
            .await,
        off_api
            .post(
                &off.op,
                off.agent,
                &format!("model-login/{id}/complete"),
                json!({"pasted": "c#s"}),
            )
            .await,
        off_api
            .get(&off.op, off.agent, &format!("model-login/{id}"))
            .await,
        off_api
            .delete(&off.op, off.agent, &format!("model-login/{id}"))
            .await,
        off_api.get(&off.op, off.agent, "app-login").await,
        off_api
            .post(&off.op, off.agent, "app-login", json!({"app": "gmail"}))
            .await,
    ] {
        assert_eq!(
            (r.code, r.body["error"]["code"].as_str()),
            (409, Some("login_relay_off")),
            "{}",
            r.text
        );
    }
    assert_eq!(off.relay.reached(), 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_second_operator_cannot_reach_the_first_operators_login() {
    let w = world_with("login-relay-two-operators", true, true).await;
    let api = w.api();
    let (second_id, second_email) = w.second.clone().expect("a second operator");
    let first_id: Uuid =
        sqlx::query_scalar("SELECT member_id FROM human WHERE workspace_id = $1 AND email = $2")
            .bind(w.f.workspace)
            .bind(&w.f.email)
            .fetch_one(&w.su)
            .await
            .unwrap();
    // The second operator has an agent of his own on the same Hermes (owner + operator_env pin).
    let theirs = Uuid::new_v4();
    sqlx::query("INSERT INTO member (id, workspace_id, kind, status, display_name, handle) VALUES ($1, $2, 'agent'::member_kind, 'active', 'Hermes Two', 'hermestwo')")
        .bind(theirs)
        .bind(w.f.workspace)
        .execute(&w.su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, model_source) SELECT $1, workspace_id, model, base_url, $4, model_source FROM agent WHERE workspace_id = $2 AND member_id = $3")
        .bind(theirs)
        .bind(w.f.workspace)
        .bind(w.agent)
        .bind(second_id)
        .execute(&w.su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_provider_pin (agent_member_id, workspace_id, kind) VALUES ($1, $2, 'operator_env')")
        .bind(theirs)
        .bind(w.f.workspace)
        .execute(&w.su)
        .await
        .unwrap();
    let second = login(&w.http, &w.base, w.f.workspace, &second_email).await;

    let start = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"}),
        )
        .await;
    assert_eq!(start.code, 200, "{}", start.text);
    let id = start.body["loginId"].as_str().unwrap().to_string();
    let pasted = json!({"pasted": format!("{MARKER_CODE}#{MOCK_STATE}")});

    // Both are listed operators with a pinned agent; the second one holds the first one's login id.
    let reached = w.relay.reached();
    for r in [
        api.get(&second, theirs, &format!("model-login/{id}")).await,
        api.post(
            &second,
            theirs,
            &format!("model-login/{id}/complete"),
            pasted.clone(),
        )
        .await,
        api.delete(&second, theirs, &format!("model-login/{id}"))
            .await,
    ] {
        assert_eq!(
            (r.code, r.body["error"]["code"].as_str()),
            (403, Some("login_forbidden")),
            "{}",
            r.text
        );
    }
    assert_eq!(
        w.relay.reached(),
        reached + 3,
        "the sidecar is asked, and it is the sidecar that refuses"
    );
    assert!(
        w.relay.received.lock().unwrap().is_empty(),
        "the second operator's paste was accepted"
    );
    // The label the sidecar sees is the caller's own member id — not a constant.
    let labels = w.relay.labels.lock().unwrap().clone();
    assert_eq!(
        labels.first().map(String::as_str),
        Some(first_id.to_string().as_str())
    );
    assert_eq!(
        labels[labels.len() - 3..],
        [
            second_id.to_string(),
            second_id.to_string(),
            second_id.to_string()
        ]
    );
    // Positive control: the owner of the login still reaches it.
    assert_eq!(
        api.get(&w.op, w.agent, &format!("model-login/{id}"))
            .await
            .code,
        200
    );
    assert_eq!(
        api.post(
            &w.op,
            w.agent,
            &format!("model-login/{id}/complete"),
            pasted
        )
        .await
        .code,
        200
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_app_login_needs_one_person_and_a_sole_pinned_hermes() {
    let w = world("login-relay-app", true).await;
    let api = w.api();
    // A second active person.
    let (_member, _) = seed_human(&w.su, w.f.workspace, "member", "relay-second").await;
    let before = w.relay.reached();
    let r = api
        .post(&w.op, w.agent, "app-login", json!({"app": "gmail"}))
        .await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (409, Some("connector_trial_members")),
        "{}",
        r.text
    );
    assert_eq!(
        w.relay.reached(),
        before,
        "the sidecar was reached for a refused app login"
    );
    // The provider login is not an app login: two people do not stop it.
    assert_eq!(
        api.post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"})
        )
        .await
        .code,
        200
    );
    // One person again, but a second agent on the same Hermes.
    sqlx::query("UPDATE member SET status = 'suspended' WHERE workspace_id = $1 AND kind = 'human' AND id <> (SELECT member_id FROM human WHERE workspace_id = $1 AND email = $2)")
        .bind(w.f.workspace)
        .bind(&w.f.email)
        .execute(&w.su)
        .await
        .unwrap();
    let second = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent'::member_kind, 'active', 'Hermes Two', 'hermestwo')",
    )
    .bind(second)
    .bind(w.f.workspace)
    .execute(&w.su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, model_source) \
         SELECT $1, workspace_id, model, base_url, owner_human_id, model_source FROM agent \
          WHERE workspace_id = $2 AND member_id = $3",
    )
    .bind(second)
    .bind(w.f.workspace)
    .bind(w.agent)
    .execute(&w.su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO agent_provider_pin (agent_member_id, workspace_id, kind) VALUES ($1, $2, 'operator_env')")
        .bind(second)
        .bind(w.f.workspace)
        .execute(&w.su)
        .await
        .expect("a second agent pinned to the same Hermes");
    let r = api
        .post(&w.op, w.agent, "app-login", json!({"app": "gmail"}))
        .await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (409, Some("connector_trial_shared")),
        "{}",
        r.text
    );
    sqlx::query("DELETE FROM agent_provider_pin WHERE workspace_id = $1 AND agent_member_id = $2")
        .bind(w.f.workspace)
        .bind(second)
        .execute(&w.su)
        .await
        .unwrap();
    let r = api
        .post(&w.op, w.agent, "app-login", json!({"app": "gmail"}))
        .await;
    assert_eq!(r.code, 200, "{}", r.text);
    // App names are shaped before they reach the sidecar.
    for bad in ["../x", "-rf", "A b", "", "x;y"] {
        let r = api
            .post(&w.op, w.agent, "app-login", json!({"app": bad}))
            .await;
        assert_eq!(r.code, 400, "{bad:?}");
    }
    assert_eq!(
        api.post(&w.op, w.agent, "model-login", json!({"provider": "gmail"}))
            .await
            .code,
        400
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refused_paste_and_malformed_ids_surface_fixed_errors() {
    let w = world("login-relay-refusals", true).await;
    let api = w.api();
    let start = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"}),
        )
        .await;
    let id = start.body["loginId"].as_str().unwrap().to_string();
    let path = format!("model-login/{id}/complete");

    // The sidecar's state check fails and its error body echoes the request: oort answers a fixed text.
    let secret = format!("{MARKER_CODE}#WRONGSTATE");
    let r = api
        .post(&w.op, w.agent, &path, json!({"pasted": secret}))
        .await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (400, Some("state_mismatch")),
        "{}",
        r.text
    );
    assert!(
        !r.text.contains(MARKER_CODE),
        "the refusal echoed the pasted value: {}",
        r.text
    );

    // Shape checks happen here, before the sidecar.
    let reached = w.relay.reached();
    for bad in [
        json!({"pasted": "a\nb"}),
        json!({"pasted": ""}),
        json!({"pasted": "x".repeat(2049)}),
        json!({"pasted": "a\u{0}b"}),
    ] {
        let r = api.post(&w.op, w.agent, &path, bad).await;
        assert_eq!(
            (r.code, r.body["error"]["code"].as_str()),
            (400, Some("bad_paste")),
            "{}",
            r.text
        );
    }
    for raw in [
        r#"{"pasted":"c#s","extra":1}"#,
        r#"{"pasted":5}"#,
        "not json",
        r#"{"pasted":["x"]}"#,
        "",
    ] {
        let r = api.post_raw(&w.op, w.agent, &path, raw).await;
        assert_eq!(r.code, 400, "{raw}");
        assert!(
            !r.text.contains("expected") && !r.text.contains("invalid type"),
            "a parser message leaked: {}",
            r.text
        );
    }
    assert_eq!(
        w.relay.reached(),
        reached,
        "a malformed paste reached the sidecar"
    );

    // Login ids that are not the sidecar's shape never become a path.
    for bad in [
        "short",
        "..%2F..%2Fv1%2Fstatus0000",
        "has space 0123456789ab",
    ] {
        let r = api.get(&w.op, w.agent, &format!("model-login/{bad}")).await;
        assert_eq!(
            (r.code, r.body["error"]["code"].as_str()),
            (404, Some("login_not_found")),
            "{bad}"
        );
        let r = api
            .delete(&w.op, w.agent, &format!("model-login/{bad}"))
            .await;
        assert_eq!(
            (r.code, r.body["error"]["code"].as_str()),
            (404, Some("login_not_found")),
            "{bad}"
        );
    }
    assert_eq!(w.relay.reached(), reached);
    let r = api
        .get(&w.op, w.agent, "model-login/LOGIN99999999999-nosuchlogin")
        .await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (404, Some("login_not_found"))
    );

    // A good paste goes through once; the second is a 409; Codex logins refuse a paste.
    let good = json!({"pasted": format!("{MARKER_CODE}#{MOCK_STATE}")});
    assert_eq!(
        api.post(&w.op, w.agent, &path, good.clone()).await.code,
        200
    );
    let r = api.post(&w.op, w.agent, &path, good.clone()).await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (409, Some("already_submitted"))
    );
    let codex = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "openai-codex"}),
        )
        .await;
    let r = api
        .post(
            &w.op,
            w.agent,
            &format!(
                "model-login/{}/complete",
                codex.body["loginId"].as_str().unwrap()
            ),
            good,
        )
        .await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (409, Some("not_paste_mode"))
    );

    // The sidecar is told WHO is asking: another operator's login id is refused there. (oort's own owner
    // check stops a second operator earlier; here the label is changed under the sidecar to prove it counts.)
    {
        let mut logins = w.relay.logins.lock().unwrap();
        let entry = logins.get_mut(&id).unwrap();
        assert_eq!(
            (entry.kind.as_str(), entry.target.as_str()),
            ("provider", "anthropic")
        );
        entry.operator = Uuid::new_v4().to_string();
    }
    let r = api.get(&w.op, w.agent, &format!("model-login/{id}")).await;
    assert_eq!(
        (r.code, r.body["error"]["code"].as_str()),
        (403, Some("login_forbidden")),
        "{}",
        r.text
    );
    let r = api
        .delete(&w.op, w.agent, &format!("model-login/{id}"))
        .await;
    assert_eq!(r.code, 403);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn starts_are_throttled_and_every_call_leaves_one_closed_audit_line() {
    let w = world("login-relay-throttle", true).await;
    let api = w.api();
    for i in 0..6 {
        let r = api
            .post(
                &w.op,
                w.agent,
                "model-login",
                json!({"provider": "anthropic"}),
            )
            .await;
        assert_eq!(r.code, 200, "start {i}: {}", r.text);
    }
    let reached = w.relay.reached();
    let r = api
        .post(
            &w.op,
            w.agent,
            "model-login",
            json!({"provider": "anthropic"}),
        )
        .await;
    assert_eq!(r.code, 429, "{}", r.text);
    assert_eq!(
        w.relay.reached(),
        reached,
        "a throttled start reached the sidecar"
    );
    let audit = audit_rows(&w.su, w.f.workspace).await;
    assert_eq!(
        audit.len(),
        6,
        "one line per start, none for the throttled one: {audit:?}"
    );
    for (action, detail) in &audit {
        assert_eq!(action, "agent.model_login.started");
        assert_eq!(detail["result"], "started");
        assert_eq!(
            (detail["kind"].as_str(), detail["target"].as_str()),
            (Some("provider"), Some("anthropic"))
        );
    }
}
