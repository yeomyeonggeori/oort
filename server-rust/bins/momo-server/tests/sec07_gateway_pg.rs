//! SEC-07 (#4245) — the REST gateway door, driven the way `Hermes` drives it: with
//! a **real issued agent bearer**, not the deprecated shared secret.
//!
//! These assertions used to live in `scripts/verify_hermes_gateway_adapter.sh`,
//! which boots the deleted Swift server and so has not run for a long time. What
//! the script claimed and no Rust test pinned is moved here. Every test starts the
//! real router on `momo_app` (NOBYPASSRLS) in `AgentGatewayMode::Gateway` with
//! `allow_legacy_secret: false` (one test turns it on, on purpose), seeds a fresh
//! workspace, mints bearers through `POST …/agents/{agent}/credentials`, and
//! reads the outcome from HTTP bodies **and** from the rows they leave behind.
//!
//! What is deliberately *not* here: the gateway door's `approval_request` /
//! `tool_call` branches, the resume-over-gateway job and the stop job do not
//! exist in Rust (`agent_gateway.rs` header, `approvals.rs` `reject_run`), and an
//! agent bearer cannot reach `POST /v1/auth/realtime-token` at all
//! (`required_agent_scope` has no arm for it, so the middleware answers 403 before
//! the handler's own agent scope check is ever reached). A test that passed
//! against those would be a fiction; they are recorded in the SEC-07 report.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test sec07_gateway_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Status: `runtime-unverified` — written against the handlers and SQL, compiled
//! and linted, not yet run against a live PostgreSQL.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::{AgentGatewayMode, AgentGatewaySettings, RealtimeSettings};
use momo_server::routes::realtime::PROXY_SECRET_HEADER;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (the gateway_mode_conformance_pg / agent_credential_conformance_pg
// pattern, with fixtures that carry no real names)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "sec07-gateway-conformance-jwt-secret";
const TEST_PASSWORD: &str = "sec07-gateway-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
/// Passes `is_unsafe_secret()` (no `change-me` / `example` / `placeholder`
/// substring), so `legacy_secret_enabled()` can be true when a test asks for it.
const GATEWAY_SECRET: &str = "sec07-gateway-shared-4d8f1c7a2b9e";
const CENT_TOKEN_HMAC: &str = "sec07-gateway-centrifugo-token-hmac";
const CENT_PROXY_SECRET: &str = "sec07-gateway-centrifugo-proxy-secret";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

fn upper(id: Uuid) -> String {
    id.to_string().to_uppercase()
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
        .max_connections(12)
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
    let roles = PathBuf::from(concat!(
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
        .arg(roles)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

#[derive(Clone, Copy)]
struct ServerOpts {
    /// `MOMO_ALLOW_LEGACY_GATEWAY_SECRET`.
    allow_legacy: bool,
    /// Configure `CENT_TOKEN_HMAC` / `CENT_PROXY_SECRET`.
    realtime: bool,
}

async fn start_server(pool: PgPool, opts: ServerOpts) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: GATEWAY_SECRET.to_string(),
        allow_legacy_secret: opts.allow_legacy,
    });
    if opts.realtime {
        state = state.with_realtime(RealtimeSettings {
            cent_token_hmac: Some(CENT_TOKEN_HMAC.to_string()),
            cent_proxy_secret: Some(CENT_PROXY_SECRET.to_string()),
            connection_token_ttl_seconds: momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
        });
    }
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
// fixtures (superuser → RLS bypassed; fictional people, @example.test)
// ---------------------------------------------------------------------------

struct Tenant {
    workspace: Uuid,
    owner: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, '달무리 스튜디오')")
        .bind(workspace)
        .bind(format!("sec07-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

    let owner = Uuid::new_v4();
    let email = format!("{owner}@example.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', '이도현', $3)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(owner.to_string())
    .execute(su)
    .await
    .expect("seed owner member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed owner auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner'::membership_role)",
    )
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed owner membership");

    // `create_channel` seeds the creator's `membership`, so the owner is in the
    // room — the authority a mention, an approval decision and a message need.
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("sec07-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;

    Tenant {
        workspace,
        owner,
        email,
        channel,
    }
}

/// An agent member **already in the channel**, with the handle a mention names.
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
    .bind(tenant.owner)
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
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(tenant.workspace)
        .bind(tenant.channel)
        .bind(agent)
        .execute(su)
        .await
        .expect("join channel");
    agent
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn login(http: &reqwest::Client, base: &str, tenant: &Tenant) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": tenant.email,
            "password": TEST_PASSWORD,
            "workspace": tenant.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "the seeded owner logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

/// One agent plus the bearer an owner issued for it.
struct Agent {
    id: Uuid,
    bearer: String,
    credential: Uuid,
}

struct Rig {
    su: PgPool,
    base: String,
    http: reqwest::Client,
    tenant: Tenant,
    owner_jwt: String,
    /// The agent the tests mention (`@hermes`).
    hermes: Agent,
    /// A second agent in the same channel with its own bearer.
    scout: Agent,
}

/// `POST …/agents/{agent}/credentials` as the owner; returns the full body.
async fn issue_credential(
    http: &reqwest::Client,
    base: &str,
    owner_jwt: &str,
    tenant: &Tenant,
    agent: Uuid,
    body: Value,
) -> Value {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/credentials",
            tenant.workspace
        ))
        .bearer_auth(owner_jwt)
        .json(&body)
        .send()
        .await
        .expect("issue credential");
    let status = response.status();
    let body: Value = response.json().await.expect("credential body");
    assert_eq!(
        status, 201,
        "an owner may issue a generic credential: {body}"
    );
    body
}

async fn issued_agent(
    http: &reqwest::Client,
    base: &str,
    owner_jwt: &str,
    tenant: &Tenant,
    agent: Uuid,
) -> Agent {
    let issued = issue_credential(http, base, owner_jwt, tenant, agent, json!({})).await;
    Agent {
        id: agent,
        bearer: issued["token"]
            .as_str()
            .expect("one-time token")
            .to_string(),
        credential: Uuid::parse_str(issued["credential"]["id"].as_str().expect("credential id"))
            .expect("credential uuid"),
    }
}

async fn rig(opts: ServerOpts) -> Rig {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let hermes_id = seed_channel_agent(&su, &tenant, "hermes").await;
    let scout_id = seed_channel_agent(&su, &tenant, "scout").await;
    let base = start_server(app, opts).await;
    let http = reqwest::Client::new();
    let owner_jwt = login(&http, &base, &tenant).await;
    let hermes = issued_agent(&http, &base, &owner_jwt, &tenant, hermes_id).await;
    let scout = issued_agent(&http, &base, &owner_jwt, &tenant, scout_id).await;
    Rig {
        su,
        base,
        http,
        tenant,
        owner_jwt,
        hermes,
        scout,
    }
}

const STRICT: ServerOpts = ServerOpts {
    allow_legacy: false,
    realtime: false,
};

async fn call(request: reqwest::RequestBuilder) -> (u16, Value) {
    let response = request.send().await.expect("send");
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

fn error_message(body: &Value) -> String {
    body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn pending_url(rig: &Rig, agent: Uuid) -> String {
    format!(
        "{}/v1/workspaces/{}/agents/{agent}/gateway/jobs/pending",
        rig.base, rig.tenant.workspace
    )
}

fn lease_url(rig: &Rig, agent: Uuid, job: i64, verb: &str) -> String {
    format!(
        "{}/v1/workspaces/{}/agents/{agent}/gateway/jobs/{job}/lease/{verb}",
        rig.base, rig.tenant.workspace
    )
}

fn run_url(rig: &Rig, run: Uuid, verb: &str) -> String {
    format!(
        "{}/v1/workspaces/{}/agent-runs/{run}/gateway/{verb}",
        rig.base, rig.tenant.workspace
    )
}

/// `GET …/gateway/jobs/pending` with `agent`'s bearer; asserts 200, returns `jobs`.
async fn claim(rig: &Rig, caller: &Agent, target: Uuid) -> Vec<Value> {
    let (status, body) = call(
        rig.http
            .get(pending_url(rig, target))
            .bearer_auth(&caller.bearer),
    )
    .await;
    assert_eq!(status, 200, "pending jobs: {body}");
    body["jobs"].as_array().expect("jobs array").clone()
}

fn lease_body(job: &Value) -> Value {
    json!({"job_id": job["id"], "lease_id": job["leaseId"]})
}

fn event_body(job: &Value, status: &str, event_id: Uuid) -> Value {
    let mut body = lease_body(job);
    body["status"] = json!(status);
    body["event_id"] = json!(event_id.to_string());
    body
}

async fn post_event(rig: &Rig, caller: &Agent, run: Uuid, body: Value) -> (u16, Value) {
    call(
        rig.http
            .post(run_url(rig, run, "events"))
            .bearer_auth(&caller.bearer)
            .json(&body),
    )
    .await
}

async fn post_complete(rig: &Rig, caller: &Agent, run: Uuid, body: Value) -> (u16, Value) {
    call(
        rig.http
            .post(run_url(rig, run, "complete"))
            .bearer_auth(&caller.bearer)
            .json(&body),
    )
    .await
}

/// An owner message that @mentions `handle`; returns `(message id, run id)`.
async fn mention(rig: &Rig, handle: &str) -> (Uuid, Uuid) {
    let (status, sent) = call(
        rig.http
            .post(format!(
                "{}/v1/workspaces/{}/channels/{}/messages",
                rig.base, rig.tenant.workspace, rig.tenant.channel
            ))
            .bearer_auth(&rig.owner_jwt)
            .json(&json!({
                "clientMsgId": Uuid::new_v4(),
                "body": format!("@{handle} 배포 상태 알려줘"),
            })),
    )
    .await;
    assert_eq!(status, 201, "a send answers 201: {sent}");
    let message = Uuid::parse_str(sent["id"].as_str().expect("message id")).expect("uuid");
    let run: Uuid = sqlx::query_scalar(
        "SELECT id FROM agent_run WHERE workspace_id = $1 AND trigger_message_id = $2",
    )
    .bind(rig.tenant.workspace)
    .bind(message)
    .fetch_one(&rig.su)
    .await
    .expect("the mention created exactly one run");
    (message, run)
}

/// A mention, then a claim by the agent's own bearer: `(run id, claimed job)`.
async fn started(rig: &Rig, agent: &Agent, handle: &str) -> (Uuid, Value) {
    let (_, run) = mention(rig, handle).await;
    let jobs = claim(rig, agent, agent.id).await;
    assert_eq!(jobs.len(), 1, "one mention, one claimable job: {jobs:?}");
    (run, jobs[0].clone())
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

/// `(id, method, status, lease_owner)` of every agent job queued for `agent`.
async fn job_rows(rig: &Rig, agent: Uuid) -> Vec<(i64, String, String, Option<Uuid>)> {
    sqlx::query_as(
        "SELECT id, method, status::text, lease_owner FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' AND partition_key = $2 \
          ORDER BY id",
    )
    .bind(rig.tenant.workspace)
    .bind(agent)
    .fetch_all(&rig.su)
    .await
    .expect("read agent jobs")
}

async fn job_status(rig: &Rig, job: i64) -> (String, Option<Uuid>) {
    sqlx::query_as("SELECT status::text, lease_owner FROM outbox WHERE id = $1")
        .bind(job)
        .fetch_one(&rig.su)
        .await
        .expect("read job")
}

async fn run_status(rig: &Rig, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(&rig.su)
        .await
        .expect("read run status")
}

/// Every `agent.status` / `agent.partial` frame the run produced, oldest first.
async fn run_frames(rig: &Rig, run: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' IN ('agent.status', 'agent.partial') \
            AND lower(payload->'data'->'payload'->>'run_id') = lower($2::text) \
          ORDER BY id",
    )
    .bind(rig.tenant.workspace)
    .bind(run.to_string())
    .fetch_all(&rig.su)
    .await
    .expect("read run frames")
}

/// `(via_token_id, detail)` of every audit row `action` wrote for `run`.
async fn run_audits(rig: &Rig, run: Uuid, action: &str) -> Vec<(Option<Uuid>, Value)> {
    sqlx::query_as(
        "SELECT via_token_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND run_id = $2 AND action = $3 \
          ORDER BY created_at",
    )
    .bind(rig.tenant.workspace)
    .bind(run)
    .bind(action)
    .fetch_all(&rig.su)
    .await
    .expect("read audits")
}

async fn agent_messages(rig: &Rig, agent: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(rig.tenant.workspace)
    .bind(agent)
    .fetch_one(&rig.su)
    .await
    .expect("count agent messages")
}

// ---------------------------------------------------------------------------
// G1 — the REST gateway door with an issued bearer
// ---------------------------------------------------------------------------

/// **A mention leaves one pending `gateway` job and rings a private doorbell.**
///
/// Map rows 19-22: the job's `method` is `gateway` (the worker's claim is
/// `publish` exactly), it starts `pending` and unleased, and the one wake-up
/// broadcast goes to `agentwork:ws<WS>.<AGENT>` — the private namespace only the
/// agent itself may subscribe to — carrying the job's outbox id.
///
/// Goes red if the job is enqueued as `publish` (the gateway never sees it), if
/// it is born leased or non-pending, if the doorbell moves to the observable
/// `agent:` namespace, or if the doorbell stops naming the job.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_1_a_mention_queues_a_pending_gateway_job_and_a_private_doorbell() {
    let rig = rig(STRICT).await;
    let (_, run) = mention(&rig, "hermes").await;

    let jobs = job_rows(&rig, rig.hermes.id).await;
    assert_eq!(jobs.len(), 1, "one mention, one job: {jobs:?}");
    let (job_id, method, status, lease_owner) = jobs[0].clone();
    assert_eq!(
        method, "gateway",
        "the gateway door can only claim `gateway`"
    );
    assert_eq!(status, "pending");
    assert_eq!(lease_owner, None, "nobody holds a job nobody has claimed");
    let job_payload: Value = sqlx::query_scalar("SELECT payload FROM outbox WHERE id = $1")
        .bind(job_id)
        .fetch_one(&rig.su)
        .await
        .expect("job payload");
    assert_eq!(
        job_payload["run_id"].as_str().map(str::to_lowercase),
        Some(run.to_string()),
        "the job names the run it carries"
    );

    let bells: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'agent.job' \
          ORDER BY id",
    )
    .bind(rig.tenant.workspace)
    .fetch_all(&rig.su)
    .await
    .expect("read doorbells");
    assert_eq!(bells.len(), 1, "the doorbell rings once: {bells:?}");
    assert_eq!(
        bells[0]["channel"],
        json!(format!(
            "agentwork:ws{}.{}",
            upper(rig.tenant.workspace),
            upper(rig.hermes.id)
        )),
        "the wake-up goes to the agent's PRIVATE work stream, nowhere observable"
    );
    assert_eq!(
        bells[0]["data"]["payload"]["agent_job_outbox_id"],
        json!(job_id),
        "the bell is a notification that names the durable row, not the work"
    );
    assert_eq!(bells[0]["data"]["seq"], json!(job_id));
}

/// **No bearer, or the legacy secret on an instance that disabled it → 401, and
/// nothing is claimed.**
///
/// Map rows 26-27. The job is queued and claimable by the issued bearer (the
/// control at the end), so each 401 is the door refusing, not an empty queue; the
/// row's lease column is the proof that the refused calls claimed nothing.
///
/// Goes red if `accept_legacy_gateway_secret` stops honouring
/// `allow_legacy_secret`, if a missing credential falls through to a handler, or
/// if the 401 turns into a 200 with a lease.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_2_unauthenticated_and_legacy_off_callers_claim_nothing() {
    let rig = rig(STRICT).await;
    let (_, run) = mention(&rig, "hermes").await;
    let agent = rig.hermes.id;

    let (status, _) = call(rig.http.get(pending_url(&rig, agent))).await;
    assert_eq!(status, 401, "no credential at all");

    let secret = momo_server::auth::GATEWAY_SECRET_HEADER;
    let (status, _) = call(
        rig.http
            .get(pending_url(&rig, agent))
            .header(secret, GATEWAY_SECRET),
    )
    .await;
    assert_eq!(
        status, 401,
        "the right legacy secret is still refused when the flag is off"
    );
    for verb in ["events", "complete"] {
        let (status, _) = call(
            rig.http
                .post(run_url(&rig, run, verb))
                .header(secret, GATEWAY_SECRET)
                .json(&json!({"job_id": 1, "lease_id": Uuid::new_v4(), "status": "running"})),
        )
        .await;
        assert_eq!(status, 401, "{verb} with the legacy secret, flag off");
    }

    let jobs = job_rows(&rig, agent).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].2, "pending");
    assert_eq!(jobs[0].3, None, "the refused callers took no lease");
    assert_eq!(run_status(&rig, run).await, "queued");

    // Control: the same queue, the same URL, a real issued bearer.
    let claimed = claim(&rig, &rig.hermes, agent).await;
    assert_eq!(
        claimed.len(),
        1,
        "the issued bearer reaches the job: {claimed:?}"
    );
}

/// **A future-dated job is not delivered; a claim has exactly one owner and a
/// well-shaped lease.**
///
/// Map rows 23-25. `available_at` in the future hides the job (and leaves it
/// unleased); once due, two concurrent claimers share one job between them
/// (`FOR UPDATE … SKIP LOCKED` + the live-lease predicate), and the winner's
/// `leaseId`/`leaseExpiresAtMs` are the lease the row now carries, thirty
/// seconds out.
///
/// Goes red if the claim ignores `o.available_at <= now()`
/// (`gateway.rs` CLAIMABLE_JOB_PREDICATE), if two claimers can both start the same
/// job, or if the response lease stops matching `lease_owner`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_3_a_future_job_waits_and_a_claim_has_one_owner() {
    let rig = rig(STRICT).await;
    let (_, run) = mention(&rig, "hermes").await;
    let job_id = job_rows(&rig, rig.hermes.id).await[0].0;

    sqlx::query("UPDATE outbox SET available_at = now() + interval '10 minutes' WHERE id = $1")
        .bind(job_id)
        .execute(&rig.su)
        .await
        .expect("push the job into the future");
    let early = claim(&rig, &rig.hermes, rig.hermes.id).await;
    assert!(
        early.is_empty(),
        "a job that is not due is not delivered: {early:?}"
    );
    assert_eq!(
        job_status(&rig, job_id).await,
        ("pending".to_string(), None),
        "…and it was not leased by being looked at"
    );

    sqlx::query("UPDATE outbox SET available_at = now() WHERE id = $1")
        .bind(job_id)
        .execute(&rig.su)
        .await
        .expect("make the job due");
    let (first, second) = tokio::join!(
        claim(&rig, &rig.hermes, rig.hermes.id),
        claim(&rig, &rig.hermes, rig.hermes.id)
    );
    assert_eq!(
        first.len() + second.len(),
        1,
        "two concurrent claimers, one provider start: {first:?} / {second:?}"
    );
    let job = first.into_iter().chain(second).next().expect("the winner");
    assert_eq!(job["id"], json!(job_id));
    assert_eq!(
        job["runId"].as_str().map(str::to_lowercase),
        Some(run.to_string())
    );
    let lease = Uuid::parse_str(job["leaseId"].as_str().expect("leaseId is a string"))
        .expect("leaseId is a uuid");
    let expires = job["leaseExpiresAtMs"]
        .as_i64()
        .expect("leaseExpiresAtMs is a number");
    let left = expires - now_ms();
    assert!(
        (20_000..=40_000).contains(&left),
        "the managed gateway's lease is ~30 s, got {left} ms"
    );
    assert_eq!(
        job_status(&rig, job_id).await,
        ("pending".to_string(), Some(lease)),
        "the response lease is the lease the row carries"
    );
    assert!(
        claim(&rig, &rig.hermes, rig.hermes.id).await.is_empty(),
        "a live lease hides the job from a third claimer"
    );
}

/// **An agent bearer may speak only for its own run, whatever lease it holds.**
///
/// Map rows 28-29. `scout` is handed `hermes`'s *real* `job_id` and `lease_id`, so
/// the only thing standing in the way is the actor binding: its `running` event
/// and its injected `streaming` frame are 403, its `complete` is 403, and its
/// claim against `hermes`'s queue is 403 — and none of it moves the run, writes a
/// frame, an audit row or a message. A body with no lease pair never reaches the
/// binding at all (409), which pins which gate answers first.
///
/// Goes red if `actor_binding` (`agent_gateway.rs`) stops comparing the bearer's
/// member with the run's agent, or `require_actor_is_target_agent` is dropped from
/// `pending`; the 409 line goes red if `lease_binding` is moved behind the
/// transaction.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_4_another_agents_bearer_cannot_touch_the_run() {
    let rig = rig(STRICT).await;
    let (_, run) = mention(&rig, "hermes").await;
    let hermes_job = job_rows(&rig, rig.hermes.id).await[0].0;

    // scout asks for hermes's queue.
    let (status, body) = call(
        rig.http
            .get(pending_url(&rig, rig.hermes.id))
            .bearer_auth(&rig.scout.bearer),
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert!(
        error_message(&body).contains("does not match target agent"),
        "{body}"
    );
    assert_eq!(
        job_status(&rig, hermes_job).await.1,
        None,
        "nothing was leased"
    );

    let claimed = claim(&rig, &rig.hermes, rig.hermes.id).await;
    let job = claimed[0].clone();

    for (status_word, delta) in [("running", None), ("streaming", Some("주입한 조각"))] {
        let mut body = event_body(&job, status_word, Uuid::new_v4());
        if let Some(delta) = delta {
            body["text_delta"] = json!(delta);
        }
        let (status, response) = post_event(&rig, &rig.scout, run, body).await;
        assert_eq!(
            status, 403,
            "{status_word} from the wrong agent: {response}"
        );
        assert!(
            error_message(&response).contains("does not match run agent"),
            "{response}"
        );
    }
    let mut complete = lease_body(&job);
    complete["status"] = json!("succeeded");
    complete["body"] = json!("가로챈 답");
    let (status, response) = post_complete(&rig, &rig.scout, run, complete).await;
    assert_eq!(status, 403, "{response}");

    assert_eq!(
        run_status(&rig, run).await,
        "queued",
        "the run did not move"
    );
    assert!(
        run_frames(&rig, run)
            .await
            .iter()
            .all(|frame| frame["data"]["payload"]["phase"] == json!("queued")),
        "only the opening frame exists; nothing was injected"
    );
    assert!(run_audits(&rig, run, "agent.gateway.status")
        .await
        .is_empty());
    assert_eq!(agent_messages(&rig, rig.hermes.id).await, 0);
    assert_eq!(agent_messages(&rig, rig.scout.id).await, 0);

    // No lease pair: the lease gate answers before the actor binding does.
    let (status, response) = post_event(
        &rig,
        &rig.scout,
        run,
        json!({"status": "running", "event_id": Uuid::new_v4().to_string()}),
    )
    .await;
    assert_eq!(status, 409, "{response}");
    assert_eq!(
        error_message(&response),
        "gateway job lease is expired or not owned"
    );

    // Control: the rightful agent, same job, same body shape, is accepted.
    let (status, response) = post_event(
        &rig,
        &rig.hermes,
        run,
        event_body(&job, "running", Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 200, "{response}");
    assert_eq!(response["status"], json!("accepted"));
    assert_eq!(run_status(&rig, run).await, "running");
}

/// **Event bounds, the rail's frames, and event-id idempotency.**
///
/// Map rows 32-35. `text_delta` is capped in *bytes* (8192 passes, 8193 is a 400
/// that writes nothing), `detail` at 2048. A `thinking` and a `streaming` event
/// produce exactly two `agent.status` frames (phases in order, `run_status:
/// running`) and one `agent.partial` carrying the delta, all on the observable
/// `agent:ws<WS>.<CH>.<AGENT>` channel and none on `agentwork:`; replaying an
/// event id adds neither a frame nor an audit row.
///
/// Goes red if `bounded` (`agent_gateway.rs`) changes either cap or stops being a
/// byte count, if the progress/partial emit is dropped or re-keyed, if a frame is
/// published on the private namespace, or if `run_event_recorded` stops
/// de-duplicating.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_5_event_bounds_frames_and_replay() {
    let rig = rig(STRICT).await;
    let (run, job) = started(&rig, &rig.hermes, "hermes").await;
    let ws = rig.tenant.workspace;

    // Over the caps → 400, before anything is stored.
    let mut too_long = event_body(&job, "streaming", Uuid::new_v4());
    too_long["text_delta"] = json!("a".repeat(8193));
    let (status, body) = post_event(&rig, &rig.hermes, run, too_long).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(error_message(&body), "text_delta is too large");
    let mut wordy = event_body(&job, "thinking", Uuid::new_v4());
    wordy["detail"] = json!("가".repeat(683)); // 683 × 3 bytes = 2049
    let (status, body) = post_event(&rig, &rig.hermes, run, wordy).await;
    assert_eq!(
        status, 400,
        "detail is capped in bytes, not characters: {body}"
    );
    assert_eq!(
        run_status(&rig, run).await,
        "queued",
        "a refused event moves nothing"
    );
    assert!(run_audits(&rig, run, "agent.gateway.status")
        .await
        .is_empty());

    // Exactly at the cap → accepted.
    let thinking = Uuid::new_v4();
    let streaming = Uuid::new_v4();
    let delta = "a".repeat(8192);
    let (status, body) = post_event(
        &rig,
        &rig.hermes,
        run,
        event_body(&job, "thinking", thinking),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let mut stream = event_body(&job, "streaming", streaming);
    stream["text_delta"] = json!(delta);
    let (status, body) = post_event(&rig, &rig.hermes, run, stream.clone()).await;
    assert_eq!(status, 200, "8192 bytes is the cap, not over it: {body}");
    // A retry of the same event id is acknowledged and changes nothing.
    let (status, body) = post_event(&rig, &rig.hermes, run, stream).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], json!("accepted"));

    assert_eq!(run_status(&rig, run).await, "running");
    let frames = run_frames(&rig, run).await;
    let statuses: Vec<&Value> = frames
        .iter()
        .filter(|f| {
            f["data"]["type"] == json!("agent.status")
                && matches!(
                    f["data"]["payload"]["phase"].as_str(),
                    Some("thinking" | "streaming")
                )
        })
        .collect();
    let phases: Vec<&str> = statuses
        .iter()
        .map(|f| f["data"]["payload"]["phase"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        phases,
        ["thinking", "streaming"],
        "one frame per event: {frames:?}"
    );
    assert!(statuses
        .iter()
        .all(|f| f["data"]["payload"]["run_status"] == json!("running")));
    let partials: Vec<&Value> = frames
        .iter()
        .filter(|f| f["data"]["type"] == json!("agent.partial"))
        .collect();
    assert_eq!(
        partials.len(),
        1,
        "the replayed event added no second partial"
    );
    assert_eq!(partials[0]["data"]["payload"]["text_delta"], json!(delta));
    let observable = format!(
        "agent:ws{}.{}.{}",
        upper(ws),
        upper(rig.tenant.channel),
        upper(rig.hermes.id)
    );
    assert!(
        frames.iter().all(|f| f["channel"] == json!(observable)),
        "every progress frame is on the observable namespace, none on agentwork: {frames:?}"
    );

    let audits = run_audits(&rig, run, "agent.gateway.status").await;
    assert_eq!(audits.len(), 2, "the retry wrote no third row: {audits:?}");
    let ids: Vec<&str> = audits
        .iter()
        .map(|(_, detail)| detail["event_id"].as_str().unwrap_or_default())
        .collect();
    assert!(ids.contains(&thinking.to_string().as_str()));
    assert!(ids.contains(&streaming.to_string().as_str()));
}

/// **Complete: seq, replay, the message, the bill, and an audit trail that names
/// the issued credential.**
///
/// Map rows 36-37, 39, 40-44. The response carries the new message's `seq`; the
/// same completion replayed answers the same `messageId`/`seq` and writes
/// nothing; the message is the agent's, bound to the run, with the body the agent
/// sent; one `message.new` broadcast carries that seq; the ledger has one row
/// with the reported tokens; the job is `done`; and every `agent.gateway.status`
/// / `agent.gateway.completed` audit row carries `via_token_id` = the credential
/// the bearer was issued from.
///
/// Usage is sent snake_case on purpose: `AgentGatewayUsageDto` accepts only that
/// spelling today (its camelCase `alias` is a no-op), which is recorded in the
/// SEC-07 report rather than pinned here.
///
/// Goes red if `complete` stops returning `seq`, a replay writes a second
/// message/ledger row, the message loses `run_id`/author/body, the audit rows lose
/// `via_token(..)`, or the job is not settled.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_6_complete_returns_a_replayable_seq_and_an_attributable_audit() {
    let rig = rig(STRICT).await;
    let (run, job) = started(&rig, &rig.hermes, "hermes").await;
    let ws = rig.tenant.workspace;

    let (status, _) = post_event(
        &rig,
        &rig.hermes,
        run,
        event_body(&job, "thinking", Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 200);
    let mut stream = event_body(&job, "streaming", Uuid::new_v4());
    stream["text_delta"] = json!("확인 중입니다");
    let (status, _) = post_event(&rig, &rig.hermes, run, stream).await;
    assert_eq!(status, 200);

    let mut done = lease_body(&job);
    done["status"] = json!("succeeded");
    done["body"] = json!("  스테이징은 정상입니다.  ");
    done["usage"] = json!({"prompt_tokens": 11, "completion_tokens": 5});
    let (status, first) = post_complete(&rig, &rig.hermes, run, done.clone()).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["status"], json!("succeeded"));
    assert_eq!(
        first["runId"].as_str().map(str::to_lowercase),
        Some(run.to_string())
    );
    let message_id =
        Uuid::parse_str(first["messageId"].as_str().expect("messageId")).expect("uuid");
    let seq = first["seq"]
        .as_i64()
        .expect("a non-empty answer reports its seq");

    // The same completion again: same answer, nothing new.
    let (status, replay) = post_complete(&rig, &rig.hermes, run, done).await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay["messageId"], first["messageId"]);
    assert_eq!(replay["seq"], first["seq"], "a retry gets the same seq");
    assert_eq!(
        agent_messages(&rig, rig.hermes.id).await,
        1,
        "one answer, not two"
    );

    let (body, author, bound_run, row_seq): (String, Uuid, Option<Uuid>, i64) =
        sqlx::query_as("SELECT body, author_member_id, run_id, seq FROM message WHERE id = $1")
            .bind(message_id)
            .fetch_one(&rig.su)
            .await
            .expect("the answer row");
    assert_eq!(body, "스테이징은 정상입니다.");
    assert_eq!(author, rig.hermes.id);
    assert_eq!(bound_run, Some(run), "the answer is bound to its run");
    assert_eq!(row_seq, seq);

    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'message.new' \
            AND (payload->'data'->>'seq')::bigint = $2",
    )
    .bind(ws)
    .bind(seq)
    .fetch_one(&rig.su)
    .await
    .expect("count message.new");
    assert_eq!(broadcasts, 1, "the answer is published exactly once");

    let (rows, prompt, completion): (i64, i32, i32) = sqlx::query_as(
        "SELECT count(*), COALESCE(max(prompt_tokens), -1), COALESCE(max(completion_tokens), -1) \
           FROM usage_ledger WHERE run_id = $1",
    )
    .bind(run)
    .fetch_one(&rig.su)
    .await
    .expect("ledger");
    assert_eq!(
        (rows, prompt, completion),
        (1, 11, 5),
        "billed once, as reported"
    );

    assert_eq!(run_status(&rig, run).await, "succeeded");
    assert_eq!(
        job_status(&rig, job["id"].as_i64().expect("job id"))
            .await
            .0,
        "done"
    );

    let via = Some(rig.hermes.credential);
    let status_rows = run_audits(&rig, run, "agent.gateway.status").await;
    assert_eq!(status_rows.len(), 2);
    let completed = run_audits(&rig, run, "agent.gateway.completed").await;
    assert_eq!(completed.len(), 1, "a replay is not a second completion");
    assert!(
        status_rows
            .iter()
            .chain(completed.iter())
            .all(|(token, _)| *token == via),
        "every gateway audit row is attributable to the issued credential: \
         {status_rows:?} {completed:?}"
    );
}

/// **A human hold and a settled run close the door on late callbacks.**
///
/// Map rows 49, 85, 86. A run parked for approval answers `complete` and `event`
/// with 409 and leaves everything as it was. A run that was cancelled while the
/// gateway still held its lease accepts the `cancelled` acknowledgement (200) but
/// can be neither resumed by a `running` event nor completed afterwards (409), and
/// stays `cancelled` with no answer and no bill.
///
/// Goes red if the approval-hold check in `complete`/`record_gateway_event_in_tx`
/// is dropped, if `allow_settled` stops widening only the `cancelled` pair, or if
/// the "already terminal" refusal is lost (a late completion would bill and answer
/// a rejected run).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_7_an_approval_hold_and_a_cancelled_run_refuse_late_callbacks() {
    let rig = rig(STRICT).await;

    // ---- parked for a human decision ---------------------------------------
    let (held, held_job) = started(&rig, &rig.hermes, "hermes").await;
    sqlx::query("UPDATE agent_run SET status = 'awaiting_approval' WHERE id = $1")
        .bind(held)
        .execute(&rig.su)
        .await
        .expect("park the run");
    let mut done = lease_body(&held_job);
    done["status"] = json!("succeeded");
    done["body"] = json!("사람이 정하기 전에 보낸 답");
    let (status, body) = post_complete(&rig, &rig.hermes, held, done).await;
    assert_eq!(status, 409, "{body}");
    assert!(
        error_message(&body).contains("requires a human approval decision"),
        "{body}"
    );
    let (status, body) = post_event(
        &rig,
        &rig.hermes,
        held,
        event_body(&held_job, "running", Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(
        error_message(&body).contains("awaiting a human approval decision"),
        "{body}"
    );
    assert_eq!(run_status(&rig, held).await, "awaiting_approval");
    assert_eq!(agent_messages(&rig, rig.hermes.id).await, 0);
    let billed: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(held)
        .fetch_one(&rig.su)
        .await
        .expect("ledger");
    assert_eq!(billed, 0, "a parked run is not billed");

    // ---- cancelled while the gateway still holds its lease ------------------
    let (_, cancelled) = mention(&rig, "hermes").await;
    let jobs = claim(&rig, &rig.hermes, rig.hermes.id).await;
    assert_eq!(jobs.len(), 1, "only the second job is unleased: {jobs:?}");
    let job = jobs[0].clone();
    assert_eq!(
        job["runId"].as_str().map(str::to_lowercase),
        Some(cancelled.to_string())
    );
    let (status, _) = post_event(
        &rig,
        &rig.hermes,
        cancelled,
        event_body(&job, "running", Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 200);
    sqlx::query("UPDATE agent_run SET status = 'cancelled', finished_at = now() WHERE id = $1")
        .bind(cancelled)
        .execute(&rig.su)
        .await
        .expect("cancel the run");

    let (status, body) = post_event(
        &rig,
        &rig.hermes,
        cancelled,
        event_body(&job, "cancelled", Uuid::new_v4()),
    )
    .await;
    assert_eq!(
        status, 200,
        "the cancellation acknowledgement is accepted: {body}"
    );
    let (status, body) = post_event(
        &rig,
        &rig.hermes,
        cancelled,
        event_body(&job, "running", Uuid::new_v4()),
    )
    .await;
    assert_eq!(
        status, 409,
        "a late progress event cannot resume the run: {body}"
    );
    assert!(error_message(&body).contains("already terminal"), "{body}");
    let mut late = lease_body(&job);
    late["status"] = json!("succeeded");
    late["body"] = json!("거부된 뒤에 도착한 답");
    let (status, body) = post_complete(&rig, &rig.hermes, cancelled, late).await;
    assert_eq!(status, 409, "{body}");
    assert!(
        error_message(&body).contains("already terminal (cancelled)"),
        "{body}"
    );

    assert_eq!(
        run_status(&rig, cancelled).await,
        "cancelled",
        "the state did not move"
    );
    assert_eq!(
        agent_messages(&rig, rig.hermes.id).await,
        0,
        "no late answer"
    );
    let billed: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(cancelled)
        .fetch_one(&rig.su)
        .await
        .expect("ledger");
    assert_eq!(
        billed, 0,
        "a cancelled run is not billed by a late completion"
    );
}

/// **An expired lease is taken over, and the old owner is locked out.**
///
/// Map rows 88-91, 93, 96-97. A live lease hides the job from a second claim; a
/// forged lease id cannot renew it; once the lease has lapsed the next claim takes
/// the *same* job under a new lease; the previous owner's `renew`, `event` and
/// `complete` are all 409 and change nothing; the new owner renews (200) and
/// completes, and the job ends `done` rather than pending forever.
///
/// Goes red if the claim drops `lease_expires_at <= now()` (no takeover), if
/// `renew_gateway_lease_in_tx` / `lock_gateway_lease_in_tx` stop requiring
/// `lease_owner = <presented>` (the old owner keeps working), or if completion no
/// longer settles the taken-over job.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_8_a_lapsed_lease_is_taken_over_and_the_old_owner_is_locked_out() {
    let rig = rig(STRICT).await;
    let agent = rig.hermes.id;
    let (run, first) = started(&rig, &rig.hermes, "hermes").await;
    let job_id = first["id"].as_i64().expect("job id");
    let first_lease = Uuid::parse_str(first["leaseId"].as_str().expect("leaseId")).expect("uuid");

    assert!(
        claim(&rig, &rig.hermes, agent).await.is_empty(),
        "a live lease hides the job from a second consumer"
    );
    let (status, body) = call(
        rig.http
            .post(lease_url(&rig, agent, job_id, "renew"))
            .bearer_auth(&rig.hermes.bearer)
            .json(&json!({"job_id": job_id, "lease_id": Uuid::new_v4()})),
    )
    .await;
    assert_eq!(status, 409, "a forged lease id cannot renew: {body}");
    let (status, body) = call(
        rig.http
            .post(lease_url(&rig, agent, job_id, "renew"))
            .bearer_auth(&rig.hermes.bearer)
            .json(&lease_body(&first)),
    )
    .await;
    assert_eq!(status, 200, "the owner renews: {body}");
    assert_eq!(body["status"], json!("renewed"));
    assert!(body["leaseExpiresAtMs"].as_i64().expect("new expiry") > now_ms());

    // The lease lapses (a crashed consumer): the next claim takes the same job.
    sqlx::query("UPDATE outbox SET lease_expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(job_id)
        .execute(&rig.su)
        .await
        .expect("lapse the lease");
    let retaken = claim(&rig, &rig.hermes, agent).await;
    assert_eq!(
        retaken.len(),
        1,
        "the lapsed job is deliverable again: {retaken:?}"
    );
    assert_eq!(
        retaken[0]["id"],
        json!(job_id),
        "the same job, not a new one"
    );
    let second_lease =
        Uuid::parse_str(retaken[0]["leaseId"].as_str().expect("leaseId")).expect("uuid");
    assert_ne!(second_lease, first_lease, "a takeover mints a fresh lease");

    // The previous owner is locked out of every callback.
    let (status, _) = call(
        rig.http
            .post(lease_url(&rig, agent, job_id, "renew"))
            .bearer_auth(&rig.hermes.bearer)
            .json(&lease_body(&first)),
    )
    .await;
    assert_eq!(status, 409, "the old lease cannot renew");
    let (status, _) = post_event(
        &rig,
        &rig.hermes,
        run,
        event_body(&first, "running", Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 409, "the old lease cannot report progress");
    let mut stale = lease_body(&first);
    stale["status"] = json!("succeeded");
    stale["body"] = json!("옛 소비자의 답");
    let (status, _) = post_complete(&rig, &rig.hermes, run, stale).await;
    assert_eq!(status, 409, "the old lease cannot complete");
    assert_eq!(
        run_status(&rig, run).await,
        "queued",
        "none of it moved the run"
    );
    assert_eq!(agent_messages(&rig, agent).await, 0);

    // The new owner finishes the work.
    let mut done = lease_body(&retaken[0]);
    done["status"] = json!("succeeded");
    done["body"] = json!("인수한 소비자의 답");
    let (status, body) = post_complete(&rig, &rig.hermes, run, done).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(run_status(&rig, run).await, "succeeded");
    assert_eq!(
        job_status(&rig, job_id).await.0,
        "done",
        "a taken-over job is settled, not pending forever"
    );
}

/// **Only the owner can release, and a release hands the job straight back.**
///
/// Map rows 92, 94-95. A forged lease id cannot release (409, lease untouched);
/// the owner's release is 200 with no `leaseExpiresAtMs`, clears `lease_owner`
/// while the row stays `pending`, and the very next claim gets the same job under
/// a new lease — without waiting out the thirty seconds.
///
/// Goes red if `release_gateway_lease_in_tx` drops `lease_owner = $4` (anyone can
/// release), if a release leaves the lease columns set, or if the response starts
/// carrying an expiry.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_9_only_the_owner_releases_and_a_release_returns_the_job() {
    let rig = rig(STRICT).await;
    let agent = rig.hermes.id;
    let (_, first) = started(&rig, &rig.hermes, "hermes").await;
    let job_id = first["id"].as_i64().expect("job id");
    let first_lease = Uuid::parse_str(first["leaseId"].as_str().expect("leaseId")).expect("uuid");

    let (status, body) = call(
        rig.http
            .post(lease_url(&rig, agent, job_id, "release"))
            .bearer_auth(&rig.hermes.bearer)
            .json(&json!({"job_id": job_id, "lease_id": Uuid::new_v4()})),
    )
    .await;
    assert_eq!(status, 409, "a non-owner cannot release: {body}");
    assert_eq!(
        job_status(&rig, job_id).await,
        ("pending".to_string(), Some(first_lease)),
        "the refused release left the owner's lease alone"
    );

    let (status, body) = call(
        rig.http
            .post(lease_url(&rig, agent, job_id, "release"))
            .bearer_auth(&rig.hermes.bearer)
            .json(&lease_body(&first)),
    )
    .await;
    assert_eq!(status, 200, "the owner releases: {body}");
    assert_eq!(body["status"], json!("released"));
    assert_eq!(body["leaseId"], first["leaseId"]);
    assert!(
        body.get("leaseExpiresAtMs").is_none(),
        "a released lease has no expiry to report: {body}"
    );
    assert_eq!(
        job_status(&rig, job_id).await,
        ("pending".to_string(), None),
        "released, and still deliverable"
    );

    let again = claim(&rig, &rig.hermes, agent).await;
    assert_eq!(
        again.len(),
        1,
        "the released job is claimable at once: {again:?}"
    );
    assert_eq!(again[0]["id"], json!(job_id));
    assert_ne!(again[0]["leaseId"], first["leaseId"], "under a new lease");
    let (status, _) = call(
        rig.http
            .post(lease_url(&rig, agent, job_id, "renew"))
            .bearer_auth(&rig.hermes.bearer)
            .json(&lease_body(&first)),
    )
    .await;
    assert_eq!(status, 409, "the released lease is dead");
}

/// **With the flag on, the legacy secret still works — and its audit trail has no
/// token.**
///
/// Map row 100. Claim, event and complete succeed with only the shared secret
/// header; the resulting `agent.gateway.status` / `agent.gateway.completed` rows
/// have `via_token_id IS NULL` (the secret names a process, not a credential).
///
/// Goes red if the opt-in stops admitting the secret, or if an audit row starts
/// attributing a secret call to some token.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g1_10_the_legacy_secret_leaves_no_token_on_the_audit_rows() {
    let rig = rig(ServerOpts {
        allow_legacy: true,
        realtime: false,
    })
    .await;
    let secret = momo_server::auth::GATEWAY_SECRET_HEADER;
    let (_, run) = mention(&rig, "hermes").await;

    let (status, body) = call(
        rig.http
            .get(pending_url(&rig, rig.hermes.id))
            .header(secret, GATEWAY_SECRET),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let job = body["jobs"][0].clone();
    assert!(job["id"].is_i64(), "the secret claimed the job: {body}");

    let (status, body) = call(
        rig.http
            .post(run_url(&rig, run, "events"))
            .header(secret, GATEWAY_SECRET)
            .json(&event_body(&job, "running", Uuid::new_v4())),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let mut done = lease_body(&job);
    done["status"] = json!("succeeded");
    done["body"] = json!("레거시 비밀로 보낸 답");
    let (status, body) = call(
        rig.http
            .post(run_url(&rig, run, "complete"))
            .header(secret, GATEWAY_SECRET)
            .json(&done),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    let status_rows = run_audits(&rig, run, "agent.gateway.status").await;
    let completed = run_audits(&rig, run, "agent.gateway.completed").await;
    assert_eq!((status_rows.len(), completed.len()), (1, 1));
    assert!(
        status_rows
            .iter()
            .chain(completed.iter())
            .all(|(token, _)| token.is_none()),
        "the shared secret is not a credential: {status_rows:?} {completed:?}"
    );
}

// ---------------------------------------------------------------------------
// G2 — credential issuance, rotation and scope at the message door
// ---------------------------------------------------------------------------

/// **Issuance records the issuer, counts rotations, and defaults to a 24 h grace.**
///
/// Map rows 2, 12, 13. The first credential of an agent rotates nothing (count 0,
/// no grace end); the second, issued with no `rotationGraceSeconds`, rotates
/// exactly one predecessor, reports a grace end, and that predecessor now expires
/// about 24 hours out — while the new credential has no expiry. Both rows record
/// the issuing owner in `token.created_by`.
///
/// Goes red if `created_by` stops being bound (`agent_credential.rs`
/// `issue_agent_credential_in_tx`), if `rotated_credential_count` stops counting
/// the `rotated` CTE, or if the default grace changes
/// (`validated_rotation_grace_seconds(None)`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g2_1_issue_records_the_issuer_counts_rotation_and_defaults_to_a_day() {
    let rig = rig(STRICT).await;
    let archivist = seed_channel_agent(&rig.su, &rig.tenant, "archivist").await;

    let first = issue_credential(
        &rig.http,
        &rig.base,
        &rig.owner_jwt,
        &rig.tenant,
        archivist,
        json!({}),
    )
    .await;
    assert_eq!(first["rotatedCredentialCount"], json!(0), "{first}");
    assert!(
        first.get("rotationGraceEndsAtMs").is_none(),
        "nothing was rotated, so there is no grace to report: {first}"
    );
    let first_id = Uuid::parse_str(first["credential"]["id"].as_str().expect("id")).expect("uuid");

    let second = issue_credential(
        &rig.http,
        &rig.base,
        &rig.owner_jwt,
        &rig.tenant,
        archivist,
        json!({}),
    )
    .await;
    assert_eq!(second["rotatedCredentialCount"], json!(1), "{second}");
    let second_id =
        Uuid::parse_str(second["credential"]["id"].as_str().expect("id")).expect("uuid");

    for id in [first_id, second_id] {
        let created_by: Option<Uuid> =
            sqlx::query_scalar("SELECT created_by FROM token WHERE id = $1")
                .bind(id)
                .fetch_one(&rig.su)
                .await
                .expect("read created_by");
        assert_eq!(
            created_by,
            Some(rig.tenant.owner),
            "the issuer is on the row"
        );
    }

    let (remaining, expires_ms): (f64, i64) = sqlx::query_as(
        "SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float8, \
                (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint \
           FROM token WHERE id = $1",
    )
    .bind(first_id)
    .fetch_one(&rig.su)
    .await
    .expect("predecessor expiry");
    assert!(
        (82_800.0..=90_000.0).contains(&remaining),
        "the default rotation grace is about 24 h, got {remaining} s"
    );
    let reported = second["rotationGraceEndsAtMs"].as_i64().expect("grace end");
    assert!(
        (reported - expires_ms).abs() <= 1_000,
        "the reported grace end is the predecessor's new expiry: {reported} vs {expires_ms}"
    );
    let successor_expiry: Option<i64> = sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint FROM token WHERE id = $1",
    )
    .bind(second_id)
    .fetch_one(&rig.su)
    .await
    .expect("successor expiry");
    assert_eq!(successor_expiry, None, "the new credential does not expire");
}

/// **A default bearer authors its own message; one without `messages:write` is
/// refused and audited.**
///
/// Map rows 10, 14. `hermes`'s default-scope bearer posts to the channel: 201,
/// `authorMemberId` and the row's author are the agent, never a field of the
/// request. A credential limited to `realtime:subscribe` gets 403 at the same
/// route, writes no message, and leaves exactly one `scope_denied` audit row bound
/// to that credential.
///
/// Goes red if the author stops being the bearer's member (`messages.rs`
/// `author_member_id: principal.member_id`), if `required_agent_scope` stops
/// demanding `messages:write` for the POST, or if the denial stops being audited.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g2_2_a_bearer_authors_as_itself_and_a_scopeless_one_is_refused() {
    let rig = rig(STRICT).await;
    let post = |bearer: String, body: &'static str| {
        let request = rig
            .http
            .post(format!(
                "{}/v1/workspaces/{}/channels/{}/messages",
                rig.base, rig.tenant.workspace, rig.tenant.channel
            ))
            .bearer_auth(bearer)
            .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}));
        call(request)
    };

    let (status, sent) = post(rig.hermes.bearer.clone(), "에이전트가 직접 쓴 글").await;
    assert_eq!(status, 201, "{sent}");
    assert_eq!(sent["authorMemberId"], json!(rig.hermes.id.to_string()));
    let message = Uuid::parse_str(sent["id"].as_str().expect("id")).expect("uuid");
    let author: Uuid = sqlx::query_scalar("SELECT author_member_id FROM message WHERE id = $1")
        .bind(message)
        .fetch_one(&rig.su)
        .await
        .expect("author");
    assert_eq!(author, rig.hermes.id);

    // A bearer that may only subscribe.
    let rook = seed_channel_agent(&rig.su, &rig.tenant, "rook").await;
    let limited = issue_credential(
        &rig.http,
        &rig.base,
        &rig.owner_jwt,
        &rig.tenant,
        rook,
        json!({"scopes": ["realtime:subscribe"]}),
    )
    .await;
    let limited_token = limited["token"].as_str().expect("token").to_string();
    let limited_id =
        Uuid::parse_str(limited["credential"]["id"].as_str().expect("id")).expect("uuid");
    let (status, body) = post(limited_token, "쓸 권한이 없는 글").await;
    assert_eq!(status, 403, "{body}");
    let written: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(rig.tenant.workspace)
    .bind(rook)
    .fetch_one(&rig.su)
    .await
    .expect("count");
    assert_eq!(written, 0, "the refused write left no message");
    let denied: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND via_token_id = $2 \
            AND action = 'auth.agent_bearer.scope_denied'",
    )
    .bind(rig.tenant.workspace)
    .bind(limited_id)
    .fetch_one(&rig.su)
    .await
    .expect("count audits");
    assert_eq!(denied, 1, "the refusal is attributable to the credential");
}

// ---------------------------------------------------------------------------
// G3 — the private agentwork stream, at the subscribe proxy
// ---------------------------------------------------------------------------

async fn subscribe(rig: &Rig, user: Uuid, token_id: Uuid, channel: &str) -> (u16, Value) {
    call(
        rig.http
            .post(format!("{}/v1/centrifugo/subscribe", rig.base))
            .header(PROXY_SECRET_HEADER, CENT_PROXY_SECRET)
            .json(&json!({
                "client": Uuid::new_v4().to_string(),
                "user": user.to_string(),
                "channel": channel,
                "meta": {
                    "schema": momo_auth::REALTIME_META_SCHEMA,
                    "token_id": token_id.to_string(),
                },
            })),
    )
    .await
}

fn assert_allow(body: &Value) {
    assert!(
        body.get("result").is_some() && body.get("error").is_none(),
        "expected an allow envelope, got {body}"
    );
}

fn assert_deny(body: &Value, message: &str) {
    assert_eq!(body["error"]["code"], json!(403), "{body}");
    assert_eq!(body["error"]["message"], json!(message), "{body}");
    assert!(body.get("result").is_none(), "{body}");
}

/// **Only the agent itself may subscribe to its `agentwork:` stream.**
///
/// Map rows 8-9, at the proxy (an agent bearer cannot mint the connection token
/// over REST, so the proxy is driven with the `user`/`meta.token_id` Centrifugo
/// would forward). The agent's own credential on its own stream is allowed; the
/// same credential on another agent's stream, another agent's credential claiming
/// this member, and a human session on the stream are all denied — each with the
/// message that says *why*, so a "credential no longer active" cannot pass for the
/// rule under test. A revoked credential is denied on its own stream.
///
/// Goes red if the `AgentWork` arm in `realtime.rs::subscribe` stops requiring
/// `user_member_id == agent_member`, if `has_active_realtime_credential` stops
/// binding the token to the user, or if a revoked agent bearer keeps its stream.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g3_1_the_agentwork_stream_is_private_to_its_agent() {
    let rig = rig(ServerOpts {
        allow_legacy: false,
        realtime: true,
    })
    .await;
    let ws = upper(rig.tenant.workspace);
    let hermes_stream = format!("agentwork:ws{ws}.{}", upper(rig.hermes.id));
    let scout_stream = format!("agentwork:ws{ws}.{}", upper(rig.scout.id));
    let denied = "not allowed to consume this agent work stream";

    let (status, body) =
        subscribe(&rig, rig.hermes.id, rig.hermes.credential, &hermes_stream).await;
    assert_eq!(status, 200, "a proxy decision is always HTTP 200");
    assert_allow(&body);

    let (_, body) = subscribe(&rig, rig.hermes.id, rig.hermes.credential, &scout_stream).await;
    assert_deny(&body, denied);

    // scout's credential cannot be used to speak as hermes.
    let (_, body) = subscribe(&rig, rig.hermes.id, rig.scout.credential, &hermes_stream).await;
    assert_deny(&body, "realtime credential is no longer active");

    // A human session is a live credential, and still not the agent.
    let human_session: Uuid = sqlx::query_scalar(
        "SELECT id FROM token \
          WHERE workspace_id = $1 AND actor_member_id = $2 \
            AND kind = 'session' AND label = 'access' AND revoked_at IS NULL \
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(rig.tenant.workspace)
    .bind(rig.tenant.owner)
    .fetch_one(&rig.su)
    .await
    .expect("the owner's access session");
    let (_, body) = subscribe(&rig, rig.tenant.owner, human_session, &hermes_stream).await;
    assert_deny(&body, denied);

    sqlx::query("UPDATE token SET revoked_at = now() WHERE id = $1")
        .bind(rig.hermes.credential)
        .execute(&rig.su)
        .await
        .expect("revoke hermes's credential");
    let (_, body) = subscribe(&rig, rig.hermes.id, rig.hermes.credential, &hermes_stream).await;
    assert_deny(&body, "realtime credential is no longer active");
}

// ---------------------------------------------------------------------------
// G4 — the approval decision route
// ---------------------------------------------------------------------------

/// A pending `tool_call` approval on a run parked for it.
async fn seed_parked_approval(rig: &Rig, agent: Uuid) -> (Uuid, Uuid, String) {
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1, $2, $3, 'awaiting_approval') RETURNING id",
    )
    .bind(rig.tenant.workspace)
    .bind(agent)
    .bind(rig.tenant.channel)
    .fetch_one(&rig.su)
    .await
    .expect("seed parked run");
    let call_id = format!("sec07-call-{run}");
    let approval: Uuid = sqlx::query_scalar(
        "INSERT INTO approval \
           (workspace_id, run_id, channel_id, requested_by, action_type, payload, \
            status, expires_at) \
         VALUES ($1, $2, $3, $4, 'tool_call', $5, 'pending', now() + interval '1 hour') \
         RETURNING id",
    )
    .bind(rig.tenant.workspace)
    .bind(run)
    .bind(rig.tenant.channel)
    .bind(agent)
    .bind(json!({"tool_call": {
        "call_id": call_id,
        "name": "github.search_issues",
        "arguments": {},
    }}))
    .fetch_one(&rig.su)
    .await
    .expect("seed pending approval");
    (run, approval, call_id)
}

async fn decide(rig: &Rig, approval: Uuid, approve: bool, key: Uuid) -> (u16, Value) {
    call(
        rig.http
            .post(format!(
                "{}/v1/workspaces/{}/approvals/{approval}/decision",
                rig.base, rig.tenant.workspace
            ))
            .bearer_auth(&rig.owner_jwt)
            .json(&json!({
                "approval_id": approval,
                "approve": approve,
                "client_decision_id": key,
            })),
    )
    .await
}

async fn decision_ledger(rig: &Rig, approval: Uuid) -> Vec<(Uuid, Uuid, bool, String)> {
    sqlx::query_as(
        "SELECT client_decision_id, decided_by, approve, status::text \
           FROM approval_decision WHERE workspace_id = $1 AND approval_id = $2",
    )
    .bind(rig.tenant.workspace)
    .bind(approval)
    .fetch_all(&rig.su)
    .await
    .expect("read decision ledger")
}

/// **A decision through the route leaves a ledger row; approval carries the
/// decision into the resume job, rejection cancels the run.**
///
/// Map rows 57, 63, 81. Approve: the receipt says `approved`, the parked run is
/// `queued` again, exactly one `resume_approval` job exists for it and its payload
/// names the approval, the approver, the tool call and an `approval_decision`
/// whose `status` is `approved`; the `approval_decision` ledger holds one row with
/// the caller's `client_decision_id`. Reject: the receipt says `rejected`, the run
/// is exactly `cancelled` (not merely "not awaiting") with the rejection code, no
/// job is created for it, and the ledger row records `approve = false`.
///
/// Goes red if `record_decision_in_tx` is dropped or mis-bound
/// (`approvals.rs` decision transaction), if `resume_job_payload` stops carrying
/// the decision event, if `reject_run` ends the run in any state other than
/// `Cancelled`, or if rejection starts enqueuing a job.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn sec07_g4_1_the_decision_route_records_the_ledger_resumes_or_cancels() {
    let rig = rig(STRICT).await;
    let owner = rig.tenant.owner;

    // ---- approve ------------------------------------------------------------
    let (run, approval, call_id) = seed_parked_approval(&rig, rig.hermes.id).await;
    let key = Uuid::new_v4();
    let (status, receipt) = decide(&rig, approval, true, key).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], json!("approved"));
    assert_eq!(
        run_status(&rig, run).await,
        "queued",
        "the hold is released"
    );

    let jobs: Vec<(String, Value)> = sqlx::query_as(
        "SELECT method, payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' AND payload->>'run_id' = $2",
    )
    .bind(rig.tenant.workspace)
    .bind(run.to_string())
    .fetch_all(&rig.su)
    .await
    .expect("read resume jobs");
    assert_eq!(jobs.len(), 1, "one resume job, not zero or two: {jobs:?}");
    // Rust resumes in-process (`resume_approval`); the Swift `gateway` resume no
    // longer exists. This line records the current contract.
    assert_eq!(jobs[0].0, "resume_approval");
    let payload = &jobs[0].1;
    assert_eq!(
        payload["resume_from_approval_id"],
        json!(approval.to_string())
    );
    assert_eq!(payload["approved_by"], json!(owner.to_string()));
    assert_eq!(payload["approved_tool_call"]["call_id"], json!(call_id));
    assert_eq!(payload["approval_decision"]["status"], json!("approved"));
    assert_eq!(
        payload["approval_decision"]["approval_id"],
        json!(approval.to_string())
    );
    assert_eq!(
        payload["approval_decision"]["decided_by"],
        json!(owner.to_string())
    );
    assert_eq!(
        decision_ledger(&rig, approval).await,
        vec![(key, owner, true, "approved".to_string())],
        "the ledger is the caller's decision, once"
    );

    // ---- reject -------------------------------------------------------------
    let (run, approval, _) = seed_parked_approval(&rig, rig.hermes.id).await;
    let key = Uuid::new_v4();
    let (status, receipt) = decide(&rig, approval, false, key).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], json!("rejected"));
    assert_eq!(
        run_status(&rig, run).await,
        "cancelled",
        "a rejection ends the run as cancelled"
    );
    let (code, rejected_approval): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT error->>'code', error->>'approval_id' FROM agent_run WHERE id = $1")
            .bind(run)
            .fetch_one(&rig.su)
            .await
            .expect("run error");
    assert_eq!(code.as_deref(), Some("approval_rejected"));
    assert_eq!(rejected_approval, Some(approval.to_string()));
    let jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' AND payload->>'run_id' = $2",
    )
    .bind(rig.tenant.workspace)
    .bind(run.to_string())
    .fetch_one(&rig.su)
    .await
    .expect("count jobs");
    assert_eq!(jobs, 0, "a rejection resumes nothing");
    assert_eq!(
        decision_ledger(&rig, approval).await,
        vec![(key, owner, false, "rejected".to_string())]
    );
}
