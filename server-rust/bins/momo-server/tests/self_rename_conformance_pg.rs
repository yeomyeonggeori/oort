//! #1873 / BZ-4e — `PATCH /v1/workspaces/{ws}/members/me` against real Postgres.
//!
//! Red proofs:
//!   1. caller PATCH 200, `member.display_name` stored, roster GET shows it
//!   2. join-normalization 400 (`displayName is required`)
//!   3. agent bearer 403 (not on the agent-route allow-list)
//!   4. foreign workspace / dropped membership 403
//!   5. audit `member.renamed` row exists; handle/role/avatar untouched
//!   6. outbox `member.renamed` broadcasts only the caller's `ch:` channels
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test self_rename_conformance_pg \
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
use momo_messaging::cent_channel;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "self-rename-conformance-signing-secret";
const TEST_PASSWORD: &str = "self-rename-test-password";

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
    handle: String,
}

struct Fixture {
    workspace: Uuid,
    other_workspace: Uuid,
    member: Human,
    other: Human,
    outsider: Human,
    agent: Uuid,
    channel_a: Uuid,
    channel_b: Uuid,
    outsider_channel: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@self-rename.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle, avatar_url) \
         VALUES ($1, $2, 'human', $3, $4, $5)",
    )
    .bind(id)
    .bind(workspace)
    .bind(handle)
    .bind(handle)
    .bind(format!("https://avatar.invalid/{handle}"))
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
    .expect("seed workspace_membership");
    Human {
        id,
        email,
        handle: handle.to_string(),
    }
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

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = seed_workspace(su, hint).await;
    let other_workspace = seed_workspace(su, &format!("{hint}-b")).await;
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
    let outsider = seed_human(
        su,
        other_workspace,
        &format!("os-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let agent = seed_agent(su, workspace, member.id).await;
    let channel_a = seed_public_channel(su, workspace, member.id).await;
    let channel_b = seed_public_channel(su, workspace, member.id).await;
    let outsider_channel = seed_public_channel(su, workspace, other.id).await;
    seed_channel_membership(su, workspace, channel_a, member.id).await;
    seed_channel_membership(su, workspace, channel_b, member.id).await;
    seed_channel_membership(su, workspace, outsider_channel, other.id).await;
    Fixture {
        workspace,
        other_workspace,
        member,
        other,
        outsider,
        agent,
        channel_a,
        channel_b,
        outsider_channel,
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
                 ARRAY['messages:write']::text[], 'self-rename-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn me_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/members/me")
}

async fn patch_me(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    body: &Value,
) -> reqwest::Response {
    http.patch(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("PATCH members/me")
}

async fn stored_member(su: &PgPool, id: Uuid) -> (String, String, Option<String>) {
    sqlx::query_as("SELECT display_name, handle, avatar_url FROM member WHERE id = $1")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("read stored member")
}

async fn stored_role(su: &PgPool, workspace: Uuid, member: Uuid) -> String {
    sqlx::query_scalar(
        "SELECT role::text FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("read stored role")
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

async fn rename_broadcasts(su: &PgPool, workspace: Uuid) -> Vec<(Uuid, String, String)> {
    sqlx::query_as(
        "SELECT partition_key, \
                payload->>'channel', \
                payload->'data'->'payload'->>'display_name' \
           FROM outbox \
          WHERE workspace_id = $1 \
            AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'member.renamed' \
          ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read rename broadcasts")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn self_rename_writes_db_roster_audit_and_outbox() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "happy").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    let response = patch_me(
        &http,
        &me_url(&base, fixture.workspace),
        &token,
        &json!({"displayName": "  곽성재  "}),
    )
    .await;
    assert_eq!(response.status(), 200, "self PATCH is 200");
    let body: Value = response.json().await.expect("rename body");
    assert_eq!(body["member"]["displayName"], "곽성재");
    assert_eq!(body["member"]["handle"], fixture.member.handle);
    assert_eq!(body["member"]["kind"], "human");
    assert_eq!(
        body["member"]["id"].as_str().expect("id").to_lowercase(),
        fixture.member.id.to_string().to_lowercase()
    );

    let (display_name, handle, avatar) = stored_member(&su, fixture.member.id).await;
    assert_eq!(display_name, "곽성재");
    assert_eq!(handle, fixture.member.handle, "handle is not writable here");
    assert_eq!(
        avatar.as_deref(),
        Some(format!("https://avatar.invalid/{}", fixture.member.handle).as_str()),
        "avatar is not writable here"
    );
    assert_eq!(
        stored_role(&su, fixture.workspace, fixture.member.id).await,
        "member",
        "role is not writable here"
    );

    let roster = http
        .get(format!("{base}/v1/workspaces/{}/roster", fixture.workspace))
        .bearer_auth(&token)
        .send()
        .await
        .expect("roster GET");
    assert_eq!(roster.status(), 200);
    let roster: Value = roster.json().await.expect("roster body");
    let members = roster["members"].as_array().expect("members");
    let mine = members
        .iter()
        .find(|row| {
            row["id"]
                .as_str()
                .map(|id| id.eq_ignore_ascii_case(&fixture.member.id.to_string()))
                .unwrap_or(false)
        })
        .expect("caller is on the roster");
    assert_eq!(mine["displayName"], "곽성재");
    assert_eq!(mine["handle"], fixture.member.handle);

    assert_eq!(
        audit_count(&su, fixture.workspace, "member.renamed").await,
        1,
        "one audit row for the rename"
    );

    let broadcasts = rename_broadcasts(&su, fixture.workspace).await;
    let hit: Vec<Uuid> = broadcasts.iter().map(|row| row.0).collect();
    assert!(hit.contains(&fixture.channel_a));
    assert!(hit.contains(&fixture.channel_b));
    assert!(
        !hit.contains(&fixture.outsider_channel),
        "a channel the caller is not in must not carry the rename"
    );
    assert_eq!(broadcasts.len(), 2);
    assert_eq!(broadcasts[0].1, cent_channel(fixture.workspace, hit[0]));
    assert!(broadcasts.iter().all(|row| row.2 == "곽성재"));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn invalid_display_name_is_the_join_sentence() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "invalid").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let url = me_url(&base, fixture.workspace);

    for bad in [
        json!({"displayName": "   "}),
        json!({"displayName": "모".repeat(101)}),
    ] {
        let response = patch_me(&http, &url, &token, &bad).await;
        assert_eq!(response.status(), 400, "{bad}");
        let err: Value = response.json().await.expect("error body");
        assert_eq!(
            err["error"]["message"], "displayName is required",
            "join sentence, not a second vocabulary: {err}"
        );
    }

    let (display_name, _, _) = stored_member(&su, fixture.member.id).await;
    assert_eq!(display_name, fixture.member.handle, "a 400 must not write");
    assert_eq!(
        audit_count(&su, fixture.workspace, "member.renamed").await,
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
    let response = patch_me(
        &http,
        &me_url(&base, fixture.workspace),
        &token,
        &json!({"displayName": "김인턴"}),
    )
    .await;
    assert_eq!(response.status(), 403, "agent bearer cannot rename");
    let (display_name, _, _) = stored_member(&su, fixture.agent).await;
    assert_ne!(display_name, "김인턴");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn foreign_workspace_and_dropped_membership_are_forbidden() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "bound").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();

    let outsider = login(
        &http,
        &base,
        fixture.other_workspace,
        &fixture.outsider.email,
    )
    .await;
    let crossed = patch_me(
        &http,
        &me_url(&base, fixture.workspace),
        &outsider,
        &json!({"displayName": "침입자"}),
    )
    .await;
    assert_eq!(
        crossed.status(),
        403,
        "a token bound to another workspace cannot address this one"
    );

    sqlx::query("DELETE FROM workspace_membership WHERE member_id = $1")
        .bind(fixture.other.id)
        .execute(&su)
        .await
        .expect("drop membership");
    let orphan = login(&http, &base, fixture.workspace, &fixture.other.email).await;
    let dropped = patch_me(
        &http,
        &me_url(&base, fixture.workspace),
        &orphan,
        &json!({"displayName": "유령"}),
    )
    .await;
    assert_eq!(dropped.status(), 403, "no workspace membership → 403");
    let (display_name, _, _) = stored_member(&su, fixture.other.id).await;
    assert_eq!(display_name, fixture.other.handle);
}
