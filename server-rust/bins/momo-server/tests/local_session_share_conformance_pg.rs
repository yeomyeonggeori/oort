//! DB-backed conformance for **#2793** — ADR-0190 D4 (Accepted): a local terminal
//! pane can be shared as a work session of its own kind (`origin = 'local_pty'`:
//! a name, a folder display name and a status, nothing else), and the server
//! refuses **every** work control aimed at it. The refusal is made on the server,
//! fail-closed — a host that receives a control and ignores it is not the design.
//!
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles (see `remote_host_r0_conformance_pg.rs` for the harness contract;
//! the server runs on `momo_app`, NOBYPASSRLS):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test local_session_share_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | rule | the guard whose removal turns it red |
//! |---|---|---|
//! | `d4_1_a_shared_local_session_refuses_every_agent_control` (**red proof**) | 공유 L 세션에 input·read·kill 컨트롤 생성 → 거부 | the `session_is_local_pty_in_tx` branch in `work_controls::create_in_tx` |
//! | `d4_2_the_owners_own_routes_refuse_a_shared_local_session` | 사람 경로(지시·권한 결정·재개)도 같은 거부 | the `origin == "local_pty"` branches in `work_instructions`, `work_permissions`, `work_sessions::resume_in_tx` |
//! | `d4_3_the_database_refuses_a_control_whatever_the_caller` | 배치·워커·미래의 라우트도 막는다 | the `work_control_refuse_local_session` trigger (112) |
//! | `d4_4_sharing_is_off_until_the_persons_own_desktop_is_registered` | 공유는 기본 꺼짐 · host 등록 뒤에만 | `work_sessions::create_local_in_tx` host check |
//! | `d4_5_nothing_but_names_reaches_the_row` | 경로·raw 바이트·바인딩 비저장 | 112's CHECKs, `validated_local_text`, the `origin = 'host'` writers |
//! | `d4_6_a_host_cannot_relay_into_a_shared_local_session` | ACP 중계(권한 요청)·PTY 바인딩 거부 | the `local_pty` branches in `record_acp_event_in_tx` and `bind_remote_pty_in_tx` |
//!
//! Every refusal test also takes the legitimate path beside it (a host-origin
//! session answering differently, the owner ending their own shared pane), so
//! none of them can pass by a route that refuses everything.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "d4-local-session-conformance-secret";
const TEST_PASSWORD: &str = "d4-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
const TOOL: &str = "codex";
const LOCAL_REFUSAL: &str = "local_session_no_control";
const NEEDS_HOST: &str = "local_share_requires_registered_host";

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

fn app_state(pool: PgPool) -> AppState {
    AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    // The signed-instruction route is closed unless R2 is on; with it open, the
    // refusal under test is the one that has to come first.
    .with_device_keys(DeviceKeySettings {
        instance_id: Some("inst_2793_conformance".to_string()),
        human_control_signature_required: true,
        ..DeviceKeySettings::default()
    })
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// The owner's own desktop: member-scoped, the `app` tier — what #2778's
/// 「이 맥」 registration makes.
async fn own_desktop(su: &PgPool, tenant: &Tenant) -> (Uuid, [u8; 32]) {
    seed_host(su, tenant, tenant.owner, "member", "app", "성재의 맥").await
}

fn sessions_url(base: &str, tenant: &Tenant) -> String {
    format!("{base}/v1/workspaces/{}/work-sessions", tenant.workspace)
}

async fn register_local(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    extra: Value,
) -> reqwest::Response {
    let mut body = json!({
        "channelId": tenant.channel,
        "hostId": Uuid::nil(),
        "tool": "shell",
        "label": "dev server",
        "origin": "local_pty",
        "folderLabel": "momo",
    });
    for (key, value) in extra.as_object().expect("object") {
        body[key] = value.clone();
    }
    http.post(sessions_url(base, tenant))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("register local session")
}

/// A shared local pane on `host`; answers its id.
async fn share(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    host: Uuid,
) -> Uuid {
    let response = register_local(http, base, token, tenant, json!({ "hostId": host })).await;
    assert_eq!(response.status(), 201, "the owner shares their own pane");
    let body: Value = response.json().await.expect("session body");
    Uuid::parse_str(body["workSession"]["id"].as_str().expect("id")).expect("uuid")
}

/// A running host-origin session on `host` — the legitimate neighbour every
/// refusal is read against.
async fn open_host_session(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    host: Uuid,
) -> Uuid {
    let created = http
        .post(sessions_url(base, tenant))
        .bearer_auth(token)
        .json(&json!({
            "channelId": tenant.channel,
            "hostId": host,
            "tool": TOOL,
            "label": "리팩터링",
        }))
        .send()
        .await
        .expect("create work session");
    assert_eq!(created.status(), 201, "a host-origin session opens");
    let created: Value = created.json().await.expect("session body");
    Uuid::parse_str(created["workSession"]["id"].as_str().expect("id")).expect("uuid")
}

async fn control_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_control WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count controls")
}

async fn session_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_session WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count sessions")
}

async fn message_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count messages")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

fn signed_statement(nonce: Uuid) -> Value {
    json!({
        "deviceKeyId": Uuid::new_v4(),
        "nonce": nonce,
        "issuedAtMs": now_ms(),
        "expiresAtMs": now_ms() + 60_000,
        "signature": BASE64.encode([7u8; 64]),
        "mode": "queue",
    })
}

async fn post_json(
    http: &reqwest::Client,
    url: String,
    token: &str,
    body: Value,
) -> reqwest::Response {
    http.post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("post")
}

// ---------------------------------------------------------------------------
// 1 — RED PROOF: the control-creation route refuses a shared local session
// ---------------------------------------------------------------------------

/// **RED PROOF (ADR-0190 D4, #2793) — 「공유 L 세션에 input 컨트롤 생성 → 거부」.**
/// An agent bound to a live run asks to type into, read and kill the owner's
/// shared local pane. Every kind is refused 403 `local_session_no_control` before
/// a row is written. Beside it, the same three asks aimed at a host-origin session
/// of the same owner on the same desktop answer something else — so the refusal is
/// the origin's, not the route's habit.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_1_a_shared_local_session_refuses_every_agent_control() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (desktop, _) = own_desktop(&su, &tenant).await;
    let run = seed_run(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let bearer = agent_bearer(&su, &tenant).await;

    let local = share(&http, &base, &owner_token, &tenant, desktop).await;
    let host_session = open_host_session(&http, &base, &owner_token, &tenant, desktop).await;
    let before = control_count(&su, tenant.workspace).await;

    for (kind, payload) in [
        ("input", json!({"text": "rm -rf ~"})),
        ("read", json!({"tail_lines": 50})),
        ("kill", json!({})),
    ] {
        let body = |session: Uuid| {
            json!({
                "channelId": tenant.channel,
                "runId": run,
                "targetHostId": desktop,
                "sessionId": session,
                "kind": kind,
                "payload": payload,
            })
        };
        let (status, code, message) =
            error_of(agent_control(&http, &base, &bearer, &tenant, body(local)).await).await;
        assert_eq!(status, 403, "{kind} on a shared local pane: {message}");
        assert_eq!(
            code,
            json!(LOCAL_REFUSAL),
            "{kind}: the refusal names itself"
        );

        let (status, code, _) =
            error_of(agent_control(&http, &base, &bearer, &tenant, body(host_session)).await).await;
        assert_ne!(
            code,
            json!(LOCAL_REFUSAL),
            "{kind}: a host-origin session is judged by its own rules ({status})"
        );
    }
    assert_eq!(
        control_count(&su, tenant.workspace).await,
        before,
        "no refused control left a ledger row behind"
    );
}

// ---------------------------------------------------------------------------
// 2 — the person's own routes
// ---------------------------------------------------------------------------

/// The owner's signed instruction, the permission decision and a resume are all
/// controls too. Each is refused with the same code before the signature is read;
/// a host-origin session on the same routes is not refused by that code.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_2_the_owners_own_routes_refuse_a_shared_local_session() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (desktop, _) = own_desktop(&su, &tenant).await;
    let (other_desktop, _) = own_desktop(&su, &tenant).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let local = share(&http, &base, &owner_token, &tenant, desktop).await;
    let host_session = open_host_session(&http, &base, &owner_token, &tenant, desktop).await;
    let before = control_count(&su, tenant.workspace).await;
    let session_url = |session: Uuid, leaf: &str| {
        format!(
            "{base}/v1/workspaces/{}/work-sessions/{session}/{leaf}",
            tenant.workspace
        )
    };

    let nonce = Uuid::new_v4();
    let instruction = json!({
        "text": "git push --force",
        "mode": "queue",
        "clientMsgId": nonce,
        "humanSignature": signed_statement(nonce),
    });
    let decision = json!({
        "requestEventId": Uuid::new_v4(),
        "optionId": "allow-once",
        "kind": "allow_once",
    });
    let resume = json!({ "targetHostId": other_desktop });
    for (name, leaf, body) in [
        ("instruction", "instructions", &instruction),
        ("permission decision", "permission-decisions", &decision),
        ("resume", "resume", &resume),
    ] {
        let (status, code, message) =
            error_of(post_json(&http, session_url(local, leaf), &owner_token, body.clone()).await)
                .await;
        assert_eq!(status, 403, "{name} on a shared local pane: {message}");
        assert_eq!(
            code,
            json!(LOCAL_REFUSAL),
            "{name}: the refusal names itself"
        );

        let (_, code, _) = error_of(
            post_json(
                &http,
                session_url(host_session, leaf),
                &owner_token,
                body.clone(),
            )
            .await,
        )
        .await;
        assert_ne!(
            code,
            json!(LOCAL_REFUSAL),
            "{name}: a host-origin session is judged by its own rules"
        );
    }
    assert_eq!(control_count(&su, tenant.workspace).await, before);
}

// ---------------------------------------------------------------------------
// 3 — the database refuses whatever the caller
// ---------------------------------------------------------------------------

/// A caller that never passes through a route — a worker, a batch, a route not
/// written yet — still cannot put a control on a shared local pane: the trigger
/// refuses INSERT of every kind, refuses binding a spawn control to the session
/// afterwards, and `insert_work_control_in_tx` answers with the domain error the
/// routes map to the same 403.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_3_the_database_refuses_a_control_whatever_the_caller() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (desktop, _) = own_desktop(&su, &tenant).await;

    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let local = share(&http, &base, &owner_token, &tenant, desktop).await;
    let host_session = open_host_session(&http, &base, &owner_token, &tenant, desktop).await;

    let insert = |session: Option<Uuid>, kind: &'static str, payload: Value| {
        let su = su.clone();
        let (workspace, channel, owner) = (tenant.workspace, tenant.channel, tenant.owner);
        async move {
            sqlx::query(
                "INSERT INTO work_control \
                   (workspace_id, channel_id, requester_member_id, target_host_id, \
                    session_id, kind, payload, status) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved')",
            )
            .bind(workspace)
            .bind(channel)
            .bind(owner)
            .bind(desktop)
            .bind(session)
            .bind(kind)
            .bind(payload)
            .execute(&su)
            .await
        }
    };
    for (kind, payload) in [
        ("input", json!({"text": "ls"})),
        ("read", json!({})),
        ("kill", json!({})),
    ] {
        let error = insert(Some(local), kind, payload.clone())
            .await
            .expect_err("a control on a shared local pane is refused by the database");
        assert!(
            error
                .to_string()
                .contains("local_pty session accepts no work control"),
            "{kind}: {error}"
        );
        // The same row on a host-origin session is accepted: the trigger is
        // about the origin, not about the table.
        insert(Some(host_session), kind, payload)
            .await
            .unwrap_or_else(|error| panic!("{kind} on a host session: {error}"));
    }

    // A spawn is written without a session and bound after the host's ack —
    // binding it to a shared local pane is refused too.
    insert(None, "spawn", json!({"tool": TOOL, "label": "x"}))
        .await
        .expect("an unbound spawn is just a request");
    let spawn: Uuid = sqlx::query_scalar(
        "SELECT id FROM work_control WHERE workspace_id = $1 AND kind = 'spawn'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("spawn id");
    let error = sqlx::query("UPDATE work_control SET session_id = $2 WHERE id = $1")
        .bind(spawn)
        .bind(local)
        .execute(&su)
        .await
        .expect_err("binding a spawn to a shared local pane is refused");
    assert!(error
        .to_string()
        .contains("local_pty session accepts no work control"));

    // Through the production insert, as the tenant role the server runs as.
    let mut tx = app_pool.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(tenant.workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("tenant scope");
    let refused = momo_t3::work_control::insert_work_control_in_tx(
        &mut tx,
        tenant.workspace,
        momo_t3::work_control::NewWorkControl {
            channel_id: tenant.channel,
            requester_member_id: tenant.owner,
            target_host_id: desktop,
            session_id: Some(local),
            kind: "kill".into(),
            payload: json!({}),
            status: "approved".into(),
            human: None,
        },
    )
    .await;
    assert!(
        matches!(refused, Err(momo_t3::T3Error::LocalSessionControlForbidden)),
        "the production insert answers with the domain refusal: {refused:?}"
    );
}

// ---------------------------------------------------------------------------
// 4 — sharing is off until the person's own desktop is registered
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_4_sharing_is_off_until_the_persons_own_desktop_is_registered() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;

    // Off by default: nothing exists, and nothing can be made from a host that
    // is not registered.
    assert_eq!(session_count(&su, tenant.workspace).await, 0);
    let messages = message_count(&su, tenant.workspace).await;
    let refuse = |label: &'static str, response: reqwest::Response| async move {
        let (status, code, message) = error_of(response).await;
        assert_eq!(status, 403, "{label}: {message}");
        assert_eq!(code, json!(NEEDS_HOST), "{label}");
    };
    refuse(
        "an unregistered host",
        register_local(
            &http,
            &base,
            &owner_token,
            &tenant,
            json!({"hostId": Uuid::new_v4()}),
        )
        .await,
    )
    .await;

    // Somebody else's desktop.
    let (teammate, _) = seed_human(&su, tenant.workspace, "member", "동료").await;
    join_channel(&su, tenant.workspace, tenant.channel, teammate).await;
    let (their_desktop, _) = seed_host(&su, &tenant, teammate, "member", "app", "동료의 맥").await;
    refuse(
        "a colleague's desktop",
        register_local(
            &http,
            &base,
            &owner_token,
            &tenant,
            json!({"hostId": their_desktop}),
        )
        .await,
    )
    .await;

    // The owner's own machine, but not a desktop: a remote workd.
    let (workd, _) = seed_host(&su, &tenant, tenant.owner, "member", "workd", "원격").await;
    refuse(
        "a remote workd host",
        register_local(
            &http,
            &base,
            &owner_token,
            &tenant,
            json!({"hostId": workd}),
        )
        .await,
    )
    .await;

    // A revoked desktop.
    let (revoked, _) = own_desktop(&su, &tenant).await;
    sqlx::query("UPDATE work_host SET revoked_at = now() WHERE id = $1")
        .bind(revoked)
        .execute(&su)
        .await
        .expect("revoke");
    refuse(
        "a revoked desktop",
        register_local(
            &http,
            &base,
            &owner_token,
            &tenant,
            json!({"hostId": revoked}),
        )
        .await,
    )
    .await;

    // A work host never registers a pane on the person's behalf.
    let (desktop, seed) = own_desktop(&su, &tenant).await;
    let signed = SignedRequest::new(
        reqwest::Method::POST,
        &format!("/v1/workspaces/{}/work-sessions", tenant.workspace),
        tenant.workspace,
        desktop,
        &seed,
        serde_json::to_vec(&json!({
            "channelId": tenant.channel, "hostId": desktop, "tool": "shell",
            "label": "x", "origin": "local_pty", "controlId": Uuid::new_v4(),
        }))
        .expect("body"),
    );
    let (status, _, message) = error_of(signed.send(&http, &base).await).await;
    assert_eq!(
        status, 403,
        "a signed host cannot share for the person: {message}"
    );

    assert_eq!(session_count(&su, tenant.workspace).await, 0);
    assert_eq!(
        message_count(&su, tenant.workspace).await,
        messages,
        "a refused share leaves no card behind"
    );

    // The legitimate path: the registered desktop's owner shares.
    let response = register_local(
        &http,
        &base,
        &owner_token,
        &tenant,
        json!({"hostId": desktop}),
    )
    .await;
    assert_eq!(response.status(), 201);
    let body: Value = response.json().await.expect("body");
    let shared = &body["workSession"];
    assert_eq!(shared["origin"], json!("local_pty"));
    assert_eq!(shared["folderLabel"], json!("momo"));
    assert_eq!(shared["label"], json!("dev server"));
    assert_eq!(shared["status"], json!("running"));
    assert_eq!(shared["remoteAttachAvailable"], json!(false));
    assert_eq!(shared["remoteDisplayAvailable"], json!(false));
    let id = shared["id"].as_str().expect("id").to_string();

    // A host-origin session keeps saying so.
    let host_session = open_host_session(&http, &base, &owner_token, &tenant, desktop).await;
    let listed: Value = http
        .get(format!("{}?active=1", sessions_url(&base, &tenant)))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list body");
    let origin_of = |wanted: &str| {
        listed["workSessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .find(|session| session["id"] == json!(wanted))
            .map(|session| session["origin"].clone())
    };
    assert_eq!(origin_of(&id), Some(json!("local_pty")));
    assert_eq!(origin_of(&host_session.to_string()), Some(json!("host")));

    // The person ends their own shared pane: status is the part they may move.
    let ended = http
        .patch(format!("{}/{id}", sessions_url(&base, &tenant)))
        .bearer_auth(&owner_token)
        .json(&json!({"status": "ended"}))
        .send()
        .await
        .expect("end");
    assert_eq!(ended.status(), 200, "the owner ends their own shared pane");
    assert_eq!(control_count(&su, tenant.workspace).await, 0);
}

// ---------------------------------------------------------------------------
// 5 — nothing but names reaches the row
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_5_nothing_but_names_reaches_the_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (desktop, _) = own_desktop(&su, &tenant).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;

    // A path is not a name: separators and control characters are refused (400)
    // on the label and on the folder label, and so is every binding a host-origin
    // create could carry.
    for (what, extra) in [
        (
            "an absolute folder path",
            json!({"folderLabel": "/Users/성재/momo"}),
        ),
        (
            "a relative folder path",
            json!({"folderLabel": "work/momo"}),
        ),
        (
            "a windows folder path",
            json!({"folderLabel": "C:\\Users\\x"}),
        ),
        (
            "a control character",
            json!({"folderLabel": "mo\u{0007}mo"}),
        ),
        ("a path as the name", json!({"label": "~/work/momo"})),
        (
            "an overlong folder label",
            json!({"folderLabel": "x".repeat(81)}),
        ),
        (
            "a pty binding",
            json!({"ptyId": "p1", "attachEndpoint": "wss://x.example/p"}),
        ),
        (
            "a display binding",
            json!({"displayId": "d1", "displayEndpoint": "wss://x.example/d"}),
        ),
        ("a control id", json!({"controlId": Uuid::new_v4()})),
        ("an unknown origin", json!({"origin": "remote"})),
    ] {
        let mut extra = extra;
        extra["hostId"] = json!(desktop);
        let (status, _, message) =
            error_of(register_local(&http, &base, &owner_token, &tenant, extra).await).await;
        assert_eq!(status, 400, "{what}: {message}");
    }
    // A folder label has no business on a host-origin session.
    let response = http
        .post(sessions_url(&base, &tenant))
        .bearer_auth(&owner_token)
        .json(&json!({
            "channelId": tenant.channel, "hostId": desktop, "tool": TOOL,
            "label": "x", "folderLabel": "momo",
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(response.status(), 400);
    assert_eq!(session_count(&su, tenant.workspace).await, 0);

    // The database says the same without the route: the row cannot hold a path,
    // a binding, or a folder label on a host-origin session, and cannot change
    // its origin.
    let local = share(&http, &base, &owner_token, &tenant, desktop).await;
    let host_session = open_host_session(&http, &base, &owner_token, &tenant, desktop).await;
    let rejected = |sql: &'static str, id: Uuid| {
        let su = su.clone();
        async move {
            sqlx::query(sql)
                .bind(id)
                .execute(&su)
                .await
                .expect_err(sql)
                .to_string()
        }
    };
    for sql in [
        "UPDATE work_session SET folder_label = '/Users/x/momo' WHERE id = $1",
        "UPDATE work_session SET folder_label = 'a\\b' WHERE id = $1",
        "UPDATE work_session SET label = 'a/b' WHERE id = $1",
        "UPDATE work_session SET pty_id = 'p1', attach_endpoint = 'wss://x.example/p' WHERE id = $1",
        "UPDATE work_session SET display_id = 'd1', display_endpoint = 'wss://x.example/d' WHERE id = $1",
    ] {
        let message = rejected(sql, local).await;
        assert!(message.contains("work_session_"), "{sql}: {message}");
    }
    let message = rejected(
        "UPDATE work_session SET folder_label = 'momo' WHERE id = $1",
        host_session,
    )
    .await;
    assert!(
        message.contains("work_session_folder_label_ck"),
        "{message}"
    );
    let message = rejected(
        "UPDATE work_session SET origin = 'host' WHERE id = $1",
        local,
    )
    .await;
    assert!(message.contains("origin is immutable"), "{message}");

    // What the server holds for the shared pane is its names and its status.
    let row: (String, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT origin, folder_label, label, pty_id FROM work_session WHERE id = $1",
    )
    .bind(local)
    .fetch_one(&su)
    .await
    .expect("row");
    assert_eq!(
        row,
        (
            "local_pty".into(),
            Some("momo".into()),
            "dev server".into(),
            None
        )
    );

    // The binding writers refuse the origin as well, with the row as it is.
    let mut tx = app_pool.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(tenant.workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("tenant scope");
    let bound = momo_t3::write_remote_pty_binding_in_tx(
        &mut tx,
        tenant.workspace,
        local,
        &momo_t3::parse_remote_pty_binding(Some("p1"), Some("wss://x.example/p"))
            .expect("shape")
            .expect("binding"),
    )
    .await
    .expect("write");
    assert!(!bound, "no PTY binding is written onto a shared local pane");
}

// ---------------------------------------------------------------------------
// 6 — a host cannot relay into a shared local session
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_6_a_host_cannot_relay_into_a_shared_local_session() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (desktop, seed) = own_desktop(&su, &tenant).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let local = share(&http, &base, &owner_token, &tenant, desktop).await;
    let host_session = open_host_session(&http, &base, &owner_token, &tenant, desktop).await;

    let relay = |session: Uuid| {
        let path = format!(
            "/v1/workspaces/{}/work-sessions/{session}",
            tenant.workspace
        );
        let body = json!({ "event": {
            "event_id": Uuid::new_v4(),
            "type": "approval.requested",
            "v": 1,
            "ts": now_ms(),
            "payload": {
                "run_id": session, "work_session_id": session,
                "channel_id": tenant.channel,
                "action": "requested", "action_type": "tool_call", "status": "pending",
                "options": [
                    {"option_id": "allow-once", "kind": "allow_once", "name": "Allow once"},
                    {"option_id": "reject-once", "kind": "reject_once", "name": "Reject"}
                ],
            },
        }});
        SignedRequest::new(
            reqwest::Method::PATCH,
            &path,
            tenant.workspace,
            desktop,
            &seed,
            serde_json::to_vec(&body).expect("body"),
        )
    };
    let (status, code, message) = error_of(relay(local).send(&http, &base).await).await;
    assert_eq!(status, 403, "ACP relay into a shared local pane: {message}");
    assert_eq!(code, json!(LOCAL_REFUSAL));
    let requests: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_permission_request WHERE work_session_id = $1",
    )
    .bind(local)
    .fetch_one(&su)
    .await
    .expect("count requests");
    assert_eq!(requests, 0, "no decidable request exists for a shared pane");

    // The same relay into a host-origin session is the normal path.
    let accepted = relay(host_session).send(&http, &base).await;
    assert_eq!(
        accepted.status(),
        200,
        "the host relays into its own session"
    );

    // A PTY binding the host would publish for the shared pane.
    let bind_path = format!("/v1/workspaces/{}/work-sessions/{local}", tenant.workspace);
    let bind = SignedRequest::new(
        reqwest::Method::PATCH,
        &bind_path,
        tenant.workspace,
        desktop,
        &seed,
        serde_json::to_vec(&json!({
            "ptyId": "p1", "attachEndpoint": "wss://x.example/p",
        }))
        .expect("body"),
    );
    let (status, code, message) = error_of(bind.send(&http, &base).await).await;
    assert_eq!(status, 403, "PTY binding on a shared local pane: {message}");
    assert_eq!(code, json!(LOCAL_REFUSAL));

    // … and the screen binding it would publish through its own route.
    let display = SignedRequest::new(
        reqwest::Method::POST,
        &format!("{bind_path}/display-binding"),
        tenant.workspace,
        desktop,
        &seed,
        serde_json::to_vec(&json!({
            "displayId": "d1", "displayEndpoint": "wss://x.example/d",
        }))
        .expect("body"),
    );
    let (status, code, message) = error_of(display.send(&http, &base).await).await;
    assert_eq!(
        status, 403,
        "display binding on a shared local pane: {message}"
    );
    assert_eq!(code, json!(LOCAL_REFUSAL));
}
