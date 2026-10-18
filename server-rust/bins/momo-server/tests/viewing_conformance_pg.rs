//! #4018 / ADR-0204 증보 3 - the presence heartbeat `PUT .../channels/{ch}/viewing`.
//!
//! 1. a member's beat answers 204 and stamps `channel_viewing.seen_at` for the *bearer*
//! 2. a beat younger than the refresh floor does not rewrite the row; an older one does
//! 3. a non-member is 403 and writes nothing (the channel is not enumerable by beating)
//! 4. no body is read: a smuggled `member_id` cannot stamp someone else
//!
//! `#[ignore]` - needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test viewing_conformance_pg -- --ignored --test-threads=1
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "viewing-conformance-signing-secret";
const TEST_PASSWORD: &str = "viewing-test-password";
const MESSAGE_COUNT: i64 = 2;

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
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let app = build_app(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Human {
    id: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    member: Human,
    channel: Uuid,
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
    let email = format!("{id}@viewing.test");
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

async fn seed_public_channel(su: &PgPool, workspace: Uuid, created_by: Uuid) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
    .bind(created_by)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    channel
}

async fn seed_channel_membership(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

async fn seed_message(su: &PgPool, workspace: Uuid, channel: Uuid, author: Uuid, body: &str) {
    sqlx::query("UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1")
        .bind(channel)
        .execute(su)
        .await
        .expect("bump seq");
    let seq: i64 = sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("seq");
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
    )
    .bind(Uuid::new_v4())
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .bind(body)
    .execute(su)
    .await
    .expect("seed message");
}

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = seed_workspace(su, hint).await;
    let member = seed_human(
        su,
        workspace,
        &format!("me-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let channel = seed_public_channel(su, workspace, member.id).await;
    seed_channel_membership(su, workspace, channel, member.id).await;
    for index in 1..=MESSAGE_COUNT {
        seed_message(
            su,
            workspace,
            channel,
            member.id,
            &format!("viewing fixture {index}"),
        )
        .await;
    }
    Fixture {
        workspace,
        member,
        channel,
    }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
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
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

fn viewing_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/viewing")
}

async fn beat(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
) -> reqwest::Response {
    http.put(viewing_url(base, workspace, channel))
        .bearer_auth(token)
        .send()
        .await
        .expect("send heartbeat")
}

async fn seen_ages(su: &PgPool, channel: Uuid) -> Vec<(Uuid, f64)> {
    sqlx::query_as(
        "SELECT member_id, extract(epoch FROM (now() - seen_at))::float8 \
           FROM channel_viewing WHERE channel_id = $1 ORDER BY member_id",
    )
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("read viewing rows")
}

async fn boot(hint: &str) -> (PgPool, reqwest::Client, String, String, Fixture) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, hint).await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    (su, http, base, token, fixture)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_beat_is_204_and_stamps_the_bearer() {
    let _guard = test_lock().await;
    let (su, http, base, token, fixture) = boot("beat").await;

    let response = beat(&http, &base, &token, fixture.workspace, fixture.channel).await;
    assert_eq!(response.status(), 204);

    let rows = seen_ages(&su, fixture.channel).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, fixture.member.id, "the bearer is the owner");
    assert!(rows[0].1 < 10.0, "stamped just now: {rows:?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_beat_inside_the_refresh_floor_is_not_rewritten_and_an_older_one_is() {
    let _guard = test_lock().await;
    let (su, http, base, token, fixture) = boot("floor").await;

    // The stored stamp is 2 s old (inside the 5 s floor): the beat is accepted, the row stays.
    sqlx::query(
        "INSERT INTO channel_viewing (workspace_id, channel_id, member_id, seen_at) \
         VALUES ($1, $2, $3, now() - interval '2 seconds')",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(fixture.member.id)
    .execute(&su)
    .await
    .expect("seed a fresh stamp");
    let response = beat(&http, &base, &token, fixture.workspace, fixture.channel).await;
    assert_eq!(response.status(), 204);
    let rows = seen_ages(&su, fixture.channel).await;
    assert!(rows[0].1 >= 1.5, "a fresh stamp is not rewritten: {rows:?}");

    // 20 s old: past the floor, so the beat moves it to now.
    sqlx::query(
        "UPDATE channel_viewing SET seen_at = now() - interval '20 seconds' WHERE channel_id = $1",
    )
    .bind(fixture.channel)
    .execute(&su)
    .await
    .expect("age the stamp");
    let response = beat(&http, &base, &token, fixture.workspace, fixture.channel).await;
    assert_eq!(response.status(), 204);
    let rows = seen_ages(&su, fixture.channel).await;
    assert!(rows[0].1 < 5.0, "an old stamp is refreshed: {rows:?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_non_member_beat_is_403_and_writes_nothing() {
    let _guard = test_lock().await;
    let (su, http, base, token, fixture) = boot("outsider").await;
    // A second channel the caller never joined.
    let other = seed_public_channel(&su, fixture.workspace, fixture.member.id).await;

    let response = beat(&http, &base, &token, fixture.workspace, other).await;
    assert_eq!(response.status(), 403);
    assert!(seen_ages(&su, other).await.is_empty());

    // A channel that does not exist is not a different answer.
    let missing = beat(&http, &base, &token, fixture.workspace, Uuid::new_v4()).await;
    assert_eq!(missing.status(), 403);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_smuggled_member_id_cannot_stamp_someone_else() {
    let _guard = test_lock().await;
    let (su, http, base, token, fixture) = boot("smuggle").await;
    let victim = seed_human(&su, fixture.workspace, "victim-viewing").await;
    seed_channel_membership(&su, fixture.workspace, fixture.channel, victim.id).await;

    let response = http
        .put(viewing_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&token)
        .json(&json!({"member_id": victim.id.to_string()}))
        .send()
        .await
        .expect("send heartbeat with a smuggled member");
    assert_eq!(response.status(), 204);
    let rows = seen_ages(&su, fixture.channel).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, fixture.member.id, "only the bearer is stamped");
}
