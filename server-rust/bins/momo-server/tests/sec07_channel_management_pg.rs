//! #4245 SEC-07 — the claims of the retired `scripts/verify_channel_management.sh`
//! (Swift server era) that no Rust test pinned, moved onto real HTTP + Postgres.
//!
//! Three groups (map-B GAP bundles T1/T2/T3):
//!   * **T1 workspace** — a suspended / deleted admin is refused on `GET` and
//!     `PATCH /v1/workspaces/{ws}`; an apostrophe name round-trips; a foreign
//!     workspace token is refused; the rename audit row carries actor, token,
//!     schema and old/new names and is absent on every refusal.
//!   * **T2 channels** — create (public/owner membership/`channel_seq` 0), member
//!     refusal, human add/remove/re-add, removed-member send 403, `seq == 1` /
//!     `last_seq == 1`, cross-tenant 403/404, tenant-scoped channel list.
//!   * **T3 DMs** — `POST/GET /dms` status and body mapping for human and agent
//!     DMs, self 400, foreign target 404, foreign token 403.
//!
//! Contract notes (Swift → Rust): the rename body is `{name, updatedAtMs}` (not
//! `expectedUpdatedAtMs`) and the audit is `workspace.renamed` /
//! `momo.workspace.renamed.v1` with `{old, new}`.
//!
//! `#[ignore]` — needs a real Postgres (runtime-unverified without one):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test sec07_channel_management_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Sabotage table: `scratchpad/4245/sab-W2.md`.

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

// ===========================================================================
// T1 — workspace read / rename
// ===========================================================================

/// map-B #19-22 (+27): a member whose row is `suspended` or deleted is refused by
/// the handler even though its token is still live, on read **and** rename, and
/// a refused rename leaves no audit row and no new name. Restoring the member
/// turns both back to 200, so the 403s are the member state and nothing else.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn suspended_or_deleted_admin_is_refused_on_workspace_read_and_rename() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let ws = seed(&su, "gate").await;
    let token = login(&http, &base, ws.id, &ws.admin).await;
    let url = workspace_url(&base, ws.id);

    let (status, before) = call(&http, Method::GET, &url, &token, None).await;
    assert_eq!(status, 200, "an active admin reads the workspace: {before}");
    assert_eq!(before["workspace"]["name"], json!(ws.name));
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    // (label, status, deleted_at set?) — each predicate of the active-member
    // check is exercised on its own: `status` and `deleted_at`.
    let blocked = [
        ("suspended", "suspended", false),
        ("deleted", "deleted", true),
        ("deleted_at only", "active", true),
    ];
    for (label, member_status, deleted) in blocked {
        set_member_state(&su, ws.admin.id, member_status, deleted).await;

        let (status, body) = call(&http, Method::GET, &url, &token, None).await;
        assert_eq!(status, 403, "{label}: GET is refused: {body}");
        assert_eq!(error_message(&body), NOT_A_WORKSPACE_MEMBER, "{label}");

        let (status, body) = call(
            &http,
            Method::PATCH,
            &url,
            &token,
            Some(&json!({"name": "거부되어야 함", "updatedAtMs": updated_at_ms})),
        )
        .await;
        assert_eq!(status, 403, "{label}: PATCH is refused: {body}");
        assert_eq!(error_message(&body), NOT_A_WORKSPACE_MEMBER, "{label}");

        assert_eq!(stored_name(&su, ws.id).await, ws.name, "{label}: no write");
        assert_eq!(
            audit_count(&su, ws.id, "workspace.renamed").await,
            0,
            "{label}: a refused rename leaves no audit row"
        );
    }

    set_member_state(&su, ws.admin.id, "active", false).await;
    let (status, body) = call(&http, Method::GET, &url, &token, None).await;
    assert_eq!(status, 200, "restored admin reads again: {body}");
    let (status, body) = call(
        &http,
        Method::PATCH,
        &url,
        &token,
        Some(&json!({"name": "복구 후 이름", "updatedAtMs": updated_at_ms})),
    )
    .await;
    assert_eq!(status, 200, "restored admin renames again: {body}");
    assert_eq!(stored_name(&su, ws.id).await, "복구 후 이름");
    assert_eq!(audit_count(&su, ws.id, "workspace.renamed").await, 1);
}

/// map-B #29: a name with an apostrophe, quotes, markup characters and Hangul is
/// stored and read back verbatim (the Swift script piped it through shell + SQL).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn apostrophe_name_round_trips_through_rename_and_get() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let ws = seed(&su, "quote").await;
    let token = login(&http, &base, ws.id, &ws.owner).await;
    let url = workspace_url(&base, ws.id);
    let (_, before) = call(&http, Method::GET, &url, &token, None).await;
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let tricky = "MOMO Runtime's \"달무리\" <b>x</b> & 'y'; --";
    let (status, body) = call(
        &http,
        Method::PATCH,
        &url,
        &token,
        Some(&json!({"name": format!("  {tricky}  "), "updatedAtMs": updated_at_ms})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["workspace"]["name"], json!(tricky), "PATCH echoes it");
    assert_eq!(stored_name(&su, ws.id).await, tricky, "stored verbatim");
    let (status, after) = call(&http, Method::GET, &url, &token, None).await;
    assert_eq!(status, 200);
    assert_eq!(
        after["workspace"]["name"],
        json!(tricky),
        "GET reads it back"
    );
    assert_eq!(
        after["workspace"]["slug"],
        json!(ws.slug),
        "the slug is untouched by a rename"
    );
}

/// map-B #23-25: a token minted for workspace A is refused on B's workspace
/// `GET` and `PATCH` (with a *valid* `updatedAtMs`, so the refusal is the scope
/// check and not body validation); B's owner reads B fine. The exact message
/// separates the scope check from the later membership check, which would also
/// answer 403 for a foreign member.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn foreign_workspace_token_is_refused_on_workspace_get_and_patch() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let a = seed(&su, "wsa").await;
    let b = seed(&su, "wsb").await;
    let a_owner = login(&http, &base, a.id, &a.owner).await;
    let b_owner = login(&http, &base, b.id, &b.owner).await;
    let b_url = workspace_url(&base, b.id);

    let (status, body) = call(&http, Method::GET, &b_url, &a_owner, None).await;
    assert_eq!(status, 403, "A's token cannot read B: {body}");
    assert_eq!(error_message(&body), FOREIGN_SCOPE);

    let b_ms = stored_updated_at_ms(&su, b.id).await;
    let (status, body) = call(
        &http,
        Method::PATCH,
        &b_url,
        &a_owner,
        Some(&json!({"name": "침입 개명", "updatedAtMs": b_ms})),
    )
    .await;
    assert_eq!(status, 403, "A's token cannot rename B: {body}");
    assert_eq!(error_message(&body), FOREIGN_SCOPE);
    assert_eq!(
        stored_name(&su, b.id).await,
        b.name,
        "B's name is untouched"
    );
    assert_eq!(audit_count(&su, b.id, "workspace.renamed").await, 0);

    let (status, body) = call(&http, Method::GET, &b_url, &b_owner, None).await;
    assert_eq!(status, 200, "B's own owner reads B: {body}");
    assert_eq!(body["workspace"]["id"], json!(b.id.to_string()));
    assert_eq!(body["workspace"]["name"], json!(b.name));
}

/// map-B #26-27: the rename audit row names the actor, the authorizing token, the
/// target, the schema and the old/new names; refused (403) and stale (409)
/// renames add no second row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn rename_audit_row_records_actor_token_schema_and_old_new_names() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let ws = seed(&su, "audit").await;
    let owner = login(&http, &base, ws.id, &ws.owner).await;
    let member = login(&http, &base, ws.id, &ws.member).await;
    let url = workspace_url(&base, ws.id);
    let (_, before) = call(&http, Method::GET, &url, &owner, None).await;
    let updated_at_ms = before["workspace"]["updatedAtMs"].as_i64().expect("ms");

    let (status, body) = call(
        &http,
        Method::PATCH,
        &url,
        &owner,
        Some(&json!({"name": "새 이름 하나", "updatedAtMs": updated_at_ms})),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        Option<Uuid>,
        Option<String>,
        Option<Uuid>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Uuid>,
    )> = sqlx::query_as(
        "SELECT a.actor_member_id, a.target_type, a.target_id, \
                a.detail->>'schema', a.detail->>'old', a.detail->>'new', \
                t.actor_member_id \
           FROM audit_log a \
           LEFT JOIN token t ON t.id = a.via_token_id \
          WHERE a.workspace_id = $1 AND a.action = 'workspace.renamed'",
    )
    .bind(ws.id)
    .fetch_all(&su)
    .await
    .expect("read the rename audit row");
    assert_eq!(rows.len(), 1, "exactly one rename audit row");
    let (actor, target_type, target_id, schema, old, new, token_actor) = rows[0].clone();
    assert_eq!(actor, Some(ws.owner.id), "actor is the renaming owner");
    assert_eq!(target_type.as_deref(), Some("workspace"));
    assert_eq!(target_id, Some(ws.id));
    assert_eq!(schema.as_deref(), Some("momo.workspace.renamed.v1"));
    assert_eq!(old.as_deref(), Some(ws.name.as_str()), "old name recorded");
    assert_eq!(new.as_deref(), Some("새 이름 하나"), "new name recorded");
    assert_eq!(
        token_actor,
        Some(ws.owner.id),
        "via_token_id points at a token row issued to the owner"
    );

    // 403 (plain member) and 409 (stale updatedAtMs) must not add a row.
    let (status, _) = call(
        &http,
        Method::PATCH,
        &url,
        &member,
        Some(&json!({"name": "침입", "updatedAtMs": stored_updated_at_ms(&su, ws.id).await})),
    )
    .await;
    assert_eq!(status, 403);
    let (status, body) = call(
        &http,
        Method::PATCH,
        &url,
        &owner,
        Some(&json!({"name": "낡은 요청", "updatedAtMs": updated_at_ms})),
    )
    .await;
    assert_eq!(status, 409, "stale token: {body}");
    assert_eq!(
        audit_count(&su, ws.id, "workspace.renamed").await,
        1,
        "refused and stale renames leave the single row alone"
    );
    assert_eq!(stored_name(&su, ws.id).await, "새 이름 하나");
}

// ===========================================================================
// T2 — channel management
// ===========================================================================

/// map-B #30-32: the owner creates a public channel; the answer says public +
/// owner membership, and the rows agree (`channel_seq.last_seq = 0`, one live
/// owner membership).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn owner_creates_a_public_channel_with_owner_membership_and_zero_seq() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let ws = seed(&su, "create").await;
    let owner = login(&http, &base, ws.id, &ws.owner).await;

    let (status, body) = create_channel(&http, &base, ws.id, &owner, "public", "Launch-Room").await;
    assert_eq!(status, 201, "owner may create a channel: {body}");
    assert_eq!(body["channel"]["kind"], json!("public"));
    assert_eq!(
        body["channel"]["name"],
        json!("launch-room"),
        "the name is lower-cased"
    );
    assert_eq!(body["channel"]["workspaceId"], json!(ws.id.to_string()));
    assert_eq!(body["creatorMembership"]["role"], json!("owner"));
    assert_eq!(
        body["creatorMembership"]["memberId"],
        json!(ws.owner.id.to_string())
    );
    assert!(
        body["creatorMembership"].get("leftAtMs").is_none(),
        "a live membership carries no leftAtMs: {body}"
    );
    let channel = uuid_at(&body, "/channel/id");
    assert_eq!(
        uuid_at(&body, "/creatorMembership/channelId"),
        channel,
        "the membership belongs to the new channel"
    );

    assert_eq!(
        last_seq(&su, channel).await,
        0,
        "a fresh channel has a channel_seq row at 0 (no message yet)"
    );
    assert_eq!(
        membership_row(&su, channel, ws.owner.id).await,
        Some(("owner".to_string(), true)),
        "the creator has one live owner membership row"
    );
    assert_eq!(
        live_member_ids(&su, channel).await,
        ids_of(&[ws.owner.id]),
        "nobody else is in a fresh channel"
    );
}

/// map-B #34: a plain member cannot create a channel; no channel row appears.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn plain_member_cannot_create_a_channel() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let ws = seed(&su, "nocreate").await;
    let member = login(&http, &base, ws.id, &ws.member).await;

    let (status, body) =
        create_channel(&http, &base, ws.id, &member, "public", "member-room").await;
    assert_eq!(status, 403, "member create is refused: {body}");
    assert_eq!(error_message(&body), OPERATOR_REQUIRED);
    assert_eq!(
        channel_count_named(&su, ws.id, "member-room").await,
        0,
        "a refused create inserts no channel"
    );
}

/// map-B #35, 39-43: the human add -> remove -> send(403) -> re-add -> send(201)
/// sequence over HTTP, with the membership rows and `channel_seq` checked after
/// each step. The refused send must not consume a seq number: the first message
/// ever stored is `seq == 1` and `last_seq == 1`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn human_member_add_remove_readd_and_the_removed_member_cannot_send() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let ws = seed(&su, "members").await;
    let owner = login(&http, &base, ws.id, &ws.owner).await;
    let admin = login(&http, &base, ws.id, &ws.admin).await;
    let member = login(&http, &base, ws.id, &ws.member).await;

    let (status, created) = create_channel(&http, &base, ws.id, &owner, "public", "ops-room").await;
    assert_eq!(status, 201, "{created}");
    let channel = uuid_at(&created, "/channel/id");
    let members = members_url(&base, ws.id, channel);

    // Not yet a member: the send is refused and stores nothing.
    let (status, body) = send_text(&http, &base, ws.id, channel, &member, "아직 멤버 아님").await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(error_message(&body), "not a member of this channel");
    assert_eq!(message_count(&su, channel).await, 0);

    // owner adds a human member (snake_case key, as the old script sent it).
    let (status, body) = call(
        &http,
        Method::POST,
        &members,
        &owner,
        Some(&json!({"member_id": ws.member.id})),
    )
    .await;
    assert_eq!(status, 200, "owner adds a human member: {body}");
    assert_eq!(
        body["membership"]["memberId"],
        json!(ws.member.id.to_string())
    );
    assert_eq!(body["membership"]["channelId"], json!(channel.to_string()));
    assert_eq!(body["membership"]["role"], json!("member"));
    assert!(
        body["membership"].get("leftAtMs").is_none(),
        "a live membership carries no leftAtMs: {body}"
    );
    assert_eq!(
        membership_row(&su, channel, ws.member.id).await,
        Some(("member".to_string(), true))
    );

    // admin removes the human: leftAtMs appears and the row is closed.
    let remove_url = format!("{members}/{}", ws.member.id);
    let (status, body) = call(&http, Method::DELETE, &remove_url, &admin, None).await;
    assert_eq!(status, 200, "admin removes a human member: {body}");
    assert!(
        body["membership"]["leftAtMs"].is_i64(),
        "the removal answers with the closed row's leftAtMs: {body}"
    );
    assert_eq!(
        membership_row(&su, channel, ws.member.id).await,
        Some(("member".to_string(), false)),
        "the membership row is soft-closed, not deleted"
    );

    // The removed member's still-valid token cannot write.
    let (status, body) = send_text(&http, &base, ws.id, channel, &member, "제거 뒤 쓰기").await;
    assert_eq!(status, 403, "a removed member cannot send: {body}");
    assert_eq!(error_message(&body), "not a member of this channel");
    assert_eq!(message_count(&su, channel).await, 0, "nothing was stored");
    assert_eq!(last_seq(&su, channel).await, 0, "no seq was consumed");

    // admin re-adds: idempotent upsert re-opens the same row.
    let (status, body) = call(
        &http,
        Method::POST,
        &members,
        &admin,
        Some(&json!({"memberId": ws.member.id})),
    )
    .await;
    assert_eq!(status, 200, "admin re-adds the member: {body}");
    assert!(body["membership"].get("leftAtMs").is_none(), "{body}");
    assert_eq!(
        membership_row(&su, channel, ws.member.id).await,
        Some(("member".to_string(), true)),
        "the re-add re-opens the membership"
    );

    // Now the write works, lands on the channel, and is the first seq.
    let (status, sent) = send_text(&http, &base, ws.id, channel, &member, "다시 돌아왔어요").await;
    assert_eq!(status, 201, "a re-added member can send: {sent}");
    assert_eq!(sent["seq"], json!(1), "first stored message is seq 1");
    assert_eq!(sent["channelId"], json!(channel.to_string()));
    assert_eq!(sent["authorMemberId"], json!(ws.member.id.to_string()));
    assert_eq!(last_seq(&su, channel).await, 1);
    assert_eq!(message_count(&su, channel).await, 1);
}

/// map-B #45-49 (+46, 47): tenant fences on the channel routes. A's owner token
/// cannot create/remove in B's path (403 scope mismatch), cannot add B's member
/// to A's channel or A's member to B's channel (404), and B's channel list holds
/// only B rows.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn channel_routes_fence_foreign_tenants() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let a = seed(&su, "tena").await;
    let b = seed(&su, "tenb").await;
    let a_owner = login(&http, &base, a.id, &a.owner).await;
    let b_owner = login(&http, &base, b.id, &b.owner).await;

    let (status, a_created) =
        create_channel(&http, &base, a.id, &a_owner, "public", "a-room").await;
    assert_eq!(status, 201, "{a_created}");
    let a_channel = uuid_at(&a_created, "/channel/id");
    let (status, b_created) =
        create_channel(&http, &base, b.id, &b_owner, "public", "b-room").await;
    assert_eq!(status, 201, "{b_created}");
    let b_channel = uuid_at(&b_created, "/channel/id");
    let (status, body) = call(
        &http,
        Method::POST,
        &members_url(&base, b.id, b_channel),
        &b_owner,
        Some(&json!({"memberId": b.member.id})),
    )
    .await;
    assert_eq!(status, 200, "B owner adds B's own member: {body}");

    // create under B's path with A's token (valid body, so the 403 is the scope).
    let (status, body) = create_channel(&http, &base, b.id, &a_owner, "public", "intruder").await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(error_message(&body), FOREIGN_SCOPE);
    assert_eq!(channel_count_named(&su, b.id, "intruder").await, 0);
    assert_eq!(channel_count_named(&su, a.id, "intruder").await, 0);

    // remove under B's path with A's token.
    let (status, body) = call(
        &http,
        Method::DELETE,
        &format!("{}/{}", members_url(&base, b.id, b_channel), b.member.id),
        &a_owner,
        None,
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(error_message(&body), FOREIGN_SCOPE);
    assert_eq!(
        membership_row(&su, b_channel, b.member.id).await,
        Some(("member".to_string(), true)),
        "B's member is still in B's channel"
    );

    // A's channel, B's member -> 404, no row.
    let (status, body) = call(
        &http,
        Method::POST,
        &members_url(&base, a.id, a_channel),
        &a_owner,
        Some(&json!({"memberId": b.member.id})),
    )
    .await;
    assert_eq!(status, 404, "a foreign member cannot be added: {body}");
    assert_eq!(error_message(&body), "channel or member not found");
    assert_eq!(membership_row(&su, a_channel, b.member.id).await, None);

    // B's channel through A's path, A's member -> 404, no row.
    let (status, body) = call(
        &http,
        Method::POST,
        &members_url(&base, a.id, b_channel),
        &a_owner,
        Some(&json!({"memberId": a.member.id})),
    )
    .await;
    assert_eq!(status, 404, "a foreign channel cannot be joined: {body}");
    assert_eq!(error_message(&body), "channel or member not found");
    assert_eq!(membership_row(&su, b_channel, a.member.id).await, None);

    // B owner's list: only B rows; A's channel never shows.
    let (status, body) = call(
        &http,
        Method::GET,
        &channels_url(&base, b.id),
        &b_owner,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let listed = body["channels"].as_array().expect("channels array");
    let listed_ids: BTreeSet<String> = listed
        .iter()
        .map(|c| c["id"].as_str().expect("id").to_string())
        .collect();
    assert!(
        listed_ids.contains(&b_channel.to_string()),
        "B's own channel is listed: {body}"
    );
    assert!(
        !listed_ids.contains(&a_channel.to_string()),
        "A's channel never leaks into B's list: {body}"
    );
    for channel in listed {
        assert_eq!(
            channel["workspaceId"],
            json!(b.id.to_string()),
            "every listed channel belongs to B: {channel}"
        );
    }
}

// ===========================================================================
// T3 — direct messages over HTTP
// ===========================================================================

/// map-B #2-7, 9-12: `POST/GET /dms` status + body mapping. 201 then 200 with
/// `created`, both ids in `memberIds`, a message in the DM, an agent DM, the
/// list, self 400, a foreign member 404, a foreign token 403.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn dm_routes_open_reopen_send_agent_list_and_refusals() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let a = seed(&su, "dma").await;
    let b = seed(&su, "dmb").await;
    let owner = login(&http, &base, a.id, &a.owner).await;
    let member = login(&http, &base, a.id, &a.member).await;
    let b_owner = login(&http, &base, b.id, &b.owner).await;
    let dms = format!("{}/dms", workspace_url(&base, a.id));
    let open = |token: &str, target: Uuid| {
        let (http, dms, token) = (http.clone(), dms.clone(), token.to_string());
        async move {
            call(
                &http,
                Method::POST,
                &dms,
                &token,
                Some(&json!({"memberId": target})),
            )
            .await
        }
    };

    // human pair: 201 + created, kind dm, both ids.
    let (status, first) = open(&owner, a.member.id).await;
    assert_eq!(status, 201, "first open creates: {first}");
    assert_eq!(first["created"], json!(true));
    assert_eq!(first["channel"]["kind"], json!("dm"));
    assert_eq!(
        id_set(&first["channel"]["memberIds"]),
        ids_of(&[a.owner.id, a.member.id]),
        "memberIds is exactly the pair"
    );
    let dm = uuid_at(&first, "/channel/id");

    // re-open: 200, same channel, created=false (idempotent, never a second row).
    let (status, again) = open(&owner, a.member.id).await;
    assert_eq!(status, 200, "re-open is 200: {again}");
    assert_eq!(again["created"], json!(false));
    assert_eq!(uuid_at(&again, "/channel/id"), dm);

    // the other side opens the same pair: same channel.
    let (status, reverse) = open(&member, a.owner.id).await;
    assert_eq!(status, 200, "the reverse open finds it: {reverse}");
    assert_eq!(uuid_at(&reverse, "/channel/id"), dm);

    // a message in the DM over HTTP.
    let (status, sent) = send_text(&http, &base, a.id, dm, &owner, "안녕하세요 민수님").await;
    assert_eq!(status, 201, "{sent}");
    assert_eq!(sent["channelId"], json!(dm.to_string()));
    assert_eq!(sent["seq"], json!(1));
    // ... and re-opening after a message is still the same identity.
    let (status, after) = open(&owner, a.member.id).await;
    assert_eq!(status, 200, "{after}");
    assert_eq!(uuid_at(&after, "/channel/id"), dm);
    assert_eq!(after["created"], json!(false));
    assert_eq!(channel_count(&su, a.id, "dm").await, 1, "still one DM row");

    // agent DM: same route, a different channel, two live memberships.
    let (status, agent_dm) = open(&owner, a.agent).await;
    assert_eq!(
        status, 201,
        "an agent DM is opened the same way: {agent_dm}"
    );
    assert_eq!(agent_dm["channel"]["kind"], json!("dm"));
    assert_eq!(
        id_set(&agent_dm["channel"]["memberIds"]),
        ids_of(&[a.owner.id, a.agent])
    );
    let agent_channel = uuid_at(&agent_dm, "/channel/id");
    assert_ne!(agent_channel, dm, "the agent pair is its own channel");
    assert_eq!(
        live_member_ids(&su, agent_channel).await,
        ids_of(&[a.owner.id, a.agent]),
        "two live memberships: the owner and the agent"
    );

    // GET /dms: the owner sees both at once; the member sees only theirs.
    let (status, listed) = call(&http, Method::GET, &dms, &owner, None).await;
    assert_eq!(status, 200, "{listed}");
    let listed_ids: BTreeSet<String> = listed["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .map(|c| c["id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(
        listed_ids,
        BTreeSet::from([dm.to_string(), agent_channel.to_string()]),
        "the owner's list is exactly the human DM and the agent DM"
    );
    let (status, listed) = call(&http, Method::GET, &dms, &member, None).await;
    assert_eq!(status, 200, "{listed}");
    let member_ids: Vec<&str> = listed["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .map(|c| c["id"].as_str().expect("id"))
        .collect();
    assert_eq!(
        member_ids,
        vec![dm.to_string().as_str()],
        "no one else's DM"
    );

    // refusals leave the DM count alone.
    let (status, body) = open(&owner, a.owner.id).await;
    assert_eq!(status, 400, "a self DM is refused: {body}");
    assert!(
        error_message(&body).contains("another member"),
        "{}",
        error_message(&body)
    );
    let (status, body) = open(&owner, b.member.id).await;
    assert_eq!(
        status, 404,
        "a foreign workspace's member is not found: {body}"
    );
    assert_eq!(error_message(&body), "active workspace member not found");
    assert_eq!(channel_count(&su, a.id, "dm").await, 2, "no DM was added");
    assert_eq!(channel_count(&su, b.id, "dm").await, 0);

    // B's token on A's /dms.
    let (status, body) = call(&http, Method::GET, &dms, &b_owner, None).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(error_message(&body), FOREIGN_SCOPE);
}
