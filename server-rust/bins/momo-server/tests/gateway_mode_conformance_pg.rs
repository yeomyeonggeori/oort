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
