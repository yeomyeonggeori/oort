//! #2331 / ADR-0185 E1 — `PATCH /v1/workspaces/{ws}` against real Postgres.
//!
//! Red proofs (each status code is its own assertion):
//!   1. non-owner/admin **403**
//!   2. agent bearer **403**
//!   3. empty name **400**
//!   4. 81-char name **400**
//!   5. control-character name **400**
//!   6. stale `updatedAtMs` **409**
//!   7. success **200** + audit `workspace.renamed` 1 + GET name matches + slug unchanged
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test workspace_rename_conformance_pg \
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

const TEST_JWT_SECRET: &str = "workspace-rename-conformance-signing-secret";
const TEST_PASSWORD: &str = "workspace-rename-test-password";

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
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
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
    slug: String,
    owner: Human,
    admin: Human,
    member: Human,
    agent: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@workspace-rename.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(id.to_string())
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
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace_membership");
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
    let workspace = Uuid::new_v4();
    let slug = format!("{hint}-{workspace}");
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(&slug)
        .bind(format!("seed-{hint}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_human(su, workspace, "owner").await;
    let admin = seed_human(su, workspace, "admin").await;
    let member = seed_human(su, workspace, "member").await;
    let agent = seed_agent(su, workspace, owner.id).await;
    Fixture {
        workspace,
        slug,
        owner,
        admin,
        member,
        agent,
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
                 ARRAY['messages:write']::text[], 'workspace-rename-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn workspace_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}")
}

async fn get_workspace(
    http: &reqwest::Client,
    url: &str,
    token: &str,
) -> (reqwest::StatusCode, Value) {
    let response = http
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("GET workspace");
    let status = response.status();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

async fn patch_workspace(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    body: &Value,
) -> (reqwest::StatusCode, Value) {
    let response = http
        .patch(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("PATCH workspace");
    let status = response.status();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

async fn stored_workspace(su: &PgPool, id: Uuid) -> (String, String) {
    sqlx::query_as("SELECT slug, name FROM workspace WHERE id = $1")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("read stored workspace")
}

async fn audit_count(su: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log WHERE workspace_id = $1 AND action = $2",
    )
    .bind(workspace)
    .bind(action)
    .fetch_one(su)
    .await
    .expect("count audit rows")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn owner_rename_writes_name_audit_and_get_matches() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "happy").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = workspace_url(&base, fixture.workspace);

    let (get_status, before) = get_workspace(&http, &url, &token).await;
    assert_eq!(get_status, 200);
    let updated_at_ms = before["workspace"]["updatedAtMs"]
        .as_i64()
        .expect("updatedAtMs");
    let original_slug = before["workspace"]["slug"]
        .as_str()
        .expect("slug")
        .to_string();
    assert_eq!(original_slug, fixture.slug);

    let (status, body) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "  내 워크스페이스  ", "updatedAtMs": updated_at_ms}),
    )
    .await;
    assert_eq!(status, 200, "owner PATCH is 200: {body}");
    assert_eq!(body["workspace"]["name"], "내 워크스페이스");
    assert_eq!(body["workspace"]["slug"], original_slug);
    assert!(
        body["workspace"]["updatedAtMs"].as_i64().expect("ms") >= updated_at_ms,
        "rename must bump updatedAtMs"
    );
    assert!(body["workspace"].get("settings").is_none(), "{body}");

    let (slug, name) = stored_workspace(&su, fixture.workspace).await;
    assert_eq!(name, "내 워크스페이스");
    assert_eq!(slug, fixture.slug, "slug is never rewritten");

    let (after_status, after) = get_workspace(&http, &url, &token).await;
    assert_eq!(after_status, 200);
    assert_eq!(after["workspace"]["name"], "내 워크스페이스");
    assert_eq!(after["workspace"]["slug"], original_slug);

    assert_eq!(
        audit_count(&su, fixture.workspace, "workspace.renamed").await,
        1,
        "one audit row for the rename"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn admin_can_rename() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "admin").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.admin.email).await;
    let url = workspace_url(&base, fixture.workspace);
    let (_, before) = get_workspace(&http, &url, &token).await;
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let (status, body) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "관리자 이름", "updatedAtMs": updated_at_ms}),
    )
    .await;
    assert_eq!(status, 200, "admin PATCH is 200: {body}");
    assert_eq!(body["workspace"]["name"], "관리자 이름");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn member_is_forbidden() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "member").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let url = workspace_url(&base, fixture.workspace);
    let (_, before) = get_workspace(&http, &url, &token).await;
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let (status, body) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "침입", "updatedAtMs": updated_at_ms}),
    )
    .await;
    assert_eq!(status, 403, "non-owner/admin is 403: {body}");
    let (_, name) = stored_workspace(&su, fixture.workspace).await;
    assert_eq!(name, "seed-member");
    assert_eq!(
        audit_count(&su, fixture.workspace, "workspace.renamed").await,
        0
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn agent_bearer_is_forbidden() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "agent").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = agent_bearer(&su, fixture.workspace, fixture.agent).await;
    assert!(
        include_str!("../src/routes/workspaces.rs")
            .contains("require_human(&principal, HUMANS_RENAME_WORKSPACES)?"),
        "require_human is the handler-level agent 403; sabotage of that call must turn this RED"
    );
    let (status, body) = patch_workspace(
        &http,
        &workspace_url(&base, fixture.workspace),
        &token,
        &json!({"name": "에이전트", "updatedAtMs": 1}),
    )
    .await;
    assert_eq!(status, 403, "agent bearer cannot rename: {body}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn empty_name_is_400() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "empty").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = workspace_url(&base, fixture.workspace);
    let (_, before) = get_workspace(&http, &url, &token).await;
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let (status, body) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "   ", "updatedAtMs": updated_at_ms}),
    )
    .await;
    assert_eq!(status, 400, "empty name is 400: {body}");
    assert_eq!(
        body["error"]["message"],
        "workspace name must be 1-80 characters"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn eighty_one_char_name_is_400() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "long").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = workspace_url(&base, fixture.workspace);
    let (_, before) = get_workspace(&http, &url, &token).await;
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let (status, body) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "모".repeat(81), "updatedAtMs": updated_at_ms}),
    )
    .await;
    assert_eq!(status, 400, "81-char name is 400: {body}");
    assert_eq!(
        body["error"]["message"],
        "workspace name must be 1-80 characters"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn control_char_name_is_400() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "ctrl").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = workspace_url(&base, fixture.workspace);
    let (_, before) = get_workspace(&http, &url, &token).await;
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let (status, body) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "momo\u{7}team", "updatedAtMs": updated_at_ms}),
    )
    .await;
    assert_eq!(status, 400, "control char name is 400: {body}");
    assert_eq!(
        body["error"]["message"],
        "workspace name contains unsupported characters"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn stale_updated_at_ms_is_409() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "stale").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = workspace_url(&base, fixture.workspace);
    let (_, before) = get_workspace(&http, &url, &token).await;
    let stale_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let (first_status, first) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "첫번째", "updatedAtMs": stale_ms}),
    )
    .await;
    assert_eq!(first_status, 200, "{first}");

    let (status, body) = patch_workspace(
        &http,
        &url,
        &token,
        &json!({"name": "두번째", "updatedAtMs": stale_ms}),
    )
    .await;
    assert_eq!(status, 409, "stale updatedAtMs is 409: {body}");
    assert_eq!(
        body["error"]["message"],
        "workspace has been updated; refetch and retry"
    );
    let (_, name) = stored_workspace(&su, fixture.workspace).await;
    assert_eq!(name, "첫번째", "a 409 must not write");
}
