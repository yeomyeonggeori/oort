//! DB-backed conformance for **#1777**: host-signed work-session variants
//! (create ↔ dispatched spawn, idle/running, `bindRemotePTY`).
//!
//! `#[ignore]` — needs a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test host_signed_session_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract matches `display_attach_conformance_pg.rs`:
//! `DATABASE_URL` is a **superuser** (migrations + fixtures bypass RLS); the
//! **server** runs as `momo_app` (NOBYPASSRLS) so every assertion goes through
//! the policies production uses.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `hss_1_unsigned_and_foreign_host_are_refused_then_the_owner_flips_attach` | drop the host-signed create/bind arms, accept a human PTY field, or skip the `controlId` ↔ dispatched-spawn pin |
//! | `hss_2_only_the_signing_host_may_move_running_and_idle` | let a human PATCH idle/running, or skip the host pin on the lifecycle arm |

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
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "hss-1777-host-signed-session-secret";
const TEST_PASSWORD: &str = "hss-1777-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
const TOOL: &str = "claude";
const LABEL: &str = "host-signed";
const PTY_ID: &str = "pty-hss-1777";
const ATTACH_ENDPOINT: &str = "wss://host.hss.invalid/v1/terminal-attach";

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

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql?)")
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

struct Fixture {
    workspace: Uuid,
    owner_email: String,
    channel: Uuid,
    agent: Uuid,
    run: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@hss1777.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(human.to_string())
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
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
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (human, email)
}

async fn seed_fixture(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let (owner, owner_email) = seed_human(su, workspace).await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("hss-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, $2, $2, $3, true, $4, $4) \
         ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true",
    )
    .bind(workspace)
    .bind(TOOL)
    .bind(json!({"command": TOOL, "arguments": []}))
    .bind(owner)
    .execute(su)
    .await
    .expect("seed work tool profile");

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(agent.to_string())
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
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent channel membership");

    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'running'::run_status, $5, $6)",
    )
    .bind(run)
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(json!({"type": "work", "title": "hss", "brief": "hss"}))
    .bind(format!("hss1777:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");

    Fixture {
        workspace,
        owner_email,
        channel,
        agent,
        run,
    }
}

async fn agent_bearer(su: &PgPool, fixture: &Fixture) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", fixture.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 'hss-1777')",
    )
    .bind(fixture.workspace)
    .bind(fixture.agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn workd_keypair() -> ([u8; 32], String) {
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

async fn register_host(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    attach: bool,
) -> (String, [u8; 32]) {
    let (seed, public_key) = workd_keypair();
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-hosts"))
        .bearer_auth(token)
        .json(&json!({
            "scope": "workspace",
            "type": "workd",
            "displayName": "hss-1777 host",
            "publicKey": public_key,
            "capabilities": { "terminal_attach": attach },
        }))
        .send()
        .await
        .expect("register work host");
    assert_eq!(response.status(), 201, "the host is registered");
    let body: Value = response.json().await.expect("host body");
    (
        body["workHost"]["id"]
            .as_str()
            .expect("workHost.id")
            .to_string(),
        seed,
    )
}

#[allow(clippy::too_many_arguments)]
async fn signed_host(
    http: &reqwest::Client,
    base: &str,
    seed: &[u8; 32],
    workspace: Uuid,
    host_id: &str,
    method: &str,
    path: &str,
    body: &Value,
) -> reqwest::Response {
    let raw = serde_json::to_vec(body).expect("serialize the signed body");
    let digest = momo_wire::signing::sha256_hex(&raw);
    let request_id = Uuid::new_v4();
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let payload = momo_wire::signing::request_payload(
        method,
        path,
        workspace,
        Uuid::parse_str(host_id).expect("host uuid"),
        sent_at_ms,
        &digest,
        request_id,
    );
    let signature = momo_wire::signing::sign_base64(seed, &payload).expect("sign");
    let url = format!("{base}{path}");
    let builder = match method {
        "POST" => http.post(&url),
        "PATCH" => http.patch(&url),
        other => panic!("signed_host helper covers POST/PATCH, not {other}"),
    };
    builder
        .header("Authorization", format!("MomoHost {host_id}"))
        .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
        .header("X-Momo-Work-Host-Signature", signature)
        .header("X-Momo-Work-Host-Request-ID", request_id.to_string())
        .header("Content-Type", "application/json")
        .body(raw)
        .send()
        .await
        .expect("signed host request")
}

async fn error_message(response: reqwest::Response) -> (u16, String) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.expect("error body");
    (
        status,
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

async fn dispatch_spawn(
    http: &reqwest::Client,
    base: &str,
    owner_token: &str,
    agent_token: &str,
    fixture: &Fixture,
    host_id: &str,
    label: &str,
) -> Uuid {
    let enabled = http
        .put(format!(
            "{base}/v1/workspaces/{}/work-auto-approvals/{TOOL}",
            fixture.workspace
        ))
        .bearer_auth(owner_token)
        .send()
        .await
        .expect("enable auto approve");
    assert_eq!(enabled.status(), 200, "auto-approve is on");

    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-controls",
            fixture.workspace
        ))
        .bearer_auth(agent_token)
        .json(&json!({
            "channelId": fixture.channel,
            "runId": fixture.run,
            "targetHostId": host_id,
            "kind": "spawn",
            "payload": {"tool": TOOL, "label": label},
        }))
        .send()
        .await
        .expect("request spawn");
    assert_eq!(response.status(), 201, "spawn is auto-dispatched");
    let body: Value = response.json().await.expect("spawn body");
    assert_eq!(body["workControl"]["status"], "dispatched");
    Uuid::parse_str(body["workControl"]["id"].as_str().expect("control id")).expect("control uuid")
}

fn session_path(workspace: Uuid, session: &str) -> String {
    format!("/v1/workspaces/{workspace}/work-sessions/{session}")
}

fn create_path(workspace: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/work-sessions")
}

fn create_body(channel: Uuid, host_id: &str, control: Uuid) -> Value {
    json!({
        "channelId": channel,
        "hostId": host_id,
        "tool": TOOL,
        "label": LABEL,
        "controlId": control,
    })
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn hss_1_unsigned_and_foreign_host_are_refused_then_the_owner_flips_attach() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let agent_token = agent_bearer(&su, &fixture).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let (other_id, other_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let control = dispatch_spawn(
        &http,
        &base,
        &owner_token,
        &agent_token,
        &fixture,
        &host_id,
        LABEL,
    )
    .await;

    // ---- unsigned / human path stays the Swift sentences -------------------
    let unsigned = http
        .post(format!("{base}{}", create_path(workspace)))
        .bearer_auth(&owner_token)
        .json(&create_body(fixture.channel, &host_id, control))
        .send()
        .await
        .expect("human create with controlId");
    let (status, message) = error_message(unsigned).await;
    assert_eq!(status, 400);
    assert_eq!(message, "controlId is reserved for work host dispatch");

    let unsigned_pty = http
        .post(format!("{base}{}", create_path(workspace)))
        .bearer_auth(&owner_token)
        .json(&json!({
            "channelId": fixture.channel,
            "hostId": host_id,
            "tool": TOOL,
            "label": LABEL,
            "ptyId": PTY_ID,
            "attachEndpoint": ATTACH_ENDPOINT,
        }))
        .send()
        .await
        .expect("human create with pty");
    let (status, message) = error_message(unsigned_pty).await;
    assert_eq!(status, 400);
    assert_eq!(message, "remote PTY binding requires work host signature");

    // Human create without host-only fields still works (regression lock).
    let human_ok = http
        .post(format!("{base}{}", create_path(workspace)))
        .bearer_auth(&owner_token)
        .json(&json!({
            "channelId": fixture.channel,
            "hostId": host_id,
            "tool": TOOL,
            "label": "human-path",
        }))
        .send()
        .await
        .expect("human create");
    assert_eq!(human_ok.status(), 201);
    let human_body: Value = human_ok.json().await.expect("human session");
    assert_eq!(human_body["workSession"]["remoteAttachAvailable"], false);
    let human_session = human_body["workSession"]["id"]
        .as_str()
        .expect("human session id")
        .to_string();

    let human_bind = http
        .patch(format!("{base}{}", session_path(workspace, &human_session)))
        .bearer_auth(&owner_token)
        .json(&json!({
            "ptyId": PTY_ID,
            "attachEndpoint": ATTACH_ENDPOINT,
        }))
        .send()
        .await
        .expect("human bind");
    let (status, message) = error_message(human_bind).await;
    assert_eq!(status, 400);
    assert_eq!(message, "remote PTY binding requires work host signature");

    // ---- foreign host signature --------------------------------------------
    // Signer B claims host A in the body: the pin is "you are the host you name".
    let foreign = signed_host(
        &http,
        &base,
        &other_seed,
        workspace,
        &other_id,
        "POST",
        &create_path(workspace),
        &create_body(fixture.channel, &host_id, control),
    )
    .await;
    let (status, message) = error_message(foreign).await;
    assert_eq!(status, 403);
    assert_eq!(message, "work host session binding is invalid");

    // Signer B names itself but the control was dispatched to A.
    let stolen = signed_host(
        &http,
        &base,
        &other_seed,
        workspace,
        &other_id,
        "POST",
        &create_path(workspace),
        &create_body(fixture.channel, &other_id, control),
    )
    .await;
    let (status, message) = error_message(stolen).await;
    assert_eq!(status, 409);
    assert_eq!(message, "spawn control is not dispatchable by this host");

    // ---- controlId mismatch ------------------------------------------------
    let mismatch = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "POST",
        &create_path(workspace),
        &create_body(fixture.channel, &host_id, Uuid::new_v4()),
    )
    .await;
    let (status, message) = error_message(mismatch).await;
    assert_eq!(status, 409);
    assert_eq!(message, "spawn control is not dispatchable by this host");

    // ---- owning host creates; attach is still false until bindRemotePTY ----
    let created = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "POST",
        &create_path(workspace),
        &create_body(fixture.channel, &host_id, control),
    )
    .await;
    assert_eq!(created.status(), 201, "host-signed create is served");
    let created_body: Value = created.json().await.expect("created session");
    assert_eq!(created_body["workSession"]["status"], "running");
    assert_eq!(
        created_body["workSession"]["remoteAttachAvailable"], false,
        "create without a PTY pair must leave the dock dark"
    );
    let session = created_body["workSession"]["id"]
        .as_str()
        .expect("session id")
        .to_string();

    let foreign_bind = signed_host(
        &http,
        &base,
        &other_seed,
        workspace,
        &other_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({
            "ptyId": PTY_ID,
            "attachEndpoint": ATTACH_ENDPOINT,
        }),
    )
    .await;
    let (status, message) = error_message(foreign_bind).await;
    assert_eq!(status, 403);
    assert_eq!(message, "work host cannot bind another host session");

    let bound = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({
            "ptyId": PTY_ID,
            "attachEndpoint": ATTACH_ENDPOINT,
        }),
    )
    .await;
    assert_eq!(bound.status(), 200, "bindRemotePTY is served");
    let bound_body: Value = bound.json().await.expect("bound session");
    assert_eq!(
        bound_body["workSession"]["remoteAttachAvailable"], true,
        "the dock's producer flag must flip on a real signed bind"
    );

    // Idempotent republish of the same pair.
    let again = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({
            "ptyId": PTY_ID,
            "attachEndpoint": ATTACH_ENDPOINT,
        }),
    )
    .await;
    assert_eq!(again.status(), 200);

    let conflict = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({
            "ptyId": "pty-other",
            "attachEndpoint": ATTACH_ENDPOINT,
        }),
    )
    .await;
    let (status, message) = error_message(conflict).await;
    assert_eq!(status, 409);
    assert_eq!(
        message,
        "work session already has a different remote PTY binding"
    );

    // ACP stays refused-by-name (follow-up requested in the #1777 PR).
    let acp = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({"event": {"type": "session_info"}}),
    )
    .await;
    let (status, message) = error_message(acp).await;
    assert_eq!(status, 400);
    assert_eq!(message, "ACP event ingestion requires work host signature");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn hss_2_only_the_signing_host_may_move_running_and_idle() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let agent_token = agent_bearer(&su, &fixture).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let (other_id, other_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let control = dispatch_spawn(
        &http,
        &base,
        &owner_token,
        &agent_token,
        &fixture,
        &host_id,
        LABEL,
    )
    .await;

    let created = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "POST",
        &create_path(workspace),
        &create_body(fixture.channel, &host_id, control),
    )
    .await;
    assert_eq!(created.status(), 201);
    let created_body: Value = created.json().await.expect("created");
    let session = created_body["workSession"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    let human_idle = http
        .patch(format!("{base}{}", session_path(workspace, &session)))
        .bearer_auth(&owner_token)
        .json(&json!({"status": "idle", "exitCode": 0}))
        .send()
        .await
        .expect("human idle");
    let (status, message) = error_message(human_idle).await;
    assert_eq!(status, 403);
    assert_eq!(
        message,
        "tool lifecycle transitions require work host signature"
    );

    let foreign_idle = signed_host(
        &http,
        &base,
        &other_seed,
        workspace,
        &other_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({"status": "idle", "exitCode": 0}),
    )
    .await;
    let (status, message) = error_message(foreign_idle).await;
    assert_eq!(status, 403);
    assert_eq!(message, "work host cannot update another host session");

    let idle = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({"status": "idle", "exitCode": 0}),
    )
    .await;
    assert_eq!(idle.status(), 200);
    let idle_body: Value = idle.json().await.expect("idle body");
    assert_eq!(idle_body["workSession"]["status"], "idle");
    assert_eq!(idle_body["workSession"]["exitCode"], 0);

    let running = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({"status": "running"}),
    )
    .await;
    assert_eq!(running.status(), 200);
    let running_body: Value = running.json().await.expect("running body");
    assert_eq!(running_body["workSession"]["status"], "running");
}
