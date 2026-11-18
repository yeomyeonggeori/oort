//! #5831 (ADR-0225 D10) — `PATCH /v1/workspaces/{ws}/channels/{ch}` renames a
//! public or private channel: owner/admin and human only, the create route's
//! normaliser, 409 on a clash and on `general` (both directions), audit
//! `channel.renamed`, no message and no realtime event.
//!
//! `#[ignore]` — needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:25831/momo \
//!   cargo test -p momo-server --test channel_rename_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

#![allow(dead_code)]

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "sec07-channel-management-signing-secret";
const TEST_PASSWORD: &str = "sec07-channel-management-password";
const FOREIGN_SCOPE: &str = "workspace scope mismatch";
const NOT_A_WORKSPACE_MEMBER: &str = "not a workspace member";
const OPERATOR_REQUIRED: &str = "workspace owner or admin role required";

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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Human {
    id: Uuid,
    email: String,
}

/// 「달무리 스튜디오」 — owner 이도현, admin 박서연, member 최민수, agent 봇.
struct Workspace {
    id: Uuid,
    slug: String,
    name: String,
    owner: Human,
    admin: Human,
    member: Human,
    agent: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display_name: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@example.test");
    let handle = format!("h{}", &id.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(display_name)
    .bind(&handle)
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
         VALUES ($1, $2, 'agent', $3, $4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind("달무리 도우미")
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

async fn seed(su: &PgPool, hint: &str) -> Workspace {
    let id = Uuid::new_v4();
    let slug = format!("{hint}-{id}");
    let name = format!("달무리 스튜디오 {hint}");
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&slug)
        .bind(&name)
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_human(su, id, "owner", "이도현").await;
    let admin = seed_human(su, id, "admin", "박서연").await;
    let member = seed_human(su, id, "member", "최민수").await;
    let agent = seed_agent(su, id, owner.id).await;
    Workspace {
        id,
        slug,
        name,
        owner,
        admin,
        member,
        agent,
    }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, human: &Human) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": human.email,
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

/// One HTTP call; the body is `Value::Null` when the response is not JSON.
async fn call(
    http: &reqwest::Client,
    method: Method,
    url: &str,
    token: &str,
    body: Option<&Value>,
) -> (StatusCode, Value) {
    let mut request = http.request(method, url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.expect("http call");
    let status = response.status();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

fn error_message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or("<no message>")
}

fn id_set(ids: &Value) -> BTreeSet<String> {
    ids.as_array()
        .expect("an id array")
        .iter()
        .map(|id| id.as_str().expect("id string").to_string())
        .collect()
}

fn ids_of(ids: &[Uuid]) -> BTreeSet<String> {
    ids.iter().map(Uuid::to_string).collect()
}

// ---------------------------------------------------------------------------
// SQL probes (superuser, so RLS does not hide anything)
// ---------------------------------------------------------------------------

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

async fn stored_name(su: &PgPool, workspace: Uuid) -> String {
    sqlx::query_scalar("SELECT name FROM workspace WHERE id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("read stored workspace name")
}

async fn stored_updated_at_ms(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT floor(extract(epoch from updated_at) * 1000)::bigint \
           FROM workspace WHERE id = $1",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("read stored updated_at")
}

async fn set_member_state(su: &PgPool, member: Uuid, status: &str, deleted: bool) {
    sqlx::query(
        "UPDATE member \
            SET status = $2::member_status, \
                deleted_at = CASE WHEN $3 THEN now() ELSE NULL END \
          WHERE id = $1",
    )
    .bind(member)
    .bind(status)
    .bind(deleted)
    .execute(su)
    .await
    .expect("set member state");
}

async fn channel_count_named(su: &PgPool, workspace: Uuid, name: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM channel WHERE workspace_id = $1 AND name = $2")
        .bind(workspace)
        .bind(name)
        .fetch_one(su)
        .await
        .expect("count channels by name")
}

async fn channel_count(su: &PgPool, workspace: Uuid, kind: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM channel WHERE workspace_id = $1 AND kind = $2::channel_kind",
    )
    .bind(workspace)
    .bind(kind)
    .fetch_one(su)
    .await
    .expect("count channels by kind")
}

async fn last_seq(su: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("channel_seq row exists")
}

async fn message_count(su: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM message WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("count messages")
}

/// `(role, left_at IS NULL)` of the one membership row, or `None` when absent.
async fn membership_row(su: &PgPool, channel: Uuid, member: Uuid) -> Option<(String, bool)> {
    sqlx::query_as(
        "SELECT role::text, left_at IS NULL FROM membership \
          WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read membership row")
}

async fn live_member_ids(su: &PgPool, channel: Uuid) -> BTreeSet<String> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT member_id FROM membership WHERE channel_id = $1 AND left_at IS NULL",
    )
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("read live members");
    ids_of(&ids)
}

fn workspace_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}")
}

fn channels_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels")
}

fn members_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/members")
}

fn send_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages")
}

async fn send_text(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    channel: Uuid,
    token: &str,
    body: &str,
) -> (StatusCode, Value) {
    call(
        http,
        Method::POST,
        &send_url(base, workspace, channel),
        token,
        Some(&json!({"clientMsgId": Uuid::new_v4(), "type": "text", "body": body})),
    )
    .await
}

async fn create_channel(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    token: &str,
    kind: &str,
    name: &str,
) -> (StatusCode, Value) {
    call(
        http,
        Method::POST,
        &channels_url(base, workspace),
        token,
        Some(&json!({"kind": kind, "name": name})),
    )
    .await
}

fn uuid_at(value: &Value, pointer: &str) -> Uuid {
    Uuid::parse_str(
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .expect(pointer),
    )
    .expect("a uuid string")
}

fn channel_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}")
}

async fn patch(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    channel: Uuid,
    token: &str,
    body: &Value,
) -> (StatusCode, Value) {
    call(
        http,
        Method::PATCH,
        &channel_url(base, workspace, channel),
        token,
        Some(body),
    )
    .await
}

async fn channel_name(su: &PgPool, channel: Uuid) -> String {
    sqlx::query_scalar("SELECT name FROM channel WHERE id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("read channel name")
}

async fn renamed_audit(su: &PgPool, workspace: Uuid) -> i64 {
    audit_count(su, workspace, "channel.renamed").await
}

async fn browse_listed_audit(su: &PgPool, workspace: Uuid) -> i64 {
    audit_count(su, workspace, "channel.browse_listed").await
}

async fn default_audit(su: &PgPool, workspace: Uuid) -> i64 {
    audit_count(su, workspace, "channel.default").await
}

async fn is_default(su: &PgPool, channel: Uuid) -> bool {
    sqlx::query_scalar("SELECT is_default FROM channel WHERE id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("read is_default")
}

async fn set_default(su: &PgPool, channel: Uuid, default: bool) {
    sqlx::query("UPDATE channel SET is_default = $2 WHERE id = $1")
        .bind(channel)
        .bind(default)
        .execute(su)
        .await
        .expect("set is_default");
}

async fn default_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM channel WHERE workspace_id = $1 AND is_default")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count defaults")
}

/// A listed public channel both the owner and the admin sit in, default or not.
async fn seated_public(r: &Rig, name: &str, default: bool) -> Uuid {
    let ch = insert_channel(&r.su, r.ws.id, "public", Some(name), false, r.ws.owner.id).await;
    set_browse_listed(&r.su, ch, true).await;
    set_default(&r.su, ch, default).await;
    join(&r.su, r.ws.id, ch, r.ws.owner.id).await;
    join(&r.su, r.ws.id, ch, r.ws.admin.id).await;
    ch
}

async fn browse_listed(su: &PgPool, channel: Uuid) -> bool {
    sqlx::query_scalar("SELECT browse_listed FROM channel WHERE id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("read browse_listed")
}

async fn set_browse_listed(su: &PgPool, channel: Uuid, listed: bool) {
    sqlx::query("UPDATE channel SET browse_listed = $2 WHERE id = $1")
        .bind(channel)
        .bind(listed)
        .execute(su)
        .await
        .expect("set browse_listed");
}

/// `(actor, detail)` of every `channel.browse_listed` row, oldest first.
async fn browse_listed_rows(su: &PgPool, workspace: Uuid) -> Vec<(Uuid, Value)> {
    sqlx::query_as(
        "SELECT actor_member_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'channel.browse_listed' \
          ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read browse_listed audit rows")
}

/// The ADR-0224 D4 self-join of the caller.
async fn self_join(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    channel: Uuid,
    token: &str,
) -> (StatusCode, Value) {
    let url = format!("{}/me", members_url(base, workspace, channel));
    call(http, Method::POST, &url, token, None).await
}

async fn message_total(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM message WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count messages")
}

async fn insert_channel(
    su: &PgPool,
    workspace: Uuid,
    kind: &str,
    name: Option<&str>,
    archived: bool,
    creator: Uuid,
) -> Uuid {
    let id = Uuid::new_v4();
    let dm_key = if kind == "dm" {
        Some(format!("k-{id}"))
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key, created_by, archived_at) \
         VALUES ($1, $2, $3::channel_kind, $4, $5, $6, CASE WHEN $7 THEN now() ELSE NULL END)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind(name)
    .bind(dm_key)
    .bind(creator)
    .bind(archived)
    .execute(su)
    .await
    .expect("insert channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(id)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    id
}

async fn join(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role)",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed membership");
}

async fn bearer_for_agent(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let token = format!(
        "momo_agent_v1.{}.{}",
        workspace.hyphenated(),
        "A".repeat(43)
    );
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write','messages:read']::text[], 'rename-test')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

struct Rig {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    ws: Workspace,
    owner: String,
    admin: String,
    member: String,
}

async fn rig(hint: &str) -> Rig {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let ws = seed(&su, hint).await;
    let owner = login(&http, &base, ws.id, &ws.owner).await;
    let admin = login(&http, &base, ws.id, &ws.admin).await;
    let member = login(&http, &base, ws.id, &ws.member).await;
    Rig {
        su,
        http,
        base,
        ws,
        owner,
        admin,
        member,
    }
}

/// Owner or admin renames: the name changes (folded), the answer carries it,
/// exactly one audit row, no message.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn owner_and_admin_rename_with_folding_and_one_audit_row() {
    let _guard = test_lock().await;
    let r = rig("rn-ok").await;
    let ch = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("old-name"),
        false,
        r.ws.owner.id,
    )
    .await;
    join(&r.su, r.ws.id, ch, r.ws.owner.id).await;
    // The channel is browse-off: only a seated admin may edit it (ADR-0224 D2).
    join(&r.su, r.ws.id, ch, r.ws.admin.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        ch,
        &r.admin,
        &json!({"name": "  디자인 리뷰  "}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["channel"]["name"], "디자인-리뷰");
    assert_eq!(body["channel"]["id"], ch.to_string());
    assert_eq!(channel_name(&r.su, ch).await, "디자인-리뷰");
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 1);
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'channel.renamed'",
    )
    .bind(r.ws.id)
    .fetch_one(&r.su)
    .await
    .expect("audit detail");
    assert_eq!(detail["old"], "old-name");
    assert_eq!(detail["new"], "디자인-리뷰");
    // owner, fullwidth + uppercase folds
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        ch,
        &r.owner,
        &json!({"name": "\u{FF33}PRINT-\u{FF12}"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(channel_name(&r.su, ch).await, "sprint-2");
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 2);
    assert_eq!(message_total(&r.su, r.ws.id).await, 0);
    // the old name is free again, the new name is taken
    let (status, _) =
        create_channel(&r.http, &r.base, r.ws.id, &r.owner, "public", "old-name").await;
    assert_eq!(status, 201);
    let (status, body) =
        create_channel(&r.http, &r.base, r.ws.id, &r.owner, "public", "sprint-2").await;
    assert_eq!(status, 409, "{body}");
    // the list (what the CLI and the team AI read) shows only the new name
    let (_, list) = call(
        &r.http,
        Method::GET,
        &channels_url(&r.base, r.ws.id),
        &r.owner,
        None,
    )
    .await;
    let names: Vec<String> = list["channels"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["name"].as_str().map(str::to_string))
        .collect();
    assert!(names.contains(&"sprint-2".to_string()));
}

/// Same name again (also a different spelling that folds to it): 200, no audit.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_same_name_again_is_ok_and_leaves_no_audit_row() {
    let _guard = test_lock().await;
    let r = rig("rn-same").await;
    let ch = insert_channel(
        &r.su,
        r.ws.id,
        "private",
        Some("디자인-리뷰"),
        false,
        r.ws.owner.id,
    )
    .await;
    join(&r.su, r.ws.id, ch, r.ws.admin.id).await;
    for spelling in [
        "디자인-리뷰",
        " 디자인 리뷰 ",
        "\u{1103}\u{1175}\u{110C}\u{1161}\u{110B}\u{1175}\u{11AB}-\u{1105}\u{1175}\u{1107}\u{1172}",
    ] {
        let (status, body) = patch(
            &r.http,
            &r.base,
            r.ws.id,
            ch,
            &r.admin,
            &json!({"name": spelling}),
        )
        .await;
        assert_eq!(status, 200, "{spelling:?} {body}");
        assert_eq!(body["channel"]["name"], "디자인-리뷰");
    }
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 0);
}

/// Who may not: a plain member, a real guest, an agent bearer; and the refusals leave
/// the name and the audit log alone.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn member_guest_and_agent_are_refused() {
    let _guard = test_lock().await;
    let r = rig("rn-who").await;
    let ch = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("keep-me"),
        false,
        r.ws.owner.id,
    )
    .await;
    let guest = seed_human(&r.su, r.ws.id, "guest", "정하늘").await;
    let guest_token = login(&r.http, &r.base, r.ws.id, &guest).await;
    let agent_token = bearer_for_agent(&r.su, r.ws.id, r.ws.agent).await;
    set_default(&r.su, ch, false).await;
    for field in [
        json!({"name": "taken-over"}),
        json!({"browseListed": true}),
        json!({"isDefault": true}),
    ] {
        for (who, token) in [
            ("member", &r.member),
            ("guest", &guest_token),
            ("agent", &agent_token),
        ] {
            let (status, body) = patch(&r.http, &r.base, r.ws.id, ch, token, &field).await;
            assert_eq!(status, 403, "{who} {field} {body}");
        }
    }
    assert_eq!(channel_name(&r.su, ch).await, "keep-me");
    assert!(!browse_listed(&r.su, ch).await);
    assert!(!is_default(&r.su, ch).await);
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 0);
    assert_eq!(browse_listed_audit(&r.su, r.ws.id).await, 0);
    assert_eq!(default_audit(&r.su, r.ws.id).await, 0);
}

/// Other workspace's channel, DM, group DM, archived, unknown id: the same 404.
/// A private channel the admin is not in: also that 404.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn targets_that_are_not_renamable_channels_all_answer_the_same_404() {
    let _guard = test_lock().await;
    let r = rig("rn-404").await;
    let other = seed(&r.su, "rn-404-other").await;
    let foreign = insert_channel(
        &r.su,
        other.id,
        "public",
        Some("foreign"),
        false,
        other.owner.id,
    )
    .await;
    let dm = insert_channel(&r.su, r.ws.id, "dm", None, false, r.ws.owner.id).await;
    let group_dm = insert_channel(
        &r.su,
        r.ws.id,
        "dm",
        Some("산책 모임"),
        false,
        r.ws.owner.id,
    )
    .await;
    let archived = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("old-archive"),
        true,
        r.ws.owner.id,
    )
    .await;
    let hidden_private = insert_channel(
        &r.su,
        r.ws.id,
        "private",
        Some("secret-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    // The admin sits in the DM and the group DM: only the kind keeps them out.
    join(&r.su, r.ws.id, dm, r.ws.admin.id).await;
    join(&r.su, r.ws.id, group_dm, r.ws.admin.id).await;
    let mut seen = BTreeSet::new();
    for target in [
        foreign,
        dm,
        group_dm,
        archived,
        hidden_private,
        Uuid::new_v4(),
    ] {
        let (status, body) = patch(
            &r.http,
            &r.base,
            r.ws.id,
            target,
            &r.admin,
            &json!({"name": "new-name"}),
        )
        .await;
        assert_eq!(status, 404, "{target} {body}");
        seen.insert(error_message(&body).to_string());
    }
    assert_eq!(seen.len(), 1, "one answer for every kind of miss: {seen:?}");
    assert_eq!(channel_name(&r.su, foreign).await, "foreign");
    assert_eq!(channel_name(&r.su, hidden_private).await, "secret-room");
    // once the admin is a live member of the private channel, it renames
    join(&r.su, r.ws.id, hidden_private, r.ws.admin.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        hidden_private,
        &r.admin,
        &json!({"name": "open-room"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // a token of the other workspace is refused at the scope
    let other_admin = login(&r.http, &r.base, other.id, &other.admin).await;
    let (status, _) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        archived,
        &other_admin,
        &json!({"name": "x1"}),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 1);
}

/// The four bad names are 400 with create's own messages; shape errors are 400.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn bad_names_and_bad_bodies_are_400_like_create() {
    let _guard = test_lock().await;
    let r = rig("rn-400").await;
    let ch = insert_channel(&r.su, r.ws.id, "public", Some("fine"), false, r.ws.owner.id).await;
    let long = "가".repeat(81);
    for bad in [
        "a.b",
        "ab\u{200B}cd",
        "-edge",
        "edge-",
        long.as_str(),
        "   ",
    ] {
        let (status, body) = patch(
            &r.http,
            &r.base,
            r.ws.id,
            ch,
            &r.owner,
            &json!({"name": bad}),
        )
        .await;
        let (cstatus, cbody) =
            create_channel(&r.http, &r.base, r.ws.id, &r.owner, "public", bad).await;
        assert_eq!(status, 400, "{bad:?} {body}");
        assert_eq!(cstatus, 400);
        assert_eq!(error_message(&body), error_message(&cbody), "{bad:?}");
    }
    for bad_body in [
        json!({}),
        json!({"topic": "x"}),
        json!({"name": "ok", "isArchived": true}),
        json!({"isDefault": "yes"}),
        json!({"name": 5}),
        json!([1]),
    ] {
        let (status, body) = patch(&r.http, &r.base, r.ws.id, ch, &r.owner, &bad_body).await;
        assert_eq!(status, 400, "{bad_body} {body}");
    }
    assert_eq!(channel_name(&r.su, ch).await, "fine");
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 0);
}

/// 409 on a clash (any spelling, a live channel only); archived names do not clash.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn a_live_name_clash_is_409_and_an_archived_one_is_not() {
    let _guard = test_lock().await;
    let r = rig("rn-409").await;
    let a = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("alpha"),
        false,
        r.ws.owner.id,
    )
    .await;
    let _b = insert_channel(
        &r.su,
        r.ws.id,
        "private",
        Some("베타"),
        false,
        r.ws.owner.id,
    )
    .await;
    let _gone = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("retired"),
        true,
        r.ws.owner.id,
    )
    .await;
    join(&r.su, r.ws.id, a, r.ws.owner.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        a,
        &r.owner,
        &json!({"name": "베타"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(error_message(&body), "channel name already exists");
    assert_eq!(channel_name(&r.su, a).await, "alpha");
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        a,
        &r.owner,
        &json!({"name": "Retired"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 1);
}

/// Two requests racing for one name: one wins, the other is 409, never a 500.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn two_requests_racing_for_one_name_give_one_200_and_one_409() {
    let _guard = test_lock().await;
    let r = rig("rn-race").await;
    for round in 0..5 {
        let a = insert_channel(
            &r.su,
            r.ws.id,
            "public",
            Some(&format!("race-a-{round}")),
            false,
            r.ws.owner.id,
        )
        .await;
        let b = insert_channel(
            &r.su,
            r.ws.id,
            "public",
            Some(&format!("race-b-{round}")),
            false,
            r.ws.owner.id,
        )
        .await;
        join(&r.su, r.ws.id, a, r.ws.owner.id).await;
        join(&r.su, r.ws.id, b, r.ws.admin.id).await;
        let name = format!("경합-{round}");
        let body = json!({"name": name});
        let (first, second) = tokio::join!(
            patch(&r.http, &r.base, r.ws.id, a, &r.owner, &body),
            patch(&r.http, &r.base, r.ws.id, b, &r.admin, &body),
        );
        let mut codes = [first.0.as_u16(), second.0.as_u16()];
        codes.sort_unstable();
        assert_eq!(codes, [200, 409], "round {round}: {first:?} {second:?}");
        let taken: i64 = sqlx::query_scalar(
            "SELECT count(*)::bigint FROM channel WHERE workspace_id = $1 AND name = $2",
        )
        .bind(r.ws.id)
        .bind(&name)
        .fetch_one(&r.su)
        .await
        .expect("count");
        assert_eq!(taken, 1);
    }
}

/// `general` is locked both ways, however the name is spelled, and the answer has its own code.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn general_is_locked_in_both_directions() {
    let _guard = test_lock().await;
    let r = rig("rn-gen").await;
    let general = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("general"),
        false,
        r.ws.owner.id,
    )
    .await;
    let other = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("lounge"),
        false,
        r.ws.owner.id,
    )
    .await;
    join(&r.su, r.ws.id, general, r.ws.owner.id).await;
    join(&r.su, r.ws.id, other, r.ws.owner.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        general,
        &r.owner,
        &json!({"name": "일반"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "general_channel_locked");
    for spelling in [
        "general",
        "General",
        "\u{FF47}\u{FF45}\u{FF4E}\u{FF45}\u{FF52}\u{FF41}\u{FF4C}",
        "  GENERAL  ",
    ] {
        let (status, body) = patch(
            &r.http,
            &r.base,
            r.ws.id,
            other,
            &r.owner,
            &json!({"name": spelling}),
        )
        .await;
        assert_eq!(status, 409, "{spelling:?} {body}");
        assert_eq!(body["error"]["code"], "general_channel_locked");
    }
    // the create route's own 409 carries no such code
    let (status, body) =
        create_channel(&r.http, &r.base, r.ws.id, &r.owner, "public", "general").await;
    assert_eq!(status, 409);
    assert!(body["error"]["code"].is_null(), "{body}");
    assert_eq!(channel_name(&r.su, general).await, "general");
    assert_eq!(channel_name(&r.su, other).await, "lounge");
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 0);
}

// ---------------------------------------------------------------------------
// ADR-0224 D2 — the `browseListed` switch and the one target condition
// ---------------------------------------------------------------------------

/// Owner and admin switch the browse listing. Each switch is one audit row (who,
/// which channel, old and new); the same value again writes nothing; switching off
/// moves no membership and makes the self-join answer like an unknown id; switching
/// on opens it again. The answer is the channel in the channel list's shape.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn switching_browse_listing_moves_only_the_self_join_door() {
    let _guard = test_lock().await;
    let r = rig("bl-door").await;
    let ch = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("open-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    set_browse_listed(&r.su, ch, true).await;
    join(&r.su, r.ws.id, ch, r.ws.owner.id).await;
    join(&r.su, r.ws.id, ch, r.ws.member.id).await;
    let seated = live_member_ids(&r.su, ch).await;
    let newcomer = seed_human(&r.su, r.ws.id, "member", "한지우").await;
    let newcomer_token = login(&r.http, &r.base, r.ws.id, &newcomer).await;
    let (status, unknown_join) =
        self_join(&r.http, &r.base, r.ws.id, Uuid::new_v4(), &newcomer_token).await;
    assert_eq!(status, 404);

    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        ch,
        &r.owner,
        &json!({"browseListed": false}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let channel = &body["channel"];
    assert_eq!(channel["id"], ch.to_string());
    assert_eq!(channel["workspaceId"], r.ws.id.to_string());
    assert_eq!(channel["kind"], "public");
    assert_eq!(channel["name"], "open-room");
    assert_eq!(channel["browseListed"], false);
    assert_eq!(channel["isDefault"], false);
    assert_eq!(channel["muted"], false);
    assert!(!browse_listed(&r.su, ch).await);
    assert_eq!(
        live_member_ids(&r.su, ch).await,
        seated,
        "switching off moves no membership"
    );
    let (status, body) = self_join(&r.http, &r.base, r.ws.id, ch, &newcomer_token).await;
    assert_eq!(
        (status, &body),
        (StatusCode::NOT_FOUND, &unknown_join),
        "browse-off joins like an unknown id"
    );

    // the same value again: 200, nothing written
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        ch,
        &r.owner,
        &json!({"browseListed": false}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(browse_listed_audit(&r.su, r.ws.id).await, 1);

    // a seated admin switches it back on; the door opens again
    join(&r.su, r.ws.id, ch, r.ws.admin.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        ch,
        &r.admin,
        &json!({"browseListed": true}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["channel"]["browseListed"], true);
    assert!(browse_listed(&r.su, ch).await);
    let (status, body) = self_join(&r.http, &r.base, r.ws.id, ch, &newcomer_token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["newlyJoined"], true);

    let rows = browse_listed_rows(&r.su, r.ws.id).await;
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0].0, r.ws.owner.id);
    assert_eq!(
        (&rows[0].1["old"], &rows[0].1["new"]),
        (&json!(true), &json!(false)),
        "{rows:?}"
    );
    assert_eq!(rows[1].0, r.ws.admin.id);
    assert_eq!(
        (&rows[1].1["old"], &rows[1].1["new"]),
        (&json!(false), &json!(true)),
        "{rows:?}"
    );
    let targets: Vec<Uuid> = sqlx::query_scalar(
        "SELECT target_id FROM audit_log WHERE workspace_id = $1 AND action = 'channel.browse_listed'",
    )
    .bind(r.ws.id)
    .fetch_all(&r.su)
    .await
    .expect("audit targets");
    assert_eq!(targets, vec![ch, ch]);
}

/// A private channel, a DM and an archived channel the admin sits in cannot be
/// listed (409 `channel_not_listable`, whichever value is asked). Judged before any
/// write: a rename sent in the same body is not applied. `name` and
/// `browseListed` that both pass are applied together.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn browse_listing_is_refused_on_channels_that_cannot_be_listed() {
    let _guard = test_lock().await;
    let r = rig("bl-kind").await;
    let private = insert_channel(
        &r.su,
        r.ws.id,
        "private",
        Some("secret-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    let dm = insert_channel(&r.su, r.ws.id, "dm", None, false, r.ws.owner.id).await;
    let archived = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("old-archive"),
        true,
        r.ws.owner.id,
    )
    .await;
    for ch in [private, dm, archived] {
        join(&r.su, r.ws.id, ch, r.ws.admin.id).await;
    }
    for (label, ch) in [("private", private), ("dm", dm), ("archived", archived)] {
        for listed in [true, false] {
            let (status, body) = patch(
                &r.http,
                &r.base,
                r.ws.id,
                ch,
                &r.admin,
                &json!({"browseListed": listed}),
            )
            .await;
            assert_eq!(status, 409, "{label} {listed} {body}");
            assert_eq!(
                body["error"]["code"], "channel_not_listable",
                "{label} {body}"
            );
        }
        assert!(!browse_listed(&r.su, ch).await, "{label}");
    }
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        private,
        &r.admin,
        &json!({"name": "renamed-room", "browseListed": true}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        channel_name(&r.su, private).await,
        "secret-room",
        "nothing of a refused body is applied"
    );
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 0);
    assert_eq!(browse_listed_audit(&r.su, r.ws.id).await, 0);

    let quiet = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("quiet-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    join(&r.su, r.ws.id, quiet, r.ws.admin.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        quiet,
        &r.admin,
        &json!({"name": "lobby", "browseListed": true}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["channel"]["name"], "lobby");
    assert_eq!(body["channel"]["browseListed"], true);
    assert_eq!(channel_name(&r.su, quiet).await, "lobby");
    assert!(browse_listed(&r.su, quiet).await);
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 1);
    assert_eq!(browse_listed_audit(&r.su, r.ws.id).await, 1);
}

/// The one target condition of the channel PATCH: a channel the admin sits in, or one
/// open to people. A browse-off public channel and a private channel the admin is not
/// in, another workspace's channel and an unknown id give the same 404 bytes for every
/// field and change nothing — so do an archived channel that is still marked listed, and
/// the two hidden channels for an admin who sat in them and left. An unseated admin may
/// edit a listed channel (the answer is still the full channel), and loses it once it is
/// switched off.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn an_admin_outside_a_hidden_channel_gets_the_unknown_id_404_for_every_field() {
    let _guard = test_lock().await;
    let r = rig("bl-target").await;
    let other = seed(&r.su, "bl-target-other").await;
    let off_public = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("quiet-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    let private = insert_channel(
        &r.su,
        r.ws.id,
        "private",
        Some("secret-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    let foreign = insert_channel(
        &r.su,
        other.id,
        "public",
        Some("foreign"),
        false,
        other.owner.id,
    )
    .await;
    set_browse_listed(&r.su, foreign, true).await;
    let archived_listed = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("old-lobby"),
        true,
        r.ws.owner.id,
    )
    .await;
    set_browse_listed(&r.su, archived_listed, true).await;
    for ch in [off_public, private] {
        join(&r.su, r.ws.id, ch, r.ws.owner.id).await;
    }
    // An admin who sat in both hidden channels and has left them.
    let left_admin = seed_human(&r.su, r.ws.id, "admin", "윤가람").await;
    let left_token = login(&r.http, &r.base, r.ws.id, &left_admin).await;
    for ch in [off_public, private] {
        join(&r.su, r.ws.id, ch, left_admin.id).await;
        sqlx::query(
            "UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2",
        )
        .bind(ch)
        .bind(left_admin.id)
        .execute(&r.su)
        .await
        .expect("leave");
    }
    for field in [
        json!({"name": "taken-over"}),
        json!({"browseListed": true}),
        json!({"browseListed": false}),
        json!({"isDefault": true}),
    ] {
        let (status, unknown) =
            patch(&r.http, &r.base, r.ws.id, Uuid::new_v4(), &r.admin, &field).await;
        assert_eq!(status, 404, "{field} {unknown}");
        for (label, ch, token) in [
            ("off_public", off_public, &r.admin),
            ("private", private, &r.admin),
            ("foreign", foreign, &r.admin),
            ("archived_listed", archived_listed, &r.admin),
            ("off_public after leaving", off_public, &left_token),
            ("private after leaving", private, &left_token),
        ] {
            let (status, body) = patch(&r.http, &r.base, r.ws.id, ch, token, &field).await;
            assert_eq!(
                (status, &body),
                (StatusCode::NOT_FOUND, &unknown),
                "{label} {field}"
            );
        }
    }
    assert_eq!(channel_name(&r.su, archived_listed).await, "old-lobby");
    assert_eq!(channel_name(&r.su, off_public).await, "quiet-room");
    assert_eq!(channel_name(&r.su, private).await, "secret-room");
    assert_eq!(channel_name(&r.su, foreign).await, "foreign");
    assert!(!browse_listed(&r.su, off_public).await);
    assert!(browse_listed(&r.su, foreign).await);
    assert_eq!(renamed_audit(&r.su, r.ws.id).await, 0);
    assert_eq!(browse_listed_audit(&r.su, r.ws.id).await, 0);
    assert_eq!(browse_listed_audit(&r.su, other.id).await, 0);
    assert_eq!(default_audit(&r.su, r.ws.id).await, 0);
    assert_eq!(default_audit(&r.su, other.id).await, 0);
    assert!(!is_default(&r.su, off_public).await);

    // a listed channel the admin does not sit in: editable, and the answer is whole
    let listed = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("open-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    set_browse_listed(&r.su, listed, true).await;
    join(&r.su, r.ws.id, listed, r.ws.owner.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        listed,
        &r.admin,
        &json!({"name": "lobby"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        listed,
        &r.admin,
        &json!({"browseListed": false}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["channel"]["name"], "lobby");
    assert_eq!(body["channel"]["browseListed"], false);
    assert_eq!(body["channel"]["isDefault"], false);
    // switched off, it is outside the admin's reach again
    let (status, unknown) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        Uuid::new_v4(),
        &r.admin,
        &json!({"browseListed": true}),
    )
    .await;
    assert_eq!(status, 404);
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        listed,
        &r.admin,
        &json!({"browseListed": true}),
    )
    .await;
    assert_eq!((status, &body), (StatusCode::NOT_FOUND, &unknown));

    // seated, the same admin edits a browse-off public channel and a private one
    join(&r.su, r.ws.id, off_public, r.ws.admin.id).await;
    join(&r.su, r.ws.id, private, r.ws.admin.id).await;
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        off_public,
        &r.admin,
        &json!({"browseListed": true}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        private,
        &r.admin,
        &json!({"name": "open-secret"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

/// ADR-0224 D6: `isDefault` is judged on the same target and kind rule as the browse
/// switch, writes one `channel.default` row per real change, touches no
/// membership and no other field, and never turns off the last default channel.
/// A body that mixes fields is all or nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_default_switch_keeps_one_default_and_changes_nothing_else() {
    let _guard = test_lock().await;
    let r = rig("df-switch").await;
    let a = seated_public(&r, "alpha-room", true).await;
    let b = seated_public(&r, "beta-room", true).await;
    let c = seated_public(&r, "gamma-room", false).await;
    let seated_c = live_member_ids(&r.su, c).await;

    // on: the flag moves, the seats do not, browse listing stays as it was
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        c,
        &r.owner,
        &json!({"isDefault": true}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["channel"]["isDefault"], true);
    assert_eq!(body["channel"]["browseListed"], true);
    assert_eq!(live_member_ids(&r.su, c).await, seated_c);
    // the same value again: 200, no second audit row
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        c,
        &r.admin,
        &json!({"isDefault": true}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let rows: Vec<(Uuid, Value)> = sqlx::query_as(
        "SELECT actor_member_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'channel.default'",
    )
    .bind(r.ws.id)
    .fetch_all(&r.su)
    .await
    .expect("default audit rows");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, r.ws.owner.id);
    assert_eq!(
        (&rows[0].1["old"], &rows[0].1["new"]),
        (&json!(false), &json!(true))
    );

    // a kind that cannot be a default: 409 for either value, and the rest of the body is not applied
    let private = insert_channel(
        &r.su,
        r.ws.id,
        "private",
        Some("hush-room"),
        false,
        r.ws.owner.id,
    )
    .await;
    let dm = insert_channel(&r.su, r.ws.id, "dm", None, false, r.ws.owner.id).await;
    let archived = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("old-hall"),
        true,
        r.ws.owner.id,
    )
    .await;
    for ch in [private, dm, archived] {
        join(&r.su, r.ws.id, ch, r.ws.owner.id).await;
        for wanted in [true, false] {
            let (status, body) = patch(
                &r.http,
                &r.base,
                r.ws.id,
                ch,
                &r.owner,
                &json!({"isDefault": wanted}),
            )
            .await;
            assert_eq!(status, 409, "{wanted} {body}");
            assert_eq!(body["error"]["code"], "channel_not_defaultable");
        }
    }
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        private,
        &r.owner,
        &json!({"name": "renamed-hush", "isDefault": true}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(channel_name(&r.su, private).await, "hush-room");
    assert_eq!(default_audit(&r.su, r.ws.id).await, 1);

    // all or nothing: a name clash refuses the whole body, the default flag included
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        c,
        &r.owner,
        &json!({"name": "alpha-room", "browseListed": false, "isDefault": false}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(is_default(&r.su, c).await);
    assert!(browse_listed(&r.su, c).await);
    assert_eq!(channel_name(&r.su, c).await, "gamma-room");
    // all three together apply together
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        c,
        &r.owner,
        &json!({"name": "delta-room", "browseListed": false, "isDefault": false}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["channel"]["name"], "delta-room");
    assert_eq!(body["channel"]["browseListed"], false);
    assert_eq!(body["channel"]["isDefault"], false);
    assert_eq!(default_audit(&r.su, r.ws.id).await, 2);
    assert_eq!(live_member_ids(&r.su, c).await, seated_c);

    // the last default cannot go: b may, then a may not
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        b,
        &r.owner,
        &json!({"isDefault": false}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        a,
        &r.owner,
        &json!({"isDefault": false}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "last_default_channel");
    assert!(is_default(&r.su, a).await);
    assert_eq!(default_count(&r.su, r.ws.id).await, 1);
    assert_eq!(default_audit(&r.su, r.ws.id).await, 3);
    // listing and default are separate: unlisting the last default keeps it default
    let (status, body) = patch(
        &r.http,
        &r.base,
        r.ws.id,
        a,
        &r.owner,
        &json!({"browseListed": false}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(is_default(&r.su, a).await);
}

/// Two admins each turning off a different one of the two remaining defaults at
/// once: exactly one wins and one default stays, every round.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn two_requests_turning_off_the_two_defaults_leave_one() {
    let _guard = test_lock().await;
    let r = rig("df-race").await;
    let a = seated_public(&r, "alpha-room", true).await;
    let b = seated_public(&r, "beta-room", true).await;
    for round in 0..8 {
        set_default(&r.su, a, true).await;
        set_default(&r.su, b, true).await;
        let off = json!({"isDefault": false});
        let (first, second) = tokio::join!(
            patch(&r.http, &r.base, r.ws.id, a, &r.owner, &off),
            patch(&r.http, &r.base, r.ws.id, b, &r.admin, &off),
        );
        let mut statuses = [first.0.as_u16(), second.0.as_u16()];
        statuses.sort_unstable();
        assert_eq!(
            statuses,
            [200, 409],
            "round {round}: {} / {}",
            first.1,
            second.1
        );
        assert_eq!(default_count(&r.su, r.ws.id).await, 1, "round {round}");
    }
}
