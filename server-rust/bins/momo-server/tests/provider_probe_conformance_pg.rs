//! #2960 — 「연결 확인」 dials the provider, through the real route.
//!
//! The link is stored through `PUT /v1/provider/link` exactly as the panel does,
//! pointing at a loopback mock in the OpenAI and Anthropic shapes (storable
//! because this is `local` with the loopback opt-in on — ADR-0004 증보 5 D4),
//! and `POST /v1/provider/link/test` is asserted on what it reports:
//!
//! * success with the provider-stated numbers (model count, rate-limit headers);
//! * a refused key as `provider_auth_failed`, with the mock echoing that key in
//!   its body and a header — the key appears in no response and no audit row;
//! * the per-link throttle (a second check inside the window reuses the report,
//!   the mock is hit once) and the per-operator window (429 + Retry-After).
//!
//! The SSRF, rebinding, redirect and OpenRouter/xAI shapes are the probe crate's
//! own suite (`crates/momo-provider-probe/src/tests.rs`).
//!
//! `#[ignore]`: needs a real Postgres, same harness as `settings_conformance_pg.rs`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_server::config::SettingsConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as http_smoke_pg.rs / client_rewire_smoke_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "provider-probe-conformance-app-signing-secret";
/// Deliberately different from the app secret, for the same reason B4 split the
/// Centrifugo key: a provider-bearer leak must not become a token-signing leak.
const TEST_PROVIDER_MASTER_KEY: &str = "provider-probe-conformance-provider-master-key";
const TEST_PASSWORD: &str = "provider-probe-conformance-password";

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

/// Boot the router with the settings surface CONFIGURED — the deployed shape.
/// `platform_admin_emails` carries the fixture operator, which is the
/// listed-instance-operator path MOMO-583 defines; the fixture never mints a
/// `platform:read` token, so this is the path under test.
async fn start_server(pool: PgPool, operator_email: &str) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(TEST_PROVIDER_MASTER_KEY.to_string()),
        env_provider: momo_settings::ProviderConfig {
            allow_local_loopback: true,
            ..Default::default()
        },
        platform_admin_emails: vec![operator_email.to_ascii_lowercase()],
        environment: "local".to_string(),
    })
    // The operator opt-in (flag on): physical loopback is admitted, so the
    // mock is reachable through the real guarded client.
    .with_provider_probe(Arc::new(momo_provider_probe::GuardedProviderProbe::new(
        momo_settings::EgressPolicy {
            allow_local: true,
            local_hosts: Vec::new(),
            operator_hosts: Vec::new(),
        },
        std::time::Duration::from_secs(5),
    )));
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

// ---------------------------------------------------------------------------
// fixtures (superuser → bypass RLS)
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    email: String,
}

/// One workspace with one **verified-email owner**. Both halves matter: the
/// settings surfaces are owner/admin gated, and the instance-global ones
/// additionally require `human.email_verified = true` before the allow-list is
/// even consulted.
async fn seed(su: &PgPool, slug_hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

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
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace_membership");

    let email = format!("{member}@probe.test");
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

    Fixture { workspace, email }
}

async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
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

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const GOOD: &str = "sk-probe-live-good-0001";
const BAD: &str = "sk-probe-live-bad-9999";

fn echo_refusal(key: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        axum::http::StatusCode::UNAUTHORIZED,
        [("x-echo-key", key.to_string())],
        format!(r#"{{"error":{{"message":"Incorrect API key provided: {key}"}}}}"#),
    )
        .into_response()
}

/// OpenAI-shaped and Anthropic-shaped `/v1/models`, counting every hit.
async fn provider_mock() -> (u16, Arc<AtomicUsize>) {
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use axum::routing::get;
    let hits = Arc::new(AtomicUsize::new(0));
    let (h1, h2) = (hits.clone(), hits.clone());
    let app = axum::Router::new()
        .route(
            "/openai/v1/models",
            get(move |headers: HeaderMap| {
                let hits = h1.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let key = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.strip_prefix("Bearer "))
                        .unwrap_or("")
                        .to_string();
                    if key != GOOD {
                        return echo_refusal(&key);
                    }
                    (
                        [
                            ("x-ratelimit-limit-requests", "5000"),
                            ("x-ratelimit-remaining-requests", "4999"),
                        ],
                        axum::Json(json!({"object": "list", "data": [{"id": "a"}, {"id": "b"}, {"id": "c"}]})),
                    )
                        .into_response()
                }
            }),
        )
        .route(
            "/anthropic/v1/models",
            get(move |headers: HeaderMap| {
                let hits = h2.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let key = headers
                        .get("x-api-key")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    if key != GOOD || headers.contains_key("authorization") {
                        return echo_refusal(&key);
                    }
                    (
                        [("anthropic-ratelimit-requests-limit", "50")],
                        axum::Json(json!({"data": [{"id": "claude-a"}, {"id": "claude-b"}], "has_more": false})),
                    )
                        .into_response()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, hits)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_connection_check_dials_the_provider() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "probe").await;
    let base = start_server(app_pool, &fixture.email).await;
    let http = reqwest::Client::new();
    sqlx::query("DELETE FROM provider_link")
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("DELETE FROM provider_link_chain")
        .execute(&su)
        .await
        .unwrap();
    let token = login(&http, &base, &fixture).await;
    let (port, hits) = provider_mock().await;

    let put = |body: Value| {
        let request = http
            .put(format!("{base}/v1/provider/link"))
            .bearer_auth(&token)
            .json(&body);
        async move {
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), 200, "{:?}", response.text().await);
        }
    };
    let check = || {
        let request = http
            .post(format!("{base}/v1/provider/link/test"))
            .bearer_auth(&token);
        async move { request.send().await.unwrap() }
    };
    let check_json = || async {
        let response = check().await;
        assert_eq!(response.status(), 200);
        let text = response.text().await.unwrap();
        assert!(
            !text.contains(GOOD) && !text.contains(BAD),
            "a key reached the response: {text}"
        );
        serde_json::from_str::<Value>(&text).unwrap()
    };

    // -- 1. OpenAI shape, good key: dialled, numbers are the provider's -------
    put(json!({"baseUrl": format!("http://127.0.0.1:{port}/openai/v1"), "bearer": GOOD})).await;
    let probe = check_json().await;
    assert_eq!(probe["ok"], json!(true), "{probe}");
    assert_eq!(probe.get("reason"), None, "{probe}");
    assert_eq!(probe["cascadeOk"], json!(true));
    let entry = &probe["entries"][0];
    assert_eq!(entry["disposition"], "ok");
    assert_eq!(entry["probe"]["outcome"], "ok");
    assert_eq!(entry["probe"]["method"], "models");
    assert_eq!(entry["probe"]["httpStatus"], json!(200));
    assert_eq!(entry["probe"]["modelCount"], json!(3));
    assert_eq!(entry["probe"]["rateLimit"]["source"], "x-ratelimit");
    assert_eq!(entry["probe"]["rateLimit"]["requestsLimit"], json!(5000));
    assert_eq!(
        entry["probe"]["rateLimit"]["requestsRemaining"],
        json!(4999)
    );
    assert_eq!(entry["probe"]["cached"], json!(false));
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // -- 2. per-link throttle: the same link inside the window is not re-dialled
    let again = check_json().await;
    assert_eq!(again["ok"], json!(true));
    assert_eq!(
        again["entries"][0]["probe"]["cached"],
        json!(true),
        "{again}"
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "the provider was dialled twice"
    );

    // -- 3. a refused key, echoed back by the provider, goes nowhere ---------
    put(json!({"baseUrl": format!("http://127.0.0.1:{port}/openai/v1"), "bearer": BAD})).await;
    let refused = check_json().await;
    assert_eq!(refused["ok"], json!(false));
    assert_eq!(refused["reason"], "provider_auth_failed", "{refused}");
    assert_eq!(refused["entries"][0]["probe"]["outcome"], "rejected");
    assert_eq!(refused["entries"][0]["probe"]["httpStatus"], json!(401));
    assert_eq!(refused["entries"][0]["disposition"], "propagate");
    assert_eq!(hits.load(Ordering::SeqCst), 2, "a new key is a new link");

    // -- 4. Anthropic key: the envelope kind picks x-api-key -----------------
    put(json!({
        "baseUrl": format!("http://127.0.0.1:{port}/anthropic/v1"),
        "bearer": GOOD,
        "format": "anthropic",
    }))
    .await;
    let anthropic = check_json().await;
    assert_eq!(anthropic["ok"], json!(true), "{anthropic}");
    assert_eq!(anthropic["entries"][0]["probe"]["modelCount"], json!(2));
    assert_eq!(
        anthropic["entries"][0]["probe"]["rateLimit"]["source"],
        "anthropic-ratelimit"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 3);

    // No audit row carries either key.
    let leaked: i64 = sqlx::query(
        "SELECT count(*)::bigint FROM audit_log WHERE detail::text LIKE $1 OR detail::text LIKE $2",
    )
    .bind(format!("%{GOOD}%"))
    .bind(format!("%{BAD}%"))
    .fetch_one(&su)
    .await
    .unwrap()
    .get::<i64, _>(0);
    assert_eq!(leaked, 0, "a key reached audit_log");

    // -- 5. per-operator window: 4 checks so far, the limit is 6 per minute --
    assert_eq!(check().await.status(), 200);
    assert_eq!(check().await.status(), 200);
    let limited = check().await;
    assert_eq!(limited.status(), 429, "the seventh check in a minute");
    let retry_after: u64 = limited
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .expect("Retry-After");
    assert!((1..=60).contains(&retry_after), "{retry_after}");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        3,
        "a refused check dials nothing"
    );
}
