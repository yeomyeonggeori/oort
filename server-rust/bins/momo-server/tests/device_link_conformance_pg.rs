//! ADR-0180 / #1959 — device-link QR token (M0s server half).
//!
//! Red proofs (brief):
//!   ① expired token redeem → 401
//!   ② second redeem → 409
//!   ③ agent session cannot issue → 403
//!   ④ issuer logout then redeem → 401
//!   ⑤ public-origin mode: access 401 until confirm-sas, then 200
//!   ⑥ loopback mode: `pendingSas: false`, access 200 immediately
//!   ⑦ raw token never appears in logs or in any response except the issue 201
//!   ⑧ foreign-workspace RLS isolation
//!
//! The raw token is an exchange voucher, not a credential: presenting it as a
//! bearer against a protected route is 401.
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test device_link_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Assertion messages never interpolate the raw token.

use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "device-link-conformance-signing-secret";
const TEST_PASSWORD: &str = "device-link-test-password";

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

async fn start_server(pool: PgPool, advert: RealtimeAdvert) -> String {
    let app = build_app(AppState::new(pool, TEST_JWT_SECRET.to_string(), advert));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

fn loopback_advert() -> RealtimeAdvert {
    RealtimeAdvert::SameOrigin
}

fn public_advert() -> RealtimeAdvert {
    RealtimeAdvert::SameOrigin
}

struct Human {
    id: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    member: Human,
    agent: Uuid,
}

async fn seed_workspace(su: &PgPool, hint: &str) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@device-link.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(handle)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
    Human { id, email }
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid) -> Uuid {
    let agent = Uuid::new_v4();
    let handle = format!("ag-{}", &agent.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
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
    .expect("seed agent membership");
    agent
}

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = seed_workspace(su, hint).await;
    let member = seed_human(
        su,
        workspace,
        &format!("me-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let agent = seed_agent(su, workspace, member.id).await;
    Fixture {
        workspace,
        member,
        agent,
    }
}

struct Session {
    access: String,
    refresh: String,
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> Session {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    Session {
        access: body["accessToken"]
            .as_str()
            .expect("login returns an access token")
            .to_string(),
        refresh: body["refreshToken"]
            .as_str()
            .expect("login returns a refresh token")
            .to_string(),
    }
}

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'device-link-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn loopback_host(base: &str) -> String {
    base.trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string()
}

struct IssuedLink {
    id: String,
    token: String,
    sas: Option<String>,
    deep_link: String,
    raw_body: String,
}

/// Fail without printing `needle`. Used so a raw token cannot leak into the
/// cargo test output on a missed assertion.
fn assert_status(actual: u16, expected: u16) {
    assert_eq!(
        actual, expected,
        "unexpected HTTP status {actual} (expected {expected})"
    );
}

fn assert_omits_token(haystack: &str, token: &str) {
    if haystack.contains(token) {
        panic!("raw device-link token appeared where it must not");
    }
}

async fn issue_link(
    http: &reqwest::Client,
    base: &str,
    access: &str,
    host: &str,
    forwarded_proto: Option<&str>,
) -> (u16, Option<IssuedLink>) {
    let mut request = http
        .post(format!("{base}/v1/auth/device-link"))
        .header("authorization", format!("Bearer {access}"))
        .header("host", host);
    if let Some(proto) = forwarded_proto {
        request = request.header("x-forwarded-proto", proto);
    }
    let response = request.send().await.expect("issue device-link");
    let status = response.status().as_u16();
    let raw_body = response.text().await.unwrap_or_default();
    if status != 201 {
        return (status, None);
    }
    let body: Value = serde_json::from_str(&raw_body).unwrap_or(json!({}));
    let token = body["token"].as_str().unwrap_or("").to_string();
    let id = body["id"].as_str().unwrap_or("").to_string();
    let deep_link = body["deepLink"].as_str().unwrap_or("").to_string();
    if token.is_empty() || id.is_empty() {
        panic!("issue 201 missing id or token");
    }
    (
        status,
        Some(IssuedLink {
            id,
            token,
            sas: body["sas"].as_str().map(str::to_string),
            deep_link,
            raw_body,
        }),
    )
}

async fn redeem(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    host: &str,
    forwarded_proto: Option<&str>,
) -> (u16, Value) {
    let mut request = http
        .post(format!("{base}/v1/auth/device-link/redeem"))
        .header("host", host)
        .json(&json!({
            "token": token,
            "device": { "name": "Seongjae iPhone", "platform": "ios" },
        }));
    if let Some(proto) = forwarded_proto {
        request = request.header("x-forwarded-proto", proto);
    }
    let response = request.send().await.expect("redeem");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
}

async fn get_status(http: &reqwest::Client, base: &str, access: &str, id: &str) -> (u16, Value) {
    let response = http
        .get(format!("{base}/v1/auth/device-link/{id}"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("get device-link status");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
}

async fn confirm_sas(http: &reqwest::Client, base: &str, access: &str, id: &str) -> u16 {
    http.post(format!("{base}/v1/auth/device-link/{id}/confirm-sas"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("confirm-sas")
        .status()
        .as_u16()
}

async fn channels_status(http: &reqwest::Client, base: &str, workspace: Uuid, access: &str) -> u16 {
    http.get(format!("{base}/v1/workspaces/{workspace}/channels"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("channels probe")
        .status()
        .as_u16()
}

#[derive(Clone)]
struct BufferWriter(Arc<Mutex<Vec<u8>>>);

impl Write for BufferWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("log buffer").extend_from_slice(buf);
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
async fn expired_device_link_token_redeem_is_401() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "dl-expired").await;
    let base = start_server(app_pool, loopback_advert()).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let session = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let (status, issued) = issue_link(&http, &base, &session.access, &host, Some("http")).await;
    assert_status(status, 201);
    let issued = issued.expect("issued");

    sqlx::query(
        "UPDATE device_link_token SET expires_at = now() - interval '1 second' \
          WHERE id = $1::uuid",
    )
    .bind(&issued.id)
    .execute(&su)
    .await
    .expect("expire the live row");

    let (redeem_status, body) = redeem(&http, &base, &issued.token, &host, Some("http")).await;
    assert_omits_token(&body.to_string(), &issued.token);
    assert_status(redeem_status, 401);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn second_redeem_is_409() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "dl-reuse").await;
    let base = start_server(app_pool, loopback_advert()).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let session = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let (status, issued) = issue_link(&http, &base, &session.access, &host, Some("http")).await;
    assert_status(status, 201);
    let issued = issued.expect("issued");

    let (first, first_body) = redeem(&http, &base, &issued.token, &host, Some("http")).await;
    assert_status(first, 200);
    assert_eq!(first_body["pendingSas"], false);
    assert_omits_token(&first_body.to_string(), &issued.token);

    let (second, second_body) = redeem(&http, &base, &issued.token, &host, Some("http")).await;
    assert_omits_token(&second_body.to_string(), &issued.token);
    assert_status(second, 409);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn agent_session_cannot_issue_a_device_link() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "dl-agent").await;
    let base = start_server(app_pool, loopback_advert()).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let bearer = agent_bearer(&su, fixture.workspace, fixture.agent).await;
    let (status, issued) = issue_link(&http, &base, &bearer, &host, Some("http")).await;
    assert!(issued.is_none(), "agent must not receive a link token");
    assert_status(status, 403);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn issuer_logout_invalidates_an_unconsumed_token() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "dl-logout").await;
    let base = start_server(app_pool, loopback_advert()).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let session = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let (status, issued) = issue_link(&http, &base, &session.access, &host, Some("http")).await;
    assert_status(status, 201);
    let issued = issued.expect("issued");

    let logout = http
        .post(format!("{base}/v1/auth/logout"))
        .header("authorization", format!("Bearer {}", session.access))
        .json(&json!({ "refreshToken": session.refresh }))
        .send()
        .await
        .expect("logout");
    assert_status(logout.status().as_u16(), 200);

    let (redeem_status, body) = redeem(&http, &base, &issued.token, &host, Some("http")).await;
    assert_omits_token(&body.to_string(), &issued.token);
    assert_status(redeem_status, 401);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn public_origin_mode_holds_the_session_until_sas_confirm() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "dl-sas").await;
    let base = start_server(app_pool, public_advert()).await;
    let http = reqwest::Client::new();
    let session = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let host = "app.example.com";
    let (status, issued) = issue_link(&http, &base, &session.access, host, Some("https")).await;
    assert_status(status, 201);
    let issued = issued.expect("issued");
    let sas = issued.sas.expect("public-origin issue returns sas");
    assert_eq!(sas.len(), 4, "sas is four digits");
    assert!(sas.bytes().all(|b| b.is_ascii_digit()), "sas is digits");
    assert!(
        issued.deep_link.starts_with("oort://link?"),
        "deepLink uses the oort://link grammar"
    );
    assert!(
        issued
            .deep_link
            .contains("server=https%3A%2F%2Fapp.example.com"),
        "deepLink server is the request public origin"
    );

    let (redeem_status, body) = redeem(&http, &base, &issued.token, host, Some("https")).await;
    assert_status(redeem_status, 200);
    assert_eq!(body["pendingSas"], true);
    let phone_access = body["accessToken"]
        .as_str()
        .expect("redeem issues an access token")
        .to_string();
    assert_omits_token(&body.to_string(), &issued.token);

    assert_status(
        channels_status(&http, &base, fixture.workspace, &phone_access).await,
        401,
    );

    assert_status(
        confirm_sas(&http, &base, &session.access, &issued.id).await,
        200,
    );
    assert_status(
        channels_status(&http, &base, fixture.workspace, &phone_access).await,
        200,
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn loopback_mode_skips_sas_and_activates_immediately() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "dl-loopback").await;
    let base = start_server(app_pool, loopback_advert()).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let session = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let (status, issued) = issue_link(&http, &base, &session.access, &host, Some("http")).await;
    assert_status(status, 201);
    let issued = issued.expect("issued");
    assert!(issued.sas.is_none(), "loopback issue omits sas");

    let (redeem_status, body) = redeem(&http, &base, &issued.token, &host, Some("http")).await;
    assert_status(redeem_status, 200);
    assert_eq!(body["pendingSas"], false);
    let phone_access = body["accessToken"]
        .as_str()
        .expect("redeem issues an access token")
        .to_string();
    assert_status(
        channels_status(&http, &base, fixture.workspace, &phone_access).await,
        200,
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn raw_token_never_lands_in_logs_db_or_follow_up_responses() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
    let _guard = tracing_subscriber::fmt()
        .with_writer(BufferWriter(logs.clone()))
        .with_max_level(tracing::Level::DEBUG)
        .set_default();

    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "dl-grep").await;
    let base = start_server(app_pool, loopback_advert()).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let session = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let (status, issued) = issue_link(&http, &base, &session.access, &host, Some("http")).await;
    assert_status(status, 201);
    let issued = issued.expect("issued");

    // The issue body is the one sanctioned appearance.
    if !issued.raw_body.contains(&issued.token) {
        panic!("issue 201 must carry the raw token exactly once");
    }

    let (pending_status, pending_body) =
        get_status(&http, &base, &session.access, &issued.id).await;
    assert_status(pending_status, 200);
    assert_eq!(pending_body["status"], "pending");
    assert_omits_token(&pending_body.to_string(), &issued.token);

    let voucher = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels",
            fixture.workspace
        ))
        .header("authorization", format!("Bearer {}", issued.token))
        .send()
        .await
        .expect("voucher-as-bearer");
    assert_status(voucher.status().as_u16(), 401);

    let (redeem_status, redeem_body) =
        redeem(&http, &base, &issued.token, &host, Some("http")).await;
    assert_status(redeem_status, 200);
    assert_omits_token(&redeem_body.to_string(), &issued.token);

    let (consumed_status, consumed_body) =
        get_status(&http, &base, &session.access, &issued.id).await;
    assert_status(consumed_status, 200);
    assert_eq!(consumed_body["status"], "consumed");
    assert_omits_token(&consumed_body.to_string(), &issued.token);

    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM device_link_token WHERE id = $1::uuid")
            .bind(&issued.id)
            .fetch_one(&su)
            .await
            .expect("read stored hash");
    assert_eq!(stored.len(), 32, "sha256 is 32 bytes");
    assert_ne!(
        stored.as_slice(),
        issued.token.as_bytes(),
        "DB must not hold the raw token"
    );
    let matches: bool = sqlx::query_scalar(
        "SELECT token_hash = digest($1::text, 'sha256') FROM device_link_token \
          WHERE id = $2::uuid",
    )
    .bind(&issued.token)
    .bind(&issued.id)
    .fetch_one(&su)
    .await
    .expect("hash matches raw");
    assert!(matches, "stored hash must be sha256 of the raw token");

    let log_bytes = logs.lock().expect("logs").clone();
    let log_text = String::from_utf8_lossy(&log_bytes);
    assert_omits_token(&log_text, &issued.token);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn device_link_rows_are_invisible_from_another_workspace() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let a = seed(&su, "dl-rls-a").await;
    let b = seed(&su, "dl-rls-b").await;
    let base = start_server(app_pool.clone(), loopback_advert()).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let session_a = login(&http, &base, a.workspace, &a.member.email).await;
    let session_b = login(&http, &base, b.workspace, &b.member.email).await;
    let (status, issued) = issue_link(&http, &base, &session_a.access, &host, Some("http")).await;
    assert_status(status, 201);
    let issued = issued.expect("issued");

    let (foreign, body) = get_status(&http, &base, &session_b.access, &issued.id).await;
    assert_omits_token(&body.to_string(), &issued.token);
    assert_status(foreign, 404);

    let visible: i64 = momo_db::with_tenant_tx(&app_pool, b.workspace, {
        let id = issued.id.clone();
        move |conn| {
            Box::pin(async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*)::bigint FROM device_link_token WHERE id = $1::uuid",
                )
                .bind(id)
                .fetch_one(&mut *conn)
                .await
                .map_err(momo_db::DbError::from)
            })
        }
    })
    .await
    .expect("tenant B count");
    assert_eq!(visible, 0, "RLS must hide workspace A's device-link row");
}
