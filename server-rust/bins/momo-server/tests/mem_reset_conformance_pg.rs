//! #3212 / ADR-0196 D9 · D10 — 기억 초기화(`POST …/memory/reset`)와 팀 고지(`GET …/memory/notice`)를 실제 Postgres 에서.
//!
//! | test | what it proves |
//! |---|---|
//! | `reset_erases_every_memory_table_of_this_workspace_only` | 모든 mem_* 표가 분류돼 있고(새 표는 여기서 걸린다), 지울 표는 비고, 남길 표는 그대로이며, 다른 워크스페이스는 손대지 않고, 커서는 헤드로 |
//! | `only_an_owner_or_admin_may_reset_and_a_repeat_is_refused` | member·guest·agent 403, confirm 없음 400, 낡은 세대 409(두 번 누름), 교차 워크스페이스, 동시 두 요청 |
//! | `a_summary_in_flight_cannot_survive_a_reset` | 요약(mem_apply_digest)·항목(mem_add_item)이 커밋 전이면 초기화가 기다렸다가 지운다(락) — 락을 빼면 되살아난다 RED |
//! | `a_worker_that_read_before_the_reset_cannot_write_after_it` | 초기화 뒤 옛 메시지를 근거로 한 요약은 40001(울타리) — 울타리를 빼면 되살아난다 RED, 스레드 뿌리 예외, 지워진 id 를 잡은 쓰기는 실패 |
//! | `each_guard_of_the_reset_is_load_bearing` | 관리자 검사·사람 검사·session_user·기대 세대·표지 사후 검사·세대 트리거를 하나씩 빼면 통과한다(RED) |
//! | `app_member_id_is_not_left_on_the_pooled_connection` | LOCAL GUC 가 커넥션에 남지 않는다 |
//! | `the_notice_names_the_provider_and_model_and_no_secret` | 요약 제공자·모델·로컬 임베딩·데이터 범주, 어떤 멤버에게나, 비밀 없음(키 모양 검사 + 응답 키 화이트리스트) |
//! | `the_notice_reads_one_row_through_two_independent_walls` | provider_default_ai 의 summary 한 행만(함수 WHERE·정책이 서로 독립인 벽), session_user 가드 |
//! | `pre_floor_evidence_never_becomes_an_item_or_a_proposal` | M-1/L-3: 뿌리 예외 없음, add_item·propose_item 울타리(RED), propose 락 경합(RED) |
//! | `a_suspended_or_deleted_admin_cannot_reset` | 정지·삭제된 관리자(HTTP·DB, RED) |
//! | `a_reset_never_deadlocks_with_a_message_edit_holding_the_channel_lock` | 편집(메시지 행+채널 락)·요약·초기화 동시 실행에 교착 없음 |
//! | `the_epoch_never_goes_back_and_a_busy_reset_answers_503` | L-5 세대 삭제·감소 금지(RED), 5회 상한 raise, API 503 |
//! | `the_embedding_label_matches_the_embed_crate` | 고지의 임베딩 모델명이 momo-embed 의 MODEL_ID 와 맞는다 |
//!
//! `#[ignore]` — needs a real Postgres (pgvector/pgvector:pg18):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:25212/momo \
//!   cargo test -p momo-server --test mem_reset_conformance_pg \
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

const TEST_JWT_SECRET: &str = "mem-reset-conformance-signing-secret";
const TEST_PASSWORD: &str = "mem-reset-test-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

/// `momo_app` with `max` connections. `max = 1` makes "the same connection" provable.
async fn momo_app_pool(max: u32) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(max)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql)")
}

/// The summary worker's connection: `momo_worker` after `SET ROLE momo_memory`.
async fn worker_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password =
        std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE momo_memory").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options.username("momo_worker").password(&password))
        .await
        .expect("connect as momo_worker (bootstrap_roles.sql)")
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
        .env("MOMO_APP_POSTGRES_PASSWORD", "momo_app_dev_pw")
        .env("RELAY_POSTGRES_PASSWORD", "momo_relay_dev_pw")
        .env("WORKER_POSTGRES_PASSWORD", "momo_worker_dev_pw")
        .env("NOTIFIER_POSTGRES_PASSWORD", "momo_notifier_dev_pw")
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
// seeds
// ---------------------------------------------------------------------------

struct Human {
    id: Uuid,
    email: String,
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(id)
        .bind(format!("memreset-{id}"))
        .execute(su)
        .await
        .expect("workspace");
    id
}

async fn seed_human(su: &PgPool, ws: Uuid, role: &str) -> Human {
    let id = Uuid::new_v4();
    let handle = format!("h-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@memreset.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(ws)
    .bind(&handle)
    .execute(su)
    .await
    .expect("member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(ws)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, $3::membership_role)",
    )
    .bind(ws)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("workspace_membership");
    Human { id, email }
}

async fn seed_agent(su: &PgPool, ws: Uuid, owner: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    let handle = format!("ag-{}", &id.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(id)
    .bind(ws)
    .bind(&handle)
    .execute(su)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
         max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(id)
    .bind(ws)
    .bind(owner)
    .execute(su)
    .await
    .expect("agent");
    id
}

async fn seed_channel(su: &PgPool, ws: Uuid, kind: &str, creator: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, dm_key) \
         VALUES ($1, $2, $3::channel_kind, $4, '', $5, $6)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(format!("c-{}", &id.simple().to_string()[..10]))
    .bind(creator)
    .bind((kind == "dm").then(|| format!("k-{id}")))
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(id)
        .bind(ws)
        .execute(su)
        .await
        .expect("channel_seq");
    id
}

async fn join(su: &PgPool, ws: Uuid, channel: Uuid, member: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ($1, $2, $3, $4::membership_role)",
    )
    .bind(ws)
    .bind(channel)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("membership");
}

async fn seed_message(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid) -> (Uuid, i64) {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(su)
    .await
    .expect("seq");
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', 'x')",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .execute(su)
    .await
    .expect("message");
    (id, seq)
}

/// Write a window digest the way the summary worker does: `SET LOCAL ROLE momo_memory`
/// is the session role here, tenant GUC set, then `mem_apply_digest`.
async fn worker_digest(
    worker: &PgPool,
    ws: Uuid,
    channel: Uuid,
    from: i64,
    to: i64,
    evidence: &[Uuid],
) -> Result<Uuid, String> {
    let mut tx = worker.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("ws guc");
    let snapshots: Vec<Option<chrono::DateTime<chrono::Utc>>> = vec![None; evidence.len()];
    let outcome = sqlx::query_scalar::<_, Uuid>(
        "SELECT mem_apply_digest($1, NULL, 'window', $2, $3, $4, '{}'::uuid[], 'm', 'agent', 'v1', \
         $5, $6, now())",
    )
    .bind(channel)
    .bind(from)
    .bind(to)
    .bind(format!("요약 {from}-{to}"))
    .bind(evidence)
    .bind(&snapshots)
    .fetch_one(&mut *tx)
    .await;
    match outcome {
        Ok(id) => {
            tx.commit().await.expect("commit");
            Ok(id)
        }
        Err(error) => Err(match &error {
            sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
            other => format!("non-db: {other}"),
        }),
    }
}

/// `mem_add_item` the way the worker calls it (same tx-level tenant GUC as the digest).
async fn worker_item(
    worker: &PgPool,
    ws: Uuid,
    digest: Uuid,
    kind: &str,
    body: &str,
    evidence: &[Uuid],
) -> Uuid {
    worker_item_try(worker, ws, digest, kind, body, evidence)
        .await
        .expect("a new item")
}

/// Like [`worker_item`], but `None` when `mem_add_item` skipped the row (duplicate or suppressed).
async fn worker_item_try(
    worker: &PgPool,
    ws: Uuid,
    digest: Uuid,
    kind: &str,
    body: &str,
    evidence: &[Uuid],
) -> Option<Uuid> {
    let mut tx = worker.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("ws guc");
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT mem_add_item($1, $2, $3, NULL, $4, 0.8::real, false, 'items-v1', 'test-model')",
    )
    .bind(digest)
    .bind(kind)
    .bind(body)
    .bind(evidence)
    .fetch_one(&mut *tx)
    .await
    .unwrap_or_else(|e| panic!("mem_add_item: {e}"));
    tx.commit().await.expect("commit");
    id
}

/// A window digest over `msgs` (consecutive seqs of one channel) and one item on top of it.
#[allow(clippy::too_many_arguments)]
async fn seed_item(
    su: &PgPool,
    worker: &PgPool,
    ws: Uuid,
    channel: Uuid,
    author: Uuid,
    kind: &str,
    body: &str,
    messages: usize,
) -> (Uuid, Vec<(Uuid, i64)>) {
    let mut msgs = Vec::new();
    for _ in 0..messages {
        msgs.push(seed_message(su, ws, channel, author).await);
    }
    let ids: Vec<Uuid> = msgs.iter().map(|m| m.0).collect();
    let digest = worker_digest(
        worker,
        ws,
        channel,
        msgs.first().unwrap().1,
        msgs.last().unwrap().1,
        &ids,
    )
    .await
    .unwrap_or_else(|e| panic!("digest: {e}"));
    (
        worker_item(worker, ws, digest, kind, body, &ids).await,
        msgs,
    )
}

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(
            &json!({"email": email, "password": TEST_PASSWORD, "workspace": workspace.to_string()}),
        )
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"].as_str().expect("token").to_string()
}

async fn agent_bearer(su: &PgPool, ws: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{ws}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'mem-reset-conformance')",
    )
    .bind(ws)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("agent bearer");
    token
}

async fn send(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = http.request(method, url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("request");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn get(http: &reqwest::Client, url: &str, token: &str) -> (u16, Value) {
    send(http, reqwest::Method::GET, url, token, None).await
}

// ---------------------------------------------------------------------------
// restore-on-panic for the sabotage tests
// ---------------------------------------------------------------------------

static RESTORE: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Queue SQL that undoes a sabotage; [`guarded`] runs the queue even if the scenario panics.
fn register_restore(sql: String) {
    RESTORE.lock().expect("restore queue").push(sql);
}

async fn restore_all(su: &PgPool) {
    let queued: Vec<String> = std::mem::take(&mut *RESTORE.lock().expect("restore queue"));
    for sql in queued.into_iter().rev() {
        sqlx::raw_sql(&sql)
            .execute(su)
            .await
            .expect("restore sabotage");
    }
}

/// Run `scenario` in its own task so a panic cannot skip the restore, then re-raise it.
async fn guarded<F>(su: &PgPool, scenario: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let outcome = tokio::spawn(scenario).await;
    restore_all(su).await;
    if let Err(error) = outcome {
        std::panic::resume_unwind(error.into_panic());
    }
}

/// Redefine `signature` in the database (committed) with each `from` replaced by `to`; returns the
/// original definition so the caller can restore it. Panics when a `from` is not found — a
/// sabotage that changes nothing proves nothing.
async fn sabotage(su: &PgPool, signature: &str, edits: &[(&str, &str)]) -> String {
    let original: String = sqlx::query_scalar("SELECT pg_get_functiondef($1::regprocedure)")
        .bind(signature)
        .fetch_one(su)
        .await
        .expect("functiondef");
    let mut text = original.clone();
    for (from, to) in edits {
        assert!(
            text.contains(from),
            "sabotage anchor not found in {signature}: {from}"
        );
        text = text.replace(from, to);
    }
    register_restore(original.clone());
    sqlx::raw_sql(&text)
        .execute(su)
        .await
        .expect("install sabotage");
    original
}

async fn restore(su: &PgPool, original: &str) {
    sqlx::raw_sql(original).execute(su).await.expect("restore");
}

/// Run `sql` as `member` on a `momo_app` connection in a tx that is always rolled back.
async fn as_member(app: &PgPool, ws: Uuid, member: Uuid, sql: &str) -> Result<String, String> {
    let mut tx = app.begin().await.expect("begin");
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(ws.to_string())
    .bind(member.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    let r = sqlx::query_scalar::<_, String>(sql)
        .fetch_one(&mut *tx)
        .await;
    tx.rollback().await.ok();
    r.map_err(|e| match e {
        sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
        other => format!("non-db {other}"),
    })
}

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------

struct Min {
    ws: Uuid,
    owner: Human,
    admin: Human,
    bob: Human,
    gina: Human, // workspace guest
    agent: Uuid,
    p1: Uuid,
}

async fn seed_min(su: &PgPool) -> Min {
    let ws = seed_workspace(su).await;
    let owner = seed_human(su, ws, "owner").await;
    let admin = seed_human(su, ws, "admin").await;
    let bob = seed_human(su, ws, "member").await;
    let gina = seed_human(su, ws, "guest").await;
    let agent = seed_agent(su, ws, owner.id).await;
    let p1 = seed_channel(su, ws, "public", owner.id).await;
    for member in [&owner, &admin, &bob] {
        join(su, ws, p1, member.id, "member").await;
    }
    Min {
        ws,
        owner,
        admin,
        bob,
        gina,
        agent,
        p1,
    }
}

async fn exec(su: &PgPool, sql: &str) {
    sqlx::raw_sql(sql)
        .execute(su)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// Every table the reset deletes, and every one it keeps. A new `mem_*` table must be added to one of
/// the two lists (the test below fails until it is) — the reset can never silently miss a table.
const DELETED_TABLES: [&str; 10] = [
    "mem_cons_pair",
    "mem_cons_state",
    "mem_digest",
    "mem_evidence",
    "mem_item",
    "mem_item_embedding",
    "mem_proposal",
    "mem_serving",
    "mem_topic",
    "mem_topic_summary",
];
const KEPT_TABLES: [&str; 6] = [
    "mem_cursor",
    "mem_event",
    "mem_settings",
    "mem_suppress",
    "mem_suppress_msg",
    "mem_usage",
];

async fn all_mem_tables(su: &PgPool) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'mem\\_%' \
          ORDER BY 1",
    )
    .fetch_all(su)
    .await
    .expect("mem tables")
}

async fn counts(su: &PgPool, ws: Uuid) -> std::collections::BTreeMap<String, i64> {
    let mut out = std::collections::BTreeMap::new();
    for table in all_mem_tables(su).await {
        let n: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE workspace_id = $1"
        ))
        .bind(ws)
        .fetch_one(su)
        .await
        .unwrap_or_else(|e| panic!("count {table}: {e}"));
        out.insert(table, n);
    }
    out
}

struct Full {
    m: Min,
    items: Vec<Uuid>,
    p2: Uuid,
}

/// A workspace with rows in every `mem_*` table: two channel items, one personal item, an embedding, a
/// pending proposal, a topic with its summary, a serving receipt, consolidation state and a judged pair,
/// a leased cursor, usage, a suppression hash and message, a ledger event and the switches.
async fn seed_full(su: &PgPool, worker: &PgPool, paused: bool) -> Full {
    let m = seed_min(su).await;
    let ws = m.ws;
    let dm = seed_channel(su, ws, "dm", m.owner.id).await;
    join(su, ws, dm, m.owner.id, "member").await;
    join(su, ws, dm, m.agent, "member").await;
    let p2 = seed_channel(su, ws, "public", m.owner.id).await;

    let (i1, msgs1) = seed_item(
        su,
        worker,
        ws,
        m.p1,
        m.owner.id,
        "decision",
        "릴리스 동결은 금요일 zebraquartz 이후",
        2,
    )
    .await;
    let (i2, _) = seed_item(
        su,
        worker,
        ws,
        m.p1,
        m.bob.id,
        "fact",
        "온콜 교대는 월요일 mangoplume",
        1,
    )
    .await;
    let (i3, _) = seed_item(
        su,
        worker,
        ws,
        dm,
        m.owner.id,
        "fact",
        "개인 선호는 아침 plumcrest 커피",
        1,
    )
    .await;
    let digest: Uuid =
        sqlx::query_scalar("SELECT id FROM mem_digest WHERE channel_id = $1 LIMIT 1")
            .bind(m.p1)
            .fetch_one(su)
            .await
            .expect("digest");
    let (prop_msg, _) = seed_message(su, ws, m.p1, m.owner.id).await;
    let run = Uuid::new_v4();
    exec(
        su,
        &format!(
            "INSERT INTO mem_item_embedding (item_id, workspace_id, model, dims, embedding) \
               VALUES ('{i1}', '{ws}', 'm', 384, array_fill(0.01::real, ARRAY[384])::vector); \
             INSERT INTO mem_proposal (workspace_id, channel_id, agent_member_id, requester_member_id, kind, body, \
                                       evidence_message_ids, content_hash) \
               VALUES ('{ws}', '{p1}', '{agent}', '{owner}', 'fact', '대기 중인 제안 본문', ARRAY['{prop_msg}']::uuid[], 'h-prop'); \
             INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, status) \
               VALUES ('{run}', '{ws}', '{agent}', '{p1}', 'running'); \
             INSERT INTO mem_serving (workspace_id, run_id, channel_id, digest_ids, item_ids) \
               VALUES ('{ws}', '{run}', '{p1}', ARRAY['{digest}']::uuid[], ARRAY['{i1}']::uuid[]); \
             INSERT INTO mem_cons_state (channel_id, workspace_id, last_run_at) VALUES ('{p1}', '{ws}', now()); \
             INSERT INTO mem_cons_pair (workspace_id, low_id, high_id, verdict) \
               VALUES ('{ws}', LEAST('{i1}'::uuid, '{i2}'::uuid), GREATEST('{i1}'::uuid, '{i2}'::uuid), 'distinct'); \
             INSERT INTO mem_cursor (channel_id, workspace_id, last_seq, lease_token, leased_until) \
               VALUES ('{p1}', '{ws}', 1, gen_random_uuid(), now() + interval '1 hour'); \
             INSERT INTO mem_usage (workspace_id, day, tokens) VALUES ('{ws}', current_date, 77); \
             INSERT INTO mem_suppress (workspace_id, channel_id, content_hash) VALUES ('{ws}', '{p1}', 'forgotten-hash'); \
             INSERT INTO mem_suppress_msg (workspace_id, channel_id, message_id) VALUES ('{ws}', '{p1}', '{msg}'); \
             INSERT INTO mem_event (workspace_id, target_kind, target_id, action, actor_member_id, channel_id) \
               VALUES ('{ws}', 'item', gen_random_uuid(), 'forgotten', '{owner}', '{p1}'); \
             INSERT INTO mem_settings (workspace_id, scope, enabled, paused, daily_token_cap) \
               VALUES ('{ws}', 'workspace', true, {paused}, 1234); \
             INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{ws}', 'channel', '{p2}', true);",
            p1 = m.p1,
            agent = m.agent,
            owner = m.owner.id,
            msg = msgs1[0].0,
        ),
    )
    .await;
    let topic = Uuid::new_v4();
    exec(
        su,
        &format!(
            "INSERT INTO mem_topic (id, workspace_id, channel_id, label, label_key) \
               VALUES ('{topic}', '{ws}', '{p1}', '릴리스', 'release'); \
             INSERT INTO mem_topic_summary (topic_id, workspace_id, channel_id, body, item_ids, item_hash, prompt_version) \
               VALUES ('{topic}', '{ws}', '{p1}', '릴리스 주제 요약', ARRAY['{i1}']::uuid[], 'h', 'v1')",
            p1 = m.p1,
        ),
    )
    .await;
    Full {
        m,
        items: vec![i1, i2, i3],
        p2,
    }
}

fn reset_url(base: &str, ws: Uuid) -> String {
    format!("{base}/v1/workspaces/{ws}/memory/reset")
}

fn notice_url(base: &str, ws: Uuid) -> String {
    format!("{base}/v1/workspaces/{ws}/memory/notice")
}

async fn post_reset(
    http: &reqwest::Client,
    base: &str,
    ws: Uuid,
    token: &str,
    epoch: i64,
) -> (u16, Value) {
    send(
        http,
        reqwest::Method::POST,
        &reset_url(base, ws),
        token,
        Some(json!({"confirm": true, "expectedEpoch": epoch})),
    )
    .await
}

async fn epoch_of(su: &PgPool, ws: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE((SELECT reset_epoch FROM mem_settings WHERE workspace_id = $1 AND scope = 'workspace'), 0)",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .expect("epoch")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn reset_erases_every_memory_table_of_this_workspace_only() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;

    // Every mem_* table is classified. A table added later fails here until someone decides.
    let mut classified: Vec<String> = DELETED_TABLES
        .iter()
        .chain(KEPT_TABLES.iter())
        .map(|s| s.to_string())
        .collect();
    classified.sort();
    assert_eq!(
        all_mem_tables(&su).await,
        classified,
        "a new mem_* table must be added to DELETED_TABLES or KEPT_TABLES (and to mem_reset_workspace)"
    );

    let a = seed_full(&su, &worker, true).await;
    let b = seed_full(&su, &worker, false).await;
    let ws = a.m.ws;
    let before = counts(&su, ws).await;
    let before_b = counts(&su, b.m.ws).await;
    for table in DELETED_TABLES {
        assert!(before[table] > 0, "precondition: {table} has rows to erase");
    }
    let heads: Vec<(Uuid, i64)> =
        sqlx::query_as("SELECT channel_id, last_seq FROM channel_seq WHERE workspace_id = $1")
            .bind(ws)
            .fetch_all(&su)
            .await
            .unwrap();
    let cursors_b: Vec<(Uuid, i64, i64)> = sqlx::query_as(
        "SELECT channel_id, last_seq, reset_floor_seq FROM mem_cursor WHERE workspace_id = $1 ORDER BY 1",
    )
    .bind(b.m.ws)
    .fetch_all(&su)
    .await
    .unwrap();

    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let owner = login(&http, &base, ws, &a.m.owner.email).await;
    let (status, body) = post_reset(&http, &base, ws, &owner, 0).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["epoch"], 1);
    assert_eq!(body["deleted"]["items"], before["mem_item"]);
    assert_eq!(body["deleted"]["digests"], before["mem_digest"]);
    assert_eq!(body["deleted"]["evidence"], before["mem_evidence"]);
    assert_eq!(body["deleted"]["proposals"], 1);
    assert_eq!(body["deleted"]["embeddings"], 1);
    assert_eq!(body["deleted"]["topics"], 1);
    assert_eq!(body["deleted"]["topicSummaries"], 1);
    assert_eq!(body["deleted"]["servings"], 1);
    assert_eq!(body["deleted"]["consolidationPairs"], 1);
    assert_eq!(body["deleted"]["consolidationState"], 1);

    let after = counts(&su, ws).await;
    for table in DELETED_TABLES {
        assert_eq!(after[table], 0, "{table} is empty after the reset");
    }
    for table in [
        "mem_suppress",
        "mem_suppress_msg",
        "mem_usage",
        "mem_settings",
    ] {
        assert_eq!(after[table], before[table], "{table} is kept");
    }
    assert_eq!(
        after["mem_event"],
        before["mem_event"] + 1,
        "the ledger keeps its rows and gains the reset line"
    );
    let (kind, actor, detail): (String, Option<Uuid>, Value) = sqlx::query_as(
        "SELECT target_kind, actor_member_id, detail FROM mem_event WHERE workspace_id = $1 AND action = 'reset'",
    )
    .bind(ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(kind, "workspace");
    assert_eq!(actor, Some(a.m.owner.id));
    assert_eq!(detail["epoch"], 1);
    assert!(
        !detail.to_string().contains("zebraquartz"),
        "the ledger line carries counts, never content"
    );

    // Switches survive; only the epoch moved.
    let (enabled, paused, cap, epoch): (bool, bool, Option<i32>, i64) = sqlx::query_as(
        "SELECT enabled, paused, daily_token_cap, reset_epoch FROM mem_settings WHERE workspace_id = $1 AND scope = 'workspace'",
    )
    .bind(ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        enabled && paused && cap == Some(1234) && epoch == 1,
        "switches intact, epoch 1"
    );
    let excluded: bool = sqlx::query_scalar(
        "SELECT excluded FROM mem_settings WHERE workspace_id = $1 AND scope = 'channel' AND channel_id = $2",
    )
    .bind(ws)
    .bind(a.p2)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(excluded, "channel exclusion survives");

    // Cursors sit at the head with the fence set and no lease; nothing is re-summarised from history.
    for (channel, head) in &heads {
        let (last, floor, lease): (i64, i64, Option<Uuid>) = sqlx::query_as(
            "SELECT last_seq, reset_floor_seq, lease_token FROM mem_cursor WHERE channel_id = $1",
        )
        .bind(channel)
        .fetch_one(&su)
        .await
        .unwrap_or_else(|e| panic!("cursor of {channel}: {e}"));
        assert_eq!((last, floor), (*head, *head), "cursor at the head");
        assert!(lease.is_none(), "lease released");
    }

    // The other workspace is untouched, row for row.
    assert_eq!(counts(&su, b.m.ws).await, before_b);
    let cursors_b_after: Vec<(Uuid, i64, i64)> = sqlx::query_as(
        "SELECT channel_id, last_seq, reset_floor_seq FROM mem_cursor WHERE workspace_id = $1 ORDER BY 1",
    )
    .bind(b.m.ws)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(cursors_b_after, cursors_b);
    assert_eq!(epoch_of(&su, b.m.ws).await, 0);

    // audit_log: the actor and the epoch, nothing else.
    let (action, actor, detail): (String, Option<Uuid>, Value) = sqlx::query_as(
        "SELECT action, actor_member_id, detail FROM audit_log WHERE workspace_id = $1 AND action = 'memory.reset'",
    )
    .bind(ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        (action.as_str(), actor),
        ("memory.reset", Some(a.m.owner.id))
    );
    println!("audit detail: {detail}");
    assert!(!detail.to_string().contains("zebraquartz"));

    // The settings surface reports the new epoch.
    let (status, settings) = get(
        &http,
        &format!("{base}/v1/workspaces/{ws}/memory/settings"),
        &owner,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(settings["workspace"]["resetEpoch"], 1);

    // The item is gone for readers too (no ghost through the API).
    let (status, list) = get(
        &http,
        &format!("{base}/v1/workspaces/{ws}/memory/items"),
        &owner,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(list["items"].as_array().map(|a| a.len()), Some(0), "{list}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_an_owner_or_admin_may_reset_and_a_repeat_is_refused() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let a = seed_full(&su, &worker, false).await;
    let b = seed_full(&su, &worker, false).await;
    let ws = a.m.ws;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let before = counts(&su, ws).await;

    let bob = login(&http, &base, ws, &a.m.bob.email).await;
    let gina = login(&http, &base, ws, &a.m.gina.email).await;
    let owner = login(&http, &base, ws, &a.m.owner.email).await;
    let admin = login(&http, &base, ws, &a.m.admin.email).await;
    let agent = agent_bearer(&su, ws, a.m.agent).await;
    for (who, token) in [("member", &bob), ("guest", &gina), ("agent", &agent)] {
        let (status, body) = post_reset(&http, &base, ws, token, 0).await;
        assert_eq!(status, 403, "{who}: {body}");
    }
    let (status, _) = send(
        &http,
        reqwest::Method::POST,
        &reset_url(&base, ws),
        "not-a-token",
        Some(json!({"confirm": true, "expectedEpoch": 0})),
    )
    .await;
    assert_eq!(status, 401);
    assert_eq!(counts(&su, ws).await, before, "refusals changed nothing");
    assert_eq!(epoch_of(&su, ws).await, 0);

    // The body must confirm, name the epoch, and add nothing else.
    for body in [
        json!({"confirm": false, "expectedEpoch": 0}),
        json!({"expectedEpoch": 0}),
        json!({"confirm": true}),
        json!({"confirm": true, "expectedEpoch": 0, "everything": true}),
        json!({"confirm": true, "expectedEpoch": -1}),
    ] {
        let (status, out) = send(
            &http,
            reqwest::Method::POST,
            &reset_url(&base, ws),
            &owner,
            Some(body.clone()),
        )
        .await;
        assert!(status == 400 || status == 422, "{body} -> {status} {out}");
    }
    assert_eq!(counts(&su, ws).await, before, "bad bodies changed nothing");

    // Another workspace's path is not reachable with this token.
    let (status, _) = post_reset(&http, &base, b.m.ws, &owner, 0).await;
    assert!(
        status == 403 || status == 404,
        "cross-workspace -> {status}"
    );
    assert_eq!(epoch_of(&su, b.m.ws).await, 0);

    // Two clicks at once: one erases, the other is told it was already done.
    let (one, two) = tokio::join!(
        post_reset(&http, &base, ws, &owner, 0),
        post_reset(&http, &base, ws, &admin, 0)
    );
    let mut statuses = [one.0, two.0];
    statuses.sort();
    assert_eq!(statuses, [200, 409], "{one:?} {two:?}");
    assert_eq!(epoch_of(&su, ws).await, 1);

    // A retry with the old epoch must not erase what was written since.
    let ch = seed_channel(&su, ws, "public", a.m.owner.id).await;
    join(&su, ws, ch, a.m.owner.id, "member").await;
    let (fresh, _) = seed_item(
        &su,
        &worker,
        ws,
        ch,
        a.m.owner.id,
        "fact",
        "초기화 뒤에 새로 적힌 사실 quincejelly",
        1,
    )
    .await;
    let (status, _) = post_reset(&http, &base, ws, &owner, 0).await;
    assert_eq!(status, 409);
    let alive: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM mem_item WHERE id = $1)")
        .bind(fresh)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(alive, "a stale epoch erases nothing");
    // With the epoch it saw, the admin erases again.
    let (status, body) = post_reset(&http, &base, ws, &admin, 1).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["epoch"], 2);
    assert_eq!(body["deleted"]["items"], 1);
}

/// The reset HTTP call and the moment it finishes, for the race tests.
async fn seed_run(su: &PgPool, ws: Uuid, channel: Uuid, agent: Uuid, trigger: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    exec(
        su,
        &format!(
            "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status) \
             VALUES ('{id}', '{ws}', '{agent}', '{channel}', '{trigger}', 'running')"
        ),
    )
    .await;
    id
}

fn spawn_reset(base: String, ws: Uuid, token: String) -> tokio::task::JoinHandle<(u16, Value)> {
    tokio::spawn(async move {
        let http = reqwest::Client::new();
        post_reset(&http, &base, ws, &token, 0).await
    })
}

/// One tenant transaction of the summary worker (`momo_memory` session role, tenant GUC).
async fn worker_tx(
    worker: &PgPool,
    ws: Uuid,
) -> momo_db::sqlx::Transaction<'static, momo_db::sqlx::Postgres> {
    let mut tx = worker.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("ws guc");
    tx
}

/// Race: `write` runs inside an open worker transaction (uncommitted) while the reset is started.
/// Returns (the reset was still waiting after 700 ms, rows of the write left after everything settled).
async fn race_with_open_write(
    su: &PgPool,
    worker: &PgPool,
    base: &str,
    write: &str,
) -> (bool, i64) {
    let m = seed_min(su).await;
    let (msg, seq) = seed_message(su, m.ws, m.p1, m.owner.id).await;
    let run = if write == "proposal" {
        join(su, m.ws, m.p1, m.agent, "member").await;
        let (trigger, _) = seed_message(su, m.ws, m.p1, m.owner.id).await;
        Some(seed_run(su, m.ws, m.p1, m.agent, trigger).await)
    } else {
        None
    };
    let digest = if write == "item" {
        Some(
            worker_digest(worker, m.ws, m.p1, seq, seq, &[msg])
                .await
                .expect("digest"),
        )
    } else {
        None
    };
    let http = reqwest::Client::new();
    let owner = login(&http, base, m.ws, &m.owner.email).await;

    let mut tx = worker_tx(worker, m.ws).await;
    match (write, digest) {
        ("proposal", _) => {
            let _: Option<Uuid> = sqlx::query_scalar(
                "SELECT mem_propose_item($1, 'fact', '경합 중인 제안 dragonberry', NULL, $2)",
            )
            .bind(run.expect("run"))
            .bind(vec![msg])
            .fetch_one(&mut *tx)
            .await
            .expect("propose (uncommitted)");
        }
        ("item", Some(digest)) => {
            let _: Option<Uuid> = sqlx::query_scalar(
                "SELECT mem_add_item($1, 'fact', '경합 중인 항목 dragonberry', NULL, $2, 0.8::real, false, 'v', 'm')",
            )
            .bind(digest)
            .bind(vec![msg])
            .fetch_one(&mut *tx)
            .await
            .expect("add item (uncommitted)");
        }
        _ => {
            let none: Vec<Option<chrono::DateTime<chrono::Utc>>> = vec![None];
            let _: Uuid = sqlx::query_scalar(
                "SELECT mem_apply_digest($1, NULL, 'window', $2, $2, '경합 중인 요약', '{}'::uuid[], 'm', 'agent', 'v1', $3, $4, now())",
            )
            .bind(m.p1)
            .bind(seq)
            .bind(vec![msg])
            .bind(&none)
            .fetch_one(&mut *tx)
            .await
            .expect("apply digest (uncommitted)");
        }
    }
    let reset = spawn_reset(base.to_string(), m.ws, owner);
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    let waiting = !reset.is_finished();
    tx.commit().await.expect("commit the in-flight write");
    let (status, body) = reset.await.expect("reset task");
    assert_eq!(status, 200, "{body}");
    let left: i64 = if write == "item" {
        sqlx::query_scalar("SELECT count(*) FROM mem_item WHERE workspace_id = $1")
    } else if write == "proposal" {
        sqlx::query_scalar("SELECT count(*) FROM mem_proposal WHERE workspace_id = $1")
    } else {
        sqlx::query_scalar("SELECT count(*) FROM mem_digest WHERE workspace_id = $1 AND created_at > now() - interval '1 hour'")
    }
    .bind(m.ws)
    .fetch_one(su)
    .await
    .unwrap();
    (waiting, left)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_summary_in_flight_cannot_survive_a_reset() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let base = start_server(momo_app_pool(4).await).await;
    guarded(&su.clone(), {
        let (su, worker, base) = (su.clone(), worker.clone(), base.clone());
        async move {
            for (label, signature, write) in [
                (
                    "mem_apply_digest",
                    "public.mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)",
                    "digest",
                ),
                (
                    "mem_add_item",
                    "public.mem_add_item(uuid, text, text, text, uuid[], real, boolean, text, text)",
                    "item",
                ),
                (
                    "mem_propose_item",
                    "public.mem_propose_item(uuid, text, text, text, uuid[])",
                    "proposal",
                ),
            ] {
                let shipped = race_with_open_write(&su, &worker, &base, write).await;
                assert_eq!(
                    shipped,
                    (true, 0),
                    "{label}: the reset waits for the in-flight write, then erases it"
                );
                let original = sabotage(
                    &su,
                    signature,
                    &[("'mem_reset:' || v_ws::text", "'mem_reset_x:' || v_ws::text")],
                )
                .await;
                let sabotaged = race_with_open_write(&su, &worker, &base, write).await;
                restore(&su, &original).await;
                println!(
                    "RED [{label}: reset advisory lock]: shipped -> (waited, left) = {shipped:?}; \
                     lock removed -> {sabotaged:?} (the reset did not wait and the write resurrected)"
                );
                assert_eq!(
                    sabotaged,
                    (false, 1),
                    "{label}: without the lock the reset finishes first and the in-flight row survives it"
                );
            }
        }
    })
    .await;
}

async fn worker_thread_digest(
    worker: &PgPool,
    ws: Uuid,
    channel: Uuid,
    root: Uuid,
    from: i64,
    to: i64,
    evidence: &[Uuid],
) -> Result<Uuid, String> {
    let mut tx = worker_tx(worker, ws).await;
    let snaps: Vec<Option<chrono::DateTime<chrono::Utc>>> = vec![None; evidence.len()];
    let outcome = sqlx::query_scalar::<_, Uuid>(
        "SELECT mem_apply_digest($1, $2, 'window', $3, $4, '스레드 요약', '{}'::uuid[], 'm', 'agent', 'v1', $5, $6, now())",
    )
    .bind(channel)
    .bind(root)
    .bind(from)
    .bind(to)
    .bind(evidence)
    .bind(&snaps)
    .fetch_one(&mut *tx)
    .await;
    match outcome {
        Ok(id) => {
            tx.commit().await.expect("commit");
            Ok(id)
        }
        Err(sqlx::Error::Database(db)) => Err(db.code().map(|c| c.to_string()).unwrap_or_default()),
        Err(other) => Err(format!("non-db: {other}")),
    }
}

async fn seed_reply(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid, root: Uuid) -> (Uuid, i64) {
    let (id, seq) = seed_message(su, ws, channel, author).await;
    sqlx::query("UPDATE message SET root_id = $2 WHERE id = $1")
        .bind(id)
        .bind(root)
        .execute(su)
        .await
        .expect("reply");
    (id, seq)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_worker_that_read_before_the_reset_cannot_write_after_it() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    guarded(&su.clone(), {
        let (su, worker, base) = (su.clone(), worker.clone(), base.clone());
        async move {
            let m = seed_min(&su).await;
            let owner = login(&http, &base, m.ws, &m.owner.email).await;
            // What a worker had read before the reset: three messages and (say) an item on top of one digest.
            let (m1, s1) = seed_message(&su, m.ws, m.p1, m.owner.id).await;
            let (m2, s2) = seed_message(&su, m.ws, m.p1, m.bob.id).await;
            let (root, sr) = seed_message(&su, m.ws, m.p1, m.owner.id).await;
            let (pre_reply, sp) = seed_reply(&su, m.ws, m.p1, m.bob.id, root).await;
            let old_digest = worker_digest(&worker, m.ws, m.p1, s1, s2, &[m1, m2])
                .await
                .expect("digest before the reset");
            let old_item = worker_item(&worker, m.ws, old_digest, "fact", "옛 항목 dragonberry", &[m1, m2]).await;
            let vector = format!("[{}]", vec!["0.01"; 384].join(","));
            let mut tx = worker_tx(&worker, m.ws).await;
            let control: bool = sqlx::query_scalar("SELECT mem_set_item_embedding($1, 'm', $2)")
                .bind(old_item)
                .bind(&vector)
                .fetch_one(&mut *tx)
                .await
                .expect("embedding before the reset");
            tx.commit().await.unwrap();
            assert!(control, "control: the embedding write works before the reset");
            let (status, body) = post_reset(&http, &base, m.ws, &owner, 0).await;
            assert_eq!(status, 200, "{body}");
            let head = sp.max(s2).max(sr);
            let floor: i64 = sqlx::query_scalar(
                "SELECT reset_floor_seq FROM mem_cursor WHERE channel_id = $1",
            )
            .bind(m.p1)
            .fetch_one(&su)
            .await
            .unwrap();
            assert_eq!(floor, head, "the fence is the channel head at the reset");

            // (1) A digest over messages read before the reset is refused with its own SQLSTATE (55R01: re-reading cannot help).
            let stale = worker_digest(&worker, m.ws, m.p1, s1, s2, &[m1, m2]).await;
            assert_eq!(stale, Err("55R01".to_string()));
            // (2) A digest that straddles the reset is refused too.
            let (m3, s3) = seed_message(&su, m.ws, m.p1, m.owner.id).await;
            let straddle = worker_digest(&worker, m.ws, m.p1, s2, s3, &[m2, m3]).await;
            assert_eq!(straddle, Err("55R01".to_string()));
            // (3) New messages after the reset are summarised normally.
            let fresh = worker_digest(&worker, m.ws, m.p1, s3, s3, &[m3]).await;
            assert!(fresh.is_ok(), "post-reset messages are memory again: {fresh:?}");
            // (4) M-1: no thread-root exemption. A thread digest rests on replies after the reset; the erased root
            // (or an erased reply) is refused, and a digest of the root alone is refused too.
            let (post_reply, sq) = seed_reply(&su, m.ws, m.p1, m.bob.id, root).await;
            let ok = worker_thread_digest(&worker, m.ws, m.p1, root, sq, sq, &[post_reply]).await;
            assert!(ok.is_ok(), "a reply after the reset: {ok:?}");
            let with_root = worker_thread_digest(&worker, m.ws, m.p1, root, sr, sq + 1, &[root, post_reply]).await;
            assert_eq!(with_root, Err("55R01".to_string()), "the erased root is not evidence");
            let root_only = worker_thread_digest(&worker, m.ws, m.p1, root, sr, sr, &[root]).await;
            assert_eq!(root_only, Err("55R01".to_string()), "a root-only digest is refused");
            let bad =
                worker_thread_digest(&worker, m.ws, m.p1, root, sp, sq + 1, &[pre_reply, post_reply]).await;
            assert_eq!(bad, Err("55R01".to_string()));
            // (5) Writes that hang on ids the reset erased fail by themselves.
            let mut tx = worker_tx(&worker, m.ws).await;
            let add = sqlx::query_scalar::<_, Option<Uuid>>(
                "SELECT mem_add_item($1, 'fact', '지워진 요약 위의 항목', NULL, $2, 0.8::real, false, 'v', 'm')",
            )
            .bind(old_digest)
            .bind(vec![m1])
            .fetch_one(&mut *tx)
            .await;
            assert!(
                matches!(&add, Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23503")),
                "{add:?}"
            );
            tx.rollback().await.ok();
            let mut tx = worker_tx(&worker, m.ws).await;
            let emb: bool = sqlx::query_scalar("SELECT mem_set_item_embedding($1, 'm', $2)")
                .bind(old_item)
                .bind(&vector)
                .fetch_one(&mut *tx)
                .await
                .expect("embedding call");
            tx.commit().await.ok();
            assert!(!emb, "an erased item takes no embedding");
            let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_item_embedding WHERE workspace_id = $1")
                .bind(m.ws)
                .fetch_one(&su)
                .await
                .unwrap();
            assert_eq!(rows, 0, "no embedding for an erased item");
            let mut tx = worker_tx(&worker, m.ws).await;
            let back = sqlx::query_scalar::<_, i64>(
                "SELECT mem_advance_cursor($1, 1, gen_random_uuid(), now() + interval '1 minute')",
            )
            .bind(m.p1)
            .fetch_one(&mut *tx)
            .await;
            assert!(
                matches!(&back, Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23514")),
                "the cursor cannot go back behind the reset: {back:?}"
            );
            tx.rollback().await.ok();

            // RED: without the fence the stale summary lands after the reset.
            let original = sabotage(
                &su,
                "public.mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)",
                &[("AND m.seq <= c.reset_floor_seq", "AND false")],
            )
            .await;
            let resurrected = worker_digest(&worker, m.ws, m.p1, s1, s2, &[m1, m2]).await;
            restore(&su, &original).await;
            println!("RED [reset fence]: shipped -> 55R01; fence removed -> {resurrected:?} (the pre-reset summary is back)");
            assert!(resurrected.is_ok(), "{resurrected:?}");
            let back: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_digest WHERE id = $1")
                .bind(resurrected.unwrap())
                .fetch_one(&su)
                .await
                .unwrap();
            assert_eq!(back, 1);
        }
    })
    .await;
}

const RESET_SIG: &str = "public.mem_reset_workspace(bigint)";

fn reset_sql(epoch: i64) -> String {
    format!("SELECT mem_reset_workspace({epoch})::text")
}

/// Run `sql` as `member` on `pool` in a tx that is always rolled back; SQLSTATE on refusal.
async fn as_of(pool: &PgPool, ws: Uuid, member: Uuid, sql: &str) -> Result<String, String> {
    as_member(pool, ws, member, sql).await
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn each_guard_of_the_reset_is_load_bearing() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let app = momo_app_pool(2).await;
    let a = seed_full(&su, &worker, false).await;
    guarded(&su.clone(), {
        let (su, worker, app) = (su.clone(), worker.clone(), app.clone());
        async move { guard_cases(su, worker, app, a).await }
    })
    .await;
}

/// The EXECUTE grant (momo_app only) is the first wall; the in-function `session_user` guard is the second. To
/// prove the second stands on its own, open the first for the duration of the test and put it back afterwards.
async fn open_execute_wall(su: &PgPool, signature: &str) {
    exec(
        su,
        &format!("GRANT EXECUTE ON FUNCTION {signature} TO PUBLIC"),
    )
    .await;
    register_restore(format!(
        "REVOKE ALL ON FUNCTION {signature} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {signature} TO momo_app"
    ));
}

async fn guard_cases(su: PgPool, worker: PgPool, app: PgPool, a: Full) {
    let ws = a.m.ws;
    // The worker login has no EXECUTE at all (privilege wall) ...
    assert_eq!(
        as_of(&worker, ws, a.m.owner.id, &reset_sql(0)).await,
        Err("42501".to_string()),
        "momo_worker cannot even call the function"
    );
    open_execute_wall(&su, RESET_SIG).await;
    // An agent that is (wrongly) an admin: only the human check can stop it.
    let rogue_agent = seed_agent(&su, ws, a.m.owner.id).await;
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'admin'::membership_role)",
    )
    .bind(ws)
    .bind(rogue_agent)
    .execute(&su)
    .await
    .expect("agent admin row");

    struct Case<'a> {
        label: &'a str,
        edits: Vec<(&'a str, &'a str)>,
        pool: &'a PgPool,
        member: Uuid,
        epoch: i64,
        refused: &'a str,
    }
    let cases = vec![
        Case {
            label: "admin check (a plain member resets)",
            edits: vec![("NOT public.mem_is_workspace_admin()", "false")],
            pool: &app,
            member: a.m.bob.id,
            epoch: 0,
            refused: "42501",
        },
        Case {
            label: "admin check (a guest resets)",
            edits: vec![("NOT public.mem_is_workspace_admin()", "false")],
            pool: &app,
            member: a.m.gina.id,
            epoch: 0,
            refused: "42501",
        },
        Case {
            label: "human check (an agent that holds an admin row resets)",
            edits: vec![("m.kind = 'human'", "true")],
            pool: &app,
            member: rogue_agent,
            epoch: 0,
            refused: "42501",
        },
        Case {
            label: "session_user guard (a BYPASSRLS login names an owner)",
            edits: vec![("session_user::text <> 'momo_app'", "false")],
            pool: &worker,
            member: a.m.owner.id,
            epoch: 0,
            refused: "42501",
        },
        Case {
            label: "expected epoch (a repeat with an old epoch)",
            edits: vec![("v_epoch <> p_expected_epoch", "false")],
            pool: &app,
            member: a.m.owner.id,
            epoch: 7,
            refused: "55000",
        },
    ];
    for case in cases {
        let sql = reset_sql(case.epoch);
        let refused = as_of(case.pool, ws, case.member, &sql).await;
        assert_eq!(
            refused,
            Err(case.refused.to_string()),
            "shipped: {}",
            case.label
        );
        let original = sabotage(&su, RESET_SIG, &case.edits).await;
        let leaked = as_of(case.pool, ws, case.member, &sql).await;
        restore(&su, &original).await;
        println!(
            "RED [{}]: shipped -> SQLSTATE {}; sabotaged -> {:?}",
            case.label,
            case.refused,
            leaked
                .as_ref()
                .map(|s| s.chars().take(60).collect::<String>())
        );
        assert!(
            leaked.is_ok(),
            "{}: with the guard removed the call must go through (else the guard is decorative): {leaked:?}",
            case.label
        );
        assert_eq!(
            as_of(case.pool, ws, case.member, &sql).await,
            Err(case.refused.to_string()),
            "restored: {}",
            case.label
        );
    }

    // A refusal must not have erased anything.
    assert!(item_alive(&su, a.items[0]).await);

    // The survivor check: a policy that does not know the 'reset' marker (the mistake a future table or
    // policy rewrite could make) makes RLS silently skip those rows — DELETE … USING false just matches
    // nothing. The shipped function then refuses the whole reset (40001) instead of bumping the epoch over
    // surviving data; with the check removed as well it "succeeds" and the data is still there.
    exec(
        &su,
        "DROP POLICY mem_item_only_definer_del ON mem_item; \
         CREATE POLICY mem_item_only_definer_del ON mem_item AS RESTRICTIVE FOR DELETE \
           USING (current_user = 'mem_definer' AND current_setting('mem.op', true) IN ('forget_item', 'cons_retention'))",
    )
    .await;
    register_restore(
        "DROP POLICY IF EXISTS mem_item_only_definer_del ON mem_item; \
         CREATE POLICY mem_item_only_definer_del ON mem_item AS RESTRICTIVE FOR DELETE \
           USING (current_user = 'mem_definer' AND pg_catalog.current_setting('mem.op', true) IN ('forget_item', 'cons_retention', 'reset'))"
            .to_string(),
    );
    let refused = as_of(&app, ws, a.m.owner.id, &reset_sql(0)).await;
    assert_eq!(
        refused,
        Err("40001".to_string()),
        "a policy that skips the items: the survivor check refuses the reset"
    );
    let original = sabotage(
        &su,
        RESET_SIG,
        &[(
            "IF EXISTS (SELECT 1 FROM public.mem_item i WHERE i.workspace_id = v_ws AND i.recorded_at <= v_started)",
            "IF false AND EXISTS (SELECT 1 FROM public.mem_item i WHERE i.workspace_id = v_ws AND i.recorded_at <= v_started)",
        )],
    )
    .await;
    let victim = seed_full(&su, &worker, false).await;
    let result = {
        let mut tx = app.begin().await.unwrap();
        sqlx::query(
            "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
        )
        .bind(victim.m.ws.to_string())
        .bind(victim.m.owner.id.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
        let result = sqlx::query_scalar::<_, String>(&reset_sql(0))
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string());
        tx.commit().await.unwrap();
        result
    };
    let items_left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_item WHERE workspace_id = $1")
            .bind(victim.m.ws)
            .fetch_one(&su)
            .await
            .unwrap();
    let epoch_now = epoch_of(&su, victim.m.ws).await;
    restore(&su, &original).await;
    exec(
        &su,
        "DROP POLICY mem_item_only_definer_del ON mem_item; \
         CREATE POLICY mem_item_only_definer_del ON mem_item AS RESTRICTIVE FOR DELETE \
           USING (current_user = 'mem_definer' AND pg_catalog.current_setting('mem.op', true) IN ('forget_item', 'cons_retention', 'reset'))",
    )
    .await;
    println!(
        "RED [survivor check]: policy misses 'reset' + no check -> ok={} items still visible={items_left} epoch={epoch_now} \
         (the epoch moved over surviving data)",
        result.is_ok()
    );
    assert!(result.is_ok() && items_left > 0 && epoch_now == 1);

    // reset_epoch belongs to the function: a direct write by the admin's own session is refused.
    let bump = "UPDATE mem_settings SET reset_epoch = reset_epoch + 1 WHERE scope = 'workspace' RETURNING reset_epoch::text";
    assert_eq!(
        as_of(&app, ws, a.m.owner.id, bump).await,
        Err("42501".to_string()),
        "the trigger refuses a direct epoch bump"
    );
    let insert_other = seed_min(&su).await;
    let raise_new = format!(
        "INSERT INTO mem_settings (workspace_id, scope, reset_epoch) VALUES ('{}', 'workspace', 5) RETURNING reset_epoch::text",
        insert_other.ws
    );
    assert_eq!(
        as_of(&app, insert_other.ws, insert_other.owner.id, &raise_new).await,
        Err("42501".to_string()),
        "…and a first row that starts above zero"
    );
    exec(
        &su,
        "ALTER TABLE mem_settings DISABLE TRIGGER mem_settings_epoch_guard_trg",
    )
    .await;
    register_restore(
        "ALTER TABLE mem_settings ENABLE TRIGGER mem_settings_epoch_guard_trg".to_string(),
    );
    let bumped = as_of(&app, ws, a.m.owner.id, bump).await;
    let inserted = as_of(&app, insert_other.ws, insert_other.owner.id, &raise_new).await;
    exec(
        &su,
        "ALTER TABLE mem_settings ENABLE TRIGGER mem_settings_epoch_guard_trg",
    )
    .await;
    println!("RED [epoch trigger]: shipped -> 42501; trigger disabled -> update {bumped:?}, insert {inserted:?}");
    assert!(bumped.is_ok() && inserted.is_ok());
    // The ordinary switch writes keep working through the trigger (regression guard for the API's upsert).
    let toggle = "INSERT INTO mem_settings (workspace_id, scope, enabled) \
        VALUES (current_setting('app.workspace_id')::uuid, 'workspace', true) \
        ON CONFLICT (workspace_id) WHERE scope = 'workspace' DO UPDATE SET enabled = EXCLUDED.enabled \
        RETURNING enabled::text";
    assert!(as_of(&app, ws, a.m.owner.id, toggle).await.is_ok());
}

async fn item_alive(su: &PgPool, id: Uuid) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM mem_item WHERE id = $1)")
        .bind(id)
        .fetch_one(su)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn app_member_id_is_not_left_on_the_pooled_connection() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let a = seed_full(&su, &worker, false).await;
    let pool = momo_app_pool(1).await;
    let base = start_server(pool.clone()).await;
    let http = reqwest::Client::new();
    let owner = login(&http, &base, a.m.ws, &a.m.owner.email).await;
    let bob = login(&http, &base, a.m.ws, &a.m.bob.email).await;
    let (status, _) = post_reset(&http, &base, a.m.ws, &bob, 0).await;
    assert_eq!(status, 403);
    let (status, _) = post_reset(&http, &base, a.m.ws, &owner, 9).await;
    assert_eq!(status, 409);
    let (status, _) = post_reset(&http, &base, a.m.ws, &owner, 0).await;
    assert_eq!(status, 200);
    let (status, _) = get(&http, &notice_url(&base, a.m.ws), &bob).await;
    assert_eq!(status, 200);
    let (member, workspace): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT current_setting('app.member_id', true), current_setting('app.workspace_id', true)",
    )
    .fetch_one(&pool)
    .await
    .expect("probe the pooled connection");
    assert!(
        member.as_deref().unwrap_or("").is_empty(),
        "app.member_id leaked: {member:?}"
    );
    assert!(
        workspace.as_deref().unwrap_or("").is_empty(),
        "app.workspace_id leaked: {workspace:?}"
    );
    let mark: Option<String> = sqlx::query_scalar("SELECT current_setting('mem.op', true)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        mark.as_deref().unwrap_or("").is_empty(),
        "mem.op leaked: {mark:?}"
    );
}

// ---------------------------------------------------------------------------
// team notice
// ---------------------------------------------------------------------------

fn json_keys(value: &Value, out: &mut std::collections::BTreeSet<String>, prefix: &str) {
    if let Value::Object(map) = value {
        for (key, inner) in map {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            out.insert(path.clone());
            json_keys(inner, out, &path);
        }
    }
}

/// Anything that looks like a credential: provider keys, bearers, URL userinfo, query strings.
fn looks_secret(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    for (needle, why) in [
        ("sk-", "provider key prefix"),
        ("bearer ", "bearer"),
        ("momo_agent_v1", "agent token"),
        ("api_key", "api_key"),
        ("apikey", "apikey"),
        ("token", "token"),
        ("secret", "secret"),
        ("password", "password"),
        ("://", "url"),
        ("@", "userinfo"),
        ("?", "query string"),
    ] {
        if lower.contains(needle) {
            return Some(why);
        }
    }
    None
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_notice_names_the_provider_and_model_and_no_secret() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    exec(&su, "DELETE FROM provider_default_ai").await;
    let m = seed_min(&su).await;
    let other = seed_min(&su).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, m.ws, &m.bob.email).await;
    let gina = login(&http, &base, m.ws, &m.gina.email).await;
    let owner = login(&http, &base, m.ws, &m.owner.email).await;
    let agent = agent_bearer(&su, m.ws, m.agent).await;
    let outsider = login(&http, &base, other.ws, &other.bob.email).await;

    // No summary row yet: nothing is sent, and the notice says so.
    let (status, none) = get(&http, &notice_url(&base, m.ws), &bob).await;
    assert_eq!(status, 200, "{none}");
    assert_eq!(none["summary"]["configured"], false);
    assert_eq!(none["sending"], false);
    assert_eq!(none["enabled"], true);
    assert_eq!(none["embeddings"]["location"], "local");
    assert_eq!(none["embeddings"]["sentToProvider"], false);
    assert_eq!(none["embeddings"]["model"], "multilingual-e5-small");
    assert!(none["summary"].get("provider").is_none());

    // The operator picked OpenAI + a model; a second (team_agent) row must not appear anywhere.
    exec(
        &su,
        "INSERT INTO provider_default_ai (role, link_position, link_endpoint_label, model_id) VALUES \
           ('summary', 0, 'https://api.openai.com/v1', 'gpt-5.4-mini'), \
           ('team_agent', 0, 'https://team-agent-only.example/v1', 'agent-secret-model')",
    )
    .await;
    for (who, token) in [("member", &bob), ("guest", &gina), ("owner", &owner)] {
        let (status, body) = get(&http, &notice_url(&base, m.ws), token).await;
        assert_eq!(status, 200, "{who}: {body}");
        assert_eq!(body["summary"]["configured"], true);
        assert_eq!(body["summary"]["provider"]["name"], "OpenAI");
        assert_eq!(body["summary"]["provider"]["host"], "api.openai.com");
        assert_eq!(body["summary"]["modelId"], "gpt-5.4-mini");
        assert_eq!(body["sending"], true);
        let text = body.to_string();
        assert!(
            !text.contains("team-agent-only") && !text.contains("agent-secret-model"),
            "{text}"
        );
        assert!(body["sends"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "channel_message_text"));
        assert!(body["neverSends"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "human_direct_messages"));
        // Only these keys, ever (a new field must be reviewed for secrets).
        let mut keys = std::collections::BTreeSet::new();
        json_keys(&body, &mut keys, "");
        let expected: std::collections::BTreeSet<String> = [
            "enabled",
            "paused",
            "sending",
            "resetEpoch",
            "sends",
            "neverSends",
            "summary",
            "summary.configured",
            "summary.provider",
            "summary.provider.name",
            "summary.provider.host",
            "summary.modelId",
            "embeddings",
            "embeddings.model",
            "embeddings.location",
            "embeddings.sentToProvider",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            keys, expected,
            "{who}: the notice exposes exactly these fields"
        );
    }

    // A label with userinfo, a path, a query and a fragment (a raw paste that got past the redactor):
    // only the host survives, and no key-shaped text appears anywhere in the response.
    exec(
        &su,
        "UPDATE provider_default_ai SET link_endpoint_label = \
           'https://ops:sk-abcdefghijklmnop1234567890@llm.corp.example:8443/v1/SECRETPATH?api_key=sk-zzzzzzzzzzzzzzzzzzzzzz#frag', \
           model_id = NULL WHERE role = 'summary'",
    )
    .await;
    let (status, dirty) = get(&http, &notice_url(&base, m.ws), &bob).await;
    assert_eq!(status, 200);
    assert_eq!(dirty["summary"]["provider"]["host"], "llm.corp.example");
    assert_eq!(dirty["summary"]["provider"]["name"], "llm.corp.example");
    assert!(
        dirty["summary"].get("modelId").is_none(),
        "no model id = the link's default"
    );
    let text = dirty.to_string();
    for forbidden in ["sk-", "SECRETPATH", "api_key", "ops", "frag", "8443"] {
        assert!(!text.contains(forbidden), "{forbidden} leaked: {text}");
    }
    println!("notice (dirty label) -> {text}");
    // L-1: a guest never sees a custom gateway's host — only 「사용자 지정」.
    let (status, as_guest) = get(&http, &notice_url(&base, m.ws), &gina).await;
    assert_eq!(status, 200);
    assert_eq!(as_guest["summary"]["provider"]["name"], "사용자 지정");
    assert!(
        as_guest["summary"]["provider"].get("host").is_none(),
        "{as_guest}"
    );
    assert!(!as_guest.to_string().contains("llm.corp.example"));
    // Generic key-shape scan over every string of a clean response.
    exec(
        &su,
        "UPDATE provider_default_ai SET link_endpoint_label = 'https://api.anthropic.com/v1', \
           model_id = 'claude-sonnet-4-5-20250929' WHERE role = 'summary'",
    )
    .await;
    let (_, clean) = get(&http, &notice_url(&base, m.ws), &bob).await;
    assert_eq!(clean["summary"]["provider"]["name"], "Anthropic");
    fn strings(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(s) => out.push(s.clone()),
            Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
            Value::Object(map) => map.values().for_each(|v| strings(v, out)),
            _ => {}
        }
    }
    let mut all = Vec::new();
    strings(&clean, &mut all);
    for text in &all {
        assert_eq!(
            looks_secret(text),
            None,
            "key-shaped string in the notice: {text}"
        );
    }

    // The switches show through.
    exec(
        &su,
        &format!("INSERT INTO mem_settings (workspace_id, scope, enabled, paused) VALUES ('{}', 'workspace', true, true)", m.ws),
    )
    .await;
    let (_, paused) = get(&http, &notice_url(&base, m.ws), &bob).await;
    assert_eq!(
        (paused["paused"].as_bool(), paused["sending"].as_bool()),
        (Some(true), Some(false))
    );

    // Agents and other workspaces get nothing.
    let (status, _) = get(&http, &notice_url(&base, m.ws), &agent).await;
    assert_eq!(status, 403);
    let (status, _) = get(&http, &notice_url(&base, m.ws), &outsider).await;
    assert!(status == 403 || status == 404, "{status}");
    let (status, _) = get(&http, &notice_url(&base, m.ws), "nope").await;
    assert_eq!(status, 401);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_notice_reads_one_row_through_two_independent_walls() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let app = momo_app_pool(2).await;
    exec(&su, "DELETE FROM provider_default_ai").await;
    exec(
        &su,
        "INSERT INTO provider_default_ai (role, link_position, link_endpoint_label, model_id) VALUES \
           ('summary', 0, 'https://api.openai.com/v1', 'gpt-5.4-mini'), \
           ('team_agent', 1, 'https://team-agent-only.example/v1', 'agent-model')",
    )
    .await;
    let m = seed_min(&su).await;
    open_execute_wall(&su, "public.mem_summary_provider()").await;
    let sql = "SELECT string_agg(endpoint_label || '|' || COALESCE(model_id, '-'), ',' ORDER BY endpoint_label) FROM mem_summary_provider()";
    let sig = "public.mem_summary_provider()";
    guarded(&su.clone(), {
        let (su, worker, app) = (su.clone(), worker.clone(), app.clone());
        async move {
            let shipped = as_member(&app, m.ws, m.bob.id, sql).await.expect("bob reads");
            assert_eq!(shipped, "https://api.openai.com/v1|gpt-5.4-mini");
            // The acting member must be an active human of this workspace.
            for (who, member) in [("agent", m.agent), ("stranger", Uuid::new_v4())] {
                assert_eq!(
                    as_member(&app, m.ws, member, sql).await,
                    Err("42501".to_string()),
                    "{who}"
                );
            }
            // session_user guard: a BYPASSRLS login cannot name a member and read.
            assert_eq!(
                as_member(&worker, m.ws, m.bob.id, sql).await,
                Err("42501".to_string())
            );
            let original =
                sabotage(&su, sig, &[("session_user::text <> 'momo_app'", "false")]).await;
            let leaked = as_member(&worker, m.ws, m.bob.id, sql).await;
            restore(&su, &original).await;
            println!("RED [notice: session_user guard]: sabotaged momo_worker -> {leaked:?}");
            assert!(leaked.is_ok());
            let original = sabotage(
                &su,
                sig,
                &[("m.kind = 'human'", "true")],
            )
            .await;
            let agent_read = as_member(&app, m.ws, m.agent, sql).await;
            restore(&su, &original).await;
            println!("RED [notice: human check]: sabotaged agent -> {agent_read:?}");
            assert!(agent_read.is_ok());

            // Two walls: the function's WHERE and the policy on the table. Either alone still hides the
            // team_agent row; only when both are gone does it leak.
            let where_gone = ("WHERE d.role = 'summary'", "");
            let original = sabotage(&su, sig, &[where_gone]).await;
            let only_policy = as_member(&app, m.ws, m.bob.id, sql).await.expect("read");
            restore(&su, &original).await;
            assert_eq!(only_policy, "https://api.openai.com/v1|gpt-5.4-mini", "policy alone holds");
            exec(
                &su,
                "DROP POLICY provider_default_ai_summary_mem ON provider_default_ai; \
                 CREATE POLICY provider_default_ai_summary_mem ON provider_default_ai FOR SELECT TO mem_definer USING (true)",
            )
            .await;
            register_restore(
                "DROP POLICY IF EXISTS provider_default_ai_summary_mem ON provider_default_ai; \
                 CREATE POLICY provider_default_ai_summary_mem ON provider_default_ai FOR SELECT TO mem_definer USING (role = 'summary')"
                    .to_string(),
            );
            let only_where = as_member(&app, m.ws, m.bob.id, sql).await.expect("read");
            assert_eq!(only_where, "https://api.openai.com/v1|gpt-5.4-mini", "the function's WHERE alone holds");
            let original = sabotage(&su, sig, &[where_gone]).await;
            let both_gone = as_member(&app, m.ws, m.bob.id, sql).await.expect("read");
            restore(&su, &original).await;
            println!("RED [notice: both walls]: policy USING (true) + no WHERE -> {both_gone}");
            assert!(both_gone.contains("team-agent-only"), "the team_agent row leaks only when both walls are gone");
            exec(
                &su,
                "DROP POLICY provider_default_ai_summary_mem ON provider_default_ai; \
                 CREATE POLICY provider_default_ai_summary_mem ON provider_default_ai FOR SELECT TO mem_definer USING (role = 'summary')",
            )
            .await;
            // The definer sees three columns only.
            let cols: Vec<String> = sqlx::query_scalar(
                "SELECT column_name::text FROM information_schema.column_privileges \
                  WHERE table_name = 'provider_default_ai' AND grantee = 'mem_definer' AND privilege_type = 'SELECT' ORDER BY 1",
            )
            .fetch_all(&su)
            .await
            .unwrap();
            assert_eq!(cols, ["link_endpoint_label", "model_id", "role"]);
            // And the operator GUC is not what opens the row: an ordinary member tx sees nothing from the table.
            let direct = as_member(&app, m.ws, m.bob.id, "SELECT count(*)::text FROM provider_default_ai").await;
            assert_eq!(direct, Ok("0".to_string()), "momo_app reads no row without the operator GUC");
        }
    })
    .await;
}

#[test]
fn the_embedding_label_matches_the_embed_crate() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../crates/momo-embed/src/lib.rs"
    ))
    .expect("read momo-embed");
    let id_line = text
        .lines()
        .find(|line| line.contains("pub const MODEL_ID"))
        .expect("MODEL_ID");
    assert!(
        id_line.contains("multilingual-e5-small"),
        "the notice says multilingual-e5-small; momo-embed says: {id_line}"
    );
}

// ---------------------------------------------------------------------------
// security review follow-ups (#3229): M-1, L-3, L-5, L-7, suspended/deleted, lock order
// ---------------------------------------------------------------------------

async fn worker_propose(
    worker: &PgPool,
    ws: Uuid,
    run: Uuid,
    body: &str,
    evidence: &[Uuid],
) -> Result<Option<Uuid>, String> {
    let mut tx = worker_tx(worker, ws).await;
    let out =
        sqlx::query_scalar::<_, Option<Uuid>>("SELECT mem_propose_item($1, 'fact', $2, NULL, $3)")
            .bind(run)
            .bind(body)
            .bind(evidence)
            .fetch_one(&mut *tx)
            .await;
    match out {
        Ok(id) => {
            tx.commit().await.ok();
            Ok(id)
        }
        Err(sqlx::Error::Database(db)) => Err(db.code().map(|c| c.to_string()).unwrap_or_default()),
        Err(other) => Err(format!("non-db: {other}")),
    }
}

async fn worker_add_item(
    worker: &PgPool,
    ws: Uuid,
    digest: Uuid,
    body: &str,
    evidence: &[Uuid],
) -> Result<Option<Uuid>, String> {
    let mut tx = worker_tx(worker, ws).await;
    let out = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT mem_add_item($1, 'fact', $2, NULL, $3, 0.8::real, false, 'v', 'm')",
    )
    .bind(digest)
    .bind(body)
    .bind(evidence)
    .fetch_one(&mut *tx)
    .await;
    match out {
        Ok(id) => {
            tx.commit().await.ok();
            Ok(id)
        }
        Err(sqlx::Error::Database(db)) => Err(db.code().map(|c| c.to_string()).unwrap_or_default()),
        Err(other) => Err(format!("non-db: {other}")),
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn pre_floor_evidence_never_becomes_an_item_or_a_proposal() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    guarded(&su.clone(), {
        let (su, worker, base, http) = (su.clone(), worker.clone(), base.clone(), http.clone());
        async move {
            let m = seed_min(&su).await;
            join(&su, m.ws, m.p1, m.agent, "member").await;
            let owner = login(&http, &base, m.ws, &m.owner.email).await;
            let (old, _) = seed_message(&su, m.ws, m.p1, m.owner.id).await;
            let (status, body) = post_reset(&http, &base, m.ws, &owner, 0).await;
            assert_eq!(status, 200, "{body}");

            // A post-reset digest and an item on it are fine; the same item over a message the floor now covers is not.
            let (m3, s3) = seed_message(&su, m.ws, m.p1, m.owner.id).await;
            let digest = worker_digest(&worker, m.ws, m.p1, s3, s3, &[m3]).await.expect("post-reset digest");
            let ok = worker_add_item(&worker, m.ws, digest, "초기화 뒤의 사실 quincejelly", &[m3]).await;
            assert!(matches!(ok, Ok(Some(_))), "{ok:?}");
            exec(
                &su,
                &format!(
                    "UPDATE mem_cursor SET last_seq = {s3}, reset_floor_seq = {s3} WHERE channel_id = '{}'",
                    m.p1
                ),
            )
            .await;
            let blocked = worker_add_item(&worker, m.ws, digest, "바닥 아래 근거의 사실 pineapplerock", &[m3]).await;
            assert_eq!(blocked, Err("55R01".to_string()), "pre-floor evidence cannot become an item");
            let add_sig = "public.mem_add_item(uuid, text, text, text, uuid[], real, boolean, text, text)";
            let original = sabotage(&su, add_sig, &[("AND m.seq <= c.reset_floor_seq", "AND false")]).await;
            let leaked = worker_add_item(&worker, m.ws, digest, "바닥 아래 근거의 사실 pineapplerock", &[m3]).await;
            restore(&su, &original).await;
            println!("RED [add_item fence]: shipped -> 55R01; fence removed -> {leaked:?}");
            assert!(matches!(leaked, Ok(Some(_))), "{leaked:?}");

            // L-3: the same for a proposal — evidence from before the reset is refused, one after it is fine.
            let (trigger, _) = seed_message(&su, m.ws, m.p1, m.owner.id).await;
            let run = seed_run(&su, m.ws, m.p1, m.agent, trigger).await;
            exec(
                &su,
                &format!(
                    "UPDATE mem_cursor SET last_seq = (SELECT last_seq FROM channel_seq WHERE channel_id = '{ch}'), \
                        reset_floor_seq = {s3} - 1 WHERE channel_id = '{ch}'",
                    ch = m.p1
                ),
            )
            .await;
            // (floor just below m3, above the erased `old`)
            let below = worker_propose(&worker, m.ws, run, "바닥 아래 근거의 제안 blueberryjam", &[old]).await;
            assert_eq!(below, Err("55R01".to_string()), "a proposal cannot cite an erased message");
            let fine = worker_propose(&worker, m.ws, run, "초기화 뒤 근거의 제안 blueberryjam", &[m3]).await;
            assert!(matches!(fine, Ok(Some(_))), "{fine:?}");
            let propose_sig = "public.mem_propose_item(uuid, text, text, text, uuid[])";
            let original = sabotage(&su, propose_sig, &[("AND m.seq <= c.reset_floor_seq", "AND false")]).await;
            let leaked = worker_propose(&worker, m.ws, run, "바닥 아래 근거의 제안 blueberryjam 둘", &[old]).await;
            restore(&su, &original).await;
            println!("RED [propose fence]: shipped -> 55R01; fence removed -> {leaked:?}");
            assert!(matches!(leaked, Ok(Some(_))), "{leaked:?}");
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_suspended_or_deleted_admin_cannot_reset() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let app = momo_app_pool(2).await;
    let a = seed_full(&su, &worker, false).await;
    let ws = a.m.ws;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    // HTTP: a token issued while active stops working once the member is suspended / deleted.
    for (label, update) in [
        (
            "suspended",
            "UPDATE member SET status = 'suspended' WHERE id = $1",
        ),
        (
            "deleted",
            "UPDATE member SET deleted_at = now() WHERE id = $1",
        ),
    ] {
        let admin = seed_human(&su, ws, "admin").await;
        let token = login(&http, &base, ws, &admin.email).await;
        sqlx::query(update)
            .bind(admin.id)
            .execute(&su)
            .await
            .unwrap();
        let (status, body) = post_reset(&http, &base, ws, &token, 0).await;
        assert!(status == 401 || status == 403, "{label}: {status} {body}");
        assert_eq!(epoch_of(&su, ws).await, 0, "{label}: nothing changed");
    }
    // DB: the function refuses them on its own, from app.member_id (a second and third wall behind the route).
    let susp = seed_human(&su, ws, "admin").await;
    let gone = seed_human(&su, ws, "admin").await;
    exec(
        &su,
        &format!(
            "UPDATE member SET status = 'suspended' WHERE id = '{}'",
            susp.id
        ),
    )
    .await;
    exec(
        &su,
        &format!(
            "UPDATE member SET deleted_at = now() WHERE id = '{}'",
            gone.id
        ),
    )
    .await;
    guarded(&su.clone(), {
        let (su, app) = (su.clone(), app.clone());
        async move {
            for (label, member) in [("suspended", susp.id), ("deleted", gone.id)] {
                let sql = reset_sql(0);
                assert_eq!(
                    as_of(&app, ws, member, &sql).await,
                    Err("42501".to_string()),
                    "{label}"
                );
                let original = sabotage(
                    &su,
                    RESET_SIG,
                    &[
                        (
                            "AND m.status = 'active' AND m.deleted_at IS NULL) THEN",
                            ") THEN",
                        ),
                        ("NOT public.mem_is_workspace_admin()", "false"),
                    ],
                )
                .await;
                let leaked = as_of(&app, ws, member, &sql).await;
                restore(&su, &original).await;
                println!(
                    "RED [{label} admin]: shipped -> 42501; both walls removed -> ok={}",
                    leaked.is_ok()
                );
                assert!(leaked.is_ok(), "{label}: {leaked:?}");
            }
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_reset_never_deadlocks_with_a_message_edit_holding_the_channel_lock() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let a = seed_full(&su, &worker, false).await;
    let m = &a.m;
    let owner = login(&http, &base, m.ws, &m.owner.email).await;
    let (evidence, seq) = seed_message(&su, m.ws, m.p1, m.owner.id).await;

    // E: an edit — message row lock + the channel advisory lock (exclusive), held open.
    let mut edit = su.begin().await.unwrap();
    sqlx::query("UPDATE message SET body = '편집 중', edited_at = now() WHERE id = $1")
        .bind(evidence)
        .execute(&mut *edit)
        .await
        .expect("edit (uncommitted)");
    // W: a summary of that message (message FOR KEY SHARE → waits at the channel advisory lock behind E).
    let wtask = {
        let (worker, ws, ch) = (worker.clone(), m.ws, m.p1);
        tokio::spawn(async move { worker_digest(&worker, ws, ch, seq, seq, &[evidence]).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    // R: the reset. It takes only the workspace lock, then deletes rows E's trigger may hold.
    let reset = spawn_reset(base.clone(), m.ws, owner);
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    edit.commit().await.expect("the edit commits");
    let finished = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        (
            wtask.await.expect("worker task"),
            reset.await.expect("reset task"),
        )
    })
    .await
    .expect("no deadlock: both finished within 20 s");
    let (applied, (status, body)) = finished;
    assert_eq!(status, 200, "{body}");
    assert_ne!(
        applied.as_ref().err().map(String::as_str),
        Some("40P01"),
        "no deadlock victim: {applied:?}"
    );
    // W ran after the reset committed (the workspace lock), so its evidence is at/below the floor.
    assert_eq!(applied, Err("55R01".to_string()), "{applied:?}");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_digest WHERE workspace_id = $1")
        .bind(m.ws)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_epoch_never_goes_back_and_a_busy_reset_answers_503() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let app = momo_app_pool(2).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    guarded(&su.clone(), {
        let (su, worker, app, base, http) =
            (su.clone(), worker.clone(), app.clone(), base.clone(), http.clone());
        async move {
            // L-5: after a reset the workspace row cannot be deleted (which would let a stale epoch work again).
            let a = seed_full(&su, &worker, false).await;
            let ws = a.m.ws;
            let owner = login(&http, &base, ws, &a.m.owner.email).await;
            let (status, _) = post_reset(&http, &base, ws, &owner, 0).await;
            assert_eq!(status, 200);
            let del = "DELETE FROM mem_settings WHERE scope = 'workspace' RETURNING reset_epoch::text";
            assert_eq!(as_of(&app, ws, a.m.owner.id, del).await, Err("42501".to_string()));
            let down = "UPDATE mem_settings SET reset_epoch = 0 WHERE scope = 'workspace' RETURNING reset_epoch::text";
            assert_eq!(as_of(&app, ws, a.m.owner.id, down).await, Err("42501".to_string()));
            exec(&su, "ALTER TABLE mem_settings DISABLE TRIGGER mem_settings_epoch_no_delete_trg").await;
            register_restore("ALTER TABLE mem_settings ENABLE TRIGGER mem_settings_epoch_no_delete_trg".to_string());
            let gone = as_of(&app, ws, a.m.owner.id, del).await;
            exec(&su, "ALTER TABLE mem_settings ENABLE TRIGGER mem_settings_epoch_no_delete_trg").await;
            println!("RED [epoch delete guard]: shipped -> 42501; trigger disabled -> {gone:?}");
            assert!(gone.is_ok());
            // The workspace itself can still be deleted (the FK cascade removes the settings row).
            let doomed = seed_full(&su, &worker, false).await;
            let doomed_owner = login(&http, &base, doomed.m.ws, &doomed.m.owner.email).await;
            assert_eq!(post_reset(&http, &base, doomed.m.ws, &doomed_owner, 0).await.0, 200);
            exec(&su, &format!("DELETE FROM workspace WHERE id = '{}'", doomed.m.ws)).await;
            assert_eq!(epoch_of(&su, doomed.m.ws).await, 0, "the workspace and its settings are gone");

            // L-4/L-7: a reset that keeps finding new rows raises instead of leaving quietly, and the API
            // answers a retryable 503 (after its own bounded retries) with nothing changed.
            let b = seed_full(&su, &worker, false).await;
            let b_owner = login(&http, &base, b.m.ws, &b.m.owner.email).await;
            let before = counts(&su, b.m.ws).await;
            let original = sabotage(&su, RESET_SIG, &[("IF v_pass = 5 THEN", "IF v_pass >= 1 THEN")]).await;
            let (status, body) = post_reset(&http, &base, b.m.ws, &b_owner, 0).await;
            restore(&su, &original).await;
            println!("busy reset -> {status} {body}");
            assert_eq!(status, 503, "{body}");
            assert_eq!(body["error"]["code"], "memory_reset_busy");
            assert_eq!(counts(&su, b.m.ws).await, before, "a busy reset changed nothing");
            assert_eq!(epoch_of(&su, b.m.ws).await, 0);
            let (status, body) = post_reset(&http, &base, b.m.ws, &b_owner, 0).await;
            assert_eq!(status, 200, "{body}");
        }
    })
    .await;
}
