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
