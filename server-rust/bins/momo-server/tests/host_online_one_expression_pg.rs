//! DB-backed conformance for **ADR-0198 T4** (#3569): 「내 맥 온라인」 is one
//! server expression, `momo_wire::work_host_online_sql`
//! (`revoked_at IS NULL AND last_seen_at >= now() - 90 s`), and every place that
//! decides it agrees with the value the work-hosts read publishes as `online`.
//!
//! The four deciding places, driven against the same host rows at the same
//! moment:
//!
//! * `GET …/work-hosts` → `online` (what the desktop and the phone render)
//! * `momo_t3::target_work_host_in_tx` (the spawn/resume target check)
//! * `momo_t3::spawn_host_candidates_in_tx` (the spawn picker)
//! * `momo_t3::load_session_reattach_state_in_tx` → `host_online`
//!
//! `#[ignore]` because it needs a `pgvector/pgvector:pg18` superuser DB:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15433/momo \
//!   cargo test -p momo-server --test host_online_one_expression_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `t4_1_every_online_decision_agrees_at_the_window_edges` | change the window in `momo_wire::work_host_online_sql` for one site only, drop the `revoked_at IS NULL` clause, or give a site its own copy of the expression |

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

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "srvchain-daemon-resume-conformance-secret";
const TEST_PASSWORD: &str = "srvchain-conformance-password";
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

fn daemon_keypair() -> ([u8; 32], String) {
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
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

const WINDOW: i64 = momo_wire::ONLINE_WINDOW_SECONDS;

async fn set_seen(su: &PgPool, host: Uuid, seen_ago: Option<i64>, revoked: bool) {
    sqlx::query(
        "UPDATE work_host SET \
           last_seen_at = CASE WHEN $2::bigint IS NULL THEN NULL \
                               ELSE clock_timestamp() - make_interval(secs => $2::bigint) END, \
           revoked_at = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END \
         WHERE id = $1",
    )
    .bind(host)
    .bind(seen_ago)
    .bind(revoked)
    .execute(su)
    .await
    .expect("move the host heartbeat");
}

/// What each deciding place says about `host` right now.
struct Verdicts {
    work_hosts_read: Option<bool>,
    target: Option<bool>,
    candidates: Option<bool>,
    reattach: Option<bool>,
}

async fn verdicts(
    su: &PgPool,
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    host: Uuid,
    session: Uuid,
) -> Verdicts {
    let body: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/work-hosts",
            tenant.workspace
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("list work hosts")
        .json()
        .await
        .expect("work hosts body");
    let hosts = body["workHosts"]
        .as_array()
        .or_else(|| body.as_array())
        .expect("a list of work hosts");
    let work_hosts_read = hosts
        .iter()
        .find(|row| row["id"].as_str() == Some(&host.to_string()))
        .map(|row| row["online"].as_bool().expect("online is a bool"));

    let mut conn = su.acquire().await.expect("connection");
    let target = momo_t3::target_work_host_in_tx(&mut conn, tenant.workspace, host)
        .await
        .expect("target host")
        .map(|row| row.online);
    let candidates =
        momo_t3::spawn_host_candidates_in_tx(&mut conn, tenant.workspace, tenant.human)
            .await
            .expect("candidates")
            .into_iter()
            .find(|row| row.id == host)
            .map(|row| row.online);
    let reattach = momo_t3::load_session_reattach_state_in_tx(&mut conn, tenant.workspace, session)
        .await
        .expect("reattach")
        .map(|row| row.host_online);
    Verdicts {
        work_hosts_read,
        target,
        candidates,
        reattach,
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL pointing at a pgvector/pg18 superuser DB"]
async fn t4_1_every_online_decision_agrees_at_the_window_edges() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let host = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;
    let session = create_session(&http, &base, &token, &tenant, host, "t4").await;

    // The literal 90 does not move with the constant: a window change must
    // be a deliberate edit of this test too.
    assert_eq!(WINDOW, 90);
    // (seen_ago, revoked, expected online). The 10 s margins keep the cases off
    // the exact boundary so a slow CI box cannot flip them.
    let cases: [(Option<i64>, bool, bool, &str); 6] = [
        (Some(5), false, true, "fresh heartbeat"),
        (Some(WINDOW - 10), false, true, "just inside the window"),
        (Some(WINDOW + 10), false, false, "just outside the window"),
        (Some(3600), false, false, "long gone"),
        (None, false, false, "never heartbeated"),
        (Some(5), true, false, "revoked outranks a fresh heartbeat"),
    ];
    for (seen_ago, revoked, expected, why) in cases {
        set_seen(&su, host, seen_ago, revoked).await;
        let v = verdicts(&su, &http, &base, &token, &tenant, host, session).await;
        assert_eq!(v.work_hosts_read, Some(expected), "work-hosts read: {why}");
        assert_eq!(v.reattach, Some(expected), "reattach host_online: {why}");
        if revoked {
            // A revoked host is not a target or a candidate at all, which is
            // "not online" stated by absence, never a contradicting `true`.
            assert_eq!(v.target, None, "target refuses a revoked host");
            assert_eq!(v.candidates, None, "a revoked host is not offered");
        } else {
            assert_eq!(v.target, Some(expected), "spawn target: {why}");
            assert_eq!(v.candidates, Some(expected), "spawn candidates: {why}");
        }
    }
}
