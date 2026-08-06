//! DB-backed conformance for the **server chain** #1114-잔여 + #1139: the daemon
//! path (signed `pending-controls` + signed ack), the D6-A "마지막 사용" default,
//! and the resume target validation that was missing from the Rust port
//! entirely.
//!
//! Two absences motivated these tests, and both were measured before they were
//! fixed:
//!
//! * #1132 landed the control ledger but no way for a **host** to learn about it
//!   or answer it — "인증만 열린 꼴"; a spawn could reach `dispatched` and stop
//!   there forever.
//! * #1138 measured that `work_sessions::resume` asked **nothing** about the
//!   target host, so the client core's `takeoverTargets` filter was the only
//!   check in the system — a fail-open a `curl` closes.
//!
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus
//! the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:5432/momo \
//!   cargo test -p momo-server --test daemon_ack_resume_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `work_control_spawn_conformance_pg.rs`:
//! `DATABASE_URL` connects as a **superuser** (migrations +
//! `infra/e2e/bootstrap_roles.sql`, fixtures bypass RLS); the **server** runs on
//! `momo_app` (NOBYPASSRLS) so every assertion is made through the policies
//! production uses.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `srvchain_1_a_daemon_learns_what_a_human_approved_and_reports_it_back` | unmount `pending-controls`, drop its `status = 'dispatched'` filter, or take the work-host arm back out of `acknowledge` |
//! | `srvchain_2_an_unsigned_or_foreign_ack_never_settles_a_control` (**red proof 1**) | let the ack route accept a caller without the `MomoHost` signature, drop the `target_host_id` comparison, or stop consuming the one-time request id |
//! | `srvchain_3_resume_refuses_a_target_the_server_would_not_offer` (**red proofs 2+3**) | delete any of `resume_target_rejection_in_tx`'s five branches, or the `t1_only` tier gate |
//! | `srvchain_4_a_takeover_actually_restarts_the_tool_on_the_new_host` | drop the `work_control` spawn dispatch from `resume_in_tx` |
//! | `srvchain_5_the_card_remembers_the_host_you_chose_last` | ignore `last_used` in `default_spawn_host`, or stop recording it on dispatch |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
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

const TEST_JWT_SECRET: &str = "srvchain-daemon-resume-conformance-secret";
const TEST_PASSWORD: &str = "srvchain-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
const TOOL: &str = "codex";

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
    let email = format!("{human}@srvchain.test");
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
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("srvchain-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create channel")
    .id;
    seed_tool_profile(su, workspace, human, TOOL).await;
    Tenant {
        workspace,
        human,
        email,
        channel,
    }
}

async fn seed_tool_profile(su: &PgPool, workspace: Uuid, by: Uuid, tool: &str) {
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, $2, $2, $3, true, $4, $4) \
         ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true",
    )
    .bind(workspace)
    .bind(tool)
    .bind(json!({"command": tool, "arguments": []}))
    .bind(by)
    .execute(su)
    .await
    .expect("seed work tool profile");
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

/// A host row seeded straight into the ledger. Used where nothing signs —
/// the picker/default tests. `seen_ago_seconds` drives the 90s online window.
async fn seed_host(
    su: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    scope: &str,
    host_type: &str,
    display: &str,
    seen_ago_seconds: Option<i64>,
) -> Uuid {
    let host = Uuid::new_v4();
    let (_, public_key) = daemon_keypair();
    sqlx::query(
        "INSERT INTO work_host \
           (id, workspace_id, scope, owner_member_id, type, display_name, public_key, \
            capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, \
                 CASE WHEN $8::bigint IS NULL THEN NULL \
                      ELSE clock_timestamp() - make_interval(secs => $8::bigint) END)",
    )
    .bind(host)
    .bind(workspace)
    .bind(scope)
    .bind(owner)
    .bind(host_type)
    .bind(display)
    .bind(public_key)
    .bind(seen_ago_seconds)
    .execute(su)
    .await
    .expect("seed work host");
    host
}

/// A host that can actually sign, seeded with its private half kept by the test
/// — this is the daemon the whole first half of this suite plays.
async fn seed_signing_host(
    su: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    scope: &str,
    display: &str,
) -> (Uuid, [u8; 32]) {
    let (seed, public_key) = daemon_keypair();
    let host = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host \
           (id, workspace_id, scope, owner_member_id, type, display_name, public_key, \
            capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, 'workd', $5, $6, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host)
    .bind(workspace)
    .bind(scope)
    .bind(owner)
    .bind(display)
    .bind(public_key)
    .execute(su)
    .await
    .expect("seed signing work host");
    (host, seed)
}

fn daemon_keypair() -> ([u8; 32], String) {
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
}

async fn seed_run(su: &PgPool, tenant: &Tenant, agent: Uuid) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'running'::run_status, $5, $6)",
    )
    .bind(run)
    .bind(tenant.workspace)
    .bind(agent)
    .bind(tenant.channel)
    .bind(json!({"type": "work", "title": "srvchain", "brief": "srvchain"}))
    .bind(format!("srvchain:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

/// Mint an agent bearer carrying `work:control`.
async fn agent_bearer(su: &PgPool, tenant: &Tenant, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", tenant.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 'srvchain-conformance')",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

/// The sweep's verdict, applied as a fixture: no HTTP path writes `orphaned`
/// (ADR-0125 D11 — it is the offline sweep's word, and #1138 measured that the
/// absence of a forcing flag is what makes takeover one-way).
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

async fn set_tier_policy(su: &PgPool, workspace: Uuid, mode: &str, auto_target: Option<String>) {
    sqlx::query(
        "INSERT INTO work_tier_policy (workspace_id, member_id, mode, auto_target) \
              VALUES ($1, NULL, $2, $3) \
         ON CONFLICT (workspace_id) WHERE member_id IS NULL \
         DO UPDATE SET mode = EXCLUDED.mode, auto_target = EXCLUDED.auto_target",
    )
    .bind(workspace)
    .bind(mode)
    .bind(auto_target)
    .execute(su)
    .await
    .expect("seed tier policy");
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

/// Everything a daemon puts on the wire, in one place: the v2 payload over
/// method + path + tenant + host + clock + **raw body digest** + a one-time
/// request id. Parameterised on every one of those so the red proofs can spoil
/// exactly one at a time.
struct SignedRequest {
    method: reqwest::Method,
    path: String,
    body: Option<Value>,
    /// The host named in `Authorization` (and therefore in the payload).
    claimed_host: Uuid,
    /// The key that actually signs — differs from the claimed host's in the
    /// impostor proofs.
    seed: [u8; 32],
    request_id: Uuid,
}

impl SignedRequest {
    fn new(method: reqwest::Method, path: String, host: Uuid, seed: [u8; 32]) -> Self {
        Self {
            method,
            path,
            body: None,
            claimed_host: host,
            seed,
            request_id: Uuid::new_v4(),
        }
    }

    fn with_body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    async fn send(&self, http: &reqwest::Client, base: &str, workspace: Uuid) -> reqwest::Response {
        let raw = match &self.body {
            Some(body) => serde_json::to_vec(body).expect("serialize the signed body"),
            None => Vec::new(),
        };
        let digest = momo_wire::signing::sha256_hex(&raw);
        let sent_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;
        let payload = momo_wire::signing::request_payload(
            self.method.as_str(),
            &self.path,
            workspace,
            self.claimed_host,
            sent_at_ms,
            &digest,
            self.request_id,
        );
        let signature = momo_wire::signing::sign_base64(&self.seed, &payload).expect("sign");
        let mut request = http
            .request(self.method.clone(), format!("{base}{}", self.path))
            .header("Authorization", format!("MomoHost {}", self.claimed_host))
            .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
            .header("X-Momo-Work-Host-Signature", signature)
            .header("X-Momo-Work-Host-Request-ID", self.request_id.to_string());
        if self.body.is_some() {
            request = request.header("Content-Type", "application/json").body(raw);
        }
        request.send().await.expect("signed host request")
    }
}

fn pending_path(workspace: Uuid, host: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/work-hosts/{host}/pending-controls")
}

fn ack_path(workspace: Uuid, control: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/work-controls/{control}/ack")
}

async fn poll_pending(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    host: Uuid,
    seed: [u8; 32],
) -> Vec<Value> {
    let response = SignedRequest::new(
        reqwest::Method::GET,
        pending_path(workspace, host),
        host,
        seed,
    )
    .send(http, base, workspace)
    .await;
    assert_eq!(
        response.status(),
        200,
        "a host may poll its own queue: {:?}",
        response.text().await
    );
    let body: Value = response.json().await.expect("pending body");
    body["workControls"]
        .as_array()
        .expect("workControls array")
        .clone()
}

async fn request_spawn(
    http: &reqwest::Client,
    base: &str,
    bearer: &str,
    tenant: &Tenant,
    run: Uuid,
    host: Uuid,
    label: &str,
) -> Uuid {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-controls",
            tenant.workspace
        ))
        .bearer_auth(bearer)
        .json(&json!({
            "channelId": tenant.channel,
            "runId": run,
            "targetHostId": host,
            "kind": "spawn",
            "payload": {"tool": TOOL, "label": label},
        }))
        .send()
        .await
        .expect("request spawn control");
    assert_eq!(response.status(), 201, "an agent may request a control");
    let body: Value = response.json().await.expect("control body");
    Uuid::parse_str(body["workControl"]["id"].as_str().expect("control id")).expect("uuid")
}

async fn decide(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    approval: Uuid,
    host: Option<Uuid>,
) -> reqwest::Response {
    let mut body = json!({
        "approval_id": approval,
        "approve": true,
        "client_decision_id": Uuid::new_v4(),
    });
    if let Some(host) = host {
        body["hostId"] = json!(host);
    }
    http.post(format!(
        "{base}/v1/workspaces/{workspace}/approvals/{approval}/decision"
    ))
    .bearer_auth(token)
    .json(&body)
    .send()
    .await
    .expect("decide approval")
}

async fn create_session(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    host: Uuid,
    label: &str,
) -> Uuid {
    let response = http
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
    assert_eq!(response.status(), 201, "the human may open a session");
    let body: Value = response.json().await.expect("session body");
    Uuid::parse_str(body["workSession"]["id"].as_str().expect("session id")).expect("uuid")
}

async fn resume(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    session: Uuid,
    target: Uuid,
) -> reqwest::Response {
    http.post(format!(
        "{base}/v1/workspaces/{workspace}/work-sessions/{session}/resume"
    ))
    .bearer_auth(token)
    .json(&json!({"targetHostId": target}))
    .send()
    .await
    .expect("resume work session")
}

async fn error_message(response: reqwest::Response) -> String {
    let payload: Value = response.json().await.expect("error body");
    payload["error"]["message"]
        .as_str()
        .or_else(|| payload["decisionReason"].as_str())
        .unwrap_or_default()
        .to_string()
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

async fn sole_approval(su: &PgPool, workspace: Uuid) -> (Uuid, Value) {
    let rows = sqlx::query(
        "SELECT id, payload FROM approval WHERE workspace_id = $1 ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read approvals");
    assert_eq!(rows.len(), 1, "exactly one approval was raised");
    (rows[0].get("id"), rows[0].get("payload"))
}

async fn approvals_payloads(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM approval WHERE workspace_id = $1 ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read approvals")
}

async fn broadcasts(su: &PgPool, workspace: Uuid, event_type: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = $2 \
          ORDER BY id",
    )
    .bind(workspace)
    .bind(event_type)
    .fetch_all(su)
    .await
    .expect("read broadcasts")
}

async fn session_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_session WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count sessions")
}

async fn last_used_host(su: &PgPool, workspace: Uuid, member: Uuid) -> Option<Uuid> {
    sqlx::query_scalar(
        "SELECT host_id FROM work_host_last_used WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read last used host")
}

// ---------------------------------------------------------------------------
// 1 — the daemon path, end to end
// ---------------------------------------------------------------------------

/// **THE CLOSED CURVE #1132 could not draw.** A person approves a spawn; the
/// host it was sent to *learns* about it under its own signature, runs it, and
/// reports back under that same signature — and the queue then goes quiet.
///
/// Every hop here was unreachable before this change: `pending-controls` had no
/// handler, `work_host_auth` refused to sign either path, and `acknowledge`
/// served humans only. The assertion that matters most is the last one: after
/// the ack the queue is **empty**, because a daemon that kept being told to
/// start a tool it already started is how one approval becomes many sessions.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srvchain_1_a_daemon_learns_what_a_human_approved_and_reports_it_back() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent).await;

    let (host, seed) =
        seed_signing_host(&su, tenant.workspace, tenant.human, "workspace", "팀 VPS").await;
    // A second daemon in the same workspace. Its queue must stay its own.
    let (neighbour, neighbour_seed) =
        seed_signing_host(&su, tenant.workspace, tenant.human, "workspace", "옆 VPS").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let bearer = agent_bearer(&su, &tenant, agent).await;

    // Nothing is pending before anyone decides — an undecided spawn is invisible
    // to the host, which is the same rule red proof 1 states from the ack side.
    let control = request_spawn(&http, &base, &bearer, &tenant, run, host, "리팩터링").await;
    assert!(
        poll_pending(&http, &base, tenant.workspace, host, seed)
            .await
            .is_empty(),
        "a pending_approval control must never appear in a host's queue"
    );

    let (approval, _) = sole_approval(&su, tenant.workspace).await;
    let decided = decide(&http, &base, &token, tenant.workspace, approval, Some(host)).await;
    assert_eq!(decided.status(), 200, "the room's human approves");

    // ---- the poll -----------------------------------------------------------
    let pending = poll_pending(&http, &base, tenant.workspace, host, seed).await;
    assert_eq!(
        pending.len(),
        1,
        "the approved spawn is queued: {pending:?}"
    );
    assert_eq!(pending[0]["id"], json!(control.to_string()));
    assert_eq!(pending[0]["status"], json!("dispatched"));
    assert_eq!(
        pending[0]["payload"],
        json!({"tool": TOOL, "label": "리팩터링"}),
        "the queue carries the closed payload — no path, no environment, no key"
    );
    assert!(
        poll_pending(&http, &base, tenant.workspace, neighbour, neighbour_seed)
            .await
            .is_empty(),
        "a host must only ever see controls addressed to itself"
    );

    // ---- the daemon runs it, and the session appears -----------------------
    // The signed `POST …/work-sessions` arm is still unported (named in
    // `work_sessions::reject_unsupported_create`), so the session is opened
    // through the human path — the ack contract is what this test measures.
    let session = create_session(&http, &base, &token, &tenant, host, "리팩터링").await;

    let acked = SignedRequest::new(
        reqwest::Method::POST,
        ack_path(tenant.workspace, control),
        host,
        seed,
    )
    .with_body(json!({"ok": true, "sessionId": session}))
    .send(&http, &base, tenant.workspace)
    .await;
    assert_eq!(
        acked.status(),
        200,
        "the addressed host may settle its own control"
    );

    let (status, target, bound) = control_row(&su, control).await;
    assert_eq!(status, "acked");
    assert_eq!(target, host);
    assert_eq!(
        bound,
        Some(session),
        "the ledger now knows which session this spawn produced"
    );

    let settled = broadcasts(&su, tenant.workspace, "work.control.acked").await;
    assert_eq!(settled.len(), 1, "exactly one ack envelope: {settled:?}");
    assert_eq!(settled[0]["data"]["payload"]["ok"], json!(true));

    // ---- the queue drains --------------------------------------------------
    assert!(
        poll_pending(&http, &base, tenant.workspace, host, seed)
            .await
            .is_empty(),
        "an acked control must leave the queue, or the daemon restarts the tool \
         on every poll"
    );
}

// ---------------------------------------------------------------------------
// 2 — red proof 1: an unsigned or foreign ack settles nothing
// ---------------------------------------------------------------------------

/// **RED PROOF 1 — 비서명 ack 거절.**
///
/// Six ways to reach the ack without the right to use it, each of which would
/// let somebody close the loop on a machine that is not theirs. The control row
/// is re-read after every one of them and must still be `dispatched` with no
/// session bound, because a settled control is what unlocks `input`/`kill` on
/// that session for the requesting agent
/// (`session_control_lineage_status_in_tx`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srvchain_2_an_unsigned_or_foreign_ack_never_settles_a_control() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent).await;
    let (host, seed) =
        seed_signing_host(&su, tenant.workspace, tenant.human, "workspace", "팀 VPS").await;
    let (impostor, impostor_seed) =
        seed_signing_host(&su, tenant.workspace, tenant.human, "workspace", "옆 VPS").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let bearer = agent_bearer(&su, &tenant, agent).await;

    let control = request_spawn(&http, &base, &bearer, &tenant, run, host, "위험한 일").await;
    let (approval, _) = sole_approval(&su, tenant.workspace).await;
    assert_eq!(
        decide(&http, &base, &token, tenant.workspace, approval, Some(host))
            .await
            .status(),
        200
    );
    let session = create_session(&http, &base, &token, &tenant, host, "위험한 일").await;
    let unchanged = control_row(&su, control).await;

    // (a) no credential at all.
    let bare = http
        .post(format!("{base}{}", ack_path(tenant.workspace, control)))
        .json(&json!({"ok": true, "sessionId": session}))
        .send()
        .await
        .expect("unauthenticated ack");
    assert_eq!(bare.status(), 401, "an anonymous ack is refused");

    // (b) the `MomoHost` scheme with no signature headers — the shape of a
    // caller that read the docs and skipped the crypto.
    let bluffing = http
        .post(format!("{base}{}", ack_path(tenant.workspace, control)))
        .header("Authorization", format!("MomoHost {host}"))
        .json(&json!({"ok": true, "sessionId": session}))
        .send()
        .await
        .expect("unsigned MomoHost ack");
    assert_eq!(bluffing.status(), 401, "claiming a host id proves nothing");
    assert_eq!(
        error_message(bluffing).await,
        "invalid work host request signature"
    );

    // (c) a real signature made with the WRONG key while claiming this host.
    let forged = SignedRequest {
        seed: impostor_seed,
        ..SignedRequest::new(
            reqwest::Method::POST,
            ack_path(tenant.workspace, control),
            host,
            seed,
        )
    }
    .with_body(json!({"ok": true, "sessionId": session}))
    .send(&http, &base, tenant.workspace)
    .await;
    assert_eq!(forged.status(), 401, "the stored key is the only key");

    // (d) a perfectly valid signature — from a host this control was never sent
    // to. This is the one the *authenticator alone* cannot catch: the ack path
    // names a control, not a host, so the pin lives in the handler.
    let neighbour = SignedRequest::new(
        reqwest::Method::POST,
        ack_path(tenant.workspace, control),
        impostor,
        impostor_seed,
    )
    .with_body(json!({"ok": true, "sessionId": session}))
    .send(&http, &base, tenant.workspace)
    .await;
    assert_eq!(neighbour.status(), 403, "a host may only answer for itself");
    assert_eq!(
        error_message(neighbour).await,
        "work host cannot acknowledge another host control"
    );

    // (e) the requesting agent's own bearer — the credential that asked for the
    // spawn must not also be able to report that it ran.
    let by_agent = http
        .post(format!("{base}{}", ack_path(tenant.workspace, control)))
        .bearer_auth(&bearer)
        .json(&json!({"ok": true, "sessionId": session}))
        .send()
        .await
        .expect("agent ack");
    assert!(
        by_agent.status() == 403 || by_agent.status() == 401,
        "an agent bearer must never settle a control, got {}",
        by_agent.status()
    );

    // (f) replay: one request id, used twice. The first is legitimate, so this
    // half also proves the ack works before proving the replay does not.
    let replayed = SignedRequest::new(
        reqwest::Method::POST,
        ack_path(tenant.workspace, control),
        host,
        seed,
    )
    .with_body(json!({"ok": true, "sessionId": session}));
    assert_eq!(
        control_row(&su, control).await,
        unchanged,
        "five refusals and the ledger has not moved"
    );
    assert_eq!(
        replayed.send(&http, &base, tenant.workspace).await.status(),
        200,
        "the addressed host, correctly signed, settles it"
    );
    let second = replayed.send(&http, &base, tenant.workspace).await;
    assert_eq!(
        second.status(),
        401,
        "a request id is consumed exactly once (migration 048)"
    );
}

// ---------------------------------------------------------------------------
// 3 — red proofs 2 + 3: the resume target
// ---------------------------------------------------------------------------

/// **RED PROOFS 2 & 3 — target=source 거절 · 자격 없는 호스트 거절 (#1139).**
///
/// Before this change `resume` asked nothing about `targetHostId` at all: it
/// went from channel membership straight to slot admission, which judges
/// capacity and not permission. So every refusal below is a curl away from
/// succeeding on the previous build, and the last assertion — a legitimate
/// target still works — is what keeps this from being a test that passes by
/// refusing everything.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srvchain_3_resume_refuses_a_target_the_server_would_not_offer() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (colleague, _) = seed_human(&su, tenant.workspace, "member", "동료").await;
    join_channel(&su, &tenant, colleague).await;

    let source = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "workd",
        "죽은 상자",
        Some(5),
    )
    .await;
    let mine = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;
    let theirs = seed_host(
        &su,
        tenant.workspace,
        colleague,
        "member",
        "app",
        "동료 맥",
        Some(5),
    )
    .await;
    let revoked = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "workd",
        "폐기한 상자",
        Some(5),
    )
    .await;
    sqlx::query("UPDATE work_host SET revoked_at = clock_timestamp() WHERE id = $1")
        .bind(revoked)
        .execute(&su)
        .await
        .expect("revoke a host");

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    let session = create_session(&http, &base, &token, &tenant, source, "이어받을 일").await;
    orphan_session(&su, session).await;
    let before = session_count(&su, tenant.workspace).await;

    // ---- red proof 2: the dead host is not a destination -------------------
    let same = resume(&http, &base, &token, tenant.workspace, session, source).await;
    assert_eq!(
        same.status(),
        409,
        "resuming onto the host that just lost the session is not a handoff"
    );
    assert_eq!(
        error_message(same).await,
        "resume target must differ from the source host"
    );

    // ---- red proof 3: hosts this caller has no claim on --------------------
    let colleagues = resume(&http, &base, &token, tenant.workspace, session, theirs).await;
    assert_eq!(
        colleagues.status(),
        403,
        "a member-scoped host belongs to its owner, not to the channel"
    );
    assert_eq!(
        error_message(colleagues).await,
        "target work host belongs to another member"
    );

    let gone = resume(&http, &base, &token, tenant.workspace, session, revoked).await;
    assert_eq!(gone.status(), 409, "a revoked registration is not a target");
    assert_eq!(
        error_message(gone).await,
        "target work host is unavailable or revoked"
    );

    let missing = resume(
        &http,
        &base,
        &token,
        tenant.workspace,
        session,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(
        missing.status(),
        409,
        "an unknown host id answers exactly like a revoked one — the refusal \
         discloses nothing about which hosts exist"
    );

    // ---- the tier policy, which is a statement about the whole act ----------
    set_tier_policy(&su, tenant.workspace, "t1_only", None).await;
    let policed = resume(&http, &base, &token, tenant.workspace, session, mine).await;
    assert_eq!(policed.status(), 409);
    assert_eq!(
        error_message(policed).await,
        "tier policy does not allow resume"
    );

    // …and one that is a statement about *where*.
    set_tier_policy(
        &su,
        tenant.workspace,
        "auto",
        Some(revoked.to_string().to_lowercase()),
    )
    .await;
    let elsewhere = resume(&http, &base, &token, tenant.workspace, session, mine).await;
    assert_eq!(elsewhere.status(), 409);
    assert_eq!(
        error_message(elsewhere).await,
        "target work host is outside auto policy"
    );

    set_tier_policy(&su, tenant.workspace, "auto", Some("cloud".to_string())).await;
    let not_cloud = resume(&http, &base, &token, tenant.workspace, session, mine).await;
    assert_eq!(not_cloud.status(), 409);
    assert_eq!(
        error_message(not_cloud).await,
        "auto policy requires a cloud work host"
    );

    assert_eq!(
        session_count(&su, tenant.workspace).await,
        before,
        "not one refused resume created a successor row"
    );
    assert!(
        broadcasts(&su, tenant.workspace, "work.control.dispatched")
            .await
            .is_empty(),
        "no refused resume told a host to start anything"
    );

    // ---- and the legitimate one still works --------------------------------
    set_tier_policy(&su, tenant.workspace, "ask", None).await;
    let allowed = resume(&http, &base, &token, tenant.workspace, session, mine).await;
    assert_eq!(
        allowed.status(),
        201,
        "the caller's own online host is a valid target: {:?}",
        allowed.text().await
    );
}

// ---------------------------------------------------------------------------
// 4 — a takeover restarts the tool
// ---------------------------------------------------------------------------

/// **#1138's fourth measurement, closed.** "인수가 실행을 재개시키지 않는다" —
/// the port created a successor ledger row and told nobody to run anything, so
/// the takeover copy could only promise 「가져옵니다」.
///
/// This test follows the instruction all the way onto the new host's queue and
/// back, which is also the proof that the two halves of this batch compose: the
/// resume writes the control, and the daemon path is how a host ever sees it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srvchain_4_a_takeover_actually_restarts_the_tool_on_the_new_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let source = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "workd",
        "죽은 상자",
        Some(5),
    )
    .await;
    let (target, seed) =
        seed_signing_host(&su, tenant.workspace, tenant.human, "workspace", "새 상자").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    let session = create_session(&http, &base, &token, &tenant, source, "이어받을 일").await;
    orphan_session(&su, session).await;

    let response = resume(&http, &base, &token, tenant.workspace, session, target).await;
    assert_eq!(response.status(), 201);
    let body: Value = response.json().await.expect("resume body");
    let resumed = Uuid::parse_str(body["workSession"]["id"].as_str().expect("id")).expect("uuid");
    assert_eq!(body["workSession"]["hostId"], json!(target.to_string()));
    assert_eq!(
        body["workSession"]["resumedFromSessionId"],
        json!(session.to_string()),
        "the successor names its lineage"
    );

    // ---- the instruction ----------------------------------------------------
    let dispatched = broadcasts(&su, tenant.workspace, "work.control.dispatched").await;
    assert_eq!(
        dispatched.len(),
        1,
        "a takeover tells exactly one host to start the tool: {dispatched:?}"
    );
    assert_eq!(
        dispatched[0]["data"]["payload"]["target_host_id"],
        json!(target.to_string())
    );
    assert_eq!(
        dispatched[0]["data"]["payload"]["session_id"],
        json!(resumed.to_string()),
        "the control is bound to the successor from the first write, so the ack \
         has a session to land on"
    );

    // ---- and the new host can see it, and answer it ------------------------
    let pending = poll_pending(&http, &base, tenant.workspace, target, seed).await;
    assert_eq!(
        pending.len(),
        1,
        "the takeover reaches the queue: {pending:?}"
    );
    let control = Uuid::parse_str(pending[0]["id"].as_str().expect("id")).expect("uuid");
    assert_eq!(pending[0]["kind"], json!("spawn"));
    assert_eq!(pending[0]["payload"]["tool"], json!(TOOL));

    let acked = SignedRequest::new(
        reqwest::Method::POST,
        ack_path(tenant.workspace, control),
        target,
        seed,
    )
    .with_body(json!({"ok": true, "sessionId": resumed}))
    .send(&http, &base, tenant.workspace)
    .await;
    assert_eq!(
        acked.status(),
        200,
        "a human-requested resume's control is ackable by its host: {:?}",
        acked.text().await
    );
    let (status, _, bound) = control_row(&su, control).await;
    assert_eq!(status, "acked");
    assert_eq!(bound, Some(resumed));

    // The takeover is also the most deliberate host choice there is, so it is
    // what the next card will remember (ADR-0125 D6-A, migration 061).
    assert_eq!(
        last_used_host(&su, tenant.workspace, tenant.human).await,
        Some(target)
    );
}

// ---------------------------------------------------------------------------
// 5 — D6-A: the default remembers
// ---------------------------------------------------------------------------

/// **ADR-0125 D6-A's second clause** — 기본 = 로컬 온라인 우선 **→ 마지막 사용**
/// (#1132's fifth deviation, migration 061).
///
/// The whole rule is visible in one workspace with two hosts: the first card has
/// no memory and falls back to the tier order; the second remembers where the
/// person actually sent the work; the third proves the memory is filtered
/// through the picker, not trusted on its own — a remembered host that went
/// offline is not pre-selected, because a card must never open on a row it also
/// greys out.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srvchain_5_the_card_remembers_the_host_you_chose_last() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let laptop = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;
    let vps = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "workd",
        "팀 VPS",
        Some(5),
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let bearer = agent_bearer(&su, &tenant, agent).await;

    // ---- first card: no memory, so the tier rule answers -------------------
    let run = seed_run(&su, &tenant, agent).await;
    request_spawn(&http, &base, &bearer, &tenant, run, laptop, "첫 번째").await;
    let (approval, payload) = sole_approval(&su, tenant.workspace).await;
    assert_eq!(
        payload["execution"]["default_host_id"],
        json!(laptop.to_string()),
        "로컬 온라인 우선 is the answer for someone who has never chosen"
    );
    assert!(
        last_used_host(&su, tenant.workspace, tenant.human)
            .await
            .is_none(),
        "asking is not choosing — a pending card must not move the default"
    );

    // The person sends it to the VPS instead.
    assert_eq!(
        decide(&http, &base, &token, tenant.workspace, approval, Some(vps))
            .await
            .status(),
        200
    );
    assert_eq!(
        last_used_host(&su, tenant.workspace, tenant.human).await,
        Some(vps),
        "the choice is recorded against the session owner"
    );

    // ---- second card: it remembers ------------------------------------------
    let run = seed_run(&su, &tenant, agent).await;
    request_spawn(&http, &base, &bearer, &tenant, run, laptop, "두 번째").await;
    let cards = approvals_payloads(&su, tenant.workspace).await;
    assert_eq!(cards.len(), 2);
    assert_eq!(
        cards[1]["execution"]["default_host_id"],
        json!(vps.to_string()),
        "마지막 사용 outranks the tier order even though the agent asked for the \
         laptop again: {}",
        cards[1]["execution"]
    );
    assert_eq!(
        cards[1]["execution"]["requested_host_id"],
        json!(laptop.to_string()),
        "the model's proposal is still shown — remembering is not overriding"
    );

    // ---- third card: the memory is filtered through the picker -------------
    sqlx::query(
        "UPDATE work_host SET last_seen_at = clock_timestamp() - make_interval(secs => 3600) \
          WHERE id = $1",
    )
    .bind(vps)
    .execute(&su)
    .await
    .expect("take the remembered host offline");

    let run = seed_run(&su, &tenant, agent).await;
    request_spawn(&http, &base, &bearer, &tenant, run, laptop, "세 번째").await;
    let cards = approvals_payloads(&su, tenant.workspace).await;
    assert_eq!(cards.len(), 3);
    assert_eq!(
        cards[2]["execution"]["default_host_id"],
        json!(laptop.to_string()),
        "a remembered host that went offline falls back to the tier rule"
    );
    let offline_row = cards[2]["execution"]["host_candidates"]
        .as_array()
        .expect("candidates")
        .iter()
        .find(|row| row["host_id"] == json!(vps.to_string()))
        .expect("the remembered host is still listed")
        .clone();
    assert_eq!(offline_row["selectable"], json!(false));
    assert_eq!(
        offline_row["unavailable_reason"],
        json!("offline"),
        "and it is shown with its reason rather than dropped"
    );
}
