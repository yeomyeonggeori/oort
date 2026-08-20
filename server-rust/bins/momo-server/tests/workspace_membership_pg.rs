//! Workspace self-leave conformance (ADR-0161 D4) — `DELETE
//! /v1/workspaces/{ws}/members/me`, driven over real HTTP against real Postgres.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test workspace_membership_pg -- --ignored --nocapture
//! ```
//!
//! The red proof this file exists for: **the last owner cannot leave (409), and
//! the refusal writes nothing.** A workspace with no owner is unrecoverable, so
//! the guard is a hard precondition, not advice — and because the tenant-tx's
//! rejection channel commits, the check has to run before the first write. The
//! test asserts both halves: the 409, and that the would-be leaver's rows are
//! untouched afterward.
//!
//! Harness contract mirrors `attachment_conformance_pg.rs`: `DATABASE_URL` is a
//! superuser (migrations + fixture seeding), the server runs as `momo_app`
//! (NOBYPASSRLS), so every assertion passes through production RLS. No Drive is
//! touched (leave is pure DB), so the default `UnavailableDriveArchive` stands.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "workspace-membership-conformance-secret";
const TEST_PASSWORD: &str = "workspace-membership-password";

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
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let base = format!("http://{address}");
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

struct Person {
    member: Uuid,
    email: String,
}

async fn seed_person(su: &PgPool, workspace: Uuid, role: &str) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@leave.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    // The per-WORKSPACE authority row (ADR-0128). Its absence is what would make
    // active_workspace_role return None; its `role` is what the last-owner guard
    // reads.
    sqlx::query("INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, $3::membership_role)")
        .bind(workspace)
        .bind(member)
        .bind(role)
        .execute(su)
        .await
        .expect("seed workspace_membership");
    Person { member, email }
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, person: &Person) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": person.email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "seeded credentials log in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

fn leave_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/members/me")
}

async fn member_status(su: &PgPool, member: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM member WHERE id = $1")
        .bind(member)
        .fetch_one(su)
        .await
        .expect("read member status")
}

async fn workspace_membership_exists(su: &PgPool, workspace: Uuid, member: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2)",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("read workspace_membership")
}

/// The whole D4 contract: a non-owner leaves freely; an owner leaves only while
/// another owner remains; the last owner is refused with a 409 that writes
/// nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn self_leave_guards_the_last_owner() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su).await;
    let owner_one = seed_person(&su, workspace, "owner").await;
    let owner_two = seed_person(&su, workspace, "owner").await;
    let plain = seed_person(&su, workspace, "member").await;

    // (1) RED PROOF core — while owner_one is one of TWO owners, they may leave.
    let token = login(&http, &base, workspace, &owner_one).await;
    let left = http
        .delete(leave_url(&base, workspace))
        .bearer_auth(&token)
        .send()
        .await
        .expect("leave");
    assert_eq!(
        left.status(),
        200,
        "an owner leaves while another owner remains"
    );
    let body: Value = left.json().await.expect("leave body");
    assert_eq!(body["status"], json!("deleted"));
    assert_eq!(member_status(&su, owner_one.member).await, "deleted");
    assert!(
        !workspace_membership_exists(&su, workspace, owner_one.member).await,
        "the workspace-authority row is gone"
    );

    // (2) owner_two is now the ONLY owner: their self-leave is a 409, and the
    // refusal must write nothing.
    let token = login(&http, &base, workspace, &owner_two).await;
    let refused = http
        .delete(leave_url(&base, workspace))
        .bearer_auth(&token)
        .send()
        .await
        .expect("leave attempt");
    assert_eq!(
        refused.status(),
        409,
        "the last owner cannot leave (workspace must retain an owner)"
    );
    let refused_body: Value = refused.json().await.expect("409 body");
    assert_eq!(
        refused_body["error"]["message"],
        json!("workspace must retain at least one owner")
    );
    // Nothing was written: the check ran before the first mutation.
    assert_eq!(
        member_status(&su, owner_two.member).await,
        "active",
        "a refused leave leaves the member active"
    );
    assert!(
        workspace_membership_exists(&su, workspace, owner_two.member).await,
        "a refused leave leaves the authority row intact"
    );

    // (3) a plain member is never the last owner, so they leave freely even as
    // the last non-owner.
    let token = login(&http, &base, workspace, &plain).await;
    let left = http
        .delete(leave_url(&base, workspace))
        .bearer_auth(&token)
        .send()
        .await
        .expect("plain leave");
    assert_eq!(
        left.status(),
        200,
        "a non-owner leaves without an owner check"
    );
    assert_eq!(member_status(&su, plain.member).await, "deleted");
}
