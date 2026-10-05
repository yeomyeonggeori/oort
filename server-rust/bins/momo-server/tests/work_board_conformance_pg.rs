//! DB-backed conformance for **#3322** — the team board's reads (serves #2863):
//! `GET /v1/workspaces/{ws}/work-sessions/shared` and
//! `GET /v1/workspaces/{ws}/work-sessions/{session}/shared`.
//!
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles (the server runs on `momo_app`, NOBYPASSRLS):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:25432/momo \
//!   cargo test -p momo-server --test work_board_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | rule | the guard whose removal turns it red |
//! |---|---|---|
//! | `b1_a_member_sees_shared_and_agent_sessions_newest_first` | S1 모양 · A 세션 null · 정렬 · 비공유 제외 | the `origin` / `s.session_id IS NOT NULL` predicate in `work_board::SELECT` |
//! | `b2_a_non_member_gets_the_same_404_for_every_reason` | 비멤버·떠난 멤버 단건 404, 이유 무관 동일 응답, 목록에서 안 보임 | the `membership ms` join (and `left_at IS NULL`) |
//! | `b3_unsharing_removes_the_session_from_the_next_read` | 해제 후 사라짐(멤버가 보아도) | the `s.session_id IS NOT NULL` predicate |
//! | `b4_another_tenant_sees_nothing_under_rls_alone` | 타 테넌트: 경로 403 · RLS만으로도 빈 결과 | RLS FORCE on `work_session_share` / `work_session` |
//! | `b5_paging_is_stable_complete_and_strict` | 커서 완전·무중복·동률 안정·잘못된 커서 400 | the `(activity_us, id) <` keyset |
//! | `b6_host_and_agent_credentials_cannot_read_the_board` | 호스트 서명·에이전트 토큰 거부 | `require_human` |
//! | `b7_no_terminal_control_or_commit_field_on_the_wire` | 응답 키 전수 · 금지 키 없음 | `SharedWorkSessionDto` field list |
//! | `b8_agent_session_retention_and_archived_channel` | 종료 30일 뒤(A·L 모두, 공유 행이 남아 있어도)·보관 채널 사라짐 | the retention / `archived_at` predicates |
//! | `b9_a_hosted_work_run_is_a_run_item_only_when_asked_and_shows_no_detail` | run 항목 모양·상태 매핑·요청자·단계/산출물·기본(`include` 없음)은 세션만·D15 비노출 | the `runs` CTE, the `$8` opt-in, the status map |
//! | `b10_run_items_follow_channel_membership_and_tenant` | 비멤버·떠난 멤버·보관 채널·타 테넌트는 run을 못 봄 | the `membership ms` join in `runs` |
//! | `b11_mention_managed_linked_and_stale_runs_are_not_listed` | mention·managed work run 제외, 세션에 연결된 run은 세션 한 줄만, 종료 30일 뒤 제외 | the `input.type` / hosted `EXISTS` / `NOT EXISTS` link / retention predicates |
//! | `b12_a_cursor_is_stable_across_mixed_sources` | 세션+run 혼합 목록의 커서 완전·무중복·동률 안정 | the `(activity_us, id) <` keyset over `board` |
//! | `b13_work_run_updated_fires_on_board_transitions_only` | 보드 어휘 전환·생성에서만 `work.run.updated`, 단계/step 갱신·승인 보류·mention/managed에서는 없음 | the trigger's state comparison and its type/hosted guards |
//!
//! Every refusal test also takes the legitimate path beside it, so none of them
//! can pass by a route that refuses everything, and each asserts the status and
//! the error message so another guard cannot mask it.

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

const NOT_FOUND: &str = "shared work session not found";

fn board_list_url(base: &str, tenant: &Tenant, query: &str) -> String {
    format!(
        "{base}/v1/workspaces/{}/work-sessions/shared{query}",
        tenant.workspace
    )
}

fn board_one_url(base: &str, workspace: Uuid, session: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/work-sessions/{session}/shared")
}

struct Board {
    su: PgPool,
    app: PgPool,
    base: String,
    http: reqwest::Client,
    tenant: Tenant,
    desktop: Uuid,
    seed: [u8; 32],
    owner_token: String,
    /// In channel 1 with the owner.
    alice: Uuid,
    alice_token: String,
    /// Only in channel 2.
    bob: Uuid,
    bob_token: String,
    channel2: Uuid,
}

async fn board() -> Board {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app).await;
    let (desktop, seed) = own_desktop(&su, &tenant).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let (alice, alice_email) = seed_human(&su, tenant.workspace, "member", "앨리스").await;
    join_channel(&su, tenant.workspace, tenant.channel, alice).await;
    let alice_token = login(&http, &base, tenant.workspace, &alice_email).await;
    let channel2 = create_channel(
        &app,
        tenant.workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("b2-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: tenant.owner,
        },
    )
    .await
    .expect("create channel 2")
    .id;
    let (bob, bob_email) = seed_human(&su, tenant.workspace, "member", "밥").await;
    join_channel(&su, tenant.workspace, channel2, bob).await;
    let bob_token = login(&http, &base, tenant.workspace, &bob_email).await;
    Board {
        su,
        app,
        base,
        http,
        tenant,
        desktop,
        seed,
        owner_token,
        alice,
        alice_token,
        bob,
        bob_token,
        channel2,
    }
}

impl Board {
    /// A local pane registered in `channel` and, when `payload` is given, shared.
    async fn local(&self, channel: Uuid, label: &str, payload: Option<Value>) -> Uuid {
        let response = register_local(
            &self.http,
            &self.base,
            &self.owner_token,
            &self.tenant,
            json!({"hostId": self.desktop, "channelId": channel, "label": label}),
        )
        .await;
        assert_eq!(response.status(), 201, "the owner registers a local pane");
        let body: Value = response.json().await.expect("body");
        let session = Uuid::parse_str(body["workSession"]["id"].as_str().expect("id")).unwrap();
        if let Some(payload) = payload {
            self.share(session, &payload).await;
        }
        session
    }

    async fn share(&self, session: Uuid, payload: &Value) {
        let response = patch_share(
            &self.http,
            &self.base,
            &self.tenant,
            session,
            self.desktop,
            &self.seed,
            payload,
        )
        .await;
        assert_eq!(response.status(), 200, "the owner's desktop shares");
    }

    async fn get(&self, token: &str, url: String) -> reqwest::Response {
        self.http
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .expect("get")
    }

    async fn list(&self, token: &str, query: &str) -> Value {
        let response = self
            .get(token, board_list_url(&self.base, &self.tenant, query))
            .await;
        assert_eq!(response.status(), 200, "the board list answers");
        response.json().await.expect("list body")
    }

    async fn one_in(&self, token: &str, tenant: &Tenant, session: Uuid) -> reqwest::Response {
        self.get(token, board_one_url(&self.base, tenant.workspace, session))
            .await
    }

    async fn one(&self, token: &str, session: Uuid) -> reqwest::Response {
        self.get(
            token,
            board_one_url(&self.base, self.tenant.workspace, session),
        )
        .await
    }
}

async fn token_for(b: &Board, tenant: &Tenant) -> String {
    login(&b.http, &b.base, tenant.workspace, &tenant.owner_email).await
}

fn ids(list: &Value) -> Vec<String> {
    list["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .map(|session| session["sessionId"].as_str().expect("id").to_string())
        .collect()
}

fn payload_with(activity: i64, state: &str) -> Value {
    let mut payload = s1_payload();
    payload["lastActivityAt"] = json!(activity);
    payload["state"] = json!(state);
    payload
}

// ---------------------------------------------------------------------------
// 1 — what a member sees
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b1_a_member_sees_shared_and_agent_sessions_newest_first() {
    let b = board().await;
    let now = now_ms() / 1000;
    let older = b
        .local(
            b.tenant.channel,
            "오래된",
            Some(payload_with(now - 3600, "idle")),
        )
        .await;
    let newer = b
        .local(
            b.tenant.channel,
            "최근",
            Some(payload_with(now - 60, "running")),
        )
        .await;
    let private = b.local(b.tenant.channel, "공유 안 함", None).await;
    let elsewhere = b
        .local(
            b.channel2,
            "다른 채널",
            Some(payload_with(now - 30, "running")),
        )
        .await;
    let agent = open_host_session(&b.http, &b.base, &b.owner_token, &b.tenant, b.desktop).await;
    // The agent session is the freshest thing in the channel.
    sqlx::query("UPDATE work_session SET started_at = clock_timestamp() WHERE id = $1")
        .bind(agent)
        .execute(&b.su)
        .await
        .unwrap();

    let list = b.list(&b.alice_token, "").await;
    assert_eq!(
        ids(&list),
        [agent, newer, older].map(|id| id.to_string()),
        "agent session first (freshest), then by last activity; unshared and other-channel absent"
    );
    assert!(list["nextCursor"].is_null());
    assert!(!ids(&list).contains(&private.to_string()), "not shared");
    assert!(
        !ids(&list).contains(&elsewhere.to_string()),
        "not my channel"
    );

    let single = b.one(&b.alice_token, newer).await;
    assert_eq!(single.status(), 200);
    let single: Value = single.json().await.unwrap();
    let session = &single["session"];
    assert_eq!(session["origin"], "local_pty");
    assert_eq!(session["label"], "최근");
    assert_eq!(session["folderLabel"], "momo");
    assert_eq!(session["owner"]["memberId"], b.tenant.owner.to_string());
    assert_eq!(session["owner"]["displayName"], "성재");
    assert_eq!(session["homeChannel"]["id"], b.tenant.channel.to_string());
    assert!(session["homeChannel"]["name"].is_string());
    assert_eq!(session["repo"], "momo");
    assert_eq!(session["branch"], "feat/2862-share");
    assert_eq!(session["harness"], "claude");
    assert_eq!(session["state"], "running");
    assert_eq!(session["stages"], json!(["원인 찾음", "수정 커밋"]));
    assert_eq!(session["diff"]["added"], 128);
    assert_eq!(session["diff"]["uncommitted"], 2);
    assert_eq!(
        session["prUrl"],
        "https://github.com/yeomyeonggeori/oort/pull/2851"
    );
    assert_eq!(session["lastActivityAt"], now - 60);
    assert_eq!(session["status"], "running");

    // The agent-lane session has the same shape, with nulls where there is
    // nothing to say.
    let agent_row = &list["sessions"][0];
    assert_eq!(agent_row["origin"], "host");
    assert_eq!(agent_row["harness"], TOOL);
    assert_eq!(agent_row["state"], "running");
    assert_eq!(agent_row["stages"], json!([]));
    for field in ["repo", "branch", "prUrl", "folderLabel", "sharedAtMs"] {
        assert!(
            agent_row[field].is_null(),
            "{field} is null for an agent session"
        );
    }
    for field in [
        "added",
        "deleted",
        "files",
        "ahead",
        "behind",
        "uncommitted",
    ] {
        assert!(agent_row["diff"][field].is_null(), "diff.{field}");
    }
    assert!(agent_row["lastActivityAt"].as_i64().unwrap() >= now - 5);
    // Same key set as a local row: one shape.
    let keys = |row: &Value| -> Vec<String> {
        let mut keys: Vec<String> = row.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(agent_row), keys(&list["sessions"][1]));

    // The owner sees the same board for the same channel membership; bob sees
    // channel 2 only.
    let bob_list = b.list(&b.bob_token, "").await;
    assert_eq!(ids(&bob_list), [elsewhere.to_string()]);
}

// ---------------------------------------------------------------------------
// 2 — non-members: one 404 for every reason
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b2_a_non_member_gets_the_same_404_for_every_reason() {
    let b = board().await;
    let now = now_ms() / 1000;
    let shared = b
        .local(b.tenant.channel, "공유", Some(payload_with(now, "running")))
        .await;
    let unshared = b.local(b.tenant.channel, "비공유", None).await;

    // The legitimate neighbour: a member reads it. Without this the 404s below
    // could be a route that refuses everyone.
    assert_eq!(b.one(&b.alice_token, shared).await.status(), 200);

    // bob is a workspace member, not a member of the home channel: the session
    // exists, is shared, and is still a 404.
    let for_bob = error_of(b.one(&b.bob_token, shared).await).await;
    assert_eq!(for_bob.0, 404);
    assert_eq!(for_bob.2, NOT_FOUND);

    // Every other reason produces the very same status, code and message:
    // never shared, nonexistent, and another tenant's id.
    // A real, shared local session of *another tenant*, read with this tenant's
    // credential on this tenant's path.
    let (other_session, other_tenant) = {
        let other = seed_tenant(&b.su, &b.app).await;
        let (host, seed) = own_desktop(&b.su, &other).await;
        let token = login(&b.http, &b.base, other.workspace, &other.owner_email).await;
        let registered =
            register_local(&b.http, &b.base, &token, &other, json!({"hostId": host})).await;
        assert_eq!(registered.status(), 201);
        let registered: Value = registered.json().await.unwrap();
        let session = Uuid::parse_str(registered["workSession"]["id"].as_str().unwrap()).unwrap();
        let shared = patch_share(
            &b.http,
            &b.base,
            &other,
            session,
            host,
            &seed,
            &s1_payload(),
        )
        .await;
        assert_eq!(shared.status(), 200, "the other tenant shares its own pane");
        (session, other)
    };
    let other_token = token_for(&b, &other_tenant).await;
    assert_eq!(
        b.one_in(&other_token, &other_tenant, other_session)
            .await
            .status(),
        200,
        "the other tenant can read it itself"
    );
    for (what, session) in [
        ("never shared", unshared),
        ("nonexistent", Uuid::new_v4()),
        ("another tenant's real shared session", other_session),
    ] {
        let seen = error_of(b.one(&b.alice_token, session).await).await;
        assert_eq!(
            seen, for_bob,
            "{what} must be indistinguishable from a non-member"
        );
    }

    // Leaving the channel ends the right to read, at the next read.
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(b.tenant.channel)
        .bind(b.alice)
        .execute(&b.su)
        .await
        .unwrap();
    assert_eq!(error_of(b.one(&b.alice_token, shared).await).await, for_bob);
    assert!(ids(&b.list(&b.alice_token, "").await).is_empty());

    // bob's list has nothing of channel 1, and says so without a count.
    let bob_list = b.list(&b.bob_token, "").await;
    assert_eq!(bob_list["sessions"], json!([]));
    assert!(bob_list["nextCursor"].is_null());
    assert!(bob_list.get("total").is_none() && bob_list.get("count").is_none());

    // A malformed id is a 400 whoever asks (it depends on nothing stored).
    let bad = b
        .get(
            &b.bob_token,
            format!(
                "{}/v1/workspaces/{}/work-sessions/not-a-uuid/shared",
                b.base, b.tenant.workspace
            ),
        )
        .await;
    assert_eq!(bad.status(), 400);
}

// ---------------------------------------------------------------------------
// 3 — unshare disappears
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b3_unsharing_removes_the_session_from_the_next_read() {
    let b = board().await;
    let now = now_ms() / 1000;
    let session = b
        .local(
            b.tenant.channel,
            "곧 해제",
            Some(payload_with(now, "running")),
        )
        .await;
    assert_eq!(
        ids(&b.list(&b.alice_token, "").await),
        [session.to_string()]
    );
    assert_eq!(b.one(&b.alice_token, session).await.status(), 200);

    b.share(session, &json!({"shared": false})).await;

    // alice is still a perfect channel member: only the unshare can explain this.
    let gone = error_of(b.one(&b.alice_token, session).await).await;
    assert_eq!(gone, (404, Value::Null, NOT_FOUND.to_string()));
    assert!(ids(&b.list(&b.alice_token, "").await).is_empty());
    // The owner too: a stopped share is not on the board for anyone.
    assert_eq!(b.one(&b.owner_token, session).await.status(), 404);

    // And it comes back when the owner turns it on again.
    b.share(session, &payload_with(now, "waiting")).await;
    let back: Value = b.one(&b.alice_token, session).await.json().await.unwrap();
    assert_eq!(back["session"]["state"], "waiting");
}

// ---------------------------------------------------------------------------
// 4 — another tenant
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b4_another_tenant_sees_nothing_under_rls_alone() {
    let b = board().await;
    let now = now_ms() / 1000;
    let session = b
        .local(
            b.tenant.channel,
            "A 테넌트",
            Some(payload_with(now, "running")),
        )
        .await;
    let other = seed_tenant(&b.su, &b.app).await;
    let other_token = login(&b.http, &b.base, other.workspace, &other.owner_email).await;

    // Path says A, credential says B: refused before any query.
    let crossed = b
        .get(
            &other_token,
            board_one_url(&b.base, b.tenant.workspace, session),
        )
        .await;
    let crossed = error_of(crossed).await;
    assert_eq!(crossed.0, 403);
    assert_eq!(crossed.2, "workspace scope mismatch");
    let crossed_list = b
        .get(&other_token, board_list_url(&b.base, &b.tenant, ""))
        .await;
    assert_eq!(error_of(crossed_list).await.0, 403);

    // B's own board is empty of A's.
    let own: Value = b
        .get(&other_token, board_list_url(&b.base, &other, ""))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(own["sessions"], json!([]));

    // RLS alone: even a query that *names* A's workspace, A's viewer and A's
    // session, run in B's tenant transaction, returns nothing. The membership
    // and share predicates are not what stops this.
    let (workspace_a, viewer_a, owner_b) = (b.tenant.workspace, b.alice, other.workspace);
    let leaked = momo_db::with_tenant_tx(&b.app, owner_b, move |conn| {
        Box::pin(async move {
            let one =
                momo_t3::work_board::get_board_item_in_tx(conn, workspace_a, viewer_a, session)
                    .await
                    .expect("query");
            let page = momo_t3::work_board::list_board_in_tx(
                conn,
                workspace_a,
                viewer_a,
                false,
                None,
                100,
            )
            .await
            .expect("query");
            Ok::<_, momo_db::DbError>((one.is_some(), page.items.len()))
        })
    })
    .await
    .expect("tenant tx");
    assert_eq!(
        leaked,
        (false, 0),
        "RLS hides A's rows from B's transaction"
    );
    // Control: the same call in A's transaction sees it.
    let seen = momo_db::with_tenant_tx(&b.app, workspace_a, move |conn| {
        Box::pin(async move {
            Ok::<_, momo_db::DbError>(
                momo_t3::work_board::get_board_item_in_tx(conn, workspace_a, viewer_a, session)
                    .await
                    .expect("query")
                    .is_some(),
            )
        })
    })
    .await
    .expect("tenant tx");
    assert!(seen, "the same query in the owning tenant finds it");
}

// ---------------------------------------------------------------------------
// 5 — paging
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b5_paging_is_stable_complete_and_strict() {
    let b = board().await;
    let now = now_ms() / 1000;
    let mut expected = Vec::new();
    // Seven sessions; the middle two share the very same activity second so the
    // id tie-break is what orders them.
    for (index, activity) in [100, 200, 300, 300, 300, 400, 500].into_iter().enumerate() {
        let id = b
            .local(
                b.tenant.channel,
                &format!("세션 {index}"),
                Some(payload_with(now - 10_000 + activity, "running")),
            )
            .await;
        expected.push((activity, id));
    }
    expected.sort_by(|a, b| b.cmp(a));
    let expected: Vec<String> = expected.into_iter().map(|(_, id)| id.to_string()).collect();

    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let query = match &cursor {
            Some(cursor) => format!("?limit=3&cursor={cursor}"),
            None => "?limit=3".to_string(),
        };
        let page = b.list(&b.alice_token, &query).await;
        let got = ids(&page);
        assert!(got.len() <= 3);
        seen.extend(got);
        pages += 1;
        match page["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
        assert!(pages < 10, "paging terminates");
    }
    assert_eq!(pages, 3, "7 rows at 3 per page");
    assert_eq!(seen, expected, "complete, no duplicates, stable under ties");

    // limit is clamped, not an error.
    assert_eq!(ids(&b.list(&b.alice_token, "?limit=0").await).len(), 1);
    assert_eq!(ids(&b.list(&b.alice_token, "?limit=abc").await).len(), 7);

    // A bad cursor is a 400 with a fixed message, and echoes nothing.
    for bad in [
        "x",
        "1_2",
        "-5_00000000-0000-0000-0000-000000000001",
        "%27%3Bdrop",
    ] {
        let response = b
            .get(
                &b.alice_token,
                board_list_url(&b.base, &b.tenant, &format!("?cursor={bad}")),
            )
            .await;
        let (status, _, message) = error_of(response).await;
        assert_eq!(status, 400, "{bad}");
        assert_eq!(message, "invalid cursor", "{bad}");
    }

    // A cursor is only a position in the viewer's own filtered rows: bob, who
    // sees none of these, gets an empty page from alice's cursor.
    let alice_cursor = b.list(&b.alice_token, "?limit=2").await["nextCursor"]
        .as_str()
        .unwrap()
        .to_string();
    let bob_page = b
        .list(&b.bob_token, &format!("?cursor={alice_cursor}"))
        .await;
    assert_eq!(bob_page["sessions"], json!([]));
    assert!(bob_page["nextCursor"].is_null());
}

// ---------------------------------------------------------------------------
// 6 — credentials that are not a signed-in person
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b6_host_and_agent_credentials_cannot_read_the_board() {
    let b = board().await;
    let now = now_ms() / 1000;
    let session = b
        .local(b.tenant.channel, "공유", Some(payload_with(now, "running")))
        .await;
    // Legitimate neighbour.
    assert_eq!(b.one(&b.alice_token, session).await.status(), 200);

    // The owner's own host, correctly signed, on the read path.
    let path = format!(
        "/v1/workspaces/{}/work-sessions/{session}/shared",
        b.tenant.workspace
    );
    let signed = SignedRequest::new(
        reqwest::Method::GET,
        &path,
        b.tenant.workspace,
        b.desktop,
        &b.seed,
        Vec::new(),
    );
    let response = signed.send(&b.http, &b.base).await;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap();
    assert!(
        status == 401 || status == 403,
        "a host signature is not a viewer ({status})"
    );
    assert!(!body.contains("feat/2862-share"), "nothing of the payload");

    // An agent bearer (work:control) is not a person either.
    let agent = agent_bearer(&b.su, &b.tenant).await;
    for url in [
        board_one_url(&b.base, b.tenant.workspace, session),
        board_list_url(&b.base, &b.tenant, ""),
    ] {
        let response = b.get(&agent, url).await;
        let status = response.status().as_u16();
        let body = response.text().await.unwrap();
        assert!(status == 401 || status == 403, "agent bearer: {status}");
        assert!(!body.contains("feat/2862-share"));
    }
    // No credential at all.
    let anonymous = b
        .http
        .get(board_list_url(&b.base, &b.tenant, ""))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
}

// ---------------------------------------------------------------------------
// 7 — nothing that could carry terminal text, input, control or a commit title
// ---------------------------------------------------------------------------

fn collect_keys(value: &Value, into: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                into.push(key.clone());
                collect_keys(inner, into);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_keys(item, into)),
        _ => {}
    }
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b7_no_terminal_control_or_commit_field_on_the_wire() {
    let b = board().await;
    let now = now_ms() / 1000;
    let _ = b
        .local(b.tenant.channel, "공유", Some(payload_with(now, "running")))
        .await;
    let _ = open_host_session(&b.http, &b.base, &b.owner_token, &b.tenant, b.desktop).await;
    let list = b.list(&b.alice_token, "").await;
    assert_eq!(list["sessions"].as_array().unwrap().len(), 2);

    let mut keys = Vec::new();
    collect_keys(&list, &mut keys);
    keys.sort();
    keys.dedup();
    // The exact vocabulary: ShareSummaryS1 + who/where/which lane. A new field
    // has to be added here, in a reviewed diff.
    let mut allowed = vec![
        "sessions",
        "nextCursor",
        "source",
        "sessionId",
        "origin",
        "label",
        "folderLabel",
        "status",
        "owner",
        "memberId",
        "displayName",
        "homeChannel",
        "id",
        "name",
        "startedAtMs",
        "endedAtMs",
        "sharedAtMs",
        "repo",
        "branch",
        "harness",
        "state",
        "stages",
        "diff",
        "added",
        "deleted",
        "files",
        "ahead",
        "behind",
        "uncommitted",
        "prUrl",
        "lastActivityAt",
    ];
    allowed.sort_unstable();
    assert_eq!(keys, allowed, "the board's whole wire vocabulary");
    for forbidden in [
        "ptyId",
        "attachEndpoint",
        "displayEndpoint",
        "displayId",
        "hostId",
        "output",
        "input",
        "text",
        "cwd",
        "path",
        "commitTitle",
        "commits",
        "body",
        "props",
        "rootMessageId",
        "observerGrantCount",
        "controlStartedAt",
    ] {
        assert!(!keys.iter().any(|key| key == forbidden), "{forbidden}");
    }
}

// ---------------------------------------------------------------------------
// 8 — agent-lane retention, archived channel
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b8_agent_session_retention_and_archived_channel() {
    let b = board().await;
    let agent = open_host_session(&b.http, &b.base, &b.owner_token, &b.tenant, b.desktop).await;
    assert_eq!(b.one(&b.alice_token, agent).await.status(), 200);

    // Ended: still listed, as done/stopped.
    let ended = b
        .http
        .patch(format!(
            "{}/v1/workspaces/{}/work-sessions/{agent}",
            b.base, b.tenant.workspace
        ))
        .bearer_auth(&b.owner_token)
        .json(&json!({"status": "ended", "exitCode": 0}))
        .send()
        .await
        .unwrap();
    assert_eq!(ended.status(), 200, "the owner ends the session");
    let row: Value = b.one(&b.alice_token, agent).await.json().await.unwrap();
    assert_eq!(row["session"]["state"], "done");
    assert_eq!(row["session"]["status"], "ended");
    assert!(row["session"]["endedAtMs"].is_i64());

    // 31 days after the end: gone, with the channel and the viewer unchanged.
    sqlx::query(
        "UPDATE work_session SET started_at = now() - interval '40 days', \
                ended_at = now() - interval '31 days' WHERE id = $1",
    )
    .bind(agent)
    .execute(&b.su)
    .await
    .unwrap();
    let gone = error_of(b.one(&b.alice_token, agent).await).await;
    assert_eq!(gone, (404, Value::Null, NOT_FOUND.to_string()));
    assert!(ids(&b.list(&b.alice_token, "").await).is_empty());

    // A shared local session that ended 31 days ago is off the board even though
    // its share row is still there (the notifier's sweep has not run): the read
    // enforces retention itself.
    let now = now_ms() / 1000;
    let stale = b
        .local(b.tenant.channel, "오래됨", Some(payload_with(now, "done")))
        .await;
    assert_eq!(b.one(&b.alice_token, stale).await.status(), 200);
    sqlx::query(
        "UPDATE work_session SET status = 'ended', started_at = now() - interval '40 days', \
                ended_at = now() - interval '29 days', exit_code = 0 WHERE id = $1",
    )
    .bind(stale)
    .execute(&b.su)
    .await
    .unwrap();
    assert_eq!(
        b.one(&b.alice_token, stale).await.status(),
        200,
        "29 days after the end: still inside retention"
    );
    sqlx::query("UPDATE work_session SET ended_at = now() - interval '31 days' WHERE id = $1")
        .bind(stale)
        .execute(&b.su)
        .await
        .unwrap();
    let share_row: i64 =
        sqlx::query_scalar("SELECT count(*) FROM work_session_share WHERE session_id = $1")
            .bind(stale)
            .fetch_one(&b.su)
            .await
            .unwrap();
    assert_eq!(share_row, 1, "the share row is still stored");
    let gone = error_of(b.one(&b.alice_token, stale).await).await;
    assert_eq!(gone, (404, Value::Null, NOT_FOUND.to_string()));
    assert!(ids(&b.list(&b.alice_token, "").await).is_empty());

    // An archived home channel takes its sessions off the board.
    let local = b
        .local(b.tenant.channel, "공유", Some(payload_with(now, "running")))
        .await;
    assert_eq!(b.one(&b.alice_token, local).await.status(), 200);
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(b.tenant.channel)
        .execute(&b.su)
        .await
        .unwrap();
    assert_eq!(b.one(&b.alice_token, local).await.status(), 404);
    assert!(ids(&b.list(&b.alice_token, "").await).is_empty());
    let _ = b.bob;
}

// ---------------------------------------------------------------------------
// 9..13 — hosted agents' work runs on the board (#3517, ADR-0162 증보 3 D13)
// ---------------------------------------------------------------------------

/// A hosted connection row is all the board's predicate asks for (the same
/// `EXISTS` `load_eligible_agent_in_tx` uses for `has_hosted_connection`).
async fn make_hosted(su: &PgPool, tenant: &Tenant, agent: Uuid) {
    // Migration 069's guard: a hosted connection needs the sentinel agent shape.
    sqlx::query(
        "UPDATE agent SET model = 'hosted-agent', base_url = 'https://hosted-agent.invalid/disabled', \
                config = jsonb_build_object('execution_mode', 'hosted_dial_in') \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("make the agent a hosted sentinel");
    sqlx::query(
        "INSERT INTO hosted_agent_connection \
           (workspace_id, agent_member_id, status, created_by, pairing_challenge_hash, pairing_expires_at) \
         VALUES ($1, $2, 'pairing_pending', $3, '\\x00'::bytea, now() + interval '1 hour')",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .bind(tenant.owner)
    .execute(su)
    .await
    .expect("seed hosted connection");
}

async fn extra_agent(su: &PgPool, tenant: &Tenant, channel: Uuid, hosted: bool) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'managed', $3)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(format!("a{}", agent.simple()))
    .execute(su)
    .await
    .expect("seed extra agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(AGENT_MODEL)
    .bind(tenant.owner)
    .execute(su)
    .await
    .expect("seed extra agent");
    join_channel(su, tenant.workspace, channel, agent).await;
    if hosted {
        make_hosted(su, tenant, agent).await;
    }
    agent
}

struct RunSpec {
    agent: Uuid,
    channel: Uuid,
    status: &'static str,
    input: Value,
    output: Option<Value>,
    requester: Option<Uuid>,
    /// Seconds ago for created/updated/finished (all the same instant).
    age_secs: i64,
    step_count: i32,
}

impl RunSpec {
    fn work(tenant: &Tenant, status: &'static str) -> Self {
        RunSpec {
            agent: tenant.agent,
            channel: tenant.channel,
            status,
            input: json!({"type": "work", "title": "로그인 버그 수정", "brief": "SECRET-BRIEF"}),
            output: None,
            requester: Some(tenant.owner),
            age_secs: 60,
            step_count: 0,
        }
    }
}

async fn seed_work_run(su: &PgPool, tenant: &Tenant, spec: RunSpec) -> Uuid {
    let run = Uuid::new_v4();
    let terminal = matches!(
        spec.status,
        "succeeded" | "failed" | "cancelled" | "timed_out"
    );
    let error = (spec.status == "failed").then(|| json!({"message": "SECRET-ERROR"}));
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, output, error, \
            idempotency_key, step_count, started_at, finished_at, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7, $8, $9, $10, \
                 now() - make_interval(secs => $11::double precision), \
                 CASE WHEN $12 THEN now() - make_interval(secs => $11::double precision) END, \
                 now() - make_interval(secs => $11::double precision), \
                 now() - make_interval(secs => $11::double precision))",
    )
    .bind(run)
    .bind(tenant.workspace)
    .bind(spec.agent)
    .bind(spec.channel)
    .bind(spec.status)
    .bind(&spec.input)
    .bind(&spec.output)
    .bind(error)
    .bind(format!("b9:{run}"))
    .bind(spec.step_count)
    .bind(spec.age_secs as f64)
    .bind(terminal)
    .execute(su)
    .await
    .expect("seed work run");
    if let Some(requester) = spec.requester {
        sqlx::query(
            "INSERT INTO audit_log (workspace_id, actor_member_id, action, target_type, target_id, run_id) \
             VALUES ($1, $2, 'agent.work.queued', 'agent_run', $3, $3)",
        )
        .bind(tenant.workspace)
        .bind(requester)
        .bind(run)
        .execute(su)
        .await
        .expect("seed requester audit row");
    }
    run
}

/// `runId` for a run row, `sessionId` for a session row.
fn item_ids(list: &Value) -> Vec<String> {
    list["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .map(|item| {
            item["runId"]
                .as_str()
                .or_else(|| item["sessionId"].as_str())
                .expect("id")
                .to_string()
        })
        .collect()
}

fn run_items(list: &Value) -> Vec<&Value> {
    list["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .filter(|item| item["source"] == "run")
        .collect()
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b9_a_hosted_work_run_is_a_run_item_only_when_asked_and_shows_no_detail() {
    let b = board().await;
    make_hosted(&b.su, &b.tenant, b.tenant.agent).await;
    let now = now_ms() / 1000;
    let session = b
        .local(
            b.tenant.channel,
            "공유",
            Some(payload_with(now - 500, "running")),
        )
        .await;
    let mut spec = RunSpec::work(&b.tenant, "succeeded");
    spec.output = Some(json!({
        "stages": ["원인 찾음", "수정 커밋", "PR 올림"],
        "artifacts": {
            "prUrl": "https://github.com/yeomyeonggeori/oort/pull/3517",
            "branch": "feat/3517-board",
            "added": 128, "deleted": 40, "commits": 3
        },
        "body": "SECRET-BODY",
        "usage": {"detail": "SECRET-USAGE"},
        "message_id": Uuid::new_v4().to_string()
    }));
    spec.step_count = 3;
    let run = seed_work_run(&b.su, &b.tenant, spec).await;

    // Default: sessions only — a client that keys rows on sessionId never meets a run.
    let plain = b.list(&b.alice_token, "").await;
    assert_eq!(item_ids(&plain), vec![session.to_string()]);
    assert_eq!(plain["sessions"][0]["source"], "session");
    assert_eq!(plain["sessions"][0]["sessionId"], session.to_string());

    // Opted in: the run is one more row, newest first.
    let list = b.list(&b.alice_token, "?include=runs").await;
    assert_eq!(item_ids(&list), vec![run.to_string(), session.to_string()]);
    let item = &list["sessions"][0];
    assert_eq!(item["source"], "run");
    assert_eq!(item["runId"], run.to_string());
    assert!(item.get("sessionId").is_none(), "{item}");
    assert_eq!(item["label"], "로그인 버그 수정");
    assert_eq!(item["origin"], "agent_run");
    assert_eq!(item["status"], "done");
    assert_eq!(item["state"], "done");
    assert_eq!(item["owner"]["memberId"], b.tenant.agent.to_string());
    assert_eq!(item["requestedBy"]["memberId"], b.tenant.owner.to_string());
    assert_eq!(item["requestedBy"]["displayName"], "성재");
    assert_eq!(item["homeChannel"]["id"], b.tenant.channel.to_string());
    assert_eq!(item["stages"], json!(["원인 찾음", "수정 커밋", "PR 올림"]));
    assert_eq!(item["stepCount"], 3);
    assert_eq!(item["commits"], 3);
    assert_eq!(item["branch"], "feat/3517-board");
    assert_eq!(item["diff"]["added"], 128);
    assert_eq!(item["diff"]["deleted"], 40);
    assert_eq!(
        item["pr"],
        json!({"url": "https://github.com/yeomyeonggeori/oort/pull/3517", "number": 3517})
    );
    assert_eq!(
        item["prUrl"],
        "https://github.com/yeomyeonggeori/oort/pull/3517"
    );
    assert!(item["endedAtMs"].is_i64());

    // D15: nothing the agent wrote in free text beyond markers/branch reaches the
    // wire — not the brief, the reply body, the usage detail, nor the error.
    let wire = serde_json::to_string(&list).unwrap();
    for secret in [
        "SECRET-BRIEF",
        "SECRET-BODY",
        "SECRET-USAGE",
        "SECRET-ERROR",
    ] {
        assert!(!wire.contains(secret), "{secret} leaked: {wire}");
    }
    let mut keys = Vec::new();
    collect_keys(item, &mut keys);
    for forbidden in [
        "body",
        "detail",
        "textDelta",
        "error",
        "input",
        "output",
        "props",
        "message_id",
    ] {
        assert!(!keys.iter().any(|key| key == forbidden), "{forbidden}");
    }

    // D13's status words, one run per ledger status.
    for (ledger, board_word) in [
        ("queued", "waiting"),
        ("running", "running"),
        ("awaiting_approval", "running"),
        ("paused", "running"),
        ("failed", "failed"),
        ("timed_out", "failed"),
        ("cancelled", "stopped"),
    ] {
        let id = seed_work_run(
            &b.su,
            &b.tenant,
            RunSpec::work(&b.tenant, ledger_static(ledger)),
        )
        .await;
        let list = b.list(&b.alice_token, "?include=runs&limit=100").await;
        let found = run_items(&list)
            .into_iter()
            .find(|item| item["runId"] == id.to_string())
            .unwrap_or_else(|| panic!("{ledger} run listed"));
        assert_eq!(found["status"], board_word, "{ledger}");
        assert_eq!(found["state"], board_word, "{ledger}");
        // Migration 120's SQL table (the realtime trigger) is the same mapping.
        let sql_word: String = sqlx::query_scalar("SELECT work_run_board_state($1)")
            .bind(ledger)
            .fetch_one(&b.su)
            .await
            .unwrap();
        assert_eq!(
            sql_word, board_word,
            "{ledger}: trigger vocabulary == board vocabulary"
        );
    }

    // No request record: still listed, requestedBy absent.
    let mut anonymous = RunSpec::work(&b.tenant, "running");
    anonymous.requester = None;
    let id = seed_work_run(&b.su, &b.tenant, anonymous).await;
    let list = b.list(&b.alice_token, "?include=runs&limit=100").await;
    let found = run_items(&list)
        .into_iter()
        .find(|item| item["runId"] == id.to_string())
        .expect("listed without a requester");
    assert!(found.get("requestedBy").is_none());

    // A run item never has a single-read route (the card is the agent-runs detail).
    assert_eq!(b.one(&b.alice_token, run).await.status(), 404);
}

fn ledger_static(status: &str) -> &'static str {
    match status {
        "queued" => "queued",
        "running" => "running",
        "awaiting_approval" => "awaiting_approval",
        "paused" => "paused",
        "failed" => "failed",
        "timed_out" => "timed_out",
        "cancelled" => "cancelled",
        other => panic!("{other}"),
    }
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b10_run_items_follow_channel_membership_and_tenant() {
    let b = board().await;
    make_hosted(&b.su, &b.tenant, b.tenant.agent).await;
    let run = seed_work_run(&b.su, &b.tenant, RunSpec::work(&b.tenant, "running")).await;

    // Legitimate neighbours: a channel member sees it.
    for token in [&b.alice_token, &b.owner_token] {
        let list = b.list(token, "?include=runs").await;
        assert_eq!(item_ids(&list), vec![run.to_string()]);
    }
    // bob is only in channel 2 — nothing, not an error, and no count.
    let bob = b.list(&b.bob_token, "?include=runs").await;
    assert!(item_ids(&bob).is_empty(), "{bob}");
    assert!(bob["nextCursor"].is_null());

    // A member who left no longer sees it.
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(b.tenant.channel)
        .bind(b.alice)
        .execute(&b.su)
        .await
        .unwrap();
    assert!(item_ids(&b.list(&b.alice_token, "?include=runs").await).is_empty());
    assert_eq!(
        item_ids(&b.list(&b.owner_token, "?include=runs").await),
        vec![run.to_string()]
    );

    // A run in channel 2 is bob's, not alice's.
    let two = seed_work_run(
        &b.su,
        &b.tenant,
        RunSpec {
            channel: b.channel2,
            ..RunSpec::work(&b.tenant, "running")
        },
    )
    .await;
    // (the agent must be a channel-2 member for nothing; membership of the
    // *viewer* is what the board checks)
    assert_eq!(
        item_ids(&b.list(&b.bob_token, "?include=runs").await),
        vec![two.to_string()]
    );
    assert!(
        !item_ids(&b.list(&b.alice_token, "?include=runs").await).contains(&two.to_string()),
        "alice (channel 1 only, rejoined below) does not see channel 2's run"
    );
    join_channel(&b.su, b.tenant.workspace, b.tenant.channel, b.alice).await;
    assert_eq!(
        item_ids(&b.list(&b.alice_token, "?include=runs").await),
        vec![run.to_string()]
    );

    // An archived channel takes its runs off the board.
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(b.tenant.channel)
        .execute(&b.su)
        .await
        .unwrap();
    assert!(item_ids(&b.list(&b.alice_token, "?include=runs").await).is_empty());
    sqlx::query("UPDATE channel SET archived_at = NULL WHERE id = $1")
        .bind(b.tenant.channel)
        .execute(&b.su)
        .await
        .unwrap();

    // Another tenant: its owner sees none of this tenant's runs (and its own
    // listing is empty), and under RLS alone — the viewer id is this tenant's, the
    // transaction is the other's — the read is empty as well.
    let other = seed_tenant(&b.su, &b.app).await;
    let other_token = token_for(&b, &other).await;
    let theirs = b
        .get(
            &other_token,
            board_list_url(&b.base, &other, "?include=runs"),
        )
        .await;
    assert_eq!(theirs.status(), 200);
    assert!(item_ids(&theirs.json::<Value>().await.unwrap()).is_empty());
    let forged = b
        .get(
            &other_token,
            board_list_url(&b.base, &b.tenant, "?include=runs"),
        )
        .await;
    assert_eq!(
        forged.status(),
        403,
        "path workspace is not the credential's"
    );
    let workspace_a = b.tenant.workspace;
    let workspace_b = other.workspace;
    let viewer_a = b.alice;
    let rls_only = momo_db::with_tenant_tx(&b.app, workspace_b, move |conn| {
        Box::pin(async move {
            Ok::<_, momo_db::DbError>(
                momo_t3::work_board::list_board_in_tx(conn, workspace_a, viewer_a, true, None, 100)
                    .await
                    .expect("read")
                    .items
                    .len(),
            )
        })
    })
    .await
    .expect("tx");
    assert_eq!(
        rls_only, 0,
        "RLS FORCE hides another tenant's runs by itself"
    );
    // Control: the same call in the owning tenant's transaction finds the run.
    let control = momo_db::with_tenant_tx(&b.app, workspace_a, move |conn| {
        Box::pin(async move {
            Ok::<_, momo_db::DbError>(
                momo_t3::work_board::list_board_in_tx(conn, workspace_a, viewer_a, true, None, 100)
                    .await
                    .expect("read")
                    .items
                    .len(),
            )
        })
    })
    .await
    .expect("tx");
    assert_eq!(control, 1, "the owning tenant's transaction sees its run");
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b11_mention_managed_linked_and_stale_runs_are_not_listed() {
    let b = board().await;
    make_hosted(&b.su, &b.tenant, b.tenant.agent).await;
    let managed = extra_agent(&b.su, &b.tenant, b.tenant.channel, false).await;

    let listed = seed_work_run(&b.su, &b.tenant, RunSpec::work(&b.tenant, "running")).await;
    let _mention = seed_work_run(
        &b.su,
        &b.tenant,
        RunSpec {
            input: json!({"surface": "mention", "prompt": "SECRET-PROMPT"}),
            ..RunSpec::work(&b.tenant, "running")
        },
    )
    .await;
    let _managed = seed_work_run(
        &b.su,
        &b.tenant,
        RunSpec {
            agent: managed,
            ..RunSpec::work(&b.tenant, "running")
        },
    )
    .await;
    let stale = seed_work_run(
        &b.su,
        &b.tenant,
        RunSpec {
            age_secs: 31 * 24 * 3600,
            ..RunSpec::work(&b.tenant, "succeeded")
        },
    )
    .await;
    let recent = seed_work_run(
        &b.su,
        &b.tenant,
        RunSpec {
            age_secs: 29 * 24 * 3600,
            ..RunSpec::work(&b.tenant, "succeeded")
        },
    )
    .await;

    // A run that drove a work session: the audit row `work_controls::create`
    // writes (`run_id` + the control as target) is what links them.
    let session = open_host_session(&b.http, &b.base, &b.owner_token, &b.tenant, b.desktop).await;
    let linked = seed_work_run(&b.su, &b.tenant, RunSpec::work(&b.tenant, "running")).await;
    let control: Uuid = sqlx::query_scalar(
        "INSERT INTO work_control (workspace_id, channel_id, requester_member_id, target_host_id, \
                                   session_id, kind, status) \
         VALUES ($1, $2, $3, $4, $5, 'read', 'acked') RETURNING id",
    )
    .bind(b.tenant.workspace)
    .bind(b.tenant.channel)
    .bind(b.tenant.agent)
    .bind(b.desktop)
    .bind(session)
    .fetch_one(&b.su)
    .await
    .expect("seed a control against the session");
    sqlx::query(
        "INSERT INTO audit_log (workspace_id, actor_member_id, action, target_type, target_id, run_id) \
         VALUES ($1, $2, 'work.control.requested', 'work_control', $3, $4)",
    )
    .bind(b.tenant.workspace)
    .bind(b.tenant.agent)
    .bind(control)
    .bind(linked)
    .execute(&b.su)
    .await
    .expect("link the run to the session");

    let list = b.list(&b.alice_token, "?include=runs&limit=100").await;
    let got = item_ids(&list);
    assert!(
        got.contains(&listed.to_string()),
        "the plain hosted run is listed"
    );
    assert!(
        got.contains(&recent.to_string()),
        "29 days after the end: inside retention"
    );
    assert!(
        !got.contains(&stale.to_string()),
        "31 days after the end: gone"
    );
    assert!(
        !got.contains(&linked.to_string()),
        "a run linked to a session is not a second row"
    );
    assert_eq!(
        got.iter().filter(|id| **id == session.to_string()).count(),
        1,
        "the session is the one row for that work"
    );
    assert_eq!(
        got.len(),
        3,
        "listed + recent + the session; mention and managed runs are absent: {got:?}"
    );
    assert!(!serde_json::to_string(&list)
        .unwrap()
        .contains("SECRET-PROMPT"));
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b12_a_cursor_is_stable_across_mixed_sources() {
    let b = board().await;
    make_hosted(&b.su, &b.tenant, b.tenant.agent).await;
    let now = now_ms() / 1000;
    let mut expected: Vec<(i64, String)> = Vec::new();
    // Sessions at known activity seconds, runs at known ages; two runs share an
    // age so the id tie-break orders them.
    for (index, offset) in [10_i64, 40, 70].into_iter().enumerate() {
        let id = b
            .local(
                b.tenant.channel,
                &format!("세션 {index}"),
                Some(payload_with(now - offset, "running")),
            )
            .await;
        expected.push((now - offset, id.to_string()));
    }
    let mut run_ids = Vec::new();
    for age in [20_i64, 50, 50, 80] {
        let id = seed_work_run(
            &b.su,
            &b.tenant,
            RunSpec {
                age_secs: age,
                ..RunSpec::work(&b.tenant, "running")
            },
        )
        .await;
        run_ids.push((age, id));
    }
    // Run activity µs straight from the ledger, so the expected order is the
    // data's, not the query's.
    let mut with_activity: Vec<(i64, String)> = Vec::new();
    for (_, id) in &run_ids {
        let us: i64 = sqlx::query_scalar(
            "SELECT (extract(epoch FROM GREATEST(created_at, updated_at, finished_at)) * 1000000)::bigint \
               FROM agent_run WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&b.su)
        .await
        .unwrap();
        with_activity.push((us, id.to_string()));
    }
    let mut all: Vec<(i64, String)> = expected
        .iter()
        .map(|(s, id)| (s * 1_000_000, id.clone()))
        .collect();
    all.extend(with_activity);
    all.sort_by(|a, c| c.cmp(a));
    let expected: Vec<String> = all.into_iter().map(|(_, id)| id).collect();
    assert_eq!(expected.len(), 7);

    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let query = match &cursor {
            Some(cursor) => format!("?include=runs&limit=3&cursor={cursor}"),
            None => "?include=runs&limit=3".to_string(),
        };
        let page = b.list(&b.alice_token, &query).await;
        seen.extend(item_ids(&page));
        pages += 1;
        match page["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
        assert!(pages < 10);
    }
    assert_eq!(pages, 3, "7 rows at 3 per page");
    assert_eq!(
        seen, expected,
        "complete, no duplicates, stable under ties, across both sources"
    );
}

async fn run_events(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query_scalar::<_, Value>(
        "SELECT payload FROM outbox WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'work.run.updated' ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read outbox")
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn b13_work_run_updated_fires_on_board_transitions_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app).await;
    make_hosted(&su, &tenant, tenant.agent).await;
    let managed = extra_agent(&su, &tenant, tenant.channel, false).await;

    // Creation is the first transition (a `waiting` row appears on the board).
    let run = seed_work_run(&su, &tenant, RunSpec::work(&tenant, "queued")).await;
    let events = run_events(&su, tenant.workspace).await;
    assert_eq!(events.len(), 1, "{events:?}");
    let event = &events[0];
    assert_eq!(
        event["channel"],
        format!(
            "ch:ws{}.{}",
            tenant.workspace.to_string().to_uppercase(),
            tenant.channel.to_string().to_uppercase()
        )
    );
    assert_eq!(event["data"]["type"], "work.run.updated");
    assert_eq!(event["data"]["v"], 1);
    assert_eq!(
        event["data"]["payload"],
        json!({"run_id": run.to_string(), "channel_id": tenant.channel.to_string(), "to": "waiting"}),
        "ids and the transition kind only — no title, name or number"
    );
    assert!(event["idempotency_key"]
        .as_str()
        .unwrap()
        .contains(&run.to_string()));

    let set_status = |status: &'static str| {
        let su = su.clone();
        async move {
            sqlx::query(
                "UPDATE agent_run SET status = $2::run_status, updated_at = now() WHERE id = $1",
            )
            .bind(run)
            .bind(status)
            .execute(&su)
            .await
            .expect("transition");
        }
    };
    let count = || async { run_events(&su, tenant.workspace).await.len() };

    set_status("running").await;
    assert_eq!(count().await, 2, "queued -> running");
    // Stage markers and step_count move without a status change: no event (D11).
    sqlx::query(
        "UPDATE agent_run SET output = '{\"stages\":[\"a\",\"b\"]}'::jsonb, step_count = 2, \
                updated_at = now() WHERE id = $1",
    )
    .bind(run)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(count().await, 2, "a stage/step update is not a transition");
    // Same status written again, and approval holds / control-window parks, which
    // the board folds into `running`: no event.
    set_status("running").await;
    set_status("awaiting_approval").await;
    set_status("running").await;
    set_status("paused").await;
    set_status("running").await;
    assert_eq!(
        count().await,
        2,
        "holds and re-writes are not board transitions"
    );
    set_status("succeeded").await;
    let events = run_events(&su, tenant.workspace).await;
    assert_eq!(events.len(), 3, "running -> done");
    assert_eq!(events[2]["data"]["payload"]["to"], "done");

    // mention runs and managed agents' work runs never emit.
    let _ = seed_work_run(
        &su,
        &tenant,
        RunSpec {
            input: json!({"surface": "mention", "prompt": "x"}),
            ..RunSpec::work(&tenant, "queued")
        },
    )
    .await;
    let managed_run = seed_work_run(
        &su,
        &tenant,
        RunSpec {
            agent: managed,
            ..RunSpec::work(&tenant, "queued")
        },
    )
    .await;
    sqlx::query("UPDATE agent_run SET status = 'running'::run_status WHERE id = $1")
        .bind(managed_run)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(count().await, 3, "mention and managed runs emit nothing");

    // Cancelling a queued run is a transition to `stopped`.
    let queued = seed_work_run(&su, &tenant, RunSpec::work(&tenant, "queued")).await;
    sqlx::query("UPDATE agent_run SET status = 'cancelled'::run_status WHERE id = $1")
        .bind(queued)
        .execute(&su)
        .await
        .unwrap();
    let events = run_events(&su, tenant.workspace).await;
    assert_eq!(events.len(), 5, "create + cancel of the second run");
    assert_eq!(events[4]["data"]["payload"]["to"], "stopped");
}
