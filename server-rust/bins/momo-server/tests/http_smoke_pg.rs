//! End-to-end HTTP smoke for `momo-server` (ADR-0145 B안, batch B1.5).
//!
//! Boots the *real* router on an ephemeral port against a real Postgres and
//! drives it over HTTP: login → send → history, plus the 401/403 rejections.
//! `#[ignore]` because it needs a throwaway `pgvector/pgvector:pg18` superuser DB
//! with the runtime roles. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test http_smoke_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract: `DATABASE_URL` is a **superuser** (migrations via psql +
//! `infra/e2e/bootstrap_roles.sql`, fixture seeding bypasses RLS); the server
//! runs on the **`momo_app`** role (NOBYPASSRLS), so every assertion below is
//! made through the same RLS policies production uses.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB")
}

/// Committed test-only role password from `infra/e2e/bootstrap_roles.sql`.
fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

/// Test-only JWT signing secret. The server takes it as a parameter; nothing is
/// read from a file or from the ambient environment.
const TEST_JWT_SECRET: &str = "http-smoke-test-signing-secret";
const TEST_PASSWORD: &str = "smoke-test-password";

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

/// Boot the real router on an ephemeral port; returns its base URL.
async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
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

// ---------------------------------------------------------------------------
// fixtures (superuser → bypass RLS)
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    member: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let email = format!("{member}@smoke.test");

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
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
    // Password hashing is the DB's job (pgcrypto `momo_password_hash`), exactly
    // as in 005_auth_password_hash.sql — so the hash the server verifies is the
    // hash production stores.
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");

    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("smoke-{}", Uuid::new_v4()),
            topic: None,
            created_by: member,
        },
    )
    .await
    .expect("create channel");

    Fixture {
        workspace,
        member,
        email,
        channel: channel.id,
    }
}

// ---------------------------------------------------------------------------
// the smoke
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn http_smoke_login_send_list_and_401s() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    // ---- health (DB ping) ------------------------------------------------
    let health = http
        .get(format!("{base}/healthz"))
        .send()
        .await
        .expect("healthz");
    assert_eq!(health.status(), 200, "healthz is served");
    let health: Value = health.json().await.expect("health body");
    assert_eq!(health["status"], json!("ok"));
    assert_eq!(health["database"], json!("ok"), "health includes a DB ping");

    // ---- login -----------------------------------------------------------
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "valid credentials log in");
    let login: Value = response.json().await.expect("login body");
    let access_token = login["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string();
    assert!(
        login["refreshToken"].as_str().is_some(),
        "login returns a refresh token too"
    );
    assert_eq!(
        login["member"]["id"],
        json!(fixture.member.to_string()),
        "login resolves the seeded member"
    );
    assert_eq!(login["member"]["kind"], json!("human"));
    assert!(
        login["realtimeWebSocketUrl"]
            .as_str()
            .is_some_and(|url| url.starts_with("ws")),
        "ADR-0110: the realtime URL comes from the server"
    );

    // wrong password → 401 with the generic message (no account enumeration)
    let bad = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": "not-the-password",
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("bad login");
    assert_eq!(bad.status(), 401, "a wrong password is rejected");
    let bad: Value = bad.json().await.expect("error body");
    assert_eq!(
        bad["error"]["message"],
        json!("invalid credentials"),
        "error envelope is {{error:{{message}}}} (openapi ErrorResponse)"
    );

    // ---- send ------------------------------------------------------------
    let messages_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        fixture.workspace, fixture.channel
    );
    let client_msg_id = Uuid::new_v4();
    let sent = http
        .post(&messages_url)
        .bearer_auth(&access_token)
        .json(&json!({"clientMsgId": client_msg_id, "type": "text", "body": "hello over http"}))
        .send()
        .await
        .expect("send");
    assert_eq!(sent.status(), 201, "a committed message answers 201");
    let sent: Value = sent.json().await.expect("send body");
    assert_eq!(sent["seq"], json!(1), "first message in a channel is seq 1");
    assert_eq!(sent["body"], json!("hello over http"));
    assert_eq!(sent["type"], json!("text"));
    assert_eq!(sent["authorMemberId"], json!(fixture.member.to_string()));
    assert_eq!(sent["clientMsgId"], json!(client_msg_id.to_string()));

    // idempotent retry → same seq, still 201 (exactly-once effect)
    let retry = http
        .post(&messages_url)
        .bearer_auth(&access_token)
        .json(&json!({"clientMsgId": client_msg_id, "type": "text", "body": "hello over http"}))
        .send()
        .await
        .expect("retry");
    assert_eq!(retry.status(), 201);
    let retry: Value = retry.json().await.expect("retry body");
    assert_eq!(retry["seq"], json!(1), "a retry returns the original seq");
    assert_eq!(retry["id"], sent["id"], "and the original message id");

    // ---- history ---------------------------------------------------------
    let page = http
        .get(&messages_url)
        .bearer_auth(&access_token)
        .send()
        .await
        .expect("history");
    assert_eq!(page.status(), 200);
    let page: Value = page.json().await.expect("history body");
    let messages = page["messages"].as_array().expect("messages array");
    assert_eq!(
        messages.len(),
        1,
        "the retry did not create a second message"
    );
    assert_eq!(messages[0]["seq"], json!(1));
    assert_eq!(messages[0]["state"], json!("sent"));
    assert_eq!(page["nextBefore"], json!(1), "nextBefore = smallest seq");

    // limit is honoured and clamped
    let limited = http
        .get(format!("{messages_url}?limit=1"))
        .bearer_auth(&access_token)
        .send()
        .await
        .expect("history limit");
    assert_eq!(limited.status(), 200);

    // ---- 401 / 403 -------------------------------------------------------
    let anonymous = http
        .post(&messages_url)
        .json(&json!({"clientMsgId": Uuid::new_v4()}))
        .send()
        .await
        .expect("anonymous send");
    assert_eq!(anonymous.status(), 401, "no Authorization header → 401");
    let anonymous: Value = anonymous.json().await.expect("error body");
    assert_eq!(anonymous["error"]["message"], json!("missing bearer token"));

    let garbage = http
        .get(&messages_url)
        .bearer_auth("not.a.jwt")
        .send()
        .await
        .expect("garbage token");
    assert_eq!(garbage.status(), 401, "an unverifiable token → 401");
    let garbage: Value = garbage.json().await.expect("error body");
    assert_eq!(
        garbage["error"]["message"],
        json!("invalid or expired token")
    );

    let refresh_token = login["refreshToken"].as_str().expect("refreshToken");
    let wrong_typ = http
        .get(&messages_url)
        .bearer_auth(refresh_token)
        .send()
        .await
        .expect("refresh as access");
    assert_eq!(
        wrong_typ.status(),
        401,
        "a refresh token must never authenticate a request"
    );
    let wrong_typ: Value = wrong_typ.json().await.expect("error body");
    assert_eq!(wrong_typ["error"]["message"], json!("not an access token"));

    // a token for workspace A cannot address workspace B's path
    let foreign = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            Uuid::new_v4(),
            fixture.channel
        ))
        .bearer_auth(&access_token)
        .send()
        .await
        .expect("foreign workspace");
    assert_eq!(foreign.status(), 403, "workspace scope mismatch → 403");

    // a member of no channel cannot read it: seed a second member without
    // membership and log in as them.
    let outsider = Uuid::new_v4();
    let outsider_email = format!("{outsider}@smoke.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(outsider)
    .bind(fixture.workspace)
    .bind(outsider.to_string())
    .execute(&su)
    .await
    .expect("seed outsider");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(outsider)
    .bind(fixture.workspace)
    .bind(&outsider_email)
    .bind(TEST_PASSWORD)
    .execute(&su)
    .await
    .expect("seed outsider human");

    let outsider_login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": outsider_email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("outsider login")
        .json()
        .await
        .expect("outsider login body");
    let outsider_token = outsider_login["accessToken"].as_str().expect("token");
    let denied = http
        .get(&messages_url)
        .bearer_auth(outsider_token)
        .send()
        .await
        .expect("outsider history");
    assert_eq!(
        denied.status(),
        403,
        "a non-member of the channel is refused, not shown an empty page"
    );
}
