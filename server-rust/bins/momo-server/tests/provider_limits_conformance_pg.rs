//! #3886 — 「한도·남은 크레딧」 through the real routes.
//!
//! * a provider that answers 402 (and echoes the presented key in the body and a
//!   header) is reported as `provider_no_credit`, and the key is in no response
//!   and no audit row;
//! * `GET /v1/provider/limits` computes this month's spend ESTIMATE from the
//!   ledger's tokens and `model_pricing` (Anthropic rows are seeded by 137), keeps
//!   a model with no price out of the dollars and names it, and ignores last month;
//! * `PUT /v1/provider/limits/budget` stores the operator's figure, rejects a bad
//!   company or amount, clears on `null`, and is refused to a non-operator;
//! * red proof: an ordinary tenant transaction (no `app.provider_link_admin`) can
//!   neither read nor write `provider_key_budget`.
//!
//! `#[ignore]`: needs a real Postgres, same harness as `provider_probe_conformance_pg.rs`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
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
    start_server_for(pool, &[operator_email]).await
}

/// [`start_server`] with several listed instance operators (#3040: two
/// operators of one instance, each in their own workspace).
async fn start_server_for(pool: PgPool, operator_emails: &[&str]) -> String {
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
        platform_admin_emails: operator_emails
            .iter()
            .map(|email| email.to_ascii_lowercase())
            .collect(),
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

use std::sync::Arc;

const GOOD: &str = "sk-limits-live-good-0001";

/// A provider whose `/v1/models` says "pay up" and repeats the key it was given.
async fn pay_mock() -> u16 {
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use axum::routing::get;
    let app = axum::Router::new().route(
        "/v1/models",
        get(move |headers: HeaderMap| async move {
            let key = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .unwrap_or("")
                .to_string();
            (
                axum::http::StatusCode::PAYMENT_REQUIRED,
                [("x-echo-key", key.clone())],
                format!(r#"{{"error":{{"code":402,"message":"no credits for {key}"}}}}"#),
            )
                .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

async fn ledger_row(
    su: &PgPool,
    fixture: &Fixture,
    model: &str,
    prompt: i32,
    completion: i32,
    cached: i32,
    created_at: &str,
) {
    // The human fixture member stands in as the agent: the ledger only needs a
    // member id (FK), not an agent row.
    let member: Uuid = sqlx::query_scalar("SELECT id FROM member WHERE workspace_id = $1 LIMIT 1")
        .bind(fixture.workspace)
        .fetch_one(su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO usage_ledger \
           (workspace_id, agent_member_id, model, prompt_tokens, completion_tokens, \
            cached_tokens, cost_micro_usd, was_estimated, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 0, true, $7::timestamptz)",
    )
    .bind(fixture.workspace)
    .bind(member)
    .bind(model)
    .bind(prompt)
    .bind(completion)
    .bind(cached)
    .bind(created_at)
    .execute(su)
    .await
    .expect("seed usage_ledger");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_402_is_no_credit_and_the_key_goes_nowhere() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "limits402").await;
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
    let port = pay_mock().await;

    let put = http
        .put(format!("{base}/v1/provider/link"))
        .bearer_auth(&token)
        .json(&json!({"baseUrl": format!("http://127.0.0.1:{port}/v1"), "bearer": GOOD}))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let response = http
        .post(format!("{base}/v1/provider/link/test"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    assert!(!text.contains(GOOD), "the key reached the response: {text}");
    assert!(
        !text.contains("no credits"),
        "provider text reached the response: {text}"
    );
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["reason"], "provider_no_credit", "{body}");
    assert_eq!(body["entries"][0]["probe"]["outcome"], "no_credit");
    assert_eq!(body["entries"][0]["probe"]["httpStatus"], json!(402));

    // No audit row holds the key either.
    let audit: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM audit_log a WHERE a.workspace_id = $1")
            .bind(fixture.workspace)
            .fetch_all(&su)
            .await
            .unwrap_or_default();
    for row in audit {
        assert!(!row.to_string().contains(GOOD), "key in audit: {row}");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn limits_estimate_spend_from_the_ledger_and_store_the_operators_budget() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "limits").await;
    let base = start_server(app_pool.clone(), &fixture.email).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    sqlx::query("DELETE FROM provider_key_budget")
        .execute(&su)
        .await
        .unwrap();

    // This UTC month: two priced Anthropic runs, one cached, one unpriced OpenAI.
    let now = chrono::Utc::now();
    let this_month = now.format("%Y-%m-02T12:00:00Z").to_string();
    let last_month = (now - chrono::Duration::days(40))
        .format("%Y-%m-%dT12:00:00Z")
        .to_string();
    // sonnet-5-5: $2 in / $10 out / $0.20 cache read per MTok (migration 137).
    //   run 1: 1,000,000 uncached in -> 2,000,000 + 100,000 out -> 1,000,000 = 3,000,000
    ledger_row(
        &su,
        &fixture,
        "claude-sonnet-5-5",
        1_000_000,
        100_000,
        0,
        &this_month,
    )
    .await;
    //   run 2 (dated id, prefix match): 1,000,000 in of which 500,000 cached ->
    //   500,000*2 + 500,000*0.2 = 1,100,000; 0 out
    ledger_row(
        &su,
        &fixture,
        "claude-sonnet-5-5-20261001",
        1_000_000,
        0,
        500_000,
        &this_month,
    )
    .await;
    ledger_row(&su, &fixture, "gpt-9-unpriced", 5_000, 500, 0, &this_month).await;
    // Last month is not this month.
    ledger_row(
        &su,
        &fixture,
        "claude-sonnet-5-5",
        9_000_000,
        0,
        0,
        &last_month,
    )
    .await;

    let get = |t: String| {
        let request = http
            .get(format!("{base}/v1/provider/limits"))
            .bearer_auth(t);
        async move { request.send().await.unwrap() }
    };
    let response = get(token.clone()).await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    let company = |body: &Value, name: &str| {
        body["companies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["company"] == name)
            .cloned()
            .unwrap()
    };
    let anthropic = company(&body, "anthropic");
    assert_eq!(
        anthropic["spendEstimate"]["microUsd"],
        json!(4_100_000),
        "{anthropic}"
    );
    assert_eq!(anthropic["spendEstimate"]["runs"], json!(2));
    assert_eq!(anthropic["spendEstimate"]["unpricedRuns"], json!(0));
    assert_eq!(anthropic.get("monthlyBudgetMicroUsd"), None);
    let openai = company(&body, "openai");
    assert_eq!(openai["spendEstimate"]["microUsd"], json!(0));
    assert_eq!(openai["spendEstimate"]["unpricedRuns"], json!(1));
    assert_eq!(
        openai["spendEstimate"]["unpricedModels"],
        json!(["gpt-9-unpriced"])
    );
    assert!(!body.to_string().contains("bearer"), "{body}");

    // Budget: set, read back, clear.
    let put = |payload: Value| {
        let request = http
            .put(format!("{base}/v1/provider/limits/budget"))
            .bearer_auth(&token)
            .json(&payload);
        async move { request.send().await.unwrap() }
    };
    let saved = put(json!({"company": "anthropic", "monthlyBudgetUsd": 100})).await;
    assert_eq!(saved.status(), 200);
    let saved: Value = saved.json().await.unwrap();
    assert_eq!(
        company(&saved, "anthropic")["monthlyBudgetMicroUsd"],
        json!(100_000_000)
    );
    assert_eq!(
        put(json!({"company": "gemini", "monthlyBudgetUsd": 1}))
            .await
            .status(),
        400
    );
    assert_eq!(
        put(json!({"company": "openai", "monthlyBudgetUsd": -1}))
            .await
            .status(),
        400
    );
    assert_eq!(
        put(json!({"company": "openai", "monthlyBudgetUsd": 1e12}))
            .await
            .status(),
        400
    );
    assert_eq!(
        put(json!({"company": "openai", "monthlyBudgetUsd": 1, "extra": 1}))
            .await
            .status(),
        422
    );
    let cleared: Value = put(json!({"company": "anthropic", "monthlyBudgetUsd": null}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        company(&cleared, "anthropic").get("monthlyBudgetMicroUsd"),
        None
    );

    // A stranger (a second workspace's owner who is not a listed operator).
    let other = seed(&su, "limits-stranger").await;
    let other_token = login(&http, &base, &other).await;
    assert_eq!(get(other_token.clone()).await.status(), 403);
    let denied = http
        .put(format!("{base}/v1/provider/limits/budget"))
        .bearer_auth(&other_token)
        .json(&json!({"company": "anthropic", "monthlyBudgetUsd": 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        denied.status(),
        403,
        "a non-operator must not write the budget"
    );

    // Red proof: without the operator GUC the table is invisible and unwritable.
    sqlx::query(
        "INSERT INTO provider_key_budget (company, monthly_budget_micro_usd) VALUES ('xai', 5)",
    )
    .execute(&su)
    .await
    .unwrap();
    let mut tx = app_pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(fixture.workspace.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM provider_key_budget")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(visible, 0, "a tenant tx must not see the budget table");
    let write = sqlx::query(
        "INSERT INTO provider_key_budget (company, monthly_budget_micro_usd) VALUES ('openai', 1)",
    )
    .execute(&mut *tx)
    .await;
    assert!(
        write.is_err(),
        "a tenant tx must not write the budget table"
    );
    let _ = tx.rollback().await;
    sqlx::query("DELETE FROM provider_key_budget")
        .execute(&su)
        .await
        .unwrap();
}
