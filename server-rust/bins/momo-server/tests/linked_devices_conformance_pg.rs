//! ADR-0180 D5 / #2029 — linked-device list and disconnect.
//!
//! Red proofs:
//!   two device-link sessions → GET /v1/auth/devices has 2 rows, `current` matches
//!     the calling token
//!   another member's GET sees 0 rows (owner filter)
//!   another member DELETE of B's id is 404 (no existence leak)
//!   DELETE B → B's token 401 on the next request, A still 200
//!   DELETE of the calling device is 400 `cannot_revoke_current`
//!   response bodies contain no token/secret strings
//!
//! SABOTAGE:
//!   revoke no-op → the 401 assertion RED
//!   list without owner filter → "other member sees 0 rows" RED
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test linked_devices_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Assertion messages never interpolate session secrets.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "linked-devices-conformance-signing-secret";
const TEST_PASSWORD: &str = "linked-devices-test-password";

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
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
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
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let app = build_app(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        RealtimeAdvert::SameOrigin,
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Human {
    id: Uuid,
    email: String,
}

async fn seed_workspace(su: &PgPool, hint: &str) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@linked-devices.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(handle)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
    Human { id, email }
}

struct Session {
    access: String,
    refresh: String,
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> Session {
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
    assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    Session {
        access: body["accessToken"]
            .as_str()
            .expect("login returns an access token")
            .to_string(),
        refresh: body["refreshToken"]
            .as_str()
            .expect("login returns a refresh token")
            .to_string(),
    }
}

fn loopback_host(base: &str) -> String {
    base.trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string()
}

fn assert_status(actual: u16, expected: u16) {
    assert_eq!(
        actual, expected,
        "unexpected HTTP status {actual} (expected {expected})"
    );
}

fn assert_no_secrets(haystack: &str, secrets: &[String]) {
    let lower = haystack.to_lowercase();
    for needle in ["accesstoken", "refreshtoken"] {
        assert!(
            !lower.contains(needle),
            "linked-device JSON named a token field"
        );
    }
    if haystack.contains("eyJ") {
        panic!("linked-device JSON contained a JWT prefix");
    }
    for secret in secrets {
        if !secret.is_empty() && haystack.contains(secret) {
            panic!("linked-device JSON contained a session secret");
        }
    }
}

async fn issue_link(http: &reqwest::Client, base: &str, access: &str, host: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/device-link"))
        .header("authorization", format!("Bearer {access}"))
        .header("host", host)
        .header("x-forwarded-proto", "http")
        .send()
        .await
        .expect("issue device-link");
    assert_status(response.status().as_u16(), 201);
    let body: Value = response.json().await.expect("issue body");
    body["token"]
        .as_str()
        .expect("issue 201 carries a voucher")
        .to_string()
}

async fn redeem_named(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    host: &str,
    name: &str,
    platform: &str,
) -> Session {
    let response = http
        .post(format!("{base}/v1/auth/device-link/redeem"))
        .header("host", host)
        .header("x-forwarded-proto", "http")
        .json(&json!({
            "token": token,
            "device": { "name": name, "platform": platform },
        }))
        .send()
        .await
        .expect("redeem");
    assert_status(response.status().as_u16(), 200);
    let body: Value = response.json().await.expect("redeem body");
    Session {
        access: body["accessToken"]
            .as_str()
            .expect("redeem issues access")
            .to_string(),
        refresh: body["refreshToken"]
            .as_str()
            .expect("redeem issues refresh")
            .to_string(),
    }
}

async fn list_devices(http: &reqwest::Client, base: &str, access: &str) -> (u16, String, Value) {
    let response = http
        .get(format!("{base}/v1/auth/devices"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("list devices");
    let status = response.status().as_u16();
    let raw = response.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    (status, raw, body)
}

async fn delete_device(
    http: &reqwest::Client,
    base: &str,
    access: &str,
    id: &str,
) -> (u16, String) {
    let response = http
        .delete(format!("{base}/v1/auth/devices/{id}"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("delete device");
    let status = response.status().as_u16();
    let raw = response.text().await.unwrap_or_default();
    (status, raw)
}

async fn channels_status(http: &reqwest::Client, base: &str, workspace: Uuid, access: &str) -> u16 {
    http.get(format!("{base}/v1/workspaces/{workspace}/channels"))
        .header("authorization", format!("Bearer {access}"))
        .send()
        .await
        .expect("channels probe")
        .status()
        .as_u16()
}

fn device_by_label<'a>(body: &'a Value, label: &str) -> &'a Value {
    body["devices"]
        .as_array()
        .expect("devices array")
        .iter()
        .find(|row| row["label"].as_str() == Some(label))
        .unwrap_or_else(|| panic!("missing linked device {label}"))
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn linked_devices_list_and_revoke_are_owner_scoped() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let workspace = seed_workspace(&su, "ld-owner").await;
    let owner = seed_human(
        &su,
        workspace,
        &format!("ow-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let other = seed_human(
        &su,
        workspace,
        &format!("ot-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let base = start_server(app_pool).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let desktop = login(&http, &base, workspace, &owner.email).await;
    let other_session = login(&http, &base, workspace, &other.email).await;

    let voucher_a = issue_link(&http, &base, &desktop.access, &host).await;
    let phone_a = redeem_named(&http, &base, &voucher_a, &host, "Phone A", "ios").await;
    let voucher_b = issue_link(&http, &base, &desktop.access, &host).await;
    let mut phone_b = redeem_named(&http, &base, &voucher_b, &host, "Phone B", "android").await;

    let secrets = vec![
        desktop.access.clone(),
        desktop.refresh.clone(),
        phone_a.access.clone(),
        phone_a.refresh.clone(),
        phone_b.access.clone(),
        phone_b.refresh.clone(),
        voucher_a.clone(),
        voucher_b.clone(),
    ];

    let (list_status, list_raw, list_body) = list_devices(&http, &base, &phone_a.access).await;
    assert_status(list_status, 200);
    assert_no_secrets(&list_raw, &secrets);
    let devices = list_body["devices"].as_array().expect("devices array");
    assert_eq!(devices.len(), 2, "two linked devices for this member");
    let row_a = device_by_label(&list_body, "Phone A");
    let row_b = device_by_label(&list_body, "Phone B");
    assert_eq!(row_a["platform"], "ios");
    assert_eq!(row_b["platform"], "android");
    assert_eq!(row_a["current"], true, "calling token is current");
    assert_eq!(row_b["current"], false);
    assert!(row_a["linkedAt"].as_i64().expect("linkedAt") > 0);
    assert!(row_b["id"].as_str().is_some());
    let id_a = row_a["id"].as_str().expect("id A").to_string();
    let id_b = row_b["id"].as_str().expect("id B").to_string();

    let (other_list_status, other_list_raw, other_list_body) =
        list_devices(&http, &base, &other_session.access).await;
    assert_status(other_list_status, 200);
    assert_no_secrets(&other_list_raw, &secrets);
    assert_eq!(
        other_list_body["devices"]
            .as_array()
            .expect("other devices array")
            .len(),
        0,
        "other member sees 0 rows"
    );

    let (foreign_status, foreign_raw) =
        delete_device(&http, &base, &other_session.access, &id_b).await;
    assert_status(foreign_status, 404);
    assert_no_secrets(&foreign_raw, &secrets);

    let refresh_response = http
        .post(format!("{base}/v1/auth/refresh"))
        .json(&json!({ "refreshToken": phone_b.refresh }))
        .send()
        .await
        .expect("refresh B");
    assert_status(refresh_response.status().as_u16(), 200);
    let refresh_body: Value = refresh_response.json().await.expect("refresh body");
    phone_b = Session {
        access: refresh_body["accessToken"]
            .as_str()
            .expect("rotated access")
            .to_string(),
        refresh: refresh_body["refreshToken"]
            .as_str()
            .expect("rotated refresh")
            .to_string(),
    };
    let secrets_after_refresh = vec![
        phone_a.access.clone(),
        phone_a.refresh.clone(),
        phone_b.access.clone(),
        phone_b.refresh.clone(),
    ];

    let (after_refresh_status, after_refresh_raw, after_refresh_body) =
        list_devices(&http, &base, &phone_a.access).await;
    assert_status(after_refresh_status, 200);
    assert_no_secrets(&after_refresh_raw, &secrets_after_refresh);
    assert_eq!(
        after_refresh_body["devices"]
            .as_array()
            .expect("devices after refresh")
            .len(),
        2,
        "refresh rebind keeps the linked device listed"
    );

    let (revoke_current, revoke_current_raw) =
        delete_device(&http, &base, &phone_a.access, &id_a).await;
    assert_status(revoke_current, 400);
    assert_no_secrets(&revoke_current_raw, &secrets_after_refresh);
    assert!(
        revoke_current_raw.contains("cannot_revoke_current"),
        "current session revoke is a named 400"
    );

    let (revoke_b, revoke_b_raw) = delete_device(&http, &base, &phone_a.access, &id_b).await;
    assert_status(revoke_b, 204);
    assert_no_secrets(&revoke_b_raw, &secrets_after_refresh);

    assert_status(
        channels_status(&http, &base, workspace, &phone_b.access).await,
        401,
    );
    assert_status(
        channels_status(&http, &base, workspace, &phone_a.access).await,
        200,
    );

    let (after_revoke_status, after_revoke_raw, after_revoke_body) =
        list_devices(&http, &base, &phone_a.access).await;
    assert_status(after_revoke_status, 200);
    assert_no_secrets(&after_revoke_raw, &secrets_after_refresh);
    assert_eq!(
        after_revoke_body["devices"]
            .as_array()
            .expect("devices after revoke")
            .len(),
        1
    );
    assert_eq!(
        after_revoke_body["devices"][0]["label"], "Phone A",
        "only the surviving device remains"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn agent_bearer_cannot_list_or_revoke_linked_devices() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let workspace = seed_workspace(&su, "ld-agent").await;
    let owner = seed_human(
        &su,
        workspace,
        &format!("ag-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let agent = Uuid::new_v4();
    let handle = format!("ag-{}", &agent.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(&handle)
    .execute(&su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner.id)
    .execute(&su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(&su)
    .await
    .expect("seed agent membership");
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let bearer = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'linked-devices-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .execute(&su)
    .await
    .expect("seed agent bearer");

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let (status, raw, _) = list_devices(&http, &base, &bearer).await;
    assert_status(status, 403);
    assert!(!raw.contains(&secret), "agent secret must not echo");
    let (revoke_status, revoke_raw) =
        delete_device(&http, &base, &bearer, &Uuid::new_v4().to_string()).await;
    assert_status(revoke_status, 403);
    assert!(!revoke_raw.contains(&secret), "agent secret must not echo");
}

// ---------------------------------------------------------------------------
// #2498 — refresh and revoke serialize on the stable device_link_token row
// ---------------------------------------------------------------------------
//
// Order is taken from Postgres, never guessed with a sleep. A superuser
// transaction holds `SELECT … FOR UPDATE` on the device row; the HTTP calls are
// spawned one at a time and each one only counts as queued once
// `pg_stat_activity` reports that backend blocked (`wait_event_type = 'Lock'`)
// on a `device_link_token … FOR UPDATE` statement. Committing the barrier then
// hands the row lock to the waiters in the order they queued, so "refresh
// first" and "revoke first" are two deterministic runs of the same fixture.
//
// RED (sabotage): delete `FOR UPDATE` from `LOCK_LINKED_DEVICE_SQL`
// (`momo-auth/src/device_link.rs`). Nothing queues behind the barrier, the
// waiter assertion in `refresh_first_then_revoke_leaves_no_live_pair` fails,
// and with it the only mechanism that orders a refresh against a revoke.

/// Backends blocked on a `device_link_token` row lock right now. `usename`
/// keeps the count to the API role, so the barrier's own superuser connection
/// and this poller are never counted.
const LOCK_WAITERS_SQL: &str = "SELECT count(*)::bigint \
      FROM pg_stat_activity \
     WHERE datname = current_database() \
       AND pid <> $1 \
       AND pid <> pg_backend_pid() \
       AND usename = 'momo_app' \
       AND state = 'active' \
       AND wait_event_type = 'Lock' \
       AND query LIKE '%FROM device_link_token%' \
       AND query LIKE '%FOR UPDATE%'";

const LIVE_DEVICE_TOKENS_SQL: &str = "SELECT count(*)::bigint \
      FROM token \
     WHERE workspace_id = $1 \
       AND actor_member_id = $2 \
       AND kind = 'session' \
       AND device_label = $3 \
       AND revoked_at IS NULL \
       AND (expires_at IS NULL OR expires_at > now())";

const RECORDED_DEVICE_TOKENS_SQL: &str = "SELECT count(*)::bigint \
      FROM token \
     WHERE workspace_id = $1 \
       AND actor_member_id = $2 \
       AND kind = 'session' \
       AND device_label = $3";

/// A superuser transaction parked on one `device_link_token` row.
struct DeviceRowBarrier {
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    pid: i32,
}

impl DeviceRowBarrier {
    /// Rewrite the binding while the lock is still held, so the waiter finds a
    /// different pair the moment it is admitted.
    async fn rebind_refresh(&mut self, device_id: Uuid, refresh_token_id: Uuid) {
        sqlx::query("UPDATE device_link_token SET redeemed_refresh_token_id = $2 WHERE id = $1")
            .bind(device_id)
            .bind(refresh_token_id)
            .execute(&mut *self.tx)
            .await
            .expect("barrier rewrites the linked-device binding");
    }

    async fn release(self) {
        self.tx.commit().await.expect("release the barrier");
    }
}

async fn begin_device_barrier(su: &PgPool, device_id: Uuid) -> DeviceRowBarrier {
    let mut tx = su.begin().await.expect("open the barrier transaction");
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .expect("barrier backend pid");
    let locked: Uuid =
        sqlx::query_scalar("SELECT id FROM device_link_token WHERE id = $1 FOR UPDATE")
            .bind(device_id)
            .fetch_one(&mut *tx)
            .await
            .expect("barrier takes FOR UPDATE on the device row");
    assert_eq!(locked, device_id, "barrier locked the requested device row");
    DeviceRowBarrier { tx, pid }
}

/// Block until exactly `expected` API backends are parked on that row lock.
async fn await_device_lock_waiters(su: &PgPool, barrier: &DeviceRowBarrier, expected: i64) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut seen: i64 = -1;
    while std::time::Instant::now() < deadline {
        seen = sqlx::query_scalar::<_, i64>(LOCK_WAITERS_SQL)
            .bind(barrier.pid)
            .fetch_one(su)
            .await
            .expect("read pg_stat_activity");
        if seen >= expected {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        seen, expected,
        "expected {expected} API request(s) blocked on the device_link_token row lock \
         (wait_event_type='Lock'), saw {seen}: without that lock nothing orders \
         a linked-device refresh against a revoke"
    );
}

fn spawn_refresh(
    http: &reqwest::Client,
    base: &str,
    refresh_token: &str,
) -> tokio::task::JoinHandle<(u16, String)> {
    let http = http.clone();
    let url = format!("{base}/v1/auth/refresh");
    let body = json!({ "refreshToken": refresh_token });
    tokio::spawn(async move {
        let response = http.post(url).json(&body).send().await.expect("refresh");
        let status = response.status().as_u16();
        let raw = response.text().await.unwrap_or_default();
        (status, raw)
    })
}

fn spawn_delete_device(
    http: &reqwest::Client,
    base: &str,
    access: &str,
    device_id: &str,
) -> tokio::task::JoinHandle<(u16, String)> {
    let http = http.clone();
    let url = format!("{base}/v1/auth/devices/{device_id}");
    let bearer = format!("Bearer {access}");
    tokio::spawn(async move {
        let response = http
            .delete(url)
            .header("authorization", bearer)
            .send()
            .await
            .expect("delete device");
        let status = response.status().as_u16();
        let raw = response.text().await.unwrap_or_default();
        (status, raw)
    })
}

async fn join_request(handle: tokio::task::JoinHandle<(u16, String)>, what: &str) -> (u16, String) {
    match tokio::time::timeout(std::time::Duration::from_secs(60), handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => panic!("{what} task panicked"),
        Err(_) => panic!("{what} never finished — the barrier left it blocked"),
    }
}

async fn refresh_once(http: &reqwest::Client, base: &str, refresh_token: &str) -> (u16, String) {
    let response = http
        .post(format!("{base}/v1/auth/refresh"))
        .json(&json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .expect("refresh");
    let status = response.status().as_u16();
    let raw = response.text().await.unwrap_or_default();
    (status, raw)
}

async fn live_device_tokens(su: &PgPool, workspace: Uuid, member: Uuid, label: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(LIVE_DEVICE_TOKENS_SQL)
        .bind(workspace)
        .bind(member)
        .bind(label)
        .fetch_one(su)
        .await
        .expect("count live device tokens")
}

async fn recorded_device_tokens(su: &PgPool, workspace: Uuid, member: Uuid, label: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(RECORDED_DEVICE_TOKENS_SQL)
        .bind(workspace)
        .bind(member)
        .bind(label)
        .fetch_one(su)
        .await
        .expect("count recorded device tokens")
}

async fn device_binding(su: &PgPool, device_id: Uuid) -> (Uuid, Uuid) {
    let (access, refresh) = sqlx::query_as::<_, (Option<Uuid>, Option<Uuid>)>(
        "SELECT redeemed_access_token_id, redeemed_refresh_token_id \
           FROM device_link_token WHERE id = $1",
    )
    .bind(device_id)
    .fetch_one(su)
    .await
    .expect("read the linked-device binding");
    (
        access.expect("bound access id"),
        refresh.expect("bound refresh id"),
    )
}

async fn token_id_of(su: &PgPool, raw_token: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM token WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(raw_token)
    .fetch_one(su)
    .await
    .expect("recorded token row")
}

async fn token_is_revoked(su: &PgPool, raw_token: &str) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT revoked_at IS NOT NULL FROM token \
          WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(raw_token)
    .fetch_one(su)
    .await
    .expect("recorded token row")
}

/// One human with one password session (the revoker) and one redeemed linked
/// device (the racer).
struct LinkedFixture {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    member: Uuid,
    desktop: Session,
    phone: Session,
    device_id: Uuid,
    label: String,
}

async fn linked_device_fixture(hint: &str, label: &str) -> LinkedFixture {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let workspace = seed_workspace(&su, hint).await;
    let owner = seed_human(
        &su,
        workspace,
        &format!("{hint}-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let base = start_server(app_pool).await;
    let host = loopback_host(&base);
    let http = reqwest::Client::new();
    let desktop = login(&http, &base, workspace, &owner.email).await;
    let voucher = issue_link(&http, &base, &desktop.access, &host).await;
    let phone = redeem_named(&http, &base, &voucher, &host, label, "ios").await;
    let (list_status, _list_raw, list_body) = list_devices(&http, &base, &desktop.access).await;
    assert_status(list_status, 200);
    let device_id = device_by_label(&list_body, label)["id"]
        .as_str()
        .expect("linked device id")
        .to_string();
    LinkedFixture {
        su,
        http,
        base,
        workspace,
        member: owner.id,
        desktop,
        phone,
        device_id: Uuid::parse_str(&device_id).expect("device id is a uuid"),
        label: label.to_string(),
    }
}

/// Acceptance 4, refresh first: the rotation commits, and the revoke that was
/// queued behind it kills the pair the rotation just minted — not the pair it
/// observed before the lock.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn refresh_first_then_revoke_leaves_no_live_pair() {
    let _lock = test_lock().await;
    let fx = linked_device_fixture("ld-rf", "Phone Refresh First").await;
    let old_pair = device_binding(&fx.su, fx.device_id).await;
    assert_eq!(
        live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        2,
        "the redeemed device starts with one live access + refresh pair"
    );

    let barrier = begin_device_barrier(&fx.su, fx.device_id).await;
    let refresh_call = spawn_refresh(&fx.http, &fx.base, &fx.phone.refresh);
    await_device_lock_waiters(&fx.su, &barrier, 1).await;
    let delete_call = spawn_delete_device(
        &fx.http,
        &fx.base,
        &fx.desktop.access,
        &fx.device_id.to_string(),
    );
    await_device_lock_waiters(&fx.su, &barrier, 2).await;
    barrier.release().await;

    let (refresh_status, refresh_raw) = join_request(refresh_call, "linked refresh").await;
    assert_status(refresh_status, 200);
    let rotated: Value = serde_json::from_str(&refresh_raw).expect("refresh body is JSON");
    let new_access = rotated["accessToken"]
        .as_str()
        .expect("rotated access")
        .to_string();
    let new_refresh = rotated["refreshToken"]
        .as_str()
        .expect("rotated refresh")
        .to_string();

    let (delete_status, delete_raw) = join_request(delete_call, "device revoke").await;
    assert_status(delete_status, 204);
    assert!(
        delete_raw.is_empty(),
        "a successful device revoke answers with no body"
    );

    assert_status(
        channels_status(&fx.http, &fx.base, fx.workspace, &new_access).await,
        401,
    );
    let (replay_status, replay_raw) = refresh_once(&fx.http, &fx.base, &new_refresh).await;
    assert_status(replay_status, 401);
    assert!(
        replay_raw.contains("already used or revoked") || replay_raw.contains("revoked"),
        "the rotated refresh is refused after the revoke"
    );
    assert_eq!(
        live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        0,
        "the revoke that lost the race still killed every live token on this device"
    );
    let bound = device_binding(&fx.su, fx.device_id).await;
    assert_ne!(bound, old_pair, "the winning refresh rebound the device");
    assert_eq!(
        bound,
        (
            token_id_of(&fx.su, &new_access).await,
            token_id_of(&fx.su, &new_refresh).await
        ),
        "the binding names the rotated pair"
    );
}

/// Acceptance 4, revoke first: the rotation queued behind it is refused with
/// the single-use wording, and the binding is left on the revoked pair.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn revoke_first_then_refresh_is_refused() {
    let _lock = test_lock().await;
    let fx = linked_device_fixture("ld-rv", "Phone Revoke First").await;
    let old_pair = device_binding(&fx.su, fx.device_id).await;

    let barrier = begin_device_barrier(&fx.su, fx.device_id).await;
    let delete_call = spawn_delete_device(
        &fx.http,
        &fx.base,
        &fx.desktop.access,
        &fx.device_id.to_string(),
    );
    await_device_lock_waiters(&fx.su, &barrier, 1).await;
    let refresh_call = spawn_refresh(&fx.http, &fx.base, &fx.phone.refresh);
    await_device_lock_waiters(&fx.su, &barrier, 2).await;
    barrier.release().await;

    let (delete_status, delete_raw) = join_request(delete_call, "device revoke").await;
    assert_status(delete_status, 204);
    assert!(delete_raw.is_empty(), "revoke answers with no body");

    let (refresh_status, refresh_raw) = join_request(refresh_call, "linked refresh").await;
    assert_status(refresh_status, 401);
    assert!(
        refresh_raw.contains("refresh token already used or revoked"),
        "the losing rotation is the single-use 401"
    );

    assert_status(
        channels_status(&fx.http, &fx.base, fx.workspace, &fx.phone.access).await,
        401,
    );
    assert_eq!(
        live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        0,
        "no token survived on the revoked device"
    );
    assert_eq!(
        device_binding(&fx.su, fx.device_id).await,
        old_pair,
        "the refused rotation left the binding on the revoked pair"
    );
}

/// Acceptance 4, duplicate rotation: two presentations of one refresh token
/// wait on the same row, and exactly one of them may mint a pair.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn concurrent_duplicate_refresh_mints_exactly_one_pair() {
    let _lock = test_lock().await;
    let fx = linked_device_fixture("ld-dup", "Phone Duplicate").await;

    let barrier = begin_device_barrier(&fx.su, fx.device_id).await;
    let first = spawn_refresh(&fx.http, &fx.base, &fx.phone.refresh);
    await_device_lock_waiters(&fx.su, &barrier, 1).await;
    let second = spawn_refresh(&fx.http, &fx.base, &fx.phone.refresh);
    await_device_lock_waiters(&fx.su, &barrier, 2).await;
    barrier.release().await;

    let (first_status, first_raw) = join_request(first, "first refresh").await;
    let (second_status, second_raw) = join_request(second, "second refresh").await;
    let mut statuses = [first_status, second_status];
    statuses.sort_unstable();
    assert_eq!(
        statuses,
        [200, 401],
        "exactly one concurrent presentation may rotate"
    );
    let (winner_raw, loser_raw) = if first_status == 200 {
        (first_raw, second_raw)
    } else {
        (second_raw, first_raw)
    };
    assert!(
        loser_raw.contains("refresh token already used or revoked"),
        "the loser is the single-use 401"
    );

    let rotated: Value = serde_json::from_str(&winner_raw).expect("winning refresh body");
    let new_access = rotated["accessToken"]
        .as_str()
        .expect("rotated access")
        .to_string();
    let new_refresh = rotated["refreshToken"]
        .as_str()
        .expect("rotated refresh")
        .to_string();
    assert_eq!(
        live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        2,
        "one live pair survives, not two"
    );
    assert_eq!(
        device_binding(&fx.su, fx.device_id).await,
        (
            token_id_of(&fx.su, &new_access).await,
            token_id_of(&fx.su, &new_refresh).await
        ),
        "the binding names the winner's pair"
    );
    assert_status(
        channels_status(&fx.http, &fx.base, fx.workspace, &new_access).await,
        200,
    );
}

/// Acceptance 4, mid-flight failure: the binding this rotation was admitted on
/// is gone by the time it holds the lock. The whole rotation must be refused
/// with nothing half-written — no minted tokens, and the presented refresh not
/// consumed.
///
/// Scope, stated so the assertion is not read as more than it is: the refusal
/// trips at the post-lock binding re-check, which runs *before* `revoke_token`,
/// so "the presented refresh was not consumed" holds because nothing was
/// written at all. The deeper `rebind → false → Err → tx rollback` branch is
/// defensive: while this transaction holds `FOR UPDATE` on the row, no other
/// writer can move the binding out from under the re-check, so that branch is
/// unreachable by external injection and is NOT what this test measures.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn rotation_on_a_changed_binding_writes_nothing() {
    let _lock = test_lock().await;
    let fx = linked_device_fixture("ld-rb", "Phone Rebind").await;
    let (old_access_id, _old_refresh_id) = device_binding(&fx.su, fx.device_id).await;
    let live_before = live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await;
    let recorded_before = recorded_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await;

    let mut barrier = begin_device_barrier(&fx.su, fx.device_id).await;
    let refresh_call = spawn_refresh(&fx.http, &fx.base, &fx.phone.refresh);
    await_device_lock_waiters(&fx.su, &barrier, 1).await;
    // The rotation already resolved this device from the presented refresh.
    // Move the binding under the lock it is waiting for.
    let desktop_refresh_id = token_id_of(&fx.su, &fx.desktop.refresh).await;
    barrier
        .rebind_refresh(fx.device_id, desktop_refresh_id)
        .await;
    barrier.release().await;

    let (refresh_status, refresh_raw) = join_request(refresh_call, "linked refresh").await;
    assert_status(refresh_status, 401);
    assert!(
        refresh_raw.contains("refresh token already used or revoked"),
        "a moved binding refuses the rotation"
    );
    assert_eq!(
        recorded_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        recorded_before,
        "the refused rotation left no minted token row behind"
    );
    assert_eq!(
        live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        live_before,
        "the refused rotation changed no live token count"
    );
    assert!(
        !token_is_revoked(&fx.su, &fx.phone.refresh).await,
        "the refused rotation did not consume the presented refresh"
    );
    assert_eq!(
        device_binding(&fx.su, fx.device_id).await,
        (old_access_id, desktop_refresh_id),
        "only the barrier's write survives"
    );
}

// ---------------------------------------------------------------------------
// #2498 R3 / H1 — refresh and logout take `token` row locks in ONE direction
// ---------------------------------------------------------------------------
//
// Independent review C raised a deadlock pair: the linked refresh holds both
// session rows (`ORDER BY id FOR UPDATE`) until commit, while `logout` UPDATEs
// access-then-refresh, so a pair with `refresh_id < access_id` would build a
// cycle (40P01 → 500).
//
// Measured premise (asserted below, not assumed): `token.id` is
// `uuid DEFAULT uuidv7()` (`001_init.sql:335`) and every mint INSERTs the
// access half before the refresh half, so `access_id < refresh_id` for every
// pair this server can create — `ORDER BY id` and "access then refresh" are the
// same direction and the cycle cannot form on this schema. The repair (logout
// takes `lock_member_session_tokens_by_ids` before its two `revoke_token`
// UPDATEs) therefore turns an accident of the id generator into an invariant of
// the code; it is hardening, not a live-bug fix.
//
// What this test can and cannot prove, stated so the assertions are not read as
// more than they are:
//   * it CAN prove logout parks on the id-ordered row lock rather than on its
//     own revoke UPDATE, and that both race orders answer without a deadlock;
//   * it CANNOT produce a 40P01 by deleting the lock call, because the premise
//     above removes the cycle. No fixture can reverse the ids without rewriting
//     `token.id` primary keys into a state production cannot reach.
//
// RED (sabotage): delete the `lock_member_session_tokens_by_ids` call from
// `logout` (`auth_routes.rs`). The logout backend then parks on
// `UPDATE token … SET revoked_at …` instead of `… FROM token … FOR UPDATE`, and
// the blocked-statement assertion in the "logout first" run fails.

/// Backends blocked on a `token` row lock right now, newest statement last.
/// `usename` keeps this to the API role, so the barrier's own superuser
/// connection and this poller are never counted. `FROM token` / `UPDATE token`
/// exclude the `device_link_token` waits the other tests in this file measure.
const TOKEN_LOCK_WAITERS_SQL: &str = "SELECT query \
      FROM pg_stat_activity \
     WHERE datname = current_database() \
       AND pid <> $1 \
       AND pid <> pg_backend_pid() \
       AND usename = 'momo_app' \
       AND state = 'active' \
       AND wait_event_type = 'Lock' \
       AND (query LIKE '%FROM token%' OR query LIKE '%UPDATE token%') \
     ORDER BY query_start";

/// A superuser transaction parked on one `token` row.
struct SessionRowBarrier {
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    pid: i32,
}

impl SessionRowBarrier {
    async fn release(self) {
        self.tx.commit().await.expect("release the token barrier");
    }
}

async fn begin_session_token_barrier(su: &PgPool, token_id: Uuid) -> SessionRowBarrier {
    let mut tx = su
        .begin()
        .await
        .expect("open the token barrier transaction");
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .expect("barrier backend pid");
    let locked: Uuid = sqlx::query_scalar("SELECT id FROM token WHERE id = $1 FOR UPDATE")
        .bind(token_id)
        .fetch_one(&mut *tx)
        .await
        .expect("barrier takes FOR UPDATE on the session row");
    assert_eq!(locked, token_id, "barrier locked the requested token row");
    SessionRowBarrier { tx, pid }
}

/// Block until exactly `expected` API backends are parked on a `token` row
/// lock, then hand back the statements they are parked on.
async fn await_token_lock_waiters(
    su: &PgPool,
    barrier: &SessionRowBarrier,
    expected: usize,
) -> Vec<String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut blocked: Vec<String> = Vec::new();
    while std::time::Instant::now() < deadline {
        blocked = sqlx::query_scalar::<_, String>(TOKEN_LOCK_WAITERS_SQL)
            .bind(barrier.pid)
            .fetch_all(su)
            .await
            .expect("read pg_stat_activity");
        if blocked.len() >= expected {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        blocked.len(),
        expected,
        "expected {expected} API request(s) blocked on a token row lock \
         (wait_event_type='Lock'), saw {}: without that wait nothing orders a \
         linked-device refresh against a logout",
        blocked.len()
    );
    blocked
}

/// This database's cumulative deadlock counter — the mechanical stand-in for
/// "no 40P01 was raised", read instead of grepping server stdout.
async fn deadlock_count(su: &PgPool) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
    )
    .fetch_one(su)
    .await
    .expect("read pg_stat_database.deadlocks")
}

fn spawn_logout(
    http: &reqwest::Client,
    base: &str,
    access: &str,
    refresh: &str,
) -> tokio::task::JoinHandle<(u16, String)> {
    let http = http.clone();
    let url = format!("{base}/v1/auth/logout");
    let bearer = format!("Bearer {access}");
    let body = json!({ "refreshToken": refresh });
    tokio::spawn(async move {
        let response = http
            .post(url)
            .header("authorization", bearer)
            .json(&body)
            .send()
            .await
            .expect("logout");
        let status = response.status().as_u16();
        let raw = response.text().await.unwrap_or_default();
        (status, raw)
    })
}

/// The id order every pair this server mints actually has. Asserted (not
/// assumed) because it is the whole reason the pre-repair lock orders agreed.
async fn assert_access_is_the_lower_id(su: &PgPool, device_id: Uuid) -> (Uuid, Uuid) {
    let (access_id, refresh_id) = device_binding(su, device_id).await;
    assert!(
        access_id < refresh_id,
        "token.id is uuidv7() and the access half is INSERTed first, so the \
         id-ordered lock and logout's access-then-refresh order are the same \
         direction; if this ever flips, the H1 deadlock pair becomes reachable \
         and this file's premise must be re-derived"
    );
    (access_id, refresh_id)
}

/// #2498 R3 / H1: a linked refresh and a logout of the same device, raced in
/// both orders on the row they both need. Neither answers 500, the database
/// records no deadlock, and the surviving token state is the one the winner
/// implies.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn refresh_and_logout_race_never_deadlocks() {
    let _lock = test_lock().await;

    // --- Run A: the refresh queues first -----------------------------------
    let fx = linked_device_fixture("ld-lo1", "Phone Logout Race A").await;
    let (access_id, _refresh_id) = assert_access_is_the_lower_id(&fx.su, fx.device_id).await;
    let deadlocks_before = deadlock_count(&fx.su).await;

    let barrier = begin_session_token_barrier(&fx.su, access_id).await;
    let refresh_call = spawn_refresh(&fx.http, &fx.base, &fx.phone.refresh);
    await_token_lock_waiters(&fx.su, &barrier, 1).await;
    let logout_call = spawn_logout(&fx.http, &fx.base, &fx.phone.access, &fx.phone.refresh);
    await_token_lock_waiters(&fx.su, &barrier, 2).await;
    barrier.release().await;

    let (refresh_status, refresh_raw) = join_request(refresh_call, "linked refresh").await;
    let (logout_status, logout_raw) = join_request(logout_call, "logout").await;
    assert_status(refresh_status, 200);
    assert_status(logout_status, 200);
    let rotated: Value = serde_json::from_str(&refresh_raw).expect("refresh body is JSON");
    let new_access = rotated["accessToken"]
        .as_str()
        .expect("rotated access")
        .to_string();
    let logged_out: Value = serde_json::from_str(&logout_raw).expect("logout body is JSON");
    assert_eq!(
        logged_out["alreadyRevoked"], true,
        "the logout that lost the race found both halves already rotated away"
    );
    assert_eq!(
        live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        2,
        "refresh first: the rotated pair is what survives"
    );
    assert_status(
        channels_status(&fx.http, &fx.base, fx.workspace, &new_access).await,
        200,
    );
    assert_eq!(
        deadlock_count(&fx.su).await,
        deadlocks_before,
        "the raced pair must not raise 40P01 (a deadlock is a 500 to one caller)"
    );

    // --- Run B: the logout queues first ------------------------------------
    let fx = linked_device_fixture("ld-lo2", "Phone Logout Race B").await;
    let (access_id, _refresh_id) = assert_access_is_the_lower_id(&fx.su, fx.device_id).await;
    let deadlocks_before = deadlock_count(&fx.su).await;

    let barrier = begin_session_token_barrier(&fx.su, access_id).await;
    let logout_call = spawn_logout(&fx.http, &fx.base, &fx.phone.access, &fx.phone.refresh);
    let blocked = await_token_lock_waiters(&fx.su, &barrier, 1).await;
    // SABOTAGE anchor: with the lock call removed, logout parks on its own
    // `UPDATE token … SET revoked_at …` instead, and this pair of assertions
    // goes RED. It is the only statement-level evidence that logout serialises
    // on the same ordered lock the linked refresh uses.
    assert!(
        blocked[0].contains("FOR UPDATE"),
        "logout must park on the id-ordered session-row lock before revoking"
    );
    assert!(
        !blocked[0].contains("SET revoked_at"),
        "logout must not reach its revoke UPDATE before taking the ordered lock"
    );
    let refresh_call = spawn_refresh(&fx.http, &fx.base, &fx.phone.refresh);
    await_token_lock_waiters(&fx.su, &barrier, 2).await;
    barrier.release().await;

    let (logout_status, logout_raw) = join_request(logout_call, "logout").await;
    let (refresh_status, refresh_raw) = join_request(refresh_call, "linked refresh").await;
    assert_status(logout_status, 200);
    assert_status(refresh_status, 401);
    let logged_out: Value = serde_json::from_str(&logout_raw).expect("logout body is JSON");
    assert_eq!(
        logged_out["revokedAccess"], true,
        "logout killed the access"
    );
    assert_eq!(
        logged_out["revokedRefresh"], true,
        "logout killed the refresh"
    );
    assert!(
        refresh_raw.contains("refresh token already used or revoked"),
        "the rotation queued behind a logout is the single-use 401"
    );
    assert_eq!(
        live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await,
        0,
        "logout first: nothing survives on the logged-out device"
    );
    assert_eq!(
        deadlock_count(&fx.su).await,
        deadlocks_before,
        "the raced pair must not raise 40P01 (a deadlock is a 500 to one caller)"
    );
}

/// #2498 R3 / M2: the runtime counterpart of the `Err → tx rollback` branch.
///
/// This is the GREEN half and it is deliberately ordinary: an uncontended
/// linked refresh commits the whole rotation — two new `token` rows, the
/// presented refresh consumed, the binding moved. The RED half cannot be
/// reached from outside the process (nothing but an injected failure can make
/// the closure return `Err` after the INSERTs), so it is run in a scratch
/// worktree with `return Err(DbError::Sqlx(Protocol("injected")))` planted
/// after the second `record_session_token_with_device`; the injected run must
/// answer 500 with every number on the line below unchanged. Both runs' raw
/// lines are recorded in STATUS and on the PR — the injection is never
/// committed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn refresh_mid_flight_failure_rolls_back_everything() {
    let _lock = test_lock().await;
    let fx = linked_device_fixture("ld-mf", "Phone Mid Flight").await;
    let binding_before = device_binding(&fx.su, fx.device_id).await;
    let recorded_before = recorded_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await;
    let live_before = live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await;

    let (status, raw) = refresh_once(&fx.http, &fx.base, &fx.phone.refresh).await;

    let recorded_after = recorded_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await;
    let live_after = live_device_tokens(&fx.su, fx.workspace, fx.member, &fx.label).await;
    let binding_after = device_binding(&fx.su, fx.device_id).await;
    let presented_consumed = token_is_revoked(&fx.su, &fx.phone.refresh).await;
    // The one line both runs are compared on. Never interpolates a secret.
    println!(
        "[#2498 M2] status={status} recorded={recorded_before}->{recorded_after} \
         live={live_before}->{live_after} presented_refresh_consumed={presented_consumed} \
         binding_moved={}",
        binding_after != binding_before
    );

    assert_status(status, 200);
    assert!(
        raw.contains("accessToken") && raw.contains("refreshToken"),
        "the committed rotation answers with the new pair"
    );
    assert_eq!(
        recorded_after,
        recorded_before + 2,
        "the committed rotation recorded exactly the new pair"
    );
    assert_eq!(
        live_after, 2,
        "one live pair on the device after the commit"
    );
    assert!(
        presented_consumed,
        "the committed rotation consumed the presented refresh"
    );
    assert_ne!(
        binding_after, binding_before,
        "the committed rotation moved the binding onto the new pair"
    );
}
