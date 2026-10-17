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
//! `#[ignore]`: needs a real Postgres, same harness as `agent_provider_pin_conformance_pg.rs`.

use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_provider_probe::GuardedProviderProbe;
use momo_server::config::{CohostedAgentConfig, SettingsConfig};
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

async fn start_server(pool: PgPool, d: Declared<'_>) -> String {
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
        },
        Arc::new(GuardedProviderProbe::new(
            EgressPolicy {
                allow_local: true,
                local_hosts: Vec::new(),
                operator_hosts: Vec::new(),
            },
            std::time::Duration::from_secs(5),
        )),
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

    // The connect probe is the same two fixed requests.
    assert_eq!(hits.paths(), vec!["/health", "/v1/models"]);

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
