//! DB-backed conformance for the surfaces that only exist in **gateway mode**
//! (goal SRV-B6, issue #1038).
//!
//! ## Why this file had to be created rather than extended
//!
//! `AGENT_GATEWAY_MODE=gateway` unlocks two surfaces — `POST …/agent-runs`
//! (the work-run create path) and the three `…/gateway/*` callbacks — and until
//! this suite existed **no test in the workspace configured that mode**. Both
//! surfaces were therefore HTTP-unverified: measured while landing #1012 (the
//! gateway `events` frame producer) and again while landing #1037 (the work
//! run's tool wiring), where the loader half could be proven against the DB and
//! the route half could not be reached at all.
//!
//! Every other suite boots `AppState::new(...)` and inherits
//! `AgentGatewaySettings::default()`, which is `Worker` — a default chosen so a
//! typo cannot expose the callback surface. That default is right, and it is
//! also exactly why this file has to opt in explicitly.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test gateway_mode_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b6_1_a_work_run_reaches_a_gateway_and_comes_back` | drop gateway mode from the route guard, stop carrying tools on the work payload (#1037), drop the lease from the claim, or stop `complete` from writing the message/ledger/terminal-status trio |
//! | `b6_2_a_gateway_event_moves_the_run_and_publishes_progress` | drop the `mark_run_started` transition from `events`, or drop the progress/partial frames it emits (#1013) |
//! | `t4622_the_rest_callback_answers_inside_the_thread_it_was_asked_in` | write the callback's answer with `root_id: None` (it leaves the thread the person is watching), or write it on the spine that skips the thread rollup (the root's 「답글 N개」 and `thread.updated` stop moving), or give a main-flow request a thread it never had |

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

const TEST_JWT_SECRET: &str = "srv-b6-gateway-conformance-secret";
const TEST_PASSWORD: &str = "srv-b6-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
/// A secret `is_unsafe_secret()` actually accepts.
///
/// It refuses eleven reserved words by equality AND five needles by
/// **substring** — `change-me`, `changeme`, `dev-insecure`, `placeholder`,
/// `example`. This constant's first draft was
/// `"…-secret-not-a-placeholder"`, which the check rejected for containing
/// "placeholder"; `legacy_secret_enabled()` then answered false and every
/// callback in this file 401'd with "missing bearer token". Worth the comment
/// because the failure names the credential, not the config that voided it.
const GATEWAY_SECRET: &str = "srv-b6-gateway-shared-9f2c4a7b1e5d";

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
    )
    // THE line this suite exists for. Every other suite inherits
    // `AgentGatewaySettings::default()` (= Worker), which is what kept these two
    // surfaces unreachable from any test.
    .with_agent_gateway(momo_server::config::AgentGatewaySettings {
        mode: momo_server::config::AgentGatewayMode::Gateway,
        secret: GATEWAY_SECRET.to_string(),
        // The legacy shared secret is deprecated in production and is used here
        // because it is the ONLY callback credential a test can mint without
        // standing up per-agent bearer issuance. `legacy_secret_enabled()`
        // requires all three of mode/flag/non-placeholder-secret, so this line
        // is also an assertion that the three-way guard is satisfiable.
        allow_legacy_secret: true,
    });
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
        "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3) \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(member)
    .execute(su)
    .await
    .expect("join channel");
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

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// helpers unique to the gateway surface
// ---------------------------------------------------------------------------

async fn enable_tools(su: &PgPool, tenant: &Tenant, agent: Uuid, tools: &[&str]) {
    sqlx::query(
        "INSERT INTO agent_profile \
           (agent_member_id, workspace_id, instructions, enabled_tools, version, \
            updated_by, updated_at) \
         VALUES ($1, $2, '', $3, 1, $4, now()) \
         ON CONFLICT (agent_member_id) DO UPDATE SET enabled_tools = EXCLUDED.enabled_tools",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(json!(tools))
    .bind(tenant.human)
    .execute(su)
    .await
    .expect("write enabled_tools");
}

/// `POST …/channels/{ch}/agent-runs` — the create path that only answers in
/// gateway mode.
async fn create_work_run(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    agent: Uuid,
    client_run_id: Uuid,
) -> reqwest::Response {
    http.post(format!(
        "{base}/v1/workspaces/{}/channels/{}/agent-runs",
        tenant.workspace, tenant.channel
    ))
    .bearer_auth(token)
    .json(&json!({
        // snake_case: `CreateAgentRunRequest` carries no `rename_all` and is
        // `deny_unknown_fields`, so a camelCase key here is a 422 — the request
        // and response casings genuinely differ on this route.
        "agent_member_id": agent.to_string(),
        "client_run_id": client_run_id.to_string(),
        "input": {"type": "work", "title": "배포 점검", "brief": "스테이징 상태를 확인해줘"},
    }))
    .send()
    .await
    .expect("create work run")
}

/// A gateway callback, authenticated with the legacy shared secret.
fn gateway(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request.header(momo_server::auth::GATEWAY_SECRET_HEADER, GATEWAY_SECRET)
}

async fn rail_frames(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' IN ('agent.status', 'agent.partial') \
          ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read rail frames")
}

// ---------------------------------------------------------------------------
// 1 — the work run, end to end through the gateway door
// ---------------------------------------------------------------------------

/// **A work run is created, claimed with a lease, and completed — over HTTP.**
///
/// This is the path that had no test at all. Three things it pins that only
/// this mode can reach:
///
/// 1. the create route answers instead of 409ing on `gateway mode required`;
/// 2. the enqueued job carries the agent's tools (#1037's wiring, which until
///    now was provable only at the loader and the payload builder);
/// 3. `complete` writes the message, the ledger row and the terminal status as
///    one transaction, and the rail is told the turn ended (#1010).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b6_1_a_work_run_reaches_a_gateway_and_comes_back() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    enable_tools(&su, &tenant, agent, &["work.session.end"]).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    let created = create_work_run(&http, &base, &token, &tenant, agent, Uuid::new_v4()).await;
    assert_eq!(
        created.status(),
        201,
        "gateway mode is what makes this route answer at all"
    );
    let created: Value = created.json().await.expect("run body");
    let run_id = created["id"].as_str().expect("run id").to_string();

    // ---- claim, with a lease ------------------------------------------------
    let pending: Value = gateway(http.get(format!(
        "{base}/v1/workspaces/{}/agents/{agent}/gateway/jobs/pending",
        tenant.workspace
    )))
    .send()
    .await
    .expect("claim")
    .json()
    .await
    .expect("pending body");
    let jobs = pending["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "one run, one claimable job: {pending}");
    let job = &jobs[0];
    assert_eq!(job["runId"].as_str(), Some(run_id.as_str()));

    // #1037's wiring, finally asserted on the wire a gateway actually reads.
    assert_eq!(
        job["payload"]["enabled_tools"],
        json!(["work.session.end"]),
        "the work payload carries the profile's tools — before #1037 this key \
         did not exist on this path at all: {job}"
    );

    // ---- complete -----------------------------------------------------------
    let done = gateway(http.post(format!(
        "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/complete",
        tenant.workspace
    )))
    .json(&json!({
        "job_id": job["id"],
        "lease_id": job["leaseId"],
        "status": "succeeded",
        "body": "스테이징은 정상입니다.",
        "usage": {"promptTokens": 11, "completionTokens": 5},
    }))
    .send()
    .await
    .expect("complete");
    assert_eq!(
        done.status(),
        200,
        "{}",
        done.text().await.unwrap_or_default()
    );

    // ---- the four writes ----------------------------------------------------
    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(Uuid::parse_str(&run_id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("run status");
    assert_eq!(status, "succeeded");

    let answered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(answered, 1, "the answer went through the message spine");

    let billed: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(Uuid::parse_str(&run_id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(billed, 1, "…and it was billed exactly once");

    // #4375 — the camelCase usage keys above are what was billed, not a zero.
    let (prompt, completion): (i32, i32) = sqlx::query_as(
        "SELECT prompt_tokens, completion_tokens FROM usage_ledger WHERE run_id = $1",
    )
    .bind(Uuid::parse_str(&run_id).expect("uuid"))
    .fetch_one(&su)
    .await
    .expect("ledger tokens");
    assert_eq!((prompt, completion), (11, 5), "camelCase usage must bill");

    let rail = rail_frames(&su, tenant.workspace).await;
    let terminal = rail
        .iter()
        .find(|frame| frame["data"]["payload"]["phase"] == json!("done"))
        .unwrap_or_else(|| panic!("the rail was told the turn ended: {rail:?}"));
    assert_eq!(
        terminal["data"]["payload"]["run_status"],
        json!("succeeded")
    );
}

// ---------------------------------------------------------------------------
// 2 — the events callback
// ---------------------------------------------------------------------------

/// **A `streaming` event moves the run to running and publishes progress.**
///
/// The `events` route validated `text_delta` and threw it away from B2.6 until
/// #1013; nothing ever exercised it over HTTP because nothing ran in this mode.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b6_2_a_gateway_event_moves_the_run_and_publishes_progress() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let created: Value = create_work_run(&http, &base, &token, &tenant, agent, Uuid::new_v4())
        .await
        .json()
        .await
        .expect("run body");
    let run_id = created["id"].as_str().expect("run id").to_string();

    let pending: Value = gateway(http.get(format!(
        "{base}/v1/workspaces/{}/agents/{agent}/gateway/jobs/pending",
        tenant.workspace
    )))
    .send()
    .await
    .expect("claim")
    .json()
    .await
    .expect("pending body");
    let job = pending["jobs"][0].clone();

    let event = gateway(http.post(format!(
        "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/events",
        tenant.workspace
    )))
    .json(&json!({
        "job_id": job["id"],
        "lease_id": job["leaseId"],
        "status": "streaming",
        "text_delta": "확인 중입니다",
    }))
    .send()
    .await
    .expect("event");
    assert_eq!(
        event.status(),
        200,
        "{}",
        event.text().await.unwrap_or_default()
    );

    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(Uuid::parse_str(&run_id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("run status");
    assert_eq!(status, "running", "a progress event starts the run");

    let rail = rail_frames(&su, tenant.workspace).await;
    let phases: Vec<&str> = rail
        .iter()
        .map(|frame| {
            frame["data"]["payload"]["phase"]
                .as_str()
                .unwrap_or(frame["data"]["type"].as_str().unwrap_or_default())
        })
        .collect();
    assert!(
        phases.contains(&"streaming"),
        "the gateway's own status reaches the rail: {phases:?}"
    );
    assert!(
        rail.iter()
            .any(|frame| frame["data"]["type"] == json!("agent.partial")
                && frame["data"]["payload"]["text_delta"] == json!("확인 중입니다")),
        "…and so does the delta this route used to validate and discard: {rail:?}"
    );
}

// ---------------------------------------------------------------------------
// #4017 — a successful run with nothing to say leaves no placeholder message
// ---------------------------------------------------------------------------

/// **An empty successful completion settles the run and writes no message.**
///
/// The old behaviour posted an English stand-in naming the runtime into the
/// channel. Now the run still ends (status, bill, rail frame, job settled), the
/// response says `messageId: null`, a replay of the same completion answers the
/// same instead of 409, and no agent-authored message exists.
///
/// Goes red if the stand-in text comes back, if the message write stops being
/// conditional (a blank bubble), or if the terminal replay turns into a 409.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn s4017_4_an_empty_success_writes_no_message_but_settles_the_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    let created: Value = create_work_run(&http, &base, &token, &tenant, agent, Uuid::new_v4())
        .await
        .json()
        .await
        .expect("run body");
    let run_id = created["id"].as_str().expect("run id").to_string();
    let pending: Value = gateway(http.get(format!(
        "{base}/v1/workspaces/{}/agents/{agent}/gateway/jobs/pending",
        tenant.workspace
    )))
    .send()
    .await
    .expect("claim")
    .json()
    .await
    .expect("pending body");
    let job = pending["jobs"][0].clone();

    let complete = |http: &reqwest::Client| {
        gateway(http.post(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/complete",
            tenant.workspace
        )))
        .json(&json!({
            "job_id": job["id"],
            "lease_id": job["leaseId"],
            "status": "succeeded",
            "body": "   ",
            "usage": {"promptTokens": 3, "completionTokens": 0},
        }))
        .send()
    };

    let done = complete(&http).await.expect("complete");
    assert_eq!(done.status(), 200);
    let done: Value = done.json().await.expect("body");
    assert_eq!(done["status"], json!("succeeded"));
    assert!(done["messageId"].is_null(), "{done}");
    assert!(done["seq"].is_null(), "{done}");

    let run = Uuid::parse_str(&run_id).expect("uuid");
    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(&su)
        .await
        .expect("run status");
    assert_eq!(status, "succeeded", "the run still ends normally");
    let answered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(answered, 0, "no placeholder bubble");
    let billed: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(run)
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(billed, 1, "the empty run is still billed once");
    let rail = rail_frames(&su, tenant.workspace).await;
    assert!(
        rail.iter()
            .any(|frame| frame["data"]["payload"]["phase"] == json!("done")),
        "the rail is told the turn ended: {rail:?}"
    );

    let replay = complete(&http).await.expect("replay");
    assert_eq!(replay.status(), 200, "a replay answers the same");
    let replay: Value = replay.json().await.expect("body");
    assert!(replay["messageId"].is_null(), "{replay}");
}

/// ADR-0113 증보 2 E8 (#3946) — the Hermes door reports 「쓴 앱」 too. A valid
/// report is stored under `output.appsUsed` with exactly one `connector.tool_used`
/// row; a malformed one is dropped without costing the answer (the run still
/// settles, nothing stored, nothing audited, no refused byte anywhere); a replay
/// does not double the line.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn s3946_the_rest_gateway_reports_apps_used_once_and_drops_a_malformed_report() {
    const MARKER: &str = "MARK3946RESTBYTES";
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    // One claimed run per case: (run id, the claimed job).
    let claimed_run = || async {
        let created: Value = create_work_run(&http, &base, &token, &tenant, agent, Uuid::new_v4())
            .await
            .json()
            .await
            .expect("run body");
        let run_id = created["id"].as_str().expect("run id").to_string();
        let pending: Value = gateway(http.get(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/gateway/jobs/pending",
            tenant.workspace
        )))
        .send()
        .await
        .expect("claim")
        .json()
        .await
        .expect("pending body");
        (run_id, pending["jobs"][0].clone())
    };
    let complete = |run_id: &str, job: &Value, extra: Value| {
        let mut body = json!({
            "job_id": job["id"], "lease_id": job["leaseId"],
            "status": "succeeded", "body": "done",
        });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        gateway(http.post(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/complete",
            tenant.workspace
        )))
        .json(&body)
        .send()
    };
    let audits = |run: Uuid| {
        let su = &su;
        async move {
            sqlx::query_scalar::<_, Value>(
                "SELECT detail FROM audit_log WHERE action='connector.tool_used' AND run_id=$1",
            )
            .bind(run)
            .fetch_all(su)
            .await
            .expect("audits")
        }
    };
    let output_of = |run: Uuid| {
        let su = &su;
        async move {
            sqlx::query_scalar::<_, Value>("SELECT output FROM agent_run WHERE id = $1")
                .bind(run)
                .fetch_one(su)
                .await
                .expect("output")
        }
    };

    // 1. A valid report: stored, one audit line, a replay adds none.
    let (run_id, job) = claimed_run().await;
    let run = Uuid::parse_str(&run_id).expect("uuid");
    let report = json!([{"pluginId": "github", "tool": "list_pull_requests", "calls": 2}]);
    let done = complete(&run_id, &job, json!({"appsUsed": report}))
        .await
        .expect("done");
    assert_eq!(done.status(), 200);
    assert_eq!(output_of(run).await["appsUsed"], report);
    let rows = audits(run).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["apps"], report);
    assert_eq!(rows[0]["source"], json!("agent_reported"));
    let replay = complete(&run_id, &job, json!({"appsUsed": report}))
        .await
        .expect("replay");
    assert_eq!(replay.status(), 200);
    assert_eq!(audits(run).await.len(), 1);

    // 2. A malformed report (a marker as the tool name) is forgotten, not fatal.
    let (bad_run_id, bad_job) = claimed_run().await;
    let bad_run = Uuid::parse_str(&bad_run_id).expect("uuid");
    let forgotten = complete(
        &bad_run_id,
        &bad_job,
        json!({"appsUsed": [
            {"pluginId": "google-calendar", "tool": format!("{MARKER} x"), "calls": 1}
        ]}),
    )
    .await
    .expect("forgotten");
    assert_eq!(forgotten.status(), 200, "the answer is not lost");
    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(bad_run)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(status, "succeeded");
    assert!(output_of(bad_run).await.get("appsUsed").is_none());
    assert!(audits(bad_run).await.is_empty());
    let marker_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $2 \
            AND detail::text LIKE '%' || $1 || '%'",
    )
    .bind(MARKER)
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(marker_rows, 0, "no refused byte reached the audit log");
}

/// ADR-0113 증보 2 E8·E10 (#4054) — the answer the Hermes completion writes carries
/// the validated 「쓴 앱」 report and the 「막힘」 notice in **server-owned** props,
/// and nobody else can put them there.
///
/// * a valid report + notice land as `props.appsUsed` / `props.app_notice`, with
///   `site` written by the server (`hermes`);
/// * a notice that names its own `site` (or a server-only kind) is forgotten
///   whole — the answer and the receipt still land;
/// * no report, no key (never an empty list, never `{}`);
/// * a person's REST send carrying the same keys (both spellings of the receipt)
///   stores neither — the forged-props case, through the real route.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn s4054_the_answer_carries_a_server_owned_receipt_and_notice_that_nobody_can_forge() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    // One official app the registry knows (a notice's app id must be one).
    sqlx::query(
        "INSERT INTO plugin_registry (plugin_id, version, manifest, manifest_digest, official) \
         VALUES ('app-4054-known', '0.0.1', '{}'::jsonb, \
                 'sha256:0000000000000000000000000000000000000000000000000000000000000000', true) \
         ON CONFLICT (plugin_id) DO UPDATE SET official = true, revoked_at = NULL",
    )
    .execute(&su)
    .await
    .expect("seed an official registry row");

    let claimed_run = || async {
        let created: Value = create_work_run(&http, &base, &token, &tenant, agent, Uuid::new_v4())
            .await
            .json()
            .await
            .expect("run body");
        let run_id = created["id"].as_str().expect("run id").to_string();
        let pending: Value = gateway(http.get(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/gateway/jobs/pending",
            tenant.workspace
        )))
        .send()
        .await
        .expect("claim")
        .json()
        .await
        .expect("pending body");
        (run_id, pending["jobs"][0].clone())
    };
    let complete = |run_id: &str, job: &Value, extra: Value| {
        let mut body = json!({
            "job_id": job["id"], "lease_id": job["leaseId"],
            "status": "succeeded", "body": "done",
        });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        gateway(http.post(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/complete",
            tenant.workspace
        )))
        .json(&body)
        .send()
    };
    let answer_props = |run: &str| {
        let su = &su;
        let run = Uuid::parse_str(run).expect("uuid");
        async move {
            sqlx::query_scalar::<_, Value>(
                "SELECT props FROM message WHERE run_id = $1 AND client_msg_id = $1",
            )
            .bind(run)
            .fetch_one(su)
            .await
            .expect("the run's answer")
        }
    };

    // 1. A valid report and notice: both land, `site` is the server's.
    let (run_id, job) = claimed_run().await;
    let report = json!([{"pluginId": "github", "tool": "list_pull_requests", "calls": 2}]);
    let done = complete(
        &run_id,
        &job,
        json!({
            "appsUsed": report,
            "appNotice": {"kind": "egress_blocked", "pluginId": "app-4054-known", "host": "api.github.com"},
        }),
    )
    .await
    .expect("done");
    assert_eq!(done.status(), 200);
    let props = answer_props(&run_id).await;
    assert_eq!(props["appsUsed"], report);
    assert_eq!(
        props["app_notice"],
        json!({"kind": "egress_blocked", "plugin_id": "app-4054-known", "site": "hermes", "host": "api.github.com"})
    );

    // 2. A notice that names its own site, or says a server-only kind, is forgotten
    //    whole; the answer and a valid receipt are not lost.
    for forged in [
        json!({"kind": "login_lost", "site": "mac"}),
        json!({"kind": "site_off"}),
        json!({"kind": "login_lost", "sentence": "free text"}),
    ] {
        let (run_id, job) = claimed_run().await;
        let done = complete(
            &run_id,
            &job,
            json!({"appsUsed": report, "appNotice": forged}),
        )
        .await
        .expect("done");
        assert_eq!(done.status(), 200, "{forged}: the answer is not lost");
        let props = answer_props(&run_id).await;
        assert!(props.get("app_notice").is_none(), "{forged}: {props}");
        assert_eq!(props["appsUsed"], report, "{forged}");
    }

    // 2b. An app id oort does not know keeps the kind and loses the id: a site cannot
    //     make the channel print an identifier-shaped string it made up.
    let (run_id, job) = claimed_run().await;
    let done = complete(
        &run_id,
        &job,
        json!({"appNotice": {"kind": "rate_limited", "pluginId": "please-visit-evil.example"}}),
    )
    .await
    .expect("done");
    assert_eq!(done.status(), 200);
    assert_eq!(
        answer_props(&run_id).await["app_notice"],
        json!({"kind": "rate_limited", "site": "hermes"})
    );

    // 3. Nothing reported: no key at all.
    let (run_id, job) = claimed_run().await;
    let done = complete(&run_id, &job, json!({})).await.expect("done");
    assert_eq!(done.status(), 200);
    let props = answer_props(&run_id).await;
    assert!(props.get("appsUsed").is_none(), "{props}");
    assert!(props.get("app_notice").is_none(), "{props}");

    // 4. A person cannot print either one through the real REST send.
    let client_msg_id = Uuid::new_v4();
    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(&token)
        .json(&json!({
            "clientMsgId": client_msg_id.to_string(),
            "body": "위조 시도",
            "props": {
                "app_notice": "{\"kind\":\"login_lost\"}",
                "appsUsed": "[]",
                "apps_used": "[]",
                "keep": "me",
            },
        }))
        .send()
        .await
        .expect("send");
    assert!(sent.status().is_success(), "{}", sent.status());
    let stored: Value = sqlx::query_scalar("SELECT props FROM message WHERE client_msg_id = $1")
        .bind(client_msg_id)
        .fetch_one(&su)
        .await
        .expect("stored props");
    assert_eq!(stored["keep"], json!("me"));
    for key in ["app_notice", "appsUsed", "apps_used"] {
        assert!(
            stored.get(key).is_none(),
            "{key} must be stripped: {stored}"
        );
    }
}

// ---------------------------------------------------------------------------
// #4622 — where the REST callback's final answer lands
// ---------------------------------------------------------------------------

/// The owner says `body` in the tenant's channel — inside the thread of `root` when given — through the
/// real REST send, and the message id comes back. A body that names `@hermes` is a mention: the send
/// itself creates the run and the pending `gateway` job.
async fn say(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    body: &str,
    root: Option<Uuid>,
) -> Uuid {
    let mut request = json!({"clientMsgId": Uuid::new_v4(), "body": body});
    if let Some(root) = root {
        request["rootId"] = json!(root);
    }
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(token)
        .json(&request)
        .send()
        .await
        .expect("send");
    let status = response.status().as_u16();
    let value: Value = response.json().await.expect("send body");
    assert_eq!(status, 201, "a send answers 201: {value}");
    Uuid::parse_str(value["id"].as_str().expect("message id")).expect("message uuid")
}

/// Claim the one pending job and complete it with `answer` over the REST callback, as a gateway
/// adapter does. Returns the run's id.
async fn claim_and_complete(
    http: &reqwest::Client,
    base: &str,
    tenant: &Tenant,
    agent: Uuid,
    answer: &str,
) -> Uuid {
    let pending: Value = gateway(http.get(format!(
        "{base}/v1/workspaces/{}/agents/{agent}/gateway/jobs/pending",
        tenant.workspace
    )))
    .send()
    .await
    .expect("claim")
    .json()
    .await
    .expect("pending body");
    let jobs = pending["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "one mention, one claimable job: {pending}");
    let job = &jobs[0];
    let run_id = Uuid::parse_str(job["runId"].as_str().expect("runId")).expect("run uuid");
    let done = gateway(http.post(format!(
        "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/complete",
        tenant.workspace
    )))
    .json(&json!({
        "job_id": job["id"],
        "lease_id": job["leaseId"],
        "status": "succeeded",
        "body": answer,
    }))
    .send()
    .await
    .expect("complete");
    let status = done.status().as_u16();
    let body = done.text().await.unwrap_or_default();
    assert_eq!(status, 200, "complete: {body}");
    run_id
}

/// A run's final answer as `(seq, root_id, reply_to_id)`.
async fn the_answer_of(su: &PgPool, run: Uuid) -> (i64, Option<Uuid>, Option<Uuid>) {
    sqlx::query_as(
        "SELECT seq, root_id, reply_to_id FROM message WHERE run_id = $1 AND client_msg_id = $1",
    )
    .bind(run)
    .fetch_one(su)
    .await
    .expect("the run's answer")
}

/// **The REST callback answers where the person asked** (#4622, ADR-0148 증보 2026-10-27).
///
/// A request made inside a thread is answered inside it — the same place, the same rollup, the same
/// `thread.updated` as the managed worker, the team AI and the Agent Port's `oort_run_complete` — and a
/// request made at the channel's top level is answered at the top level, quoting it. The second half is
/// what keeps the first from being "always thread": #4646 owns the day that changes.
///
/// The rollup assertions are the ones a bare `root_id: Some(_)` on the raw spine fails: it would leave
/// the root's `reply_count` at 1 and publish no `thread.updated`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn t4622_the_rest_callback_answers_inside_the_thread_it_was_asked_in() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    // A request made inside a thread.
    let root = say(&http, &base, &token, &tenant, "다음 주 배포 일정", None).await;
    let asked = say(
        &http,
        &base,
        &token,
        &tenant,
        "@hermes 이어서 정리해줘",
        Some(root),
    )
    .await;
    let run = claim_and_complete(&http, &base, &tenant, agent, "이어서 정리했어요").await;
    let (answer_seq, answer_root, answer_quote) = the_answer_of(&su, run).await;
    assert_eq!(
        (answer_root, answer_quote),
        (Some(root), Some(asked)),
        "the callback's answer is inside the thread of the request, quoting it"
    );
    let rollup: (i32, Option<i64>) = sqlx::query_as(
        "SELECT reply_count, last_reply_seq FROM thread WHERE workspace_id = $1 AND root_id = $2",
    )
    .bind(tenant.workspace)
    .bind(root)
    .fetch_one(&su)
    .await
    .expect("the thread's rollup");
    assert_eq!(
        rollup,
        (2, Some(answer_seq)),
        "the person's reply and the answer — the answer is a reply the thread knows about"
    );
    let announced: Value = sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'thread.updated' \
            AND lower(payload->'data'->'payload'->>'root_id') = lower($2) \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(tenant.workspace)
    .bind(root.to_string())
    .fetch_one(&su)
    .await
    .expect("the thread was announced");
    assert_eq!(announced["reply_count"], json!(2), "{announced}");
    assert_eq!(
        announced["last_reply_seq"],
        json!(answer_seq),
        "{announced}"
    );

    // A request made at the channel's top level stays where it was: the main flow, quoting it.
    let top = say(&http, &base, &token, &tenant, "@hermes 새 질문이에요", None).await;
    let run = claim_and_complete(&http, &base, &tenant, agent, "새 답이에요").await;
    let (_, answer_root, answer_quote) = the_answer_of(&su, run).await;
    assert_eq!(
        (answer_root, answer_quote),
        (None, Some(top)),
        "a top-level request is answered in the main flow (the thread-under-it step is #4646)"
    );
}
