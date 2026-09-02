//! ADR-0181 / #1960 — welcome kickoff server half (UX-R2s).
//!
//! Red proofs (brief):
//!   ① same member joins twice → exactly one opener run
//!   ② provider missing → ProviderRequired message 1, opener 0;
//!      after provider linked, next entry → opener 1
//!   ③ rejoin (`createdMember:false`) → no trigger
//!   ④ no welcome agent (setting unset and no native agent) → no job, no error
//!   ⑤ opener run has a `usage_ledger` row
//!   ⑥ opener does not count toward the G2 consecutive auto-reply streak
//!   ⑦ settings validation: inactive agent id → 400, 2001-char prompt → 400
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test welcome_kickoff_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::agent_auto_reply_streak_in_tx;
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "welcome-kickoff-conformance-signing-secret";
const OWNER_PASSWORD: &str = "welcome-kickoff-owner-password";
const JOIN_PASSWORD: &str = "welcome-kickoff-join-password";
const AGENT_MODEL: &str = "hermes-agent";
const PROVIDER_REQUIRED_BODY: &str = "설정 › AI 연결에서 연결하고 돌아오면 시작해요";
const CONFIGURED_BEARER: &str = "sk-abcdefghijklmnopqrstuvwxyz012345";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
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

async fn role_pool(username: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username(username).password(password))
        .await
        .unwrap_or_else(|error| panic!("connect as {username} (bootstrap_roles.sql?): {error}"))
}

async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", &momo_app_password()).await
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
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
    *ready = true;
}

async fn settle_residual_worker_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = ANY($1) \
            AND status IN ('pending', 'processing')",
    )
    .bind(momo_outbox::WORKER_JOB_METHODS.map(str::to_string).to_vec())
    .execute(su)
    .await
    .expect("sweep residual worker agent_jobs");
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(RateLimitConfig {
        per_ip_limit: 0,
        claim_per_ip_limit: 0,
        ..RateLimitConfig::default()
    });
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

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_email: String,
    channel: Uuid,
    agent: Option<Uuid>,
}

async fn seed(su: &PgPool, hint: &str, with_agent: bool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

    let owner = Uuid::new_v4();
    let owner_handle = format!("owner-{}", &owner.to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&owner_handle)
    .execute(su)
    .await
    .expect("seed owner member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed workspace_membership");

    let owner_email = format!("{owner}@welcome.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&owner_email)
    .bind(OWNER_PASSWORD)
    .execute(su)
    .await
    .expect("seed owner human");

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'Team general channel', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'owner')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed owner membership");

    let agent = if with_agent {
        let agent = Uuid::new_v4();
        let handle = format!("hermes-{}", &agent.simple().to_string()[..8]);
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'agent', 'hermes', $3)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(&handle)
        .execute(su)
        .await
        .expect("seed agent member");
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                                max_concurrent_runs, max_run_steps) \
             VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(AGENT_MODEL)
        .execute(su)
        .await
        .expect("seed agent");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(workspace)
        .bind(agent)
        .execute(su)
        .await
        .expect("seed agent workspace membership");
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(workspace)
        .bind(channel)
        .bind(agent)
        .execute(su)
        .await
        .expect("seed agent channel membership");
        Some(agent)
    } else {
        None
    };

    Fixture {
        workspace,
        owner,
        owner_email,
        channel,
        agent,
    }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": OWNER_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn issue_invite(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    max_uses: i32,
) -> String {
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/invites"))
        .bearer_auth(token)
        .json(&json!({ "role": "member", "maxUses": max_uses }))
        .send()
        .await
        .expect("create invite");
    assert_eq!(response.status().as_u16(), 201, "invite create must be 201");
    let body: Value = response.json().await.expect("invite body");
    body["code"]
        .as_str()
        .expect("the create response carries the raw code")
        .to_string()
}

fn join_payload(code: &str, email: &str) -> Value {
    json!({
        "code": code,
        "email": email,
        "displayName": "Joining Human",
        "password": JOIN_PASSWORD,
        "timeZone": "Asia/Seoul",
    })
}

async fn post_join(http: &reqwest::Client, base: &str, payload: Value) -> (u16, Value) {
    let response = http
        .post(format!("{base}/v1/join"))
        .json(&payload)
        .send()
        .await
        .expect("join request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

async fn count_runs_like(su: &PgPool, workspace: Uuid, kind: &str) -> i64 {
    let pattern = format!("welcome:%:{kind}:v1");
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM agent_run \
          WHERE workspace_id = $1 AND idempotency_key LIKE $2",
    )
    .bind(workspace)
    .bind(pattern)
    .fetch_one(su)
    .await
    .expect("count welcome runs")
}

async fn count_welcome_jobs(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM outbox \
          WHERE workspace_id = $1 \
            AND kind = 'agent_job' \
            AND payload->>'created_from' = 'server.welcome.kickoff.v1'",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("count welcome jobs")
}

async fn count_ledger(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM usage_ledger WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count usage_ledger")
}

async fn agent_text_bodies(su: &PgPool, workspace: Uuid, agent: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT COALESCE(body, '') FROM message \
          WHERE workspace_id = $1 AND author_member_id = $2 AND type = 'text' \
          ORDER BY seq",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_all(su)
    .await
    .expect("read agent text bodies")
}

async fn worker(provider: Arc<dyn ChatProvider>, configured: bool) -> AgentWorker {
    let mut config = WorkerConfig::for_target(database_url());
    if configured {
        config.provider.bearer = CONFIGURED_BEARER.to_string();
    }
    AgentWorker::new(
        role_pool("momo_worker", &momo_worker_password()).await,
        provider,
        config,
    )
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn proof_1_and_3_same_member_twice_is_one_opener_rejoin_does_not_retrigger() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let fixture = seed(&su, "once", true).await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let first_code = issue_invite(&http, &base, &token, fixture.workspace, 5).await;
    let email = format!("ada-{}@welcome.test", Uuid::new_v4());

    let (first_status, first_body) =
        post_join(&http, &base, join_payload(&first_code, &email)).await;
    assert_eq!(first_status, 201, "first join creates: {first_body}");
    assert_eq!(first_body["createdMember"], json!(true));

    // A second unused invite: the same code is 409 already-redeemed, not a rejoin.
    let rejoin_code = issue_invite(&http, &base, &token, fixture.workspace, 5).await;
    let (second_status, second_body) =
        post_join(&http, &base, join_payload(&rejoin_code, &email)).await;
    assert_eq!(second_status, 200, "rejoin is 200: {second_body}");
    assert_eq!(second_body["createdMember"], json!(false));
    assert_eq!(
        count_welcome_jobs(&su, fixture.workspace).await,
        1,
        "rejoin must not enqueue a second welcome job"
    );

    let mock = Arc::new(MockChatProvider::echo());
    worker(mock, true)
        .await
        .drain_once()
        .await
        .expect("drain opener");
    assert_eq!(
        count_runs_like(&su, fixture.workspace, "opener").await,
        1,
        "same member joining twice must produce exactly one opener run"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn proof_2_provider_missing_then_linked_next_entry_opens() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let fixture = seed(&su, "prov", true).await;
    let agent = fixture.agent.expect("seeded agent");
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let code = issue_invite(&http, &base, &token, fixture.workspace, 5).await;

    let mock = Arc::new(MockChatProvider::echo());
    let unconfigured = worker(mock.clone(), false).await;

    let email_a = format!("a-{}@welcome.test", Uuid::new_v4());
    let (status_a, body_a) = post_join(&http, &base, join_payload(&code, &email_a)).await;
    assert_eq!(status_a, 201, "first entry: {body_a}");
    unconfigured.drain_once().await.expect("drain unconfigured");

    assert_eq!(
        count_runs_like(&su, fixture.workspace, "provider-required").await,
        1,
        "provider missing must consume the provider-required marker"
    );
    assert_eq!(
        count_runs_like(&su, fixture.workspace, "opener").await,
        0,
        "provider missing must not consume the opener marker"
    );
    let bodies = agent_text_bodies(&su, fixture.workspace, agent).await;
    assert_eq!(
        bodies,
        vec![PROVIDER_REQUIRED_BODY.to_string()],
        "provider-required copy is an agent-authored message: {bodies:?}"
    );
    assert_eq!(
        count_ledger(&su, fixture.workspace).await,
        0,
        "provider-required path writes no usage_ledger row"
    );
    assert!(
        mock.calls().is_empty(),
        "provider-required path must not call the model"
    );

    let configured = worker(mock.clone(), true).await;
    let email_b = format!("b-{}@welcome.test", Uuid::new_v4());
    let (status_b, body_b) = post_join(&http, &base, join_payload(&code, &email_b)).await;
    assert_eq!(status_b, 201, "next entry after provider linked: {body_b}");
    configured.drain_once().await.expect("drain configured");

    assert_eq!(
        count_runs_like(&su, fixture.workspace, "opener").await,
        1,
        "next entry after provider is linked must post the opener"
    );
    assert!(
        !mock.calls().is_empty(),
        "opener run must call the model once provider is linked"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn proof_4_no_welcome_agent_is_silent() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let fixture = seed(&su, "none", false).await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let code = issue_invite(&http, &base, &token, fixture.workspace, 3).await;
    let email = format!("none-{}@welcome.test", Uuid::new_v4());
    let (status, body) = post_join(&http, &base, join_payload(&code, &email)).await;
    assert_eq!(status, 201, "join still succeeds with no agent: {body}");
    assert_eq!(count_welcome_jobs(&su, fixture.workspace).await, 0);
    assert_eq!(count_runs_like(&su, fixture.workspace, "opener").await, 0);
    assert_eq!(
        count_runs_like(&su, fixture.workspace, "provider-required").await,
        0
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn proof_5_and_6_opener_bills_and_does_not_count_toward_g2() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let fixture = seed(&su, "bill", true).await;
    let agent = fixture.agent.expect("seeded agent");
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let code = issue_invite(&http, &base, &token, fixture.workspace, 3).await;
    let email = format!("bill-{}@welcome.test", Uuid::new_v4());
    let (status, body) = post_join(&http, &base, join_payload(&code, &email)).await;
    assert_eq!(status, 201, "{body}");

    let mock = Arc::new(MockChatProvider::echo());
    worker(mock, true)
        .await
        .drain_once()
        .await
        .expect("drain opener");

    assert_eq!(
        count_runs_like(&su, fixture.workspace, "opener").await,
        1,
        "opener run exists"
    );
    let ledger_for_opener: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint \
           FROM usage_ledger u \
           JOIN agent_run r ON r.id = u.run_id AND r.workspace_id = u.workspace_id \
          WHERE u.workspace_id = $1 \
            AND r.idempotency_key LIKE 'welcome:%:opener:v1'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("ledger for opener");
    assert_eq!(
        ledger_for_opener, 1,
        "opener run must write a usage_ledger row"
    );

    let streak = with_tenant_tx(&su, fixture.workspace, {
        let channel = fixture.channel;
        move |conn| {
            Box::pin(async move { agent_auto_reply_streak_in_tx(conn, channel, agent).await })
        }
    })
    .await
    .expect("g2 streak");
    assert_eq!(
        streak, 0,
        "opener text must not count toward the G2 consecutive auto-reply streak"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn proof_7_settings_reject_inactive_agent_and_overlong_prompt() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "set", true).await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let url = format!("{base}/v1/workspaces/{}/settings", fixture.workspace);

    let inactive = http
        .patch(&url)
        .bearer_auth(&token)
        .json(&json!({"welcome_agent_member_id": fixture.owner.to_string()}))
        .send()
        .await
        .expect("PATCH inactive agent");
    assert_eq!(inactive.status(), 400, "inactive agent id must 400");
    let inactive_body: Value = inactive.json().await.expect("inactive error");
    let inactive_msg = inactive_body["error"]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(
        !inactive_msg.starts_with("unknown settings key"),
        "must be an agent-eligibility error, not unknown-key: {inactive_msg}"
    );
    assert!(
        inactive_msg.contains("active agent"),
        "error must say the id is not an active agent: {inactive_msg}"
    );

    let too_long = http
        .patch(&url)
        .bearer_auth(&token)
        .json(&json!({"welcome_prompt": "가".repeat(2001)}))
        .send()
        .await
        .expect("PATCH 2001-char prompt");
    assert_eq!(too_long.status(), 400, "2001-char prompt must 400");
    let too_long_body: Value = too_long.json().await.expect("prompt error");
    let too_long_msg = too_long_body["error"]["message"]
        .as_str()
        .unwrap_or_default();
    assert!(
        !too_long_msg.starts_with("unknown settings key"),
        "must be a prompt-length error, not unknown-key: {too_long_msg}"
    );
    assert!(
        too_long_msg.contains("2000"),
        "error must name the 2000-character cap: {too_long_msg}"
    );
}
