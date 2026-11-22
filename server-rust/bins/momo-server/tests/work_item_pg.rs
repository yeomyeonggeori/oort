//! #6066 (ADR-0222 원장-1) — work items on the real router against a `momo_app` (NOBYPASSRLS) pool.
//!
//! | test | proves | revert that makes it red |
//! |---|---|---|
//! | `the_new_tables_are_rls_forced_and_hide_other_workspaces` | FORCE flag on both tables; under A's GUC, B's items and counter are invisible and a B row cannot be inserted | `FORCE ROW LEVEL SECURITY`; the `ws_isolation` policy |
//! | `the_database_keeps_assignee_and_on_behalf_of_human` | agent assignee refused on INSERT and UPDATE; agent on-behalf-of refused; a human requester's on-behalf-of is that requester; requester immutable; a refused insert leaves no gap | each branch of `work_item_people_guard` |
//! | `a_child_run_carries_its_parents_work_item` | inherit / refuse a different item / no move with children / human on-behalf-of on `agent_run` | each branch of `agent_run_work_item_guard` |
//! | `an_agent_bearer_cannot_create_and_nothing_is_written` | every work-item route answers an agent bearer 403 at the route table; 0 rows, no counter | adding a work-item path to `required_agent_scope` |
//! | `the_server_names_the_requester_and_a_body_cannot` | a body naming a person column is 400 with nothing written; the stored person columns are the caller | `deny_unknown_fields` on `CreateWorkItemRequest`; binding a body value |
//! | `an_item_the_caller_cannot_see_answers_like_an_unknown_number` | hidden / unknown / other-workspace numbers: same status and bytes for read, close, reassign; list leaves it out | the membership join in `VISIBLE_ITEM` |
//! | `close_and_reassign_belong_to_the_assignee_and_admins` | assignee and admin 200, anyone else 403 with the row unmoved; one 400 for an ineligible assignee | `may_steer_in_tx`; the eligibility query |
//! | `twenty_concurrent_creates_are_numbered_one_to_twenty` | 20 parallel creates → exactly 1..=20; another workspace starts at 1 | `work_item_assign_number` |
//!
//! `#[ignore]` — needs a real Postgres (superuser `DATABASE_URL`; the harness applies every
//! migration and `bootstrap_roles.sql`):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:28660/momo \
//!   cargo test -p momo-server --test work_item_pg -- --ignored --test-threads=1
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

const TEST_JWT_SECRET: &str = "work-item-pg-signing-secret";
const TEST_PASSWORD: &str = "work-item-pg-password";

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
                 ARRAY['messages:write','messages:read']::text[], 'work-item-test')",
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

// ---------------------------------------------------------------------------
// #6066 helpers
// ---------------------------------------------------------------------------

fn items_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/work-items")
}

fn item_url(base: &str, workspace: Uuid, number: impl std::fmt::Display) -> String {
    format!("{base}/v1/workspaces/{workspace}/work-items/{number}")
}

/// One HTTP call with an optional JSON body, the answer kept as the exact bytes.
async fn call_bytes(
    http: &reqwest::Client,
    method: Method,
    url: &str,
    token: &str,
    body: Option<&Value>,
) -> (StatusCode, String) {
    let mut request = http.request(method, url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.expect("http call");
    let status = response.status();
    (status, response.text().await.expect("body text"))
}

async fn create_item(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    token: &str,
    channel: Uuid,
    title: &str,
) -> Value {
    let (status, body) = call(
        http,
        Method::POST,
        &items_url(base, workspace),
        token,
        Some(&json!({"title": title, "homeChannelId": channel})),
    )
    .await;
    assert_eq!(status, 201, "create: {body}");
    body["workItem"].clone()
}

async fn count_items(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_item WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count work items")
}

async fn counter(su: &PgPool, workspace: Uuid) -> Option<i64> {
    sqlx::query_scalar("SELECT last_number FROM work_item_counter WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_optional(su)
        .await
        .expect("read counter")
}

/// A transaction as the non-bypass API role, scoped the way every route scopes it.
async fn app_tx(app: &PgPool, workspace: Uuid) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = app.begin().await.expect("begin as momo_app");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("SET LOCAL app.workspace_id");
    tx
}

/// Insert a work item directly (as momo_app inside its tenant transaction), returning the
/// database error code and message on refusal.
async fn insert_raw(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    workspace: Uuid,
    channel: Uuid,
    assignee: Uuid,
    requested_by: Uuid,
    on_behalf_of: Uuid,
) -> Result<(Uuid, i64), (String, String)> {
    sqlx::query("SAVEPOINT probe")
        .execute(&mut **tx)
        .await
        .expect("savepoint");
    let outcome: Result<(Uuid, i64), sqlx::Error> = sqlx::query_as(
        "INSERT INTO work_item (workspace_id, number, home_channel_id, title, assignee_member_id, \
                                requested_by_member_id, on_behalf_of_member_id, created_by_member_id) \
         VALUES ($1, 0, $2, '디자인 시안 정리', $3, $4, $5, $4) RETURNING id, number",
    )
    .bind(workspace)
    .bind(channel)
    .bind(assignee)
    .bind(requested_by)
    .bind(on_behalf_of)
    .fetch_one(&mut **tx)
    .await;
    finish_probe(tx, outcome).await
}

async fn finish_probe<T>(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    outcome: Result<T, sqlx::Error>,
) -> Result<T, (String, String)> {
    match outcome {
        Ok(value) => {
            sqlx::query("RELEASE SAVEPOINT probe")
                .execute(&mut **tx)
                .await
                .expect("release");
            Ok(value)
        }
        Err(error) => {
            sqlx::query("ROLLBACK TO SAVEPOINT probe")
                .execute(&mut **tx)
                .await
                .expect("rollback to savepoint");
            let db = error.as_database_error().expect("a database refusal");
            Err((
                db.code().map(|c| c.to_string()).unwrap_or_default(),
                db.message().to_string(),
            ))
        }
    }
}

async fn exec_probe(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    sql: &str,
    binds: &[Uuid],
) -> Result<(), (String, String)> {
    sqlx::query("SAVEPOINT probe")
        .execute(&mut **tx)
        .await
        .expect("savepoint");
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    let outcome = query.execute(&mut **tx).await.map(|_| ());
    finish_probe(tx, outcome).await
}

fn assert_check_violation(outcome: Result<impl std::fmt::Debug, (String, String)>, needle: &str) {
    match outcome {
        Ok(value) => panic!("expected a check_violation naming {needle:?}, got {value:?}"),
        Err((code, message)) => {
            assert_eq!(code, "23514", "{message}");
            assert!(message.contains(needle), "{message} should name {needle:?}");
        }
    }
}

struct Stage {
    su: PgPool,
    app: PgPool,
    base: String,
    http: reqwest::Client,
    a: Workspace,
    /// 공개 채널 「작업」: owner·admin·member 가 앉아 있다.
    room: Uuid,
    /// 비공개 채널 「기획」: owner 만 앉아 있다.
    private_room: Uuid,
    /// 공개 채널 「작업」에 앉아 있는 두 번째 사람(담당자가 아닌 멤버).
    other: Human,
    owner_jwt: String,
    admin_jwt: String,
    member_jwt: String,
    other_jwt: String,
}

async fn stage(hint: &str) -> Stage {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed(&su, hint).await;
    let room = insert_channel(
        &su,
        a.id,
        "public",
        Some(&format!("작업-{hint}")),
        false,
        a.owner.id,
    )
    .await;
    let private_room = insert_channel(
        &su,
        a.id,
        "private",
        Some(&format!("기획-{hint}")),
        false,
        a.owner.id,
    )
    .await;
    let other = seed_human(&su, a.id, "member", "정하늘").await;
    for person in [a.owner.id, a.admin.id, a.member.id, other.id] {
        join(&su, a.id, room, person).await;
    }
    join(&su, a.id, room, a.agent).await;
    join(&su, a.id, private_room, a.owner.id).await;
    let base = start_server(app_state(app.clone())).await;
    let http = reqwest::Client::new();
    let owner_jwt = login(&http, &base, a.id, &a.owner).await;
    let admin_jwt = login(&http, &base, a.id, &a.admin).await;
    let member_jwt = login(&http, &base, a.id, &a.member).await;
    let other_jwt = login(&http, &base, a.id, &other).await;
    Stage {
        su,
        app,
        base,
        http,
        a,
        room,
        private_room,
        other,
        owner_jwt,
        admin_jwt,
        member_jwt,
        other_jwt,
    }
}

// ---------------------------------------------------------------------------
// the database contract
// ---------------------------------------------------------------------------

/// Acceptance 1 — both new tables are RLS ENABLE + FORCE, and as the API role scoped to
/// workspace A, workspace B's work items and counter are invisible and cannot be written.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn the_new_tables_are_rls_forced_and_hide_other_workspaces() {
    let _guard = test_lock().await;
    let s = stage("rls").await;
    let b = seed(&s.su, "rls-b").await;
    let b_room = insert_channel(&s.su, b.id, "public", Some("b-작업"), false, b.owner.id).await;
    join(&s.su, b.id, b_room, b.owner.id).await;
    let b_jwt = login(&s.http, &s.base, b.id, &b.owner).await;
    for title in ["b-1", "b-2", "b-3"] {
        create_item(&s.http, &s.base, b.id, &b_jwt, b_room, title).await;
    }

    for table in ["work_item", "work_item_counter"] {
        let (enabled, forced): (bool, bool) = sqlx::query_as(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
        )
        .bind(table)
        .fetch_one(&s.su)
        .await
        .expect("pg_class");
        assert!(
            enabled && forced,
            "{table}: rls enabled={enabled} forced={forced}"
        );
    }

    let mut tx = app_tx(&s.app, s.a.id).await;
    let seen: i64 = sqlx::query_scalar("SELECT count(*) FROM work_item WHERE workspace_id = $1")
        .bind(b.id)
        .fetch_one(&mut *tx)
        .await
        .expect("count");
    assert_eq!(
        seen, 0,
        "another workspace's items are invisible under A's scope"
    );
    let counters: i64 =
        sqlx::query_scalar("SELECT count(*) FROM work_item_counter WHERE workspace_id = $1")
            .bind(b.id)
            .fetch_one(&mut *tx)
            .await
            .expect("count counter");
    assert_eq!(counters, 0, "another workspace's counter is invisible");
    let refused = insert_raw(&mut tx, b.id, b_room, b.owner.id, b.owner.id, b.owner.id).await;
    let (code, message) = refused.expect_err("a cross-workspace insert is refused");
    assert_eq!(code, "42501", "{message}");
    tx.rollback().await.expect("rollback");
    assert_eq!(count_items(&s.su, b.id).await, 3);
}

/// Acceptance 2 — an agent as assignee is refused by the database on INSERT and on UPDATE, an
/// agent cannot be on-behalf-of, a human requester's on-behalf-of is that requester, and the
/// requester never changes. A refused insert does not move the counter.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn the_database_keeps_assignee_and_on_behalf_of_human() {
    let _guard = test_lock().await;
    let s = stage("people").await;
    let mut tx = app_tx(&s.app, s.a.id).await;
    let (owner, member, agent) = (s.a.owner.id, s.a.member.id, s.a.agent);

    assert_check_violation(
        insert_raw(&mut tx, s.a.id, s.room, agent, owner, owner).await,
        "assignee must be a human",
    );
    assert_check_violation(
        insert_raw(&mut tx, s.a.id, s.room, owner, agent, agent).await,
        "on-behalf-of must be a human",
    );
    assert_check_violation(
        insert_raw(&mut tx, s.a.id, s.room, owner, owner, member).await,
        "must equal a human requester",
    );
    let (id, number) = insert_raw(&mut tx, s.a.id, s.room, owner, owner, owner)
        .await
        .expect("a person assignee is accepted");
    assert_eq!(number, 1, "the refused inserts left no gap");

    assert_check_violation(
        exec_probe(
            &mut tx,
            "UPDATE work_item SET assignee_member_id = $2 WHERE id = $1",
            &[id, agent],
        )
        .await,
        "assignee must be a human",
    );
    assert_check_violation(
        exec_probe(
            &mut tx,
            "UPDATE work_item SET requested_by_member_id = $2, on_behalf_of_member_id = $2 WHERE id = $1",
            &[id, member],
        )
        .await,
        "cannot change",
    );
    exec_probe(
        &mut tx,
        "UPDATE work_item SET assignee_member_id = $2 WHERE id = $1",
        &[id, member],
    )
    .await
    .expect("handing the item to another person is accepted");
    tx.commit().await.expect("commit");
    assert_eq!(counter(&s.su, s.a.id).await, Some(1));
}

/// A child run's work item is its parent's: left empty it inherits, a different one is refused,
/// and a run with children cannot move to another item. A run's on-behalf-of is a person.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn a_child_run_carries_its_parents_work_item() {
    let _guard = test_lock().await;
    let s = stage("runs").await;
    let x = create_item(&s.http, &s.base, s.a.id, &s.member_jwt, s.room, "x").await;
    let y = create_item(&s.http, &s.base, s.a.id, &s.member_jwt, s.room, "y").await;
    let x: Uuid = x["id"].as_str().unwrap().parse().unwrap();
    let y: Uuid = y["id"].as_str().unwrap().parse().unwrap();
    let mut tx = app_tx(&s.app, s.a.id).await;
    let insert_run =
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, parent_run_id, \
                      work_item_id, depth) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id";
    let parent: Uuid = sqlx::query_scalar(insert_run)
        .bind(s.a.id)
        .bind(s.a.agent)
        .bind(s.room)
        .bind(None::<Uuid>)
        .bind(Some(x))
        .bind(0)
        .fetch_one(&mut *tx)
        .await
        .expect("parent run");
    let child: Uuid = sqlx::query_scalar(insert_run)
        .bind(s.a.id)
        .bind(s.a.agent)
        .bind(s.room)
        .bind(Some(parent))
        .bind(None::<Uuid>)
        .bind(1)
        .fetch_one(&mut *tx)
        .await
        .expect("child run");
    let inherited: Option<Uuid> =
        sqlx::query_scalar("SELECT work_item_id FROM agent_run WHERE id = $1")
            .bind(child)
            .fetch_one(&mut *tx)
            .await
            .expect("child row");
    assert_eq!(
        inherited,
        Some(x),
        "an empty child inherits the parent's item"
    );

    sqlx::query("SAVEPOINT probe")
        .execute(&mut *tx)
        .await
        .unwrap();
    let outcome = sqlx::query(insert_run)
        .bind(s.a.id)
        .bind(s.a.agent)
        .bind(s.room)
        .bind(Some(parent))
        .bind(Some(y))
        .bind(1)
        .execute(&mut *tx)
        .await
        .map(|_| ());
    assert_check_violation(
        finish_probe(&mut tx, outcome).await,
        "must equal its parent",
    );
    assert_check_violation(
        exec_probe(
            &mut tx,
            "UPDATE agent_run SET work_item_id = $2 WHERE id = $1",
            &[parent, y],
        )
        .await,
        "with child runs cannot change",
    );
    assert_check_violation(
        exec_probe(
            &mut tx,
            "UPDATE agent_run SET on_behalf_of_member_id = $2 WHERE id = $1",
            &[parent, s.a.agent],
        )
        .await,
        "on-behalf-of must be a human",
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------

/// Acceptance 3 (agent half) — an agent bearer is refused at the route table for every work-item
/// route, and nothing is written: no item, no counter row.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn an_agent_bearer_cannot_create_and_nothing_is_written() {
    let _guard = test_lock().await;
    let s = stage("agent").await;
    let bearer = bearer_for_agent(&s.su, s.a.id, s.a.agent).await;
    let body = json!({"title": "에이전트가 연 작업", "homeChannelId": s.room});
    let (status, answer) = call(
        &s.http,
        Method::POST,
        &items_url(&s.base, s.a.id),
        &bearer,
        Some(&body),
    )
    .await;
    assert_eq!(status, 403, "{answer}");
    assert_eq!(
        error_message(&answer),
        "agent bearer is not allowed for this route"
    );
    for (method, url) in [
        (Method::GET, items_url(&s.base, s.a.id)),
        (Method::GET, item_url(&s.base, s.a.id, 1)),
        (
            Method::POST,
            format!("{}/close", item_url(&s.base, s.a.id, 1)),
        ),
        (
            Method::PUT,
            format!("{}/assignee", item_url(&s.base, s.a.id, 1)),
        ),
    ] {
        let (status, answer) = call(&s.http, method.clone(), &url, &bearer, Some(&json!({}))).await;
        assert_eq!(status, 403, "{method} {url}: {answer}");
    }
    assert_eq!(count_items(&s.su, s.a.id).await, 0);
    assert_eq!(counter(&s.su, s.a.id).await, None);
}

/// Acceptance 3 (body half) — a create body cannot name the requester, the on-behalf-of, the
/// assignee or an actor (400, nothing written); what is stored is the caller in every person
/// column, whatever was attempted before.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn the_server_names_the_requester_and_a_body_cannot() {
    let _guard = test_lock().await;
    let s = stage("body").await;
    let someone_else = s.a.owner.id.to_string();
    for field in [
        "requestedByMemberId",
        "onBehalfOfMemberId",
        "assigneeMemberId",
        "createdByMemberId",
        "actorMemberId",
        "number",
    ] {
        let mut body = json!({"title": "릴리스 노트", "homeChannelId": s.room});
        body[field] = json!(someone_else);
        let (status, answer) = call(
            &s.http,
            Method::POST,
            &items_url(&s.base, s.a.id),
            &s.member_jwt,
            Some(&body),
        )
        .await;
        assert_eq!(status, 400, "{field}: {answer}");
    }
    assert_eq!(
        count_items(&s.su, s.a.id).await,
        0,
        "no refused body wrote a row"
    );
    assert_eq!(
        counter(&s.su, s.a.id).await,
        None,
        "no refused body moved the counter"
    );

    let item = create_item(
        &s.http,
        &s.base,
        s.a.id,
        &s.member_jwt,
        s.room,
        "  릴리스 노트  ",
    )
    .await;
    let me = s.a.member.id.to_string();
    assert_eq!(item["number"], 1);
    assert_eq!(item["title"], "릴리스 노트");
    assert_eq!(item["state"], "open");
    for key in [
        "assigneeMemberId",
        "requestedByMemberId",
        "onBehalfOfMemberId",
        "createdByMemberId",
    ] {
        assert_eq!(item[key], me, "{key}");
    }
    assert!(item.get("doerMemberId").is_none(), "nobody is doing it yet");
    let stored: (Uuid, Uuid, Uuid) = sqlx::query_as(
        "SELECT requested_by_member_id, on_behalf_of_member_id, assignee_member_id \
           FROM work_item WHERE workspace_id = $1",
    )
    .bind(s.a.id)
    .fetch_one(&s.su)
    .await
    .expect("stored row");
    assert_eq!(stored, (s.a.member.id, s.a.member.id, s.a.member.id));

    // A channel the caller is not in is the same 404 as one that does not exist.
    let hidden = call_bytes(
        &s.http,
        Method::POST,
        &items_url(&s.base, s.a.id),
        &s.member_jwt,
        Some(&json!({"title": "x", "homeChannelId": s.private_room})),
    )
    .await;
    let unknown = call_bytes(
        &s.http,
        Method::POST,
        &items_url(&s.base, s.a.id),
        &s.member_jwt,
        Some(&json!({"title": "x", "homeChannelId": Uuid::new_v4()})),
    )
    .await;
    assert_eq!(hidden.0, 404, "{}", hidden.1);
    assert_eq!(hidden, unknown);
    assert_eq!(count_items(&s.su, s.a.id).await, 1);
}

/// Acceptance 4·5 — a number the caller cannot see, a number that does not exist, and a number
/// that exists only in another workspace give the same status and the same bytes, for reading,
/// closing and reassigning; the list leaves the hidden item out; another workspace's path is
/// refused by scope.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn an_item_the_caller_cannot_see_answers_like_an_unknown_number() {
    let _guard = test_lock().await;
    let s = stage("hidden").await;
    let b = seed(&s.su, "hidden-b").await;
    let b_room = insert_channel(&s.su, b.id, "public", Some("b-작업"), false, b.owner.id).await;
    join(&s.su, b.id, b_room, b.owner.id).await;
    let b_jwt = login(&s.http, &s.base, b.id, &b.owner).await;
    for title in ["b-1", "b-2", "b-3", "b-4", "b-5"] {
        create_item(&s.http, &s.base, b.id, &b_jwt, b_room, title).await;
    }

    let open = create_item(&s.http, &s.base, s.a.id, &s.owner_jwt, s.room, "공개 작업").await;
    let hidden = create_item(
        &s.http,
        &s.base,
        s.a.id,
        &s.owner_jwt,
        s.private_room,
        "비공개 작업",
    )
    .await;
    assert_eq!(
        (open["number"].as_i64(), hidden["number"].as_i64()),
        (Some(1), Some(2))
    );

    // #2 is hidden from the admin and the member, #999 does not exist, #5 exists only in B.
    for (who, jwt) in [("admin", &s.admin_jwt), ("member", &s.member_jwt)] {
        let mut answers = Vec::new();
        for number in [2, 999, 5] {
            let url = item_url(&s.base, s.a.id, number);
            answers.push((
                "GET",
                number,
                call_bytes(&s.http, Method::GET, &url, jwt, None).await,
            ));
            answers.push((
                "close",
                number,
                call_bytes(
                    &s.http,
                    Method::POST,
                    &format!("{url}/close"),
                    jwt,
                    Some(&json!({"state": "done"})),
                )
                .await,
            ));
            answers.push((
                "assignee",
                number,
                call_bytes(
                    &s.http,
                    Method::PUT,
                    &format!("{url}/assignee"),
                    jwt,
                    Some(&json!({"memberId": s.a.member.id})),
                )
                .await,
            ));
        }
        for verb in ["GET", "close", "assignee"] {
            let same: Vec<_> = answers.iter().filter(|(v, _, _)| *v == verb).collect();
            assert_eq!(same[0].2 .0, 404, "{who} {verb} #2: {}", same[0].2 .1);
            for other in &same[1..] {
                assert_eq!(
                    other.2, same[0].2,
                    "{who} {verb}: #{} must answer exactly like the hidden #2",
                    other.1
                );
            }
        }
        let (status, page) =
            call(&s.http, Method::GET, &items_url(&s.base, s.a.id), jwt, None).await;
        assert_eq!(status, 200);
        let numbers: Vec<i64> = page["workItems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["number"].as_i64().unwrap())
            .collect();
        assert_eq!(numbers, vec![1], "{who} lists only what they can see");
        assert!(
            !page.to_string().contains("비공개 작업"),
            "{who}: no hidden title"
        );
    }
    let (status, page) = call(
        &s.http,
        Method::GET,
        &items_url(&s.base, s.a.id),
        &s.owner_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        page["workItems"].as_array().unwrap().len(),
        2,
        "the owner sits in both"
    );
    let (status, _) = call(
        &s.http,
        Method::GET,
        &item_url(&s.base, b.id, 1),
        &s.owner_jwt,
        None,
    )
    .await;
    assert_eq!(status, 403, "another workspace's path is refused by scope");
    let hidden_state: String =
        sqlx::query_scalar("SELECT state FROM work_item WHERE workspace_id = $1 AND number = 2")
            .bind(s.a.id)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!(
        hidden_state, "open",
        "no refused close touched the hidden item"
    );
}

/// Acceptance 6 — closing and reassigning: the assignee and an admin get 200, any other person
/// who can see the item gets 403 and the row does not move; the new assignee must be a person in
/// the item's channel.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn close_and_reassign_belong_to_the_assignee_and_admins() {
    let _guard = test_lock().await;
    let s = stage("steer").await;
    let first = create_item(
        &s.http,
        &s.base,
        s.a.id,
        &s.member_jwt,
        s.room,
        "온보딩 문서",
    )
    .await;
    let second = create_item(&s.http, &s.base, s.a.id, &s.member_jwt, s.room, "알림 점검").await;
    let url = item_url(&s.base, s.a.id, first["number"].as_i64().unwrap());
    let second_url = item_url(&s.base, s.a.id, second["number"].as_i64().unwrap());
    let snapshot = |number: i64| {
        let su = s.su.clone();
        let ws = s.a.id;
        async move {
            sqlx::query_as::<_, (String, Uuid)>(
                "SELECT state, assignee_member_id FROM work_item WHERE workspace_id = $1 AND number = $2",
            )
            .bind(ws)
            .bind(number)
            .fetch_one(&su)
            .await
            .unwrap()
        }
    };

    // Someone who can see it but is neither the assignee nor an admin: 403, nothing moves.
    let (status, answer) = call(
        &s.http,
        Method::POST,
        &format!("{url}/close"),
        &s.other_jwt,
        Some(&json!({"state": "done"})),
    )
    .await;
    assert_eq!(status, 403, "{answer}");
    let (status, answer) = call(
        &s.http,
        Method::PUT,
        &format!("{url}/assignee"),
        &s.other_jwt,
        Some(&json!({"memberId": s.other.id})),
    )
    .await;
    assert_eq!(status, 403, "{answer}");
    assert_eq!(snapshot(1).await, ("open".to_string(), s.a.member.id));

    // An agent, an unknown id and a person outside the channel are one 400.
    let outsider = seed_human(&s.su, s.a.id, "member", "윤지아").await;
    let mut refusals = BTreeSet::new();
    for target in [s.a.agent, Uuid::new_v4(), outsider.id] {
        let (status, body) = call_bytes(
            &s.http,
            Method::PUT,
            &format!("{url}/assignee"),
            &s.member_jwt,
            Some(&json!({"memberId": target})),
        )
        .await;
        assert_eq!(status, 400, "{target}: {body}");
        refusals.insert(body);
    }
    assert_eq!(
        refusals.len(),
        1,
        "one answer for every ineligible assignee"
    );
    assert_eq!(snapshot(1).await, ("open".to_string(), s.a.member.id));

    // The admin hands #1 to the other person; the old assignee then may not close it.
    let (status, answer) = call(
        &s.http,
        Method::PUT,
        &format!("{url}/assignee"),
        &s.admin_jwt,
        Some(&json!({"memberId": s.other.id})),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer["workItem"]["assigneeMemberId"],
        s.other.id.to_string()
    );
    let (status, answer) = call(
        &s.http,
        Method::POST,
        &format!("{url}/close"),
        &s.member_jwt,
        Some(&json!({"state": "done"})),
    )
    .await;
    assert_eq!(status, 403, "the former assignee: {answer}");

    // The new assignee closes it.
    let (status, answer) = call(
        &s.http,
        Method::POST,
        &format!("{url}/close"),
        &s.other_jwt,
        Some(&json!({"state": "done"})),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["workItem"]["state"], "done");
    assert_eq!(
        answer["workItem"]["closedByMemberId"],
        s.other.id.to_string()
    );
    let (status, _) = call(
        &s.http,
        Method::POST,
        &format!("{url}/close"),
        &s.other_jwt,
        Some(&json!({"state": "cancelled"})),
    )
    .await;
    assert_eq!(status, 409, "a closed item stays closed");

    // The assignee reassigns their own item; the owner (an admin) cancels another's.
    let (status, answer) = call(
        &s.http,
        Method::PUT,
        &format!("{second_url}/assignee"),
        &s.member_jwt,
        Some(&json!({"memberId": s.a.owner.id})),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let (status, answer) = call(
        &s.http,
        Method::POST,
        &format!("{second_url}/close"),
        &s.admin_jwt,
        Some(&json!({"state": "cancelled"})),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(snapshot(2).await, ("cancelled".to_string(), s.a.owner.id));
}

/// Acceptance 5 (numbers) — twenty creates at once in one workspace are numbered 1..=20 exactly,
/// and another workspace starts its own count at 1.
#[tokio::test]
#[ignore = "needs a real Postgres"]
async fn twenty_concurrent_creates_are_numbered_one_to_twenty() {
    let _guard = test_lock().await;
    let s = stage("burst").await;
    let mut tasks = Vec::new();
    for i in 0..20 {
        let http = s.http.clone();
        let url = items_url(&s.base, s.a.id);
        let jwt = if i % 2 == 0 {
            s.member_jwt.clone()
        } else {
            s.other_jwt.clone()
        };
        let room = s.room;
        tasks.push(tokio::spawn(async move {
            let (status, body) = call(
                &http,
                Method::POST,
                &url,
                &jwt,
                Some(&json!({"title": format!("동시 작업 {i}"), "homeChannelId": room})),
            )
            .await;
            assert_eq!(status, 201, "{body}");
            body["workItem"]["number"].as_i64().unwrap()
        }));
    }
    let mut numbers = Vec::new();
    for task in tasks {
        numbers.push(task.await.expect("create task"));
    }
    numbers.sort_unstable();
    assert_eq!(
        numbers,
        (1..=20).collect::<Vec<i64>>(),
        "no duplicate, no gap"
    );
    assert_eq!(counter(&s.su, s.a.id).await, Some(20));

    let b = seed(&s.su, "burst-b").await;
    let b_room = insert_channel(&s.su, b.id, "public", Some("b-작업"), false, b.owner.id).await;
    join(&s.su, b.id, b_room, b.owner.id).await;
    let b_jwt = login(&s.http, &s.base, b.id, &b.owner).await;
    let first = create_item(&s.http, &s.base, b.id, &b_jwt, b_room, "b-1").await;
    assert_eq!(first["number"], 1, "each workspace counts on its own");
}
