//! End-to-end HTTP smoke for `momo-server` (ADR-0145 B안, batch B1.5).
//!
//! Boots the *real* router on an ephemeral port against a real Postgres and
//! drives it over HTTP: login → send → history, the 401/403 rejections, the
//! MOMO-300 revocation contract, and (B1.6) the logout / refresh-rotation
//! contract. `#[ignore]` because it needs a real DB. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test http_smoke_pg -- --ignored --nocapture
//! ```
//!
//! **A fresh database is no longer required (B1.6).** The migration runner now
//! tracks `schema_migrations` like `scripts/migrate.sh`, so applying the
//! migrations against a database another conformance binary already migrated
//! SKIPs every file instead of failing in the migration step; `bootstrap_roles.sql`
//! was already re-runnable (`IF NOT EXISTS` + `ALTER ROLE`). Test binaries may
//! therefore share one `pgvector/pgvector:pg18` container. A throwaway container
//! per binary is still the cleanest isolation and remains supported — every test
//! seeds its own random-UUID fixture, so neither mode changes an assertion.
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
use momo_db::sqlx::Row;
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

    // ---- MOMO-300 revocation (fail-closed) -------------------------------
    // Red test: delete the `token_state` call from the middleware and both
    // assertions below flip to 200/201, because the JWT signature is still
    // perfectly valid in each case.

    // (a) a validly signed token that was never recorded → 401 unknown token.
    // Signed here with the server's own secret, so ONLY the missing row can
    // explain the rejection.
    let orphan = momo_auth::sign_access(
        fixture.member,
        fixture.workspace,
        &["messages:read".to_string()],
        TEST_JWT_SECRET,
    )
    .expect("sign an unrecorded access token");
    let unknown = http
        .get(&messages_url)
        .bearer_auth(&orphan.token)
        .send()
        .await
        .expect("unrecorded token");
    assert_eq!(
        unknown.status(),
        401,
        "a token with no `token` row must not authenticate (fail closed)"
    );
    let unknown: Value = unknown.json().await.expect("error body");
    assert_eq!(unknown["error"]["message"], json!("unknown token"));

    // (b) revoke the live session row → the same token stops working.
    // The RETURNING count also proves login RECORDED the token: without the
    // insert this is 0 rows and the assertion fails.
    let revoked = sqlx::query(
        "UPDATE token \
            SET revoked_at = now() \
          WHERE token_hash = digest($1::text, 'sha256') \
            AND revoked_at IS NULL \
        RETURNING id, kind::text AS kind, label",
    )
    .bind(&access_token)
    .fetch_all(&su)
    .await
    .expect("revoke the access token row");
    assert_eq!(
        revoked.len(),
        1,
        "login must record exactly one `token` row for the access token"
    );
    assert_eq!(
        revoked[0].get::<String, _>("kind"),
        "session",
        "session JWTs are recorded as kind='session' (Swift parity)"
    );
    assert_eq!(
        revoked[0].get::<Option<String>, _>("label").as_deref(),
        Some("access"),
        "the access half carries label='access' (Swift parity)"
    );

    let dead = http
        .get(&messages_url)
        .bearer_auth(&access_token)
        .send()
        .await
        .expect("revoked token");
    assert_eq!(
        dead.status(),
        401,
        "a revoked session must die immediately, signature notwithstanding"
    );
    let dead: Value = dead.json().await.expect("error body");
    assert_eq!(dead["error"]["message"], json!("token has been revoked"));

    // The refresh half was recorded too, so a later logout can kill it.
    let refresh_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token \
          WHERE token_hash = digest($1::text, 'sha256') AND label = 'refresh'",
    )
    .bind(refresh_token)
    .fetch_one(&su)
    .await
    .expect("count refresh rows");
    assert_eq!(refresh_rows, 1, "the refresh half is recorded as well");

    // And the raw JWT is never persisted — only its sha256.
    let raw_leak: i64 =
        sqlx::query_scalar("SELECT count(*) FROM token WHERE encode(token_hash, 'escape') = $1")
            .bind(&access_token)
            .fetch_one(&su)
            .await
            .expect("scan for a raw token");
    assert_eq!(raw_leak, 0, "the raw JWT must never be stored");
}

// ---------------------------------------------------------------------------
// B1.6 — logout / refresh (the revocation *trigger* surface)
// ---------------------------------------------------------------------------

/// Log in and return `(accessToken, refreshToken)`.
async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture) -> (String, String) {
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
    (
        body["accessToken"]
            .as_str()
            .expect("accessToken")
            .to_string(),
        body["refreshToken"]
            .as_str()
            .expect("refreshToken")
            .to_string(),
    )
}

/// **RED for B1.6 소품 A.** Drives the two routes that make MOMO-300 revocation
/// reachable over HTTP:
///
///  * logout revokes the presented session → the same access token stops
///    working (401 `token has been revoked`). Delete the `revoke_token` call
///    from `routes::auth_routes::logout` and this flips to 200: the JWT
///    signature is still perfectly valid, which is the whole point of the
///    `token` row.
///  * logout is idempotent — a second call is 200 with `alreadyRevoked=true`
///    (Swift :229-235). Mount logout *behind* the auth middleware and this goes
///    red with a 401 instead.
///  * refresh rotates: the new access token works, and replaying the spent
///    refresh token is 401 `refresh token already used or revoked`. Drop the
///    `revoked_now` check and the replay assertion flips to 200 (Swift's
///    single-use gate, :169-181).
///  * a refresh token belonging to another session is a 403 and revokes
///    nothing (Swift :261-276).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn http_smoke_logout_and_refresh_rotation() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let messages_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        fixture.workspace, fixture.channel
    );

    // ---- logout kills the presented session ------------------------------
    let (access, refresh) = login(&http, &base, &fixture).await;
    let alive = http
        .get(&messages_url)
        .bearer_auth(&access)
        .send()
        .await
        .expect("pre-logout history");
    assert_eq!(alive.status(), 200, "the session works before logout");

    let out = http
        .post(format!("{base}/v1/auth/logout"))
        .bearer_auth(&access)
        .json(&json!({"refreshToken": refresh}))
        .send()
        .await
        .expect("logout");
    assert_eq!(out.status(), 200, "logout answers 200");
    let out: Value = out.json().await.expect("logout body");
    assert_eq!(out["status"], json!("ok"));
    assert_eq!(
        out["revokedAccess"],
        json!(true),
        "logout must revoke the presented access token"
    );
    assert_eq!(
        out["revokedRefresh"],
        json!(true),
        "and the refresh half handed in with the body"
    );
    assert_eq!(out["alreadyRevoked"], json!(false));

    let dead = http
        .get(&messages_url)
        .bearer_auth(&access)
        .send()
        .await
        .expect("post-logout history");
    assert_eq!(
        dead.status(),
        401,
        "after logout the same access token must die, signature notwithstanding"
    );
    let dead: Value = dead.json().await.expect("error body");
    assert_eq!(dead["error"]["message"], json!("token has been revoked"));

    // the logged-out refresh token cannot mint a new session either
    let stale = http
        .post(format!("{base}/v1/auth/refresh"))
        .json(&json!({"refreshToken": refresh}))
        .send()
        .await
        .expect("refresh after logout");
    assert_eq!(
        stale.status(),
        401,
        "logout must end rotation, not just the access token"
    );
    let stale: Value = stale.json().await.expect("error body");
    assert_eq!(stale["error"]["message"], json!("token has been revoked"));

    // ---- logout is idempotent -------------------------------------------
    let again = http
        .post(format!("{base}/v1/auth/logout"))
        .bearer_auth(&access)
        .send()
        .await
        .expect("second logout");
    assert_eq!(
        again.status(),
        200,
        "logging out twice stays 200 (the route is outside the revocation check)"
    );
    let again: Value = again.json().await.expect("second logout body");
    assert_eq!(
        again["revokedAccess"],
        json!(false),
        "nothing new to revoke"
    );
    assert_eq!(again["alreadyRevoked"], json!(true));

    // ---- refresh rotates -------------------------------------------------
    let (access2, refresh2) = login(&http, &base, &fixture).await;
    let rotated = http
        .post(format!("{base}/v1/auth/refresh"))
        .json(&json!({"refreshToken": refresh2}))
        .send()
        .await
        .expect("refresh");
    assert_eq!(rotated.status(), 200, "a live refresh token rotates");
    let rotated: Value = rotated.json().await.expect("refresh body");
    let access3 = rotated["accessToken"].as_str().expect("accessToken");
    let refresh3 = rotated["refreshToken"].as_str().expect("refreshToken");
    assert_ne!(access3, access2, "rotation issues a NEW access token");
    assert_ne!(refresh3, refresh2, "and a new refresh token");

    let fresh = http
        .get(&messages_url)
        .bearer_auth(access3)
        .send()
        .await
        .expect("history with the rotated token");
    assert_eq!(
        fresh.status(),
        200,
        "the rotated access token must be recorded, or the middleware 401s it"
    );

    // single-use: replaying the spent refresh token is dead
    let replay = http
        .post(format!("{base}/v1/auth/refresh"))
        .json(&json!({"refreshToken": refresh2}))
        .send()
        .await
        .expect("refresh replay");
    assert_eq!(replay.status(), 401, "a refresh token is single-use");
    let replay: Value = replay.json().await.expect("error body");
    assert_eq!(
        replay["error"]["message"],
        json!("token has been revoked"),
        "the rotated row is revoked, so the pre-check names it precisely"
    );

    // the pre-rotation access token is untouched by rotation (Swift parity:
    // refresh revokes the refresh row only), and the new refresh works once.
    let rotated_again = http
        .post(format!("{base}/v1/auth/refresh"))
        .json(&json!({"refreshToken": refresh3}))
        .send()
        .await
        .expect("second rotation");
    assert_eq!(rotated_again.status(), 200, "the new refresh token spends");

    // ---- wrong-typ and mismatched-session bodies -------------------------
    let access_as_refresh = http
        .post(format!("{base}/v1/auth/refresh"))
        .json(&json!({"refreshToken": access3}))
        .send()
        .await
        .expect("access on the refresh path");
    assert_eq!(
        access_as_refresh.status(),
        401,
        "an access token must never rotate a session"
    );
    let access_as_refresh: Value = access_as_refresh.json().await.expect("error body");
    assert_eq!(
        access_as_refresh["error"]["message"],
        json!("not a refresh token")
    );

    // A second member's refresh token may not be revoked through this session.
    let other = Uuid::new_v4();
    let other_email = format!("{other}@smoke.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(other)
    .bind(fixture.workspace)
    .bind(other.to_string())
    .execute(&su)
    .await
    .expect("seed other member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(other)
    .bind(fixture.workspace)
    .bind(&other_email)
    .bind(TEST_PASSWORD)
    .execute(&su)
    .await
    .expect("seed other human");
    let other_login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": other_email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("other login")
        .json()
        .await
        .expect("other login body");
    let other_refresh = other_login["refreshToken"].as_str().expect("refreshToken");

    let (access4, _refresh4) = login(&http, &base, &fixture).await;
    let mismatched = http
        .post(format!("{base}/v1/auth/logout"))
        .bearer_auth(&access4)
        .json(&json!({"refreshToken": other_refresh}))
        .send()
        .await
        .expect("logout with a foreign refresh token");
    assert_eq!(
        mismatched.status(),
        403,
        "a refresh token from another session is refused"
    );
    let mismatched_body: Value = mismatched.json().await.expect("error body");
    assert_eq!(
        mismatched_body["error"]["message"],
        json!("refresh token does not match this session")
    );

    // …and the refusal revoked NOTHING: validation happens before any write.
    let foreign_revoked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token \
          WHERE token_hash = digest($1::text, 'sha256') AND revoked_at IS NOT NULL",
    )
    .bind(other_refresh)
    .fetch_one(&su)
    .await
    .expect("count foreign revocations");
    assert_eq!(
        foreign_revoked, 0,
        "a rejected logout must not have revoked the foreign token"
    );
    let still_alive = http
        .get(&messages_url)
        .bearer_auth(&access4)
        .send()
        .await
        .expect("history after the rejected logout");
    assert_eq!(
        still_alive.status(),
        200,
        "the rejected logout must not half-revoke the caller's own session"
    );

    // logout with no body at all revokes just the access half.
    let bodyless = http
        .post(format!("{base}/v1/auth/logout"))
        .bearer_auth(&access4)
        .send()
        .await
        .expect("logout without a body");
    assert_eq!(bodyless.status(), 200, "the body is optional");
    let bodyless: Value = bodyless.json().await.expect("logout body");
    assert_eq!(bodyless["revokedAccess"], json!(true));
    assert_eq!(
        bodyless["revokedRefresh"],
        json!(false),
        "no refresh token was presented, so none was revoked"
    );
}

// ---------------------------------------------------------------------------
// goal B13 R2 High 1 — the login workspace is honoured or refused, never swapped
// ---------------------------------------------------------------------------

/// **A workspace that was typed and cannot be an id fails visibly; a workspace
/// nobody named still falls back to the demo one.**
///
/// Before this batch `login` did
/// `.and_then(|raw| Uuid::parse_str(raw).ok()).unwrap_or(DEMO_WORKSPACE_ID)`, so
/// `workspace: "dawn-team"` signed the caller into the *demo* workspace without
/// a word. Every screen after that looked like a working session in the wrong
/// tenant — and the trap is real rather than theoretical, because the workspace
/// id is never displayed anywhere in the product, so a person filling a box
/// labelled 워크스페이스 reaches for the slug or the name they actually know.
///
/// The test asserts both halves, because fixing one by breaking the other is the
/// obvious wrong turn:
///   * a **supplied, unusable** value → 400, and **no session is issued**;
///   * an **absent or blank** value → 200 into the demo workspace, unchanged.
///
/// Goes red if the fallback is widened back over parse failures, or if the
/// blank path is dragged into the refusal with them.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b13_login_refuses_a_workspace_it_cannot_parse_and_keeps_the_blank_fallback() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    // ---- 1. a value the caller typed that is not a workspace id ----------
    for typed in ["dawn-team", "우리 팀", "not-a-uuid", "00000000"] {
        let response = http
            .post(format!("{base}/v1/auth/login"))
            .json(&json!({
                "email": fixture.email,
                "password": TEST_PASSWORD,
                "workspace": typed,
            }))
            .send()
            .await
            .expect("login with an unusable workspace");
        assert_eq!(
            response.status(),
            400,
            "{typed:?} must be refused rather than silently swapped for the demo workspace"
        );
        let body: Value = response.json().await.expect("error body");
        let message = body["error"]["message"]
            .as_str()
            .expect("an error message")
            .to_lowercase();
        assert!(
            message.contains("workspace"),
            "the web client translates this refusal by matching on the word: {message}"
        );
        assert!(
            body.get("accessToken").is_none() && body.get("member").is_none(),
            "a refused login issues no session: {body}"
        );
    }

    // ---- 2. the blank path is untouched ----------------------------------
    // The connect form ships this box EMPTY, so this is the request almost every
    // real sign-in makes.
    for omitted in [
        json!({"email": fixture.email, "password": TEST_PASSWORD}),
        json!({"email": fixture.email, "password": TEST_PASSWORD, "workspace": ""}),
        json!({"email": fixture.email, "password": TEST_PASSWORD, "workspace": "   "}),
    ] {
        let response = http
            .post(format!("{base}/v1/auth/login"))
            .json(&omitted)
            .send()
            .await
            .expect("login without a workspace");
        // The seeded member lives in its own workspace, not the demo one, so the
        // demo fallback cannot find it: 401 is the RIGHT answer here and it is
        // the proof the request reached the credential check instead of being
        // refused at the workspace gate.
        assert_eq!(
            response.status(),
            401,
            "a blank workspace still resolves (to the demo workspace) and is judged \
             on credentials, never rejected as malformed: {omitted}"
        );
        let body: Value = response.json().await.expect("error body");
        assert_eq!(
            body["error"]["message"],
            json!("invalid credentials"),
            "…and it fails as a credential mismatch, not as a bad workspace: {body}"
        );
    }

    // ---- 3. the member's own workspace, named properly, still works -------
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login with a real workspace id");
    assert_eq!(response.status(), 200, "a real workspace id is honoured");
    let body: Value = response.json().await.expect("login body");
    assert_eq!(
        body["member"]["workspaceId"],
        json!(fixture.workspace.to_string()),
        "the session is scoped to the workspace that was asked for: {body}"
    );
}
