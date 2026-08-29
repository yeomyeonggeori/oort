//! #1888 / ADR-0175 — message reminder REST against real Postgres.
//!
//! Red proofs:
//!   1. create → list(pending) → snooze → complete round-trip; `state=all` keeps
//!      the completed row; no outbox fan-out
//!   2. another member's GET omits the row; PATCH/DELETE of that id is 404
//!   3. a non-member of the message's channel is 403
//!   4. past `dueAtMs` is 400
//!   5. RLS GUC: workspace + owner `app.member_id` sees the row; the other
//!      member's GUC and a foreign workspace GUC see none
//!   6. agent bearer is 403 (route is not on the agent allow-list)
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test reminder_conformance_pg \
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

const TEST_JWT_SECRET: &str = "reminder-conformance-signing-secret";
const TEST_PASSWORD: &str = "reminder-test-password";

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
}

struct Fixture {
    workspace: Uuid,
    other_workspace: Uuid,
    member: Human,
    other: Human,
    agent: Uuid,
    channel: Uuid,
    outsider_channel: Uuid,
    message: Uuid,
    outsider_message: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@reminder.test");
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

async fn seed_message(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    author: Uuid,
    body: &str,
) -> Uuid {
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
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
    )
    .bind(id)
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .bind(body)
    .execute(su)
    .await
    .expect("message");
    id
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
    let _outsider = seed_human(
        su,
        other_workspace,
        &format!("os-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let agent = seed_agent(su, workspace, member.id).await;
    let channel = seed_public_channel(su, workspace, member.id).await;
    let outsider_channel = seed_public_channel(su, workspace, other.id).await;
    seed_channel_membership(su, workspace, channel, member.id).await;
    seed_channel_membership(su, workspace, channel, other.id).await;
    seed_channel_membership(su, workspace, outsider_channel, other.id).await;
    let message = seed_message(su, workspace, channel, member.id, "remind me").await;
    let outsider_message = seed_message(su, workspace, outsider_channel, other.id, "private").await;
    Fixture {
        workspace,
        other_workspace,
        member,
        other,
        agent,
        channel,
        outsider_channel,
        message,
        outsider_message,
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
                 ARRAY['messages:write']::text[], 'reminder-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn reminders_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/reminders")
}

fn reminder_url(base: &str, workspace: Uuid, id: &str) -> String {
    format!("{base}/v1/workspaces/{workspace}/reminders/{id}")
}

fn future_due_ms() -> i64 {
    chrono::Utc::now().timestamp_millis() + 3_600_000
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

async fn outbox_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM outbox WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count outbox")
}

async fn audit_actions(su: &PgPool, workspace: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT action FROM audit_log \
          WHERE workspace_id = $1 AND action LIKE 'reminder.%' \
          ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("audit actions")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn reminder_create_list_snooze_complete_has_no_outbox() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "happy").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let before_outbox = outbox_count(&su, fixture.workspace).await;
    let due = future_due_ms();
    let snooze = due + 3_600_000;

    let created = http
        .post(reminders_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": fixture.channel,
            "messageId": fixture.message,
            "dueAtMs": due,
            "note": "  later  ",
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201, "create is 201");
    let created_body: Value = created.json().await.expect("create body");
    let id = created_body["reminder"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    assert_eq!(created_body["reminder"]["note"], "later");
    assert_eq!(created_body["reminder"]["dueAtMs"], due);
    assert!(created_body["reminder"].get("completedAtMs").is_none());

    let listed = http
        .get(format!(
            "{}?state=pending",
            reminders_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list pending");
    assert_eq!(listed.status(), 200);
    let listed_body: Value = listed.json().await.expect("list body");
    let reminders = listed_body["reminders"].as_array().expect("reminders");
    assert!(
        reminders.iter().any(|row| row["id"] == id),
        "created row is on the pending page: {listed_body}"
    );

    let snoozed = http
        .patch(reminder_url(&base, fixture.workspace, &id))
        .bearer_auth(&token)
        .json(&json!({ "dueAtMs": snooze }))
        .send()
        .await
        .expect("snooze");
    assert_eq!(snoozed.status(), 200);
    let snoozed_body: Value = snoozed.json().await.expect("snooze body");
    assert_eq!(snoozed_body["reminder"]["dueAtMs"], snooze);

    let completed = http
        .patch(reminder_url(&base, fixture.workspace, &id))
        .bearer_auth(&token)
        .json(&json!({ "completed": true }))
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200);
    let completed_body: Value = completed.json().await.expect("complete body");
    assert!(completed_body["reminder"]["completedAtMs"].is_number());

    let pending_after = http
        .get(format!(
            "{}?state=pending",
            reminders_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list pending after complete");
    let pending_body: Value = pending_after.json().await.expect("pending body");
    let pending = pending_body["reminders"].as_array().expect("pending");
    assert!(
        pending.iter().all(|row| row["id"] != id),
        "completed row leaves pending: {pending_body}"
    );

    let all = http
        .get(format!(
            "{}?state=all",
            reminders_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list all");
    let all_body: Value = all.json().await.expect("all body");
    assert!(
        all_body["reminders"]
            .as_array()
            .expect("all")
            .iter()
            .any(|row| row["id"] == id && row["completedAtMs"].is_number()),
        "completed row stays on state=all: {all_body}"
    );

    assert_eq!(
        outbox_count(&su, fixture.workspace).await,
        before_outbox,
        "v1 reminders must not write outbox"
    );
    assert_eq!(
        audit_actions(&su, fixture.workspace).await,
        vec![
            "reminder.created".to_string(),
            "reminder.updated".to_string(),
            "reminder.completed".to_string(),
        ]
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn another_members_reminder_is_404() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "cross").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let owner = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let other = login(&http, &base, fixture.workspace, &fixture.other.email).await;

    let created = http
        .post(reminders_url(&base, fixture.workspace))
        .bearer_auth(&owner)
        .json(&json!({
            "channelId": fixture.channel,
            "messageId": fixture.message,
            "dueAtMs": future_due_ms(),
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let created_body: Value = created.json().await.expect("create body");
    let id = created_body["reminder"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    let listed = http
        .get(reminders_url(&base, fixture.workspace))
        .bearer_auth(&other)
        .send()
        .await
        .expect("other list");
    assert_eq!(listed.status(), 200);
    let listed_body: Value = listed.json().await.expect("other list body");
    let reminders = listed_body["reminders"].as_array().expect("reminders");
    assert!(
        reminders.iter().all(|row| row["id"] != id),
        "owner's reminder must not appear on another member's list: {listed_body}"
    );

    let patched = http
        .patch(reminder_url(&base, fixture.workspace, &id))
        .bearer_auth(&other)
        .json(&json!({ "completed": true }))
        .send()
        .await
        .expect("other patch");
    let (status, message) = error_status_message(patched).await;
    assert_eq!(status, 404, "{message}");

    let deleted = http
        .delete(reminder_url(&base, fixture.workspace, &id))
        .bearer_auth(&other)
        .send()
        .await
        .expect("other delete");
    assert_eq!(deleted.status(), 404);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn non_member_channel_message_is_forbidden() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "nonmember").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    let response = http
        .post(reminders_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": fixture.outsider_channel,
            "messageId": fixture.outsider_message,
            "dueAtMs": future_due_ms(),
        }))
        .send()
        .await
        .expect("create");
    let (status, message) = error_status_message(response).await;
    assert!(
        status == 403 || status == 404,
        "non-member target must not succeed: {status} {message}"
    );
    if status == 403 {
        assert_eq!(message, "not a member of this channel");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn past_due_is_400() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "past").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    let response = http
        .post(reminders_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": fixture.channel,
            "messageId": fixture.message,
            "dueAtMs": chrono::Utc::now().timestamp_millis() - 1_000,
        }))
        .send()
        .await
        .expect("create");
    let (status, message) = error_status_message(response).await;
    assert_eq!(status, 400, "{message}");
    assert_eq!(message, "dueAtMs must be in the future");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn rls_guc_is_owner_scoped() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "rls").await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    let created = http
        .post(reminders_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": fixture.channel,
            "messageId": fixture.message,
            "dueAtMs": future_due_ms(),
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);

    let visible_owner: i64 = {
        let mut tx = app.begin().await.expect("begin owner");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(fixture.workspace.to_string())
            .execute(&mut *tx)
            .await
            .expect("ws guc");
        sqlx::query("SELECT set_config('app.member_id', $1, true)")
            .bind(fixture.member.id.to_string())
            .execute(&mut *tx)
            .await
            .expect("owner guc");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM message_reminder")
            .fetch_one(&mut *tx)
            .await
            .expect("count owner");
        tx.rollback().await.expect("rollback owner");
        count
    };
    let visible_other: i64 = {
        let mut tx = app.begin().await.expect("begin other");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(fixture.workspace.to_string())
            .execute(&mut *tx)
            .await
            .expect("ws guc");
        sqlx::query("SELECT set_config('app.member_id', $1, true)")
            .bind(fixture.other.id.to_string())
            .execute(&mut *tx)
            .await
            .expect("other guc");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM message_reminder")
            .fetch_one(&mut *tx)
            .await
            .expect("count other");
        tx.rollback().await.expect("rollback other");
        count
    };
    let visible_foreign: i64 = {
        let mut tx = app.begin().await.expect("begin foreign");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(fixture.other_workspace.to_string())
            .execute(&mut *tx)
            .await
            .expect("foreign ws guc");
        sqlx::query("SELECT set_config('app.member_id', $1, true)")
            .bind(fixture.member.id.to_string())
            .execute(&mut *tx)
            .await
            .expect("owner guc on foreign ws");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM message_reminder")
            .fetch_one(&mut *tx)
            .await
            .expect("count foreign");
        tx.rollback().await.expect("rollback foreign");
        count
    };
    assert_eq!(visible_owner, 1);
    assert_eq!(visible_other, 0, "peer member GUC must not see the row");
    assert_eq!(
        visible_foreign, 0,
        "foreign tenant GUC must not see the row"
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
        .post(reminders_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": fixture.channel,
            "messageId": fixture.message,
            "dueAtMs": future_due_ms(),
        }))
        .send()
        .await
        .expect("agent create");
    let (status, message) = error_status_message(response).await;
    assert_eq!(status, 403, "{message}");
}
