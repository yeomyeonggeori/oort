//! DB-backed conformance for **#2862** — the shared local session's S1 payload
//! (ADR-0190 증보 D4-b, ADR-0194 D4·D7·D8·D9; migration 114): `PATCH
//! /v1/workspaces/{ws}/work-sessions/{session}/share`, host-signed.
//!
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles (the server runs on `momo_app`, NOBYPASSRLS):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test work_session_share_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | rule | the guard whose removal turns it red |
//! |---|---|---|
//! | `s1_1_share_update_and_unshare_roundtrip` | S1 저장 · 전체 교체 · 해제 = 행 삭제 | `delete_share_in_tx` call in `share_in_tx` |
//! | `s1_2_a_commit_title_or_any_extra_field_is_refused` | 커밋 제목·알려지지 않은 필드 거부 | `deny_unknown_fields` on `ShareWorkSessionRequest` / `ShareDiffRequest` |
//! | `s1_3_limits_lists_paths_and_pr_urls_are_enforced` | 상한·닫힌 목록·경로·PR URL | `momo_t3::work_share::validated_*` |
//! | `s1_4_only_the_owners_own_signed_host_can_share` | 서명 없는 PATCH·사람·에이전트·다른 host·재전송·변조 거부 | the `PrincipalKind::WorkHost` check and `is_allowed_signed_path` entry |
//! | `s1_5_only_local_sessions_and_not_after_the_end` | origin='local_pty'만 · 종료 뒤 갱신 불가(해제는 가능) | the `origin` branch and the `ended` branch in `share_in_tx` |
//! | `s1_6_the_event_is_an_outbox_row_without_names` | 같은 tx outbox · 이름·브랜치 없음 · 상태 전환에서만 | the `emit_outbox` call and `ShareTransition` |
//! | `s1_8_the_desktop_collectors_summary_is_accepted_as_it_is` | core `ShareSummaryS1` 모양(널·초 단위·6상태)을 그대로 받는다 | `ShareWorkSessionRequest` field names, `DERIVED_STATES` |
//! | `s1_7_rls_cross_tenant_and_the_schema_has_no_forbidden_column` | RLS FORCE·교차 테넌트·DB 트리거·금지 컬럼 없음 | 114's policy / trigger / column list |
//!
//! Every refusal test also takes the legitimate path beside it, so none of them
//! can pass by a route that refuses everything.

#![allow(dead_code)]

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
// S1 helpers
// ---------------------------------------------------------------------------

fn share_path(tenant: &Tenant, session: Uuid) -> String {
    format!(
        "/v1/workspaces/{}/work-sessions/{session}/share",
        tenant.workspace
    )
}

/// A full, valid S1 payload.
fn s1_payload() -> Value {
    json!({
        "shared": true,
        "repo": "momo",
        "branch": "feat/2862-share",
        "harness": "claude",
        "state": "running",
        "stages": ["원인 찾음", "수정 커밋"],
        "diff": {"added": 128, "deleted": 40, "files": 9, "ahead": 5, "behind": 0, "uncommitted": 2},
        "prUrl": "https://github.com/yeomyeonggeori/oort/pull/2851",
        "lastActivityAt": now_ms() / 1000,
    })
}

fn signed_patch(
    tenant: &Tenant,
    session: Uuid,
    host: Uuid,
    seed: &[u8; 32],
    body: &Value,
) -> SignedRequest {
    SignedRequest::new(
        reqwest::Method::PATCH,
        &share_path(tenant, session),
        tenant.workspace,
        host,
        seed,
        serde_json::to_vec(body).expect("body"),
    )
}

async fn patch_share(
    http: &reqwest::Client,
    base: &str,
    tenant: &Tenant,
    session: Uuid,
    host: Uuid,
    seed: &[u8; 32],
    body: &Value,
) -> reqwest::Response {
    signed_patch(tenant, session, host, seed, body)
        .send(http, base)
        .await
}

async fn share_rows(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_session_share WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count share rows")
}

async fn share_events(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND payload->'data'->>'type' = 'work.session.share_changed' \
          ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read share events")
}

struct Rig {
    su: PgPool,
    base: String,
    http: reqwest::Client,
    tenant: Tenant,
    desktop: Uuid,
    seed: [u8; 32],
    owner_token: String,
    session: Uuid,
}

async fn rig() -> Rig {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (desktop, seed) = own_desktop(&su, &tenant).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let session = share(&http, &base, &owner_token, &tenant, desktop).await;
    Rig {
        su,
        base,
        http,
        tenant,
        desktop,
        seed,
        owner_token,
        session,
    }
}

impl Rig {
    async fn patch(&self, body: &Value) -> reqwest::Response {
        patch_share(
            &self.http,
            &self.base,
            &self.tenant,
            self.session,
            self.desktop,
            &self.seed,
            body,
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// 1 — roundtrip: share, replace, unshare deletes
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_1_share_update_and_unshare_roundtrip() {
    let rig = rig().await;
    assert_eq!(
        share_rows(&rig.su, rig.tenant.workspace).await,
        0,
        "off by default"
    );

    let response = rig.patch(&s1_payload()).await;
    assert_eq!(response.status(), 200, "the owner's desktop shares");
    let body: Value = response.json().await.expect("body");
    assert_eq!(
        body,
        json!({"sessionId": rig.session.to_string(), "shared": true})
    );

    let row = sqlx::query(
        "SELECT repo_label, branch, harness, derived_state, stage_markers, diff_added, \
                diff_deleted, diff_files, commits_ahead, commits_behind, uncommitted, pr_url, \
                last_activity_at IS NOT NULL AS has_activity \
           FROM work_session_share WHERE session_id = $1",
    )
    .bind(rig.session)
    .fetch_one(&rig.su)
    .await
    .expect("the payload is stored");
    use sqlx::Row;
    assert_eq!(row.get::<String, _>("repo_label"), "momo");
    assert_eq!(
        row.get::<Option<String>, _>("branch").as_deref(),
        Some("feat/2862-share")
    );
    assert_eq!(row.get::<String, _>("harness"), "claude");
    assert_eq!(row.get::<String, _>("derived_state"), "running");
    assert_eq!(
        row.get::<Value, _>("stage_markers"),
        json!(["원인 찾음", "수정 커밋"])
    );
    assert_eq!(row.get::<Option<i32>, _>("diff_added"), Some(128));
    assert_eq!(row.get::<Option<i32>, _>("diff_files"), Some(9));
    assert_eq!(row.get::<Option<i32>, _>("commits_ahead"), Some(5));
    assert_eq!(
        row.get::<Option<String>, _>("pr_url").as_deref(),
        Some("https://github.com/yeomyeonggeori/oort/pull/2851")
    );
    assert!(row.get::<bool, _>("has_activity"));

    // A second PATCH is a full replacement: what it omits is cleared.
    let replaced = rig
        .patch(&json!({"shared": true, "repo": "momo", "harness": "codex", "state": "idle"}))
        .await;
    assert_eq!(replaced.status(), 200);
    let row = sqlx::query(
        "SELECT harness, branch, stage_markers, pr_url, diff_added FROM work_session_share \
          WHERE session_id = $1",
    )
    .bind(rig.session)
    .fetch_one(&rig.su)
    .await
    .expect("row");
    assert_eq!(row.get::<String, _>("harness"), "codex");
    assert_eq!(row.get::<Option<String>, _>("branch"), None);
    assert_eq!(row.get::<Value, _>("stage_markers"), json!([]));
    assert_eq!(
        row.get::<Option<String>, _>("pr_url"),
        None,
        "an omitted PR URL is cleared"
    );
    assert_eq!(row.get::<Option<i32>, _>("diff_added"), None);
    assert_eq!(
        share_rows(&rig.su, rig.tenant.workspace).await,
        1,
        "still one row per session"
    );

    // Unshare deletes the payload — the row is gone, not flagged.
    let off = rig.patch(&json!({"shared": false})).await;
    assert_eq!(off.status(), 200);
    let off: Value = off.json().await.expect("body");
    assert_eq!(off["shared"], json!(false));
    assert_eq!(
        share_rows(&rig.su, rig.tenant.workspace).await,
        0,
        "unshare deletes the S1 extension"
    );
    // The ledger row and its card stay (ADR-0190 D4-b: 원장 규칙대로 남는다).
    let session_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM work_session WHERE id = $1")
        .bind(rig.session)
        .fetch_one(&rig.su)
        .await
        .expect("count");
    assert_eq!(session_rows, 1);
    // Unsharing what is not shared is a quiet no-op, and sharing again works.
    assert_eq!(rig.patch(&json!({"shared": false})).await.status(), 200);
    assert_eq!(rig.patch(&s1_payload()).await.status(), 200);
    assert_eq!(share_rows(&rig.su, rig.tenant.workspace).await, 1);
}

// ---------------------------------------------------------------------------
// 2 — RED PROOF: no commit title, no extra field
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_2_a_commit_title_or_any_extra_field_is_refused() {
    let rig = rig().await;
    for field in [
        "commitTitle",
        "commitTitles",
        "commits",
        "lastCommitTitle",
        "files",
        "fileNames",
        "cwd",
        "path",
        "remoteUrl",
        "output",
        "scrollback",
        "command",
        "env",
    ] {
        let mut body = s1_payload();
        body[field] = json!("fix: rotate prod-db-password for acme-corp");
        let (status, _, message) = error_of(rig.patch(&body).await).await;
        assert_eq!(
            status, 400,
            "{field} is not part of the S1 payload: {message}"
        );
    }
    // Nested: the diff object has numbers only.
    for field in ["fileNames", "titles", "paths"] {
        let mut body = s1_payload();
        body["diff"][field] = json!(["secret/customer-x.rs"]);
        let (status, _, _) = error_of(rig.patch(&body).await).await;
        assert_eq!(status, 400, "diff.{field}");
    }
    // snake_case spellings of real fields are not an escape hatch either.
    let mut body = s1_payload();
    body["pr_url"] = json!("https://github.com/a/b/pull/1");
    assert_eq!(error_of(rig.patch(&body).await).await.0, 400);
    assert_eq!(
        share_rows(&rig.su, rig.tenant.workspace).await,
        0,
        "a refused request wrote nothing"
    );
    // The legitimate payload beside them is accepted.
    assert_eq!(rig.patch(&s1_payload()).await.status(), 200);
    assert_eq!(share_rows(&rig.su, rig.tenant.workspace).await, 1);
}

// ---------------------------------------------------------------------------
// 3 — limits, closed lists, paths, PR URL
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_3_limits_lists_paths_and_pr_urls_are_enforced() {
    let rig = rig().await;
    let with = |key: &str, value: Value| {
        let mut body = s1_payload();
        body[key] = value;
        body
    };
    let bad: Vec<(&str, Value)> = vec![
        ("repo", json!("/Users/me/momo")),
        ("repo", json!("a\\b")),
        ("repo", json!("x".repeat(101))),
        ("repo", json!("")),
        ("repo", json!("esc\u{1b}[31m")),
        ("branch", json!("/etc/passwd")),
        ("branch", json!("~/work")),
        ("branch", json!("C:\\work")),
        ("branch", json!("x".repeat(201))),
        (
            "branch",
            json!("fix: rotate the prod database password for acme"),
        ),
        ("branch", json!("feat\u{2028}x")),
        ("repo", json!("oort\u{2028}[승인됨]")),
        ("repo", json!("oort\u{2060}x")),
        ("stages", json!(["/Users/me/secret-proj/src/auth.rs"])),
        ("harness", json!("cursor")),
        ("harness", json!("")),
        ("state", json!("나를 기다림")),
        ("state", json!("RUNNING")),
        ("state", json!("quiet")),
        ("state", json!("ended")),
        ("state", json!("review_pending")),
        ("stages", json!(vec!["a"; 13])),
        ("stages", json!(["x".repeat(81)])),
        ("stages", json!(["bell\u{7}"])),
        ("stages", json!([1, 2])),
        ("lastActivityAt", json!(0)),
        ("lastActivityAt", json!(now_ms() / 1000 + 3_600)),
        ("lastActivityAt", json!(now_ms())),
        ("prUrl", json!("http://github.com/a/b/pull/1")),
        ("prUrl", json!("https://evil.example/a/b/pull/1")),
        ("prUrl", json!("https://github.com.evil.example/a/b/pull/1")),
        ("prUrl", json!("https://user@github.com/a/b/pull/1")),
        ("prUrl", json!("https://github.com:8443/a/b/pull/1")),
        ("prUrl", json!("https://127.0.0.1/a/b/pull/1")),
        ("prUrl", json!("https://169.254.169.254/latest/meta-data")),
        ("prUrl", json!("https://github.com/a/b/issues/1")),
        ("prUrl", json!("https://github.com/a/b/pull/1/files")),
        ("prUrl", json!("javascript:alert(1)")),
        ("prUrl", json!("https://github.com/a/b/pull/1\nHost: evil")),
    ];
    for (key, value) in bad {
        let shown = value.to_string();
        let (status, _, message) = error_of(rig.patch(&with(key, value)).await).await;
        assert_eq!(
            status, 400,
            "{key} = {shown:.60} must be refused: {message}"
        );
    }
    for (path, value) in [
        ("added", json!(-1)),
        ("added", json!(2_147_483_648_i64)),
        ("files", json!(1.5)),
        ("ahead", json!("many")),
    ] {
        let mut body = s1_payload();
        body["diff"][path] = value;
        assert_eq!(error_of(rig.patch(&body).await).await.0, 400, "diff.{path}");
    }
    // Required fields, and unshare that carries a payload.
    for missing in ["harness", "state"] {
        let mut body = s1_payload();
        body.as_object_mut().unwrap().remove(missing);
        assert_eq!(
            error_of(rig.patch(&body).await).await.0,
            400,
            "{missing} required"
        );
    }
    assert_eq!(
        error_of(rig.patch(&json!({"shared": false, "repo": "momo"})).await)
            .await
            .0,
        400
    );
    assert_eq!(share_rows(&rig.su, rig.tenant.workspace).await, 0);

    // Oversize body: refused before it is parsed, as a 413.
    let mut huge = s1_payload();
    huge["stages"] = json!(vec!["x".repeat(80); 12]);
    huge["pad"] = json!("y".repeat(9_000));
    let (status, _, _) = error_of(rig.patch(&huge).await).await;
    assert_eq!(status, 413);
    assert_eq!(share_rows(&rig.su, rig.tenant.workspace).await, 0);

    // The boundary values are accepted; a query/fragment on the PR URL is dropped.
    let mut edge = s1_payload();
    edge["repo"] = json!("r".repeat(100));
    edge["branch"] = json!("b".repeat(200));
    edge["stages"] = json!(vec!["x".repeat(80); 12]);
    edge["prUrl"] = json!("https://GitHub.com/acme/oort/pull/7?tab=files#diff");
    edge["diff"] = json!({"added": 2_147_483_647_i64, "files": 1_000_000});
    assert_eq!(rig.patch(&edge).await.status(), 200);
    let stored: Option<String> =
        sqlx::query_scalar("SELECT pr_url FROM work_session_share WHERE session_id = $1")
            .bind(rig.session)
            .fetch_one(&rig.su)
            .await
            .expect("row");
    assert_eq!(
        stored.as_deref(),
        Some("https://github.com/acme/oort/pull/7")
    );
}

// ---------------------------------------------------------------------------
// 4 — RED PROOF: signature and identity
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_4_only_the_owners_own_signed_host_can_share() {
    let rig = rig().await;
    let url = format!("{}{}", rig.base, share_path(&rig.tenant, rig.session));
    let body = s1_payload();

    // Unsigned: no credential at all.
    let response = rig.http.patch(&url).json(&body).send().await.expect("send");
    assert_eq!(response.status(), 401, "an unsigned PATCH is refused");
    // A human bearer — even the owner's — may not share (host-signed only).
    let response = rig
        .http
        .patch(&url)
        .bearer_auth(&rig.owner_token)
        .json(&body)
        .send()
        .await
        .expect("send");
    let (status, _, message) = error_of(response).await;
    assert_eq!(status, 403, "a human bearer cannot share");
    assert!(
        message.contains("requires work host signature"),
        "refused for lacking a host signature, not by a later pin: {message}"
    );
    assert_eq!(share_rows(&rig.su, rig.tenant.workspace).await, 0);
    // An agent bearer with every scope it can hold.
    let agent = agent_bearer(&rig.su, &rig.tenant).await;
    let response = rig
        .http
        .patch(&url)
        .bearer_auth(&agent)
        .json(&body)
        .send()
        .await
        .expect("send");
    assert!(
        matches!(response.status().as_u16(), 401 | 403),
        "an agent bearer cannot share: {}",
        response.status()
    );
    // A forged signature (wrong key) and a signature over a different body.
    let (_, wrong_seed) = (0, {
        let mut seed = [9u8; 32];
        seed[0] = 1;
        seed
    });
    assert_eq!(
        patch_share(
            &rig.http,
            &rig.base,
            &rig.tenant,
            rig.session,
            rig.desktop,
            &wrong_seed,
            &body
        )
        .await
        .status(),
        401,
        "a signature by another key"
    );
    let signed = signed_patch(&rig.tenant, rig.session, rig.desktop, &rig.seed, &body);
    let mut tampered = signed_patch(&rig.tenant, rig.session, rig.desktop, &rig.seed, &body);
    let mut altered = body.clone();
    altered["repo"] = json!("someone-else");
    tampered.body = serde_json::to_vec(&altered).expect("body");
    assert_eq!(
        tampered.send(&rig.http, &rig.base).await.status(),
        401,
        "the signature covers the body's digest"
    );
    // A signed request may not carry a query string (nothing unsigned rides along).
    let mut with_query = signed_patch(&rig.tenant, rig.session, rig.desktop, &rig.seed, &body);
    with_query.wire_path = format!("{}?x=1", with_query.wire_path);
    assert_eq!(with_query.send(&rig.http, &rig.base).await.status(), 401);
    assert_eq!(
        share_rows(&rig.su, rig.tenant.workspace).await,
        0,
        "nothing above wrote a row"
    );

    // The legitimate signed request is accepted — and replaying the same bytes is not.
    assert_eq!(signed.send(&rig.http, &rig.base).await.status(), 200);
    assert_eq!(
        signed.send(&rig.http, &rig.base).await.status(),
        401,
        "a replayed request id is refused"
    );

    // Another desktop of the SAME owner is a registered host, but not this session's host.
    let (other_desktop, other_seed) = own_desktop(&rig.su, &rig.tenant).await;
    let (status, _, message) = error_of(
        patch_share(
            &rig.http,
            &rig.base,
            &rig.tenant,
            rig.session,
            other_desktop,
            &other_seed,
            &body,
        )
        .await,
    )
    .await;
    assert_eq!(
        status, 403,
        "a host cannot share another host's session: {message}"
    );

    // A teammate's desktop (another member, same workspace).
    let (teammate, _) = seed_human(&rig.su, rig.tenant.workspace, "member", "팀원").await;
    let (mate_desktop, mate_seed) =
        seed_host(&rig.su, &rig.tenant, teammate, "member", "app", "팀원의 맥").await;
    let (status, _, _) = error_of(
        patch_share(
            &rig.http,
            &rig.base,
            &rig.tenant,
            rig.session,
            mate_desktop,
            &mate_seed,
            &body,
        )
        .await,
    )
    .await;
    assert_eq!(
        status, 403,
        "a teammate's host cannot share the owner's session"
    );

    // The session's own host, but its registered owner is no longer the session's
    // member (the host row was re-owned): the host pin passes, the owner pin must
    // not — this is the guard `existing.member_id != owner_member_id` alone.
    let (re_owned, re_owned_seed) = own_desktop(&rig.su, &rig.tenant).await;
    let owner_session = share(
        &rig.http,
        &rig.base,
        &rig.owner_token,
        &rig.tenant,
        re_owned,
    )
    .await;
    sqlx::query("UPDATE work_host SET owner_member_id = $2 WHERE id = $1")
        .bind(re_owned)
        .bind(teammate)
        .execute(&rig.su)
        .await
        .expect("re-own host");
    let (status, _, message) = error_of(
        patch_share(
            &rig.http,
            &rig.base,
            &rig.tenant,
            owner_session,
            re_owned,
            &re_owned_seed,
            &body,
        )
        .await,
    )
    .await;
    assert_eq!(
        status, 403,
        "a host cannot share a session of a member who is not its owner: {message}"
    );
    assert!(
        message.contains("another member"),
        "refused by the owner pin: {message}"
    );

    // A session that does not exist.
    let (status, _, _) = error_of(
        patch_share(
            &rig.http,
            &rig.base,
            &rig.tenant,
            Uuid::new_v4(),
            rig.desktop,
            &rig.seed,
            &body,
        )
        .await,
    )
    .await;
    assert_eq!(status, 404);
}

// ---------------------------------------------------------------------------
// 5 — origin and lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_5_only_local_sessions_and_not_after_the_end() {
    let rig = rig().await;
    // A host-origin session on the same desktop: not a shared pane.
    let host_session = open_host_session(
        &rig.http,
        &rig.base,
        &rig.owner_token,
        &rig.tenant,
        rig.desktop,
    )
    .await;
    let (status, code, message) = error_of(
        patch_share(
            &rig.http,
            &rig.base,
            &rig.tenant,
            host_session,
            rig.desktop,
            &rig.seed,
            &s1_payload(),
        )
        .await,
    )
    .await;
    assert_eq!(
        status, 403,
        "an A-lane session takes no S1 payload: {message}"
    );
    assert_eq!(code, json!("share_local_session_only"));
    assert_eq!(share_rows(&rig.su, rig.tenant.workspace).await, 0);

    // Beside it: the local one is shareable.
    assert_eq!(rig.patch(&s1_payload()).await.status(), 200);

    // The owner ends the shared pane; the payload can no longer be started or
    // updated, but it can still be unshared.
    let ended = rig
        .http
        .patch(format!(
            "{}/v1/workspaces/{}/work-sessions/{}",
            rig.base, rig.tenant.workspace, rig.session
        ))
        .bearer_auth(&rig.owner_token)
        .json(&json!({"status": "ended"}))
        .send()
        .await
        .expect("end");
    assert_eq!(ended.status(), 200, "the owner ends their own shared pane");
    let (status, code, _) = error_of(rig.patch(&s1_payload()).await).await;
    assert_eq!(status, 409);
    assert_eq!(code, json!("share_session_ended"));
    assert_eq!(rig.patch(&json!({"shared": false})).await.status(), 200);
    assert_eq!(share_rows(&rig.su, rig.tenant.workspace).await, 0);
}

// ---------------------------------------------------------------------------
// 6 — realtime: outbox, same tx, no names, transitions only
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_6_the_event_is_an_outbox_row_without_names() {
    let rig = rig().await;
    let ws = rig.tenant.workspace;
    let base_events = share_events(&rig.su, ws).await.len();
    assert_eq!(base_events, 0);

    // off -> on: one event.
    assert_eq!(rig.patch(&s1_payload()).await.status(), 200);
    let events = share_events(&rig.su, ws).await;
    assert_eq!(events.len(), 1, "enabling commits one outbox row");
    let event = &events[0];
    assert_eq!(event["data"]["payload"]["kind"], json!("enabled"));
    assert_eq!(
        event["data"]["payload"]["session_id"],
        json!(rig.session.to_string())
    );
    assert_eq!(
        event["data"]["payload"]["channel_id"],
        json!(rig.tenant.channel.to_string())
    );
    let text = event.to_string();
    for forbidden in [
        "momo",
        "feat/2862-share",
        "yeomyeonggeori",
        "원인 찾음",
        "128",
        "claude",
    ] {
        assert!(
            !text.contains(forbidden),
            "the event must not carry {forbidden}: {text}"
        );
    }
    let keys: Vec<&String> = event["data"]["payload"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(
        keys.len(),
        3,
        "session_id, channel_id, kind and nothing else: {keys:?}"
    );
    assert!(
        event["channel"]
            .as_str()
            .unwrap()
            .eq_ignore_ascii_case(&format!(
                "ch:ws{}.{}",
                rig.tenant.workspace, rig.tenant.channel
            )),
        "it goes to the home channel's topic"
    );
    // It is in the outbox table (relay -> Centrifugo), not published directly.
    let kind: String = sqlx::query_scalar(
        "SELECT kind::text FROM outbox WHERE workspace_id = $1 \
           AND payload->'data'->>'type' = 'work.session.share_changed'",
    )
    .bind(ws)
    .fetch_one(&rig.su)
    .await
    .expect("outbox kind");
    assert_eq!(kind, "broadcast");

    // Same state, new numbers/markers/activity: nothing to announce.
    let mut quiet = s1_payload();
    quiet["diff"]["added"] = json!(500);
    quiet["stages"] = json!(["다른 단계"]);
    assert_eq!(rig.patch(&quiet).await.status(), 200);
    assert_eq!(
        share_events(&rig.su, ws).await.len(),
        1,
        "a diff-only update emits nothing"
    );

    // Derived state changes: one more.
    let mut flipped = s1_payload();
    flipped["state"] = json!("waiting");
    assert_eq!(rig.patch(&flipped).await.status(), 200);
    let events = share_events(&rig.su, ws).await;
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["data"]["payload"]["kind"], json!("state_changed"));

    // on -> off: one more; off -> off: none.
    assert_eq!(rig.patch(&json!({"shared": false})).await.status(), 200);
    assert_eq!(share_events(&rig.su, ws).await.len(), 3);
    assert_eq!(
        share_events(&rig.su, ws).await[2]["data"]["payload"]["kind"],
        json!("disabled")
    );
    assert_eq!(rig.patch(&json!({"shared": false})).await.status(), 200);
    assert_eq!(
        share_events(&rig.su, ws).await.len(),
        3,
        "unsharing the unshared emits nothing"
    );

    // A refused request leaves no outbox row (rejections precede the first write).
    let mut bad = s1_payload();
    bad["commitTitle"] = json!("x");
    assert_eq!(error_of(rig.patch(&bad).await).await.0, 400);
    assert_eq!(share_events(&rig.su, ws).await.len(), 3);
    // Distinct idempotency keys: two transitions are two rows.
    let keys: std::collections::HashSet<String> = share_events(&rig.su, ws)
        .await
        .iter()
        .map(|event| event["idempotency_key"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(keys.len(), 3);
}

// ---------------------------------------------------------------------------
// 7a — the desktop collector's own shape (`momo-core` ShareSummaryS1, #2861)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_8_the_desktop_collectors_summary_is_accepted_as_it_is() {
    let rig = rig().await;
    // A shell pane outside a git repository: the collector sends `null` for
    // everything it does not know, and always sends every key.
    let unknown = json!({
        "shared": true, "repo": null, "branch": null, "harness": "shell", "state": "idle",
        "stages": [],
        "diff": {"added": null, "deleted": null, "files": null, "ahead": null, "behind": null, "uncommitted": null},
        "prUrl": null, "lastActivityAt": null,
    });
    assert_eq!(
        rig.patch(&unknown).await.status(),
        200,
        "all-unknown is a valid summary"
    );
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT repo_label, branch, diff_added, commits_ahead, pr_url, last_activity_at \
           FROM work_session_share WHERE session_id = $1",
    )
    .bind(rig.session)
    .fetch_one(&rig.su)
    .await
    .expect("row");
    assert_eq!(row.get::<Option<String>, _>("repo_label"), None);
    assert_eq!(row.get::<Option<String>, _>("branch"), None);
    assert_eq!(row.get::<Option<i32>, _>("diff_added"), None);
    assert_eq!(row.get::<Option<i32>, _>("commits_ahead"), None);
    assert_eq!(row.get::<Option<String>, _>("pr_url"), None);
    // Every state of momo-core's `SessionStatus` is accepted; ADR 표의 「조용함」 is not.
    for state in ["waiting", "running", "review", "idle", "done", "stopped"] {
        let mut body = s1_payload();
        body["state"] = json!(state);
        assert_eq!(rig.patch(&body).await.status(), 200, "{state}");
    }
    let mut quiet = s1_payload();
    quiet["state"] = json!("quiet");
    assert_eq!(error_of(rig.patch(&quiet).await).await.0, 400);
    // lastActivityAt is seconds, stored as given.
    let mut body = s1_payload();
    body["lastActivityAt"] = json!(1_790_000_123_i64);
    assert_eq!(rig.patch(&body).await.status(), 200);
    let secs: i64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM last_activity_at)::bigint FROM work_session_share WHERE session_id = $1",
    )
    .bind(rig.session)
    .fetch_one(&rig.su)
    .await
    .expect("secs");
    assert_eq!(secs, 1_790_000_123);
}

// ---------------------------------------------------------------------------
// 7 — RLS, cross tenant, DB-level guards, no forbidden column
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn s1_7_rls_cross_tenant_and_the_schema_has_no_forbidden_column() {
    let rig = rig().await;
    assert_eq!(rig.patch(&s1_payload()).await.status(), 200);

    // A second tenant with its own shared session.
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let other = seed_tenant(&rig.su, &app_pool).await;
    let (other_desktop, other_seed) = own_desktop(&rig.su, &other).await;
    let other_token = login(&rig.http, &rig.base, other.workspace, &other.owner_email).await;
    let other_session = share(&rig.http, &rig.base, &other_token, &other, other_desktop).await;
    assert_eq!(
        patch_share(
            &rig.http,
            &rig.base,
            &other,
            other_session,
            other_desktop,
            &other_seed,
            &s1_payload()
        )
        .await
        .status(),
        200
    );

    // Tenant B's host signs for tenant A's session, naming A's workspace: the host
    // does not exist in A -> 401. Naming B's workspace with A's session -> 404.
    let cross = SignedRequest::new(
        reqwest::Method::PATCH,
        &share_path(&rig.tenant, rig.session),
        rig.tenant.workspace,
        other_desktop,
        &other_seed,
        serde_json::to_vec(&s1_payload()).unwrap(),
    );
    assert_eq!(cross.send(&rig.http, &rig.base).await.status(), 401);
    let (status, _, _) = error_of(
        patch_share(
            &rig.http,
            &rig.base,
            &other,
            rig.session,
            other_desktop,
            &other_seed,
            &s1_payload(),
        )
        .await,
    )
    .await;
    assert_eq!(status, 404, "A's session does not exist in B's workspace");

    // The runtime role, RLS FORCE: no GUC -> no rows; B's GUC -> only B's row.
    let mut bare = app_pool.begin().await.expect("tx");
    let none = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM work_session_share")
        .fetch_one(&mut *bare)
        .await;
    assert!(
        none.map(|count| count == 0).unwrap_or(true),
        "no tenant GUC: no rows (or a refusal)"
    );
    drop(bare);
    let mut conn = app_pool.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(other.workspace.to_string())
        .execute(&mut *conn)
        .await
        .expect("guc");
    let visible: Vec<Uuid> = sqlx::query_scalar("SELECT workspace_id FROM work_session_share")
        .fetch_all(&mut *conn)
        .await
        .expect("rows");
    assert_eq!(
        visible,
        vec![other.workspace],
        "only the GUC tenant's row is visible"
    );
    // WITH CHECK: B's GUC cannot write A's workspace id.
    let forged = sqlx::query(
        "INSERT INTO work_session_share (workspace_id, session_id, repo_label, harness, derived_state) \
         VALUES ($1, $2, 'x', 'claude', 'running')",
    )
    .bind(rig.tenant.workspace)
    .bind(Uuid::new_v4())
    .execute(&mut *conn)
    .await;
    assert!(
        forged.is_err(),
        "RLS WITH CHECK refuses a row for another tenant"
    );
    drop(conn);
    let relforce: bool = sqlx::query_scalar(
        "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'work_session_share'",
    )
    .fetch_one(&rig.su)
    .await
    .expect("relforce");
    assert!(relforce, "RLS is enabled and FORCEd");

    // DB-level guards, whoever the writer is (superuser here).
    let host_session = open_host_session(
        &rig.http,
        &rig.base,
        &rig.owner_token,
        &rig.tenant,
        rig.desktop,
    )
    .await;
    let on_host_origin = sqlx::query(
        "INSERT INTO work_session_share (workspace_id, session_id, repo_label, harness, derived_state) \
         VALUES ($1, $2, 'x', 'claude', 'running')",
    )
    .bind(rig.tenant.workspace)
    .bind(host_session)
    .execute(&rig.su)
    .await;
    assert!(
        on_host_origin.is_err(),
        "the trigger refuses a share row on a host-origin session"
    );
    for (column, value) in [
        ("branch", "'fix: rotate the key'"),
        ("branch", "E'feat\\u2028x'"),
        ("repo_label", "E'oort\\u2028x'"),
        ("stage_markers", "'[\"/etc/passwd\"]'::jsonb"),
        ("branch", "'/etc/passwd'"),
        ("branch", "'C:\\x'"),
        ("pr_url", "'http://github.com/a/b/pull/1'"),
        ("pr_url", "'https://github.com/a/b/pull/1?x=1'"),
        ("pr_url", "'https://github.com:1/a/b/pull/1'"),
        ("repo_label", "'a/b'"),
        ("stage_markers", "'[\"ok\", 5]'::jsonb"),
        (
            "stage_markers",
            "to_jsonb(array_fill('x'::text, ARRAY[13]))",
        ),
    ] {
        let sql = format!("UPDATE work_session_share SET {column} = {value} WHERE session_id = $1");
        let result = sqlx::query(&sql).bind(rig.session).execute(&rig.su).await;
        assert!(result.is_err(), "CHECK refuses {column} = {value}");
    }
    for tool in ["grok", "other"] {
        let ok = sqlx::query("UPDATE work_session SET tool = $2 WHERE id = $1")
            .bind(rig.session)
            .bind(tool)
            .execute(&rig.su)
            .await;
        assert!(ok.is_ok(), "the widened tool CHECK accepts {tool}");
    }
    assert!(
        sqlx::query("UPDATE work_session SET tool = 'rm-rf' WHERE id = $1")
            .bind(rig.session)
            .execute(&rig.su)
            .await
            .is_err(),
        "an unknown tool is still refused"
    );

    // The table has exactly the S1 columns. A commit-title or file-name column
    // would have to be added here, in a reviewed diff.
    let mut columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name::text FROM information_schema.columns \
          WHERE table_name = 'work_session_share' AND table_schema = 'public'",
    )
    .fetch_all(&rig.su)
    .await
    .expect("columns");
    columns.sort();
    let mut expected: Vec<String> = [
        "workspace_id",
        "session_id",
        "repo_label",
        "branch",
        "harness",
        "derived_state",
        "stage_markers",
        "diff_added",
        "diff_deleted",
        "diff_files",
        "commits_ahead",
        "commits_behind",
        "uncommitted",
        "pr_url",
        "last_activity_at",
        "shared_at",
        "updated_at",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    expected.sort();
    assert_eq!(
        columns, expected,
        "work_session_share carries S1 and nothing else"
    );

    // Deleting the session (or its channel) cascades the payload away.
    sqlx::query("DELETE FROM work_session WHERE id = $1")
        .bind(rig.session)
        .execute(&rig.su)
        .await
        .expect("delete session");
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM work_session_share WHERE session_id = $1")
            .bind(rig.session)
            .fetch_one(&rig.su)
            .await
            .expect("count");
    assert_eq!(
        left, 0,
        "ON DELETE CASCADE removes the payload with the session"
    );
}
