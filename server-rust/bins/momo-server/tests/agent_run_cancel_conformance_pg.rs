//! DB-backed conformance for the human stop (goal SRV-C2, ADR-0132 D1).
//!
//! Before this goal the Rust server had **zero** cancel routes: a run, once
//! started, could only be ended by the machine that was running it. These four
//! tests are the proof that a person can now end one — and each is written so
//! that a revert shows up as *an agent answering after it was told to stop*,
//! not as a missing column.
//!
//! They are `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB
//! plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test agent_run_cancel_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `agent_ops_conformance_pg.rs`: `DATABASE_URL`
//! connects as a **superuser** (migrations + `infra/e2e/bootstrap_roles.sql`,
//! fixtures bypass RLS); the **server** runs on `momo_app` (NOBYPASSRLS) so every
//! assertion is made through the policies production uses; the **worker** runs on
//! `momo_worker` (BYPASSRLS), the only faithful posture for a consumer whose
//! claim has no workspace predicate.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `srv_c2_1_a_stop_ends_the_run_retires_its_job_and_says_so_in_the_room` | drop the route, drop `retire_pending_agent_jobs_for_run_in_tx` (the agent then answers after the stop), case-match the job predicate literally like Swift, or stop writing the system line |
//! | `srv_c2_2_a_repeat_stop_writes_nothing` | remove the `already_cancelled` early return — a second tap appends a second system line and a second audit row |
//! | `srv_c2_3_only_someone_in_the_room_may_stop_a_run` | widen the gate to any workspace member, or answer 403 instead of 404 for a run that is not there |
//! | `srv_c2_4_a_finished_run_is_a_conflict_and_a_stop_retires_its_approvals` | let a terminal run answer 200, or leave the run's pending approval in the inbox |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent_worker::provider::MockChatProvider;
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "srv-c2-run-cancel-conformance-secret";
const TEST_PASSWORD: &str = "srv-c2-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";

/// The line the room sees. Pinned here rather than imported so that changing the
/// server's copy is a two-file edit somebody has to mean.
const CANCEL_LINE: &str = "실행이 사람에 의해 중지되었습니다.";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn momo_worker_password() -> String {
    std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string())
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

/// Retire every worker job this suite did not enqueue — `claim_agent_job_batch`
/// is a **global** claim (no workspace predicate, no tenant GUC), so a leftover
/// row from another binary would land in this suite's batch. Every assertion
/// below is additionally scoped to this test's fresh `workspace_id`.
async fn settle_residual_worker_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = 'publish' \
            AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual worker agent_jobs");
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

struct Tenant {
    workspace: Uuid,
    human: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@srvc2.test");
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

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let (human, email) = seed_human(su, workspace, "owner", "성재").await;

    // `create_channel` seeds the creator's `membership` row, so the human is
    // already in the room — which is exactly the authority a cancel needs.
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("srvc2-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create channel")
    .id;

    Tenant {
        workspace,
        human,
        email,
        channel,
    }
}

/// Seed an agent member **already in the channel** — this suite is about the
/// stop, not about the invite that `agent_ops_conformance_pg` covers.
async fn seed_channel_agent(su: &PgPool, tenant: &Tenant, handle: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(AGENT_MODEL)
    .bind(tenant.human)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    join_channel(su, tenant, agent).await;
    agent
}

async fn join_channel(su: &PgPool, tenant: &Tenant, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

/// A run in an arbitrary status, for the branches a real mention cannot reach
/// (a `succeeded` run, an `awaiting_approval` one).
async fn seed_run(su: &PgPool, tenant: &Tenant, agent: Uuid, status: &str) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7)",
    )
    .bind(run)
    .bind(tenant.workspace)
    .bind(agent)
    .bind(tenant.channel)
    .bind(status)
    .bind(json!({"type": "work", "title": "srv-c2", "brief": "srv-c2"}))
    .bind(format!("srv-c2:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
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

async fn send(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    body: &str,
) -> Value {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(token)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
        .send()
        .await
        .expect("send message");
    assert_eq!(response.status(), 201, "a send answers 201");
    response.json().await.expect("message body")
}

async fn cancel(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    run: Uuid,
) -> reqwest::Response {
    http.post(format!(
        "{base}/v1/workspaces/{workspace}/agent-runs/{run}/cancel"
    ))
    .bearer_auth(token)
    .send()
    .await
    .expect("cancel agent run")
}

async fn error_message(response: reqwest::Response) -> String {
    let payload: Value = response.json().await.expect("error body");
    payload["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

async fn run_row(su: &PgPool, run: Uuid) -> (String, Option<Value>, bool) {
    let row = sqlx::query(
        "SELECT status::text AS status, error, finished_at IS NOT NULL AS finished \
           FROM agent_run WHERE id = $1",
    )
    .bind(run)
    .fetch_one(su)
    .await
    .expect("read agent run");
    (
        row.get("status"),
        row.get("error"),
        row.get::<bool, _>("finished"),
    )
}

async fn agent_jobs(su: &PgPool, workspace: Uuid) -> Vec<(String, Option<String>, Value)> {
    sqlx::query(
        "SELECT status::text AS status, last_error, payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read agent jobs")
    .into_iter()
    .map(|row| (row.get("status"), row.get("last_error"), row.get("payload")))
    .collect()
}

/// Every `system` message in the channel, with its props.
async fn system_lines(su: &PgPool, tenant: &Tenant) -> Vec<(Uuid, i64, String, Uuid, Value)> {
    sqlx::query(
        "SELECT id, seq, COALESCE(body, '') AS body, author_member_id, props \
           FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND type = 'system' \
          ORDER BY seq",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .fetch_all(su)
    .await
    .expect("read system messages")
    .into_iter()
    .map(|row| {
        (
            row.get("id"),
            row.get("seq"),
            row.get("body"),
            row.get("author_member_id"),
            row.get("props"),
        )
    })
    .collect()
}

/// Broadcast rows whose payload carries the cancel line — the proof the room is
/// actually told, rather than only the database knowing.
async fn cancel_broadcasts(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->'payload'->>'body' = $2 \
          ORDER BY id",
    )
    .bind(workspace)
    .bind(CANCEL_LINE)
    .fetch_all(su)
    .await
    .expect("read cancel broadcasts")
}

async fn audit_details(su: &PgPool, workspace: Uuid, action: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = $2 ORDER BY created_at",
    )
    .bind(workspace)
    .bind(action)
    .fetch_all(su)
    .await
    .expect("read audit details")
}

async fn agent_message_count(su: &PgPool, tenant: &Tenant, agent: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(agent)
    .fetch_one(su)
    .await
    .expect("count agent messages")
}

async fn drain_once() -> momo_agent_worker::DrainStats {
    let pool = role_pool("momo_worker", &momo_worker_password()).await;
    let worker = AgentWorker::new(
        pool,
        Arc::new(MockChatProvider::echo()),
        WorkerConfig::for_target(database_url()),
    );
    worker.drain_once().await.expect("drain")
}

// ---------------------------------------------------------------------------
// 1 — the stop actually stops it
// ---------------------------------------------------------------------------

/// **A person stops a run: the row ends, the queued job never runs, and the room
/// is told.**
///
/// The run here is a *real* one — a mention that queued a worker job — rather
/// than a seeded row, for two reasons. First, the `drain_once()` at the end is
/// the only assertion that proves a cancel means **stopped** and not merely
/// *marked*: without the outbox retirement the worker claims the job and the
/// agent answers in the channel seconds after a human asked it not to. Second,
/// the mention path writes `payload.run_id` **uppercase**
/// (`momo_agent::mention::mention_job_payload`) while the work path writes it
/// lowercase — so a literal port of Swift's case-sensitive job predicate passes
/// against a work run and fails right here, on the commonest kind of run there
/// is.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srv_c2_1_a_stop_ends_the_run_retires_its_job_and_says_so_in_the_room() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    let trigger = send(&http, &base, &token, &tenant, "@hermes 배포 시작해줘").await;
    let trigger_seq = trigger["seq"].as_i64().expect("the send returns its seq");

    let run: Uuid = sqlx::query_scalar("SELECT id FROM agent_run WHERE workspace_id = $1")
        .bind(tenant.workspace)
        .fetch_one(&su)
        .await
        .expect("the mention started exactly one run");
    let jobs = agent_jobs(&su, tenant.workspace).await;
    assert_eq!(jobs.len(), 1, "the mention queued one job: {jobs:?}");
    assert_eq!(jobs[0].0, "pending", "and it is waiting for a worker");

    // ---- the stop -----------------------------------------------------------
    let response = cancel(&http, &base, &token, tenant.workspace, run).await;
    assert_eq!(response.status(), 200, "a member of the room may stop it");
    let body: Value = response.json().await.expect("cancel body");
    assert_eq!(body["runId"], json!(run.to_string()));
    assert_eq!(body["status"], json!("cancelled"));
    assert_eq!(
        body["linkedWorkSessionIds"],
        json!([]),
        "no work_control row exists on this server, so the honest answer is none"
    );
    assert_eq!(
        body["workSessionsTerminated"],
        json!(false),
        "a run cancel never kills a work session — the response says so out loud"
    );

    // ---- the run row --------------------------------------------------------
    let (status, error, finished) = run_row(&su, run).await;
    assert_eq!(status, "cancelled");
    assert!(finished, "a stopped run is finished, not merely relabelled");
    let error = error.expect("a cancelled run carries its reason");
    assert_eq!(error["code"], json!("human_cancelled"));
    assert_eq!(error["cancelled_by"], json!(tenant.human.to_string()));
    assert_eq!(error["work_sessions_terminated"], json!(false));

    // ---- the job, which is the half that actually stops the work ------------
    let jobs = agent_jobs(&su, tenant.workspace).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        jobs[0].0, "done",
        "the queued instruction is retired, or the worker still runs it: {jobs:?}"
    );
    assert_eq!(
        jobs[0].1.as_deref(),
        Some("human cancelled agent run"),
        "the reason is on the row, so an operator reading the outbox is not guessing"
    );

    // ---- the room -----------------------------------------------------------
    let lines = system_lines(&su, &tenant).await;
    assert_eq!(lines.len(), 1, "exactly one system line: {lines:?}");
    let (message_id, seq, body_text, author, props) = &lines[0];
    assert_eq!(body_text, CANCEL_LINE);
    assert!(
        *seq > trigger_seq,
        "the line took a real channel_seq after the trigger, not a synthetic one"
    );
    assert_eq!(
        *author, tenant.human,
        "the person who stopped it is the author — the agent did not choose this"
    );
    assert_eq!(props["kind"], json!("agent_run_cancelled"));
    assert_eq!(props["run_id"], json!(run.to_string()));
    assert_eq!(props["agent_member_id"], json!(agent.to_string()));
    assert_eq!(props["cancelled_by"], json!(tenant.human.to_string()));

    let broadcasts = cancel_broadcasts(&su, tenant.workspace).await;
    assert_eq!(
        broadcasts.len(),
        1,
        "the line left through the ONE outbox egress, so a connected client sees \
         it without a refetch: {broadcasts:?}"
    );
    assert_eq!(broadcasts[0]["data"]["type"], json!("message.new"));

    // ---- the audit ----------------------------------------------------------
    let details = audit_details(&su, tenant.workspace, "agent.run.cancelled").await;
    assert_eq!(details.len(), 1, "one stop, one audit row: {details:?}");
    assert_eq!(details[0]["schema"], json!("momo.agent_run.cancelled.v1"));
    assert_eq!(
        details[0]["previous_status"],
        json!("queued"),
        "the record says what it interrupted"
    );
    assert_eq!(
        details[0]["system_message_id"],
        json!(message_id.to_string()),
        "the audit row names the line it published"
    );

    // ---- and the loop is genuinely over -------------------------------------
    //
    // The claim is global, so this asserts on THIS workspace's messages rather
    // than on `DrainStats`: another test binary's job is allowed to be in the
    // same batch.
    drain_once().await;
    assert_eq!(
        agent_message_count(&su, &tenant, agent).await,
        0,
        "the agent said nothing after it was stopped — this is the assertion the \
         whole goal exists for"
    );
}

// ---------------------------------------------------------------------------
// 2 — idempotence, and the red proof it anchors
// ---------------------------------------------------------------------------

/// **Stopping an already-stopped run changes nothing.**
///
/// A double-tap on a phone, or a retry of a request whose response was lost,
/// must not append a second "중지되었습니다" to the room or a second audit row to
/// the record. The guard is the `already_cancelled` early return in
/// `cancel_in_tx`; remove it and this test fails by name with two system lines
/// and two audit rows, which is the red proof this suite is built around.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srv_c2_2_a_repeat_stop_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent, "running").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    let first = cancel(&http, &base, &token, tenant.workspace, run).await;
    assert_eq!(first.status(), 200);
    let first: Value = first.json().await.expect("first body");

    let second = cancel(&http, &base, &token, tenant.workspace, run).await;
    assert_eq!(
        second.status(),
        200,
        "a repeat stop is not a conflict: the caller asked for a stopped run and \
         is holding one"
    );
    let second: Value = second.json().await.expect("second body");
    assert_eq!(first, second, "and it answers the same thing");

    assert_eq!(
        system_lines(&su, &tenant).await.len(),
        1,
        "one stop, one line — a second tap must not re-announce it"
    );
    assert_eq!(
        cancel_broadcasts(&su, tenant.workspace).await.len(),
        1,
        "and must not re-publish it either"
    );
    assert_eq!(
        audit_details(&su, tenant.workspace, "agent.run.cancelled")
            .await
            .len(),
        1,
        "the record must not double-count a decision made once"
    );
}

// ---------------------------------------------------------------------------
// 3 — the authorization is the room
// ---------------------------------------------------------------------------

/// **Being in the room is what grants the stop — and nothing else does.**
///
/// ADR-0132 D1 puts the authority with the channel rather than with ownership,
/// so this test's positive case is a *plain member* (not the owner, not the
/// agent's owner) and its negative is a workspace member who is simply not in
/// that room. The 404 arm matters just as much: a run in another workspace must
/// answer "not found" rather than "forbidden", because "forbidden" confirms the
/// run exists to someone who cannot see it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srv_c2_3_only_someone_in_the_room_may_stop_a_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent, "running").await;

    // An ordinary workspace member who is NOT in the channel.
    let (outsider, outsider_email) = seed_human(&su, tenant.workspace, "member", "바깥사람").await;
    // …and an ordinary workspace member who IS.
    let (insider, insider_email) = seed_human(&su, tenant.workspace, "member", "같은방").await;
    join_channel(&su, &tenant, insider).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let outsider_token = login(&http, &base, tenant.workspace, &outsider_email).await;
    let insider_token = login(&http, &base, tenant.workspace, &insider_email).await;

    // ---- not in the room ----------------------------------------------------
    let refused = cancel(&http, &base, &outsider_token, tenant.workspace, run).await;
    assert_eq!(refused.status(), 403);
    assert_eq!(
        error_message(refused).await,
        "active human channel member required"
    );
    assert_eq!(
        run_row(&su, run).await.0,
        "running",
        "a refusal leaves the run exactly as it was"
    );
    assert!(
        system_lines(&su, &tenant).await.is_empty(),
        "and says nothing in a room it was refused"
    );

    // ---- a run that is not there -------------------------------------------
    let missing = cancel(
        &http,
        &base,
        &insider_token,
        tenant.workspace,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(
        missing.status(),
        404,
        "an unknown run is not found, never forbidden"
    );
    assert_eq!(error_message(missing).await, "agent run not found");

    // ---- a member of the room, with no other privilege ----------------------
    let allowed = cancel(&http, &base, &insider_token, tenant.workspace, run).await;
    assert_eq!(
        allowed.status(),
        200,
        "a plain member of the channel may stop it — that is 휴먼 정지권"
    );
    assert_eq!(run_row(&su, run).await.0, "cancelled");
    let details = audit_details(&su, tenant.workspace, "agent.run.cancelled").await;
    assert_eq!(
        details.len(),
        1,
        "and only the stop that happened is recorded"
    );
    assert_ne!(
        outsider, insider,
        "the two fixtures really are different people"
    );
}

// ---------------------------------------------------------------------------
// 4 — a finished run, and the approvals a stop clears
// ---------------------------------------------------------------------------

/// **A run that already ended is a conflict, and a run that was waiting on a
/// person takes its approval down with it.**
///
/// The conflict arm is about honesty: answering 200 for a `succeeded` run would
/// tell someone their stop worked when what really happened is that the agent
/// finished first — the opposite conclusion about whether the work happened.
///
/// The approval arm is about the inbox: a stopped run whose approval stayed
/// `pending` keeps asking a person to decide something that can no longer
/// happen, and an 승인 tap on it would try to resume a cancelled run.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srv_c2_4_a_finished_run_is_a_conflict_and_a_stop_retires_its_approvals() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    // ---- every terminal status that is not `cancelled` is a 409 -------------
    for status in ["succeeded", "failed", "timed_out"] {
        let finished = seed_run(&su, &tenant, agent, status).await;
        let response = cancel(&http, &base, &token, tenant.workspace, finished).await;
        assert_eq!(
            response.status(),
            409,
            "a {status} run cannot be stopped — it already ended"
        );
        assert_eq!(
            error_message(response).await,
            format!("agent run is already {status}"),
            "and the answer names the status it actually has, so a client can say \
             '이미 끝났습니다' rather than '실패했습니다'"
        );
        assert_eq!(
            run_row(&su, finished).await.0,
            status,
            "the refusal wrote nothing"
        );
    }
    assert!(
        system_lines(&su, &tenant).await.is_empty(),
        "three refusals, no lines in the room"
    );

    // ---- a parked run: the stop clears the approval it was waiting on -------
    let parked = seed_run(&su, &tenant, agent, "awaiting_approval").await;
    let approval = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, requested_by, action_type, payload, \
            status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, 'tool_call', $6, 'pending', now() + interval '1 hour')",
    )
    .bind(approval)
    .bind(tenant.workspace)
    .bind(parked)
    .bind(tenant.channel)
    .bind(agent)
    .bind(
        json!({"tool_call": {"call_id": "srv-c2-1", "name": "github.search_issues",
                               "arguments": {}}}),
    )
    .execute(&su)
    .await
    .expect("seed pending approval");

    let response = cancel(&http, &base, &token, tenant.workspace, parked).await;
    assert_eq!(
        response.status(),
        200,
        "a run parked on a human decision is still stoppable"
    );

    let (status, decided_by, reason): (String, Option<Uuid>, Option<String>) = sqlx::query_as(
        "SELECT status::text, decided_by, decision_reason FROM approval WHERE id = $1",
    )
    .bind(approval)
    .fetch_one(&su)
    .await
    .expect("read approval");
    assert_eq!(
        status, "cancelled",
        "the card leaves the inbox with the run it belonged to"
    );
    assert_eq!(
        decided_by, None,
        "nobody decided this approval — the run it was for went away, and \
         approval_decided_ck would refuse a decider anyway"
    );
    assert_eq!(reason.as_deref(), Some("agent run cancelled by human"));
    assert_eq!(run_row(&su, parked).await.0, "cancelled");
}
