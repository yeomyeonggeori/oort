//! #3208 / ADR-0196 D9 + D12 V4 — the memory browser API (items list / search / detail / evidence /
//! events / edit / forget) over HTTP against real Postgres as `momo_app`.
//!
//! Items are seeded the way the summary worker (#3162) writes them: a `momo_worker` connection that
//! has done `SET ROLE momo_memory` calls `mem_apply_digest` + `mem_add_item`. Everything the API
//! returns is then decided by the migration 104 RLS policies and the 106 definer functions — these
//! tests prove the routes wire `app.member_id`, answer with no existence oracle, and that every new
//! guard is load-bearing (each sabotaged in turn; the RED output is printed with `--nocapture`).
//!
//! | test | what it proves |
//! |---|---|
//! | `readers_see_the_list_detail_evidence_and_events` | list/filter/keyset, detail + evidence back-links, events, search |
//! | `hidden_items_are_absent_or_404_with_no_oracle` | non-reader, multi-channel, personal, other workspace; search under RLS |
//! | `edit_supersedes_and_keeps_the_evidence` | permission (D9), new curated item, old = history, validation, 409s |
//! | `forget_deletes_for_good_and_hides_everywhere` | permission, chain purge, ledger ids only, search/list/detail gone |
//! | `agents_suspended_members_and_wrong_sessions_are_refused` | agent bearer 403, suspended 403, definer session guard |
//! | `each_new_guard_is_load_bearing` | sabotage of every guard in 106 (RED) |
//! | `member_id_is_not_left_on_the_pooled_connection` | LOCAL GUC after success/refusal |
//! | `forget_sweeps_dead_twins_and_suppresses_reextraction` | M-1 twins, M-5 suppression (hash only), M-4 indexes |
//! | `editing_to_a_twins_text_reveals_nothing_and_a_dead_twin_gives_way` | M-2 |
//! | `guests_read_but_do_not_change_and_curated_items_name_their_editor` | M-6 |
//! | `only_the_functions_own_errors_are_mapped_and_nul_is_refused` | L-1, L-4 |
//!
//! `#[ignore]` — needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:25208/momo \
//!   cargo test -p momo-server --test mem_browser_conformance_pg \
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

const TEST_JWT_SECRET: &str = "mem-browser-conformance-signing-secret";
const TEST_PASSWORD: &str = "mem-browser-test-password";

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
        .bind(format!("membrowser-{id}"))
        .execute(su)
        .await
        .expect("workspace");
    id
}

async fn seed_human(su: &PgPool, ws: Uuid, role: &str) -> Human {
    let id = Uuid::new_v4();
    let handle = format!("h-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@membrowser.test");
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

struct World {
    ws: Uuid,
    ws_b: Uuid,
    alice: Human,    // P1 + S1 + DM(agent) member
    bob: Human,      // P1 only
    carol: Human,    // workspace member, no channel
    erin: Human,     // P1 member, suspended later
    wsadmin: Human,  // workspace admin, not in any channel
    outsider: Human, // other workspace
    agent: Uuid,
    p1: Uuid,
    s1: Uuid,
    dm: Uuid,
    /// p1 items, oldest first: decision, fact, commitment
    a1: Uuid,
    a2: Uuid,
    a3: Uuid,
    a1_msgs: Vec<(Uuid, i64)>,
    /// alice-only private channel item
    s1_item: Uuid,
    /// p1 storage channel, evidence in p1 (bob) AND s1 (alice only)
    multi: Uuid,
    /// personal (alice <-> agent DM)
    personal: Uuid,
    /// an item of the other workspace
    other_item: Uuid,
}

const A1_BODY: &str = "릴리스 동결은 금요일 zebraquartz 이후에 시작한다";
const A2_BODY: &str = "온콜 로테이션은 매주 월요일 mangoplume 교대";
const A3_BODY: &str = "분기 로드맵 문서는 leopardnut 담당이 정리한다";
const S1_BODY: &str = "비공개 예산 결정은 kiwiember 팀만 안다";
const MULTI_BODY: &str = "다중 채널 근거 항목 papayafrost 기록";
const PERSONAL_BODY: &str = "알리스 개인 선호는 아침 plumcrest 커피";

async fn build_world(su: &PgPool, worker: &PgPool) -> World {
    let ws = seed_workspace(su).await;
    let ws_b = seed_workspace(su).await;
    let alice = seed_human(su, ws, "member").await;
    let bob = seed_human(su, ws, "member").await;
    let carol = seed_human(su, ws, "member").await;
    let erin = seed_human(su, ws, "member").await;
    let wsadmin = seed_human(su, ws, "admin").await;
    let outsider = seed_human(su, ws_b, "member").await;
    let agent = seed_agent(su, ws, alice.id).await;
    let p1 = seed_channel(su, ws, "public", alice.id).await;
    let s1 = seed_channel(su, ws, "private", alice.id).await;
    let dm = seed_channel(su, ws, "dm", alice.id).await;
    for member in [&alice, &bob, &erin] {
        join(su, ws, p1, member.id, "member").await;
    }
    join(su, ws, s1, alice.id, "member").await;
    join(su, ws, dm, alice.id, "member").await;
    join(su, ws, dm, agent, "member").await;

    let (a1, a1_msgs) = seed_item(su, worker, ws, p1, alice.id, "decision", A1_BODY, 2).await;
    let (a2, _) = seed_item(su, worker, ws, p1, bob.id, "fact", A2_BODY, 1).await;
    let (a3, _) = seed_item(su, worker, ws, p1, alice.id, "commitment", A3_BODY, 1).await;
    let (s1_item, _) = seed_item(su, worker, ws, s1, alice.id, "fact", S1_BODY, 1).await;
    let (personal, _) = seed_item(su, worker, ws, dm, alice.id, "fact", PERSONAL_BODY, 1).await;

    // A multi-channel item cannot come from mem_add_item (one digest = one channel); a superuser
    // forges the shape the read rule must still hide: stored in p1, evidence in p1 AND s1.
    let m_p1 = seed_message(su, ws, p1, bob.id).await;
    let m_s1 = seed_message(su, ws, s1, alice.id).await;
    let multi = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO mem_item (id, workspace_id, space_kind, channel_id, kind, origin, body, \
         valid_from, content_hash, extractor_version, source_count) \
         VALUES ($1, $2, 'channel', $3, 'fact', 'extracted', $4, now(), \
                 encode(sha256(convert_to('fact:' || $4, 'UTF8')), 'hex'), 'forged', 2)",
    )
    .bind(multi)
    .bind(ws)
    .bind(p1)
    .bind(MULTI_BODY)
    .execute(su)
    .await
    .expect("multi item");
    for (msg, ch) in [(m_p1.0, p1), (m_s1.0, s1)] {
        sqlx::query(
            "INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ($1, $2, $3, $4)",
        )
        .bind(ws)
        .bind(multi)
        .bind(msg)
        .bind(ch)
        .execute(su)
        .await
        .expect("multi evidence");
    }

    // The other workspace's item (forged the same way; only its id matters here).
    let hr_owner = outsider.id;
    let pb = seed_channel(su, ws_b, "public", hr_owner).await;
    join(su, ws_b, pb, hr_owner, "member").await;
    let mb = seed_message(su, ws_b, pb, hr_owner).await;
    let other_item = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO mem_item (id, workspace_id, space_kind, channel_id, kind, origin, body, \
         valid_from, content_hash, extractor_version, source_count) \
         VALUES ($1, $2, 'channel', $3, 'fact', 'extracted', '다른 워크스페이스 항목', now(), 'hb', 'forged', 1)",
    )
    .bind(other_item)
    .bind(ws_b)
    .bind(pb)
    .execute(su)
    .await
    .expect("other item");
    sqlx::query(
        "INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(ws_b)
    .bind(other_item)
    .bind(mb.0)
    .bind(pb)
    .execute(su)
    .await
    .expect("other evidence");

    World {
        ws,
        ws_b,
        alice,
        bob,
        carol,
        erin,
        wsadmin,
        outsider,
        agent,
        p1,
        s1,
        dm,
        a1,
        a2,
        a3,
        a1_msgs,
        s1_item,
        multi,
        personal,
        other_item,
    }
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
                 ARRAY['messages:write']::text[], 'mem-browser-conformance')",
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

fn items_url(base: &str, ws: Uuid) -> String {
    format!("{base}/v1/workspaces/{ws}/memory/items")
}

fn item_url(base: &str, ws: Uuid, id: Uuid) -> String {
    format!("{base}/v1/workspaces/{ws}/memory/items/{id}")
}

fn item_ids(body: &Value) -> Vec<String> {
    body["items"]
        .as_array()
        .expect("items array")
        .iter()
        .map(|i| i["id"].as_str().expect("id").to_string())
        .collect()
}

async fn item_row_exists(su: &PgPool, id: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM mem_item WHERE id = $1::uuid)")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("exists")
}

/// The four item URLs a caller can hit with an id (used to compare "hidden" with "nonexistent").
async fn probe_all(
    http: &reqwest::Client,
    base: &str,
    ws: Uuid,
    id: Uuid,
    token: &str,
) -> Vec<(u16, Value)> {
    let url = item_url(base, ws, id);
    vec![
        get(http, &url, token).await,
        get(http, &format!("{url}/evidence"), token).await,
        get(http, &format!("{url}/events"), token).await,
        send(
            http,
            reqwest::Method::PATCH,
            &url,
            token,
            Some(json!({"body": "몰래 고쳐 쓴 본문"})),
        )
        .await,
        send(http, reqwest::Method::DELETE, &url, token, None).await,
    ]
}

/// PATCH the id with bodies whose refusal must not depend on whether the id exists or is hidden:
/// plain, credential-shaped, over-long, NUL, and `same_text` (the text of the hidden item itself).
async fn probe_edit_variants(
    http: &reqwest::Client,
    base: &str,
    ws: Uuid,
    id: Uuid,
    token: &str,
    same_text: &str,
) -> Vec<(u16, Value)> {
    let url = item_url(base, ws, id);
    let mut out = Vec::new();
    for body in [
        "몰래 고쳐 쓴 본문".to_string(),
        "토큰 sk-abcdefghijklmnopqrstuvwxyz123456 기록".to_string(),
        "가".repeat(601),
        "널\u{0}문자".to_string(),
        same_text.to_string(),
    ] {
        out.push(
            send(
                http,
                reqwest::Method::PATCH,
                &url,
                token,
                Some(json!({ "body": body })),
            )
            .await,
        );
    }
    out
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

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn readers_see_the_list_detail_evidence_and_events() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, w.ws, &w.alice.email).await;
    let bob = login(&http, &base, w.ws, &w.bob.email).await;

    // list: bob (p1 only) sees the three p1 items, newest first; nothing of s1 / personal / multi.
    let (status, body) = get(&http, &items_url(&base, w.ws), &bob).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        item_ids(&body),
        [w.a3, w.a2, w.a1]
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>(),
        "bob sees exactly the p1 items, newest first"
    );
    assert!(body.get("nextCursor").is_none());
    // alice additionally sees the s1 item, the multi-channel item (she reads both channels) and
    // her personal one.
    let (_, body) = get(&http, &items_url(&base, w.ws), &alice).await;
    let alice_ids = item_ids(&body);
    for id in [w.a1, w.a2, w.a3, w.s1_item, w.multi, w.personal] {
        assert!(alice_ids.contains(&id.to_string()), "alice reads {id}");
    }

    // filters
    let (_, body) = get(
        &http,
        &format!("{}?kind=fact", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(item_ids(&body), vec![w.a2.to_string()]);
    let (_, body) = get(
        &http,
        &format!("{}?channelId={}", items_url(&base, w.ws), w.s1),
        &alice,
    )
    .await;
    assert_eq!(item_ids(&body), vec![w.s1_item.to_string()]);
    let (status, _) = get(
        &http,
        &format!("{}?kind=bogus", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = get(
        &http,
        &format!("{}?status=forgotten", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = get(
        &http,
        &format!("{}?cursor=garbage", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(status, 400);

    // keyset pagination: limit 2 -> [a3, a2] + cursor -> [a1], no cursor.
    let (_, page1) = get(&http, &format!("{}?limit=2", items_url(&base, w.ws)), &bob).await;
    assert_eq!(item_ids(&page1), vec![w.a3.to_string(), w.a2.to_string()]);
    let cursor = page1["nextCursor"].as_str().expect("cursor").to_string();
    let (_, page2) = get(
        &http,
        &format!("{}?limit=2&cursor={cursor}", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(item_ids(&page2), vec![w.a1.to_string()]);
    assert!(page2.get("nextCursor").is_none());

    // detail + evidence back-links (message ids, channel, seq — never text).
    let (status, detail) = get(&http, &item_url(&base, w.ws, w.a1), &bob).await;
    assert_eq!(status, 200);
    assert_eq!(detail["item"]["body"], A1_BODY);
    assert_eq!(detail["item"]["kind"], "decision");
    assert_eq!(detail["item"]["origin"], "extracted");
    assert_eq!(detail["item"]["sourceCount"], 2);
    let evidence = detail["evidence"].as_array().expect("evidence");
    assert_eq!(evidence.len(), 2);
    for (link, (msg, seq)) in evidence.iter().zip(&w.a1_msgs) {
        assert_eq!(link["messageId"], msg.to_string());
        assert_eq!(link["channelId"], w.p1.to_string());
        assert_eq!(link["seq"], *seq);
    }
    let (status, ev) = get(
        &http,
        &format!("{}/evidence", item_url(&base, w.ws, w.a1)),
        &bob,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(ev["evidence"], detail["evidence"]);
    assert!(
        !detail.to_string().contains("\"body\":\"x\""),
        "message text is never returned"
    );

    // events: the ledger row written by mem_add_item.
    let (status, events) = get(
        &http,
        &format!("{}/events", item_url(&base, w.ws, w.a1)),
        &bob,
    )
    .await;
    assert_eq!(status, 200);
    let list = events["events"].as_array().expect("events");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["action"], "created");
    assert_eq!(list[0]["detail"]["source_count"], 2);

    // search: ranked hit carries a score; retired-only statuses are refused.
    let (status, hits) = get(
        &http,
        &format!("{}?q=zebraquartz", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(status, 200, "{hits}");
    assert_eq!(item_ids(&hits), vec![w.a1.to_string()]);
    assert!(hits["items"][0]["score"].as_f64().unwrap() > 0.0);
    assert!(hits["items"][0].get("retiredAtMs").is_none());
    let (status, _) = get(
        &http,
        &format!("{}?q=zebraquartz&status=history", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(status, 400);
    // channel/kind narrow a search
    let (_, hits) = get(
        &http,
        &format!("{}?q=zebraquartz&kind=fact", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert!(item_ids(&hits).is_empty());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn hidden_items_are_absent_or_404_with_no_oracle() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, w.ws, &w.alice.email).await;
    let bob = login(&http, &base, w.ws, &w.bob.email).await;
    let carol = login(&http, &base, w.ws, &w.carol.email).await;
    let wsadmin = login(&http, &base, w.ws, &w.wsadmin.email).await;

    // carol reads no channel: empty list (200), not an error, and no hint.
    let (status, body) = get(&http, &items_url(&base, w.ws), &carol).await;
    assert_eq!(status, 200);
    assert!(item_ids(&body).is_empty());
    // a workspace admin is not a channel reader either (D9 「근거 채널 멤버」).
    let (_, body) = get(&http, &items_url(&base, w.ws), &wsadmin).await;
    assert!(item_ids(&body).is_empty());
    // asking for a specific unreadable channel is the same empty list
    let (status, body) = get(
        &http,
        &format!("{}?channelId={}", items_url(&base, w.ws), w.s1),
        &bob,
    )
    .await;
    assert_eq!(status, 200);
    assert!(item_ids(&body).is_empty());

    // bob (p1 only): the multi-channel item (evidence in s1), the s1 item and alice's personal
    // item are absent from his list and 404 on every call — byte-identical to a random id.
    let (_, body) = get(&http, &items_url(&base, w.ws), &bob).await;
    let ids = item_ids(&body);
    for hidden in [w.multi, w.s1_item, w.personal] {
        assert!(
            !ids.contains(&hidden.to_string()),
            "{hidden} leaked into bob's list"
        );
    }
    let nothing = probe_all(&http, &base, w.ws, Uuid::new_v4(), &bob).await;
    assert!(nothing.iter().all(|(s, _)| *s == 404), "{nothing:?}");
    for hidden in [w.multi, w.s1_item, w.personal] {
        assert_eq!(
            probe_all(&http, &base, w.ws, hidden, &bob).await,
            nothing,
            "{hidden}: hidden must look exactly like nonexistent (status AND body)"
        );
        assert_eq!(
            probe_all(&http, &base, w.ws, hidden, &carol).await,
            nothing,
            "{hidden} for carol"
        );
    }
    // the other workspace's item is invisible from here too
    assert_eq!(
        probe_all(&http, &base, w.ws, w.other_item, &alice).await,
        nothing
    );
    // none of those probes changed anything
    for id in [w.multi, w.s1_item, w.personal, w.other_item] {
        assert!(
            item_row_exists(&su, &id.to_string()).await,
            "{id} untouched"
        );
    }

    // the owner / a reader of both channels does see them.
    for visible in [w.multi, w.s1_item, w.personal] {
        let (status, _) = get(&http, &item_url(&base, w.ws, visible), &alice).await;
        assert_eq!(status, 200, "{visible} for alice");
    }

    // search respects RLS: each hidden item's rare word finds it for alice, never for the others.
    for (word, id) in [
        ("papayafrost", w.multi),
        ("kiwiember", w.s1_item),
        ("plumcrest", w.personal),
    ] {
        let url = format!("{}?q={word}", items_url(&base, w.ws));
        let (_, hits) = get(&http, &url, &alice).await;
        assert_eq!(item_ids(&hits), vec![id.to_string()], "alice finds {word}");
        for (who, token) in [("bob", &bob), ("carol", &carol), ("wsadmin", &wsadmin)] {
            let (status, hits) = get(&http, &url, token).await;
            assert_eq!(status, 200);
            assert!(
                item_ids(&hits).is_empty(),
                "{who} must not find {word}: {hits}"
            );
        }
    }

    // a source message that is deleted hides the item (D6-5) — and then edit is a plain 404 too.
    sqlx::query("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = $1")
        .bind(w.a1_msgs[0].0)
        .execute(&su)
        .await
        .expect("delete a source");
    assert_eq!(probe_all(&http, &base, w.ws, w.a1, &bob).await, nothing);

    // L-5: the refusal of an edit does not depend on the body either — credential-shaped, over-long,
    // NUL, and the hidden item's own text all get the answer a nonexistent id gets.
    let random = Uuid::new_v4();
    for (hidden, text) in [
        (w.multi, MULTI_BODY),
        (w.s1_item, S1_BODY),
        (w.personal, PERSONAL_BODY),
        (w.a1, A1_BODY),
    ] {
        let want = probe_edit_variants(&http, &base, w.ws, random, &bob, text).await;
        assert_eq!(
            probe_edit_variants(&http, &base, w.ws, hidden, &bob, text).await,
            want,
            "{hidden}: edit variants must not tell hidden from missing"
        );
    }
    // a hidden *retired* item is a 404 too (retired items are readable history only to readers).
    sqlx::query("UPDATE mem_item SET retired_at = now(), retired_reason = 'edited' WHERE id = $1")
        .bind(w.multi)
        .execute(&su)
        .await
        .expect("retire multi");
    assert_eq!(probe_all(&http, &base, w.ws, w.multi, &bob).await, nothing);
    let (status, _) = get(&http, &item_url(&base, w.ws, w.multi), &alice).await;
    assert_eq!(status, 200, "its readers still see the history");
    let (_, history) = get(
        &http,
        &format!("{}?status=history", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert!(!item_ids(&history).contains(&w.multi.to_string()));
    // a member who left the channel loses the list at once (narrowing + policy agree).
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(w.p1)
        .bind(w.erin.id)
        .execute(&su)
        .await
        .expect("erin leaves");
    let erin = login(&http, &base, w.ws, &w.erin.email).await;
    let (status, body) = get(&http, &items_url(&base, w.ws), &erin).await;
    assert_eq!(status, 200);
    assert!(item_ids(&body).is_empty(), "{body}");
}

async fn edit(
    http: &reqwest::Client,
    base: &str,
    ws: Uuid,
    id: Uuid,
    token: &str,
    body: Value,
) -> (u16, Value) {
    send(
        http,
        reqwest::Method::PATCH,
        &item_url(base, ws, id),
        token,
        Some(body),
    )
    .await
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn edit_supersedes_and_keeps_the_evidence() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;
    let carol = login(&http, &base, w.ws, &w.carol.email).await;
    let new_body = "릴리스 동결은 목요일 zebraquartz 자정부터 시작한다";

    // unauthorized: refused, and the answer is the same 404 a random id gets; nothing changed.
    let (s_missing, b_missing) = edit(
        &http,
        &base,
        w.ws,
        Uuid::new_v4(),
        &carol,
        json!({"body": new_body}),
    )
    .await;
    assert_eq!(s_missing, 404);
    for hidden in [w.a1, w.multi, w.personal, w.s1_item] {
        let who = if hidden == w.a1 { &carol } else { &bob };
        let (status, body) = edit(&http, &base, w.ws, hidden, who, json!({"body": new_body})).await;
        assert_eq!((status, &body), (s_missing, &b_missing), "{hidden}");
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM mem_item WHERE workspace_id = $1 AND origin = 'curated'"
        )
        .bind(w.ws)
        .fetch_one(&su)
        .await
        .unwrap(),
        0,
        "a refused edit adds nothing"
    );

    // validation: 422 for text, 400 for a bad kind; nothing written.
    for bad in [
        json!({"body": "   "}),
        json!({"body": "가".repeat(601)}),
        json!({"body": "sk-abcdefghijklmnopqrstuvwxyz123456"}),
    ] {
        let (status, _) = edit(&http, &base, w.ws, w.a1, &bob, bad).await;
        assert_eq!(status, 422);
    }
    let (status, _) = edit(
        &http,
        &base,
        w.ws,
        w.a1,
        &bob,
        json!({"body": new_body, "kind": "nope"}),
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = edit(&http, &base, w.ws, w.a1, &bob, json!({"body": A1_BODY})).await;
    assert_eq!(status, 422, "an unchanged text is refused");
    let (status, _) = edit(
        &http,
        &base,
        w.ws,
        w.a1,
        &bob,
        json!({"body": new_body, "extra": 1}),
    )
    .await;
    assert!(
        status == 400 || status == 422,
        "unknown fields are refused: {status}"
    );

    // a reader (bob is a member of the evidence channel, not the author) may edit — D9.
    let (status, edited) = edit(
        &http,
        &base,
        w.ws,
        w.a1,
        &bob,
        json!({"body": new_body, "kind": "commitment"}),
    )
    .await;
    assert_eq!(status, 200, "{edited}");
    let new_id = edited["item"]["id"].as_str().expect("new id").to_string();
    assert_ne!(new_id, w.a1.to_string());
    assert_eq!(edited["item"]["origin"], "curated");
    assert_eq!(edited["item"]["kind"], "commitment");
    assert_eq!(edited["item"]["body"], new_body);
    assert_eq!(edited["item"]["supersedesId"], w.a1.to_string());
    assert_eq!(edited["supersededId"], w.a1.to_string());
    // the old evidence is kept, link for link.
    let old_msgs: Vec<String> = w.a1_msgs.iter().map(|m| m.0.to_string()).collect();
    let new_msgs: Vec<String> = edited["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["messageId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(new_msgs, old_msgs);
    assert_eq!(edited["item"]["sourceCount"], 2);

    // active list: new one, not the old; history: the old, retired as edited, pointing forward.
    let (_, active) = get(&http, &items_url(&base, w.ws), &bob).await;
    let ids = item_ids(&active);
    assert!(ids.contains(&new_id) && !ids.contains(&w.a1.to_string()));
    let (_, history) = get(
        &http,
        &format!("{}?status=history", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(item_ids(&history), vec![w.a1.to_string()]);
    assert_eq!(history["items"][0]["retiredReason"], "edited");
    assert_eq!(history["items"][0]["supersededById"], new_id);
    // search finds the new text, not the retired one
    let (_, hits) = get(
        &http,
        &format!("{}?q=zebraquartz", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert_eq!(item_ids(&hits), vec![new_id.clone()]);

    // events: the new item says 'edited' (with the id it supersedes), the old one 'superseded'.
    let new_uuid = Uuid::parse_str(&new_id).unwrap();
    let (_, ev_new) = get(
        &http,
        &format!("{}/events", item_url(&base, w.ws, new_uuid)),
        &alice_or(&http, &base, &w).await,
    )
    .await;
    assert_eq!(ev_new["events"][0]["action"], "edited");
    assert_eq!(
        ev_new["events"][0]["detail"]["supersedes"],
        w.a1.to_string()
    );
    assert_eq!(ev_new["events"][0]["actorMemberId"], w.bob.id.to_string());
    let (_, ev_old) = get(
        &http,
        &format!("{}/events", item_url(&base, w.ws, w.a1)),
        &bob,
    )
    .await;
    let actions: Vec<&str> = ev_old["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert_eq!(actions, vec!["created", "superseded"]);
    let ledger = ev_old.to_string() + &ev_new.to_string();
    assert!(
        !ledger.contains("zebraquartz"),
        "the ledger never holds memory text"
    );

    // the audit trail is written in the same tx and names ids only.
    let audit: Vec<(String, Value)> = sqlx::query_as(
        "SELECT action, detail FROM audit_log WHERE workspace_id = $1 AND action = 'memory.item.edited'",
    )
    .bind(w.ws)
    .fetch_all(&su)
    .await
    .expect("audit");
    assert_eq!(audit.len(), 1);
    assert!(!audit[0].1.to_string().contains("zebraquartz"));

    // the retired version cannot be edited again (409 — only a reader reaches this answer).
    let (status, _) = edit(
        &http,
        &base,
        w.ws,
        w.a1,
        &bob,
        json!({"body": "또 다른 본문 zebraquartz"}),
    )
    .await;
    assert_eq!(status, 409);
    // an identical live item in the channel is refused with the generic 422 (M-2: never a distinguishable
    // 409): a2 -> a3's text.
    let (status, _) = edit(
        &http,
        &base,
        w.ws,
        w.a2,
        &bob,
        json!({"body": A3_BODY, "kind": "commitment"}),
    )
    .await;
    assert_eq!(status, 422);
    // the new (curated) item can itself be edited: a chain.
    let (status, second) = edit(
        &http,
        &base,
        w.ws,
        new_uuid,
        &bob,
        json!({"body": "세 번째 판 zebraquartz 문구"}),
    )
    .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["item"]["supersedesId"], new_id);

    // a personal item: only the owner edits; its owner keeps the personal space.
    let alice = login(&http, &base, w.ws, &w.alice.email).await;
    let (status, mine) = edit(
        &http,
        &base,
        w.ws,
        w.personal,
        &alice,
        json!({"body": "알리스는 저녁에 plumcrest 차를 마신다"}),
    )
    .await;
    assert_eq!(status, 200, "{mine}");
    assert_eq!(mine["item"]["spaceKind"], "personal");
    let (s_bob, _) = get(
        &http,
        &item_url(
            &base,
            w.ws,
            Uuid::parse_str(mine["item"]["id"].as_str().unwrap()).unwrap(),
        ),
        &bob,
    )
    .await;
    assert_eq!(s_bob, 404, "the edited personal item stays private");
}

/// alice's token, minted on demand (keeps the edit test's flow linear).
async fn alice_or(http: &reqwest::Client, base: &str, w: &World) -> String {
    login(http, base, w.ws, &w.alice.email).await
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn forget_deletes_for_good_and_hides_everywhere() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, w.ws, &w.alice.email).await;
    let bob = login(&http, &base, w.ws, &w.bob.email).await;
    let carol = login(&http, &base, w.ws, &w.carol.email).await;
    let del = |token: String, id: Uuid| {
        let (http, url) = (http.clone(), item_url(&base, w.ws, id));
        async move { send(&http, reqwest::Method::DELETE, &url, &token, None).await }
    };

    // unauthorized forget: the same 404 as a random id; the item survives.
    let (s_missing, b_missing) = del(carol.clone(), Uuid::new_v4()).await;
    assert_eq!(s_missing, 404);
    for (hidden, token) in [
        (w.a2, &carol),
        (w.multi, &bob),
        (w.personal, &bob),
        (w.s1_item, &bob),
    ] {
        assert_eq!(
            del(token.clone(), hidden).await,
            (s_missing, b_missing.clone()),
            "{hidden}"
        );
        assert!(
            item_row_exists(&su, &hidden.to_string()).await,
            "{hidden} survived"
        );
    }

    // edit a1 twice, then try to forget an OLD version: 409 (forget the newest).
    let (_, e1) = edit(
        &http,
        &base,
        w.ws,
        w.a1,
        &bob,
        json!({"body": "1판 zebraquartz 문구 하나"}),
    )
    .await;
    let v2 = Uuid::parse_str(e1["item"]["id"].as_str().unwrap()).unwrap();
    let (_, e2) = edit(
        &http,
        &base,
        w.ws,
        v2,
        &bob,
        json!({"body": "2판 zebraquartz 문구 둘"}),
    )
    .await;
    let v3 = Uuid::parse_str(e2["item"]["id"].as_str().unwrap()).unwrap();
    let (status, _) = del(bob.clone(), w.a1).await;
    assert_eq!(status, 409, "an older version cannot be forgotten alone");
    assert!(item_row_exists(&su, &w.a1.to_string()).await);

    // forgetting the newest deletes the whole chain: 3 rows, evidence too, ledger ids only.
    let evidence_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_evidence WHERE item_id = ANY($1)")
            .bind(vec![w.a1, v2, v3])
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(evidence_before, 6);
    let (status, gone) = del(bob.clone(), v3).await;
    assert_eq!(status, 200, "{gone}");
    assert_eq!(gone["forgottenCount"], 3);
    for id in [w.a1, v2, v3] {
        assert!(
            !item_row_exists(&su, &id.to_string()).await,
            "{id} is deleted, not hidden"
        );
    }
    let evidence_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_evidence WHERE item_id = ANY($1)")
            .bind(vec![w.a1, v2, v3])
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(evidence_after, 0);
    let body_left: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM mem_item WHERE workspace_id = $1 AND body LIKE '%zebraquartz%'",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        body_left, 0,
        "no version of the text survives anywhere in mem_item"
    );
    // ledger: 'forgotten' events for all three, ids/counts only.
    let ledger: Vec<(Uuid, String, Value)> = sqlx::query_as(
        "SELECT target_id, action, detail FROM mem_event WHERE workspace_id = $1 AND action = 'forgotten' ORDER BY created_at",
    )
    .bind(w.ws)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(ledger.len(), 3);
    assert!(ledger
        .iter()
        .all(|(_, _, d)| !d.to_string().contains("zebraquartz")));
    let dump: String = sqlx::query_scalar(
        "SELECT coalesce(string_agg(detail::text, ' '), '') FROM mem_event WHERE workspace_id = $1",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        !dump.contains("zebraquartz"),
        "no event detail holds the text"
    );
    // hidden everywhere: 404s, list, search, and the ledger is unreadable through the API.
    let nothing = probe_all(&http, &base, w.ws, Uuid::new_v4(), &bob).await;
    for id in [w.a1, v2, v3] {
        assert_eq!(probe_all(&http, &base, w.ws, id, &bob).await, nothing);
    }
    let (_, list) = get(
        &http,
        &format!("{}?status=all", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert!(!item_ids(&list)
        .iter()
        .any(|i| [w.a1, v2, v3].iter().any(|x| x.to_string() == *i)));
    let (_, hits) = get(
        &http,
        &format!("{}?q=zebraquartz", items_url(&base, w.ws)),
        &bob,
    )
    .await;
    assert!(item_ids(&hits).is_empty());
    // audit names the id only
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'memory.item.forgotten'",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(!audit.to_string().contains("zebraquartz"));

    // a personal item: only its owner forgets it.
    assert_eq!(del(bob.clone(), w.personal).await.0, 404);
    let (status, _) = del(alice.clone(), w.personal).await;
    assert_eq!(status, 200);
    let (_, hits) = get(
        &http,
        &format!("{}?q=plumcrest", items_url(&base, w.ws)),
        &alice,
    )
    .await;
    assert!(
        item_ids(&hits).is_empty(),
        "a forgotten item is gone from search too"
    );
    // the multi-channel item: a reader of both channels may forget it.
    assert_eq!(del(alice.clone(), w.multi).await.0, 200);
    assert!(!item_row_exists(&su, &w.multi.to_string()).await);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn agents_suspended_members_and_wrong_sessions_are_refused() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let app = momo_app_pool(4).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let erin = login(&http, &base, w.ws, &w.erin.email).await;
    let agent = agent_bearer(&su, w.ws, w.agent).await;

    // agent principal: 403 on every item route (never a list, never a write).
    let url = item_url(&base, w.ws, w.a1);
    for (method, target, body) in [
        (reqwest::Method::GET, items_url(&base, w.ws), None),
        (reqwest::Method::GET, url.clone(), None),
        (reqwest::Method::GET, format!("{url}/evidence"), None),
        (reqwest::Method::GET, format!("{url}/events"), None),
        (
            reqwest::Method::PATCH,
            url.clone(),
            Some(json!({"body": "에이전트가 고친 본문"})),
        ),
        (reqwest::Method::DELETE, url.clone(), None),
    ] {
        let (status, _) = send(&http, method.clone(), &target, &agent, body).await;
        assert_eq!(status, 403, "{method} {target} as an agent");
    }
    assert!(item_row_exists(&su, &w.a1.to_string()).await);

    // a suspended member is refused (403), not answered an empty 200 or a 404.
    let (status, _) = get(&http, &items_url(&base, w.ws), &erin).await;
    assert_eq!(status, 200);
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(w.erin.id)
        .execute(&su)
        .await
        .expect("suspend");
    for (method, target, body) in [
        (reqwest::Method::GET, items_url(&base, w.ws), None),
        (
            reqwest::Method::PATCH,
            url.clone(),
            Some(json!({"body": "정지된 사람의 본문"})),
        ),
        (reqwest::Method::DELETE, url.clone(), None),
    ] {
        let (status, _) = send(&http, method.clone(), &target, &erin, body).await;
        assert_eq!(status, 403, "{method} as a suspended member");
    }

    // the definer functions themselves: a BYPASSRLS login (momo_worker, even after SET ROLE
    // momo_memory) cannot act as anyone — the session_user guard.
    let as_worker = |sql: String| {
        let worker = worker.clone();
        let (ws, member) = (w.ws, w.bob.id);
        async move {
            let mut tx = worker.begin().await.expect("begin");
            sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)")
                .bind(ws.to_string())
                .bind(member.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let r = sqlx::query_scalar::<_, String>(&sql)
                .fetch_one(&mut *tx)
                .await;
            tx.rollback().await.ok();
            r.map_err(|e| match e {
                sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
                other => format!("non-db {other}"),
            })
        }
    };
    assert_eq!(
        as_worker(format!(
            "SELECT mem_edit_item('{}', 'x 워커가 쓴 본문')::text",
            w.a1
        ))
        .await,
        Err("42501".to_string())
    );
    assert_eq!(
        as_worker(format!("SELECT mem_forget_item('{}')::text", w.a1)).await,
        Err("42501".to_string())
    );
    // momo_app without a bound member acts as nobody.
    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(w.ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let r = sqlx::query_scalar::<_, String>(&format!("SELECT mem_forget_item('{}')::text", w.a1))
        .fetch_one(&mut *tx)
        .await;
    assert!(
        matches!(&r, Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("42501")),
        "{r:?}"
    );
    tx.rollback().await.ok();
    assert!(item_row_exists(&su, &w.a1.to_string()).await);
}

// -- sabotage ---------------------------------------------------------------------------------

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

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn each_new_guard_is_load_bearing() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let app = momo_app_pool(2).await;
    // Every sabotage queues its own undo; `guarded` runs the queue even when a case panics.
    guarded(&su.clone(), guard_cases(su, worker, app, w)).await;
}

async fn guard_cases(su: PgPool, worker: PgPool, app: PgPool, w: World) {
    let edit_sig = "public.mem_edit_item(uuid, text, text)";
    let forget_sig = "public.mem_forget_item(uuid)";
    let new_text = "가드 시험용 새 본문 zebraquartz";
    let edit_as = |member: Uuid, item: Uuid, body: &str| {
        format!("SELECT mem_edit_item('{item}', '{body}')::text")
            .replace("{member}", &member.to_string())
    };

    // (label, signature, [(from, to)], scenario sql, member, expected refusal, what the sabotage lets through)
    struct Case<'a> {
        label: &'a str,
        signature: &'a str,
        edits: Vec<(&'a str, &'a str)>,
        sql: String,
        member: Uuid,
        refused: &'a str,
    }
    let cases = vec![
        Case {
            label: "edit: reader check (a non-reader edits a hidden item)",
            signature: edit_sig,
            edits: vec![
                (
                    "NOT public.mem_item_readable_by(p_item_id, v_actor)",
                    "false",
                ),
                ("NOT public.mem_item_readable_by(o.id, v_actor)", "false"),
            ],
            sql: edit_as(w.carol.id, w.a2, new_text),
            member: w.carol.id,
            refused: "P0002",
        },
        Case {
            label: "edit: multi-channel evidence (a reader of one evidence channel edits)",
            signature: edit_sig,
            edits: vec![
                (
                    "NOT public.mem_item_readable_by(p_item_id, v_actor)",
                    "false",
                ),
                ("NOT public.mem_item_readable_by(o.id, v_actor)", "false"),
            ],
            sql: edit_as(w.bob.id, w.multi, new_text),
            member: w.bob.id,
            refused: "P0002",
        },
        Case {
            label: "edit: acting member must be an active human",
            signature: edit_sig,
            edits: vec![("m.kind = 'human'", "true")],
            sql: edit_as(w.agent, w.a2, new_text),
            member: w.agent,
            refused: "42501",
        },
        Case {
            label: "edit: secret-shaped text",
            signature: edit_sig,
            edits: vec![("public.mem_looks_like_secret(v_body)", "false")],
            sql: edit_as(
                w.bob.id,
                w.a2,
                "토큰 sk-abcdefghijklmnopqrstuvwxyz123456 기록",
            ),
            member: w.bob.id,
            refused: "23514",
        },
        Case {
            label: "edit: nothing changed",
            signature: edit_sig,
            edits: vec![(
                "v_kind = o.kind AND v_body = pg_catalog.btrim(o.body)",
                "false",
            )],
            sql: edit_as(w.bob.id, w.a2, A2_BODY),
            member: w.bob.id,
            refused: "22023",
        },
        Case {
            label: "forget: reader check",
            signature: forget_sig,
            edits: vec![
                (
                    "NOT public.mem_item_readable_by(p_item_id, v_actor)",
                    "false",
                ),
                (
                    "NOT FOUND OR NOT public.mem_item_readable_by(o.id, v_actor)",
                    "NOT FOUND",
                ),
            ],
            sql: format!("SELECT mem_forget_item('{}')::text", w.a2),
            member: w.carol.id,
            refused: "P0002",
        },
        Case {
            label: "forget: acting member must be an active human",
            signature: forget_sig,
            edits: vec![("m.kind = 'human'", "true")],
            sql: format!("SELECT mem_forget_item('{}')::text", w.a2),
            member: w.agent,
            refused: "42501",
        },
    ];
    // agent must read p1 for the human-check cases to reach that guard rather than the reader wall.
    join(&su, w.ws, w.p1, w.agent, "member").await;

    for case in cases {
        let refused = as_member(&app, w.ws, case.member, &case.sql).await;
        assert_eq!(
            refused,
            Err(case.refused.to_string()),
            "shipped: {}",
            case.label
        );
        let original = sabotage(&su, case.signature, &case.edits).await;
        let leaked = as_member(&app, w.ws, case.member, &case.sql).await;
        restore(&su, &original).await;
        println!(
            "RED [{}]: shipped -> SQLSTATE {}; sabotaged -> {:?}",
            case.label, case.refused, leaked
        );
        assert!(
            leaked.is_ok(),
            "{}: with the guard removed the call must go through (else the guard is decorative): {leaked:?}",
            case.label
        );
        // and the restored function refuses again
        assert_eq!(
            as_member(&app, w.ws, case.member, &case.sql).await,
            Err(case.refused.to_string()),
            "restored: {}",
            case.label
        );
    }

    // edit: retired versions are not editable (55000) — remove the check and a fork appears.
    let first = as_member(
        &app,
        w.ws,
        w.bob.id,
        &edit_as(w.bob.id, w.a3, "새 판 leopardnut 문구"),
    )
    .await;
    assert!(first.is_ok());
    // (as_member rolls back, so retire a3 for real to set the scene)
    sqlx::query("UPDATE mem_item SET retired_at = now(), retired_reason = 'edited' WHERE id = $1")
        .bind(w.a3)
        .execute(&su)
        .await
        .unwrap();
    let sql = edit_as(w.bob.id, w.a3, "포크가 될 leopardnut 문구");
    assert_eq!(
        as_member(&app, w.ws, w.bob.id, &sql).await,
        Err("55000".to_string())
    );
    let original = sabotage(
        &su,
        edit_sig,
        &[("IF o.retired_at IS NOT NULL THEN", "IF false THEN")],
    )
    .await;
    let forked = as_member(&app, w.ws, w.bob.id, &sql).await;
    restore(&su, &original).await;
    println!("RED [edit: retired version]: shipped -> 55000; sabotaged -> {forked:?}");
    assert!(forked.is_ok(), "{forked:?}");

    // forget: a version that has a successor is refused (409) — remove it and the old version is
    // deleted alone, leaving the successor with a dangling chain.
    let head: Uuid = {
        // make a real successor: edit through a committed tx on the app pool
        let mut tx = app.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)")
            .bind(w.ws.to_string())
            .bind(w.bob.id.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let id: Uuid = sqlx::query_scalar("SELECT mem_edit_item($1, '온콜 mangoplume 확정 문구')")
            .bind(w.a2)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        id
    };
    let sql = format!("SELECT mem_forget_item('{}')::text", w.a2);
    assert_eq!(
        as_member(&app, w.ws, w.bob.id, &sql).await,
        Err("55000".to_string())
    );
    let original = sabotage(
        &su,
        forget_sig,
        &[(
            "IF EXISTS (SELECT 1 FROM public.mem_item s WHERE s.supersedes_id = o.id AND s.workspace_id = v_ws) THEN",
            "IF false THEN",
        )],
    )
    .await;
    let alone = as_member(&app, w.ws, w.bob.id, &sql).await;
    restore(&su, &original).await;
    println!("RED [forget: newer version exists]: shipped -> 55000; sabotaged -> {alone:?} (head {head} would dangle)");
    assert!(alone.is_ok());

    // forget: the whole chain goes — sabotage the chain walk and an older body survives.
    let chain_sql = format!("SELECT mem_forget_item('{head}')::text");
    let original = sabotage(
        &su,
        forget_sig,
        &[(
            "DELETE FROM public.mem_item i WHERE i.id = ANY (v_all)",
            "DELETE FROM public.mem_item i WHERE i.id = o.id",
        )],
    )
    .await;
    let mut tx = app.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(w.ws.to_string())
    .bind(w.bob.id.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    let removed: String = sqlx::query_scalar(&chain_sql)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    restore(&su, &original).await;
    let survivor = item_row_exists(&su, &w.a2.to_string()).await;
    println!("RED [forget: whole version chain]: sabotaged forget returned {removed}, the older version still exists = {survivor}");
    assert!(
        survivor,
        "with the chain purge removed an older version's text survives"
    );

    // session_user guard: with it removed a BYPASSRLS login acts as any member.
    let as_worker_sql = format!("SELECT mem_forget_item('{}')::text", w.a3);
    let run_as_worker = || {
        let worker = worker.clone();
        let (ws, member) = (w.ws, w.bob.id);
        let sql = as_worker_sql.clone();
        async move {
            let mut tx = worker.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)")
                .bind(ws.to_string())
                .bind(member.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let r = sqlx::query_scalar::<_, String>(&sql)
                .fetch_one(&mut *tx)
                .await;
            tx.rollback().await.ok();
            r.map_err(|e| match e {
                sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
                other => format!("{other}"),
            })
        }
    };
    assert_eq!(run_as_worker().await, Err("42501".to_string()));
    let original = sabotage(
        &su,
        forget_sig,
        &[("session_user::text <> 'momo_app'", "false")],
    )
    .await;
    let acted = run_as_worker().await;
    restore(&su, &original).await;
    println!(
        "RED [forget: session_user guard]: shipped -> 42501; sabotaged momo_worker -> {acted:?}"
    );
    assert!(acted.is_ok());
    let original = sabotage(
        &su,
        edit_sig,
        &[("session_user::text <> 'momo_app'", "false")],
    )
    .await;
    let acted = {
        let mut tx = worker.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)")
            .bind(w.ws.to_string())
            .bind(w.bob.id.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let r = sqlx::query_scalar::<_, Uuid>(&format!(
            "SELECT mem_edit_item('{}', '워커가 쓴 leopardnut 본문')",
            w.a1
        ))
        .fetch_one(&mut *tx)
        .await;
        tx.rollback().await.ok();
        r
    };
    restore(&su, &original).await;
    println!("RED [edit: session_user guard]: sabotaged momo_worker edit -> {acted:?}");
    assert!(acted.is_ok());

    // evidence copy: without it the new item has no evidence and the read rule hides it.
    let original = sabotage(
        &su,
        edit_sig,
        &[(
            "GET DIAGNOSTICS v_ins = ROW_COUNT;",
            "v_ins := v_n; DELETE FROM public.mem_evidence WHERE item_id = v_id;",
        )],
    )
    .await;
    let mut tx = app.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(w.ws.to_string())
    .bind(w.bob.id.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    let bare: Uuid = sqlx::query_scalar("SELECT mem_edit_item($1, '증거 없는 leopardnut 판')")
        .bind(w.a1)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let visible: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM mem_item WHERE id = $1)")
        .bind(bare)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.ok();
    restore(&su, &original).await;
    println!("RED [edit: evidence copy]: without the copy the new item is visible to its editor = {visible}");
    assert!(
        !visible,
        "an item without its evidence is hidden by the read rule (and never useful)"
    );
    let good = as_member(
        &app,
        w.ws,
        w.bob.id,
        &edit_as(w.bob.id, w.a1, "증거가 이어진 leopardnut 판"),
    )
    .await;
    assert!(good.is_ok(), "restored edit works: {good:?}");

    // ---- review round (PR #3209) ------------------------------------------------------------
    // M-2: a *dead* identical item (its source message was deleted) must not block an edit — the
    // edit marks it stale and goes on. Sabotage the liveness test and the edit is wrongly refused.
    let (dead_y, dead_msgs) = seed_item(
        &su,
        &worker,
        w.ws,
        w.p1,
        w.alice.id,
        "fact",
        "죽은 항목 dragonpear 사실 기록",
        1,
    )
    .await;
    sqlx::query("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = $1")
        .bind(dead_msgs[0].0)
        .execute(&su)
        .await
        .unwrap();
    let (editee, _) = seed_item(
        &su,
        &worker,
        w.ws,
        w.p1,
        w.alice.id,
        "fact",
        "고칠 대상 항목 cranberrydust 기록",
        1,
    )
    .await;
    let to_dead_text = edit_as(w.bob.id, editee, "죽은 항목 dragonpear 사실 기록");
    assert!(
        as_member(&app, w.ws, w.bob.id, &to_dead_text).await.is_ok(),
        "shipped: a dead twin does not block the edit"
    );
    let original = sabotage(
        &su,
        edit_sig,
        &[("IF public.mem_item_live(v_twin) THEN", "IF true THEN")],
    )
    .await;
    let blocked = as_member(&app, w.ws, w.bob.id, &to_dead_text).await;
    restore(&su, &original).await;
    println!("RED [edit: dead twin]: shipped -> Ok; sabotaged (liveness ignored) -> {blocked:?}");
    assert_eq!(blocked, Err("22023".to_string()));
    let _ = dead_y;

    // M-1: forget removes stale / retired twins of the same text; sabotage the twin sweep and the
    // dead twin's body stays in the table.
    let twin_case = |label: &'static str| {
        let (su, worker, app) = (su.clone(), worker.clone(), app.clone());
        let (ws, p1, alice, bob) = (w.ws, w.p1, w.alice.id, w.bob.id);
        async move {
            let (x, _) = seed_item(
                &su,
                &worker,
                ws,
                p1,
                alice,
                "fact",
                &format!("쌍둥이 시험 {label} raspberrylime"),
                1,
            )
            .await;
            sqlx::query(
                "INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, origin, body, valid_from, \
                 content_hash, extractor_version, source_count, stale) \
                 SELECT workspace_id, space_kind, channel_id, kind, origin, body, valid_from, content_hash, \
                        'twin', source_count, true FROM mem_item WHERE id = $1",
            )
            .bind(x)
            .execute(&su)
            .await
            .unwrap();
            let mut tx = app.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)")
                .bind(ws.to_string())
                .bind(bob.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let removed: i32 = sqlx::query_scalar("SELECT mem_forget_item($1)")
                .bind(x)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
            let left: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM mem_item WHERE workspace_id = $1 AND body LIKE $2",
            )
            .bind(ws)
            .bind(format!("%{label}%"))
            .fetch_one(&su)
            .await
            .unwrap();
            (removed, left)
        }
    };
    assert_eq!(twin_case("shipped").await, (2, 0));
    let original = sabotage(
        &su,
        forget_sig,
        &[("AND (t.stale OR t.retired_at IS NOT NULL)", "AND false")],
    )
    .await;
    let (removed, left) = twin_case("sabotaged").await;
    restore(&su, &original).await;
    println!("RED [forget: dead twins]: shipped -> (2 removed, 0 bodies left); sabotaged -> ({removed} removed, {left} bodies left)");
    assert_eq!((removed, left), (1, 1));

    // M-5: forget then re-extract the same text. Sabotage the trigger, then the suppress insert.
    let reextract = |label: &'static str| {
        let (su, worker, app) = (su.clone(), worker.clone(), app.clone());
        let (ws, p1, alice, bob) = (w.ws, w.p1, w.alice.id, w.bob.id);
        async move {
            let body = format!("재추출 시험 {label} blueberrymoss 결정");
            let (x, _) = seed_item(&su, &worker, ws, p1, alice, "decision", &body, 1).await;
            let mut tx = app.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)")
                .bind(ws.to_string())
                .bind(bob.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query_scalar::<_, i32>("SELECT mem_forget_item($1)")
                .bind(x)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
            let m = seed_message(&su, ws, p1, alice).await;
            let d = worker_digest(&worker, ws, p1, m.1, m.1, &[m.0])
                .await
                .unwrap();
            worker_item_try(&worker, ws, d, "decision", &body, &[m.0]).await
        }
    };
    assert_eq!(
        reextract("shipped").await,
        None,
        "a forgotten text is not re-created"
    );
    register_restore(
        "DROP TRIGGER IF EXISTS mem_item_suppressed ON mem_item; \
         CREATE TRIGGER mem_item_suppressed BEFORE INSERT ON mem_item \
         FOR EACH ROW EXECUTE FUNCTION mem_item_suppressed_guard();"
            .to_string(),
    );
    sqlx::raw_sql("DROP TRIGGER mem_item_suppressed ON mem_item")
        .execute(&su)
        .await
        .unwrap();
    let recreated = reextract("no-trigger").await;
    restore_all(&su).await;
    println!("RED [suppress: trigger]: shipped -> None; trigger dropped -> {recreated:?}");
    assert!(recreated.is_some());
    let original = sabotage(
        &su,
        forget_sig,
        &[(
            "ON CONFLICT DO NOTHING;",
            "AND false ON CONFLICT DO NOTHING;",
        )],
    )
    .await;
    let recreated = reextract("no-record").await;
    restore(&su, &original).await;
    println!(
        "RED [suppress: forget records the hash]: sabotaged forget -> re-extraction {recreated:?}"
    );
    assert!(recreated.is_some());

    // M-6: guests read but do not change memory (channel guest and workspace guest).
    let (g_item, _) = seed_item(
        &su,
        &worker,
        w.ws,
        w.p1,
        w.alice.id,
        "fact",
        "손님 시험 항목 gooseberrybark 기록",
        1,
    )
    .await;
    let chan_guest = seed_human(&su, w.ws, "member").await;
    join(&su, w.ws, w.p1, chan_guest.id, "guest").await;
    let ws_guest = seed_human(&su, w.ws, "guest").await;
    join(&su, w.ws, w.p1, ws_guest.id, "member").await;
    for guest in [chan_guest.id, ws_guest.id] {
        let e = edit_as(guest, g_item, "손님이 고친 본문 kiwifern");
        let f = format!("SELECT mem_forget_item('{}')::text", g_item);
        assert_eq!(
            as_member(&app, w.ws, guest, &e).await,
            Err("42501".to_string())
        );
        assert_eq!(
            as_member(&app, w.ws, guest, &f).await,
            Err("42501".to_string())
        );
    }
    for (sig, sql_for) in [(edit_sig, 0), (forget_sig, 1)] {
        let original = sabotage(
            &su,
            sig,
            &[
                ("ms.role = 'guest'", "false"),
                ("wm.role = 'guest'", "false"),
            ],
        )
        .await;
        let mut acted = Vec::new();
        for guest in [chan_guest.id, ws_guest.id] {
            let sql = if sql_for == 0 {
                edit_as(guest, g_item, "손님이 고친 본문 kiwifern")
            } else {
                format!("SELECT mem_forget_item('{}')::text", g_item)
            };
            acted.push(as_member(&app, w.ws, guest, &sql).await.is_ok());
        }
        restore(&su, &original).await;
        println!("RED [guest refusal, {sig}]: sabotaged -> channel guest acted = {}, workspace guest acted = {}", acted[0], acted[1]);
        assert_eq!(acted, vec![true, true]);
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn member_id_is_not_left_on_the_pooled_connection() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let pool = momo_app_pool(1).await;
    let base = start_server(pool.clone()).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;

    let (status, _) = get(&http, &items_url(&base, w.ws), &bob).await;
    assert_eq!(status, 200);
    let (status, _) = edit(
        &http,
        &base,
        w.ws,
        w.a2,
        &bob,
        json!({"body": "풀 시험용 mangoplume 문구"}),
    )
    .await;
    assert_eq!(status, 200);
    // refused writes (rolled back) must not leak it either
    let (status, _) = edit(
        &http,
        &base,
        w.ws,
        w.multi,
        &bob,
        json!({"body": "거부될 본문"}),
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = send(
        &http,
        reqwest::Method::DELETE,
        &item_url(&base, w.ws, w.personal),
        &bob,
        None,
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = edit(&http, &base, w.ws, w.a3, &bob, json!({"body": "   "})).await;
    assert_eq!(status, 422);

    let (member, workspace): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT current_setting('app.member_id', true), current_setting('app.workspace_id', true)",
    )
    .fetch_one(&pool)
    .await
    .expect("probe the pooled connection");
    assert!(
        member.as_deref().unwrap_or("").is_empty(),
        "app.member_id leaked onto the pooled connection: {member:?}"
    );
    assert!(
        workspace.as_deref().unwrap_or("").is_empty(),
        "app.workspace_id leaked: {workspace:?}"
    );
    // a second caller on the same single connection acts as themselves, not as bob
    let carol = login(&http, &base, w.ws, &w.carol.email).await;
    let (status, list) = get(&http, &items_url(&base, w.ws), &carol).await;
    assert_eq!(status, 200);
    assert!(
        item_ids(&list).is_empty(),
        "carol must not inherit bob's reads"
    );
    let _ = (&w.outsider, &w.ws_b, &w.dm);
}

// ---------------------------------------------------------------------------
// review round (PR #3209): M-1..M-6, L-1, L-4
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn forget_sweeps_dead_twins_and_suppresses_reextraction() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let app = momo_app_pool(2).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;

    // X plus two dead twins of the same text: a stale one and a retired one (M-1).
    let text = "잊을 항목 raspberrylime 결정 기록";
    let (x, _) = seed_item(&su, &worker, w.ws, w.p1, w.alice.id, "decision", text, 1).await;
    for (stale, retired) in [(true, false), (false, true)] {
        sqlx::query(
            "INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, origin, body, valid_from, \
             content_hash, extractor_version, source_count, stale, retired_at, retired_reason) \
             SELECT workspace_id, space_kind, channel_id, kind, origin, body, valid_from, content_hash, \
                    'twin', source_count, $2, CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN 'decayed' END \
               FROM mem_item WHERE id = $1",
        )
        .bind(x)
        .bind(stale)
        .bind(retired)
        .execute(&su)
        .await
        .expect("twin");
    }
    let (status, gone) = send(
        &http,
        reqwest::Method::DELETE,
        &item_url(&base, w.ws, x),
        &bob,
        None,
    )
    .await;
    assert_eq!(
        (status, &gone["forgottenCount"]),
        (200, &json!(3)),
        "{gone}"
    );
    let bodies: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM mem_item WHERE workspace_id = $1 AND body LIKE '%raspberrylime%'",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        bodies, 0,
        "no body of the forgotten text stays in the DB (D10)"
    );

    // M-5: only a hash is remembered; re-extraction skips it, other text is unaffected.
    let (hash_rows, ws_rows): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE workspace_id = $1) FROM mem_suppress WHERE workspace_id = $1",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!((hash_rows, ws_rows), (1, 1));
    let cols: Vec<String> = sqlx::query_scalar(
        "SELECT column_name::text FROM information_schema.columns WHERE table_name = 'mem_suppress' ORDER BY 1",
    )
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        cols,
        ["channel_id", "content_hash", "created_at", "workspace_id"],
        "hash only, no text"
    );
    let m = seed_message(&su, w.ws, w.p1, w.alice.id).await;
    let d = worker_digest(&worker, w.ws, w.p1, m.1, m.1, &[m.0])
        .await
        .unwrap();
    assert_eq!(
        worker_item_try(&worker, w.ws, d, "decision", text, &[m.0]).await,
        None,
        "extraction skips a suppressed hash"
    );
    let m2 = seed_message(&su, w.ws, w.p1, w.alice.id).await;
    let d2 = worker_digest(&worker, w.ws, w.p1, m2.1, m2.1, &[m2.0])
        .await
        .unwrap();
    assert!(
        worker_item_try(
            &worker,
            w.ws,
            d2,
            "decision",
            "전혀 다른 새 결정 tangerinesalt",
            &[m2.0]
        )
        .await
        .is_some(),
        "other text is not suppressed"
    );
    // a person who deliberately writes the text again (curated edit) is not blocked.
    let (status, _) = edit(
        &http,
        &base,
        w.ws,
        w.a2,
        &bob,
        json!({"body": text, "kind": "decision"}),
    )
    .await;
    assert_eq!(status, 200, "a deliberate curated edit is exempt");

    // the API role sees and writes nothing in mem_suppress, whatever table grant it holds.
    let seen = as_member(
        &app,
        w.ws,
        w.bob.id,
        "SELECT count(*)::text FROM mem_suppress",
    )
    .await;
    assert!(
        matches!(seen.as_ref().map(String::as_str), Ok("0")) || seen == Err("42501".to_string()),
        "momo_app must not see suppression rows: {seen:?}"
    );
    let wrote = as_member(
        &app,
        w.ws,
        w.bob.id,
        &format!(
            "WITH i AS (INSERT INTO mem_suppress (workspace_id, channel_id, content_hash) \
             VALUES ('{}', '{}', 'x') RETURNING 1) SELECT count(*)::text FROM i",
            w.ws, w.p1
        ),
    )
    .await;
    assert_eq!(wrote, Err("42501".to_string()));
    // M-4: the two partial indexes exist.
    let idx: Vec<(String, String)> = sqlx::query_as(
        "SELECT indexname::text, indexdef FROM pg_indexes WHERE tablename = 'mem_item' \
           AND indexname IN ('mem_item_supersedes_idx', 'mem_item_merged_into_idx') ORDER BY 1",
    )
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(idx.len(), 2);
    assert!(
        idx[0].1.contains("merged_into_id IS NOT NULL")
            && idx[1].1.contains("supersedes_id IS NOT NULL"),
        "{idx:?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn editing_to_a_twins_text_reveals_nothing_and_a_dead_twin_gives_way() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;

    // live twins: one bob can read (a1's text) and one he cannot (the multi-channel item, same kind),
    // plus "unchanged" and a disallowed value: one generic 422 for all of them.
    let unchanged = edit(&http, &base, w.ws, w.a3, &bob, json!({"body": A3_BODY})).await;
    assert_eq!(unchanged.0, 422);
    let readable_twin = edit(
        &http,
        &base,
        w.ws,
        w.a3,
        &bob,
        json!({"body": A1_BODY, "kind": "decision"}),
    )
    .await;
    let hidden_twin = edit(
        &http,
        &base,
        w.ws,
        w.a3,
        &bob,
        json!({"body": MULTI_BODY, "kind": "fact"}),
    )
    .await;
    let disallowed = edit(
        &http,
        &base,
        w.ws,
        w.a3,
        &bob,
        json!({"body": "sk-abcdefghijklmnopqrstuvwxyz123456"}),
    )
    .await;
    assert_eq!(readable_twin, unchanged);
    assert_eq!(
        hidden_twin, unchanged,
        "a hidden identical item must look like any other refusal"
    );
    assert_eq!(disallowed, unchanged);
    assert!(item_row_exists(&su, &w.multi.to_string()).await);

    // a dead twin (its source message was deleted) is marked stale and the edit goes through.
    let dead_text = "죽은 항목 dragonpear 사실 기록";
    let (dead, msgs) = seed_item(&su, &worker, w.ws, w.p1, w.alice.id, "fact", dead_text, 1).await;
    sqlx::query("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = $1")
        .bind(msgs[0].0)
        .execute(&su)
        .await
        .unwrap();
    let (status, edited) = edit(&http, &base, w.ws, w.a2, &bob, json!({"body": dead_text})).await;
    assert_eq!(status, 200, "{edited}");
    let stale: bool = sqlx::query_scalar("SELECT stale FROM mem_item WHERE id = $1")
        .bind(dead)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(stale, "the dead twin was marked stale");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn guests_read_but_do_not_change_and_curated_items_name_their_editor() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;
    let chan_guest = seed_human(&su, w.ws, "member").await;
    join(&su, w.ws, w.p1, chan_guest.id, "guest").await;
    let ws_guest = seed_human(&su, w.ws, "guest").await;
    join(&su, w.ws, w.p1, ws_guest.id, "member").await;

    for guest in [&chan_guest, &ws_guest] {
        let token = login(&http, &base, w.ws, &guest.email).await;
        let (status, list) = get(&http, &items_url(&base, w.ws), &token).await;
        assert_eq!(status, 200);
        assert!(
            item_ids(&list).contains(&w.a2.to_string()),
            "guests read (RLS)"
        );
        assert_eq!(
            get(&http, &item_url(&base, w.ws, w.a2), &token).await.0,
            200
        );
        let (s, _) = edit(
            &http,
            &base,
            w.ws,
            w.a2,
            &token,
            json!({"body": "손님이 고친 본문 kiwifern"}),
        )
        .await;
        assert_eq!(s, 403, "a guest may not edit");
        let (s, _) = send(
            &http,
            reqwest::Method::DELETE,
            &item_url(&base, w.ws, w.a2),
            &token,
            None,
        )
        .await;
        assert_eq!(s, 403, "a guest may not forget");
        assert!(item_row_exists(&su, &w.a2.to_string()).await);
    }

    // the editor is named on curated items only.
    let (_, before) = get(&http, &item_url(&base, w.ws, w.a2), &bob).await;
    assert!(before["item"].get("editedByMemberId").is_none());
    let (status, edited) = edit(
        &http,
        &base,
        w.ws,
        w.a2,
        &bob,
        json!({"body": "밥이 고친 본문 kiwifern 확정"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(edited["item"]["editedByMemberId"], w.bob.id.to_string());
    assert!(edited["item"]["editedAtMs"].as_i64().unwrap() > 0);
    let new_id = Uuid::parse_str(edited["item"]["id"].as_str().unwrap()).unwrap();
    let (_, detail) = get(&http, &item_url(&base, w.ws, new_id), &bob).await;
    assert_eq!(detail["item"]["editedByMemberId"], w.bob.id.to_string());
    let (_, list) = get(&http, &items_url(&base, w.ws), &bob).await;
    let row = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == new_id.to_string())
        .unwrap();
    assert_eq!(row["editedByMemberId"], w.bob.id.to_string());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_the_functions_own_errors_are_mapped_and_nul_is_refused() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su, &worker).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;

    // L-4: NUL in the text is a 422 at the route (and in a search, a 400) — never a 500.
    let (s, _) = edit(
        &http,
        &base,
        w.ws,
        w.a2,
        &bob,
        json!({"body": "널\u{0}문자"}),
    )
    .await;
    assert_eq!(s, 422);
    let (s, _) = get(&http, &format!("{}?q=%00abc", items_url(&base, w.ws)), &bob).await;
    assert_eq!(s, 400);

    // L-1: a privilege regression makes the *database* say 42501 — that is a 500, not a 403.
    let (ws, a2, a3) = (w.ws, w.a2, w.a3);
    let (su2, base2, http2, bob2) = (su.clone(), base.clone(), http.clone(), bob.clone());
    guarded(&su, async move {
        register_restore(
            "GRANT UPDATE (retired_at, retired_reason) ON mem_item TO mem_definer; \
             GRANT DELETE ON mem_item TO mem_definer;"
                .to_string(),
        );
        sqlx::raw_sql("REVOKE UPDATE (retired_at, retired_reason) ON mem_item FROM mem_definer; REVOKE DELETE ON mem_item FROM mem_definer;")
            .execute(&su2)
            .await
            .unwrap();
        let (s, _) = edit(&http2, &base2, ws, a2, &bob2, json!({"body": "권한 회귀 시험 문구 lemonash"})).await;
        println!("RED [L-1 edit]: mem_definer lost UPDATE(retired_*) -> HTTP {s} (a mapped 42501 would be 403)");
        assert_eq!(s, 500, "an unmapped database 42501 stays a 500");
        let (s, _) = send(&http2, reqwest::Method::DELETE, &item_url(&base2, ws, a3), &bob2, None).await;
        println!("RED [L-1 forget]: mem_definer lost DELETE -> HTTP {s}");
        assert_eq!(s, 500);
    })
    .await;
    // restored: the writes work again.
    let (s, _) = edit(
        &http,
        &base,
        w.ws,
        w.a2,
        &bob,
        json!({"body": "권한 복구 뒤 문구 lemonash"}),
    )
    .await;
    assert_eq!(s, 200);
}
