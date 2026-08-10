//! Workspace avatar conformance (ADR-0161 D5) — the three avatar Drive routes,
//! driven over real HTTP against real Postgres.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test workspace_avatar_pg -- --ignored --nocapture
//! ```
//!
//! The red proof this file exists for: **avatar scope isolation.** An avatar
//! lives in exactly one tenant, and the whole isolation is one RLS policy on
//! `workspace_avatar_media` (migration 067). The test proves it two ways: over
//! HTTP a member of workspace B cannot read workspace A's avatar, and directly at
//! the GUC a `momo_app` (NOBYPASSRLS) connection bound to B sees zero of A's
//! media rows while the same connection bound to A sees the one.
//!
//! It also pins the two D5 authorization asymmetries: **any** active member of a
//! workspace may read its avatar (wider than a channel), but only an owner/admin
//! may set it. No real Drive is touched — the archive is `momo_drive`'s stub,
//! same as `attachment_conformance_pg.rs`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_drive::{DriveArchive, StubDriveArchive};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "workspace-avatar-conformance-secret";
const TEST_PASSWORD: &str = "workspace-avatar-password";

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
    let archive: Arc<dyn DriveArchive> = Arc::new(StubDriveArchive::new(&base));
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive);
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

struct Person {
    email: String,
}

async fn seed_person(su: &PgPool, workspace: Uuid, role: &str) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@avatar.test");
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
    sqlx::query("INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, $3::membership_role)")
        .bind(workspace)
        .bind(member)
        .bind(role)
        .execute(su)
        .await
        .expect("seed workspace_membership");
    Person { email }
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
    body["accessToken"].as_str().expect("accessToken").to_string()
}

fn uploads_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/avatar/uploads")
}

fn content_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/avatar/content")
}

/// Upload session → stub PUT → complete, returning the media id.
async fn upload_avatar(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    mime: &str,
    bytes: &[u8],
) -> String {
    let created = http
        .post(uploads_url(base, workspace))
        .bearer_auth(token)
        .json(&json!({"name": "logo.png", "mime": mime, "size": bytes.len()}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(created.status(), 201, "a created session answers 201");
    let created: Value = created.json().await.expect("upload body");
    let id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"].as_str().expect("uploadUrl").to_string();

    let uploaded = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, mime)
        .body(bytes.to_vec())
        .send()
        .await
        .expect("stub upload");
    assert_eq!(uploaded.status(), 200, "the bytes go straight to the archive");

    let completed = http
        .post(format!("{base}/v1/workspaces/{workspace}/avatar/{id}/complete"))
        .bearer_auth(token)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200, "a verified upload completes");
    let completed: Value = completed.json().await.expect("complete body");
    assert_eq!(completed["status"], json!("complete"));
    id
}

/// Count avatar media rows visible under a given tenant GUC on a NOBYPASSRLS
/// connection — the direct measurement of the `ws_isolation` policy.
async fn avatar_rows_visible_as_tenant(app: &PgPool, tenant: Uuid) -> i64 {
    let mut tx = app.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await
        .expect("bind GUC");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_avatar_media")
        .fetch_one(&mut *tx)
        .await
        .expect("count");
    tx.rollback().await.expect("rollback");
    count
}

/// Scope isolation, the D5 read/write asymmetries, and the round trip in one pass.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn avatar_is_scoped_to_its_workspace() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();

    let workspace_a = seed_workspace(&su).await;
    let owner_a = seed_person(&su, workspace_a, "owner").await;
    let member_a = seed_person(&su, workspace_a, "member").await;
    let workspace_b = seed_workspace(&su).await;
    let member_b = seed_person(&su, workspace_b, "owner").await;

    let bytes = b"\x89PNG\r\n\x1a\n-not-really-but-the-stub-does-not-care";

    // Owner of A sets the avatar.
    let owner_token = login(&http, &base, workspace_a, &owner_a).await;
    upload_avatar(&http, &base, &owner_token, workspace_a, "image/png", bytes).await;

    // WIDER READ SCOPE (D5): any active member of A may read it, owner or not.
    let member_token = login(&http, &base, workspace_a, &member_a).await;
    let read = http
        .get(content_url(&base, workspace_a))
        .bearer_auth(&member_token)
        .send()
        .await
        .expect("member reads avatar");
    assert_eq!(read.status(), 200, "a plain member may read the avatar");
    assert_eq!(
        read.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("image/png"),
        "served with the stored image mime"
    );
    // Cacheable-immutable, not no-store (the URL is versioned).
    let cache = read
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(cache.contains("immutable"), "cache-control was {cache:?}");
    assert_eq!(read.bytes().await.expect("bytes").as_ref(), bytes);

    // SCOPE ISOLATION over HTTP: a member of B is bound to B, so addressing A's
    // avatar is a scope mismatch — B can never reach A's bytes.
    let b_token = login(&http, &base, workspace_b, &member_b).await;
    let cross = http
        .get(content_url(&base, workspace_a))
        .bearer_auth(&b_token)
        .send()
        .await
        .expect("cross-tenant read");
    assert_eq!(
        cross.status(),
        403,
        "a member of B cannot address A's avatar (scope mismatch)"
    );

    // SET GATE (D5): a non-owner member of A cannot upload an avatar.
    let refused = http
        .post(uploads_url(&base, workspace_a))
        .bearer_auth(&member_token)
        .json(&json!({"name": "x.png", "mime": "image/png", "size": bytes.len()}))
        .send()
        .await
        .expect("member upload attempt");
    assert_eq!(
        refused.status(),
        403,
        "only an owner/admin may set the workspace avatar"
    );

    // SCOPE ISOLATION at the GUC — the RLS policy itself. A's one media row is
    // visible under A's tenant and invisible under B's, on the same NOBYPASSRLS
    // connection production uses.
    assert_eq!(
        avatar_rows_visible_as_tenant(&app, workspace_a).await,
        1,
        "A's own tenant sees its avatar media"
    );
    assert_eq!(
        avatar_rows_visible_as_tenant(&app, workspace_b).await,
        0,
        "B's tenant sees none of A's avatar media (ws_isolation, migration 067)"
    );
}
