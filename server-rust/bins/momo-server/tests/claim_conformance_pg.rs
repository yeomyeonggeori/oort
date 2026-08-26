//! ADR-0166 / T-1 — first-owner claim token, replayed against the real server.
//!
//! ```text
//! mint hash-only row → login 401 → POST /v1/claim → login 200
//!                    → reuse 409 → expired 410 → DB has no plaintext
//!                    → captured logs omit the raw token
//! ```
//!
//! `#[ignore]` because it needs a real Postgres. Run via
//! `scripts/verify_owner_claim.sh`.

use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_auth::{mint_owner_claim_token, OWNER_CLAIM_TOKEN_LEN};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "claim-conformance-app-signing-secret";
const CLAIM_PASSWORD: &str = "claim-conformance-owner-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(role: &str, env_key: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| format!("{role}_dev_pw"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(role: &str, env_key: &str) -> Result<PgPool, sqlx::Error> {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username(role)
        .password(&role_password(role, env_key));
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
}

async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", "MOMO_APP_PASSWORD")
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
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
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

async fn start_server(pool: PgPool, rate_limit: RateLimitConfig) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(rate_limit);
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
    token: String,
}

async fn seed_claim_pending(
    su: &PgPool,
    slug_hint: &str,
    expires_sql: &str,
    created_sql: &str,
) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
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

    let owner_email = format!("{owner}@claim.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, NULL)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&owner_email)
    .execute(su)
    .await
    .expect("seed owner human without password");

    let token = mint_owner_claim_token().expect("entropy");
    assert_eq!(token.len(), OWNER_CLAIM_TOKEN_LEN);
    let insert = format!(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, expires_at, created_at, kind) \
         VALUES ($1, $2, digest($3::text, 'sha256'), {expires_sql}, {created_sql}, \
                 'owner_bootstrap')"
    );
    sqlx::query(&insert)
        .bind(workspace)
        .bind(owner)
        .bind(&token)
        .execute(su)
        .await
        .expect("seed owner_claim");

    Fixture {
        workspace,
        owner,
        owner_email,
        token,
    }
}

async fn login_status(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> u16 {
    http.post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": password,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .status()
        .as_u16()
}

async fn post_claim(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    password: &str,
) -> (u16, Value) {
    let response = http
        .post(format!("{base}/v1/claim"))
        .json(&json!({ "token": token, "password": password }))
        .send()
        .await
        .expect("claim");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
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
async fn claim_issue_login_reject_consume_login_reuse_and_hash_only() {
    ensure_schema_and_roles();
    let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
    let _guard = tracing_subscriber::fmt()
        .with_writer(BufferWriter(logs.clone()))
        .with_max_level(tracing::Level::INFO)
        .set_default();

    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture =
        seed_claim_pending(&su, "claim-happy", "now() + interval '24 hours'", "now()").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();

    assert_eq!(
        login_status(
            &http,
            &base,
            fixture.workspace,
            &fixture.owner_email,
            CLAIM_PASSWORD,
        )
        .await,
        401,
        "unconsumed claim-pending owner must be refused by identity.rs login"
    );

    let (status, body) = post_claim(&http, &base, &fixture.token, CLAIM_PASSWORD).await;
    assert_eq!(status, 200, "claim consume must issue a session: {body}");
    assert!(
        body["accessToken"].as_str().is_some(),
        "claim 200 is a login response"
    );

    assert_eq!(
        login_status(
            &http,
            &base,
            fixture.workspace,
            &fixture.owner_email,
            CLAIM_PASSWORD,
        )
        .await,
        200,
        "after consume, the same password must log in"
    );

    let (reuse_status, reuse_body) = post_claim(&http, &base, &fixture.token, CLAIM_PASSWORD).await;
    assert_eq!(reuse_status, 409, "reuse must be refused: {reuse_body}");

    let stored: Vec<u8> = sqlx::query_scalar(
        "SELECT token_hash FROM credential_claim \
          WHERE workspace_id = $1 AND member_id = $2 \
            AND kind = 'owner_bootstrap'",
    )
    .bind(fixture.workspace)
    .bind(fixture.owner)
    .fetch_one(&su)
    .await
    .expect("read stored hash");
    assert_eq!(stored.len(), 32, "sha256 is 32 bytes");
    assert_ne!(
        stored.as_slice(),
        fixture.token.as_bytes(),
        "DB must not hold the raw token"
    );
    let matches: bool = sqlx::query_scalar(
        "SELECT token_hash = digest($1::text, 'sha256') FROM credential_claim \
          WHERE workspace_id = $2 AND member_id = $3 \
            AND kind = 'owner_bootstrap'",
    )
    .bind(&fixture.token)
    .bind(fixture.workspace)
    .bind(fixture.owner)
    .fetch_one(&su)
    .await
    .expect("hash matches raw");
    assert!(matches, "stored hash must be sha256 of the raw token");

    let log_bytes = logs.lock().expect("logs").clone();
    let log_text = String::from_utf8_lossy(&log_bytes);
    assert!(
        !log_text.contains(&fixture.token),
        "server logs must not contain the raw claim token"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_expired_claim_token_is_gone() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_claim_pending(
        &su,
        "claim-expired",
        "now() - interval '1 second'",
        "now() - interval '2 seconds'",
    )
    .await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let (status, body) = post_claim(&http, &base, &fixture.token, CLAIM_PASSWORD).await;
    assert_eq!(status, 410, "expired token must be 410: {body}");
    assert_eq!(
        login_status(
            &http,
            &base,
            fixture.workspace,
            &fixture.owner_email,
            CLAIM_PASSWORD,
        )
        .await,
        401,
        "an expired claim must not have set a password"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_unknown_claim_token_is_not_an_oracle() {
    ensure_schema_and_roles();
    let app_pool = momo_app_pool().await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = mint_owner_claim_token().expect("entropy");
    let (status, body) = post_claim(&http, &base, &token, CLAIM_PASSWORD).await;
    assert_eq!(status, 404, "unknown token must be 404: {body}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_public_claim_route_sheds_a_flood_from_one_address() {
    ensure_schema_and_roles();
    let app_pool = momo_app_pool().await;
    let base = start_server(
        app_pool,
        RateLimitConfig {
            claim_per_ip_limit: 2,
            ..RateLimitConfig::default()
        },
    )
    .await;
    let http = reqwest::Client::new();
    let token = "A".repeat(OWNER_CLAIM_TOKEN_LEN);
    let guess = |ip: &'static str| {
        let http = http.clone();
        let base = base.clone();
        let token = token.clone();
        async move {
            http.post(format!("{base}/v1/claim"))
                .header("x-forwarded-for", ip)
                .json(&json!({ "token": token, "password": "x" }))
                .send()
                .await
                .expect("claim guess")
        }
    };
    for attempt in 0..2 {
        assert_eq!(
            guess("198.51.100.9").await.status().as_u16(),
            404,
            "guess {attempt} is within the claim limit"
        );
    }
    assert_eq!(guess("198.51.100.9").await.status().as_u16(), 429);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_momo_app_can_execute_the_locked_claim_lookup() {
    ensure_schema_and_roles();
    let token = mint_owner_claim_token().expect("entropy");
    for (role, env_key) in [
        ("momo_relay", "MOMO_RELAY_PASSWORD"),
        ("momo_worker", "MOMO_WORKER_PASSWORD"),
    ] {
        let pool = role_pool(role, env_key)
            .await
            .unwrap_or_else(|error| panic!("connect as {role}: {error}"));
        let result = sqlx::query_scalar::<_, Option<Uuid>>(
            "SELECT momo_join_private.owner_claim_workspace_id($1::text)",
        )
        .bind(&token)
        .fetch_one(&pool)
        .await;
        assert!(
            result.is_err(),
            "{role} must not execute the locked claim lookup"
        );
    }
    let app = momo_app_pool().await;
    let resolved: Option<Uuid> =
        sqlx::query_scalar("SELECT momo_join_private.owner_claim_workspace_id($1::text)")
            .bind(&token)
            .fetch_one(&app)
            .await
            .expect("momo_app executes the locked lookup");
    assert!(resolved.is_none(), "unknown token resolves to no workspace");
}
