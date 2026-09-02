//! #1889 / ADR-0176 — custom member status on the existing presence surface.
//!
//! Red proofs:
//!   1. set custom → roster reflects it → explicit nulls clear it (round-trip);
//!      a `{status}`-only PUT does not wipe custom fields
//!   2. `statusText` over 80 characters is 400
//!   3. a reached `statusExpiresAtMs` is null on roster (lazy delete, no job)
//!   4. another member cannot write yours — the path names no `memberId`
//!   5. agent bearer is 403 (route is not on the agent allow-list)
//!   6. the declared presence 3-set (`auto`/`away`/`dnd`) still round-trips
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test custom_status_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
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

const TEST_JWT_SECRET: &str = "custom-status-conformance-signing-secret";
const TEST_PASSWORD: &str = "custom-status-test-password";

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
    other: Human,
    agent: Uuid,
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
    let email = format!("{id}@status.test");
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

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = seed_workspace(su, hint).await;
    let member = seed_human(
        su,
        workspace,
        &format!("me-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let other = seed_human(
        su,
        workspace,
        &format!("ot-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let agent = seed_agent(su, workspace, member.id).await;
    let channel = seed_public_channel(su, workspace, member.id).await;
    seed_channel_membership(su, workspace, channel, member.id).await;
    seed_channel_membership(su, workspace, channel, other.id).await;
    Fixture {
        workspace,
        member,
        other,
        agent,
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

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'custom-status-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn presence_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/presence")
}

fn roster_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/roster")
}

async fn error_status_message(response: reqwest::Response) -> (u16, String) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    (status, message)
}

fn same_id(value: &Value, id: Uuid) -> bool {
    value
        .as_str()
        .is_some_and(|raw| raw.eq_ignore_ascii_case(&id.to_string()))
}

async fn roster_row(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    id: Uuid,
) -> Value {
    let response = http
        .get(roster_url(base, workspace))
        .bearer_auth(token)
        .send()
        .await
        .expect("roster");
    assert_eq!(response.status(), 200, "roster is 200");
    let body: Value = response.json().await.expect("roster body");
    body["members"]
        .as_array()
        .expect("members")
        .iter()
        .find(|row| same_id(&row["id"], id))
        .cloned()
        .expect("member on roster")
}

async fn presence_broadcasts(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 \
            AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'presence' \
          ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read presence broadcasts")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn custom_status_set_roster_clear_round_trip() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "round").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let expires = chrono::Utc::now().timestamp_millis() + 3_600_000;

    let set = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "status": "away",
            "statusEmoji": "📅",
            "statusText": " 회의 중 ",
            "statusExpiresAtMs": expires
        }))
        .send()
        .await
        .expect("set");
    assert_eq!(set.status(), 200, "set is 200");
    let set_body: Value = set.json().await.expect("set body");
    assert_eq!(set_body["status"], "away");
    assert_eq!(set_body["statusEmoji"], "📅");
    assert_eq!(set_body["statusText"], "회의 중");
    assert_eq!(set_body["statusExpiresAtMs"], expires);

    let row = roster_row(&http, &base, &token, fixture.workspace, fixture.member.id).await;
    assert_eq!(row["presenceStatus"], "away");
    assert_eq!(row["statusEmoji"], "📅");
    assert_eq!(row["statusText"], "회의 중");
    assert_eq!(row["statusExpiresAtMs"], expires);

    let keep = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({ "status": "dnd" }))
        .send()
        .await
        .expect("status-only");
    assert_eq!(keep.status(), 200);
    let keep_body: Value = keep.json().await.expect("keep body");
    assert_eq!(keep_body["status"], "dnd");
    assert_eq!(
        keep_body["statusText"], "회의 중",
        "status-only must not wipe custom"
    );

    let broadcasts = presence_broadcasts(&su, fixture.workspace).await;
    assert!(
        broadcasts.iter().any(|payload| {
            payload["data"]["payload"]["status_text"] == "회의 중"
                && payload["data"]["payload"]["presence_status"] == "away"
                && payload["channel"].as_str().is_some_and(|channel| {
                    channel
                        .to_ascii_uppercase()
                        .contains(&fixture.channel.to_string().to_uppercase())
                })
        }),
        "custom status rides the existing presence rail: {broadcasts:?}"
    );

    let clear = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "status": "auto",
            "statusEmoji": null,
            "statusText": null,
            "statusExpiresAtMs": null
        }))
        .send()
        .await
        .expect("clear");
    assert_eq!(clear.status(), 200);
    let clear_body: Value = clear.json().await.expect("clear body");
    assert_eq!(clear_body["status"], "auto");
    assert!(clear_body.get("statusEmoji").is_none(), "{clear_body}");
    assert!(clear_body.get("statusText").is_none(), "{clear_body}");

    let cleared = roster_row(&http, &base, &token, fixture.workspace, fixture.member.id).await;
    assert_eq!(cleared["presenceStatus"], "auto");
    assert!(cleared.get("statusEmoji").is_none(), "{cleared}");
    assert!(cleared.get("statusText").is_none(), "{cleared}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn status_text_over_80_is_400() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "cap").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    let response = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "status": "auto",
            "statusText": "한".repeat(81)
        }))
        .send()
        .await
        .expect("overlong");
    let (status, message) = error_status_message(response).await;
    assert_eq!(status, 400, "{message}");
    assert_eq!(message, "statusText must be at most 80 characters");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn expired_custom_status_is_null_on_roster() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "exp").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let past = chrono::Utc::now().timestamp_millis() - 5_000;

    let set = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "status": "away",
            "statusEmoji": "🏖️",
            "statusText": "휴가",
            "statusExpiresAtMs": past
        }))
        .send()
        .await
        .expect("set past");
    assert_eq!(set.status(), 200);
    let set_body: Value = set.json().await.expect("set body");
    assert!(
        set_body.get("statusText").is_none(),
        "own GET also ignores a reached expiry: {set_body}"
    );

    let stored: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT status_emoji, status_text FROM member WHERE id = $1")
            .bind(fixture.member.id)
            .fetch_one(&su)
            .await
            .expect("stored columns");
    assert_eq!(
        stored.1.as_deref(),
        Some("휴가"),
        "lazy delete leaves the row"
    );

    let row = roster_row(&http, &base, &token, fixture.workspace, fixture.member.id).await;
    assert_eq!(row["presenceStatus"], "away");
    assert!(row.get("statusEmoji").is_none(), "{row}");
    assert!(row.get("statusText").is_none(), "{row}");
    assert!(row.get("statusExpiresAtMs").is_none(), "{row}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn another_member_cannot_write_your_status() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "other").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let mine = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let theirs = login(&http, &base, fixture.workspace, &fixture.other.email).await;

    let set = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&mine)
        .json(&json!({
            "status": "away",
            "statusText": "회의 중"
        }))
        .send()
        .await
        .expect("set mine");
    assert_eq!(set.status(), 200);

    let other_put = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&theirs)
        .json(&json!({
            "status": "dnd",
            "statusText": "이동 중"
        }))
        .send()
        .await
        .expect("set theirs");
    assert_eq!(other_put.status(), 200);

    let mine_row = roster_row(&http, &base, &mine, fixture.workspace, fixture.member.id).await;
    assert_eq!(mine_row["statusText"], "회의 중");
    assert_eq!(mine_row["presenceStatus"], "away");

    let stolen = http
        .put(format!(
            "{}/{}",
            presence_url(&base, fixture.workspace),
            fixture.member.id
        ))
        .bearer_auth(&theirs)
        .json(&json!({ "status": "auto", "statusText": "stolen" }))
        .send()
        .await
        .expect("path with memberId");
    assert_eq!(
        stolen.status().as_u16(),
        404,
        "the write path names no memberId: {}",
        stolen.status()
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn agent_bearer_is_403() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "agent").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = agent_bearer(&su, fixture.workspace, fixture.agent).await;

    let response = http
        .put(presence_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({ "status": "away", "statusText": "작업 중" }))
        .send()
        .await
        .expect("agent put");
    let (status, message) = error_status_message(response).await;
    assert_eq!(status, 403, "{message}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn declared_presence_three_labels_still_round_trip() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "three").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    for label in ["auto", "away", "dnd"] {
        let put = http
            .put(presence_url(&base, fixture.workspace))
            .bearer_auth(&token)
            .json(&json!({ "status": label }))
            .send()
            .await
            .expect("put");
        assert_eq!(put.status(), 200, "{label}");
        let body: Value = put.json().await.expect("body");
        assert_eq!(body["status"], label);

        let get = http
            .get(presence_url(&base, fixture.workspace))
            .bearer_auth(&token)
            .send()
            .await
            .expect("get");
        assert_eq!(get.status(), 200, "{label} get");
        let got: Value = get.json().await.expect("get body");
        assert_eq!(got["status"], label);

        let row = roster_row(&http, &base, &token, fixture.workspace, fixture.member.id).await;
        assert_eq!(row["presenceStatus"], label);
    }
}
