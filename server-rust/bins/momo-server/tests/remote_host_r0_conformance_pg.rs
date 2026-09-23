//! DB-backed conformance for **ADR-0188 R0** (#2570) — the remote host defended
//! before any phone can reach it.
//!
//! ADR-0188 §1 names the subject: 「원격 host = `scope='member'`인 모든 host」 —
//! somebody's own machine. §1.3 measured what today's code let happen to it and
//! §4's R0 row is the list of refusals that must exist before remote work opens.
//! Each test below is one of that list, driven through the real router (and, for
//! the tool path, the real worker) against a real Postgres, with the server on
//! `momo_app` (NOBYPASSRLS) so every assertion passes through production's
//! policies.
//!
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test remote_host_r0_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | R0 rule (ADR-0188) | the guard whose removal turns it red |
//! |---|---|---|
//! | `r0_1_a_teammate_cannot_decide_work_headed_to_the_owners_host` | D3 결정자 = host 소유자 | the owner check in `routes::approvals::decide_in_tx` |
//! | `r0_2_a_work_host_principal_cannot_decide` | D3 결정 라우트는 사람 principal만 | the `PrincipalKind::Human` check at the top of `routes::approvals::decide` |
//! | `r0_3_an_agent_reaches_a_remote_host_with_kill_only` | D3 에이전트 컨트롤은 kill만 | `momo_t3::work_control::agent_control_allowed` in `work_controls::create_in_tx` |
//! | `r0_4_a_standing_auto_approval_never_reaches_a_remote_host` | D3 원격 host에 `work_auto_approve` 미적용 | the `work_host` scope join in `spawn_is_auto_approved_in_tx` |
//! | `r0_5_a_shell_is_never_spawned_on_a_remote_host` | D6 원격 `shell` 금지 | the shell check in `routes::approvals::decide_in_tx` |
//! | `r0_6_a_replayed_heartbeat_is_refused` | D7 heartbeat v2 · 재전송 거부 | one-time request-id consumption in `work_host_auth::authenticate_signed_host_request` |
//! | `r0_7_a_signed_request_carries_no_query_string` | D7 query 문자열 401 | the `uri.query()` check in `authenticate_signed_host_request` |
//! | `r0_8_the_spawn_tool_refuses_a_remote_host_it_was_not_given` | D3·D6, executor half | the remote-host block in `tool_exec::spawn_session_in_tx` |
//! | `r0_9_a_shell_is_not_resumed_onto_a_remote_host` | D6, resume half | the shell check in `work_sessions::resume_in_tx` |
//!
//! **R0.1** (#2582) — the ways round R0 its security review found:
//!
//! | test | R0.1 item | the guard whose removal turns it red |
//! |---|---|---|
//! | `r01_1_only_a_workspace_admin_registers_a_workspace_host` | Medium: scope as a registration option | the role check in `work_hosts::register` |
//! | `r01_2_an_app_host_is_never_workspace_scoped` | Medium: `type=app` is always remote | `work_hosts::validated_scope_for_type` in `register` |
//! | `r01_3_a_remote_host_is_not_handed_what_r0_would_refuse` | Low 1: rows dispatched before R0 | the member-host clause in `momo_t3::pending_controls_for_host_in_tx` |
//! | `r01_4_a_rejection_is_judged_on_the_card_not_the_pick` | Low 2: the rejecting decider's pick | the reject branch of `approvals::decision_reference_host` |
//!
//! Every refusal test also takes the **legitimate** path at the end — the owner
//! deciding, a team host, a `kill` — so none of them can pass by a route that
//! refuses everything.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_agent_worker::provider::{MockChatProvider, ProviderToolCall};
use momo_agent_worker::tool_exec::{self, ToolContext};
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

const TEST_JWT_SECRET: &str = "r0-remote-host-conformance-secret";
const TEST_PASSWORD: &str = "r0-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
const TOOL: &str = "codex";

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
/// is a **global** claim, so a leftover row from another binary would land in
/// this suite's batch.
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

fn app_state(pool: PgPool) -> AppState {
    AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
}

async fn serve(router: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    format!("http://{address}")
}

async fn start_server(pool: PgPool) -> String {
    serve(build_app(app_state(pool))).await
}

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

/// One workspace, its owner, a channel, and the agent that owner is
/// accountable for — every R0 story is about that person's own laptop.
struct Tenant {
    workspace: Uuid,
    /// The owner: of the workspace, of the agent, and of the laptop.
    owner: Uuid,
    owner_email: String,
    channel: Uuid,
    agent: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@r0.test");
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

/// A tool profile with an explicit launch command. The owner's membership row
/// already seeded 029's four (`claude`, `codex`, `opencode`, `shell` → `sh`)
/// through `work_tool_profile_seed_after_membership`; this makes each one this
/// suite relies on explicit rather than an accident of that trigger.
async fn seed_tool_profile(su: &PgPool, workspace: Uuid, by: Uuid, tool: &str, command: &str) {
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, $2, $2, $3, true, $4, $4) \
         ON CONFLICT (workspace_id, tool_key) \
         DO UPDATE SET enabled = true, launch_template = EXCLUDED.launch_template",
    )
    .bind(workspace)
    .bind(tool)
    .bind(json!({"command": command, "arguments": []}))
    .bind(by)
    .execute(su)
    .await
    .expect("seed work tool profile");
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let (owner, owner_email) = seed_human(su, workspace, "owner", "성재").await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("r0-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;
    seed_tool_profile(su, workspace, owner, TOOL, TOOL).await;
    seed_tool_profile(su, workspace, owner, "shell", "sh").await;

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'hermes', 'hermes')",
    )
    .bind(agent)
    .bind(workspace)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
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
    join_channel(su, workspace, channel, agent).await;

    Tenant {
        workspace,
        owner,
        owner_email,
        channel,
        agent,
    }
}

/// A colleague who is in the room — and a workspace **admin**, because ADR-0188
/// D3 says 「채널 멤버십이나 관리자 역할로 대신할 수 없다」 and a test that only
/// tried a plain member would prove half of that.
async fn seed_teammate(su: &PgPool, tenant: &Tenant) -> (Uuid, String) {
    let (teammate, email) = seed_human(su, tenant.workspace, "admin", "동료").await;
    join_channel(su, tenant.workspace, tenant.channel, teammate).await;
    (teammate, email)
}

fn host_keypair() -> ([u8; 32], String) {
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
}

/// A registered, online host whose signing key this test holds.
async fn seed_host(
    su: &PgPool,
    tenant: &Tenant,
    owner: Uuid,
    scope: &str,
    host_type: &str,
    display: &str,
) -> (Uuid, [u8; 32]) {
    let (seed, public_key) = host_keypair();
    let host = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host \
           (id, workspace_id, scope, owner_member_id, type, display_name, public_key, \
            capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host)
    .bind(tenant.workspace)
    .bind(scope)
    .bind(owner)
    .bind(host_type)
    .bind(display)
    .bind(public_key)
    .execute(su)
    .await
    .expect("seed work host");
    (host, seed)
}

/// The owner's own laptop: member-scoped, the `app` tier, online — the card's
/// default by ADR-0125 D6-A's 로컬 온라인 우선.
async fn seed_laptop(su: &PgPool, tenant: &Tenant) -> (Uuid, [u8; 32]) {
    seed_host(su, tenant, tenant.owner, "member", "app", "성재의 맥").await
}

/// A team box: workspace-scoped, outside goal A (ADR-0188 D3).
async fn seed_team_box(su: &PgPool, tenant: &Tenant, display: &str) -> Uuid {
    seed_host(su, tenant, tenant.owner, "workspace", "workd", display)
        .await
        .0
}

async fn seed_run(su: &PgPool, tenant: &Tenant) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'running'::run_status, $5, $6)",
    )
    .bind(run)
    .bind(tenant.workspace)
    .bind(tenant.agent)
    .bind(tenant.channel)
    .bind(json!({"type": "work", "title": "r0", "brief": "r0"}))
    .bind(format!("r0:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

/// Mint an agent bearer carrying `work:control`.
async fn agent_bearer(su: &PgPool, tenant: &Tenant) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", tenant.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 'r0-conformance')",
    )
    .bind(tenant.workspace)
    .bind(tenant.agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

/// The sweep's verdict, applied as a fixture (no HTTP path writes `orphaned`).
async fn orphan_session(su: &PgPool, session: Uuid) {
    sqlx::query(
        "UPDATE work_session SET status = 'orphaned', host_lost_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(session)
    .execute(su)
    .await
    .expect("orphan the session");
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

/// `POST …/work-controls` with the agent's bearer.
async fn agent_control(
    http: &reqwest::Client,
    base: &str,
    bearer: &str,
    tenant: &Tenant,
    body: Value,
) -> reqwest::Response {
    http.post(format!(
        "{base}/v1/workspaces/{}/work-controls",
        tenant.workspace
    ))
    .bearer_auth(bearer)
    .json(&body)
    .send()
    .await
    .expect("agent work control")
}

/// The agent asks for a spawn on `host`; answers the control id on a 201.
#[allow(clippy::too_many_arguments)]
async fn request_spawn(
    http: &reqwest::Client,
    base: &str,
    bearer: &str,
    tenant: &Tenant,
    run: Uuid,
    host: Uuid,
    tool: &str,
    label: &str,
) -> Uuid {
    let response = agent_control(
        http,
        base,
        bearer,
        tenant,
        json!({
            "channelId": tenant.channel,
            "runId": run,
            "targetHostId": host,
            "kind": "spawn",
            "payload": {"tool": tool, "label": label},
        }),
    )
    .await;
    assert_eq!(
        response.status(),
        201,
        "an agent may still ask for a spawn on a team box"
    );
    let body: Value = response.json().await.expect("control body");
    Uuid::parse_str(body["workControl"]["id"].as_str().expect("control id")).expect("uuid")
}

fn decision_body(approval: Uuid, approve: bool, host: Option<Uuid>) -> Value {
    let mut body = json!({
        "approval_id": approval,
        "approve": approve,
        "client_decision_id": Uuid::new_v4(),
    });
    if let Some(host) = host {
        body["hostId"] = json!(host);
    }
    body
}

async fn decide(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    approval: Uuid,
    approve: bool,
    host: Option<Uuid>,
) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/approvals/{approval}/decision"
        ))
        .bearer_auth(token)
        .json(&decision_body(approval, approve, host))
        .send()
        .await
        .expect("decide approval");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// `(status, error.code, error.message)` of an error envelope.
async fn error_of(response: reqwest::Response) -> (u16, Value, String) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

/// A work-host request exactly as a daemon puts it on the wire: the v2 payload
/// over method + **signed** path + tenant + host + clock + body digest + a
/// one-time request id, in the `MomoHost` headers. Built once, sendable twice —
/// which is how the replay proofs present the very same bytes again.
struct SignedRequest {
    method: reqwest::Method,
    /// What goes on the request line — differs from `signed_path` only in the
    /// query-string proofs.
    wire_path: String,
    host: Uuid,
    sent_at_ms: i64,
    request_id: Uuid,
    signature: String,
    body: Vec<u8>,
}

impl SignedRequest {
    fn new(
        method: reqwest::Method,
        signed_path: &str,
        workspace: Uuid,
        host: Uuid,
        seed: &[u8; 32],
        body: Vec<u8>,
    ) -> Self {
        let sent_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;
        let request_id = Uuid::new_v4();
        let payload = momo_wire::signing::request_payload(
            method.as_str(),
            signed_path,
            workspace,
            host,
            sent_at_ms,
            &momo_wire::signing::sha256_hex(&body),
            request_id,
        );
        let signature = momo_wire::signing::sign_base64(seed, &payload).expect("sign");
        SignedRequest {
            method,
            wire_path: signed_path.to_string(),
            host,
            sent_at_ms,
            request_id,
            signature,
            body,
        }
    }

    fn on_the_wire_as(mut self, wire_path: String) -> Self {
        self.wire_path = wire_path;
        self
    }

    async fn send(&self, http: &reqwest::Client, base: &str) -> reqwest::Response {
        let mut request = http
            .request(self.method.clone(), format!("{base}{}", self.wire_path))
            .header("Authorization", format!("MomoHost {}", self.host))
            .header("X-Momo-Work-Host-Sent-At", self.sent_at_ms.to_string())
            .header("X-Momo-Work-Host-Signature", &self.signature)
            .header("X-Momo-Work-Host-Request-ID", self.request_id.to_string());
        if !self.body.is_empty() {
            request = request
                .header("Content-Type", "application/json")
                .body(self.body.clone());
        }
        request.send().await.expect("signed host request")
    }
}

fn heartbeat_path(workspace: Uuid, host: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/work-hosts/{host}/heartbeat")
}

fn pending_path(workspace: Uuid, host: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/work-hosts/{host}/pending-controls")
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

async fn control_row(su: &PgPool, control: Uuid) -> (String, Uuid, Option<Uuid>) {
    let row =
        sqlx::query("SELECT status, target_host_id, session_id FROM work_control WHERE id = $1")
            .bind(control)
            .fetch_one(su)
            .await
            .expect("read work control");
    (
        row.get("status"),
        row.get("target_host_id"),
        row.get("session_id"),
    )
}

async fn control_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_control WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count work controls")
}

/// The one pending approval raised for `control`.
async fn approval_for(su: &PgPool, control: Uuid) -> Uuid {
    sqlx::query_scalar(
        "SELECT id FROM approval \
          WHERE payload->>'work_control_id' = $1 AND status = 'pending'",
    )
    .bind(control.to_string())
    .fetch_one(su)
    .await
    .expect("the spawn raised one pending approval")
}

async fn approval_status(su: &PgPool, approval: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM approval WHERE id = $1")
        .bind(approval)
        .fetch_one(su)
        .await
        .expect("read approval status")
}

/// `work.control.dispatched` broadcasts addressed to `host`.
async fn dispatched_to(su: &PgPool, workspace: Uuid, host: Uuid) -> usize {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'work.control.dispatched' \
            AND payload->'data'->'payload'->>'target_host_id' = $2",
    )
    .bind(workspace)
    .bind(host.to_string())
    .fetch_one(su)
    .await
    .expect("read dispatch broadcasts");
    count as usize
}

async fn sessions_on(su: &PgPool, workspace: Uuid, host: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_session WHERE workspace_id = $1 AND host_id = $2")
        .bind(workspace)
        .bind(host)
        .fetch_one(su)
        .await
        .expect("count work sessions")
}

async fn last_seen_ms(su: &PgPool, host: Uuid) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT floor(extract(epoch from last_seen_at) * 1000)::bigint \
           FROM work_host WHERE id = $1",
    )
    .bind(host)
    .fetch_one(su)
    .await
    .expect("read last_seen_at")
}

async fn heartbeat_provenance_rows(su: &PgPool, workspace: Uuid, host: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM action_signature \
          WHERE workspace_id = $1 AND entity_type = 'work_host.heartbeat' AND entity_id = $2",
    )
    .bind(workspace)
    .bind(host)
    .fetch_one(su)
    .await
    .expect("count heartbeat provenance rows")
}

// ---------------------------------------------------------------------------
// 1 — D3: 결정자 = host 소유자
// ---------------------------------------------------------------------------

/// **RED PROOF — 팀원 결정 거부.** Work headed to the owner's laptop is decided
/// by the owner, and by nobody else in the room — not even a workspace admin.
///
/// The agent aims its spawn at the team box (the only kind of host it may still
/// ask for); the card's default is the owner's laptop (로컬 온라인 우선). The
/// colleague then tries every way of deciding while the card points at that
/// laptop — approving onto it by name, approving onto the default, rejecting —
/// and each is refused with the same code, before any write: the control stays
/// `pending_approval`, the approval stays `pending`, no host is told anything.
///
/// Then the criterion is shown to be **the final host**, not the card: the
/// colleague *may* approve a second card onto the team box. And the owner
/// approves the first onto their own laptop, which is the path R0 keeps open —
/// on the ledger: the row is still an agent's control, so R0.1 does not hand it
/// to the laptop (`r01_3`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_1_a_teammate_cannot_decide_work_headed_to_the_owners_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (_teammate, teammate_email) = seed_teammate(&su, &tenant).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let teammate_token = login(&http, &base, tenant.workspace, &teammate_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let control = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "리팩터링").await;
    let approval = approval_for(&su, control).await;
    let payload: Value = sqlx::query_scalar("SELECT payload FROM approval WHERE id = $1")
        .bind(approval)
        .fetch_one(&su)
        .await
        .expect("approval payload");
    assert_eq!(
        payload["execution"]["default_host_id"],
        json!(laptop.to_string()),
        "the card sits on the owner's laptop by default: {}",
        payload["execution"]
    );

    for (approve, host, why) in [
        (
            true,
            Some(laptop),
            "approving onto the owner's laptop by name",
        ),
        (true, None, "approving onto the card's default, the laptop"),
        (false, None, "rejecting while the card points at the laptop"),
    ] {
        let (status, receipt) = decide(
            &http,
            &base,
            &teammate_token,
            tenant.workspace,
            approval,
            approve,
            host,
        )
        .await;
        assert_eq!(status, 403, "{why}: {receipt}");
        assert_eq!(
            receipt["status"],
            json!("remote_host_owner_required"),
            "{why}: the refusal names itself — {receipt}"
        );
        assert_eq!(
            control_row(&su, control).await.0,
            "pending_approval",
            "{why}: the control did not move"
        );
        assert_eq!(approval_status(&su, approval).await, "pending", "{why}");
        assert_eq!(
            dispatched_to(&su, tenant.workspace, laptop).await,
            0,
            "{why}: the laptop was told nothing"
        );
    }

    // ---- the criterion is the final host --------------------------------------
    let second = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "팀 일").await;
    let second_approval = approval_for(&su, second).await;
    let (status, receipt) = decide(
        &http,
        &base,
        &teammate_token,
        tenant.workspace,
        second_approval,
        true,
        Some(vps),
    )
    .await;
    assert_eq!(
        status, 200,
        "a team box is outside goal A — the colleague may send work there: {receipt}"
    );
    assert_eq!(control_row(&su, second).await.0, "dispatched");

    // ---- and the owner decides their own laptop ------------------------------
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        approval,
        true,
        Some(laptop),
    )
    .await;
    assert_eq!(
        status, 200,
        "the owner may send work to their own laptop: {receipt}"
    );
    let (state, target, _) = control_row(&su, control).await;
    assert_eq!(state, "dispatched");
    assert_eq!(target, laptop);
    assert_eq!(dispatched_to(&su, tenant.workspace, laptop).await, 1);
}

// ---------------------------------------------------------------------------
// 2 — D3: the decision route takes a person
// ---------------------------------------------------------------------------

/// **RED PROOF — WorkHost principal 결정 거부.** A laptop cannot approve work
/// onto itself.
///
/// The danger is specific: a signed host's principal carries its **owner's**
/// `member_id` (`auth::authenticate_signed_host`), so every membership and
/// ownership predicate on the decision route would pass it as that person. Two
/// layers stop it, and both are asserted:
///
/// 1. **the allow-list** — the laptop, correctly signing a decision, is the
///    ordinary signed-request 401 (`work_host_auth::is_allowed_signed_path` does
///    not list any approval route);
/// 2. **the handler** — the same principal presented *past* the middleware, on a
///    router that mounts only the decision handler, is still refused with a 403
///    receipt `human_principal_required`. This is the layer the red proof
///    removes: without it the laptop's principal decides as its owner and the
///    spawn is dispatched to the laptop.
///
/// An agent bearer is refused as well. The owner's own decision closes the test.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_2_a_work_host_principal_cannot_decide() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, laptop_seed) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let control = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "리팩터링").await;
    let approval = approval_for(&su, control).await;
    let decision_path = format!(
        "/v1/workspaces/{}/approvals/{approval}/decision",
        tenant.workspace
    );
    let body = serde_json::to_vec(&decision_body(approval, true, Some(laptop))).expect("json");

    // ---- layer 1: a signed laptop never authenticates on this route ---------
    let signed = SignedRequest::new(
        reqwest::Method::POST,
        &decision_path,
        tenant.workspace,
        laptop,
        &laptop_seed,
        body.clone(),
    )
    .send(&http, &base)
    .await;
    let (status, _, message) = error_of(signed).await;
    assert_eq!(status, 401, "the decision route is not host-signable");
    assert_eq!(message, "invalid work host request signature");

    // ---- layer 2: the same principal, presented past the middleware ---------
    let host_principal = momo_auth::Principal {
        member_id: tenant.owner,
        workspace_id: tenant.workspace,
        token_id: Some(laptop),
        scopes: vec![],
        kind: momo_auth::PrincipalKind::WorkHost,
    };
    let bare_handler = axum::Router::new()
        .route(
            "/v1/workspaces/{ws}/approvals/{approval}/decision",
            axum::routing::post(momo_server::routes::approvals::decide_by_approval),
        )
        .layer(axum::Extension(host_principal))
        .with_state(app_state(app_pool.clone()));
    let bare_base = serve(bare_handler).await;
    let response = http
        .post(format!("{bare_base}{decision_path}"))
        .header("Content-Type", "application/json")
        .body(body.clone())
        .send()
        .await
        .expect("decide as a work host principal");
    let status = response.status().as_u16();
    let receipt: Value = response.json().await.expect("receipt");
    assert_eq!(
        status, 403,
        "a work host principal is not a person, whoever owns it: {receipt}"
    );
    assert_eq!(receipt["status"], json!("human_principal_required"));

    // ---- an agent bearer is not a person either ----------------------------
    let as_agent = http
        .post(format!("{base}{decision_path}"))
        .bearer_auth(&bearer)
        .header("Content-Type", "application/json")
        .body(body.clone())
        .send()
        .await
        .expect("decide as the agent");
    assert_eq!(as_agent.status(), 403, "an agent cannot decide");

    assert_eq!(control_row(&su, control).await.0, "pending_approval");
    assert_eq!(approval_status(&su, approval).await, "pending");
    assert_eq!(dispatched_to(&su, tenant.workspace, laptop).await, 0);

    // ---- the person does ------------------------------------------------------
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        approval,
        true,
        Some(laptop),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(control_row(&su, control).await.0, "dispatched");
}

// ---------------------------------------------------------------------------
// 3 — D3: an agent's controls on a remote host are kill only
// ---------------------------------------------------------------------------

/// **RED PROOF — 에이전트 input·read 거부.** Once a session is running on the
/// owner's laptop, the agent that asked for it may stop it and do nothing else.
///
/// The lineage below is the strongest one an agent can hold: its own spawn,
/// approved by the owner onto the laptop, acked with the session bound — exactly
/// what ADR-0114 D4 let `input`/`read` ride on without asking again. On a remote
/// host that is over: `input`, `read` and a fresh `spawn` are 403
/// `remote_host_kill_only` before any write (no row, no dispatch), and `kill` —
/// the off switch — is still accepted.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_3_an_agent_reaches_a_remote_host_with_kill_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    // ---- the lineage: the agent's spawn, the owner's laptop, acked ----------
    let spawn = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "리팩터링").await;
    let approval = approval_for(&su, spawn).await;
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        approval,
        true,
        Some(laptop),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let created = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-sessions",
            tenant.workspace
        ))
        .bearer_auth(&owner_token)
        .json(&json!({
            "channelId": tenant.channel,
            "hostId": laptop,
            "tool": TOOL,
            "label": "리팩터링",
        }))
        .send()
        .await
        .expect("create work session");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("session body");
    let session = Uuid::parse_str(created["workSession"]["id"].as_str().expect("id")).unwrap();
    let acked = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-controls/{spawn}/ack",
            tenant.workspace
        ))
        .bearer_auth(&owner_token)
        .json(&json!({"ok": true, "sessionId": session}))
        .send()
        .await
        .expect("ack the spawn");
    assert_eq!(acked.status(), 200, "the laptop's owner acks its spawn");
    assert_eq!(control_row(&su, spawn).await.2, Some(session));

    // ---- what the agent may no longer do ------------------------------------
    let before = control_count(&su, tenant.workspace).await;
    for (kind, payload, session_id) in [
        ("input", json!({"text": "rm -rf ~"}), Some(session)),
        ("read", json!({"tail_lines": 200}), Some(session)),
        ("spawn", json!({"tool": TOOL, "label": "또 하나"}), None),
    ] {
        let mut body = json!({
            "channelId": tenant.channel,
            "runId": run,
            "targetHostId": laptop,
            "kind": kind,
            "payload": payload,
        });
        if let Some(session_id) = session_id {
            body["sessionId"] = json!(session_id);
        }
        let (status, code, message) =
            error_of(agent_control(&http, &base, &bearer, &tenant, body).await).await;
        assert_eq!(status, 403, "{kind} on the owner's laptop: {message}");
        assert_eq!(
            code,
            json!("remote_host_kill_only"),
            "{kind}: the refusal carries its code"
        );
    }
    assert_eq!(
        control_count(&su, tenant.workspace).await,
        before,
        "no refused control left a ledger row behind"
    );

    // ---- the off switch still works -----------------------------------------
    let killed = agent_control(
        &http,
        &base,
        &bearer,
        &tenant,
        json!({
            "channelId": tenant.channel,
            "runId": run,
            "targetHostId": laptop,
            "sessionId": session,
            "kind": "kill",
            "payload": {},
        }),
    )
    .await;
    assert_eq!(
        killed.status(),
        201,
        "kill is the one control an agent keeps"
    );
    let killed: Value = killed.json().await.expect("kill body");
    assert_eq!(killed["workControl"]["status"], json!("dispatched"));
}

// ---------------------------------------------------------------------------
// 4 — D3: no standing auto-approval on a remote host
// ---------------------------------------------------------------------------

/// **RED PROOF — auto spawn 거부.** The owner ticked `work_auto_approve` for
/// `codex`; the agent's `work.session.spawn` would land on the owner's laptop
/// (the card's default). Before R0 that ran with no card at all. Now the run
/// parks on an approval, no session exists and no control was written.
///
/// Driven end to end through the real worker: the mention starts a real run,
/// the mock model asks for the tool, and the disposition is the worker's own.
/// The standing permission is then read directly for both hosts, which pins the
/// cause: the same row that is refused for the laptop still answers yes for the
/// team box.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_4_a_standing_auto_approval_never_reaches_a_remote_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;

    let enabled = http
        .put(format!(
            "{base}/v1/workspaces/{}/work-auto-approvals/{TOOL}",
            tenant.workspace
        ))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("enable auto approve");
    assert_eq!(enabled.status(), 200, "the owner's standing permission");

    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(&owner_token)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "@hermes 코덱스 세션 하나 띄워줘"}))
        .send()
        .await
        .expect("send mention");
    assert_eq!(sent.status(), 201);
    let run: Uuid = sqlx::query_scalar("SELECT id FROM agent_run WHERE workspace_id = $1")
        .bind(tenant.workspace)
        .fetch_one(&su)
        .await
        .expect("the mention started one run");

    let spawn_call = ProviderToolCall {
        id: "call_spawn_r0".to_string(),
        name: momo_agent::tools::WORK_SESSION_SPAWN.to_string(),
        arguments: json!({"tool": TOOL, "label": "자동이었던 일"}).to_string(),
    };
    let worker = AgentWorker::new(
        worker_pool.clone(),
        Arc::new(MockChatProvider::echo().with_tool_calls([vec![spawn_call], vec![]])),
        WorkerConfig::for_target(database_url()),
    );
    worker.drain_once().await.expect("drain");

    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM approval WHERE workspace_id = $1 AND status = 'pending'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("the spawn raised a card instead of running");
    assert_eq!(
        payload["execution"]["default_host_id"],
        json!(laptop.to_string()),
        "the host the auto-approval would have opened onto is the owner's laptop"
    );
    let run_status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(&su)
        .await
        .expect("read run");
    assert_eq!(
        run_status, "awaiting_approval",
        "the run parks on the owner instead of running"
    );
    assert_eq!(
        sessions_on(&su, tenant.workspace, laptop).await,
        0,
        "**nothing ran on the laptop**"
    );
    assert_eq!(control_count(&su, tenant.workspace).await, 0);

    // ---- the cause is the scope, not a broken permission ---------------------
    let mut conn = su.acquire().await.expect("connection");
    for (host, expected, why) in [
        (laptop, false, "a member-scoped host is never auto-approved"),
        (
            vps,
            true,
            "the same standing permission still opens a team box",
        ),
    ] {
        assert_eq!(
            momo_t3::work_control::spawn_is_auto_approved_in_tx(
                &mut conn,
                tenant.workspace,
                tenant.owner,
                TOOL,
                host,
            )
            .await
            .expect("read auto-approval"),
            expected,
            "{why}"
        );
    }
}

// ---------------------------------------------------------------------------
// 5 — D6: no shell on a remote host
// ---------------------------------------------------------------------------

/// **RED PROOF — shell spawn 거부.** A shell is refused on the owner's laptop
/// even when the owner approves it: 「원격 `shell`은 거부한다」 is about the
/// tool, not the decider.
///
/// The agent aims a `shell` spawn at the team box (allowed — team hosts are
/// outside goal A); the owner then tries to redirect it to their laptop, by name
/// and by the card's default. Both are 403 `remote_host_shell_refused` before
/// any write. A profile that is a shell under another key (`bash-2` →
/// `{"command":"bash"}`) is refused the same way. The same shell card may still
/// go to the team box.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_5_a_shell_is_never_spawned_on_a_remote_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_tool_profile(&su, tenant.workspace, tenant.owner, "bash-2", "bash").await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let shell = request_spawn(&http, &base, &bearer, &tenant, run, vps, "shell", "셸").await;
    let shell_approval = approval_for(&su, shell).await;
    let renamed = request_spawn(&http, &base, &bearer, &tenant, run, vps, "bash-2", "셸 2").await;
    let renamed_approval = approval_for(&su, renamed).await;

    for (control, approval, host, why) in [
        (
            shell,
            shell_approval,
            Some(laptop),
            "`shell` onto the laptop by name",
        ),
        (
            shell,
            shell_approval,
            None,
            "`shell` onto the card's default, the laptop",
        ),
        (
            renamed,
            renamed_approval,
            Some(laptop),
            "a shell under another key",
        ),
    ] {
        let (status, receipt) = decide(
            &http,
            &base,
            &owner_token,
            tenant.workspace,
            approval,
            true,
            host,
        )
        .await;
        assert_eq!(status, 403, "{why}: {receipt}");
        assert_eq!(
            receipt["status"],
            json!("remote_host_shell_refused"),
            "{why}: {receipt}"
        );
        assert_eq!(
            control_row(&su, control).await.0,
            "pending_approval",
            "{why}"
        );
        assert_eq!(approval_status(&su, approval).await, "pending", "{why}");
    }
    assert_eq!(
        dispatched_to(&su, tenant.workspace, laptop).await,
        0,
        "no shell was ever addressed to the laptop"
    );

    // ---- a team box is outside goal A ---------------------------------------
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        shell_approval,
        true,
        Some(vps),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let (state, target, _) = control_row(&su, shell).await;
    assert_eq!(state, "dispatched");
    assert_eq!(target, vps);
}

// ---------------------------------------------------------------------------
// 6 — D7: the heartbeat is v2, and a replay is refused
// ---------------------------------------------------------------------------

/// **RED PROOF — heartbeat 재전송 거부.** A captured heartbeat cannot keep a
/// dead laptop looking alive.
///
/// The v1 heartbeat signed only `{ws, host, sentAtMs}`, so the same bytes were
/// good for the whole ±5 minute window. Now a heartbeat is a v2 request whose id
/// is consumed exactly once: the first presentation stamps liveness and records
/// provenance, the identical second presentation is the ordinary 401, and
/// neither `last_seen_at` nor the provenance log moves. A v1 heartbeat — the
/// old body, no `MomoHost` headers — is refused outright, however good its
/// signature.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_6_a_replayed_heartbeat_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, seed) = seed_laptop(&su, &tenant).await;
    sqlx::query("UPDATE work_host SET last_seen_at = NULL WHERE id = $1")
        .bind(laptop)
        .execute(&su)
        .await
        .expect("start the laptop offline");

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    // ---- a v1 heartbeat, correctly signed by the laptop's own key ----------
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let v1_signature = momo_wire::signing::sign_base64(
        &seed,
        &momo_wire::signing::heartbeat_payload(tenant.workspace, laptop, sent_at_ms),
    )
    .expect("sign v1");
    let v1 = http
        .post(format!(
            "{base}{}",
            heartbeat_path(tenant.workspace, laptop)
        ))
        .json(&json!({"sentAtMs": sent_at_ms, "signature": v1_signature}))
        .send()
        .await
        .expect("v1 heartbeat");
    let (status, _, message) = error_of(v1).await;
    assert_eq!(status, 401, "v1 is not accepted");
    assert_eq!(message, "invalid work host request signature");
    assert_eq!(last_seen_ms(&su, laptop).await, None, "and stamped nothing");

    // ---- the v2 heartbeat --------------------------------------------------
    let beat = SignedRequest::new(
        reqwest::Method::POST,
        &heartbeat_path(tenant.workspace, laptop),
        tenant.workspace,
        laptop,
        &seed,
        Vec::new(),
    );
    let first = beat.send(&http, &base).await;
    assert_eq!(first.status(), 200, "a fresh v2 heartbeat is accepted");
    let first: Value = first.json().await.expect("heartbeat body");
    assert_eq!(first["workHost"]["online"], json!(true));
    let stamped = last_seen_ms(&su, laptop)
        .await
        .expect("the heartbeat stamped liveness");
    assert_eq!(
        heartbeat_provenance_rows(&su, tenant.workspace, laptop).await,
        1,
        "and recorded the host's signature as provenance"
    );

    // ---- the same bytes again ------------------------------------------------
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let replayed = beat.send(&http, &base).await;
    let (status, _, message) = error_of(replayed).await;
    assert_eq!(
        status, 401,
        "a heartbeat's request id is consumed exactly once"
    );
    assert_eq!(message, "invalid work host request signature");
    assert_eq!(
        last_seen_ms(&su, laptop).await,
        Some(stamped),
        "the replay did not move liveness"
    );
    assert_eq!(
        heartbeat_provenance_rows(&su, tenant.workspace, laptop).await,
        1,
        "nor the provenance log"
    );

    // ---- a new beat is a new id, and is fine ---------------------------------
    let next = SignedRequest::new(
        reqwest::Method::POST,
        &heartbeat_path(tenant.workspace, laptop),
        tenant.workspace,
        laptop,
        &seed,
        Vec::new(),
    )
    .send(&http, &base)
    .await;
    assert_eq!(next.status(), 200, "the next real beat is accepted");
}

// ---------------------------------------------------------------------------
// 7 — D7: no query string on a signed request
// ---------------------------------------------------------------------------

/// **Query 문자열 401.** The v2 signature covers the path, not the query, so a
/// signed request may not carry one: anything after `?` would be a byte nobody
/// signed. Proved on both entry points the authenticator has — the public
/// heartbeat (handler-authenticated) and the protected `pending-controls` poll
/// (middleware-authenticated) — with a signature that is otherwise perfect, and
/// with a signature that even covers the query. A clean request then succeeds on
/// both, so the refusals are about the `?` and nothing else.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_7_a_signed_request_carries_no_query_string() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, seed) = seed_laptop(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    for (method, path) in [
        (
            reqwest::Method::POST,
            heartbeat_path(tenant.workspace, laptop),
        ),
        (reqwest::Method::GET, pending_path(tenant.workspace, laptop)),
    ] {
        // The signature covers the path; the wire adds a query.
        let smuggled = SignedRequest::new(
            method.clone(),
            &path,
            tenant.workspace,
            laptop,
            &seed,
            Vec::new(),
        )
        .on_the_wire_as(format!("{path}?since=0"))
        .send(&http, &base)
        .await;
        let (status, _, message) = error_of(smuggled).await;
        assert_eq!(status, 401, "{method} {path}?since=0 (unsigned query)");
        assert_eq!(message, "invalid work host request signature");

        // Even signing the query does not make it acceptable.
        let signed_query = format!("{path}?since=0");
        let covered = SignedRequest::new(
            method.clone(),
            &signed_query,
            tenant.workspace,
            laptop,
            &seed,
            Vec::new(),
        )
        .send(&http, &base)
        .await;
        assert_eq!(
            covered.status(),
            401,
            "{method} {signed_query} (signed query)"
        );

        let clean = SignedRequest::new(
            method.clone(),
            &path,
            tenant.workspace,
            laptop,
            &seed,
            Vec::new(),
        )
        .send(&http, &base)
        .await;
        assert_eq!(clean.status(), 200, "{method} {path} without a query");
    }
}

// ---------------------------------------------------------------------------
// 8 — the spawn executor, for the callers that never pass through a card
// ---------------------------------------------------------------------------

/// **The executor half of D3 and D6.** `tool_exec::spawn_session` also runs
/// for callers that never passed a card — a G6 exemption runs it with the
/// *agent's* own authority. So the executor asks again: a session lands on the
/// owner's laptop only with the owner's authority, and never as a shell. The
/// owner's own `codex` then runs, so the refusals are rules.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_8_the_spawn_tool_refuses_a_remote_host_it_was_not_given() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let run = seed_run(&su, &tenant).await;

    let spawn = |call_id: &str, tool: &str| momo_agent::tools::ToolCall {
        call_id: call_id.to_string(),
        name: momo_agent::tools::WORK_SESSION_SPAWN.to_string(),
        arguments: json!({"tool": tool, "label": "실행기", "host_id": laptop.to_string()}),
    };
    let context = |approved_by: Uuid| ToolContext {
        workspace_id: tenant.workspace,
        run_id: run,
        channel_id: tenant.channel,
        agent_member_id: tenant.agent,
        approved_by,
        approved_host_id: Some(laptop),
    };

    let unapproved = tool_exec::execute(&worker_pool, &context(tenant.agent), &spawn("c1", TOOL))
        .await
        .expect("execute");
    assert!(
        unapproved.is_error && unapproved.output.contains("remote_host_owner_required"),
        "the agent's own authority does not reach the laptop: {unapproved:?}"
    );
    let shell = tool_exec::execute(&worker_pool, &context(tenant.owner), &spawn("c2", "shell"))
        .await
        .expect("execute");
    assert!(
        shell.is_error && shell.output.contains("remote_host_shell_refused"),
        "not even the owner starts a shell there: {shell:?}"
    );
    assert_eq!(sessions_on(&su, tenant.workspace, laptop).await, 0);
    assert_eq!(control_count(&su, tenant.workspace).await, 0);

    let owned = tool_exec::execute(&worker_pool, &context(tenant.owner), &spawn("c3", TOOL))
        .await
        .expect("execute");
    assert!(!owned.is_error, "the owner's own codex runs: {owned:?}");
    assert_eq!(sessions_on(&su, tenant.workspace, laptop).await, 1);
}

// ---------------------------------------------------------------------------
// 9 — resume is a spawn too
// ---------------------------------------------------------------------------

/// **D6 on the takeover path.** A resume writes a `spawn` control onto its
/// target, so an orphaned shell session cannot be carried onto the owner's
/// laptop — by the owner either. The same session may still move to another
/// team box.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_9_a_shell_is_not_resumed_onto_a_remote_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let dead = seed_team_box(&su, &tenant, "죽은 상자").await;
    let spare = seed_team_box(&su, &tenant, "새 상자").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;

    let created = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-sessions",
            tenant.workspace
        ))
        .bearer_auth(&owner_token)
        .json(&json!({
            "channelId": tenant.channel,
            "hostId": dead,
            "tool": "shell",
            "label": "셸 세션",
        }))
        .send()
        .await
        .expect("create work session");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("session body");
    let session = Uuid::parse_str(created["workSession"]["id"].as_str().expect("id")).unwrap();
    orphan_session(&su, session).await;

    let resume = |target: Uuid| {
        http.post(format!(
            "{base}/v1/workspaces/{}/work-sessions/{session}/resume",
            tenant.workspace
        ))
        .bearer_auth(&owner_token)
        .json(&json!({"targetHostId": target}))
        .send()
    };
    let (status, code, message) = error_of(resume(laptop).await.expect("resume")).await;
    assert_eq!(status, 403, "{message}");
    assert_eq!(code, json!("remote_host_shell_refused"));
    assert_eq!(sessions_on(&su, tenant.workspace, laptop).await, 0);
    assert_eq!(dispatched_to(&su, tenant.workspace, laptop).await, 0);

    let moved = resume(spare).await.expect("resume");
    assert_eq!(moved.status(), 201, "a team box may take the shell");
}

// ===========================================================================
// ADR-0188 R0.1 (#2582) — the ways round R0 its security review found
// ===========================================================================

/// `POST …/work-hosts` as a person, with a fresh key.
async fn register_host(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    scope: &str,
    host_type: &str,
) -> reqwest::Response {
    let (_, public_key) = host_keypair();
    http.post(format!("{base}/v1/workspaces/{workspace}/work-hosts"))
        .bearer_auth(token)
        .json(&json!({
            "scope": scope,
            "type": host_type,
            "displayName": format!("{scope} {host_type}"),
            "publicKey": public_key,
        }))
        .send()
        .await
        .expect("register work host")
}

async fn host_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_host WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count work hosts")
}

/// A running session on `host`, opened by the person holding `token`.
async fn open_session(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    host: Uuid,
    label: &str,
) -> Uuid {
    let created = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-sessions",
            tenant.workspace
        ))
        .bearer_auth(token)
        .json(&json!({
            "channelId": tenant.channel,
            "hostId": host,
            "tool": TOOL,
            "label": label,
        }))
        .send()
        .await
        .expect("create work session");
    assert_eq!(created.status(), 201, "the session {label} opens");
    let created: Value = created.json().await.expect("session body");
    Uuid::parse_str(created["workSession"]["id"].as_str().expect("id")).expect("uuid")
}

/// A `dispatched` control written straight to the ledger as the superuser —
/// the shape a row dispatched **before R0** has, which no route writes any more.
#[allow(clippy::too_many_arguments)]
async fn insert_dispatched(
    su: &PgPool,
    tenant: &Tenant,
    host: Uuid,
    requester: Uuid,
    session: Option<Uuid>,
    kind: &str,
    payload: Value,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO work_control \
           (workspace_id, channel_id, requester_member_id, target_host_id, session_id, \
            kind, payload, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'dispatched') \
         RETURNING id",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(requester)
    .bind(host)
    .bind(session)
    .bind(kind)
    .bind(payload)
    .fetch_one(su)
    .await
    .expect("insert a dispatched control")
}

/// What `host`'s own signed poll hands it, in delivery order — the one way a
/// daemon learns what to run.
async fn poll_pending(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    host: Uuid,
    seed: &[u8; 32],
) -> Vec<Uuid> {
    let response = SignedRequest::new(
        reqwest::Method::GET,
        &pending_path(workspace, host),
        workspace,
        host,
        seed,
        Vec::new(),
    )
    .send(http, base)
    .await;
    assert_eq!(response.status(), 200, "a host polls its own queue");
    let body: Value = response.json().await.expect("pending body");
    body["workControls"]
        .as_array()
        .expect("workControls")
        .iter()
        .map(|control| Uuid::parse_str(control["id"].as_str().expect("id")).expect("uuid"))
        .collect()
}

async fn approval_payload(su: &PgPool, approval: Uuid) -> Value {
    sqlx::query_scalar("SELECT payload FROM approval WHERE id = $1")
        .bind(approval)
        .fetch_one(su)
        .await
        .expect("approval payload")
}

// ---------------------------------------------------------------------------
// R0.1 Medium — the scope is not a registration option
// ---------------------------------------------------------------------------

/// **RED PROOF — 관리자 아닌 멤버의 `scope=workspace` 등록 거부.** Every R0 defence
/// keys on `scope = 'member'`, so a member who could register their own laptop
/// as a team box would switch all of them off from the request body.
///
/// A plain member asking for `workspace` is 403 `workspace_host_admin_required`
/// and leaves no row. The same member still registers their own machine
/// member-scoped, and a workspace admin and the owner still add team hosts — so
/// the refusal is about the role, not the route.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r01_1_only_a_workspace_admin_registers_a_workspace_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (_member, member_email) = seed_human(&su, tenant.workspace, "member", "팀원").await;
    let (_admin, admin_email) = seed_teammate(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let member_token = login(&http, &base, tenant.workspace, &member_email).await;
    let admin_token = login(&http, &base, tenant.workspace, &admin_email).await;
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;

    let before = host_count(&su, tenant.workspace).await;
    let (status, code, message) = error_of(
        register_host(
            &http,
            &base,
            &member_token,
            tenant.workspace,
            "workspace",
            "workd",
        )
        .await,
    )
    .await;
    assert_eq!(
        status, 403,
        "a plain member cannot add a team host: {message}"
    );
    assert_eq!(code, json!("workspace_host_admin_required"), "{message}");
    assert_eq!(
        host_count(&su, tenant.workspace).await,
        before,
        "and nothing was registered"
    );

    // ---- the member's own machine is still theirs to register ---------------
    let own = register_host(
        &http,
        &base,
        &member_token,
        tenant.workspace,
        "member",
        "workd",
    )
    .await;
    assert_eq!(own.status(), 201, "a member registers their own machine");
    let own: Value = own.json().await.expect("host body");
    assert_eq!(own["workHost"]["scope"], json!("member"));

    // ---- a team host is the workspace's to add ------------------------------
    for (token, who) in [
        (&admin_token, "a workspace admin"),
        (&owner_token, "the workspace owner"),
    ] {
        let added =
            register_host(&http, &base, token, tenant.workspace, "workspace", "workd").await;
        assert_eq!(added.status(), 201, "{who} adds a team host");
        let added: Value = added.json().await.expect("host body");
        assert_eq!(added["workHost"]["scope"], json!("workspace"), "{who}");
    }
}

/// **RED PROOF — `type=app` host는 scope와 무관하게 원격.** An `app` host is the
/// desktop app on its owner's own machine. Asked for as a team host it is
/// refused — 400 `app_host_member_scope_required`, for the workspace owner as
/// much as for a member — rather than quietly rewritten, and nothing is
/// registered. Member-scoped it registers, and R0 then holds for it: the agent
/// may address it with `kill` only.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r01_2_an_app_host_is_never_workspace_scoped() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (_member, member_email) = seed_human(&su, tenant.workspace, "member", "팀원").await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let member_token = login(&http, &base, tenant.workspace, &member_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let before = host_count(&su, tenant.workspace).await;
    for (token, who) in [
        (&owner_token, "the workspace owner"),
        (&member_token, "a member"),
    ] {
        let (status, code, message) = error_of(
            register_host(&http, &base, token, tenant.workspace, "workspace", "app").await,
        )
        .await;
        assert_eq!(status, 400, "{who}: an app host as a team host: {message}");
        assert_eq!(code, json!("app_host_member_scope_required"), "{who}");
    }
    assert_eq!(
        host_count(&su, tenant.workspace).await,
        before,
        "no app host became a team host"
    );

    // ---- member-scoped, it registers — and is a remote host ------------------
    let laptop = register_host(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        "member",
        "app",
    )
    .await;
    assert_eq!(laptop.status(), 201, "the owner registers their own laptop");
    let laptop: Value = laptop.json().await.expect("host body");
    assert_eq!(laptop["workHost"]["scope"], json!("member"));
    let laptop = Uuid::parse_str(laptop["workHost"]["id"].as_str().expect("id")).expect("uuid");

    let (status, code, message) = error_of(
        agent_control(
            &http,
            &base,
            &bearer,
            &tenant,
            json!({
                "channelId": tenant.channel,
                "runId": run,
                "targetHostId": laptop,
                "kind": "spawn",
                "payload": {"tool": TOOL, "label": "노트북에서"},
            }),
        )
        .await,
    )
    .await;
    assert_eq!(status, 403, "{message}");
    assert_eq!(code, json!("remote_host_kill_only"), "R0 holds for it");
}

// ---------------------------------------------------------------------------
// R0.1 Low 1 — rows dispatched before R0 are not handed to a remote host
// ---------------------------------------------------------------------------

/// **RED PROOF — R0 이전에 dispatch된 컨트롤의 전달 차단.** R0 refuses these at
/// creation and decision time; it cannot reach a row that was already
/// `dispatched` before it existed, and the signed poll is what would hand that
/// row to the first `momo-workd` (#2571) that asks. So every pre-R0 shape is
/// written straight to the ledger here — no route writes them any more — and
/// the owner's laptop polls:
///
/// * an agent's `input` and `read` (ADR-0114 D4, never approved);
/// * an agent's spawn a standing auto-approval dispatched (no card);
/// * an agent's spawn a **colleague** approved onto the laptop (a real card,
///   its pre-R0 decision replayed as the superuser);
/// * the owner's own `shell`, and a shell under another key (`bash-2` → `bash`);
/// * a colleague's takeover onto the laptop (the shape resume could write
///   before #1139 asked whose host a target was).
///
/// One more row is not pre-R0 at all and is withheld on purpose: an agent's
/// spawn its **owner** approved onto the laptop through R0's own card. R0 lets
/// that decision through (the owner decides, `r0_1`), but the row is still an
/// agent's control, and ADR-0188 §3 gives an agent `kill` only on a remote host
/// — so it is `dispatched` on the ledger and never handed to the laptop. This
/// pins the literal reading of #2582; delivering owner-approved agent spawns
/// would be a deliberate change to this assertion.
///
/// None of them is delivered, and none is failed either — they are withheld,
/// still `dispatched`, because the poll writes nothing. What the laptop **is**
/// handed is the agent's `kill` and its owner's own takeover, oldest first; and
/// the same shapes on a team box are all delivered, exactly as before.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r01_3_a_remote_host_is_not_handed_what_r0_would_refuse() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_tool_profile(&su, tenant.workspace, tenant.owner, "bash-2", "bash").await;
    let (teammate, _) = seed_teammate(&su, &tenant).await;
    let (laptop, laptop_seed) = seed_laptop(&su, &tenant).await;
    let (vps, vps_seed) =
        seed_host(&su, &tenant, tenant.owner, "workspace", "workd", "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let bearer = agent_bearer(&su, &tenant).await;
    let on_laptop = open_session(&http, &base, &owner_token, &tenant, laptop, "노트북 세션").await;
    let on_vps = open_session(&http, &base, &owner_token, &tenant, vps, "VPS 세션").await;

    // ---- a colleague's approval onto the laptop, as a pre-R0 decision left it
    let carded = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "팀원 승인").await;
    let card = approval_for(&su, carded).await;
    sqlx::query(
        "UPDATE approval SET status = 'approved', decided_by = $2, decided_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(card)
    .bind(teammate)
    .execute(&su)
    .await
    .expect("the colleague's pre-R0 approval");
    sqlx::query(
        "UPDATE work_control SET status = 'dispatched', target_host_id = $2, \
                updated_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(carded)
    .bind(laptop)
    .execute(&su)
    .await
    .expect("…dispatched onto the owner's laptop");

    // ---- R0's own card path: the owner approves an agent's spawn onto the
    // laptop. The decision stands (`r0_1`); the delivery does not (§3).
    let owner_approved =
        request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "주인 승인").await;
    let owner_card = approval_for(&su, owner_approved).await;
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        owner_card,
        true,
        Some(laptop),
    )
    .await;
    assert_eq!(
        status, 200,
        "R0 lets the owner approve onto the laptop: {receipt}"
    );
    let (state, target, _) = control_row(&su, owner_approved).await;
    assert_eq!((state.as_str(), target), ("dispatched", laptop));

    // ---- the other pre-R0 shapes, on the owner's laptop ----------------------
    let spawn = |tool: &str, label: &str| json!({"tool": tool, "label": label});
    let mut withheld = vec![
        (
            carded,
            "an agent's spawn a colleague approved onto the laptop",
        ),
        (
            owner_approved,
            "an agent's spawn its owner approved onto the laptop (§3: an agent's control)",
        ),
    ];
    for (requester, session, kind, payload, why) in [
        (
            tenant.agent,
            Some(on_laptop),
            "input",
            json!({"text": "rm -rf ~"}),
            "an agent's input (ADR-0114 D4, never approved)",
        ),
        (
            tenant.agent,
            Some(on_laptop),
            "read",
            json!({"tail_lines": 200}),
            "an agent's read",
        ),
        (
            tenant.agent,
            None,
            "spawn",
            spawn(TOOL, "자동승인"),
            "an agent's auto-approved spawn (no card)",
        ),
        (
            tenant.owner,
            None,
            "spawn",
            spawn("shell", "셸"),
            "the owner's own shell",
        ),
        (
            tenant.owner,
            None,
            "spawn",
            spawn("bash-2", "이름만 다른 셸"),
            "a shell under another key",
        ),
        (
            teammate,
            None,
            "spawn",
            spawn(TOOL, "남의 노트북"),
            "a colleague's takeover onto the laptop (before #1139)",
        ),
    ] {
        let control =
            insert_dispatched(&su, &tenant, laptop, requester, session, kind, payload).await;
        withheld.push((control, why));
    }
    let kill = insert_dispatched(
        &su,
        &tenant,
        laptop,
        tenant.agent,
        Some(on_laptop),
        "kill",
        json!({}),
    )
    .await;
    let takeover = insert_dispatched(
        &su,
        &tenant,
        laptop,
        tenant.owner,
        None,
        "spawn",
        spawn(TOOL, "주인의 이어받기"),
    )
    .await;

    // ---- the same shapes on a team box ---------------------------------------
    let mut team = Vec::new();
    for (requester, session, kind, payload) in [
        (
            tenant.agent,
            Some(on_vps),
            "input",
            json!({"text": "상태 알려줘"}),
        ),
        (tenant.agent, None, "spawn", spawn("shell", "팀 셸")),
        (teammate, None, "spawn", spawn(TOOL, "팀 일")),
    ] {
        team.push(insert_dispatched(&su, &tenant, vps, requester, session, kind, payload).await);
    }

    // ---- the laptop's own poll ------------------------------------------------
    let delivered = poll_pending(&http, &base, tenant.workspace, laptop, &laptop_seed).await;
    for (control, why) in &withheld {
        assert!(
            !delivered.contains(control),
            "handed to the owner's laptop: {why} ({control}) — the poll answered {delivered:?}"
        );
    }
    assert_eq!(
        delivered,
        vec![kill, takeover],
        "the laptop is handed the agent's kill and its owner's own takeover, oldest first"
    );
    for (control, why) in &withheld {
        assert_eq!(
            control_row(&su, *control).await.0,
            "dispatched",
            "{why}: withheld, not failed — the poll writes nothing"
        );
    }

    // ---- a team box is outside goal A -----------------------------------------
    assert_eq!(
        poll_pending(&http, &base, tenant.workspace, vps, &vps_seed).await,
        team,
        "a team box is handed every shape it was before"
    );
}

// ---------------------------------------------------------------------------
// R0.1 Low 2 — a rejection is judged on the card, not on the decider's pick
// ---------------------------------------------------------------------------

/// **RED PROOF — 거부 판정의 host는 pick이 아니라 카드.** A rejection runs
/// nothing, so the decider's `hostId` chooses nothing — except, before R0.1,
/// which ownership rule applied. A team box is a selectable candidate on every
/// card, so a colleague could settle a card sitting on the owner's laptop by
/// "picking" the VPS while saying no.
///
/// The card defaults to the laptop: the colleague's rejection is 403
/// `remote_host_owner_required` whatever they pick, and changes nothing. A card
/// that pre-selected nothing is judged on the host its request named. The owner
/// then rejects their own card (with a pick, which is ignored), and a card that
/// defaults to the team box is still the colleague's to refuse — picking the
/// laptop does not make it the owner's.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r01_4_a_rejection_is_judged_on_the_card_not_the_pick() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (_teammate, teammate_email) = seed_teammate(&su, &tenant).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let teammate_token = login(&http, &base, tenant.workspace, &teammate_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let control = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "리팩터링").await;
    let approval = approval_for(&su, control).await;
    let payload = approval_payload(&su, approval).await;
    assert_eq!(
        payload["execution"]["default_host_id"],
        json!(laptop.to_string()),
        "the card sits on the owner's laptop: {}",
        payload["execution"]
    );
    assert!(
        payload["execution"]["host_candidates"]
            .as_array()
            .expect("candidates")
            .iter()
            .any(|row| row["host_id"] == json!(vps.to_string()) && row["selectable"] == true),
        "and offers the team box, so a pick of it is one the card allows"
    );

    for (pick, why) in [
        (Some(vps), "rejecting with the team box picked"),
        (Some(laptop), "rejecting with the laptop picked"),
        (None, "rejecting with no pick"),
    ] {
        let (status, receipt) = decide(
            &http,
            &base,
            &teammate_token,
            tenant.workspace,
            approval,
            false,
            pick,
        )
        .await;
        assert_eq!(status, 403, "{why}: {receipt}");
        assert_eq!(
            receipt["status"],
            json!("remote_host_owner_required"),
            "{why}: {receipt}"
        );
        assert_eq!(
            control_row(&su, control).await.0,
            "pending_approval",
            "{why}"
        );
        assert_eq!(approval_status(&su, approval).await, "pending", "{why}");
    }

    // ---- a card that pre-selected nothing: the host its request named ---------
    let bare = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "빈 카드").await;
    let bare_approval = approval_for(&su, bare).await;
    sqlx::query(
        "UPDATE approval \
            SET payload = jsonb_set( \
                  jsonb_set(payload, '{execution,default_host_id}', 'null'::jsonb), \
                  '{execution,requested_host_id}', to_jsonb($2::text)) \
          WHERE id = $1",
    )
    .bind(bare_approval)
    .bind(laptop.to_string())
    .execute(&su)
    .await
    .expect("a card that asks for the laptop and pre-selects nothing");
    let (status, receipt) = decide(
        &http,
        &base,
        &teammate_token,
        tenant.workspace,
        bare_approval,
        false,
        Some(vps),
    )
    .await;
    assert_eq!(status, 403, "a card that names the laptop: {receipt}");
    assert_eq!(receipt["status"], json!("remote_host_owner_required"));
    assert_eq!(approval_status(&su, bare_approval).await, "pending");

    // ---- the owner refuses their own card; the pick changes nothing ----------
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        approval,
        false,
        Some(vps),
    )
    .await;
    assert_eq!(status, 200, "the owner rejects their own card: {receipt}");
    assert_eq!(receipt["status"], json!("rejected"));
    assert_eq!(control_row(&su, control).await.0, "denied");

    // ---- a card on the team box is anybody's in the room to refuse -----------
    sqlx::query(
        "INSERT INTO work_host_last_used (workspace_id, member_id, host_id) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (workspace_id, member_id) DO UPDATE SET host_id = EXCLUDED.host_id",
    )
    .bind(tenant.workspace)
    .bind(tenant.owner)
    .bind(vps)
    .execute(&su)
    .await
    .expect("the owner last sent work to the team box");
    let team = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "팀 일").await;
    let team_approval = approval_for(&su, team).await;
    assert_eq!(
        approval_payload(&su, team_approval).await["execution"]["default_host_id"],
        json!(vps.to_string()),
        "마지막 사용 puts this card on the team box"
    );
    let (status, receipt) = decide(
        &http,
        &base,
        &teammate_token,
        tenant.workspace,
        team_approval,
        false,
        Some(laptop),
    )
    .await;
    assert_eq!(
        status, 200,
        "picking the laptop does not make a team-box card the owner's: {receipt}"
    );
    assert_eq!(control_row(&su, team).await.0, "denied");
}
