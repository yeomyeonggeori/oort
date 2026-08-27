//! DB-backed conformance for **#1778**: the human-owner observation PATCH
//! (`open` ↔ `owner_only`).
//!
//! `#[ignore]` — needs a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test observation_toggle_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract matches `host_signed_session_conformance_pg.rs`:
//! `DATABASE_URL` is a **superuser**; the **server** runs as `momo_app`.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `obs_1_owner_toggles_teammate_attach_is_refused_then_reopens` | refuse observation by name (400), let a teammate PATCH, skip the observer-cap revoke, or leave attach open after `owner_only` |

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

const TEST_JWT_SECRET: &str = "obs-1778-observation-toggle-secret";
const TEST_PASSWORD: &str = "obs-1778-conformance-password";
const PTY_ID: &str = "pty-obs-1778";
const ATTACH_ENDPOINT: &str = "wss://host.obs.invalid/v1/terminal-attach";

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
    owner: Uuid,
    owner_email: String,
    teammate_email: String,
    channel: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, label: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@obs1778.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(label)
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

async fn seed_fixture(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let (owner, owner_email) = seed_human(su, workspace, "owner", "obs-owner").await;
    let (teammate, teammate_email) = seed_human(su, workspace, "member", "obs-teammate").await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("obs-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(teammate)
    .execute(su)
    .await
    .expect("seed teammate channel membership");
    Fixture {
        workspace,
        owner,
        owner_email,
        teammate_email,
        channel,
    }
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
) -> (String, [u8; 32]) {
    let (seed, public_key) = workd_keypair();
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-hosts"))
        .bearer_auth(token)
        .json(&json!({
            "scope": "workspace",
            "type": "workd",
            "displayName": "obs-1778 host",
            "publicKey": public_key,
            "capabilities": { "terminal_attach": true },
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

fn session_path(workspace: Uuid, session: &str) -> String {
    format!("/v1/workspaces/{workspace}/work-sessions/{session}")
}

async fn bind_pty(su: &PgPool, session: Uuid) {
    let updated =
        sqlx::query("UPDATE work_session SET pty_id = $2, attach_endpoint = $3 WHERE id = $1")
            .bind(session)
            .bind(PTY_ID)
            .bind(ATTACH_ENDPOINT)
            .execute(su)
            .await
            .expect("bind the remote PTY")
            .rows_affected();
    assert_eq!(updated, 1, "exactly one session is bound");
}

async fn observer_count(su: &PgPool, session: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM terminal_attach_capability \
          WHERE work_session_id = $1 AND mode = 'observer'",
    )
    .bind(session)
    .fetch_one(su)
    .await
    .expect("count observer caps")
}

async fn audit_count(su: &PgPool, workspace: Uuid, session: Uuid, observation: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 \
            AND action = 'work.session.observation' \
            AND target_id = $2 \
            AND detail->>'observation' = $3 \
            AND detail->>'schema' = 'momo.work.session.observation.v1'",
    )
    .bind(workspace)
    .bind(session)
    .bind(observation)
    .fetch_one(su)
    .await
    .expect("count observation audit")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn obs_1_owner_toggles_teammate_attach_is_refused_then_reopens() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let teammate_token = login(&http, &base, workspace, &fixture.teammate_email).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace).await;

    let created = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(&owner_token)
        .json(&json!({
            "channelId": fixture.channel,
            "hostId": host_id,
            "tool": "claude",
            "label": "obs-1778",
        }))
        .send()
        .await
        .expect("human create");
    assert_eq!(created.status(), 201);
    let created_body: Value = created.json().await.expect("created session");
    assert_eq!(created_body["workSession"]["observation"], "open");
    assert_eq!(
        created_body["workSession"]["memberId"],
        fixture.owner.to_string()
    );
    let session = created_body["workSession"]["id"]
        .as_str()
        .expect("session id")
        .to_string();
    let session_id = Uuid::parse_str(&session).expect("session uuid");
    bind_pty(&su, session_id).await;

    let attach_path =
        format!("{base}/v1/workspaces/{workspace}/work-sessions/{session}/terminal-attach");

    let first_watch = http
        .post(&attach_path)
        .bearer_auth(&teammate_token)
        .json(&json!({"mode": "observer"}))
        .send()
        .await
        .expect("teammate watch while open");
    assert_eq!(first_watch.status(), 200, "open session admits a teammate");
    assert_eq!(observer_count(&su, session_id).await, 1);

    // ---- wire shape + refusals --------------------------------------------
    let invented = http
        .patch(format!("{base}{}", session_path(workspace, &session)))
        .bearer_auth(&owner_token)
        .json(&json!({"observation": "closed"}))
        .send()
        .await
        .expect("invented observation value");
    let (status, message) = error_message(invented).await;
    assert_eq!(status, 400);
    assert_eq!(message, "observation must be open or owner_only");

    let combined = http
        .patch(format!("{base}{}", session_path(workspace, &session)))
        .bearer_auth(&owner_token)
        .json(&json!({"observation": "owner_only", "status": "ended"}))
        .send()
        .await
        .expect("combined observation + lifecycle");
    let (status, message) = error_message(combined).await;
    assert_eq!(status, 400);
    assert_eq!(
        message,
        "observation cannot be combined with lifecycle fields"
    );

    let host_obs = signed_host(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        "PATCH",
        &session_path(workspace, &session),
        &json!({"observation": "owner_only"}),
    )
    .await;
    let (status, message) = error_message(host_obs).await;
    assert_eq!(status, 403);
    assert_eq!(message, "observation requires a human bearer");

    let teammate_patch = http
        .patch(format!("{base}{}", session_path(workspace, &session)))
        .bearer_auth(&teammate_token)
        .json(&json!({"observation": "owner_only"}))
        .send()
        .await
        .expect("teammate observation patch");
    let (status, message) = error_message(teammate_patch).await;
    assert_eq!(status, 403);
    assert_eq!(message, "only the session owner can change observation");

    // ---- owner closes ------------------------------------------------------
    let closed = http
        .patch(format!("{base}{}", session_path(workspace, &session)))
        .bearer_auth(&owner_token)
        .json(&json!({"observation": "owner_only"}))
        .send()
        .await
        .expect("owner close");
    assert_eq!(closed.status(), 200, "owner toggle is served");
    let closed_body: Value = closed.json().await.expect("closed body");
    assert_eq!(closed_body["workSession"]["observation"], "owner_only");
    assert_eq!(closed_body["workSession"]["observerGrantCount"], 0);
    assert_eq!(
        observer_count(&su, session_id).await,
        0,
        "closing observation must revoke live observer grants"
    );
    assert_eq!(
        audit_count(&su, workspace, session_id, "owner_only").await,
        1,
        "the close writes one audit row in the same transaction"
    );

    let refused = http
        .post(&attach_path)
        .bearer_auth(&teammate_token)
        .json(&json!({"mode": "observer"}))
        .send()
        .await
        .expect("teammate watch while closed");
    let (status, message) = error_message(refused).await;
    assert_eq!(status, 403);
    assert_eq!(message, "session observation is owner-only");

    // ---- owner reopens -----------------------------------------------------
    let opened = http
        .patch(format!("{base}{}", session_path(workspace, &session)))
        .bearer_auth(&owner_token)
        .json(&json!({"observation": "open"}))
        .send()
        .await
        .expect("owner reopen");
    assert_eq!(opened.status(), 200);
    let opened_body: Value = opened.json().await.expect("opened body");
    assert_eq!(opened_body["workSession"]["observation"], "open");
    assert_eq!(
        audit_count(&su, workspace, session_id, "open").await,
        1,
        "the reopen writes its own audit row"
    );

    let rewatch = http
        .post(&attach_path)
        .bearer_auth(&teammate_token)
        .json(&json!({"mode": "observer"}))
        .send()
        .await
        .expect("teammate watch after reopen");
    assert_eq!(rewatch.status(), 200, "reopen admits the teammate again");
    let grant: Value = rewatch.json().await.expect("rewatch body");
    assert!(
        grant["capability_token"]
            .as_str()
            .is_some_and(|token| token.starts_with("momo_terminal_attach_v1.")),
        "a real observer grant, not a mocked token"
    );
}
