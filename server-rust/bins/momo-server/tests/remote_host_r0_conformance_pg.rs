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
//! | `r01_5_an_agents_spawn_is_not_approved_onto_a_member_host` | A′: decision time | the `member_is_agent_in_tx` refusal in `approvals::decide_in_tx` |
//! | `r01_6_a_spawn_call_that_names_a_member_host_is_refused` | A′: request time (tool) | `AgentWorker::refused_spawn_target` in `momo-agent-worker` |
//!
//! **R1 M2** (#2778) — the owner hears about every host added in their name:
//!
//! | test | rule | the guard whose removal turns it red |
//! |---|---|---|
//! | `r1m2_1_the_owners_devices_hear_a_host_registered_and_revoked` | ADR-0188 D2 「등록 사실을 소유자의 모든 기기에 알린다」 | `emit_work_host_notice` in `work_hosts::register` and `revoke` |
//!
//! `r0_8` also pins A′'s executor re-check (`tool_exec::spawn_session_in_tx`).
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
use momo_agent_worker::provider::{
    ChatCompletion, ChatProvider, ChatRequest, MockChatProvider, ProviderEndpoint, ProviderError,
    ProviderToolCall,
};
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
/// settles the first — the decision the rule reserves for them. Since R0.1 (A′)
/// that is a rejection: nobody, the owner included, approves an agent's spawn
/// *onto* a laptop (`r01_5`).
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

    // ---- and the owner settles the card that sits on their laptop ------------
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        approval,
        false,
        None,
    )
    .await;
    assert_eq!(
        status, 200,
        "the owner may decide a card that points at their own laptop: {receipt}"
    );
    assert_eq!(receipt["status"], json!("rejected"));
    assert_eq!(control_row(&su, control).await.0, "denied");
    assert_eq!(dispatched_to(&su, tenant.workspace, laptop).await, 0);
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
///    removes: without it the laptop's principal decides as its owner. It asks
///    for the team box, so that nothing *else* refuses it — since R0.1 (A′) no
///    approval sends an agent's spawn onto the laptop itself (`r01_5`), and a
///    host that can approve anything at all as its owner is the hole either way.
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
    let body = serde_json::to_vec(&decision_body(approval, true, Some(vps))).expect("json");

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
    assert_eq!(dispatched_to(&su, tenant.workspace, vps).await, 0);

    // ---- the person does ------------------------------------------------------
    // Onto the team box: since R0.1 (A′) an agent's spawn is not approved onto
    // the laptop by anyone (`r01_5`), and what is under test here is only that a
    // person's decision goes through where a host's does not.
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        approval,
        true,
        Some(vps),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(control_row(&su, control).await.0, "dispatched");
    assert_eq!(dispatched_to(&su, tenant.workspace, laptop).await, 0);
}

// ---------------------------------------------------------------------------
// 3 — D3: an agent's controls on a remote host are kill only
// ---------------------------------------------------------------------------

/// **RED PROOF — 에이전트 input·read 거부.** Once a session is running on the
/// owner's laptop, the agent that asked for it may stop it and do nothing else.
///
/// The lineage below is the strongest one an agent can hold: its own spawn,
/// acked on the owner's laptop with the session bound — exactly what ADR-0114
/// D4 let `input`/`read` ride on without asking again. On a remote host that is
/// over: `input`, `read` and a fresh `spawn` are 403 `remote_host_kill_only`
/// before any write (no row, no dispatch), and `kill` — the off switch — is
/// still accepted.
///
/// Since R0.1 (A′) no route can build that lineage any more — the decision route
/// will not approve an agent's spawn onto a laptop (`r01_5`) — so it is seeded
/// as the superuser: the shape a laptop may still carry from before, and the
/// one its off switch must still reach.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_3_an_agent_reaches_a_remote_host_with_kill_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    // ---- the lineage: the agent's spawn, the owner's laptop, acked ----------
    let session = open_session(&http, &base, &owner_token, &tenant, laptop, "리팩터링").await;
    let spawn = insert_dispatched(
        &su,
        &tenant,
        laptop,
        tenant.agent,
        Some(session),
        "spawn",
        json!({"tool": TOOL, "label": "리팩터링"}),
    )
    .await;
    sqlx::query("UPDATE work_control SET status = 'acked' WHERE id = $1")
        .bind(spawn)
        .execute(&su)
        .await
        .expect("the spawn was acked on the laptop, before R0.1 (A′)");
    let (state, target, bound) = control_row(&su, spawn).await;
    assert_eq!(
        (state.as_str(), target, bound),
        ("acked", laptop, Some(session))
    );

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
        WorkerConfig::for_target(database_url()).with_env_bearer("sk-conformance-team-key"),
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
/// *agent's* own authority. So the executor asks again, and each refusal keeps
/// its own word: the agent's own authority does not reach the owner's laptop
/// (`remote_host_owner_required`), a shell never does (`remote_host_shell_refused`),
/// and since R0.1 (A′) the owner's authority does not carry an agent's spawn
/// there either (`member_host_agent_control_refused`) — what reaches this line
/// is an approval granted before the decision route refused it. Nothing is
/// written for any of them. The owner's `codex` then runs on the team box, so
/// the refusals are rules.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_8_the_spawn_tool_refuses_a_remote_host_it_was_not_given() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let spawn = |call_id: &str, tool: &str, host: Uuid| momo_agent::tools::ToolCall {
        call_id: call_id.to_string(),
        name: momo_agent::tools::WORK_SESSION_SPAWN.to_string(),
        arguments: json!({"tool": tool, "label": "실행기", "host_id": host.to_string()}),
    };
    let context = |approved_by: Uuid, host: Uuid| ToolContext {
        workspace_id: tenant.workspace,
        run_id: run,
        channel_id: tenant.channel,
        agent_member_id: tenant.agent,
        approved_by,
        approved_host_id: Some(host),
        claude_subscription_agents_enabled: true,
    };

    for (approved_by, tool, code, why) in [
        (
            tenant.agent,
            TOOL,
            "remote_host_owner_required",
            "the agent's own authority does not reach the laptop",
        ),
        (
            tenant.owner,
            "shell",
            "remote_host_shell_refused",
            "not even the owner starts a shell there",
        ),
        (
            tenant.owner,
            TOOL,
            "member_host_agent_control_refused",
            "nor carries an agent's spawn there, since R0.1 (A′)",
        ),
    ] {
        let refused = tool_exec::execute(
            &worker_pool,
            &context(approved_by, laptop),
            &spawn(&format!("laptop-{tool}-{approved_by}"), tool, laptop),
        )
        .await
        .expect("execute");
        assert!(
            refused.is_error && refused.output.contains(code),
            "{why}: {refused:?}"
        );
    }
    assert_eq!(sessions_on(&su, tenant.workspace, laptop).await, 0);
    assert_eq!(control_count(&su, tenant.workspace).await, 0);

    let owned = tool_exec::execute(
        &worker_pool,
        &context(tenant.owner, vps),
        &spawn("team-box", TOOL, vps),
    )
    .await
    .expect("execute");
    assert!(
        !owned.is_error,
        "the owner's codex runs on the team box: {owned:?}"
    );
    assert_eq!(sessions_on(&su, tenant.workspace, vps).await, 1);
    assert_eq!(sessions_on(&su, tenant.workspace, laptop).await, 0);
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
/// spawn its **owner** approved onto the laptop through a card, as R0 allowed
/// until R0.1 (A′). The decision route now refuses to make that row
/// (`r01_5`); one made in between is still an agent's control, and ADR-0188 §3
/// gives an agent `kill` only on a remote host — so it stays `dispatched` and
/// is never handed to the laptop. It is written as the superuser, like the
/// colleague's approval, because no route writes it any more.
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

    // ---- the owner's own approval onto the laptop, as R0 allowed until A′ ----
    let owner_approved =
        request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "주인 승인").await;
    let owner_card = approval_for(&su, owner_approved).await;
    sqlx::query(
        "UPDATE approval SET status = 'approved', decided_by = $2, decided_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(owner_card)
    .bind(tenant.owner)
    .execute(&su)
    .await
    .expect("the owner's approval, before R0.1 (A′)");
    sqlx::query(
        "UPDATE work_control SET status = 'dispatched', target_host_id = $2, \
                updated_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(owner_approved)
    .bind(laptop)
    .execute(&su)
    .await
    .expect("…dispatched onto the owner's laptop");

    // ---- the other pre-R0 shapes, on the owner's laptop ----------------------
    let spawn = |tool: &str, label: &str| json!({"tool": tool, "label": label});
    let mut withheld = vec![
        (
            carded,
            "an agent's spawn a colleague approved onto the laptop",
        ),
        (
            owner_approved,
            "an agent's spawn its owner approved onto the laptop before A′ (§3: an agent's control)",
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

// ---------------------------------------------------------------------------
// R0.1 (A′) — an agent's spawn is refused where the row would be made
// ---------------------------------------------------------------------------

/// The newest run in `workspace` — the one the last mention started.
async fn latest_run(su: &PgPool, workspace: Uuid) -> Uuid {
    sqlx::query_scalar(
        "SELECT id FROM agent_run WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("the mention started a run")
}

async fn run_status(su: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .expect("read run status")
}

async fn approvals_in(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count approvals")
}

/// The owner mentions the agent, which starts a real run.
async fn mention_agent(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    body: &str,
) {
    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(token)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
        .send()
        .await
        .expect("send mention");
    assert_eq!(sent.status(), 201, "the mention is sent");
}

/// A real worker whose mock model asks for `work.session.spawn` once.
fn spawn_worker(worker_pool: &PgPool, call_id: &str, arguments: Value) -> AgentWorker {
    let call = ProviderToolCall {
        id: call_id.to_string(),
        name: momo_agent::tools::WORK_SESSION_SPAWN.to_string(),
        arguments: arguments.to_string(),
    };
    AgentWorker::new(
        worker_pool.clone(),
        Arc::new(MockChatProvider::echo().with_tool_calls([vec![call], vec![]])),
        WorkerConfig::for_target(database_url()).with_env_bearer("sk-conformance-team-key"),
    )
}

/// **RED PROOF — 결정 시점 거부 (A′).** An agent's spawn is not approved onto
/// a member-scoped host by anyone — its owner included — on either producer of
/// a spawn card, and the refusal writes nothing: the card stays pending so the
/// decider can still send the work to a team box, which then works.
///
/// * **The REST ledger's card.** The agent asks for the team box; the card
///   defaults to the owner's laptop. The owner approving onto the laptop, by
///   name or by the default, is 403 `member_host_agent_control_refused`: the
///   control stays `pending_approval`, no row is added, the laptop is told
///   nothing. Onto the team box it dispatches.
/// * **The spawn tool's card**, driven through the real worker: the model names
///   no host, the card defaults to the laptop, the same refusal holds — the run
///   stays parked, no control and no session exist — and approving onto the
///   team box resumes the run and starts the session there.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r01_5_an_agents_spawn_is_not_approved_onto_a_member_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();

    // ---- the REST ledger's card ---------------------------------------------
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let control = request_spawn(&http, &base, &bearer, &tenant, run, vps, TOOL, "리팩터링").await;
    let approval = approval_for(&su, control).await;
    assert_eq!(
        approval_payload(&su, approval).await["execution"]["default_host_id"],
        json!(laptop.to_string()),
        "the card defaults to the owner's laptop"
    );
    let rows = control_count(&su, tenant.workspace).await;
    for (pick, why) in [
        (
            Some(laptop),
            "the owner approving onto their laptop by name",
        ),
        (None, "the owner approving the card's default, the laptop"),
    ] {
        let (status, receipt) = decide(
            &http,
            &base,
            &owner_token,
            tenant.workspace,
            approval,
            true,
            pick,
        )
        .await;
        assert_eq!(status, 403, "{why}: {receipt}");
        assert_eq!(
            receipt["status"],
            json!("member_host_agent_control_refused"),
            "{why}: {receipt}"
        );
        let (state, target, _) = control_row(&su, control).await;
        assert_eq!(
            (state.as_str(), target),
            ("pending_approval", vps),
            "{why}: the control did not move"
        );
        assert_eq!(approval_status(&su, approval).await, "pending", "{why}");
        assert_eq!(
            control_count(&su, tenant.workspace).await,
            rows,
            "{why}: no row"
        );
        assert_eq!(
            dispatched_to(&su, tenant.workspace, laptop).await,
            0,
            "{why}"
        );
    }
    let (status, receipt) = decide(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        approval,
        true,
        Some(vps),
    )
    .await;
    assert_eq!(status, 200, "the same card, onto the team box: {receipt}");
    let (state, target, _) = control_row(&su, control).await;
    assert_eq!((state.as_str(), target), ("dispatched", vps));

    // ---- the spawn tool's card -------------------------------------------------
    let tool_tenant = seed_tenant(&su, &app_pool).await;
    let (tool_laptop, _) = seed_laptop(&su, &tool_tenant).await;
    let tool_vps = seed_team_box(&su, &tool_tenant, "팀 VPS").await;
    let tool_owner = login(
        &http,
        &base,
        tool_tenant.workspace,
        &tool_tenant.owner_email,
    )
    .await;
    mention_agent(
        &http,
        &base,
        &tool_owner,
        &tool_tenant,
        "@hermes 코덱스 세션 하나 띄워줘",
    )
    .await;
    let tool_run = latest_run(&su, tool_tenant.workspace).await;
    let worker = spawn_worker(
        &worker_pool,
        "call_spawn_a_prime",
        json!({"tool": TOOL, "label": "도구 카드"}),
    );
    worker.drain_once().await.expect("first drain");
    assert_eq!(run_status(&su, tool_run).await, "awaiting_approval");
    let tool_approval: Uuid = sqlx::query_scalar(
        "SELECT id FROM approval WHERE workspace_id = $1 AND status = 'pending'",
    )
    .bind(tool_tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("the spawn raised a card");
    assert_eq!(
        approval_payload(&su, tool_approval).await["execution"]["default_host_id"],
        json!(tool_laptop.to_string()),
        "a call that names no host gets a card, defaulting to the laptop"
    );

    let (status, receipt) = decide(
        &http,
        &base,
        &tool_owner,
        tool_tenant.workspace,
        tool_approval,
        true,
        None,
    )
    .await;
    assert_eq!(status, 403, "the tool's card onto the laptop: {receipt}");
    assert_eq!(
        receipt["status"],
        json!("member_host_agent_control_refused")
    );
    assert_eq!(approval_status(&su, tool_approval).await, "pending");
    assert_eq!(run_status(&su, tool_run).await, "awaiting_approval");
    assert_eq!(control_count(&su, tool_tenant.workspace).await, 0, "no row");
    assert_eq!(
        sessions_on(&su, tool_tenant.workspace, tool_laptop).await,
        0
    );

    let (status, receipt) = decide(
        &http,
        &base,
        &tool_owner,
        tool_tenant.workspace,
        tool_approval,
        true,
        Some(tool_vps),
    )
    .await;
    assert_eq!(status, 200, "onto the team box: {receipt}");
    worker.drain_once().await.expect("resume drain");
    assert_eq!(
        sessions_on(&su, tool_tenant.workspace, tool_vps).await,
        1,
        "the approved spawn started on the team box"
    );
    assert_eq!(
        sessions_on(&su, tool_tenant.workspace, tool_laptop).await,
        0
    );
    assert_eq!(
        dispatched_to(&su, tool_tenant.workspace, tool_laptop).await,
        0
    );
}

/// **RED PROOF — 요청 시점 거부 (A′).** A `work.session.spawn` whose `host_id`
/// names the owner's laptop is refused as the call arrives, through the real
/// worker: no approval, no card, no control, no session — the run is not
/// parked on anybody. The model is answered with a `tool_result` that carries
/// `remote_host_kill_only`, the word the REST ledger gives the same request.
///
/// The same call naming the team box still raises its card, so the refusal is
/// about the host the call named, not about the tool.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r01_6_a_spawn_call_that_names_a_member_host_is_refused() {
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

    // ---- the call names the laptop -------------------------------------------
    mention_agent(
        &http,
        &base,
        &owner_token,
        &tenant,
        "@hermes 내 맥에서 코덱스 띄워줘",
    )
    .await;
    let refused_run = latest_run(&su, tenant.workspace).await;
    spawn_worker(
        &worker_pool,
        "call_spawn_laptop",
        json!({"tool": TOOL, "label": "노트북에서", "host_id": laptop.to_string()}),
    )
    .drain_once()
    .await
    .expect("drain");

    assert_eq!(
        approvals_in(&su, tenant.workspace).await,
        0,
        "no card was raised for a call that names the laptop"
    );
    assert_ne!(
        run_status(&su, refused_run).await,
        "awaiting_approval",
        "and the run is not parked on anybody"
    );
    assert_eq!(control_count(&su, tenant.workspace).await, 0);
    assert_eq!(sessions_on(&su, tenant.workspace, laptop).await, 0);
    let answer: Value = sqlx::query_scalar(
        "SELECT props FROM message \
          WHERE workspace_id = $1 AND run_id = $2 AND type = 'tool_result'",
    )
    .bind(tenant.workspace)
    .bind(refused_run)
    .fetch_one(&su)
    .await
    .expect("the refusal stands beside the call as its tool_result");
    assert_eq!(answer["is_error"], json!(true), "{answer}");
    assert!(
        answer["output"]
            .as_str()
            .is_some_and(|output| output.contains("remote_host_kill_only")),
        "the model is told why, in the REST ledger's word: {answer}"
    );

    // ---- the same call, naming the team box ----------------------------------
    mention_agent(
        &http,
        &base,
        &owner_token,
        &tenant,
        "@hermes 팀 VPS에서 코덱스 띄워줘",
    )
    .await;
    let carded_run = latest_run(&su, tenant.workspace).await;
    assert_ne!(carded_run, refused_run);
    spawn_worker(
        &worker_pool,
        "call_spawn_team_box",
        json!({"tool": TOOL, "label": "팀 VPS에서", "host_id": vps.to_string()}),
    )
    .drain_once()
    .await
    .expect("drain");
    assert_eq!(run_status(&su, carded_run).await, "awaiting_approval");
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM approval WHERE workspace_id = $1 AND status = 'pending'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("a call that names the team box raises its card");
    assert_eq!(
        payload["execution"]["requested_host_id"],
        json!(vps.to_string())
    );
}

// ---------------------------------------------------------------------------
// #2959 M3 — `card_suggest` runs only when the agent's profile turned it on
// ---------------------------------------------------------------------------

/// **RED PROOF (#2959 M3).** `card_suggest` is exempt from the approval gate by
/// name, so the profile is its only backstop: a provider that calls it for an
/// agent whose `enabled_tools` does not list it gets a refusal and posts no
/// card; the same call on a profile that lists it posts one. Driven through the
/// real worker loop (`drain_once`), so the check under test is the one
/// `record_tool_call` makes.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn gc6_card_suggest_runs_only_when_the_profile_enabled_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;

    let cards = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM message WHERE workspace_id=$1 \
               AND props ? 'momo.command_suggest'",
        )
        .bind(tenant.workspace)
        .fetch_one(&su)
        .await
        .expect("count cards")
    };
    let mention_and_drain = |call_id: &'static str| {
        let http = http.clone();
        let base = base.clone();
        let owner_token = owner_token.clone();
        let worker_pool = worker_pool.clone();
        async move {
            let sent = http
                .post(format!(
                    "{base}/v1/workspaces/{}/channels/{}/messages",
                    tenant.workspace, tenant.channel
                ))
                .bearer_auth(&owner_token)
                .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "@hermes 내 클로드 구독 연결해 줘"}))
                .send()
                .await
                .expect("send mention");
            assert_eq!(sent.status(), 201);
            let call = ProviderToolCall {
                id: call_id.to_string(),
                name: momo_agent::tools::CARD_SUGGEST.to_string(),
                arguments: json!({"commandId": "ai.connect", "args": {"harness": "claude"},
                                  "body": "연결 카드예요"})
                .to_string(),
            };
            let worker = AgentWorker::new(
                worker_pool,
                Arc::new(MockChatProvider::echo().with_tool_calls([vec![call], vec![]])),
                WorkerConfig::for_target(database_url()).with_env_bearer("sk-conformance-team-key"),
            );
            worker.drain_once().await.expect("drain");
        }
    };

    // No profile → `enabled_tools` is empty.
    mention_and_drain("call_card_off").await;
    assert_eq!(
        cards().await,
        0,
        "a tool the profile did not enable posts nothing"
    );
    let refusal: String = sqlx::query_scalar(
        "SELECT props->>'output' FROM message WHERE workspace_id=$1 AND type='tool_result' \
           AND props->>'call_id' = 'call_card_off'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("the refusal is answered on the spine");
    assert!(refusal.contains("not enabled"), "{refusal}");
    let approvals: i64 = sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
        .bind(tenant.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(approvals, 0, "a refusal is not a card either");

    // The operator turns it on.
    sqlx::query(
        "INSERT INTO agent_profile (agent_member_id, workspace_id, updated_by, paused, enabled_tools) \
         VALUES ($1, $2, $3, false, '[\"card_suggest\"]'::jsonb)",
    )
    .bind(tenant.agent)
    .bind(tenant.workspace)
    .bind(tenant.owner)
    .execute(&su)
    .await
    .expect("enable card_suggest");
    mention_and_drain("call_card_on").await;
    assert_eq!(cards().await, 1, "the enabled profile posts the card");
}

/// Status and whole JSON body (GC-8's reads want the body, not the error code).
async fn json_of(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// GC-8 "mock hermes" (#2949): a provider that behaves like a model which read
/// its instructions, and no better.
///
/// It reaches for `card_suggest` only when all three hold: the request offers
/// the tool, a `system` turn carries the connection-request rule
/// (`CARD_SUGGEST_DIRECTIVE`), and the person's last turn asks to connect.
/// Otherwise it does what a model without the rule does — explains settings
/// in text. So the E2E below cannot pass on a positional script: take the
/// rule or the default profile away and the card is never posted.
struct RuleFollowingHermes {
    /// Per turn: (offered momo tools, whether the rule was in the system turns).
    seen: Mutex<Vec<(Vec<String>, bool)>>,
    /// Trigger texts already answered with a card, so the turn after the tool
    /// result answers in text instead of suggesting again.
    carded: Mutex<Vec<String>>,
}

impl RuleFollowingHermes {
    fn new() -> RuleFollowingHermes {
        RuleFollowingHermes {
            seen: Mutex::new(Vec::new()),
            carded: Mutex::new(Vec::new()),
        }
    }

    fn seen(&self) -> Vec<(Vec<String>, bool)> {
        self.seen.lock().expect("hermes lock").clone()
    }
}

#[async_trait::async_trait]
impl ChatProvider for RuleFollowingHermes {
    async fn complete(
        &self,
        _endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        let offered: Vec<String> = request
            .momo_tools
            .iter()
            .map(|definition| definition.name.to_string())
            .collect();
        let told = request.messages.iter().any(|message| {
            message.role == "system"
                && message.content == momo_agent::card_suggest::CARD_SUGGEST_DIRECTIVE
        });
        self.seen
            .lock()
            .expect("hermes lock")
            .push((offered.clone(), told));
        let last_user = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(|message| message.content.clone())
            .unwrap_or_default();
        let asks_to_connect = last_user.contains("연결");
        let mut carded = self.carded.lock().expect("hermes lock");
        let may_suggest = offered
            .iter()
            .any(|name| name == momo_agent::tools::CARD_SUGGEST)
            && told
            && asks_to_connect
            && !carded.contains(&last_user);
        if may_suggest {
            carded.push(last_user.clone());
            let harness = if last_user.contains("클로드") {
                json!({"harness": "claude"})
            } else {
                json!({})
            };
            return Ok(ChatCompletion {
                text: String::new(),
                usage: None,
                tool_calls: vec![ProviderToolCall {
                    id: format!("call_gc8_{}", carded.len()),
                    // The wire name, as a real provider reports it.
                    name: momo_agent::tools::wire_tool_name(momo_agent::tools::CARD_SUGGEST),
                    arguments: json!({
                        "commandId": "ai.connect",
                        "args": harness,
                        "body": "여기서 바로 연결할 수 있어요."
                    })
                    .to_string(),
                }],
            });
        }
        let text = if asks_to_connect && !carded.contains(&last_user) {
            // The failure mode the rule exists to replace.
            "설정 › AI 연결로 가서 구독을 연결해 주세요.".to_string()
        } else {
            "카드를 띄웠어요.".to_string()
        };
        Ok(ChatCompletion {
            text,
            usage: None,
            tool_calls: Vec::new(),
        })
    }
}

/// GC-8 (#2949) — the whole server half of 「내 클로드 구독 연결해 줘」, with
/// nothing staged by hand between the person's message and the card:
///
/// 1. an operator creates an agent through `POST …/agents` **without** saying
///    anything about tools, and the hub reads `card_suggest` back as on;
/// 2. a plain member asks it to connect Claude; the worker offers the tool
///    **and** the rule, and the rule-following provider answers with the card;
/// 3. the posted props are exactly the shared golden vector
///    (`docs/api/command-suggest-ai-connect.golden.json`, the one the GC-7
///    client tests render) with `for_member_id` = the member who asked, and
///    every viewer's history carries the same props (G4: the split is the
///    client's, never the server's);
/// 4. the operator switches it off with `enabledTools: []`; the same request
///    then gets neither the tool nor the rule, and no card.
///
/// | sabotage | red |
/// |---|---|
/// | worker drops the rule (`card_suggest: None`) | no card, and `told` false |
/// | create writes no default (`default_enabled_tools` → empty) | hub reads `[]`, no card |
/// | PUT re-applies the default when `enabledTools` is `[]` | a card after 「끔」 |
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn gc8_a_connection_request_becomes_the_card_for_the_person_who_asked() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (doyun, doyun_email) = seed_human(&su, tenant.workspace, "member", "이도윤").await;
    join_channel(&su, tenant.workspace, tenant.channel, doyun).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let doyun_token = login(&http, &base, tenant.workspace, &doyun_email).await;
    let ws = tenant.workspace;

    // ---- 1. an agent created with no word about tools --------------------
    let handle = format!("kometto{}", &Uuid::new_v4().simple().to_string()[..6]);
    let created = http
        .post(format!("{base}/v1/workspaces/{ws}/agents"))
        .bearer_auth(&owner_token)
        .json(&json!({
            "displayName": "코메토",
            "handle": handle,
            "model": AGENT_MODEL,
            "baseUrl": "https://gateway.invalid/v1"
        }))
        .send()
        .await
        .expect("create agent");
    let (status, created) = json_of(created).await;
    assert_eq!(status, 201, "{created}");
    let agent =
        Uuid::parse_str(created["agent"]["id"].as_str().expect("agent id")).expect("agent uuid");
    join_channel(&su, ws, tenant.channel, agent).await;

    let profile_of = || {
        let http = http.clone();
        let base = base.clone();
        let owner_token = owner_token.clone();
        async move {
            let read = http
                .get(format!("{base}/v1/workspaces/{ws}/agents/{agent}/profile"))
                .bearer_auth(&owner_token)
                .send()
                .await
                .expect("read profile");
            let (status, body) = json_of(read).await;
            assert_eq!(status, 200, "{body}");
            body["profile"]["enabledTools"].clone()
        }
    };
    assert_eq!(
        profile_of().await,
        json!([momo_agent::tools::CARD_SUGGEST]),
        "the hub shows what will run: a new agent starts with card_suggest on"
    );

    // ---- 2. a plain member asks; the worker runs one turn ------------------
    let ask_and_drain = |text: String| {
        let http = http.clone();
        let base = base.clone();
        let doyun_token = doyun_token.clone();
        let worker_pool = worker_pool.clone();
        async move {
            let sent = http
                .post(format!(
                    "{base}/v1/workspaces/{ws}/channels/{}/messages",
                    tenant.channel
                ))
                .bearer_auth(&doyun_token)
                .json(&json!({"clientMsgId": Uuid::new_v4(), "body": text}))
                .send()
                .await
                .expect("send request");
            assert_eq!(sent.status(), 201);
            let hermes = Arc::new(RuleFollowingHermes::new());
            let worker = AgentWorker::new(
                worker_pool,
                hermes.clone(),
                WorkerConfig::for_target(database_url()).with_env_bearer("sk-conformance-team-key"),
            );
            worker.drain_once().await.expect("drain");
            hermes.seen()
        }
    };
    let cards = || async {
        sqlx::query(
            "SELECT author_member_id, channel_id, props FROM message \
              WHERE workspace_id = $1 AND props ? 'momo.command_suggest' ORDER BY seq",
        )
        .bind(ws)
        .fetch_all(&su)
        .await
        .expect("read cards")
        .into_iter()
        .map(|row| {
            (
                row.get::<Uuid, _>("author_member_id"),
                row.get::<Uuid, _>("channel_id"),
                row.get::<Value, _>("props"),
            )
        })
        .collect::<Vec<_>>()
    };

    let seen = ask_and_drain(format!("@{handle} 내 클로드 구독 연결해 줘")).await;
    assert!(!seen.is_empty(), "the worker called the provider");
    let (offered, told) = &seen[0];
    assert!(
        offered
            .iter()
            .any(|name| name == momo_agent::tools::CARD_SUGGEST),
        "the default profile offers the tool: {offered:?}"
    );
    assert!(*told, "the rule rides with the tool");

    let posted = cards().await;
    assert_eq!(posted.len(), 1, "one card for one request: {posted:?}");
    let (author, channel, props) = &posted[0];
    assert_eq!(*author, agent, "the agent speaks the card");
    assert_eq!(*channel, tenant.channel, "in the room it was asked in");

    // ---- 3. the props are the shared golden vector -------------------------
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/api/command-suggest-ai-connect.golden.json"
        ))
        .expect("read golden"),
    )
    .expect("golden JSON");
    let mut expected = golden["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == "claude")
        .expect("claude case")["props"]
        .clone();
    expected["momo.command_suggest"]["for_member_id"] = json!(doyun.to_string());
    assert_eq!(
        *props, expected,
        "server props = golden with the real requester"
    );
    let inner = props["momo.command_suggest"].as_object().expect("envelope");
    let mut keys: Vec<&str> = inner.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["args", "command_id", "for_member_id", "label", "v"]);
    let approvals: i64 = sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
        .bind(ws)
        .fetch_one(&su)
        .await
        .expect("count approvals");
    assert_eq!(approvals, 0, "a suggestion is not an approval card");

    // Every viewer reads the same props; who sees a card and who sees a line
    // is decided on their screen (G4).
    for token in [&doyun_token, &owner_token] {
        let history = http
            .get(format!(
                "{base}/v1/workspaces/{ws}/channels/{}/messages",
                tenant.channel
            ))
            .bearer_auth(token)
            .send()
            .await
            .expect("read history");
        let (status, page) = json_of(history).await;
        assert_eq!(status, 200, "{page}");
        let wire: Vec<&Value> = page["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .filter(|message| message["props"].get("momo.command_suggest").is_some())
            .collect();
        assert_eq!(wire.len(), 1, "{page}");
        assert_eq!(wire[0]["props"], expected);
        assert_eq!(
            wire[0]["authorMemberId"].as_str().map(str::to_lowercase),
            Some(agent.to_string())
        );
    }

    // ---- 4. the operator switches it off ------------------------------------
    let off = http
        .put(format!("{base}/v1/workspaces/{ws}/agents/{agent}/profile"))
        .bearer_auth(&owner_token)
        .json(&json!({"instructions": "", "enabledTools": []}))
        .send()
        .await
        .expect("switch off");
    let (status, body) = json_of(off).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        profile_of().await,
        json!([]),
        "the operator's 「끔」 sticks"
    );

    let seen = ask_and_drain(format!("@{handle} 코덱스 구독도 연결해 줘")).await;
    assert!(!seen.is_empty(), "the agent still answers");
    assert!(
        seen.iter()
            .all(|(offered, told)| offered.is_empty() && !told),
        "no tool, no rule: {seen:?}"
    );
    assert_eq!(cards().await.len(), 1, "switched off posts no card");
}

/// Every `broadcast` outbox row on `channel`, oldest first: (`data.type`, data).
async fn notices_on(su: &PgPool, workspace: Uuid, channel: &str) -> Vec<(String, Value)> {
    sqlx::query(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' AND payload->>'channel' = $2 \
          ORDER BY id",
    )
    .bind(workspace)
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("read outbox")
    .into_iter()
    .map(|row| {
        let payload: Value = row.get("payload");
        (
            payload["data"]["type"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            payload["data"].clone(),
        )
    })
    .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r1m2_1_the_owners_devices_hear_a_host_registered_and_revoked() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (teammate, teammate_email) = seed_teammate(&su, &tenant).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let teammate_token = login(&http, &base, tenant.workspace, &teammate_email).await;

    let owner_channel = format!("user:work-host#{}", tenant.owner.to_string().to_uppercase());
    let teammate_channel = format!("user:work-host#{}", teammate.to_string().to_uppercase());

    // ---- register: one notice on the owner's own channel, same tx ----------
    let response = register_host(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        "member",
        "workd",
    )
    .await;
    assert_eq!(response.status(), 201);
    let body: Value = response.json().await.unwrap();
    let host = body["workHost"]["id"].as_str().unwrap().to_string();
    let notices = notices_on(&su, tenant.workspace, &owner_channel).await;
    assert_eq!(notices.len(), 1, "one notice per registration: {notices:?}");
    assert_eq!(notices[0].0, "work_host.registered");
    let data = &notices[0].1;
    assert_eq!(data["payload"]["host_id"], json!(host));
    assert_eq!(data["payload"]["display_name"], json!("member workd"));
    assert_eq!(
        data["payload"]["actor_member_id"],
        json!(tenant.owner.to_string())
    );
    assert!(
        !data
            .to_string()
            .contains(body["workHost"]["publicKey"].as_str().unwrap()),
        "the notice never carries the host key"
    );
    assert!(
        notices_on(&su, tenant.workspace, &teammate_channel)
            .await
            .is_empty(),
        "nobody else's channel hears it"
    );

    // A refused registration writes neither the host nor a notice.
    let refused = register_host(
        &http,
        &base,
        &owner_token,
        tenant.workspace,
        "workspace",
        "app",
    )
    .await;
    assert_eq!(refused.status(), 400);
    assert_eq!(
        notices_on(&su, tenant.workspace, &owner_channel)
            .await
            .len(),
        1
    );

    // ---- revoke by an admin: the OWNER hears it; twice → one notice -------
    for _ in 0..2 {
        let revoked = http
            .delete(format!(
                "{base}/v1/workspaces/{}/work-hosts/{host}",
                tenant.workspace
            ))
            .bearer_auth(&teammate_token)
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), 200);
    }
    let notices = notices_on(&su, tenant.workspace, &owner_channel).await;
    let kinds: Vec<&str> = notices.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(kinds, ["work_host.registered", "work_host.revoked"]);
    assert_eq!(
        notices[1].1["payload"]["actor_member_id"],
        json!(teammate.to_string()),
        "the owner is told who revoked it"
    );
}

// ===========================================================================
// #3431 (ADR-0193 D18) — Claude Code on a shared host, while the opt-in is off
// ===========================================================================
//
// A workspace-scoped host (admin-registered) and a cloud host have no R0: any
// channel member may approve work headed there, and the Claude login on that
// machine may be somebody else's — which the server cannot see. So with
// `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED` off, Claude Code is not started on
// one, whoever asks or approves. A member-scoped host (somebody's own machine,
// owner-approved) is the 「본인 사용이라 허용」 path and is not touched; Codex is
// never touched.
//
// | test | entry point | the guard whose removal turns it red |
// |---|---|---|
// | `c3431_1_...request_and_decision` | REST ledger (spawn, input) + decision route | `shared_host_refuses_claude_in_tx` in `work_controls::create_in_tx` / `approvals::decide_in_tx` |
// | `c3431_2_...delivery` | the host's signed poll | the claude clause in `pending_controls_for_host_in_tx` |
// | `c3431_3_...sessions` | human session create + resume | the gates in `work_sessions::create_in_tx` / `resume_in_tx` |
// | `c3431_4_...spawn_tool` | `work.session.spawn` executor | the gate in `tool_exec::spawn_session_in_tx` |

const CLAUDE_PAUSED: &str = "claude_subscription_agent_paused";

async fn start_server_claude(pool: PgPool, claude_subscription_agents_enabled: bool) -> String {
    let state = app_state(pool).with_agent_port(momo_server::config::AgentPortConfig {
        claude_subscription_agents_enabled,
        ..momo_server::config::AgentPortConfig::default()
    });
    serve(build_app(state)).await
}

/// `claude` stays the seeded key; `assistant` is a profile under another key
/// that launches the same adapter, so renaming the key is no way round.
async fn seed_claude_profiles(su: &PgPool, tenant: &Tenant) {
    seed_tool_profile(su, tenant.workspace, tenant.owner, "claude", "claude").await;
    seed_tool_profile(
        su,
        tenant.workspace,
        tenant.owner,
        "assistant",
        "claude-agent-acp",
    )
    .await;
}

async fn spawn_request(
    http: &reqwest::Client,
    base: &str,
    bearer: &str,
    tenant: &Tenant,
    run: Uuid,
    host: Uuid,
    tool: &str,
) -> reqwest::Response {
    agent_control(
        http,
        base,
        bearer,
        tenant,
        json!({
            "channelId": tenant.channel,
            "runId": run,
            "targetHostId": host,
            "kind": "spawn",
            "payload": {"tool": tool, "label": "일"},
        }),
    )
    .await
}

async fn create_session_as(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    host: Uuid,
    tool: &str,
) -> reqwest::Response {
    http.post(format!(
        "{base}/v1/workspaces/{}/work-sessions",
        tenant.workspace
    ))
    .bearer_auth(token)
    .json(&json!({
        "channelId": tenant.channel,
        "hostId": host,
        "tool": tool,
        "label": "세션",
    }))
    .send()
    .await
    .expect("create work session")
}

/// **RED PROOF (#3431) — request and decision.** Flag off:
///
/// * an agent's spawn of `claude` (or a profile that launches it under another
///   key) on a team box is 409 `claude_subscription_agent_paused` before the
///   first write — no control, no card — and so is an `input` aimed at a
///   `claude` session there;
/// * a card made while the opt-in was on cannot be approved by anybody once it
///   is off (the teammate, the owner, a retarget): 409, the card stays
///   pending;
/// * the same ask for `codex`, and a `claude` ask once the opt-in is on, are
///   untouched.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn c3431_1_claude_is_not_asked_for_or_approved_on_a_shared_host_while_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_claude_profiles(&su, &tenant).await;
    let (teammate, teammate_email) = seed_teammate(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let off = start_server_claude(app_pool.clone(), false).await;
    let on = start_server_claude(app_pool, true).await;
    let http = reqwest::Client::new();
    let teammate_token = login(&http, &off, tenant.workspace, &teammate_email).await;
    let _ = teammate;

    // ---- request: spawn ------------------------------------------------------
    for tool in ["claude", "assistant"] {
        let (status, code, message) =
            error_of(spawn_request(&http, &off, &bearer, &tenant, run, vps, tool).await).await;
        assert_eq!(status, 409, "{tool}: {message}");
        assert_eq!(code, json!(CLAUDE_PAUSED), "{tool}");
        assert!(message.contains("「AI 화면」"), "{message}");
    }
    assert_eq!(control_count(&su, tenant.workspace).await, 0, "no row");
    assert_eq!(approvals_in(&su, tenant.workspace).await, 0, "no card");

    // ---- the positives: the gate is tool × scope, not a blanket refusal -------
    let codex = spawn_request(&http, &off, &bearer, &tenant, run, vps, "codex").await;
    assert_eq!(codex.status(), 201, "codex is not paused");
    let claude_on = spawn_request(&http, &on, &bearer, &tenant, run, vps, "claude").await;
    assert_eq!(claude_on.status(), 201, "the opt-in opens it");
    let body: Value = claude_on.json().await.expect("body");
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(control_row(&su, control).await.0, "pending_approval");

    // ---- decision: the card made while on cannot be approved once off ---------
    let approval = approval_for(&su, control).await;
    for (who, token) in [("teammate", &teammate_token)] {
        let (status, receipt) = decide(
            &http,
            &off,
            token,
            tenant.workspace,
            approval,
            true,
            Some(vps),
        )
        .await;
        assert_eq!(status, 409, "{who}: {receipt}");
        assert_eq!(receipt["status"], json!(CLAUDE_PAUSED), "{who}: {receipt}");
    }
    let owner_token = login(&http, &off, tenant.workspace, &tenant.owner_email).await;
    let (status, receipt) = decide(
        &http,
        &off,
        &owner_token,
        tenant.workspace,
        approval,
        true,
        None,
    )
    .await;
    assert_eq!(
        status, 409,
        "the owner too — the default host is the box: {receipt}"
    );
    assert_eq!(control_row(&su, control).await.0, "pending_approval");
    assert_eq!(approval_status(&su, approval).await, "pending");
    assert_eq!(dispatched_to(&su, tenant.workspace, vps).await, 0);

    // A rejection is not blocked: nothing will run.
    let (status, _) = decide(
        &http,
        &off,
        &teammate_token,
        tenant.workspace,
        approval,
        false,
        None,
    )
    .await;
    assert_eq!(status, 200, "saying no is always allowed");

    // ---- request: input to a running claude session on the box ----------------
    let claude_session =
        open_claude_session(&http, &on, &owner_token, &tenant, vps, "claude").await;
    let codex_session = open_claude_session(&http, &on, &owner_token, &tenant, vps, "codex").await;
    for session in [claude_session, codex_session] {
        sqlx::query(
            "INSERT INTO work_control \
               (workspace_id, channel_id, requester_member_id, target_host_id, session_id, \
                kind, payload, status) \
             VALUES ($1, $2, $3, $4, $5, 'spawn', $6, 'acked')",
        )
        .bind(tenant.workspace)
        .bind(tenant.channel)
        .bind(tenant.agent)
        .bind(vps)
        .bind(session)
        .bind(json!({"tool": "codex", "label": "l"}))
        .execute(&su)
        .await
        .expect("lineage root");
    }
    let input = |session: Uuid| {
        json!({
            "channelId": tenant.channel,
            "runId": run,
            "targetHostId": vps,
            "sessionId": session,
            "kind": "input",
            "payload": {"text": "계속해 줘"},
        })
    };
    let (status, code, message) =
        error_of(agent_control(&http, &off, &bearer, &tenant, input(claude_session)).await).await;
    assert_eq!((status, code), (409, json!(CLAUDE_PAUSED)), "{message}");
    assert_eq!(
        agent_control(&http, &off, &bearer, &tenant, input(codex_session))
            .await
            .status(),
        201,
        "input to a codex session is untouched"
    );
    assert_eq!(
        agent_control(&http, &on, &bearer, &tenant, input(claude_session))
            .await
            .status(),
        201,
        "the opt-in opens it"
    );
}

async fn open_claude_session(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    host: Uuid,
    tool: &str,
) -> Uuid {
    let created = create_session_as(http, base, token, tenant, host, tool).await;
    assert_eq!(created.status(), 201, "the {tool} session opens");
    let created: Value = created.json().await.expect("session body");
    Uuid::parse_str(created["workSession"]["id"].as_str().expect("id")).expect("uuid")
}

/// **RED PROOF (#3431) — delivery.** A `claude` spawn (and `input` to a
/// `claude` session) already `dispatched` to a shared host — made while the
/// opt-in was on — is not in that host's signed poll once it is off; codex and a
/// member-scoped host's own rows are; the opt-in hands it back.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn c3431_2_a_dispatched_claude_row_is_withheld_from_a_shared_host_while_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_claude_profiles(&su, &tenant).await;
    let (vps, vps_seed) =
        seed_host(&su, &tenant, tenant.owner, "workspace", "cloud", "클라우드").await;
    let (laptop, laptop_seed) = seed_laptop(&su, &tenant).await;

    let off = start_server_claude(app_pool.clone(), false).await;
    let on = start_server_claude(app_pool, true).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &off, tenant.workspace, &tenant.owner_email).await;

    let claude_session =
        open_claude_session(&http, &on, &owner_token, &tenant, vps, "claude").await;
    let codex_session = open_claude_session(&http, &on, &owner_token, &tenant, vps, "codex").await;

    let spawn_claude = insert_dispatched(
        &su,
        &tenant,
        vps,
        tenant.agent,
        None,
        "spawn",
        json!({"tool": "claude", "label": "a"}),
    )
    .await;
    let spawn_renamed = insert_dispatched(
        &su,
        &tenant,
        vps,
        tenant.agent,
        None,
        "spawn",
        json!({"tool": "assistant", "label": "b"}),
    )
    .await;
    let spawn_codex = insert_dispatched(
        &su,
        &tenant,
        vps,
        tenant.agent,
        None,
        "spawn",
        json!({"tool": "codex", "label": "c"}),
    )
    .await;
    let input_claude = insert_dispatched(
        &su,
        &tenant,
        vps,
        tenant.agent,
        Some(claude_session),
        "input",
        json!({"text": "x"}),
    )
    .await;
    let input_codex = insert_dispatched(
        &su,
        &tenant,
        vps,
        tenant.agent,
        Some(codex_session),
        "input",
        json!({"text": "y"}),
    )
    .await;
    // The owner's own laptop: the 「본인 사용이라 허용」 path. A claude spawn the
    // owner requested is delivered whatever the opt-in says.
    let own_claude = insert_dispatched(
        &su,
        &tenant,
        laptop,
        tenant.owner,
        None,
        "spawn",
        json!({"tool": "claude", "label": "mine"}),
    )
    .await;

    let handed = |ids: Vec<Uuid>| {
        let mut ids = ids;
        ids.sort();
        ids
    };
    let mut expected_off = vec![spawn_codex, input_codex];
    expected_off.sort();
    assert_eq!(
        handed(poll_pending(&http, &off, tenant.workspace, vps, &vps_seed).await),
        expected_off,
        "off: only the codex rows reach the shared host"
    );
    let mut expected_on = vec![
        spawn_claude,
        spawn_renamed,
        spawn_codex,
        input_claude,
        input_codex,
    ];
    expected_on.sort();
    assert_eq!(
        handed(poll_pending(&http, &on, tenant.workspace, vps, &vps_seed).await),
        expected_on,
        "on: the opt-in hands every row back"
    );
    assert_eq!(
        poll_pending(&http, &off, tenant.workspace, laptop, &laptop_seed).await,
        vec![own_claude],
        "off: the owner's own claude on their own member-scoped host is delivered"
    );
}

/// **RED PROOF (#3431) — sessions.** A human may not open a `claude` session on
/// a shared host (a row `momo-workd`-style daemons would then act on), nor
/// resume one onto it, while the opt-in is off; a team box takes codex, and the
/// owner's own member-scoped host still takes `claude`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn c3431_3_a_claude_session_is_not_opened_or_resumed_on_a_shared_host_while_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_claude_profiles(&su, &tenant).await;
    let (laptop, _) = seed_laptop(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let spare = seed_team_box(&su, &tenant, "새 상자").await;

    let off = start_server_claude(app_pool.clone(), false).await;
    let on = start_server_claude(app_pool, true).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &off, tenant.workspace, &tenant.owner_email).await;

    for tool in ["claude", "assistant"] {
        let (status, code, message) =
            error_of(create_session_as(&http, &off, &owner_token, &tenant, vps, tool).await).await;
        assert_eq!(
            (status, code),
            (409, json!(CLAUDE_PAUSED)),
            "{tool}: {message}"
        );
    }
    assert_eq!(sessions_on(&su, tenant.workspace, vps).await, 0);
    assert_eq!(
        create_session_as(&http, &off, &owner_token, &tenant, vps, "codex")
            .await
            .status(),
        201,
        "codex is not paused"
    );
    assert_eq!(
        create_session_as(&http, &off, &owner_token, &tenant, laptop, "claude")
            .await
            .status(),
        201,
        "the owner's own member-scoped host takes claude (본인 사용)"
    );

    // ---- resume ----------------------------------------------------------------
    let claude_session =
        open_claude_session(&http, &on, &owner_token, &tenant, vps, "claude").await;
    orphan_session(&su, claude_session).await;
    let resume = |base: &str, target: Uuid| {
        http.post(format!(
            "{base}/v1/workspaces/{}/work-sessions/{claude_session}/resume",
            tenant.workspace
        ))
        .bearer_auth(&owner_token)
        .json(&json!({"targetHostId": target}))
        .send()
    };
    let (status, code, message) = error_of(resume(&off, spare).await.expect("resume")).await;
    assert_eq!((status, code), (409, json!(CLAUDE_PAUSED)), "{message}");
    assert_eq!(
        resume(&on, spare).await.expect("resume").status(),
        201,
        "the opt-in opens it"
    );
}

/// **RED PROOF (#3431) — the spawn tool.** The executor is the last gate for a
/// call that never met a card (a standing auto-approval, a G6 exemption): flag
/// off, `claude` on a team box is refused with the code and starts nothing;
/// codex runs; flag on, claude runs.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn c3431_4_the_spawn_tool_refuses_claude_on_a_shared_host_while_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_claude_profiles(&su, &tenant).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let run = seed_run(&su, &tenant).await;

    let spawn = |call_id: &str, tool: &str| momo_agent::tools::ToolCall {
        call_id: call_id.to_string(),
        name: momo_agent::tools::WORK_SESSION_SPAWN.to_string(),
        arguments: json!({"tool": tool, "label": "실행기", "host_id": vps.to_string()}),
    };
    let context = |enabled: bool| ToolContext {
        workspace_id: tenant.workspace,
        run_id: run,
        channel_id: tenant.channel,
        agent_member_id: tenant.agent,
        approved_by: tenant.owner,
        approved_host_id: Some(vps),
        claude_subscription_agents_enabled: enabled,
    };

    for tool in ["claude", "assistant"] {
        let refused = tool_exec::execute(
            &worker_pool,
            &context(false),
            &spawn(&format!("off-{tool}"), tool),
        )
        .await
        .expect("execute");
        assert!(
            refused.is_error && refused.output.contains(CLAUDE_PAUSED),
            "{tool}: {refused:?}"
        );
    }
    assert_eq!(sessions_on(&su, tenant.workspace, vps).await, 0);
    assert_eq!(control_count(&su, tenant.workspace).await, 0);

    let codex = tool_exec::execute(&worker_pool, &context(false), &spawn("off-codex", "codex"))
        .await
        .expect("execute");
    assert!(!codex.is_error, "codex is not paused: {codex:?}");
    let claude = tool_exec::execute(&worker_pool, &context(true), &spawn("on-claude", "claude"))
        .await
        .expect("execute");
    assert!(!claude.is_error, "the opt-in opens it: {claude:?}");
    assert_eq!(sessions_on(&su, tenant.workspace, vps).await, 2);
}

async fn seed_profile_with_args(
    su: &PgPool,
    tenant: &Tenant,
    tool: &str,
    command: &str,
    arguments: Value,
) {
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, $2, $2, $3, true, $4, $4) \
         ON CONFLICT (workspace_id, tool_key) \
         DO UPDATE SET enabled = true, launch_template = EXCLUDED.launch_template",
    )
    .bind(tenant.workspace)
    .bind(tool)
    .bind(json!({"command": command, "arguments": arguments}))
    .bind(tenant.owner)
    .execute(su)
    .await
    .expect("seed work tool profile with arguments");
}

/// **RED PROOF (#3431 H1) — the standing auto-approval.** The host owner ticked
/// `work_auto_approve` for `claude`; a shared host is auto-approvable by scope
/// (r0_4), so without the gate in front of the auto-approval question the spawn
/// would be `dispatched` with no card. Flag off: 409, **no `work_control` row,
/// no card, nothing dispatched** — which is what fails if the gate is moved
/// after the insert/dispatch. Flag on: the same request dispatches (the
/// positive), so the refusal is the gate and not a broken permission.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn c3431_5_a_standing_auto_approval_does_not_dispatch_claude_to_a_shared_host_while_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_claude_profiles(&su, &tenant).await;
    let (cloud, _) = seed_host(&su, &tenant, tenant.owner, "workspace", "cloud", "클라우드").await;
    let run = seed_run(&su, &tenant).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let off = start_server_claude(app_pool.clone(), false).await;
    let on = start_server_claude(app_pool, true).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &off, tenant.workspace, &tenant.owner_email).await;
    for tool in ["claude", "assistant"] {
        let enabled = http
            .put(format!(
                "{off}/v1/workspaces/{}/work-auto-approvals/{tool}",
                tenant.workspace
            ))
            .bearer_auth(&owner_token)
            .send()
            .await
            .expect("enable auto approve");
        assert_eq!(enabled.status(), 200, "the standing permission for {tool}");
    }

    for tool in ["claude", "assistant"] {
        let (status, code, message) =
            error_of(spawn_request(&http, &off, &bearer, &tenant, run, cloud, tool).await).await;
        assert_eq!(
            (status, code),
            (409, json!(CLAUDE_PAUSED)),
            "{tool}: {message}"
        );
    }
    assert_eq!(
        control_count(&su, tenant.workspace).await,
        0,
        "no row at all"
    );
    assert_eq!(approvals_in(&su, tenant.workspace).await, 0, "no card");
    assert_eq!(
        dispatched_to(&su, tenant.workspace, cloud).await,
        0,
        "nothing dispatched"
    );

    let allowed = spawn_request(&http, &on, &bearer, &tenant, run, cloud, "claude").await;
    assert_eq!(allowed.status(), 201);
    assert_eq!(
        dispatched_to(&su, tenant.workspace, cloud).await,
        1,
        "flag on: the standing permission dispatches it without a card"
    );
}

/// **RED PROOF (#3431 M1/M2) — how Claude is recognised.** Known aliases and a
/// launcher whose arguments name Claude are Claude Code whatever the profile
/// key says; a launcher running something else is not. Judged through the REST
/// ledger (flag off, cloud host) and the host's poll.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn c3431_6_claude_aliases_and_launchers_are_recognised_and_other_launchers_are_not() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (cloud, cloud_seed) =
        seed_host(&su, &tenant, tenant.owner, "workspace", "cloud", "클라우드").await;
    let run = seed_run(&su, &tenant).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let claude_like: [(&str, &str, Value); 9] = [
        ("alias-code", "claude-code", json!([])),
        ("alias-code-acp", "claude-code-acp", json!([])),
        (
            "npx-acp",
            "npx",
            json!(["-y", "@agentclientprotocol/claude-agent-acp"]),
        ),
        ("bunx-up", "bunx", json!(["CLAUDE-AGENT-ACP"])),
        ("env-wrap", "env", json!(["FOO=1", "claude"])),
        ("node-js", "node", json!(["tools/Claude.js"])),
        (
            "pnpm-dlx",
            "pnpm",
            json!(["dlx", "@anthropic-ai/claude-code"]),
        ),
        ("sh-c", "sh", json!(["-c", "exec claude --acp"])),
        ("python-m", "python3", json!(["-m", "claude_agent_acp"])),
    ];
    let not_claude: [(&str, &str, Value); 3] = [
        ("npx-fmt", "npx", json!(["-y", "prettier"])),
        ("node-srv", "node", json!(["server.js"])),
        ("env-plain", "env", json!(["FOO=1", "codex"])),
    ];
    for (tool, command, arguments) in claude_like.iter().chain(not_claude.iter()) {
        seed_profile_with_args(&su, &tenant, tool, command, arguments.clone()).await;
    }

    let off = start_server_claude(app_pool.clone(), false).await;
    let on = start_server_claude(app_pool, true).await;
    let http = reqwest::Client::new();

    for (tool, command, _) in &claude_like {
        let (status, code, message) =
            error_of(spawn_request(&http, &off, &bearer, &tenant, run, cloud, tool).await).await;
        assert_eq!(
            (status, code),
            (409, json!(CLAUDE_PAUSED)),
            "{tool} ({command}) is Claude Code: {message}"
        );
    }
    for (tool, command, _) in &not_claude {
        assert_eq!(
            spawn_request(&http, &off, &bearer, &tenant, run, cloud, tool)
                .await
                .status(),
            201,
            "{tool} ({command}) is not Claude Code"
        );
    }
    assert_eq!(
        spawn_request(&http, &on, &bearer, &tenant, run, cloud, "npx-acp")
            .await
            .status(),
        201,
        "flag on opens it"
    );

    // The poll applies the same recognition to rows dispatched earlier.
    let mut withheld = Vec::new();
    for (tool, _, _) in &claude_like {
        withheld.push(
            insert_dispatched(
                &su,
                &tenant,
                cloud,
                tenant.agent,
                None,
                "spawn",
                json!({"tool": tool, "label": "p"}),
            )
            .await,
        );
    }
    let handed = poll_pending(&http, &off, tenant.workspace, cloud, &cloud_seed).await;
    for control in &withheld {
        assert!(
            !handed.contains(control),
            "{control} reached the shared host"
        );
    }
}

/// **(#3431 L2) — the host-signed create on a cloud host.** A cloud host's own
/// signed `POST work-sessions` with a `controlId` is refused while the opt-in is
/// off; with it on, the same signed create is accepted.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn c3431_7_a_cloud_hosts_signed_session_create_is_refused_while_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    seed_claude_profiles(&su, &tenant).await;
    let (cloud, cloud_seed) =
        seed_host(&su, &tenant, tenant.owner, "workspace", "cloud", "클라우드").await;
    let off = start_server_claude(app_pool.clone(), false).await;
    let on = start_server_claude(app_pool, true).await;
    let http = reqwest::Client::new();

    // (The approval picker never offers a cloud host — `default_spawn_host` and
    // the candidate list skip it — so the decision gate is exercised on a
    // workspace `workd` host in c3431_1; the cloud host's entry points are the
    // REST ledger, the poll and its own signed create below.)
    // ---- host-signed create with controlId --------------------------------------
    let dispatched = insert_dispatched(
        &su,
        &tenant,
        cloud,
        tenant.agent,
        None,
        "spawn",
        json!({"tool": "claude", "label": "일"}),
    )
    .await;
    let create = |base: String| {
        let body = serde_json::to_vec(&json!({
            "channelId": tenant.channel,
            "hostId": cloud,
            "tool": "claude",
            "label": "일",
            "controlId": dispatched,
        }))
        .unwrap();
        let request = SignedRequest::new(
            reqwest::Method::POST,
            &format!("/v1/workspaces/{}/work-sessions", tenant.workspace),
            tenant.workspace,
            cloud,
            &cloud_seed,
            body,
        );
        let http = http.clone();
        async move { request.send(&http, &base).await }
    };
    let (status, code, message) = error_of(create(off.clone()).await).await;
    assert_eq!((status, code), (409, json!(CLAUDE_PAUSED)), "{message}");
    assert_eq!(sessions_on(&su, tenant.workspace, cloud).await, 0);
    let accepted = create(on.clone()).await;
    assert_eq!(
        accepted.status(),
        201,
        "flag on: the signed create is accepted"
    );
}

/// #3583 / ADR-0188 증보: `GET …/work-hosts` hands a member **who is not the
/// owner** only presence for somebody else's personal machine — id, scope, type,
/// owner, online, revoked. The device name is replaced by a generic one built
/// from the owner's name, and the public key and capability flags are absent.
/// The owner and the workspace-scoped box keep the full row, and the observing
/// surfaces still see that a host is online.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_3583_other_members_personal_host_is_listed_as_presence_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (member, member_email) = seed_human(&su, tenant.workspace, "member", "민준").await;
    join_channel(&su, tenant.workspace, tenant.channel, member).await;
    let (admin, admin_email) = seed_teammate(&su, &tenant).await;
    let secret_name = "서재의 비밀 맥북";
    let (laptop, _) = seed_host(&su, &tenant, tenant.owner, "member", "app", secret_name).await;
    let vps = seed_team_box(&su, &tenant, "팀 VPS").await;
    let _ = admin;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let list = |token: String| {
        let http = http.clone();
        let url = format!("{base}/v1/workspaces/{}/work-hosts", tenant.workspace);
        async move {
            let response = http
                .get(url)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await
                .expect("list work hosts");
            assert_eq!(response.status(), 200);
            let body: Value = response.json().await.expect("list body");
            body["workHosts"].as_array().cloned().expect("workHosts")
        }
    };
    let find = |rows: &[Value], id: Uuid| -> Value {
        rows.iter()
            .find(|row| row["id"] == json!(id.to_string()))
            .cloned()
            .unwrap_or(Value::Null)
    };

    // The owner sees the whole row.
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let owner_rows = list(owner_token).await;
    let own = find(&owner_rows, laptop);
    assert_eq!(own["displayName"], json!(secret_name));
    assert!(own["publicKey"].as_str().is_some_and(|k| !k.is_empty()));
    assert!(own.get("capabilities").is_some());

    // A plain member and an admin both get presence only for the owner's laptop.
    for email in [&member_email, &admin_email] {
        let token = login(&http, &base, tenant.workspace, email).await;
        let rows = list(token).await;
        let theirs = find(&rows, laptop);
        assert_ne!(
            theirs,
            Value::Null,
            "presence of the laptop is still listed"
        );
        assert_eq!(theirs["ownerMemberId"], json!(tenant.owner.to_string()));
        assert_eq!(theirs["scope"], json!("member"));
        assert_eq!(theirs["type"], json!("app"));
        assert_eq!(theirs["online"], json!(true));
        assert_eq!(theirs["displayName"], json!("성재의 맥"));
        assert!(
            theirs.get("publicKey").is_none(),
            "public key leaked: {theirs}"
        );
        assert!(
            theirs.get("capabilities").is_none(),
            "capabilities leaked: {theirs}"
        );
        assert!(
            !serde_json::to_string(&rows).unwrap().contains(secret_name),
            "the device name leaked into the list"
        );
        // The workspace box is unchanged for everybody.
        let team = find(&rows, vps);
        assert_eq!(team["displayName"], json!("팀 VPS"));
        assert!(team["publicKey"].as_str().is_some_and(|k| !k.is_empty()));
        assert!(team.get("capabilities").is_some());
    }
}

/// One list call as `email`, returning the row of `host`.
async fn listed_host_as(
    http: &reqwest::Client,
    base: &str,
    tenant: &Tenant,
    email: &str,
    host: Uuid,
) -> Value {
    let token = login(http, base, tenant.workspace, email).await;
    let response = http
        .get(format!(
            "{base}/v1/workspaces/{}/work-hosts",
            tenant.workspace
        ))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("list work hosts");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("list body");
    body["workHosts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == json!(host.to_string())))
        .cloned()
        .unwrap_or(Value::Null)
}

/// #3583 H1: the revoke response goes through the same masking as the list. An
/// admin who revokes somebody else's personal machine gets presence only back;
/// the owner revoking their own still gets the whole row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_3583_revoke_response_masks_another_members_personal_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (_admin, admin_email) = seed_teammate(&su, &tenant).await;
    let secret_name = "서재의 비밀 맥북";
    let (laptop, _) = seed_host(&su, &tenant, tenant.owner, "member", "app", secret_name).await;
    let (own_laptop, _) =
        seed_host(&su, &tenant, tenant.owner, "member", "app", "내 두번째 맥").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let revoke = |token: String, host: Uuid| {
        let http = http.clone();
        let url = format!(
            "{base}/v1/workspaces/{}/work-hosts/{host}",
            tenant.workspace
        );
        async move {
            let response = http
                .delete(url)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await
                .expect("revoke");
            assert_eq!(response.status(), 200);
            response.json::<Value>().await.expect("revoke body")
        }
    };

    let admin_token = login(&http, &base, tenant.workspace, &admin_email).await;
    let body = revoke(admin_token, laptop).await;
    let row = &body["workHost"];
    assert_eq!(row["id"], json!(laptop.to_string()));
    assert!(row["revokedAtMs"].is_number(), "it is revoked: {row}");
    assert_eq!(row["displayName"], json!("성재의 맥"));
    assert!(row.get("publicKey").is_none(), "public key leaked: {row}");
    assert!(
        row.get("capabilities").is_none(),
        "capabilities leaked: {row}"
    );
    assert!(!body.to_string().contains(secret_name));

    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let own = revoke(owner_token, own_laptop).await;
    assert_eq!(own["workHost"]["displayName"], json!("내 두번째 맥"));
    assert!(own["workHost"]["publicKey"].is_string());
    assert!(own["workHost"].get("capabilities").is_some());
}

/// #3583 L3: the generic name has fallbacks — a blank owner name, an owner who
/// has left (suspended), and a non-`app` host which is not called a Mac.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r0_3583_generic_host_name_fallbacks() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (_member, member_email) = seed_human(&su, tenant.workspace, "member", "민준").await;

    let (blank_owner, _) = seed_human(&su, tenant.workspace, "member", "   ").await;
    let (gone_owner, _) = seed_human(&su, tenant.workspace, "member", "떠난사람").await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(gone_owner)
        .execute(&su)
        .await
        .expect("suspend owner");
    let (blank_host, _) = seed_host(&su, &tenant, blank_owner, "member", "app", "비밀1").await;
    let (gone_host, _) = seed_host(&su, &tenant, gone_owner, "member", "app", "비밀2").await;
    let (workd_host, _) = seed_host(&su, &tenant, tenant.owner, "member", "workd", "비밀3").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    for (host, expected) in [
        (blank_host, "팀원의 맥"),
        (gone_host, "팀원의 맥"),
        (workd_host, "성재의 호스트"),
    ] {
        let row = listed_host_as(&http, &base, &tenant, &member_email, host).await;
        assert_eq!(row["displayName"], json!(expected), "row: {row}");
        assert!(row.get("publicKey").is_none() && row.get("capabilities").is_none());
    }
}

// ---------------------------------------------------------------------------
// #3590 N5 — the folders a host issued (ADR-0188 D6, ADR-0198 증보 1 D7)
// ---------------------------------------------------------------------------

/// One signed heartbeat carrying `body` (a folder announcement), as the host.
async fn announce_folders(
    http: &reqwest::Client,
    base: &str,
    tenant: &Tenant,
    host: Uuid,
    seed: &[u8; 32],
    body: Value,
) -> reqwest::Response {
    let raw = if body.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(&body).expect("body")
    };
    SignedRequest::new(
        reqwest::Method::POST,
        &heartbeat_path(tenant.workspace, host),
        tenant.workspace,
        host,
        seed,
        raw,
    )
    .send(http, base)
    .await
}

fn two_folders() -> Value {
    json!({"folders": [
        {"id": "fld_repo", "displayName": "momo", "kind": "project"},
        {"id": "fld_ask", "displayName": "질문용 폴더", "kind": "question"},
    ]})
}

async fn folder_rows(su: &PgPool, host: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_host_folder WHERE host_id = $1")
        .bind(host)
        .fetch_one(su)
        .await
        .expect("count folders")
}

/// The owner reads the ids and names a host issued, plus the 「질문용 폴더」
/// default. Nobody else does: not a member, not an admin, and not the owner's
/// teammates for a team box. No answer anywhere carries an absolute path.
/// Sabotage: stop clearing `folders`/`default_folder_id` in the foreign branch of
/// `dto_for_viewer`, or load folders for every host in `list`, and the member and
/// admin assertions fail.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r3590_1_the_owner_reads_folders_and_nobody_else_does() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (member, member_email) = seed_human(&su, tenant.workspace, "member", "민준").await;
    join_channel(&su, tenant.workspace, tenant.channel, member).await;
    let (_admin, admin_email) = seed_teammate(&su, &tenant).await;
    let (laptop, seed) = seed_laptop(&su, &tenant).await;
    let (box_host, box_seed) =
        seed_host(&su, &tenant, tenant.owner, "workspace", "workd", "팀 VPS").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    // Before any announcement: the owner has an empty list and no default.
    let before = listed_host_as(&http, &base, &tenant, &tenant.owner_email, laptop).await;
    assert_eq!(before["folders"], json!([]), "{before}");
    assert!(before.get("defaultFolderId").is_none(), "{before}");

    for (host, seed) in [(laptop, &seed), (box_host, &box_seed)] {
        let response = announce_folders(&http, &base, &tenant, host, seed, two_folders()).await;
        assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    }

    // The owner: both folders, the question folder is the default.
    let own = listed_host_as(&http, &base, &tenant, &tenant.owner_email, laptop).await;
    assert_eq!(
        own["folders"],
        json!([
            {"id": "fld_ask", "displayName": "질문용 폴더", "kind": "question"},
            {"id": "fld_repo", "displayName": "momo", "kind": "project"},
        ]),
        "{own}"
    );
    assert_eq!(own["defaultFolderId"], json!("fld_ask"), "{own}");

    // A member and an admin: presence only for the owner's personal Mac, and no
    // folder, id, name or default anywhere in what they are sent (admins
    // included: the list and the revoke answer share one function).
    for email in [&member_email, &admin_email] {
        let theirs = listed_host_as(&http, &base, &tenant, email, laptop).await;
        assert_ne!(theirs, Value::Null);
        assert!(theirs.get("folders").is_none(), "folders leaked: {theirs}");
        assert!(
            theirs.get("defaultFolderId").is_none(),
            "default leaked: {theirs}"
        );
        let token = login(&http, &base, tenant.workspace, email).await;
        let all = http
            .get(format!(
                "{base}/v1/workspaces/{}/work-hosts",
                tenant.workspace
            ))
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .expect("list")
            .text()
            .await
            .expect("text");
        for leaked in ["fld_repo", "fld_ask", "질문용 폴더", "\"momo\"", "folders"] {
            assert!(!all.contains(leaked), "{leaked} reached {email}: {all}");
        }
        // The team box is the owner's alone to read folders from too.
        let team = listed_host_as(&http, &base, &tenant, email, box_host).await;
        assert!(team.get("folders").is_none(), "team box folders: {team}");
    }
    let team_owner = listed_host_as(&http, &base, &tenant, &tenant.owner_email, box_host).await;
    assert_eq!(team_owner["defaultFolderId"], json!("fld_ask"));

    // An admin who revokes the owner's Mac gets presence only back, and the
    // revoked host stops showing folders even to its owner.
    let admin_token = login(&http, &base, tenant.workspace, &admin_email).await;
    let revoked = http
        .delete(format!(
            "{base}/v1/workspaces/{}/work-hosts/{laptop}",
            tenant.workspace
        ))
        .header("Authorization", format!("Bearer {admin_token}"))
        .send()
        .await
        .expect("revoke")
        .text()
        .await
        .expect("text");
    for leaked in ["fld_repo", "fld_ask", "folders", "defaultFolderId"] {
        assert!(!revoked.contains(leaked), "{leaked} in revoke: {revoked}");
    }
    let after = listed_host_as(&http, &base, &tenant, &tenant.owner_email, laptop).await;
    assert!(after.get("folders").is_none(), "revoked host: {after}");
}

/// What a host may announce. A path as a name, a `path` field, a bad id, two
/// question folders: each is a 400 that stores nothing and echoes nothing. The
/// table itself also refuses a path-shaped name (the DB half of the guarantee).
/// An empty body leaves the stored folders alone; `[]` clears; re-announcing
/// without the question folder removes the default (never falls back to a
/// project folder). Sabotage: allow `/` in `validated_announced_folders` and the
/// 400s fail; drop `work_host_folder_name_ck` and the insert test fails.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r3590_2_a_host_announces_names_never_paths_and_the_default_rule_holds() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (laptop, seed) = seed_laptop(&su, &tenant).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let path = "/Users/kwakseongjae/projects/momo";

    for (label, body) in [
        (
            "path as name",
            json!({"folders": [{"id": "f1", "displayName": path, "kind": "project"}]}),
        ),
        (
            "windows path as name",
            json!({"folders": [{"id": "f1", "displayName": "C:\\work\\momo", "kind": "project"}]}),
        ),
        (
            "path field",
            json!({"folders": [{"id": "f1", "displayName": "momo", "kind": "project", "path": path}]}),
        ),
        (
            "path as id",
            json!({"folders": [{"id": path, "displayName": "momo", "kind": "project"}]}),
        ),
        (
            "two question folders",
            json!({"folders": [
                {"id": "q1", "displayName": "a", "kind": "question"},
                {"id": "q2", "displayName": "b", "kind": "question"}]}),
        ),
        (
            "duplicate ids",
            json!({"folders": [
                {"id": "d", "displayName": "a", "kind": "project"},
                {"id": "d", "displayName": "b", "kind": "project"}]}),
        ),
        (
            "unknown kind",
            json!({"folders": [{"id": "f1", "displayName": "a", "kind": "shell"}]}),
        ),
    ] {
        let response = announce_folders(&http, &base, &tenant, laptop, &seed, body).await;
        let (status, _, text) = error_of(response).await;
        assert_eq!(status, 400, "{label}: {text}");
        assert!(
            !text.contains("Users"),
            "{label}: the path was echoed: {text}"
        );
        assert_eq!(folder_rows(&su, laptop).await, 0, "{label}: stored");
    }

    // The DB half: even a writer that skipped the route cannot store a path.
    for name in [path, "a\\b", "x\ny"] {
        let inserted = sqlx::query(
            "INSERT INTO work_host_folder (workspace_id, host_id, folder_id, display_name, kind) \
             VALUES ($1, $2, 'raw', $3, 'project')",
        )
        .bind(tenant.workspace)
        .bind(laptop)
        .bind(name)
        .execute(&su)
        .await;
        assert!(inserted.is_err(), "the table accepted {name:?}");
    }

    // Accepted: both folders. An empty-body heartbeat leaves them alone.
    let ok = announce_folders(&http, &base, &tenant, laptop, &seed, two_folders()).await;
    assert_eq!(ok.status(), 200);
    let empty = announce_folders(&http, &base, &tenant, laptop, &seed, Value::Null).await;
    assert_eq!(empty.status(), 200);
    assert_eq!(folder_rows(&su, laptop).await, 2);

    // Without the question folder there is no default: the project folder is
    // never promoted to it.
    let only_project =
        json!({"folders": [{"id": "fld_repo", "displayName": "momo", "kind": "project"}]});
    let ok = announce_folders(&http, &base, &tenant, laptop, &seed, only_project).await;
    assert_eq!(ok.status(), 200);
    let own = listed_host_as(&http, &base, &tenant, &tenant.owner_email, laptop).await;
    assert_eq!(own["folders"].as_array().map(Vec::len), Some(1), "{own}");
    assert!(own.get("defaultFolderId").is_none(), "{own}");

    // The question folder may change id and a project may become it (rekind).
    let swap = json!({"folders": [
        {"id": "fld_repo", "displayName": "momo", "kind": "question"},
        {"id": "fld_new", "displayName": "새 폴더", "kind": "project"}]});
    let ok = announce_folders(&http, &base, &tenant, laptop, &seed, swap).await;
    assert_eq!(ok.status(), 200, "{}", ok.text().await.unwrap());
    let own = listed_host_as(&http, &base, &tenant, &tenant.owner_email, laptop).await;
    assert_eq!(own["defaultFolderId"], json!("fld_repo"), "{own}");
    // ... and the two exchange kinds in one announcement without meeting the
    // one-question-per-host index half way.
    let exchange = json!({"folders": [
        {"id": "fld_repo", "displayName": "momo", "kind": "project"},
        {"id": "fld_new", "displayName": "새 폴더", "kind": "question"}]});
    let ok = announce_folders(&http, &base, &tenant, laptop, &seed, exchange).await;
    assert_eq!(ok.status(), 200, "{}", ok.text().await.unwrap());
    let own = listed_host_as(&http, &base, &tenant, &tenant.owner_email, laptop).await;
    assert_eq!(own["defaultFolderId"], json!("fld_new"), "{own}");

    // `[]` clears.
    let ok = announce_folders(&http, &base, &tenant, laptop, &seed, json!({"folders": []})).await;
    assert_eq!(ok.status(), 200);
    assert_eq!(folder_rows(&su, laptop).await, 0);
}

/// #3590 security review: the revoke, rewrite-only-on-change, look-alike name,
/// cross-workspace and FORCE-RLS properties of the folder table.
/// Sabotage: drop the DELETE in `mark_work_host_revoked` (M1), the `WHERE ...
/// IS DISTINCT FROM` in `replace_work_host_folders` (M2), the Cf/look-alike
/// ranges in `momo_wire::folder_name` or the migration's class (L1), the
/// composite FK (L2), or FORCE RLS (L4), and the matching assertion fails.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn r3590_3_review_findings_revoke_unchanged_rewrites_lookalikes_and_tenancy() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let other = seed_tenant(&su, &app_pool).await;
    let (laptop, seed) = seed_laptop(&su, &tenant).await;
    let (other_laptop, _) = seed_laptop(&su, &other).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    // ---- L4: FORCE RLS is on, as the bootstrap roles rely on ---------------
    let (rls, forced): (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class \
          WHERE relname = 'work_host_folder' AND relkind = 'r'",
    )
    .fetch_one(&su)
    .await
    .expect("pg_class");
    assert!(rls && forced, "work_host_folder must be ENABLE + FORCE RLS");

    // ---- L4: a heartbeat sent down another workspace's path is refused ------
    let crossed = SignedRequest::new(
        reqwest::Method::POST,
        &heartbeat_path(other.workspace, laptop),
        other.workspace,
        laptop,
        &seed,
        serde_json::to_vec(&two_folders()).unwrap(),
    )
    .send(&http, &base)
    .await;
    assert_eq!(
        crossed.status(),
        401,
        "a host's key signs nothing elsewhere"
    );
    assert_eq!(folder_rows(&su, laptop).await, 0);
    assert_eq!(folder_rows(&su, other_laptop).await, 0);

    // ---- L2: a folder row cannot name a host of another workspace ----------
    let crossed_row = sqlx::query(
        "INSERT INTO work_host_folder (workspace_id, host_id, folder_id, display_name, kind) \
         VALUES ($1, $2, 'x', 'x', 'project')",
    )
    .bind(other.workspace)
    .bind(laptop)
    .execute(&su)
    .await;
    assert!(crossed_row.is_err(), "the composite FK must refuse it");

    // ---- M2: an unchanged announcement rewrites nothing --------------------
    let ok = announce_folders(&http, &base, &tenant, laptop, &seed, two_folders()).await;
    assert_eq!(ok.status(), 200);
    let snapshot = |su: PgPool| async move {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT folder_id, xmin::text, updated_at::text FROM work_host_folder \
              WHERE host_id = $1 ORDER BY folder_id",
        )
        .bind(laptop)
        .fetch_all(&su)
        .await
        .expect("snapshot")
    };
    let first = snapshot(su.clone()).await;
    assert_eq!(first.len(), 2);
    for _ in 0..2 {
        let again = announce_folders(&http, &base, &tenant, laptop, &seed, two_folders()).await;
        assert_eq!(again.status(), 200);
    }
    assert_eq!(
        snapshot(su.clone()).await,
        first,
        "identical beats rewrote rows"
    );
    let renamed = json!({"folders": [
        {"id": "fld_repo", "displayName": "momo 2", "kind": "project"},
        {"id": "fld_ask", "displayName": "질문용 폴더", "kind": "question"}]});
    let ok = announce_folders(&http, &base, &tenant, laptop, &seed, renamed).await;
    assert_eq!(ok.status(), 200);
    let after = snapshot(su.clone()).await;
    assert_ne!(after[1], first[1], "a changed name is written");
    assert_eq!(after[0], first[0], "the untouched row is not");

    // ---- L1: look-alike separators and invisible/reordering characters -----
    for name in [
        "a\u{2215}b",
        "a\u{FF0F}b",
        "a\u{2044}b",
        "a\u{202E}b",
        "a\u{200B}b",
        "a\u{FEFF}",
        "a\u{2066}b",
    ] {
        let body = json!({"folders": [{"id": "l1", "displayName": name, "kind": "project"}]});
        let response = announce_folders(&http, &base, &tenant, laptop, &seed, body).await;
        assert_eq!(
            response.status(),
            400,
            "{name:?} was accepted by the server"
        );
    }
    // The table agrees with the shared rule on every range's two ends.
    for &(lo, hi) in momo_wire::folder_name::FORBIDDEN_NAME_RANGES {
        for cp in [lo, hi] {
            let name = format!("a{}b", char::from_u32(cp).expect("scalar"));
            let inserted = sqlx::query(
                "INSERT INTO work_host_folder (workspace_id, host_id, folder_id, display_name, kind) \
                 VALUES ($1, $2, 'rng', $3, 'project')",
            )
            .bind(tenant.workspace)
            .bind(laptop)
            .bind(&name)
            .execute(&su)
            .await;
            assert!(inserted.is_err(), "the table accepted U+{cp:04X}");
        }
    }

    // ---- M1: a revoked host keeps no folders --------------------------------
    assert_eq!(folder_rows(&su, laptop).await, 2);
    let token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let revoked = http
        .delete(format!(
            "{base}/v1/workspaces/{}/work-hosts/{laptop}",
            tenant.workspace
        ))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("revoke");
    assert_eq!(revoked.status(), 200);
    assert_eq!(folder_rows(&su, laptop).await, 0, "revoke left folder rows");
}
