//! #3883 — 같은 서버 에이전트 감지·연결 (ADR-0203 슬라이스 1·3), through the real
//! routes, the real RLS role and a loopback mock that counts every request.
//!
//! Red proofs (ADR-0203 「수용 기준」):
//! * nothing declared ⇒ zero requests, even with a live mock at the env URL;
//! * the probe sends exactly `/health` and `/v1/models` (+ `/v1/toolsets` only on ask);
//! * a stranger (workspace admin / other tenant) gets 403 and the mock sees nothing;
//! * no attestation ⇒ connect refused by the server, mock sees nothing, no agent;
//! * connect creates the member + `operator_env` pin and **no** membership, plugin,
//!   memory or connection grant (row counts compared);
//! * neither responses, logs nor audit rows carry `HERMES_API_KEY` or the agent's body.
//!
//! #4337 (ADR-0203 증보 2026-10-25 수용 기준 2·4, `[nightly]`):
//! * the status body is the whole expected JSON for each configuration (platform x relay x declared), so the
//!   handler is tied to the assembly by value; neither the agent mock nor a counting relay client is reached;
//! * a stranger's 403 carries no `environment`; probe and connect answers carry none either;
//! * no env string (stamp, Railway id, relay URL, relay key) reaches a 200 body, a 403 body, an audit row or the log.
//!
//! `#[ignore]`: needs a real Postgres, same harness as `agent_provider_pin_conformance_pg.rs`.

use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_provider_probe::{
    GuardedProviderProbe, LoginRelayClient, Pasted, RelayFailure, RelayKind, RelayTarget,
    StartReply, StatusReply, TargetStatus,
};
use momo_server::config::{CohostedAgentConfig, LoginRelayConfig, SettingsConfig};
use momo_server::host_platform::HostPlatform;
use momo_server::{build_app, AppState};
use momo_settings::{EgressPolicy, ProviderConfig, ProviderMode};
use serde_json::{json, Value};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "cohosted-conformance-app-signing-secret";
const TEST_PROVIDER_MASTER_KEY: &str = "cohosted-conformance-provider-master-key";
const TEST_PASSWORD: &str = "cohosted-conformance-password";
const ENV_KEY: &str = "sk-cohost-env-3883-0002";
/// Text the mock agent puts in every body: it must never reach a client, a log or an audit row.
const BODY_MARKER: &str = "agent-body-marker-3883";
/// A well-formed login relay key (32-256 characters of `[A-Za-z0-9._~+/=-]`).
const RELAY_KEY: &str = "relay-key-4337-0123456789abcdef0123456789abcdef";

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
// the mock co-hosted agent: counts and records every request
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Hits {
    paths: Arc<Mutex<Vec<String>>>,
    bearers: Arc<Mutex<Vec<String>>>,
    /// Armed by a test: while answering the next `/api/model/options`, re-pin this
    /// agent to a team link, i.e. change the world between the read and the write.
    repin_on_options: Arc<Mutex<Option<(PgPool, Uuid)>>>,
}

impl Hits {
    fn count(&self) -> usize {
        self.paths.lock().unwrap().len()
    }
    fn paths(&self) -> Vec<String> {
        self.paths.lock().unwrap().clone()
    }
}

/// `key_ok = false` makes `/v1/models` answer 401 and echo the key.
async fn mock_agent(key_ok: bool, toolsets: Option<Value>) -> (u16, Hits) {
    let hits = Hits::default();
    let record = |hits: &Hits, path: &str, headers: &HeaderMap| {
        hits.paths.lock().unwrap().push(path.to_string());
        hits.bearers.lock().unwrap().push(
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string(),
        );
    };
    let (h1, h2, h3, h4) = (hits.clone(), hits.clone(), hits.clone(), hits.clone());
    let toolsets = Arc::new(toolsets);
    let app = Router::new()
        .route(
            "/health",
            get(move |headers: HeaderMap| async move {
                record(&h1, "/health", &headers);
                axum::Json(json!({"status": "ok", "note": BODY_MARKER}))
            }),
        )
        .route(
            "/v1/models",
            get(move |headers: HeaderMap| async move {
                record(&h2, "/v1/models", &headers);
                if !key_ok {
                    return (
                        StatusCode::UNAUTHORIZED,
                        [("x-echo-key", ENV_KEY.to_string())],
                        format!("{BODY_MARKER} {ENV_KEY}"),
                    )
                        .into_response();
                }
                axum::Json(json!({
                    "object": "list",
                    "data": [{"id": "hermes-agent", "owned_by": BODY_MARKER}],
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/toolsets",
            get(move |headers: HeaderMap| {
                let toolsets = toolsets.clone();
                async move {
                    record(&h3, "/v1/toolsets", &headers);
                    match toolsets.as_ref() {
                        Some(body) => axum::Json(body.clone()).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
            }),
        )
        .fallback(move |uri: axum::http::Uri, headers: HeaderMap| async move {
            record(&h4, uri.path(), &headers);
            StatusCode::NOT_FOUND
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock agent");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, hits)
}

struct Declared<'a> {
    operator_email: &'a str,
    env_url: String,
    bearer: &'a str,
    declared: bool,
    tools_locked: bool,
}

/// A relay client that only counts. The status read asks the parsed config whether the relay is on and
/// never the sidecar, so every call here is a request the test must not see; the answer is a refusal that
/// dials nothing.
#[derive(Default)]
struct CountingRelay(AtomicUsize);

impl CountingRelay {
    fn calls(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }

    fn hit<T>(&self) -> Result<T, RelayFailure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(RelayFailure::Unreachable)
    }
}

#[async_trait::async_trait]
impl LoginRelayClient for CountingRelay {
    async fn start(
        &self,
        _target: &RelayTarget,
        _kind: RelayKind,
        _name: &str,
        _operator: &str,
    ) -> Result<StartReply, RelayFailure> {
        self.hit()
    }
    async fn complete(
        &self,
        _target: &RelayTarget,
        _login_id: &str,
        _operator: &str,
        _pasted: &Pasted,
    ) -> Result<StatusReply, RelayFailure> {
        self.hit()
    }
    async fn poll(
        &self,
        _target: &RelayTarget,
        _login_id: &str,
        _operator: &str,
    ) -> Result<StatusReply, RelayFailure> {
        self.hit()
    }
    async fn cancel(
        &self,
        _target: &RelayTarget,
        _login_id: &str,
        _operator: &str,
    ) -> Result<StatusReply, RelayFailure> {
        self.hit()
    }
    async fn status(&self, _target: &RelayTarget) -> Result<Vec<TargetStatus>, RelayFailure> {
        self.hit()
    }
}

/// What #4337 adds to a started server (ADR-0203 증보 2026-10-25): the platform the process says it runs
/// on, and the login relay's config with the client that would dial it.
struct Environment {
    platform: HostPlatform,
    relay: LoginRelayConfig,
    relay_client: Arc<dyn LoginRelayClient>,
}

async fn start_server(pool: PgPool, d: Declared<'_>) -> String {
    let environment = Environment {
        platform: HostPlatform::default(),
        relay: LoginRelayConfig::default(),
        relay_client: Arc::new(CountingRelay::default()),
    };
    start_server_in(pool, d, environment).await
}

async fn start_server_in(pool: PgPool, d: Declared<'_>, environment: Environment) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(TEST_PROVIDER_MASTER_KEY.to_string()),
        env_provider: ProviderConfig {
            mode: ProviderMode::ExternalHermes,
            base_url: d.env_url,
            bearer: d.bearer.to_string(),
            allow_local_loopback: true,
        },
        platform_admin_emails: vec![d.operator_email.to_ascii_lowercase()],
        environment: "local".to_string(),
    })
    .with_cohosted(
        CohostedAgentConfig {
            declared: d.declared,
            tools_locked: d.tools_locked,
            platform: environment.platform,
            ..Default::default()
        },
        Arc::new(GuardedProviderProbe::new(
            EgressPolicy {
                allow_local: true,
                local_hosts: Vec::new(),
                operator_hosts: Vec::new(),
            },
            std::time::Duration::from_secs(5),
        )),
    )
    .with_login_relay(environment.relay, environment.relay_client);
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

struct Api<'a> {
    http: &'a reqwest::Client,
    base: &'a str,
    workspace: Uuid,
}

impl Api<'_> {
    fn url(&self, tail: &str) -> String {
        format!(
            "{}/v1/workspaces/{}/cohosted-agent{tail}",
            self.base, self.workspace
        )
    }

    async fn status(&self, token: &str) -> (u16, Value, String) {
        let r = self
            .http
            .get(self.url(""))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let code = r.status().as_u16();
        let text = r.text().await.unwrap();
        (
            code,
            serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        )
    }

    async fn post(&self, token: &str, tail: &str, body: Option<Value>) -> (u16, Value, String) {
        let mut r = self.http.post(self.url(tail)).bearer_auth(token);
        if let Some(body) = body {
            r = r.json(&body);
        }
        let r = r.send().await.unwrap();
        let code = r.status().as_u16();
        let text = r.text().await.unwrap();
        (
            code,
            serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        )
    }
}

/// Row counts of every table a "grant" could land in, plus the agent count.
async fn grant_counts(su: &PgPool, workspace: Uuid) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    for table in [
        "membership",
        "plugin_grant",
        "hosted_agent_connection",
        "agent_run",
        "message",
    ] {
        let n: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE workspace_id = $1"
        ))
        .bind(workspace)
        .fetch_one(su)
        .await
        .unwrap_or_else(|e| panic!("count {table}: {e}"));
        out.push((table.to_string(), n));
    }
    out
}

async fn agent_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id = $1 AND kind = 'agent'")
        .bind(workspace)
        .fetch_one(su)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn undeclared_means_zero_requests_even_with_a_live_agent_at_the_env_url() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-undeclared").await;
    // The mock is up and the env URL points at it — but the operator never
    // declared it (HERMES_BASE_URL unset in production would leave only the
    // localhost default; the flag is what says "declared").
    let (port, hits) = mock_agent(true, None).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: false,
            tools_locked: true,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;

    let (code, body, _) = api.status(&op).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["declaration"], "not_declared");
    assert_eq!(body["connectable"], false);
    let (code, body, _) = api
        .post(&op, "/probe", Some(json!({"checkToolsets": true})))
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["state"], "not_declared");
    assert_eq!(body["requestsSent"], 0);
    let (code, body, _) = api.post(&op, "/connect", None).await;
    assert_eq!(code, 409, "{body}");
    assert_eq!(body["error"]["code"], "cohosted_agent_not_ready");

    assert_eq!(
        hits.count(),
        0,
        "a request left the server: {:?}",
        hits.paths()
    );
    assert_eq!(agent_count(&su, f.workspace).await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_declared_url_the_gate_refuses_or_a_placeholder_key_sends_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-refused").await;
    let (port, hits) = mock_agent(true, None).await;
    let http = reqwest::Client::new();

    // (a) key missing: the dev placeholder is not a key.
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: "dev-insecure-hermes-bearer",
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;
    let (_, body, _) = api.post(&op, "/probe", None).await;
    assert_eq!(body["state"], "key_missing");
    assert_eq!(body["requestsSent"], 0);

    // (b) plaintext to a name that is not an opted-in local host: the bearer
    // would go out in clear, so the write gate refuses before any socket.
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: "http://hermes.example.test:8642/v1".into(),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;
    let (_, body, _) = api.post(&op, "/probe", None).await;
    assert_eq!(body["state"], "url_refused");
    assert_eq!(body["requestsSent"], 0);
    let (code, body, _) = api.post(&op, "/connect", None).await;
    assert_eq!(
        (code, body["error"]["code"].as_str()),
        (409, Some("cohosted_agent_not_ready"))
    );
    assert_eq!(hits.count(), 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_the_instance_operator_reaches_status_probe_and_connect() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-op").await;
    let (_, admin_email) = seed_human(&su, f.workspace, "admin", "cohost-admin").await;
    let stranger = seed(&su, "cohost-stranger").await;
    let (port, hits) = mock_agent(true, None).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let admin = login(&http, &base, f.workspace, &admin_email).await;
    let other = login(&http, &base, stranger.workspace, &stranger.email).await;

    // A workspace admin who is not on PLATFORM_ADMIN_EMAILS, and another
    // tenant's operator: 403 on every verb, nothing dialled, nothing written.
    for token in [&admin, &other] {
        assert_eq!(api.status(token).await.0, 403);
        assert_eq!(api.post(token, "/probe", None).await.0, 403);
        assert_eq!(api.post(token, "/connect", None).await.0, 403);
    }
    assert_eq!(
        hits.count(),
        0,
        "a stranger spent a request: {:?}",
        hits.paths()
    );
    assert_eq!(agent_count(&su, f.workspace).await, 0);

    // Positive control: the operator gets through the same routes.
    let op = login(&http, &base, f.workspace, &f.email).await;
    assert_eq!(api.status(&op).await.0, 200);
    let (code, body, _) = api.post(&op, "/probe", None).await;
    assert_eq!((code, body["state"].as_str()), (200, Some("ok")), "{body}");
    assert!(hits.count() > 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_probe_sends_exactly_two_requests_and_a_third_only_when_asked() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-probe").await;
    let (port, hits) =
        mock_agent(true, Some(json!({"toolsets": {"terminal": {}, "web": {}}}))).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: false,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;

    let (code, body, _) = api.post(&op, "/probe", None).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["state"], "ok");
    assert_eq!(body["requestsSent"], 2);
    assert_eq!(body["modelCount"], 1);
    assert_eq!(hits.paths(), vec!["/health", "/v1/models"]);
    assert_eq!(
        hits.bearers.lock().unwrap().clone(),
        vec![format!("Bearer {ENV_KEY}"); 2]
    );
    // Not attested: reachable, but not connectable.
    assert_eq!(body["toolsLockAttested"], false);
    assert_eq!(body["connectable"], false);
    assert_eq!(body["toolsets"]["signal"], "not_checked");

    let (code, body, _) = api
        .post(&op, "/probe", Some(json!({"checkToolsets": true})))
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["requestsSent"], 3);
    assert_eq!(body["toolsets"]["signal"], "dangerous_listed");
    assert_eq!(body["toolsets"]["listed"], json!(["terminal"]));
    assert_eq!(body["toolsets"]["proof"], false);
    assert_eq!(
        hits.paths(),
        vec![
            "/health",
            "/v1/models",
            "/health",
            "/v1/models",
            "/v1/toolsets"
        ]
    );

    // A body that tries to widen the probe is refused (closed vocabulary).
    let (code, _, _) = api
        .post(
            &op,
            "/probe",
            Some(json!({"path": "/admin", "url": "http://169.254.169.254"})),
        )
        .await;
    assert_eq!(code, 422, "an unknown field must not be accepted silently");
    assert_eq!(hits.count(), 5);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn without_the_attestation_the_server_itself_refuses_to_connect() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-attest").await;
    let (port, hits) = mock_agent(true, None).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: false,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;
    let before = grant_counts(&su, f.workspace).await;

    let (code, body, _) = api.post(&op, "/connect", None).await;
    assert_eq!(code, 409, "{body}");
    assert_eq!(body["error"]["code"], "cohosted_tools_lock_not_attested");
    let (_, status, _) = api.status(&op).await;
    assert_eq!(status["connectable"], false);
    assert_eq!(status["toolsLockAttested"], false);

    assert_eq!(
        hits.count(),
        0,
        "connect dialled before checking the attestation"
    );
    assert_eq!(agent_count(&su, f.workspace).await, 0);
    assert_eq!(grant_counts(&su, f.workspace).await, before);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_that_does_not_answer_or_refuses_the_key_is_not_connected() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-dead").await;
    let http = reqwest::Client::new();

    // Wrong key: the agent answers 401.
    let (port, hits) = mock_agent(false, None).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;
    let (code, body, text) = api.post(&op, "/connect", None).await;
    assert_eq!(
        (code, body["error"]["code"].as_str()),
        (409, Some("cohosted_agent_not_reachable"))
    );
    assert!(
        !text.contains(ENV_KEY) && !text.contains(BODY_MARKER),
        "{text}"
    );
    let (_, body, text) = api.post(&op, "/probe", None).await;
    assert_eq!(body["state"], "rejected");
    assert!(
        !text.contains(ENV_KEY) && !text.contains(BODY_MARKER),
        "{text}"
    );
    assert!(hits.count() >= 2);

    // Nothing listening.
    let dead = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{dead}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;
    let (_, body, _) = api.post(&op, "/probe", None).await;
    assert_eq!(body["state"], "unreachable");
    let (code, body, _) = api.post(&op, "/connect", None).await;
    assert_eq!(
        (code, body["error"]["code"].as_str()),
        (409, Some("cohosted_agent_not_reachable"))
    );
    assert_eq!(
        agent_count(&su, f.workspace).await,
        0,
        "a dead agent got a member"
    );
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

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn connect_creates_the_member_and_the_pin_and_grants_nothing_and_leaks_no_secret() {
    ensure_schema_and_roles();
    let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
    let _guard = tracing_subscriber::fmt()
        .with_writer(BufferWriter(logs.clone()))
        .with_max_level(tracing::Level::DEBUG)
        .set_default();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-connect").await;
    // A pre-existing channel the operator is in: connect must not add the agent to it.
    let (port, hits) = mock_agent(true, None).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;

    let (_, status, status_text) = api.status(&op).await;
    assert_eq!(status["declaration"], "ready");
    assert_eq!(status["connectable"], true);
    assert_eq!(status["toolsLockAttested"], true);
    assert_eq!(hits.count(), 0, "status must not touch the network");

    let before = grant_counts(&su, f.workspace).await;
    let (code, body, connect_text) = api
        .post(
            &op,
            "/connect",
            Some(json!({"displayName": "Hermes", "handle": "hermes"})),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    assert_eq!(body["pinKind"], "operator_env");
    let agent: Uuid = body["agentId"].as_str().unwrap().parse().unwrap();

    // The connect probe is the same two fixed requests, plus the one read-only
    // options GET (#4143, ADR-0203 증보 2026-10-20 M2). This mock has no options
    // route (404), so connect fell back to today's alias and an empty route.
    assert_eq!(
        hits.paths(),
        vec!["/health", "/v1/models", "/api/model/options"]
    );

    // A first-class agent member, on its own model, pinned to the env link.
    let kind: String = sqlx::query_scalar("SELECT kind::text FROM member WHERE id = $1")
        .bind(agent)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(kind, "agent");
    let (model, source): (String, String) =
        sqlx::query_as("SELECT model, model_source FROM agent WHERE member_id = $1")
            .bind(agent)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!((model.as_str(), source.as_str()), ("hermes-agent", "agent"));
    let pin: String =
        sqlx::query_scalar("SELECT kind FROM agent_provider_pin WHERE agent_member_id = $1")
            .bind(agent)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(pin, "operator_env");
    let tools: Value = sqlx::query_scalar(
        "SELECT to_jsonb(enabled_tools) FROM agent_profile WHERE agent_member_id = $1",
    )
    .bind(agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(tools, json!([]), "connect enabled a tool");

    // The #3873 route reads the same pin, resolved.
    let pin_route: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/provider-pin",
            f.workspace
        ))
        .bearer_auth(&op)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pin_route["pin"]["kind"], "operator_env");
    assert_eq!(pin_route["pin"]["linkResolved"], true);

    // Nothing else changed: no membership, plugin, memory, connection, run or message.
    assert_eq!(
        grant_counts(&su, f.workspace).await,
        before,
        "connect added a membership/grant/run/message row"
    );
    let agent_memberships: i64 =
        sqlx::query_scalar("SELECT count(*) FROM membership WHERE member_id = $1")
            .bind(agent)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(agent_memberships, 0, "the agent was put in a channel");

    // Idempotence: a second click is refused and makes no second agent.
    let (code, body, _) = api
        .post(&op, "/connect", Some(json!({"handle": "hermes2"})))
        .await;
    assert_eq!(
        (code, body["error"]["code"].as_str()),
        (409, Some("cohosted_agent_already_connected"))
    );
    assert_eq!(agent_count(&su, f.workspace).await, 1);
    let (_, status, _) = api.status(&op).await;
    assert_eq!(status["connectable"], false);
    assert_eq!(status["connectedAgentId"], agent.to_string());

    // Audit: the three rows exist, and no secret/body is in any of them.
    let audit: Vec<(String, Value)> = sqlx::query_as(
        "SELECT action, detail FROM audit_log \
          WHERE workspace_id = $1 AND subject_member_id = $2 ORDER BY created_at",
    )
    .bind(f.workspace)
    .bind(agent)
    .fetch_all(&su)
    .await
    .unwrap();
    let actions: Vec<&str> = audit.iter().map(|(a, _)| a.as_str()).collect();
    assert!(actions.contains(&"agent.created"), "{actions:?}");
    assert!(
        actions.contains(&"agent.provider_pin.updated"),
        "{actions:?}"
    );
    assert!(actions.contains(&"agent.cohosted.connected"), "{actions:?}");
    let audit_text = serde_json::to_string(&audit).unwrap();

    let log_text = String::from_utf8_lossy(&logs.lock().unwrap()).to_string();
    for (what, text) in [
        ("status response", &status_text),
        ("connect response", &connect_text),
        ("audit rows", &audit_text),
        ("logs", &log_text),
    ] {
        assert!(
            !text.contains(ENV_KEY),
            "HERMES_API_KEY leaked into the {what}"
        );
        assert!(
            !text.contains(BODY_MARKER),
            "the agent's body leaked into the {what}"
        );
    }
    assert!(
        log_text.contains("cohosted agent connect probe"),
        "positive control: the probe log line must exist for the log check to mean anything"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn connect_keeps_the_name_hygiene_of_the_agent_create_and_rename_routes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, "cohost-names").await;
    // A person already named "Hermes": an agent with the same skeleton would be
    // indistinguishable from them on cards and in mentions.
    sqlx::query(
        "INSERT INTO member (workspace_id, kind, display_name, handle) \
         VALUES ($1, 'human', 'Hermes', 'hermes-person')",
    )
    .bind(f.workspace)
    .execute(&su)
    .await
    .unwrap();
    let (port, _hits) = mock_agent(true, None).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;

    // Default name collides with the person.
    let (code, body, _) = api.post(&op, "/connect", None).await;
    assert_eq!(
        (code, body["error"]["code"].as_str()),
        (409, Some("cohosted_agent_name_taken")),
        "{body}"
    );
    // A zero-width character in the name is refused outright (the rename route's rule).
    let (code, body, _) = api
        .post(
            &op,
            "/connect",
            Some(json!({"displayName": "Her\u{200b}mes", "handle": "hermes2"})),
        )
        .await;
    assert_eq!(code, 400, "{body}");
    assert_eq!(agent_count(&su, f.workspace).await, 0);
    // A name of its own goes through (positive control).
    let (code, body, _) = api
        .post(
            &op,
            "/connect",
            Some(json!({"displayName": "Hermes Bot", "handle": "hermesbot"})),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    assert_eq!(agent_count(&su, f.workspace).await, 1);
}

// ---------------------------------------------------------------------------
// #4143 — choosing the provider + model (ADR-0203 증보 2026-10-20)
// ---------------------------------------------------------------------------

/// What Hermes's `/api/model/options` looks like (shape from hermes_cli/inventory.py):
/// Anthropic and OpenAI Codex logged in, Nous and a "stale" row not.
fn options_body() -> Value {
    json!({
        "model": "claude-sonnet-5-5",
        "provider": "anthropic",
        "providers": [
            {"slug": "anthropic", "name": BODY_MARKER, "is_current": true, "authenticated": true,
             "models": ["claude-sonnet-5-5", "claude-fable-5.1", "claude-opus-5-5",
                        "claude-haiku-5", "claude-opus-4-1"]},
            {"slug": "openai-codex", "is_current": false, "authenticated": true,
             "models": ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]},
            {"slug": "nous", "is_current": false, "authenticated": false, "models": []},
            // A provider that lists models but is NOT logged in must never be offered.
            {"slug": "openrouter", "is_current": false, "authenticated": false,
             "models": ["some/model"]},
        ],
    })
}

/// A Hermes that serves the three connect paths plus a mutable options body.
async fn mock_hermes(options: Value) -> (u16, Hits, Arc<Mutex<(u16, Value)>>) {
    let hits = Hits::default();
    let options = Arc::new(Mutex::new((200u16, options)));
    let (h1, h2, h3) = (hits.clone(), hits.clone(), hits.clone());
    let served = options.clone();
    let app = Router::new()
        .route(
            "/health",
            get(move || async move {
                h1.paths.lock().unwrap().push("/health".into());
                axum::Json(json!({"status": "ok"}))
            }),
        )
        .route(
            "/v1/models",
            get(move || async move {
                h2.paths.lock().unwrap().push("/v1/models".into());
                axum::Json(json!({"object": "list", "data": [{"id": "hermes-agent"}]}))
            }),
        )
        .route(
            "/api/model/options",
            get(move |headers: HeaderMap| {
                let served = served.clone();
                async move {
                    h3.paths.lock().unwrap().push("/api/model/options".into());
                    h3.bearers.lock().unwrap().push(
                        headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string(),
                    );
                    let armed = h3.repin_on_options.lock().unwrap().take();
                    if let Some((su, agent)) = armed {
                        sqlx::query(
                            "UPDATE agent_provider_pin SET kind = 'team_link', link_position = 0, \
                                    link_endpoint_label = 'team', model_provider = NULL, model_id = NULL \
                              WHERE agent_member_id = $1",
                        )
                        .bind(agent)
                        .execute(&su)
                        .await
                        .unwrap();
                    }
                    let (status, body) = served.lock().unwrap().clone();
                    (StatusCode::from_u16(status).unwrap(), axum::Json(body)).into_response()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, hits, options)
}

impl Api<'_> {
    async fn get_models(&self, token: &str) -> (u16, Value, String) {
        let r = self
            .http
            .get(self.url("/models"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let code = r.status().as_u16();
        let text = r.text().await.unwrap();
        (
            code,
            serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        )
    }

    async fn put_model(&self, token: &str, body: Value) -> (u16, Value, String) {
        let r = self
            .http
            .put(self.url("/model"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let code = r.status().as_u16();
        let text = r.text().await.unwrap();
        (
            code,
            serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        )
    }
}

struct Connected {
    su: PgPool,
    f: Fixture,
    base: String,
    http: reqwest::Client,
    op: String,
    hits: Hits,
    options: Arc<Mutex<(u16, Value)>>,
    agent: Uuid,
}

impl Connected {
    fn api(&self) -> Api<'_> {
        Api {
            http: &self.http,
            base: &self.base,
            workspace: self.f.workspace,
        }
    }

    async fn pin_row(&self) -> (Option<String>, Option<String>, String) {
        sqlx::query_as(
            "SELECT p.model_provider, p.model_id, a.model FROM agent_provider_pin p \
               JOIN agent a ON a.member_id = p.agent_member_id WHERE p.agent_member_id = $1",
        )
        .bind(self.agent)
        .fetch_one(&self.su)
        .await
        .unwrap()
    }

    async fn model_audits(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_log WHERE workspace_id = $1 \
               AND action = 'agent.cohosted.model_changed'",
        )
        .bind(self.f.workspace)
        .fetch_one(&self.su)
        .await
        .unwrap()
    }
}

async fn connected(hint: &str, options: Value) -> Connected {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su, hint).await;
    let (port, hits, options) = mock_hermes(options).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &f.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let http = reqwest::Client::new();
    let op = login(&http, &base, f.workspace, &f.email).await;
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let (code, body, _) = api
        .post(
            &op,
            "/connect",
            Some(json!({"displayName": "Hermes Bot", "handle": "hermesbot"})),
        )
        .await;
    assert_eq!(code, 201, "{body}");
    let agent: Uuid = body["agentId"].as_str().unwrap().parse().unwrap();
    Connected {
        su,
        f,
        base,
        http,
        op,
        hits,
        options,
        agent,
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn connect_pins_the_current_provider_and_model_instead_of_the_alias() {
    let c = connected("model-connect", options_body()).await;
    let (provider, model, agent_model) = c.pin_row().await;
    assert_eq!(
        (provider.as_deref(), model.as_deref(), agent_model.as_str()),
        (
            Some("anthropic"),
            Some("claude-sonnet-5-5"),
            "claude-sonnet-5-5"
        ),
        "connect must name Hermes's current provider and model, not hermes-agent"
    );
    assert!(c
        .hits
        .bearers
        .lock()
        .unwrap()
        .iter()
        .any(|b| b == &format!("Bearer {ENV_KEY}")));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn connect_still_succeeds_when_the_options_read_fails_and_keeps_todays_pin() {
    for (status, body) in [
        (500u16, json!({"detail": "boom"})),
        (200, json!({"unexpected": BODY_MARKER})),
        (200, json!({"providers": "not-a-list"})),
    ] {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let f = seed(&su, "model-fallback").await;
        let (port, _hits, options) = mock_hermes(options_body()).await;
        *options.lock().unwrap() = (status, body.clone());
        let base = start_server(
            momo_app_pool().await,
            Declared {
                operator_email: &f.email,
                env_url: format!("http://127.0.0.1:{port}/v1"),
                bearer: ENV_KEY,
                declared: true,
                tools_locked: true,
            },
        )
        .await;
        let http = reqwest::Client::new();
        let op = login(&http, &base, f.workspace, &f.email).await;
        let api = Api {
            http: &http,
            base: &base,
            workspace: f.workspace,
        };
        let (code, resp, _) = api
            .post(
                &op,
                "/connect",
                Some(json!({"displayName": "Hermes Bot", "handle": "hermesbot"})),
            )
            .await;
        assert_eq!(code, 201, "{status} {body}: {resp}");
        let agent: Uuid = resp["agentId"].as_str().unwrap().parse().unwrap();
        let row: (Option<String>, Option<String>, String) = sqlx::query_as(
            "SELECT p.model_provider, p.model_id, a.model FROM agent_provider_pin p \
               JOIN agent a ON a.member_id = p.agent_member_id WHERE p.agent_member_id = $1",
        )
        .bind(agent)
        .fetch_one(&su)
        .await
        .unwrap();
        assert_eq!(
            row,
            (None, None, "hermes-agent".to_string()),
            "{status} {body}"
        );
        // And the models route says so honestly rather than inventing a list.
        let (code, _, _) = api.get_models(&op).await;
        assert_eq!(code, 502);
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn models_offers_only_logged_in_providers_and_marks_featured() {
    let c = connected("model-list", options_body()).await;
    let api = c.api();
    let (code, body, text) = api.get_models(&c.op).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["schema"], "momo.cohosted_agent.models.v0");
    assert_eq!(body["agentId"], c.agent.to_string());
    assert_eq!(body["pinned"], true, "connect wrote the pair");
    assert_eq!(
        body["current"],
        json!({"provider": "anthropic", "model": "claude-sonnet-5-5"})
    );
    assert_eq!(body["hermesCurrent"], body["current"]);
    let providers: Vec<&str> = body["providers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["provider"].as_str().unwrap())
        .collect();
    assert_eq!(providers, vec!["anthropic", "openai-codex"], "{text}");
    assert!(!text.contains("openrouter") && !text.contains("some/model"));
    assert!(!text.contains(BODY_MARKER), "an agent-supplied name leaked");
    // Featured: the first three in Hermes's order; the rest are behind 전체 보기.
    let anthropic = &body["providers"][0]["models"];
    let featured: Vec<(&str, bool)> = anthropic
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["id"].as_str().unwrap(), m["featured"].as_bool().unwrap()))
        .collect();
    assert_eq!(
        featured,
        vec![
            ("claude-sonnet-5-5", true),
            ("claude-fable-5.1", true),
            ("claude-opus-5-5", true),
            ("claude-haiku-5", false),
            ("claude-opus-4-1", false),
        ]
    );
    assert_eq!(anthropic[0]["current"], true);
    assert_eq!(anthropic[1]["current"], false);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn put_model_writes_the_pair_to_the_pin_the_agent_row_and_the_audit_and_current_is_always_featured(
) {
    let c = connected("model-put", options_body()).await;
    let api = c.api();
    // A model deep in the list (not in the first three) is still featured once chosen.
    let (code, body, _) = api
        .put_model(
            &c.op,
            json!({"provider": "openai-codex", "model": "gpt-5.5"}),
        )
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(
        body["current"],
        json!({"provider": "openai-codex", "model": "gpt-5.5"})
    );
    assert_eq!(
        c.pin_row().await,
        (
            Some("openai-codex".into()),
            Some("gpt-5.5".into()),
            "gpt-5.5".into()
        )
    );
    assert_eq!(c.model_audits().await, 1);
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 \
           AND action = 'agent.cohosted.model_changed'",
    )
    .bind(c.f.workspace)
    .fetch_one(&c.su)
    .await
    .unwrap();
    let audit_text = audit.to_string();
    assert!(audit_text.contains("openai-codex") && audit_text.contains("claude-sonnet-5-5"));
    assert!(!audit_text.contains(ENV_KEY));

    let (_, listed, _) = api.get_models(&c.op).await;
    assert_eq!(listed["pinned"], true);
    assert_eq!(listed["current"]["model"], "gpt-5.5");
    // Hermes's own current model is unchanged and reported as such.
    assert_eq!(listed["hermesCurrent"]["provider"], "anthropic");
    let codex = listed["providers"][1]["models"].as_array().unwrap();
    let chosen = codex.iter().find(|m| m["id"] == "gpt-5.5").unwrap();
    assert_eq!(
        (chosen["featured"].clone(), chosen["current"].clone()),
        (json!(true), json!(true))
    );
    let unchosen = codex.iter().find(|m| m["id"] == "gpt-5.6-luna").unwrap();
    assert_eq!(unchosen["featured"], false);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn put_model_outside_the_logged_in_list_is_422_and_writes_nothing() {
    let c = connected("model-422", options_body()).await;
    let api = c.api();
    let before = c.pin_row().await;
    for (what, body) in [
        (
            "model not listed under a logged-in provider",
            json!({"provider": "anthropic", "model": "claude-opus-4-1-nonexistent"}),
        ),
        (
            "a real model, but of the other provider",
            json!({"provider": "anthropic", "model": "gpt-6-sol"}),
        ),
        (
            "provider not logged in (skeleton row)",
            json!({"provider": "nous", "model": "anything"}),
        ),
        (
            "provider not logged in but listing models",
            json!({"provider": "openrouter", "model": "some/model"}),
        ),
        (
            "unknown provider",
            json!({"provider": "made-up", "model": "claude-sonnet-5-5"}),
        ),
        (
            "malformed provider slug",
            json!({"provider": "../anthropic", "model": "claude-sonnet-5-5"}),
        ),
        (
            "malformed model id",
            json!({"provider": "anthropic", "model": "claude sonnet; drop"}),
        ),
        (
            "alias that Hermes ignores",
            json!({"provider": "", "model": "hermes-agent"}),
        ),
    ] {
        let (code, resp, _) = api.put_model(&c.op, body).await;
        assert_eq!(
            (code, resp["error"]["code"].as_str()),
            (422, Some("cohosted_model_not_offered")),
            "{what}: {resp}"
        );
    }
    // An unknown field is refused too (closed body), as a client error.
    let (code, _, _) = api
        .put_model(
            &c.op,
            json!({"provider": "anthropic", "model": "claude-opus-5-5", "baseUrl": "http://evil"}),
        )
        .await;
    assert!(code == 422 || code == 400, "{code}");
    assert_eq!(c.pin_row().await, before, "a refused PUT wrote something");
    assert_eq!(c.model_audits().await, 0);
    // Positive control: the same route accepts a listed pair.
    let (code, _, _) = api
        .put_model(
            &c.op,
            json!({"provider": "anthropic", "model": "claude-opus-5-5"}),
        )
        .await;
    assert_eq!(code, 200);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn put_model_reads_hermes_afresh_and_never_trusts_an_earlier_list() {
    let c = connected("model-fresh", options_body()).await;
    let api = c.api();
    let (code, _, _) = api.get_models(&c.op).await;
    assert_eq!(code, 200);
    // Hermes logs out of Codex after the operator saw the list.
    let mut now = options_body();
    now["providers"][1]["authenticated"] = json!(false);
    *c.options.lock().unwrap() = (200, now);
    let (code, resp, _) = api
        .put_model(
            &c.op,
            json!({"provider": "openai-codex", "model": "gpt-6-sol"}),
        )
        .await;
    assert_eq!(
        (code, resp["error"]["code"].as_str()),
        (422, Some("cohosted_model_not_offered")),
        "{resp}"
    );
    // And when Hermes cannot be read at all, nothing is guessed from the pin.
    *c.options.lock().unwrap() = (500, json!({}));
    let (code, resp, _) = api
        .put_model(
            &c.op,
            json!({"provider": "anthropic", "model": "claude-opus-5-5"}),
        )
        .await;
    assert_eq!(
        (code, resp["error"]["code"].as_str()),
        (502, Some("cohosted_models_unavailable")),
        "{resp}"
    );
    assert_eq!(c.model_audits().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_model_routes_are_operator_only_and_need_a_connected_agent() {
    let c = connected("model-op", options_body()).await;
    let api = c.api();
    let (_, admin_email) = seed_human(&c.su, c.f.workspace, "admin", "model-admin").await;
    let stranger = seed(&c.su, "model-stranger").await;
    let admin = login(&c.http, &c.base, c.f.workspace, &admin_email).await;
    let other = login(&c.http, &c.base, stranger.workspace, &stranger.email).await;
    let seen = c.hits.count();
    let before = c.pin_row().await;
    for token in [&admin, &other] {
        assert_eq!(api.get_models(token).await.0, 403);
        assert_eq!(
            api.put_model(
                token,
                json!({"provider": "openai-codex", "model": "gpt-6-sol"})
            )
            .await
            .0,
            403
        );
    }
    assert_eq!(
        c.hits.count(),
        seen,
        "a stranger made Hermes answer a request"
    );
    assert_eq!(c.pin_row().await, before);
    assert_eq!(c.model_audits().await, 0);

    // A workspace with no connected agent: 409, and Hermes is not asked.
    let lone = seed(&c.su, "model-lone").await;
    let (port, hits, _) = mock_hermes(options_body()).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &lone.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let op = login(&c.http, &base, lone.workspace, &lone.email).await;
    let lone_api = Api {
        http: &c.http,
        base: &base,
        workspace: lone.workspace,
    };
    let (code, resp, _) = lone_api.get_models(&op).await;
    assert_eq!(
        (code, resp["error"]["code"].as_str()),
        (409, Some("cohosted_agent_not_connected"))
    );
    let (code, resp, _) = lone_api
        .put_model(
            &op,
            json!({"provider": "anthropic", "model": "claude-opus-5-5"}),
        )
        .await;
    assert_eq!(
        (code, resp["error"]["code"].as_str()),
        (409, Some("cohosted_agent_not_connected"))
    );
    assert_eq!(hits.count(), 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn put_model_says_the_pin_was_replaced_when_the_agent_is_re_pinned_to_a_team_link() {
    // #4159 L2: the agent is connected at the first read, and re-pinned to a team
    // link while Hermes is being asked. Not "not connected": a different cause.
    let c = connected("model-replaced", options_body()).await;
    *c.hits.repin_on_options.lock().unwrap() = Some((c.su.clone(), c.agent));
    let (code, resp, _) = c
        .api()
        .put_model(
            &c.op,
            json!({"provider": "openai-codex", "model": "gpt-6-sol"}),
        )
        .await;
    assert_eq!(
        (code, resp["error"]["code"].as_str()),
        (409, Some("cohosted_agent_pin_replaced")),
        "{resp}"
    );
    assert_eq!(c.model_audits().await, 0);
    let (kind, provider): (String, Option<String>) = sqlx::query_as(
        "SELECT kind, model_provider FROM agent_provider_pin WHERE agent_member_id = $1",
    )
    .bind(c.agent)
    .fetch_one(&c.su)
    .await
    .unwrap();
    assert_eq!((kind.as_str(), provider), ("team_link", None));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn connect_does_not_pin_a_current_provider_hermes_has_not_logged_in() {
    // #4159 L1: Hermes's current provider is not authenticated. The pin carries no
    // route (today's behaviour), not a pair nobody can answer on.
    let mut body = options_body();
    body["provider"] = json!("nous");
    body["model"] = json!("nous-hermes-4");
    body["providers"][2]["models"] = json!(["nous-hermes-4"]);
    let c = connected("model-unauth-current", body).await;
    assert_eq!(
        c.pin_row().await,
        (None, None, "hermes-agent".to_string()),
        "an unauthenticated current provider must not be pinned"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_models_throttle_is_checked_before_any_database_read() {
    // #4159 L5: a workspace with no connected agent still spends the budget, so the
    // 21st call is a 429, not a 21st DB read ending in 409.
    let c = connected("model-throttle", options_body()).await;
    let lone = seed(&c.su, "model-throttle-lone").await;
    let (port, hits, _) = mock_hermes(options_body()).await;
    let base = start_server(
        momo_app_pool().await,
        Declared {
            operator_email: &lone.email,
            env_url: format!("http://127.0.0.1:{port}/v1"),
            bearer: ENV_KEY,
            declared: true,
            tools_locked: true,
        },
    )
    .await;
    let op = login(&c.http, &base, lone.workspace, &lone.email).await;
    let api = Api {
        http: &c.http,
        base: &base,
        workspace: lone.workspace,
    };
    let limit = momo_server::routes::cohosted_agent::OPERATOR_MODEL_CALLS_PER_WINDOW;
    for call in 1..=limit {
        let (code, resp, _) = api.get_models(&op).await;
        assert_eq!(
            (code, resp["error"]["code"].as_str()),
            (409, Some("cohosted_agent_not_connected")),
            "call {call}"
        );
    }
    assert_eq!(api.get_models(&op).await.0, 429);
    let (code, _, _) = api
        .put_model(
            &op,
            json!({"provider": "anthropic", "model": "claude-opus-5-5"}),
        )
        .await;
    assert_eq!(code, 429, "PUT shares the budget");
    assert_eq!(hits.count(), 0);
}

// ---------------------------------------------------------------------------
// #4337 — the environment facts in the status (ADR-0203 증보 2026-10-25 수용 기준 2·4)
// ---------------------------------------------------------------------------

/// 수용 기준 4: the 200 body is the **whole** expected JSON for each configuration, so the handler is tied
/// to the assembly by value (a handler that stops calling it, or an assembly that empties `environment`,
/// is a different body). Four configurations: declared x platform x relay. Nothing is dialled: neither the
/// live agent mock nor the counting relay client sees a request, through status, probe and connect on an
/// undeclared instance.
///
/// Sabotage: delete the `require_instance_operator_write` line in `status` (the stranger test below goes
/// red); make `assemble_status` blank or change `environment` (the body comparison goes red).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_status_is_the_expected_body_with_the_environment_and_dials_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let http = reqwest::Client::new();
    struct Case {
        name: &'static str,
        declared: bool,
        platform: HostPlatform,
        platform_word: &'static str,
        relay_on: bool,
    }
    let cases = [
        Case {
            name: "undeclared, compose, relay off",
            declared: false,
            platform: HostPlatform::Compose,
            platform_word: "compose",
            relay_on: false,
        },
        Case {
            name: "undeclared, railway, relay on",
            declared: false,
            platform: HostPlatform::Railway,
            platform_word: "railway",
            relay_on: true,
        },
        Case {
            name: "declared, unknown, relay off",
            declared: true,
            platform: HostPlatform::Unknown,
            platform_word: "unknown",
            relay_on: false,
        },
        Case {
            name: "declared, railway, relay on",
            declared: true,
            platform: HostPlatform::Railway,
            platform_word: "railway",
            relay_on: true,
        },
    ];
    for case in cases {
        let f = seed(&su, "cohost-env").await;
        let (port, hits) = mock_agent(true, None).await;
        let relay_client = Arc::new(CountingRelay::default());
        let relay = if case.relay_on {
            LoginRelayConfig::new("https://relay.example.com", RELAY_KEY)
        } else {
            LoginRelayConfig::default()
        };
        let base = start_server_in(
            momo_app_pool().await,
            Declared {
                operator_email: &f.email,
                env_url: format!("http://127.0.0.1:{port}/v1"),
                bearer: ENV_KEY,
                declared: case.declared,
                tools_locked: true,
            },
            Environment {
                platform: case.platform,
                relay,
                relay_client: relay_client.clone(),
            },
        )
        .await;
        let api = Api {
            http: &http,
            base: &base,
            workspace: f.workspace,
        };
        let op = login(&http, &base, f.workspace, &f.email).await;

        let mut expected = json!({
            "schema": "momo.cohosted_agent.status.v0",
            "declaration": if case.declared { "ready" } else { "not_declared" },
            "toolsLockAttested": true,
            "connectable": case.declared,
            "environment": {
                "platform": case.platform_word,
                "loginRelay": if case.relay_on { "on" } else { "off" },
            },
        });
        if case.declared {
            expected["endpointLabel"] = json!(format!("http://127.0.0.1:{port}/v1"));
        }
        let (code, body, text) = api.status(&op).await;
        assert_eq!(code, 200, "{}: {text}", case.name);
        assert_eq!(body, expected, "{}", case.name);

        if !case.declared {
            // The whole family on an undeclared instance: still nothing leaves the server.
            let (code, probe, _) = api
                .post(&op, "/probe", Some(json!({"checkToolsets": true})))
                .await;
            assert_eq!(code, 200, "{}: {probe}", case.name);
            assert_eq!(probe["requestsSent"], 0, "{}", case.name);
            let (code, _, _) = api.post(&op, "/connect", None).await;
            assert_eq!(code, 409, "{}", case.name);
        }
        assert_eq!(
            hits.count(),
            0,
            "{}: a request reached the agent mock: {:?}",
            case.name,
            hits.paths()
        );
        assert_eq!(
            relay_client.calls(),
            0,
            "{}: a request reached the relay client",
            case.name
        );
    }
}

/// 수용 기준 4 (403) + 수용 기준 2 ([nightly] 절반): a workspace admin who is not a listed operator and
/// another tenant's operator get 403 and a body without `environment`; the probe and connect answers carry
/// none either; and no env string — the stamp, the Railway id, the relay URL, the relay key — reaches a 200
/// body, a 403 body, an audit row or the log, in each of the three platform-marker configurations (see the unit test
/// `no_env_string_reaches_the_body_or_the_logs` for why they are split).
///
/// Sabotage: delete the operator gate line in `status` (the 403 rows go red); serialize any env string
/// (a stamp, a relay label) into `environment`, or `warn!` it in the parser (the marker scans go red);
/// add `environment` to the probe or connect answer (the key check goes red).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_stranger_gets_no_environment_and_no_env_string_leaves_the_server() {
    ensure_schema_and_roles();
    const PLATFORM_MARKER: &str = "MARKER-PLATFORM-4337-pg";
    const RWENV_MARKER: &str = "MARKER-RWENV-4337-pg";
    const RELAY_HOST_MARKER: &str = "marker-relayurl-4337-pg";
    const RELAY_KEY_MARKER: &str = "MARKER-RELAYKEY-4337-pg-0123456789abcdef";
    let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
    let _guard = tracing_subscriber::fmt()
        .with_writer(BufferWriter(logs.clone()))
        .with_max_level(tracing::Level::TRACE)
        .set_default();
    let su = superuser_pool().await;
    let http = reqwest::Client::new();
    // (name, Railway id, stamp, the platform word the status must carry): a stamp that no table names is `unknown`.
    let configurations: [(&str, Option<&str>, Option<&str>, &str); 3] = [
        ("railway id only", Some(RWENV_MARKER), None, "railway"),
        ("stamp only", None, Some(PLATFORM_MARKER), "unknown"),
        ("both", Some(RWENV_MARKER), Some(PLATFORM_MARKER), "railway"),
    ];
    for (name, railway_id, stamp, platform_word) in configurations {
        let lookup = |key: &str| -> Option<String> {
            match key {
                "RAILWAY_ENVIRONMENT_ID" => railway_id.map(str::to_string),
                "MOMO_SELF_HOST_PLATFORM" => stamp.map(str::to_string),
                "HERMES_LOGIN_RELAY_URL" => {
                    Some(format!("https://{RELAY_HOST_MARKER}.example.com"))
                }
                "HERMES_LOGIN_RELAY_KEY" => Some(RELAY_KEY_MARKER.to_string()),
                _ => None,
            }
        };
        let platform = CohostedAgentConfig::from_lookup(lookup).platform;
        let relay = LoginRelayConfig::from_lookup(lookup);

        let f = seed(&su, "cohost-env-leak").await;
        let (_, admin_email) = seed_human(&su, f.workspace, "admin", "cohost-env-admin").await;
        let stranger = seed(&su, "cohost-env-stranger").await;
        let (port, _hits) = mock_agent(true, None).await;
        let base = start_server_in(
            momo_app_pool().await,
            Declared {
                operator_email: &f.email,
                env_url: format!("http://127.0.0.1:{port}/v1"),
                bearer: ENV_KEY,
                declared: true,
                tools_locked: true,
            },
            Environment {
                platform,
                relay,
                relay_client: Arc::new(CountingRelay::default()),
            },
        )
        .await;
        let api = Api {
            http: &http,
            base: &base,
            workspace: f.workspace,
        };
        let op = login(&http, &base, f.workspace, &f.email).await;
        let admin = login(&http, &base, f.workspace, &admin_email).await;
        let other = login(&http, &base, stranger.workspace, &stranger.email).await;

        let mut bodies: Vec<(String, String)> = Vec::new();
        let (code, body, text) = api.status(&op).await;
        assert_eq!(code, 200, "{name}: {text}");
        assert_eq!(
            body["environment"]["loginRelay"], "on",
            "{name}: the relay markers must make the relay on, or the scan proves nothing"
        );
        assert_eq!(body["environment"]["platform"], platform_word, "{name}");
        let mut keys: Vec<&str> = body["environment"]
            .as_object()
            .expect("environment is an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["loginRelay", "platform"], "{name}");
        bodies.push(("200 status".to_string(), text));

        for (who, token) in [("admin", &admin), ("other tenant", &other)] {
            let (code, body, text) = api.status(token).await;
            assert_eq!(code, 403, "{name}: {who}: {text}");
            assert!(
                body.get("environment").is_none() && !text.contains("environment"),
                "{name}: {who}: a 403 body carries environment: {text}"
            );
            bodies.push((format!("403 status ({who})"), text));
        }

        let (code, body, text) = api.post(&op, "/probe", None).await;
        assert_eq!(code, 200, "{name}: {text}");
        assert!(
            body.get("environment").is_none(),
            "{name}: probe carries environment"
        );
        bodies.push(("probe".to_string(), text));
        let (code, body, text) = api
            .post(
                &op,
                "/connect",
                Some(json!({"displayName": "Hermes", "handle": "hermes"})),
            )
            .await;
        assert_eq!(code, 201, "{name}: {text}");
        assert!(
            body.get("environment").is_none(),
            "{name}: connect carries environment"
        );
        bodies.push(("connect".to_string(), text));

        // The audit rows this workspace has by now (`connect` wrote its three): no env string may be in them
        // either (ADR F2: response, log, audit, error). Positive control: the connect row exists, so an
        // empty read cannot pass the scan.
        let audit: Vec<(String, Value)> = sqlx::query_as(
            "SELECT action, detail FROM audit_log WHERE workspace_id = $1 ORDER BY created_at",
        )
        .bind(f.workspace)
        .fetch_all(&su)
        .await
        .unwrap();
        assert!(
            audit
                .iter()
                .any(|(action, _)| action == "agent.cohosted.connected"),
            "{name}: positive control: the connect audit row must exist for the audit scan to mean anything"
        );
        bodies.push((
            "audit rows".to_string(),
            serde_json::to_string(&audit).unwrap(),
        ));

        let log_text = String::from_utf8_lossy(&logs.lock().unwrap()).to_ascii_lowercase();
        let mut markers = vec![RELAY_HOST_MARKER, RELAY_KEY_MARKER];
        markers.extend(railway_id);
        markers.extend(stamp);
        for marker in markers {
            let marker = marker.to_ascii_lowercase();
            for (what, text) in &bodies {
                assert!(
                    !text.to_ascii_lowercase().contains(&marker),
                    "{name}: {marker} leaked into the {what}: {text}"
                );
            }
            assert!(
                !log_text.contains(&marker),
                "{name}: {marker} leaked into the log"
            );
        }
        assert!(
            log_text.contains("cohosted agent connect probe"),
            "{name}: positive control: the log capture must hear the server"
        );
    }
}
