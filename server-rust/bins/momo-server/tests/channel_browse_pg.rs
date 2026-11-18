//! #5838 (ADR-0224 D3·D4·D8·D9·D11) — `GET …/channels/browse` and
//! `POST …/channels/{ch}/members/me`: the public channels a person may find and join.
//!
//! What this file pins:
//!   * D11 claim 1 — no private channel, DM, browse-off public channel or archived
//!     channel (nor another workspace's channel) appears anywhere in the browse body,
//!     for an owner, an admin or a member, even one seated in all of them;
//!   * D11 claim 2 — joining any of those, or an unknown id, is one 404, byte for byte;
//!   * D11 claim 3 — a guest (demoted through the role route), a suspended person and an
//!     agent bearer are refused by both routes, with an answer that does not depend on
//!     the channel id;
//!   * D11 claim 4 — archived channels are neither listed nor joinable;
//!   * D4/D9 — role kept or reset, read position moved only when admitted, audit row;
//!   * the filter takes `%` and `_` literally, pages walk to the end, the member count;
//!   * the channel piece keeps private channels out even without the table check, and a
//!     negative control shows the leak detector catches a piece missing any condition.
//!
//! `#[ignore]` — needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:55838/momo \
//!   cargo test -p momo-server --test channel_browse_pg \
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
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "channel-browse-signing-secret";
const TEST_PASSWORD: &str = "channel-browse-password";

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
}

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
// D11 claim 1 (and 4): the list holds only channels open to people
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_browse_list_holds_only_channels_open_to_people() {
    let _guard = test_lock().await;
    let r = rig("br-list").await;
    let other = seed(&r.su, "br-list-other").await;
    let k = seed_kinds(&r, &other).await;
    // Owner and admin sit in every hidden channel: being inside does not list it.
    for who in [r.ws.owner.id, r.ws.admin.id] {
        for channel in [k.off, k.private, k.dm, k.archived] {
            seat(&r.su, r.ws.id, channel, who, "member").await;
        }
    }
    for (who, token) in [
        ("owner", &r.owner),
        ("admin", &r.admin),
        ("member", &r.member),
    ] {
        let (status, body) = browse_raw(&r.http, &r.base, r.ws.id, token, "").await;
        assert_eq!(status, 200, "{who}: {body}");
        for mark in HIDDEN_MARKS {
            assert!(
                !body.contains(mark),
                "{who}: a hidden channel's name or topic ({mark}) is in the browse body: {body}"
            );
        }
        assert!(body.contains(&format!("{OPEN_MARK}-name")), "{who}: {body}");
        assert!(
            body.contains(&format!("{OPEN_MARK}-topic")),
            "{who}: {body}"
        );
        let page: Value = serde_json::from_str(&body).expect("json");
        assert_eq!(
            row_ids(&page),
            BTreeSet::from([k.open.to_string()]),
            "{who}: exactly the open channel"
        );
    }
    // The other workspace sees its own open channel and nothing of this one.
    let foreign_token = login(&r.http, &r.base, other.id, &other.member).await;
    let (status, body) = browse_raw(&r.http, &r.base, other.id, &foreign_token, "").await;
    assert_eq!(status, 200, "{body}");
    assert!(!body.contains(OPEN_MARK), "{body}");
    let page: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(row_ids(&page), BTreeSet::from([k.foreign.to_string()]));
}

// ---------------------------------------------------------------------------
// D11 claim 2 (and 4): one 404 for every channel that is not open
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn every_channel_that_is_not_open_answers_the_join_like_an_unknown_id() {
    let _guard = test_lock().await;
    let r = rig("br-404").await;
    let other = seed(&r.su, "br-404-other").await;
    let k = seed_kinds(&r, &other).await;
    // The admin already sits in the private, off and DM channels: still the same 404.
    for channel in [k.off, k.private, k.dm] {
        seat(&r.su, r.ws.id, channel, r.ws.admin.id, "member").await;
    }
    let before = membership_total(&r.su, r.ws.id).await;
    for (who, token) in [("admin", &r.admin), ("member", &r.member)] {
        let mut answers = BTreeSet::new();
        for target in [
            k.private,
            k.dm,
            k.off,
            k.archived,
            k.foreign,
            Uuid::new_v4(),
        ] {
            let (status, body) = join_raw(&r.http, &r.base, r.ws.id, target, token).await;
            assert_eq!(status, 404, "{who} {target}: {body}");
            answers.insert(body);
        }
        assert_eq!(
            answers.len(),
            1,
            "{who}: every miss must be the same bytes: {answers:?}"
        );
    }
    assert_eq!(
        membership_total(&r.su, r.ws.id).await,
        before,
        "no row was written"
    );
    assert_eq!(
        membership_row(&r.su, k.foreign, r.ws.member.id).await,
        None,
        "nothing in the other workspace either"
    );
    assert_eq!(joined_audit_total(&r.su, r.ws.id).await, 0);
    // The member left behind no membership in the archived channel either.
    assert_eq!(
        membership_row(&r.su, k.archived, r.ws.member.id).await,
        None
    );
}

// ---------------------------------------------------------------------------
// D11 claim 3: guests, suspended people and agents are refused before any channel is read
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn guests_suspended_people_and_agents_are_refused_before_any_channel_is_read() {
    let _guard = test_lock().await;
    let r = rig("br-who").await;
    let other = seed(&r.su, "br-who-other").await;
    let k = seed_kinds(&r, &other).await;

    // A real guest: a member demoted through the role route, then signed in again.
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

    // A suspended person whose access token is still valid (status changed underneath).
    let stale = seed_human(&r.su, r.ws.id, "member", "한서준").await;
    let stale_token = login(&r.http, &r.base, r.ws.id, &stale).await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(stale.id)
        .execute(&r.su)
        .await
        .expect("suspend underneath");

    // A person suspended through the route: the token is revoked with it.
    let suspended = seed_human(&r.su, r.ws.id, "member", "오지우").await;
    let suspended_token = login(&r.http, &r.base, r.ws.id, &suspended).await;
    let (status, body) = call_raw_json(
        &r.http,
        Method::POST,
        &format!(
            "{}/v1/workspaces/{}/members/{}/suspend",
            r.base, r.ws.id, suspended.id
        ),
        &r.owner,
        &json!({}),
    )
    .await;
    assert_eq!(status, 200, "suspend: {body}");

    let agent = bearer_for_agent(&r.su, r.ws.id, r.ws.agent).await;
    let before = membership_total(&r.su, r.ws.id).await;
    for (who, token, expected) in [
        ("guest", &guest, 403),
        ("suspended underneath", &stale_token, 403),
        ("suspended", &suspended_token, 401),
        ("agent", &agent, 403),
    ] {
        let (status, body) = browse_raw(&r.http, &r.base, r.ws.id, token, "").await;
        assert_eq!(status, expected, "{who} browse: {body}");
        assert!(!body.contains(OPEN_MARK), "{who}: {body}");
        // The answer must not depend on which channel was named.
        let mut answers = BTreeSet::new();
        for target in [k.open, k.private, k.off, Uuid::new_v4()] {
            let (status, body) = join_raw(&r.http, &r.base, r.ws.id, target, token).await;
            assert_eq!(status, expected, "{who} join {target}: {body}");
            answers.insert(body);
        }
        assert_eq!(answers.len(), 1, "{who}: {answers:?}");
    }
    assert_eq!(
        membership_total(&r.su, r.ws.id).await,
        before,
        "nobody got in"
    );
    assert_eq!(membership_row(&r.su, k.open, demoted.id).await, None);
    assert_eq!(joined_audit_total(&r.su, r.ws.id).await, 0);
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

// ---------------------------------------------------------------------------
// D4·D9: roles, read position, audit, response shape
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn joining_keeps_a_live_role_resets_a_left_one_and_moves_the_read_position_only_when_admitted(
) {
    let _guard = test_lock().await;
    let r = rig("br-join").await;
    let ch = open_channel(&r.su, r.ws.id, "lounge", r.ws.owner.id).await;
    seat(&r.su, r.ws.id, ch, r.ws.owner.id, "owner").await;
    for n in 0..4 {
        let (status, body) =
            send_text(&r.http, &r.base, r.ws.id, ch, &r.owner, &format!("글 {n}")).await;
        assert_eq!(status, 201, "{body}");
    }
    let end = last_seq(&r.su, ch).await;
    assert_eq!(end, 4);

    // 1) New: member role, nothing unread, one audit row, the list's Channel row.
    let (status, body) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.member).await;
    assert_eq!(status, 200, "{body}");
    let joined: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(joined["newlyJoined"], true, "{joined}");
    assert_eq!(joined["channel"]["id"], ch.to_string());
    assert_eq!(joined["channel"]["kind"], "public");
    assert_eq!(joined["channel"]["name"], "lounge");
    assert_eq!(joined["channel"]["browseListed"], true);
    assert_eq!(joined["channel"]["isDefault"], false);
    assert_eq!(joined["channel"]["muted"], false);
    assert_eq!(
        membership_row(&r.su, ch, r.ws.member.id).await,
        Some(("member".to_string(), true))
    );
    assert_eq!(
        read_seq(&r.su, ch, r.ws.member.id).await,
        Some(end),
        "unread starts at 0"
    );
    // The same row as the channel list returns for it.
    let (status, list_body) = call_raw(
        &r.http,
        Method::GET,
        &format!("{}/v1/workspaces/{}/channels", r.base, r.ws.id),
        &r.member,
    )
    .await;
    assert_eq!(status, 200);
    let list: Value = serde_json::from_str(&list_body).expect("json");
    let listed = list["channels"]
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["id"] == ch.to_string())
        .expect("joined channel is in the member's list")
        .clone();
    assert_eq!(listed, joined["channel"], "join answers the list's row");

    // 2) A former channel owner who left comes back as member.
    seat(&r.su, r.ws.id, ch, r.ws.admin.id, "owner").await;
    mark_left(&r.su, ch, r.ws.admin.id).await;
    let (status, body) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.admin).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("json")["newlyJoined"],
        true
    );
    assert_eq!(
        membership_row(&r.su, ch, r.ws.admin.id).await,
        Some(("member".to_string(), true)),
        "a left owner comes back as member"
    );
    assert_eq!(read_seq(&r.su, ch, r.ws.admin.id).await, Some(end));

    // 3) A live owner asking again: 200, nothing changes — role, read position, audit.
    set_read_seq(&r.su, r.ws.id, ch, r.ws.owner.id, 1).await;
    let (status, body) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.owner).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("json")["newlyJoined"],
        false
    );
    assert_eq!(
        membership_row(&r.su, ch, r.ws.owner.id).await,
        Some(("owner".to_string(), true)),
        "a live owner keeps the owner role"
    );
    assert_eq!(
        read_seq(&r.su, ch, r.ws.owner.id).await,
        Some(1),
        "an existing member keeps their unread"
    );
    // And the new member asking twice changes nothing either.
    let (status, _) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.member).await;
    assert_eq!(status, 200);

    let audits = joined_audits(&r.su, r.ws.id, ch).await;
    assert_eq!(audits.len(), 2, "one row per admission: {audits:?}");
    assert_eq!(audits[0].0, r.ws.member.id);
    assert_eq!(audits[0].1["rejoined"], "false");
    assert_eq!(audits[0].1["kind"], "public");
    assert_eq!(audits[0].1["schema"], "momo.membership.channel_joined.v1");
    assert_eq!(audits[1].0, r.ws.admin.id);
    assert_eq!(audits[1].1["rejoined"], "true");
}

// ---------------------------------------------------------------------------
// Filter, pages, member count
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_filter_takes_percent_and_underscore_literally() {
    let _guard = test_lock().await;
    let r = rig("br-q").await;
    let o = r.ws.owner.id;
    let plain = open_channel(&r.su, r.ws.id, "planning", o).await;
    let percent = open_channel(&r.su, r.ws.id, "sales", o).await;
    set_topic(&r.su, percent, "목표 100% 달성").await;
    let underscore = open_channel(&r.su, r.ws.id, "dev-ops", o).await;
    set_topic(&r.su, underscore, "snake_case 규칙").await;
    let upper = open_channel(&r.su, r.ws.id, "Design", o).await;
    let names = |page: &Value| row_names(page).into_iter().collect::<BTreeSet<_>>();
    let all = browse(&r.http, &r.base, r.ws.id, &r.member, "").await;
    assert_eq!(names(&all).len(), 4);
    let q = browse(&r.http, &r.base, r.ws.id, &r.member, "?q=%25").await;
    assert_eq!(
        names(&q),
        BTreeSet::from(["sales".to_string()]),
        "% is a character"
    );
    let q = browse(&r.http, &r.base, r.ws.id, &r.member, "?q=_").await;
    assert_eq!(
        names(&q),
        BTreeSet::from(["dev-ops".to_string()]),
        "_ is a character"
    );
    let q = browse(&r.http, &r.base, r.ws.id, &r.member, "?q=dESIGN").await;
    assert_eq!(
        names(&q),
        BTreeSet::from(["Design".to_string()]),
        "case-insensitive"
    );
    let q = browse(
        &r.http,
        &r.base,
        r.ws.id,
        &r.member,
        "?q=%EB%AA%A9%ED%91%9C",
    )
    .await;
    assert_eq!(
        names(&q),
        BTreeSet::from(["sales".to_string()]),
        "topic text"
    );
    let q = browse(&r.http, &r.base, r.ws.id, &r.member, "?q=%20%20").await;
    assert_eq!(names(&q).len(), 4, "a blank filter is no filter");
    let long = "가".repeat(101);
    let (status, _) = browse_raw(&r.http, &r.base, r.ws.id, &r.member, &format!("?q={long}")).await;
    assert_eq!(status, 400);
    let _ = (plain, upper);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn pages_walk_every_open_channel_once_in_name_order_and_end() {
    let _guard = test_lock().await;
    let r = rig("br-page").await;
    let o = r.ws.owner.id;
    let mut expected = Vec::new();
    for name in ["echo", "Alpha", "delta", "charlie", "bravo"] {
        open_channel(&r.su, r.ws.id, name, o).await;
        expected.push(name.to_string());
    }
    expected.sort_by_key(|name| name.to_lowercase());
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let query = match &cursor {
            None => "?limit=2".to_string(),
            Some(c) => format!("?limit=2&cursor={c}"),
        };
        let page = browse(&r.http, &r.base, r.ws.id, &r.member, &query).await;
        pages += 1;
        let names = row_names(&page);
        assert!(names.len() <= 2, "{page}");
        seen.extend(names);
        match page.get("nextCursor").and_then(Value::as_str) {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
        assert!(pages < 10, "the walk must end");
    }
    assert_eq!(pages, 3, "2 + 2 + 1");
    assert_eq!(seen, expected, "each once, by lower(name)");
    for bad in ["nope", "not-a-uuid.6162", &format!("{}.zz", Uuid::new_v4())] {
        let (status, body) = browse_raw(
            &r.http,
            &r.base,
            r.ws.id,
            &r.member,
            &format!("?cursor={bad}"),
        )
        .await;
        assert_eq!(status, 400, "{bad}: {body}");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn each_row_counts_live_people_and_agents_and_says_whether_the_caller_is_in() {
    let _guard = test_lock().await;
    let r = rig("br-count").await;
    let ch = open_channel(&r.su, r.ws.id, "crowd", r.ws.owner.id).await;
    set_default(&r.su, ch).await;
    let empty = open_channel(&r.su, r.ws.id, "empty-room", r.ws.owner.id).await;
    seat(&r.su, r.ws.id, ch, r.ws.owner.id, "owner").await;
    seat(&r.su, r.ws.id, ch, r.ws.member.id, "member").await;
    seat(&r.su, r.ws.id, ch, r.ws.agent, "member").await;
    let left = seed_human(&r.su, r.ws.id, "member", "윤가람").await;
    seat(&r.su, r.ws.id, ch, left.id, "member").await;
    mark_left(&r.su, ch, left.id).await;
    let suspended = seed_human(&r.su, r.ws.id, "member", "서다온").await;
    seat(&r.su, r.ws.id, ch, suspended.id, "member").await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(suspended.id)
        .execute(&r.su)
        .await
        .expect("suspend");
    let removed = seed_human(&r.su, r.ws.id, "member", "남궁별").await;
    seat(&r.su, r.ws.id, ch, removed.id, "member").await;
    sqlx::query("UPDATE member SET deleted_at = now() WHERE id = $1")
        .bind(removed.id)
        .execute(&r.su)
        .await
        .expect("remove");

    for (who, token, in_crowd) in [("member", &r.member, true), ("admin", &r.admin, false)] {
        let page = browse(&r.http, &r.base, r.ws.id, token, "").await;
        let rows = page["channels"].as_array().expect("rows");
        let crowd = rows
            .iter()
            .find(|row| row["id"] == ch.to_string())
            .expect("crowd");
        assert_eq!(
            crowd["memberCount"], 3,
            "{who}: two people and an agent: {crowd}"
        );
        assert_eq!(crowd["isMember"], in_crowd, "{who}");
        assert_eq!(crowd["isDefault"], true);
        let room = rows
            .iter()
            .find(|row| row["id"] == empty.to_string())
            .expect("empty");
        assert_eq!(room["memberCount"], 0);
        assert_eq!(room["isMember"], false);
        assert!(room.get("topic").is_none(), "no topic, no key: {room}");
    }
}

// ---------------------------------------------------------------------------
// Write budget
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn joining_spends_its_own_per_member_budget() {
    let _guard = test_lock().await;
    let r = rig_with("br-budget", |pool| {
        app_state(pool).with_rate_limit(RateLimitConfig {
            channel_join_per_member_limit: 2,
            ..RateLimitConfig::default()
        })
    })
    .await;
    let ch = open_channel(&r.su, r.ws.id, "budget", r.ws.owner.id).await;
    for _ in 0..2 {
        let (status, body) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.member).await;
        assert_eq!(status, 200, "{body}");
    }
    let (status, body) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.member).await;
    assert_eq!(status, 429, "{body}");
    // Leaving is not budgeted, and another person has a budget of their own.
    let (status, body) = call_raw(
        &r.http,
        Method::DELETE,
        &join_url(&r.base, r.ws.id, ch),
        &r.member,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = join_raw(&r.http, &r.base, r.ws.id, ch, &r.admin).await;
    assert_eq!(status, 200, "{body}");
}

// ---------------------------------------------------------------------------
// The channel piece itself
// ---------------------------------------------------------------------------

/// Hidden channels whose `browse_listed` is on although they are private, a DM or
/// archived — a state the table check (migration 184) forbids for the first two. Built
/// inside `tx` with the check dropped; the caller rolls back.
async fn hidden_rows_with_the_flag_on(
    tx: &mut sqlx::PgConnection,
    su: &PgPool,
    workspace: Uuid,
    creator: Uuid,
) -> Vec<Uuid> {
    let private = insert_channel(
        su,
        workspace,
        "private",
        Some("flag-private"),
        false,
        creator,
    )
    .await;
    let dm = insert_channel(su, workspace, "dm", Some("flag-dm"), false, creator).await;
    let archived = insert_channel(
        su,
        workspace,
        "public",
        Some("flag-archived"),
        true,
        creator,
    )
    .await;
    sqlx::query("ALTER TABLE channel DROP CONSTRAINT channel_browse_listed_public_ck")
        .execute(&mut *tx)
        .await
        .expect("drop the table check inside the transaction");
    sqlx::query("UPDATE channel SET browse_listed = true WHERE id = ANY($1)")
        .bind(vec![private, dm, archived])
        .execute(&mut *tx)
        .await
        .expect("turn the flag on");
    vec![private, dm, archived]
}

async fn delete_channels(su: &PgPool, ids: &[Uuid]) {
    sqlx::query("DELETE FROM channel WHERE id = ANY($1)")
        .bind(ids.to_vec())
        .execute(su)
        .await
        .expect("clean up");
}

/// The piece's own conditions keep a private channel and a DM out even where the table
/// check is gone — the boundary does not rest on the constraint.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_channel_piece_keeps_hidden_channels_out_even_without_the_table_check() {
    let _guard = test_lock().await;
    let r = rig("br-piece").await;
    let open = open_channel(&r.su, r.ws.id, "open-one", r.ws.owner.id).await;
    let mut tx = r.su.begin().await.expect("begin");
    let hidden = hidden_rows_with_the_flag_on(&mut tx, &r.su, r.ws.id, r.ws.owner.id).await;
    let rows = momo_messaging::list_browsable_channels_in_tx(
        &mut tx,
        r.ws.id,
        r.ws.member.id,
        None,
        None,
        100,
    )
    .await
    .expect("list");
    let listed: BTreeSet<Uuid> = rows.iter().map(|row| row.id).collect();
    assert_eq!(listed, BTreeSet::from([open]), "only the open channel");
    for id in &hidden {
        let joined = momo_messaging::self_join_channel_in_tx(&mut tx, r.ws.id, *id, r.ws.member.id)
            .await
            .expect("join");
        assert_eq!(joined, momo_messaging::SelfJoin::NotFound, "{id}");
    }
    tx.rollback().await.expect("rollback");
    delete_channels(&r.su, &hidden).await;
}

/// Negative control: the detector the test above relies on ("a hidden id is listed") does
/// turn red when the piece is missing any one of its three conditions.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn control_a_piece_missing_a_condition_lets_a_hidden_channel_through() {
    let _guard = test_lock().await;
    let r = rig("br-control").await;
    open_channel(&r.su, r.ws.id, "open-two", r.ws.owner.id).await;
    let off = insert_channel(
        &r.su,
        r.ws.id,
        "public",
        Some("off-two"),
        false,
        r.ws.owner.id,
    )
    .await;
    let mut tx = r.su.begin().await.expect("begin");
    let hidden = hidden_rows_with_the_flag_on(&mut tx, &r.su, r.ws.id, r.ws.owner.id).await;
    let mut hidden_all = hidden.clone();
    hidden_all.push(off);
    // The one place the three conditions are written (ADR-0224 D11·D13): momo-auth's
    // judgment, which the browse piece is.
    let piece = momo_auth::channel_open_to_people_sql("c");
    assert_eq!(
        momo_messaging::CHANNEL_OPEN_TO_PEOPLE_SQL.to_string(),
        piece,
        "the browse piece is momo-auth's judgment, not a copy"
    );
    let inner = piece
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
        .unwrap_or(&piece);
    let conditions: Vec<&str> = inner.split(" AND ").collect();
    assert_eq!(conditions.len(), 3, "{piece}");
    let leaks = |listed: &[Uuid]| listed.iter().filter(|id| hidden_all.contains(id)).count();
    let run = |condition: String| {
        format!("SELECT c.id FROM channel c WHERE c.workspace_id = $1 AND {condition}")
    };
    let whole: Vec<Uuid> = sqlx::query_scalar(&run(piece.to_string()))
        .bind(r.ws.id)
        .fetch_all(&mut *tx)
        .await
        .expect("whole piece");
    assert_eq!(
        leaks(&whole),
        0,
        "the whole piece lets nothing hidden through"
    );
    for dropped in 0..conditions.len() {
        let weakened = conditions
            .iter()
            .enumerate()
            .filter(|(at, _)| *at != dropped)
            .map(|(_, condition)| *condition)
            .collect::<Vec<_>>()
            .join(" AND ");
        let listed: Vec<Uuid> = sqlx::query_scalar(&run(weakened.clone()))
            .bind(r.ws.id)
            .fetch_all(&mut *tx)
            .await
            .expect("weakened piece");
        assert!(
            leaks(&listed) > 0,
            "without `{}` a hidden channel must get through: {weakened}",
            conditions[dropped]
        );
    }
    tx.rollback().await.expect("rollback");
    let mut cleanup = hidden.clone();
    cleanup.push(off);
    delete_channels(&r.su, &cleanup).await;
}

/// A double tap: the same person's two joins race. The one that waits on the other's
/// row must still answer 200 (`newlyJoined: false`), not fail, and write nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn a_join_that_loses_a_race_with_the_same_persons_join_answers_200() {
    let _guard = test_lock().await;
    let r = rig("br-race").await;
    let ch = open_channel(&r.su, r.ws.id, "race", r.ws.owner.id).await;
    // The winner: a membership row inserted but not yet committed.
    let mut winner = r.su.begin().await.expect("begin");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role)",
    )
    .bind(r.ws.id)
    .bind(ch)
    .bind(r.ws.member.id)
    .execute(&mut *winner)
    .await
    .expect("winner inserts");
    let http = r.http.clone();
    let url = join_url(&r.base, r.ws.id, ch);
    let token = r.member.clone();
    let loser = tokio::spawn(async move { call_raw(&http, Method::POST, &url, &token).await });
    // Let the loser reach the unique index and wait there.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(!loser.is_finished(), "the loser waits for the winner's row");
    winner.commit().await.expect("winner commits");
    let (status, body) = loser.await.expect("join task");
    assert_eq!(status, 200, "{body}");
    let joined: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(joined["newlyJoined"], false, "{joined}");
    assert_eq!(joined["channel"]["id"], ch.to_string());
    assert_eq!(
        joined_audit_total(&r.su, r.ws.id).await,
        0,
        "the loser audits nothing"
    );
    assert_eq!(
        read_seq(&r.su, ch, r.ws.member.id).await,
        None,
        "nor moves a cursor"
    );
}
