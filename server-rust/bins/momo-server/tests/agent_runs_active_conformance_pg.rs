//! DB-backed conformance for the workspace **"running now"** read —
//! `GET /v1/workspaces/{ws}/agent-runs?state=active&scope=mine|team`
//! (ADR-0200 증보 2026-10-15 R1, ADR-0202 D2, #3847).
//!
//! The read exists to answer "what is running, and how many at once per agent"
//! across the channels the reader is in — without becoming the workspace-wide
//! queue ADR-0200 D3 refused. Every test is written so the revert that matters
//! shows up as *someone seeing a run of a room they are not in*, or as a count
//! that silently depends on the page.
//!
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test agent_runs_active_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract identical to `agent_run_history_conformance_pg.rs`: fixtures
//! are written as superuser, the **server** runs on `momo_app` (NOBYPASSRLS).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `active_1_rows_are_the_readers_rooms_and_counts_span_them` | drop the membership join (the private / archived / left rooms' runs appear), drop `archived_at IS NULL`, or compute `activeTotal` from the visible rows |
//! | `active_2_counts_do_not_depend_on_the_page` | derive `agents[]` from the paged rows (`limit=1` shrinks `running` to 1), or drop the keyset (pages repeat) |
//! | `active_3_scope_mine_is_what_i_asked_for` | drop the requester predicate (someone else's run appears under `mine`) |
//! | `active_4_claimed_is_a_leased_queued_run` | count raw status only (`claimed` stays 0) |
//! | `active_5_refusals_and_tenants` | accept an unknown `state`/`scope`, answer an unseen cursor with a page, or leak another tenant's runs |
//! | `active_6_a_dm_run_is_its_two_peoples` | widen visibility beyond channel membership |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "issue-3847-running-now-conformance-secret";
const TEST_PASSWORD: &str = "issue-3847-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";

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

async fn role_pool(username: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username(username).password(password))
        .await
        .unwrap_or_else(|error| panic!("connect as {username} (bootstrap_roles.sql?): {error}"))
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

fn apply_bootstrap_roles() {
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
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
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

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@issue3847.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(human)
    .bind(workspace)
    .bind(display)
    .bind(human.to_string())
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(human)
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
    .bind(human)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (human, email)
}

async fn seed_channel(su: &PgPool, app: &PgPool, workspace: Uuid, creator: Uuid) -> Uuid {
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("i3847-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: creator,
        },
    )
    .await
    .expect("create channel")
    .id;
    // `create_channel` seeds the creator's membership; nothing else joins by
    // default, which is exactly the asymmetry these tests need.
    let _ = su;
    channel
}

async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid, handle: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 8, 50, $4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(AGENT_MODEL)
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
    .expect("seed agent workspace membership");
    agent
}

/// One run with an explicit age, so `(created_at, id)` order is decided by the
/// clock and not by the tie-break.
async fn seed_run(
    su: &PgPool,
    workspace: Uuid,
    agent: Uuid,
    channel: Uuid,
    status: &str,
    age_seconds: i64,
) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key, \
            started_at, finished_at, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7, \
                 CASE WHEN $5 = 'queued' THEN NULL \
                      ELSE now() - make_interval(secs => $8::double precision) END, \
                 CASE WHEN $5 IN ('succeeded','failed','timed_out','cancelled') THEN now() END, \
                 now() - make_interval(secs => $8::double precision), \
                 now() - make_interval(secs => $8::double precision))",
    )
    .bind(run)
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(status)
    .bind(json!({"type": "work", "title": format!("run {run}"), "brief": "b"}))
    .bind(format!("i3847:{run}"))
    .bind(age_seconds as f64)
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

/// The work-run requester record — the run has no requester column, so this audit
/// row is what `scope=mine` reads (the same source the team board reads).
async fn seed_work_requester(su: &PgPool, workspace: Uuid, run: Uuid, requester: Uuid) {
    sqlx::query(
        "INSERT INTO audit_log (workspace_id, actor_member_id, action, target_type, target_id, run_id) \
         VALUES ($1, $2, 'agent.work.queued', 'agent_run', $3, $3)",
    )
    .bind(workspace)
    .bind(requester)
    .bind(run)
    .execute(su)
    .await
    .expect("seed requester audit row");
}

/// A mention run: its requester is the author of the trigger message.
async fn seed_mention_run(
    su: &PgPool,
    workspace: Uuid,
    agent: Uuid,
    channel: Uuid,
    author: Uuid,
    age_seconds: i64,
) -> Uuid {
    let message = Uuid::new_v4();
    let seq: i64 =
        sqlx::query_scalar("SELECT COALESCE(max(seq), 0) + 1 FROM message WHERE channel_id = $1")
            .bind(channel)
            .fetch_one(su)
            .await
            .expect("next seq");
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', '@agent 해 줘')",
    )
    .bind(message)
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .execute(su)
    .await
    .expect("seed trigger message");
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, input, \
            idempotency_key, started_at, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, now(), \
                 now() - make_interval(secs => $8::double precision), \
                 now() - make_interval(secs => $8::double precision))",
    )
    .bind(run)
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(message)
    .bind(json!({"surface": "mention", "prompt": "해 줘"}))
    .bind(format!("i3847-mention:{run}"))
    .bind(age_seconds as f64)
    .execute(su)
    .await
    .expect("seed mention run");
    run
}

/// A pending delivery job for `run`, leased (live) or not.
async fn seed_job(
    su: &PgPool,
    workspace: Uuid,
    agent: Uuid,
    channel: Uuid,
    run: Uuid,
    leased: bool,
) {
    sqlx::query(
        "INSERT INTO outbox(workspace_id, kind, status, method, payload, partition_key, \
                            lease_owner, lease_acquired_at, lease_expires_at) \
         VALUES ($1, 'agent_job', 'pending', 'gateway', $2, $3, \
                 CASE WHEN $4 THEN uuidv7() END, \
                 CASE WHEN $4 THEN now() END, \
                 CASE WHEN $4 THEN now() + interval '10 minutes' END)",
    )
    .bind(workspace)
    .bind(json!({
        "agent_member_id": agent.to_string(),
        "run_id": run.to_string(),
        "channel_id": channel.to_string(),
    }))
    .bind(agent)
    .bind(leased)
    .execute(su)
    .await
    .expect("seed agent job");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

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
    assert_eq!(response.status(), 200, "the seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

async fn get(http: &reqwest::Client, base: &str, token: &str, path: &str) -> reqwest::Response {
    http.get(format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET")
}

async fn json_body(response: reqwest::Response) -> Value {
    response.json().await.expect("json body")
}

fn run_ids(page: &Value) -> Vec<Uuid> {
    page["runs"]
        .as_array()
        .unwrap_or_else(|| panic!("runs is an array in {page}"))
        .iter()
        .map(|run| Uuid::parse_str(run["id"].as_str().expect("id")).expect("uuid"))
        .collect()
}

fn agent_entry(page: &Value, agent: Uuid) -> Value {
    page["agents"]
        .as_array()
        .unwrap_or_else(|| panic!("agents is an array in {page}"))
        .iter()
        .find(|entry| {
            entry["agentMemberId"].as_str().map(str::to_lowercase) == Some(agent.to_string())
        })
        .cloned()
        .unwrap_or_else(|| panic!("agent {agent} listed in {page}"))
}

async fn active(http: &reqwest::Client, base: &str, token: &str, ws: Uuid, query: &str) -> Value {
    let response = get(
        http,
        base,
        token,
        &format!("/v1/workspaces/{ws}/agent-runs{query}"),
    )
    .await;
    assert_eq!(
        response.status(),
        200,
        "running-now read answers 200 for {query}"
    );
    json_body(response).await
}

struct Setup {
    su: PgPool,
    app: PgPool,
    base: String,
    http: reqwest::Client,
}

async fn setup() -> Setup {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool("momo_app", &momo_app_password()).await;
    let base = start_server(app.clone()).await;
    Setup {
        su,
        app,
        base,
        http: reqwest::Client::new(),
    }
}

// ---------------------------------------------------------------------------
// 1 — rows are the reader's rooms; activeTotal spans every room as a number
// ---------------------------------------------------------------------------

/// One agent runs in four rooms the reader is in → `running = 4`. The same agent
/// also runs in a private room, an archived room and a room the reader left:
/// none of those rows appear, and only `activeTotal` (a bare number) knows them.
/// A finished run in a visible room is not "running now".
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn active_1_rows_are_the_readers_rooms_and_counts_span_them() {
    let s = setup().await;
    let ws = seed_workspace(&s.su).await;
    let (owner, owner_email) = seed_human(&s.su, ws, "owner", "성재").await;
    let (peer, peer_email) = seed_human(&s.su, ws, "member", "동료").await;
    let agent = seed_agent(&s.su, ws, owner, "grokbot").await;

    let mut shared = Vec::new();
    for _ in 0..4 {
        let channel = seed_channel(&s.su, &s.app, ws, owner).await;
        join_channel(&s.su, ws, channel, peer).await;
        join_channel(&s.su, ws, channel, agent).await;
        shared.push(channel);
    }
    let private = seed_channel(&s.su, &s.app, ws, owner).await;
    let archived = seed_channel(&s.su, &s.app, ws, owner).await;
    join_channel(&s.su, ws, archived, peer).await;
    let left = seed_channel(&s.su, &s.app, ws, owner).await;
    join_channel(&s.su, ws, left, peer).await;

    let mut visible_runs = Vec::new();
    for (index, channel) in shared.iter().enumerate() {
        visible_runs
            .push(seed_run(&s.su, ws, agent, *channel, "running", 100 + index as i64).await);
    }
    let private_run = seed_run(&s.su, ws, agent, private, "running", 50).await;
    let archived_run = seed_run(&s.su, ws, agent, archived, "running", 51).await;
    let left_run = seed_run(&s.su, ws, agent, left, "running", 52).await;
    let finished = seed_run(&s.su, ws, agent, shared[0], "succeeded", 10).await;

    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(archived)
        .execute(&s.su)
        .await
        .expect("archive channel");
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(left)
        .bind(peer)
        .execute(&s.su)
        .await
        .expect("leave channel");

    let peer_token = login(&s.http, &s.base, ws, &peer_email).await;
    let page = active(&s.http, &s.base, &peer_token, ws, "?state=active").await;
    let mut got = run_ids(&page);
    got.sort();
    let mut want = visible_runs.clone();
    want.sort();
    assert_eq!(
        got, want,
        "exactly the four runs of the reader's rooms: {page}"
    );
    for hidden in [private_run, archived_run, left_run, finished] {
        assert!(!got.contains(&hidden), "{hidden} must not be listed");
        assert!(
            !page
                .to_string()
                .to_lowercase()
                .contains(&hidden.to_string()),
            "{hidden} is named nowhere in the body"
        );
    }
    for hidden_room in [private, archived, left] {
        assert!(
            !page
                .to_string()
                .to_lowercase()
                .contains(&hidden_room.to_string()),
            "room {hidden_room} is named nowhere"
        );
    }
    for row in page["runs"].as_array().unwrap() {
        assert_eq!(row["phase"], "running");
        assert!(
            row["channelId"].is_string() && row["startedAtMs"].is_i64(),
            "{row}"
        );
    }
    let entry = agent_entry(&page, agent);
    assert_eq!(
        entry["visible"]["running"], 4,
        "one agent, four rooms → running=4: {entry}"
    );
    assert_eq!(entry["visible"]["queued"], 0);
    assert_eq!(entry["visible"]["claimed"], 0);
    assert_eq!(entry["visible"]["awaitingApproval"], 0);
    assert_eq!(entry["visible"]["paused"], 0);
    assert_eq!(
        entry["activeTotal"], 7,
        "the three hidden rooms' runs count in activeTotal only: {entry}"
    );
    assert_eq!(page["agents"].as_array().unwrap().len(), 1);
    assert!(
        page.get("nextCursor").is_none(),
        "one page holds everything"
    );

    // The owner is in every room except the one archived: archived rooms are out
    // for everyone, the left room is still theirs.
    let owner_token = login(&s.http, &s.base, ws, &owner_email).await;
    let page = active(&s.http, &s.base, &owner_token, ws, "").await;
    let got = run_ids(&page);
    assert_eq!(
        got.len(),
        6,
        "four shared + private + left (owner never left): {page}"
    );
    assert!(!got.contains(&archived_run));
    let entry = agent_entry(&page, agent);
    assert_eq!(entry["visible"]["running"], 6);
    assert_eq!(entry["activeTotal"], 7);
}

// ---------------------------------------------------------------------------
// 2 — the counts are the whole visible set, never the page
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn active_2_counts_do_not_depend_on_the_page() {
    let s = setup().await;
    let ws = seed_workspace(&s.su).await;
    let (owner, owner_email) = seed_human(&s.su, ws, "owner", "성재").await;
    let agent = seed_agent(&s.su, ws, owner, "grokbot").await;
    let other = seed_agent(&s.su, ws, owner, "teamai").await;
    let mut runs = Vec::new();
    for index in 0..4 {
        let channel = seed_channel(&s.su, &s.app, ws, owner).await;
        // newest first: index 0 is the newest
        runs.push(seed_run(&s.su, ws, agent, channel, "running", 10 + index).await);
    }
    let channel = seed_channel(&s.su, &s.app, ws, owner).await;
    let other_run = seed_run(&s.su, ws, other, channel, "awaiting_approval", 100).await;
    runs.push(other_run);

    let token = login(&s.http, &s.base, ws, &owner_email).await;
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for page_index in 0..5 {
        let query = match &cursor {
            Some(cursor) => format!("?state=active&limit=1&cursor={cursor}"),
            None => "?state=active&limit=1".to_string(),
        };
        let page = active(&s.http, &s.base, &token, ws, &query).await;
        let ids = run_ids(&page);
        assert_eq!(ids.len(), 1, "limit=1 → one row per page: {page}");
        seen.extend(ids);
        let entry = agent_entry(&page, agent);
        assert_eq!(
            entry["visible"]["running"], 4,
            "page {page_index}: counts are the whole set, not the page: {entry}"
        );
        assert_eq!(entry["activeTotal"], 4);
        let entry = agent_entry(&page, other);
        assert_eq!(entry["visible"]["awaitingApproval"], 1);
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if page_index < 4 {
            assert!(cursor.is_some(), "page {page_index} has a next page");
        } else {
            assert!(cursor.is_none(), "the last page has no cursor: {page}");
        }
    }
    assert_eq!(
        seen, runs,
        "keyset pages walk newest → oldest, no repeats, no gaps"
    );
}

// ---------------------------------------------------------------------------
// 3 — scope=mine
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn active_3_scope_mine_is_what_i_asked_for() {
    let s = setup().await;
    let ws = seed_workspace(&s.su).await;
    let (owner, owner_email) = seed_human(&s.su, ws, "owner", "성재").await;
    let (peer, peer_email) = seed_human(&s.su, ws, "member", "동료").await;
    let agent = seed_agent(&s.su, ws, owner, "grokbot").await;
    let room = seed_channel(&s.su, &s.app, ws, owner).await;
    join_channel(&s.su, ws, room, peer).await;
    join_channel(&s.su, ws, room, agent).await;

    let owner_work = seed_run(&s.su, ws, agent, room, "running", 30).await;
    seed_work_requester(&s.su, ws, owner_work, owner).await;
    let peer_work = seed_run(&s.su, ws, agent, room, "queued", 20).await;
    seed_work_requester(&s.su, ws, peer_work, peer).await;
    let peer_mention = seed_mention_run(&s.su, ws, agent, room, peer, 10).await;
    // A run with no requester record at all (e.g. a welcome run) is team-only.
    let nobody = seed_run(&s.su, ws, agent, room, "running", 5).await;

    let peer_token = login(&s.http, &s.base, ws, &peer_email).await;
    let mine = active(
        &s.http,
        &s.base,
        &peer_token,
        ws,
        "?state=active&scope=mine",
    )
    .await;
    assert_eq!(
        run_ids(&mine),
        vec![peer_mention, peer_work],
        "mine = the mention I wrote and the work I queued, newest first: {mine}"
    );
    let entry = agent_entry(&mine, agent);
    assert_eq!(entry["visible"]["running"], 1, "the mention run: {entry}");
    assert_eq!(entry["visible"]["queued"], 1, "the work run: {entry}");
    assert_eq!(entry["activeTotal"], 4, "activeTotal is every requester's");

    let team = active(
        &s.http,
        &s.base,
        &peer_token,
        ws,
        "?state=active&scope=team",
    )
    .await;
    assert_eq!(
        run_ids(&team),
        vec![nobody, peer_mention, peer_work, owner_work],
        "team = every run of my rooms: {team}"
    );
    assert_eq!(agent_entry(&team, agent)["visible"]["running"], 3);

    let owner_token = login(&s.http, &s.base, ws, &owner_email).await;
    let mine = active(&s.http, &s.base, &owner_token, ws, "?scope=mine").await;
    assert_eq!(
        run_ids(&mine),
        vec![owner_work],
        "the owner asked for one: {mine}"
    );
}

// ---------------------------------------------------------------------------
// 4 — claimed = a queued run whose job is leased
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn active_4_claimed_is_a_leased_queued_run() {
    let s = setup().await;
    let ws = seed_workspace(&s.su).await;
    let (owner, owner_email) = seed_human(&s.su, ws, "owner", "성재").await;
    let agent = seed_agent(&s.su, ws, owner, "grokbot").await;
    let room = seed_channel(&s.su, &s.app, ws, owner).await;
    let leased = seed_run(&s.su, ws, agent, room, "queued", 30).await;
    seed_job(&s.su, ws, agent, room, leased, true).await;
    let waiting = seed_run(&s.su, ws, agent, room, "queued", 20).await;
    seed_job(&s.su, ws, agent, room, waiting, false).await;
    let paused = seed_run(&s.su, ws, agent, room, "paused", 10).await;

    let token = login(&s.http, &s.base, ws, &owner_email).await;
    // limit=1 so the leased run is NOT on the page: claimed must still be counted.
    let page = active(&s.http, &s.base, &token, ws, "?limit=1").await;
    assert_eq!(run_ids(&page), vec![paused]);
    let entry = agent_entry(&page, agent);
    assert_eq!(entry["visible"]["claimed"], 1, "{entry}");
    assert_eq!(entry["visible"]["queued"], 1, "{entry}");
    assert_eq!(entry["visible"]["paused"], 1, "{entry}");
    assert_eq!(entry["activeTotal"], 3);

    let page = active(&s.http, &s.base, &token, ws, "").await;
    let phases: Vec<(Uuid, String)> = page["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                Uuid::parse_str(row["id"].as_str().unwrap()).unwrap(),
                row["phase"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        phases,
        vec![
            (paused, "paused".to_string()),
            (waiting, "queued".to_string()),
            (leased, "claimed".to_string()),
        ],
        "rows carry the same derived phase the counts use: {page}"
    );
}

// ---------------------------------------------------------------------------
// 5 — refusals and tenants
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn active_5_refusals_and_tenants() {
    let s = setup().await;
    let ws = seed_workspace(&s.su).await;
    let (owner, _owner_email) = seed_human(&s.su, ws, "owner", "성재").await;
    let (peer, peer_email) = seed_human(&s.su, ws, "member", "동료").await;
    let agent = seed_agent(&s.su, ws, owner, "grokbot").await;
    let private = seed_channel(&s.su, &s.app, ws, owner).await;
    let hidden = seed_run(&s.su, ws, agent, private, "running", 10).await;
    let _ = peer;

    // A second tenant, busy, with the same shape.
    let other_ws = seed_workspace(&s.su).await;
    let (other_owner, other_email) = seed_human(&s.su, other_ws, "owner", "남").await;
    let other_agent = seed_agent(&s.su, other_ws, other_owner, "grokbot").await;
    let other_room = seed_channel(&s.su, &s.app, other_ws, other_owner).await;
    let other_run = seed_run(&s.su, other_ws, other_agent, other_room, "running", 10).await;

    let token = login(&s.http, &s.base, ws, &peer_email).await;
    for (query, why) in [
        ("?state=all", "only state=active exists"),
        ("?state=done", "unknown state"),
        ("?scope=everyone", "unknown scope"),
        (
            "?scope=MINE",
            "scope is case-sensitive like every closed enum here",
        ),
    ] {
        let response = get(
            &s.http,
            &s.base,
            &token,
            &format!("/v1/workspaces/{ws}/agent-runs{query}"),
        )
        .await;
        assert_eq!(response.status(), 400, "{why}: {query}");
    }
    // A cursor that is a run of a room I am not in is a 400, not an empty page.
    let response = get(
        &s.http,
        &s.base,
        &token,
        &format!("/v1/workspaces/{ws}/agent-runs?cursor={hidden}"),
    )
    .await;
    assert_eq!(
        response.status(),
        400,
        "unseen cursor is named, not answered empty"
    );
    let response = get(
        &s.http,
        &s.base,
        &token,
        &format!("/v1/workspaces/{ws}/agent-runs?cursor=not-a-uuid"),
    )
    .await;
    assert_eq!(response.status(), 400);

    // The peer is in no room with a run: empty rows, and the busy agent is not
    // even named (listing it would say it is busy somewhere they cannot see).
    let page = active(&s.http, &s.base, &token, ws, "").await;
    assert_eq!(
        page,
        json!({"runs": [], "agents": []}),
        "nothing visible → nothing named"
    );

    // Another tenant's id in the path is refused by the token's workspace binding.
    let response = get(
        &s.http,
        &s.base,
        &token,
        &format!("/v1/workspaces/{other_ws}/agent-runs"),
    )
    .await;
    assert_eq!(
        response.status(),
        403,
        "path workspace must equal the token's"
    );

    // And the other tenant sees only its own run.
    let other_token = login(&s.http, &s.base, other_ws, &other_email).await;
    let page = active(&s.http, &s.base, &other_token, other_ws, "").await;
    assert_eq!(run_ids(&page), vec![other_run]);
    assert_eq!(
        agent_entry(&page, other_agent)["activeTotal"],
        1,
        "no cross-tenant count"
    );
    assert!(!page
        .to_string()
        .to_lowercase()
        .contains(&hidden.to_string()));

    // No bearer at all.
    let response = s
        .http
        .get(format!("{}/v1/workspaces/{ws}/agent-runs", s.base))
        .send()
        .await
        .expect("GET");
    assert_eq!(response.status(), 401);
}

// ---------------------------------------------------------------------------
// 6 — a DM's runs are its two people's
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn active_6_a_dm_run_is_its_two_peoples() {
    let s = setup().await;
    let ws = seed_workspace(&s.su).await;
    let (owner, owner_email) = seed_human(&s.su, ws, "owner", "성재").await;
    let (peer, peer_email) = seed_human(&s.su, ws, "member", "동료").await;
    let agent = seed_agent(&s.su, ws, owner, "grokbot").await;

    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, dm_key, created_by) \
         VALUES ($1, $2, 'dm', NULL, NULL, $3, $4)",
    )
    .bind(dm)
    .bind(ws)
    .bind(dm.to_string())
    .bind(owner)
    .execute(&s.su)
    .await
    .expect("seed dm");
    join_channel(&s.su, ws, dm, owner).await;
    join_channel(&s.su, ws, dm, agent).await;
    let dm_run = seed_run(&s.su, ws, agent, dm, "running", 10).await;

    let owner_token = login(&s.http, &s.base, ws, &owner_email).await;
    let page = active(&s.http, &s.base, &owner_token, ws, "").await;
    assert_eq!(run_ids(&page), vec![dm_run], "the DM's person sees it");

    let peer_token = login(&s.http, &s.base, ws, &peer_email).await;
    let page = active(&s.http, &s.base, &peer_token, ws, "").await;
    assert_eq!(
        page,
        json!({"runs": [], "agents": []}),
        "a third person does not"
    );
    let _ = peer;
}
