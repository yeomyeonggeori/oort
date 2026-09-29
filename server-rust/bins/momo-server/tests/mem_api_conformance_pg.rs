//! #3164 / ADR-0196 — team-memory M1 API: digest + receipt reads and settings, over
//! HTTP against real Postgres as `momo_app`.
//!
//! The rows are seeded the way the summary worker (#3162) will write them: a
//! `momo_worker` connection that has done `SET ROLE momo_memory`, calling
//! `mem_apply_digest` / `mem_record_serving`. Everything the API returns is then
//! decided by the migration-100 RLS policies — these tests only prove that the
//! routes wire `app.member_id`, ask for the right rows, and map the policy denials.
//!
//! Red proofs:
//!   1. a channel reader sees the digest, with evidence message ids + seq
//!   2. a non-member gets an empty list (200, not 403) and a hidden digest is 404
//!   3. a digest whose evidence spans an unreadable channel is hidden; stale too
//!   4. a suspended member is refused (403)
//!   5. `sinceLastRead` anchors at the caller's cursor; keyset pagination
//!   6. the receipt: chip data for a reader, `withheldCount` for the requester only
//!   7. settings: non-admin workspace/channel writes are 403, an admin's flip the
//!      worker's switch, a member cannot touch another member's personal pause
//!   8. `app.member_id` is not left on the (single) pooled connection
//!
//! `#[ignore]` — needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15464/momo \
//!   cargo test -p momo-server --test mem_api_conformance_pg \
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

const TEST_JWT_SECRET: &str = "mem-api-conformance-signing-secret";
const TEST_PASSWORD: &str = "mem-api-test-password";

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
        .bind(format!("memapi-{id}"))
        .execute(su)
        .await
        .expect("workspace");
    id
}

async fn seed_human(su: &PgPool, ws: Uuid, role: &str) -> Human {
    let id = Uuid::new_v4();
    let handle = format!("h-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@memapi.test");
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
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, $3::channel_kind, $4, '', $5)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(format!("c-{}", &id.simple().to_string()[..10]))
    .bind(creator)
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

async fn worker_receipt(
    worker: &PgPool,
    ws: Uuid,
    run: Uuid,
    requester: Uuid,
    digests: &[Uuid],
    withheld: i32,
) {
    let mut tx = worker.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("ws guc");
    sqlx::query_scalar::<_, Uuid>(
        "SELECT mem_record_serving($1, $2, $3, '{}'::uuid[], $4, 6000, 900)",
    )
    .bind(run)
    .bind(requester)
    .bind(digests)
    .bind(withheld)
    .fetch_one(&mut *tx)
    .await
    .expect("mem_record_serving");
    tx.commit().await.expect("commit");
}

struct World {
    ws: Uuid,
    ws_b: Uuid,
    alice: Human,    // P1 + S1 member, requester of the run
    bob: Human,      // P1 only
    carol: Human,    // workspace member, no channel
    erin: Human,     // P1 member, suspended after login
    wsadmin: Human,  // workspace admin (not in S1)
    chadmin: Human,  // channel admin of P1
    outsider: Human, // other workspace
    p1: Uuid,
    s1: Uuid,
    m_p1: (Uuid, i64),
    m_p1_b: (Uuid, i64),
    m_s1: (Uuid, i64),
    run_p1: Uuid,
}

async fn build_world(su: &PgPool) -> World {
    let ws = seed_workspace(su).await;
    let ws_b = seed_workspace(su).await;
    let alice = seed_human(su, ws, "member").await;
    let bob = seed_human(su, ws, "member").await;
    let carol = seed_human(su, ws, "member").await;
    let erin = seed_human(su, ws, "member").await;
    let wsadmin = seed_human(su, ws, "admin").await;
    let chadmin = seed_human(su, ws, "member").await;
    let outsider = seed_human(su, ws_b, "member").await;
    let agent = seed_agent(su, ws, alice.id).await;
    let p1 = seed_channel(su, ws, "public", alice.id).await;
    let s1 = seed_channel(su, ws, "private", alice.id).await;
    for member in [&alice, &bob, &erin, &wsadmin] {
        join(su, ws, p1, member.id, "member").await;
    }
    join(su, ws, p1, chadmin.id, "admin").await;
    join(su, ws, s1, alice.id, "member").await;
    let m_p1 = seed_message(su, ws, p1, alice.id).await;
    let m_p1_b = seed_message(su, ws, p1, bob.id).await;
    let m_s1 = seed_message(su, ws, s1, alice.id).await;
    let run_p1 = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(run_p1)
    .bind(ws)
    .bind(agent)
    .bind(p1)
    .bind(m_p1.0)
    .execute(su)
    .await
    .expect("agent_run");
    World {
        ws,
        ws_b,
        alice,
        bob,
        carol,
        erin,
        wsadmin,
        chadmin,
        outsider,
        p1,
        s1,
        m_p1,
        m_p1_b,
        m_s1,
        run_p1,
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

async fn get(http: &reqwest::Client, url: &str, token: &str) -> (u16, Value) {
    let response = http.get(url).bearer_auth(token).send().await.expect("get");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn patch(http: &reqwest::Client, url: &str, token: &str, body: Value) -> (u16, Value) {
    let response = http
        .patch(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("patch");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn digests_url(base: &str, ws: Uuid, ch: Uuid) -> String {
    format!("{base}/v1/workspaces/{ws}/channels/{ch}/memory/digests")
}

fn digest_ids(body: &Value) -> Vec<String> {
    body["digests"]
        .as_array()
        .expect("digests array")
        .iter()
        .map(|d| d["id"].as_str().expect("id").to_string())
        .collect()
}

async fn settings_row_count(su: &PgPool, ws: Uuid, scope: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM mem_settings WHERE workspace_id = $1 AND scope = $2")
        .bind(ws)
        .bind(scope)
        .fetch_one(su)
        .await
        .expect("count settings")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn reads_are_decided_by_rls() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, w.ws, &w.alice.email).await;
    let bob = login(&http, &base, w.ws, &w.bob.email).await;
    let carol = login(&http, &base, w.ws, &w.carol.email).await;
    let erin = login(&http, &base, w.ws, &w.erin.email).await;
    let outsider = login(&http, &base, w.ws_b, &w.outsider.email).await;

    let d_p1 = worker_digest(
        &worker,
        w.ws,
        w.p1,
        w.m_p1.1,
        w.m_p1_b.1,
        &[w.m_p1.0, w.m_p1_b.0],
    )
    .await
    .expect("worker digest in P1");
    let d_s1 = worker_digest(&worker, w.ws, w.s1, w.m_s1.1, w.m_s1.1, &[w.m_s1.0])
        .await
        .expect("worker digest in S1");

    // 1. a reader sees the digest, with evidence links back to the source messages.
    let (status, body) = get(&http, &digests_url(&base, w.ws, w.p1), &bob).await;
    assert_eq!(status, 200);
    assert_eq!(digest_ids(&body), vec![d_p1.to_string()]);
    let digest = &body["digests"][0];
    assert_eq!(digest["channelId"], w.p1.to_string());
    assert_eq!(digest["level"], "window");
    assert_eq!(digest["sourceCount"], 2);
    let evidence: Vec<(String, i64)> = digest["evidence"]
        .as_array()
        .expect("evidence")
        .iter()
        .map(|e| {
            (
                e["messageId"].as_str().unwrap().to_string(),
                e["seq"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        evidence,
        vec![
            (w.m_p1.0.to_string(), w.m_p1.1),
            (w.m_p1_b.0.to_string(), w.m_p1_b.1)
        ]
    );
    let (status, one) = get(
        &http,
        &format!("{base}/v1/workspaces/{}/memory/digests/{d_p1}", w.ws),
        &bob,
    )
    .await;
    assert_eq!(
        (status, one["digest"]["id"].as_str()),
        (200, Some(d_p1.to_string().as_str()))
    );

    // 2. a non-member of the channel: an EMPTY list (200) — not 403, not a 404 that
    //    would confirm the channel exists — and the digest by id is a plain 404.
    for (label, token) in [("carol (no channel)", &carol), ("bob (not in S1)", &bob)] {
        let channel = if label.starts_with("carol") {
            w.p1
        } else {
            w.s1
        };
        let (status, body) = get(&http, &digests_url(&base, w.ws, channel), token).await;
        assert_eq!(status, 200, "{label}");
        assert_eq!(
            digest_ids(&body),
            Vec::<String>::new(),
            "{label} sees nothing"
        );
    }
    let (status, _) = get(
        &http,
        &format!("{base}/v1/workspaces/{}/memory/digests/{d_s1}", w.ws),
        &bob,
    )
    .await;
    assert_eq!(status, 404, "a digest the policy hides is a 404");
    let (status, _) = get(
        &http,
        &format!(
            "{base}/v1/workspaces/{}/memory/digests/{}",
            w.ws,
            Uuid::new_v4()
        ),
        &bob,
    )
    .await;
    assert_eq!(status, 404, "a missing digest looks the same");
    // another tenant's token cannot address this workspace at all.
    let (status, _) = get(&http, &digests_url(&base, w.ws, w.p1), &outsider).await;
    assert_eq!(status, 403);
    // the S1 member does see S1's digest.
    let (_, body) = get(&http, &digests_url(&base, w.ws, w.s1), &alice).await;
    assert_eq!(digest_ids(&body), vec![d_s1.to_string()]);

    // 3. multi-channel evidence with one unreadable channel is hidden as a whole.
    //    (`mem_apply_digest` refuses cross-channel evidence, so plant it as a superuser —
    //    the read policy is the second wall.) Alice reads both channels; bob only P1.
    let cross = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO mem_digest (id, workspace_id, channel_id, level, from_seq, to_seq, body, \
         source_count, prompt_version) VALUES ($1, $2, $3, 'window', 90, 90, 'cross', 2, 'v1')",
    )
    .bind(cross)
    .bind(w.ws)
    .bind(w.p1)
    .execute(&su)
    .await
    .expect("cross digest");
    for (message, channel) in [(w.m_p1.0, w.p1), (w.m_s1.0, w.s1)] {
        sqlx::query(
            "INSERT INTO mem_evidence (workspace_id, digest_id, message_id, channel_id) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(w.ws)
        .bind(cross)
        .bind(message)
        .bind(channel)
        .execute(&su)
        .await
        .expect("cross evidence");
    }
    let (_, as_bob) = get(&http, &digests_url(&base, w.ws, w.p1), &bob).await;
    assert!(
        !digest_ids(&as_bob).contains(&cross.to_string()),
        "bob cannot read S1 evidence"
    );
    let (_, as_alice) = get(&http, &digests_url(&base, w.ws, w.p1), &alice).await;
    assert!(
        digest_ids(&as_alice).contains(&cross.to_string()),
        "alice can read both"
    );
    // stale rows are hidden until regenerated.
    sqlx::query("UPDATE mem_digest SET stale = true WHERE id = $1")
        .bind(d_p1)
        .execute(&su)
        .await
        .expect("stale");
    let (_, as_bob) = get(&http, &digests_url(&base, w.ws, w.p1), &bob).await;
    assert!(
        !digest_ids(&as_bob).contains(&d_p1.to_string()),
        "stale digest is hidden"
    );

    // 4. a suspended member is refused (403), not answered an empty 200.
    let (status, _) = get(&http, &digests_url(&base, w.ws, w.p1), &erin).await;
    assert_eq!(status, 200, "erin reads while active");
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(w.erin.id)
        .execute(&su)
        .await
        .expect("suspend");
    let (status, _) = get(&http, &digests_url(&base, w.ws, w.p1), &erin).await;
    assert_eq!(status, 403, "a suspended member is refused");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn since_last_read_and_pagination() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;

    // three windows in P1: seq 10, 11, 12 (a message per window)
    let mut ids = Vec::new();
    let mut seqs = Vec::new();
    for _ in 0..3 {
        let (message, seq) = seed_message(&su, w.ws, w.p1, w.alice.id).await;
        let digest = worker_digest(&worker, w.ws, w.p1, seq, seq, &[message])
            .await
            .expect("digest");
        ids.push(digest.to_string());
        seqs.push(seq);
    }
    // bob has read up to the first of them.
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(w.ws)
    .bind(w.p1)
    .bind(w.bob.id)
    .bind(seqs[0])
    .execute(&su)
    .await
    .expect("read_state");

    let url = format!("{}?sinceLastRead=true", digests_url(&base, w.ws, w.p1));
    let (status, body) = get(&http, &url, &bob).await;
    assert_eq!(status, 200);
    assert_eq!(body["afterSeq"], seqs[0]);
    // newest first, and only what reaches past his cursor
    assert_eq!(digest_ids(&body), vec![ids[2].clone(), ids[1].clone()]);

    // keyset pagination: limit=1 walks newest -> oldest without repeats
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..4 {
        let mut url = format!("{}?limit=1", digests_url(&base, w.ws, w.p1));
        if let Some(c) = &cursor {
            url.push_str(&format!("&cursor={c}"));
        }
        let (status, page) = get(&http, &url, &bob).await;
        assert_eq!(status, 200);
        seen.extend(digest_ids(&page));
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let expected: Vec<String> = ids.iter().rev().cloned().collect();
    assert_eq!(seen, expected);

    let (status, _) = get(
        &http,
        &format!("{}?cursor=garbage", digests_url(&base, w.ws, w.p1)),
        &bob,
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = get(
        &http,
        &format!("{}?level=year", digests_url(&base, w.ws, w.p1)),
        &bob,
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn receipt_gives_the_chip_and_withheld_count_only_to_the_requester() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, w.ws, &w.alice.email).await;
    let bob = login(&http, &base, w.ws, &w.bob.email).await;
    let carol = login(&http, &base, w.ws, &w.carol.email).await;

    let d = worker_digest(
        &worker,
        w.ws,
        w.p1,
        w.m_p1.1,
        w.m_p1_b.1,
        &[w.m_p1.0, w.m_p1_b.0],
    )
    .await
    .expect("digest");
    worker_receipt(&worker, w.ws, w.run_p1, w.alice.id, &[d], 2).await;
    let url = format!(
        "{base}/v1/workspaces/{}/agent-runs/{}/memory-receipt",
        w.ws, w.run_p1
    );

    // the requester (trigger message author) sees the count.
    let (status, body) = get(&http, &url, &alice).await;
    assert_eq!(status, 200);
    let receipt = &body["receipt"];
    assert_eq!(receipt["servedCount"], 1);
    assert_eq!(receipt["digestIds"], json!([d.to_string()]));
    assert_eq!(receipt["withheldCount"], 2);
    assert_eq!(receipt["budgetChars"], 6000);
    assert_eq!(
        receipt["digests"][0]["evidence"].as_array().unwrap().len(),
        2
    );
    // another reader of the channel sees the chip but NOT the withheld count.
    let (status, body) = get(&http, &url, &bob).await;
    assert_eq!(status, 200);
    assert_eq!(body["receipt"]["servedCount"], 1);
    assert!(
        body["receipt"].get("withheldCount").is_none(),
        "count is requester-only"
    );
    // a non-member of the answer channel: 404.
    let (status, _) = get(&http, &url, &carol).await;
    assert_eq!(status, 404);
    // a run without a receipt: 404.
    let (status, _) = get(
        &http,
        &format!(
            "{base}/v1/workspaces/{}/agent-runs/{}/memory-receipt",
            w.ws,
            Uuid::new_v4()
        ),
        &alice,
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn settings_writes_are_authorized_by_rls() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker = worker_pool().await;
    let w = build_world(&su).await;
    let base = start_server(momo_app_pool(4).await).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, w.ws, &w.alice.email).await;
    let bob = login(&http, &base, w.ws, &w.bob.email).await;
    let carol = login(&http, &base, w.ws, &w.carol.email).await;
    let wsadmin = login(&http, &base, w.ws, &w.wsadmin.email).await;
    let chadmin = login(&http, &base, w.ws, &w.chadmin.email).await;
    let ws_url = format!("{base}/v1/workspaces/{}/memory/settings", w.ws);
    let me_url = format!("{ws_url}/me");
    let ch_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/memory/settings",
        w.ws, w.p1
    );

    // defaults with no rows
    let (status, body) = get(&http, &ws_url, &bob).await;
    assert_eq!(status, 200);
    assert_eq!(body["workspace"]["enabled"], true);
    assert_eq!(body["workspace"]["paused"], false);
    assert_eq!(body["workspace"]["resetEpoch"], 0);
    assert_eq!(body["me"]["paused"], false);

    // workspace switch: a plain member is 403 and leaves no row; the admin flips it.
    let (status, _) = patch(&http, &ws_url, &bob, json!({"enabled": false})).await;
    assert_eq!(status, 403, "non-admin cannot change the workspace switch");
    assert_eq!(settings_row_count(&su, w.ws, "workspace").await, 0);
    let (status, _) = patch(&http, &ws_url, &wsadmin, json!({})).await;
    assert_eq!(status, 400, "an empty patch is a 400");
    let (status, body) = patch(&http, &ws_url, &wsadmin, json!({"enabled": false})).await;
    assert_eq!((status, &body["enabled"]), (200, &json!(false)));
    let (_, body) = get(&http, &ws_url, &bob).await;
    assert_eq!(
        body["workspace"]["enabled"], false,
        "everyone reads the switch"
    );
    // a second write by a non-admin against the EXISTING row is also 403 (upsert path).
    let (status, _) = patch(&http, &ws_url, &bob, json!({"enabled": true})).await;
    assert_eq!(status, 403);
    let still: bool = sqlx::query_scalar(
        "SELECT enabled FROM mem_settings WHERE workspace_id = $1 AND scope = 'workspace'",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(!still, "the row was not changed by the non-admin");
    // the switch reaches the worker: it refuses to record while disabled (55000).
    assert_eq!(
        worker_digest(&worker, w.ws, w.p1, w.m_p1.1, w.m_p1.1, &[w.m_p1.0]).await,
        Err("55000".to_string())
    );
    let (status, _) = patch(
        &http,
        &ws_url,
        &wsadmin,
        json!({"enabled": true, "paused": true}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        worker_digest(&worker, w.ws, w.p1, w.m_p1.1, w.m_p1.1, &[w.m_p1.0]).await,
        Err("55000".to_string()),
        "paused also stops the worker"
    );
    let (status, _) = patch(&http, &ws_url, &wsadmin, json!({"paused": false})).await;
    assert_eq!(status, 200);

    // channel exclude / pause: channel admin yes; plain member, non-member: 403.
    let (status, _) = patch(&http, &ch_url, &bob, json!({"excluded": true})).await;
    assert_eq!(status, 403);
    let (status, _) = patch(&http, &ch_url, &carol, json!({"excluded": true})).await;
    assert_eq!(
        status, 403,
        "a non-member gets 403 without learning the channel exists"
    );
    let nonexistent = format!(
        "{base}/v1/workspaces/{}/channels/{}/memory/settings",
        w.ws,
        Uuid::new_v4()
    );
    let (status, _) = patch(&http, &nonexistent, &wsadmin, json!({"excluded": true})).await;
    assert_eq!(
        status, 403,
        "a missing channel is indistinguishable from an unreadable one"
    );
    let (status, body) = patch(&http, &ch_url, &chadmin, json!({"excluded": true})).await;
    assert_eq!((status, &body["excluded"]), (200, &json!(true)));
    assert_eq!(body["channelId"], w.p1.to_string());
    assert_eq!(
        worker_digest(&worker, w.ws, w.p1, w.m_p1.1, w.m_p1.1, &[w.m_p1.0]).await,
        Err("55000".to_string()),
        "an excluded channel is refused by the worker"
    );
    let (_, body) = get(&http, &ws_url, &bob).await;
    assert_eq!(body["channels"][0]["channelId"], w.p1.to_string());
    assert_eq!(body["channels"][0]["excluded"], true);
    let (_, body) = get(&http, &ws_url, &carol).await;
    assert_eq!(
        body["channels"],
        json!([]),
        "a non-member does not see the channel's row"
    );
    let (status, _) = patch(&http, &ch_url, &chadmin, json!({"excluded": false})).await;
    assert_eq!(status, 200);
    assert!(
        worker_digest(&worker, w.ws, w.p1, w.m_p1.1, w.m_p1.1, &[w.m_p1.0])
            .await
            .is_ok()
    );

    // personal pause: self only. The body has no member field and rejects one.
    let (status, body) = patch(&http, &me_url, &bob, json!({"paused": true})).await;
    assert_eq!((status, &body["paused"]), (200, &json!(true)));
    let (status, _) = patch(
        &http,
        &me_url,
        &bob,
        json!({"paused": true, "memberId": w.alice.id.to_string()}),
    )
    .await;
    assert!(
        (400..500).contains(&status),
        "memberId is refused, got {status}"
    );
    assert_eq!(
        settings_row_count(&su, w.ws, "member").await,
        1,
        "only bob's row exists"
    );
    let (_, body) = get(&http, &ws_url, &alice).await;
    assert_eq!(
        body["me"]["paused"], false,
        "alice does not see (or share) bob's pause"
    );
    let (_, body) = get(&http, &ws_url, &bob).await;
    assert_eq!(body["me"]["paused"], true);
    // the audit trail records who changed what.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'memory.settings.updated'",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        audits >= 5,
        "each successful write is audited, got {audits}"
    );
}

/// The policy itself (not the route) refuses to let one member write another's row —
/// the API never names a member, so this is the wall behind that.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_cannot_write_another_members_personal_row() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = build_world(&su).await;
    let app = momo_app_pool(2).await;
    let mut tx = app.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(w.ws.to_string())
    .bind(w.bob.id.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    let outcome = sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, member_id, paused) VALUES ($1, 'member', $2, true)",
    )
    .bind(w.ws)
    .bind(w.alice.id)
    .execute(&mut *tx)
    .await;
    let code = match outcome {
        Err(sqlx::Error::Database(db)) => db.code().map(|c| c.to_string()),
        other => panic!("expected an RLS denial, got {other:?}"),
    };
    assert_eq!(code.as_deref(), Some("42501"));
}

/// `app.member_id` (and the tenant GUC) must not survive the transaction on a pooled
/// connection. One connection in the pool, real routes in between, then a probe on
/// that same connection.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn member_id_is_not_left_on_the_pooled_connection() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = build_world(&su).await;
    let pool = momo_app_pool(1).await;
    let base = start_server(pool.clone()).await;
    let http = reqwest::Client::new();
    let bob = login(&http, &base, w.ws, &w.bob.email).await;

    let (status, _) = get(&http, &digests_url(&base, w.ws, w.p1), &bob).await;
    assert_eq!(status, 200);
    let (status, _) = patch(
        &http,
        &format!("{base}/v1/workspaces/{}/memory/settings/me", w.ws),
        &bob,
        json!({"paused": true}),
    )
    .await;
    assert_eq!(status, 200);
    // a denied write (rolled back) must not leak it either.
    let (status, _) = patch(
        &http,
        &format!("{base}/v1/workspaces/{}/memory/settings", w.ws),
        &bob,
        json!({"enabled": false}),
    )
    .await;
    assert_eq!(status, 403);

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
}
