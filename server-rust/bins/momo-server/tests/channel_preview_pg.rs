//! #5840 (ADR-0224 D5·D8·D11) — `GET …/channels/{ch}/preview`: reading a public channel
//! before joining it.
//!
//! What this file pins:
//!   * the preview is an allow-list — channel name, topic, member count (the browse row's
//!     count) and `isMember`; per message only id, body, author name and kind, time,
//!     edited/deleted marks, reply count and attachment names — and the member's own history
//!     of the same channel shows the planted reaction, thread reply, props and attachment
//!     address that the preview leaves out;
//!   * D11 claim 2 — every channel that is not open to people (private, DM, browse off,
//!     archived, another workspace's, unknown) answers the preview with the join's 404, byte
//!     for byte, even for a caller seated there;
//!   * D11 claim 3 — a guest, a suspended person and an agent bearer are refused the preview
//!     with the join's answer, whichever channel they name;
//!   * a preview writes no read position, membership, audit or outbox row, and opens neither
//!     the attachment content route nor the realtime subscription — both open after a join.
//!
//! `#[ignore]` — needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:55840/momo \
//!   cargo test -p momo-server --test channel_preview_pg \
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
use momo_server::config::RealtimeSettings;
use momo_server::routes::realtime::PROXY_SECRET_HEADER;
use momo_server::{build_app, AppState};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "channel-preview-signing";
const TEST_PASSWORD: &str = "channel-preview-password";

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

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

struct Human {
    id: Uuid,
    email: String,
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

fn app_state(pool: PgPool) -> AppState {
    AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_realtime(RealtimeSettings {
        cent_token_hmac: Some(CENT_SIGNING.to_string()),
        cent_proxy_secret: Some(PROXY_HEADER_VALUE.to_string()),
        connection_token_ttl_seconds: momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
    })
}

const CENT_SIGNING: &str = "channel-preview-cent";
const PROXY_HEADER_VALUE: &str = "channel-preview-proxy";

async fn start_server(state: AppState) -> String {
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

fn send_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages")
}

fn browse_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/browse")
}

fn join_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/members/me")
}

/// One HTTP call, the body kept as the bytes the server sent.
async fn call_raw(
    http: &reqwest::Client,
    method: Method,
    url: &str,
    token: &str,
) -> (StatusCode, String) {
    let response = http
        .request(method, url)
        .bearer_auth(token)
        .send()
        .await
        .expect("http call");
    let status = response.status();
    let body = response.text().await.expect("body text");
    (status, body)
}

async fn browse_raw(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    token: &str,
    query: &str,
) -> (StatusCode, String) {
    call_raw(
        http,
        Method::GET,
        &format!("{}{query}", browse_url(base, workspace)),
        token,
    )
    .await
}

async fn browse(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    token: &str,
    query: &str,
) -> Value {
    let (status, body) = browse_raw(http, base, workspace, token, query).await;
    assert_eq!(status, 200, "browse {query}: {body}");
    serde_json::from_str(&body).expect("browse json")
}

async fn join_raw(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    channel: Uuid,
    token: &str,
) -> (StatusCode, String) {
    call_raw(
        http,
        Method::POST,
        &join_url(base, workspace, channel),
        token,
    )
    .await
}

fn row_names(page: &Value) -> Vec<String> {
    page["channels"]
        .as_array()
        .expect("channels array")
        .iter()
        .map(|row| row["name"].as_str().expect("name").to_string())
        .collect()
}

fn row_ids(page: &Value) -> BTreeSet<String> {
    page["channels"]
        .as_array()
        .expect("channels array")
        .iter()
        .map(|row| row["id"].as_str().expect("id").to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// SQL probes and setters (superuser, so RLS hides nothing)
// ---------------------------------------------------------------------------

async fn set_topic(su: &PgPool, channel: Uuid, topic: &str) {
    sqlx::query("UPDATE channel SET topic = $2 WHERE id = $1")
        .bind(channel)
        .bind(topic)
        .execute(su)
        .await
        .expect("set topic");
}

async fn set_listed(su: &PgPool, channel: Uuid, listed: bool) {
    sqlx::query("UPDATE channel SET browse_listed = $2 WHERE id = $1")
        .bind(channel)
        .bind(listed)
        .execute(su)
        .await
        .expect("set browse_listed");
}

async fn set_default(su: &PgPool, channel: Uuid) {
    sqlx::query("UPDATE channel SET is_default = true WHERE id = $1")
        .bind(channel)
        .execute(su)
        .await
        .expect("set is_default");
}

/// A public channel with `browse_listed` on — what the create route makes.
async fn open_channel(su: &PgPool, workspace: Uuid, name: &str, creator: Uuid) -> Uuid {
    let id = insert_channel(su, workspace, "public", Some(name), false, creator).await;
    set_listed(su, id, true).await;
    id
}

async fn seat(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, $4::membership_role)",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("seat member");
}

async fn mark_left(su: &PgPool, channel: Uuid, member: Uuid) {
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("mark left");
}

/// `(role, live)` of the membership row, or `None` when there is none.
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

async fn membership_total(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM membership WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count memberships")
}

async fn read_seq(su: &PgPool, channel: Uuid, member: Uuid) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT last_read_seq FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read cursor")
}

async fn set_read_seq(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid, seq: i64) {
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET last_read_seq = EXCLUDED.last_read_seq",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .bind(seq)
    .execute(su)
    .await
    .expect("set read cursor");
}

async fn last_seq(su: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("channel_seq row")
}

/// `detail` of every `channel.joined` row about `channel`, oldest first.
async fn joined_audits(su: &PgPool, workspace: Uuid, channel: Uuid) -> Vec<(Uuid, Value)> {
    sqlx::query_as(
        "SELECT actor_member_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'channel.joined' AND target_id = $2 \
          ORDER BY created_at, id",
    )
    .bind(workspace)
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("read channel.joined audit")
}

async fn joined_audit_total(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log WHERE workspace_id = $1 AND action = 'channel.joined'",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("count channel.joined audit")
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

async fn rig_with(hint: &str, state: impl FnOnce(PgPool) -> AppState) -> Rig {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(state(app)).await;
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

async fn rig(hint: &str) -> Rig {
    rig_with(hint, app_state).await
}

/// The five kinds of channel D11 is about, each carrying a marker no other channel
/// carries in its name and in its topic.
struct Kinds {
    open: Uuid,
    off: Uuid,
    private: Uuid,
    dm: Uuid,
    archived: Uuid,
    /// An open channel of another workspace.
    foreign: Uuid,
}

const OPEN_MARK: &str = "mark-open-7f3a";
const HIDDEN_MARKS: [&str; 5] = [
    "mark-off-91c2",
    "mark-private-5d0e",
    "mark-dm-2b8f",
    "mark-archived-c4a1",
    "mark-foreign-e6d9",
];

async fn seed_kinds(r: &Rig, other: &Workspace) -> Kinds {
    let su = &r.su;
    let ws = r.ws.id;
    let creator = r.ws.owner.id;
    let open = open_channel(su, ws, &format!("{OPEN_MARK}-name"), creator).await;
    let off = insert_channel(su, ws, "public", Some("mark-off-91c2-name"), false, creator).await;
    let private = insert_channel(
        su,
        ws,
        "private",
        Some("mark-private-5d0e-name"),
        false,
        creator,
    )
    .await;
    // A named group DM: the kind is the only thing that keeps it out.
    let dm = insert_channel(su, ws, "dm", Some("mark-dm-2b8f-name"), false, creator).await;
    let archived = open_channel(su, ws, "mark-archived-c4a1-name", creator).await;
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(archived)
        .execute(su)
        .await
        .expect("archive");
    let foreign = open_channel(su, other.id, "mark-foreign-e6d9-name", other.owner.id).await;
    for (channel, mark) in [
        (open, OPEN_MARK),
        (off, HIDDEN_MARKS[0]),
        (private, HIDDEN_MARKS[1]),
        (dm, HIDDEN_MARKS[2]),
        (archived, HIDDEN_MARKS[3]),
        (foreign, HIDDEN_MARKS[4]),
    ] {
        set_topic(su, channel, &format!("{mark}-topic")).await;
    }
    Kinds {
        open,
        off,
        private,
        dm,
        archived,
        foreign,
    }
}

// ---------------------------------------------------------------------------
// preview helpers
// ---------------------------------------------------------------------------

fn preview_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/preview")
}

async fn preview_raw(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    channel: Uuid,
    token: &str,
) -> (StatusCode, String) {
    call_raw(
        http,
        Method::GET,
        &preview_url(base, workspace, channel),
        token,
    )
    .await
}

async fn preview(r: &Rig, channel: Uuid, token: &str) -> (String, Value) {
    let (status, body) = preview_raw(&r.http, &r.base, r.ws.id, channel, token).await;
    assert_eq!(status, 200, "preview: {body}");
    let value = serde_json::from_str(&body).expect("preview json");
    (body, value)
}

fn keys(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .expect("an object")
        .keys()
        .cloned()
        .collect()
}

fn key_set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

/// Rows a preview must never add to: read positions, memberships, audit, outbox.
async fn side_rows(su: &PgPool, workspace: Uuid) -> [i64; 4] {
    let mut counts = [0; 4];
    for (at, table) in ["read_state", "membership", "audit_log", "outbox"]
        .into_iter()
        .enumerate()
    {
        counts[at] = sqlx::query_scalar(&format!(
            "SELECT count(*)::bigint FROM {table} WHERE workspace_id = $1"
        ))
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count side rows");
    }
    counts
}

async fn send_ok(r: &Rig, channel: Uuid, token: &str, body: &str) -> Uuid {
    let (status, sent) = send_text(&r.http, &r.base, r.ws.id, channel, token, body).await;
    assert_eq!(status, 201, "send: {sent}");
    Uuid::parse_str(sent["id"].as_str().expect("message id")).expect("uuid")
}

/// A completed attachment bound to `message`, as the complete route leaves it.
async fn plant_attachment(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    uploader: Uuid,
    message: Uuid,
    name: &str,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, message_id, \
                                 drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, 'application/x-preview-mime-b81c', 4242, 'complete') \
         RETURNING id",
    )
    .bind(workspace)
    .bind(channel)
    .bind(uploader)
    .bind(message)
    .bind(format!("drive-{}", Uuid::new_v4()))
    .bind(name)
    .fetch_one(su)
    .await
    .expect("plant attachment")
}

async fn call_raw_json(
    http: &reqwest::Client,
    method: Method,
    url: &str,
    token: &str,
    body: &Value,
) -> (StatusCode, String) {
    let response = http
        .request(method, url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("http call");
    let status = response.status();
    (status, response.text().await.expect("body"))
}

fn realtime_name(workspace: Uuid, channel: Uuid) -> String {
    format!(
        "ch:ws{}.{}",
        workspace.to_string().to_uppercase(),
        channel.to_string().to_uppercase()
    )
}

/// The subscribe proxy's decision for `token`'s person on `channel` (raw body).
async fn subscribe_decision(r: &Rig, token: &str, channel: Uuid) -> String {
    let response = r
        .http
        .post(format!("{}/v1/auth/realtime-token", r.base))
        .bearer_auth(token)
        .send()
        .await
        .expect("realtime token");
    assert_eq!(response.status(), 200, "connection token");
    let body: Value = response.json().await.expect("token body");
    let claims = jsonwebtoken::decode::<momo_auth::CentrifugoConnectionClaims>(
        body["token"].as_str().expect("token"),
        &jsonwebtoken::DecodingKey::from_secret(CENT_SIGNING.as_bytes()),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )
    .expect("verify connection token")
    .claims;
    let response = r
        .http
        .post(format!("{}/v1/centrifugo/subscribe", r.base))
        .header(PROXY_SECRET_HEADER, PROXY_HEADER_VALUE)
        .json(&json!({
            "client": Uuid::new_v4().to_string(),
            "user": claims.sub,
            "channel": realtime_name(r.ws.id, channel),
            "meta": { "schema": claims.meta.schema, "token_id": claims.meta.token_id },
        }))
        .send()
        .await
        .expect("subscribe proxy");
    assert_eq!(response.status(), 200, "a proxy decision is HTTP 200");
    response.text().await.expect("proxy body")
}

const SUBSCRIBE_ALLOW: &str = r#"{"result":{}}"#;

const REPLY_MARK: &str = "reply-mark-3c1d";
const REACTION_MARK: &str = "reaction-mark-77e0";
const PROPS_MARK: &str = "props-mark-a9b4";
const FILE_NAME: &str = "회의록-mark-5e2f.pdf";

// ---------------------------------------------------------------------------
// The narrow shape
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_preview_carries_only_the_narrow_shape_of_the_newest_top_level_messages() {
    let _guard = test_lock().await;
    let r = rig("pv-shape").await;
    let ch = open_channel(&r.su, r.ws.id, "pv-lounge", r.ws.owner.id).await;
    set_topic(&r.su, ch, "pv-topic").await;
    seat(&r.su, r.ws.id, ch, r.ws.owner.id, "owner").await;

    // Who counts: owner + agent + one more person. A left, a suspended and a deleted member
    // do not.
    seat(&r.su, r.ws.id, ch, r.ws.agent, "member").await;
    let counted = seed_human(&r.su, r.ws.id, "member", "김도현").await;
    seat(&r.su, r.ws.id, ch, counted.id, "member").await;
    let left = seed_human(&r.su, r.ws.id, "member", "윤가람").await;
    seat(&r.su, r.ws.id, ch, left.id, "member").await;
    mark_left(&r.su, ch, left.id).await;
    let suspended = seed_human(&r.su, r.ws.id, "member", "서하은").await;
    seat(&r.su, r.ws.id, ch, suspended.id, "member").await;
    let suspended_token = login(&r.http, &r.base, r.ws.id, &suspended).await;
    for n in 0..50 {
        send_ok(&r, ch, &r.owner, &format!("filler {n}")).await;
    }
    // Written while active; its author is suspended afterwards.
    send_ok(&r, ch, &suspended_token, "from-a-suspended-author").await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(suspended.id)
        .execute(&r.su)
        .await
        .expect("suspend");
    let deleted = seed_human(&r.su, r.ws.id, "member", "문채원").await;
    seat(&r.su, r.ws.id, ch, deleted.id, "member").await;
    sqlx::query("UPDATE member SET deleted_at = now() WHERE id = $1")
        .bind(deleted.id)
        .execute(&r.su)
        .await
        .expect("delete member");

    // Then four that carry what the preview must narrow.
    let root = send_ok(&r, ch, &r.owner, "root-text").await;
    let (status, sent) = call(
        &r.http,
        Method::POST,
        &send_url(&r.base, r.ws.id, ch),
        &r.owner,
        Some(
            &json!({"clientMsgId": Uuid::new_v4(), "type": "text", "body": REPLY_MARK,
                     "rootId": root.to_string()}),
        ),
    )
    .await;
    assert_eq!(status, 201, "reply: {sent}");
    let edited = send_ok(&r, ch, &r.owner, "before-edit").await;
    let (status, body) = call(
        &r.http,
        Method::PATCH,
        &format!("{}/v1/workspaces/{}/messages/{edited}", r.base, r.ws.id),
        &r.owner,
        Some(&json!({"body": "after-edit"})),
    )
    .await;
    assert_eq!(status, 200, "edit: {body}");
    let gone = send_ok(&r, ch, &r.owner, "gone-text-0d6a").await;
    let (status, body) = call(
        &r.http,
        Method::DELETE,
        &format!("{}/v1/workspaces/{}/messages/{gone}", r.base, r.ws.id),
        &r.owner,
        None,
    )
    .await;
    assert!(status.is_success(), "delete: {status} {body}");
    let carrier = send_ok(&r, ch, &r.owner, "with-file").await;
    let attachment = plant_attachment(&r.su, r.ws.id, ch, r.ws.owner.id, carrier, FILE_NAME).await;
    sqlx::query("UPDATE message SET props = jsonb_build_object('mark', $2::text) WHERE id = $1")
        .bind(carrier)
        .bind(PROPS_MARK)
        .execute(&r.su)
        .await
        .expect("plant props");
    sqlx::query(
        "INSERT INTO reaction (workspace_id, message_id, member_id, emoji) VALUES ($1, $2, $3, $4)",
    )
    .bind(r.ws.id)
    .bind(carrier)
    .bind(r.ws.owner.id)
    .bind(REACTION_MARK)
    .execute(&r.su)
    .await
    .expect("plant reaction");

    // The plants are real: the seated owner's own reads show every one of them.
    let (status, history) = call_raw(
        &r.http,
        Method::GET,
        &format!("{}?limit=200", send_url(&r.base, r.ws.id, ch)),
        &r.owner,
    )
    .await;
    assert_eq!(status, 200, "{history}");
    for planted in [
        REPLY_MARK,
        PROPS_MARK,
        &attachment.to_string(),
        "x-preview-mime-b81c",
    ] {
        assert!(history.contains(planted), "history shows {planted}");
    }
    let (status, reactions) = call_raw(
        &r.http,
        Method::GET,
        &format!(
            "{}/v1/workspaces/{}/channels/{ch}/reactions",
            r.base, r.ws.id
        ),
        &r.owner,
    )
    .await;
    assert_eq!(status, 200, "{reactions}");
    assert!(reactions.contains(REACTION_MARK), "{reactions}");

    // The member (not in the channel) previews it.
    let (raw, page) = preview(&r, ch, &r.member).await;
    for absent in [
        REPLY_MARK,
        REACTION_MARK,
        PROPS_MARK,
        &attachment.to_string(),
        "x-preview-mime-b81c",
        &r.ws.owner.id.to_string(),
        "서하은",
        "gone-text-0d6a",
        "before-edit",
    ] {
        assert!(!raw.contains(absent), "the preview carries {absent}: {raw}");
    }
    assert_eq!(keys(&page), key_set(&["channel", "messages"]), "{raw}");
    assert_eq!(
        keys(&page["channel"]),
        key_set(&["id", "name", "topic", "memberCount", "isMember"]),
        "{raw}"
    );
    assert_eq!(page["channel"]["id"], ch.to_string());
    assert_eq!(page["channel"]["name"], "pv-lounge");
    assert_eq!(page["channel"]["topic"], "pv-topic");
    assert_eq!(page["channel"]["isMember"], false);
    assert_eq!(
        page["channel"]["memberCount"], 3,
        "owner, agent and one person"
    );
    // The browse row counts the same.
    let (status, listed) = call_raw(
        &r.http,
        Method::GET,
        &format!("{}/v1/workspaces/{}/channels/browse", r.base, r.ws.id),
        &r.member,
    )
    .await;
    assert_eq!(status, 200, "{listed}");
    let listed: Value = serde_json::from_str(&listed).expect("browse json");
    assert_eq!(
        listed["channels"][0]["memberCount"],
        page["channel"]["memberCount"]
    );

    let messages = page["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 50, "one screen of top-level messages");
    for message in messages {
        let mut expected = key_set(&[
            "id",
            "author",
            "createdAtMs",
            "edited",
            "deleted",
            "replyCount",
            "attachmentNames",
        ]);
        if message["deleted"] == false {
            expected.insert("body".to_string());
        }
        assert_eq!(keys(message), expected, "{message}");
        let mut author = key_set(&["kind"]);
        if message["body"] != "from-a-suspended-author" {
            author.insert("displayName".to_string());
        }
        assert_eq!(keys(&message["author"]), author, "{message}");
    }
    let bodies: Vec<Option<&str>> = messages.iter().map(|m| m["body"].as_str()).collect();
    assert_eq!(
        &bodies[..6],
        &[
            Some("with-file"),
            None,
            Some("after-edit"),
            Some("root-text"),
            Some("from-a-suspended-author"),
            Some("filler 49")
        ],
        "newest first, the reply left in its thread"
    );
    assert_eq!(bodies[49], Some("filler 5"), "the oldest that fits");
    assert_eq!(messages[0]["id"], carrier.to_string());
    assert_eq!(messages[0]["attachmentNames"], json!([FILE_NAME]));
    assert_eq!(messages[0]["author"]["displayName"], "이도현");
    assert_eq!(messages[0]["author"]["kind"], "human");
    assert_eq!(messages[1]["deleted"], true);
    assert_eq!(messages[1]["edited"], false);
    assert_eq!(messages[2]["edited"], true);
    assert_eq!(messages[3]["replyCount"], 1);
    // A suspended author is not named: a member's roster names active members only.
    assert_eq!(messages[4]["author"], json!({"kind": "human"}));
    assert_eq!(messages[5]["replyCount"], 0);
    assert_eq!(messages[5]["attachmentNames"], json!([]));

    // A member of the channel gets the same narrow shape; only isMember differs.
    let (_, mine) = preview(&r, ch, &r.owner).await;
    assert_eq!(mine["channel"]["isMember"], true);
    let mut same = mine.clone();
    same["channel"]["isMember"] = json!(false);
    assert_eq!(same, page, "membership does not change the shape");
    // So does someone who had left it.
    let left_token = login(&r.http, &r.base, r.ws.id, &left).await;
    let (_, theirs) = preview(&r, ch, &left_token).await;
    assert_eq!(theirs, page);
}

// ---------------------------------------------------------------------------
// D11 claim 2: the join's one 404
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn every_channel_that_is_not_open_answers_the_preview_with_the_joins_404() {
    let _guard = test_lock().await;
    let r = rig("pv-404").await;
    let other = seed(&r.su, "pv-404-other").await;
    let k = seed_kinds(&r, &other).await;
    // The admin sits in the private, off and DM channels, each with a message in it.
    for channel in [k.off, k.private, k.dm] {
        seat(&r.su, r.ws.id, channel, r.ws.admin.id, "member").await;
        send_ok(&r, channel, &r.admin, &format!("hidden-body-{channel}")).await;
    }
    let mut answers = BTreeSet::new();
    for (who, token) in [("admin", &r.admin), ("member", &r.member)] {
        for target in [
            k.private,
            k.dm,
            k.off,
            k.archived,
            k.foreign,
            Uuid::new_v4(),
        ] {
            let (status, body) = preview_raw(&r.http, &r.base, r.ws.id, target, token).await;
            assert_eq!(status, 404, "{who} preview {target}: {body}");
            answers.insert(body);
            let (status, body) = join_raw(&r.http, &r.base, r.ws.id, target, token).await;
            assert_eq!(status, 404, "{who} join {target}: {body}");
            answers.insert(body);
        }
    }
    assert_eq!(
        answers.len(),
        1,
        "every miss, preview or join, is the same bytes: {answers:?}"
    );
    // The open channel itself answers.
    let (status, body) = preview_raw(&r.http, &r.base, r.ws.id, k.open, &r.member).await;
    assert_eq!(status, 200, "{body}");
}

// ---------------------------------------------------------------------------
// D11 claim 3: refused before any channel is read
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn guests_suspended_people_and_agents_are_refused_the_preview_like_the_join() {
    let _guard = test_lock().await;
    let r = rig("pv-who").await;
    let other = seed(&r.su, "pv-who-other").await;
    let k = seed_kinds(&r, &other).await;

    let demoted = seed_human(&r.su, r.ws.id, "member", "정하늘").await;
    let (status, body) = call_raw_json(
        &r.http,
        Method::PATCH,
        &format!(
            "{}/v1/workspaces/{}/members/{}/role",
            r.base, r.ws.id, demoted.id
        ),
        &r.owner,
        &json!({"role": "guest"}),
    )
    .await;
    assert_eq!(status, 200, "demote to guest: {body}");
    let guest = login(&r.http, &r.base, r.ws.id, &demoted).await;

    let stale = seed_human(&r.su, r.ws.id, "member", "한서준").await;
    let stale_token = login(&r.http, &r.base, r.ws.id, &stale).await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(stale.id)
        .execute(&r.su)
        .await
        .expect("suspend underneath");

    let agent = bearer_for_agent(&r.su, r.ws.id, r.ws.agent).await;
    for (who, token, expected) in [
        ("guest", &guest, 403),
        ("suspended underneath", &stale_token, 403),
        ("agent", &agent, 403),
    ] {
        let mut answers = BTreeSet::new();
        for target in [k.open, k.private, k.off, Uuid::new_v4()] {
            let (status, body) = preview_raw(&r.http, &r.base, r.ws.id, target, token).await;
            assert_eq!(status, expected, "{who} preview {target}: {body}");
            assert!(!body.contains(OPEN_MARK), "{who}: {body}");
            answers.insert(body);
            let (status, body) = join_raw(&r.http, &r.base, r.ws.id, target, token).await;
            assert_eq!(status, expected, "{who} join {target}: {body}");
            answers.insert(body);
        }
        assert_eq!(answers.len(), 1, "{who}: {answers:?}");
    }
}

// ---------------------------------------------------------------------------
// Writes nothing, opens no other door
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn a_preview_writes_nothing_and_opens_neither_the_file_nor_the_live_channel() {
    let _guard = test_lock().await;
    let r = rig("pv-door").await;
    let ch = open_channel(&r.su, r.ws.id, "pv-door", r.ws.owner.id).await;
    seat(&r.su, r.ws.id, ch, r.ws.owner.id, "owner").await;
    let carrier = send_ok(&r, ch, &r.owner, "with-file").await;
    let attachment = plant_attachment(&r.su, r.ws.id, ch, r.ws.owner.id, carrier, FILE_NAME).await;
    let content = format!(
        "{}/v1/workspaces/{}/channels/{ch}/attachments/{attachment}/content",
        r.base, r.ws.id
    );

    let before = side_rows(&r.su, r.ws.id).await;
    for _ in 0..3 {
        preview(&r, ch, &r.member).await;
    }
    preview(&r, ch, &r.owner).await;
    assert_eq!(
        side_rows(&r.su, r.ws.id).await,
        before,
        "read_state, membership, audit_log, outbox"
    );
    assert_eq!(read_seq(&r.su, ch, r.ws.member.id).await, None);
    assert_eq!(membership_row(&r.su, ch, r.ws.member.id).await, None);

    // Having previewed, the member still cannot fetch the file or subscribe.
    let (status, body) = call_raw(&r.http, Method::GET, &content, &r.member).await;
    assert_eq!(status, 403, "content after a preview: {body}");
    assert!(
        body.contains("active channel membership required"),
        "{body}"
    );
    let refused = subscribe_decision(&r, &r.member, ch).await;
    assert_ne!(refused, SUBSCRIBE_ALLOW, "subscribe after a preview");

    // Control: the join opens both doors to the same person.
    let (status, body) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.member).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = call_raw(&r.http, Method::GET, &content, &r.member).await;
    assert!(
        !body.contains("active channel membership required"),
        "content after joining: {status} {body}"
    );
    assert_eq!(subscribe_decision(&r, &r.member, ch).await, SUBSCRIBE_ALLOW);
}
