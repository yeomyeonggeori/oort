//! #4497 / ADR-0206 D4 - the activity heartbeat `PUT .../presence/activity` against a real Postgres.
//!
//! 1. a person's beat answers 204 and stamps `member_activity.seen_at` for the *bearer* only: a
//!    smuggled `memberId` in a body is never read
//! 2. a beat younger than the refresh floor does not rewrite the row; an older one does
//! 3. a path naming another workspace is 403 and writes nothing (to either workspace)
//! 4. an agent bearer (a real one, carrying every scope) is refused for the route and writes nothing
//! 5. nothing reads the stamp: `GET` on the path is not served
//! 6. the new tenant table is RLS-bound: another tenant cannot read it, and a row for another
//!    workspace cannot be written under this tenant's GUC (`momo_app` is NOBYPASSRLS)
//!
//! `#[ignore]` - needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26971/w4497 \
//!   cargo test -p momo-server --test presence_activity_conformance_pg -- --ignored --test-threads=1
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "presence-activity-signing-secret";
const TEST_PASSWORD: &str = "presence-activity-test-password";

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
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
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
    let email = format!("{id}@activity.test");
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

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'activity-agent', $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("agent-{}", &id.simple().to_string()[..8]))
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, \
            owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    id
}

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid, scopes: &[&str]) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), $4::text[], \
                 'presence-activity-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .bind(&scopes)
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
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

fn activity_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/presence/activity")
}

/// `(member, age in seconds)` of every stamp in `workspace`.
async fn stamps(su: &PgPool, workspace: Uuid) -> Vec<(Uuid, f64)> {
    sqlx::query_as(
        "SELECT member_id, extract(epoch FROM (now() - seen_at))::float8 \
           FROM member_activity WHERE workspace_id = $1 ORDER BY member_id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read activity rows")
}

struct World {
    su: PgPool,
    app: PgPool,
    http: reqwest::Client,
    base: String,
}

impl World {
    async fn new() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let base = start_server(app.clone()).await;
        World {
            su,
            app,
            http: reqwest::Client::new(),
            base,
        }
    }
}

/// A beat stamps the bearer's own row and nobody else's, even when the request tries to name
/// someone; a second beat inside the five-second floor leaves the stored time alone, and an older
/// stamp is moved to now.
///
/// Sabotage: read a member id from the request (the smuggled id gets the row); drop the
/// `WHERE seen_at < now() - 5s` floor (the second beat rewrites the row); drop `seen_at = now()`
/// from the `DO UPDATE` (the old stamp never moves).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_beat_stamps_the_bearer_only_and_respects_the_refresh_floor() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = seed_workspace(&w.su, "activity").await;
    let me = seed_human(&w.su, ws, "me-activity").await;
    let other = seed_human(&w.su, ws, "other-activity").await;
    let token = login(&w.http, &w.base, ws, &me.email).await;

    let response = w
        .http
        .put(activity_url(&w.base, ws))
        .bearer_auth(&token)
        .json(&json!({"memberId": other.id.to_string(), "member_id": other.id.to_string()}))
        .send()
        .await
        .expect("beat");
    assert_eq!(response.status(), 204, "a person's beat is 204");
    let rows = stamps(&w.su, ws).await;
    assert_eq!(rows.len(), 1, "one row: {rows:?}");
    assert_eq!(rows[0].0, me.id, "the bearer's row, not the id in the body");
    assert!(rows[0].1 < 5.0, "stamped now: {rows:?}");

    // An old stamp, then a beat: the stamp moves to now.
    sqlx::query(
        "UPDATE member_activity SET seen_at = now() - interval '10 seconds' \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(ws)
    .bind(me.id)
    .execute(&w.su)
    .await
    .expect("age the stamp");
    let beat = w
        .http
        .put(activity_url(&w.base, ws))
        .bearer_auth(&token)
        .send()
        .await
        .expect("second beat");
    assert_eq!(beat.status(), 204);
    let moved = stamps(&w.su, ws).await;
    assert!(
        moved[0].1 < 5.0,
        "a beat past the floor moves the stamp: {moved:?}"
    );

    // A stamp 2 s old is inside the 5 s floor: the beat is accepted and the row is not rewritten.
    sqlx::query(
        "UPDATE member_activity SET seen_at = now() - interval '2 seconds' \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(ws)
    .bind(me.id)
    .execute(&w.su)
    .await
    .expect("set a fresh stamp");
    let before = stamps(&w.su, ws).await[0].1;
    let again = w
        .http
        .put(activity_url(&w.base, ws))
        .bearer_auth(&token)
        .send()
        .await
        .expect("beat inside the floor");
    assert_eq!(again.status(), 204, "still accepted");
    let after = stamps(&w.su, ws).await[0].1;
    assert!(
        after >= before,
        "inside the floor the stored time is left alone (age {before} -> {after})"
    );
    assert!(after >= 1.5, "and it was not reset to now: {after}");

    assert!(
        stamps(&w.su, ws)
            .await
            .iter()
            .all(|(member, _)| *member == me.id),
        "the other person was never stamped"
    );
}

/// A path that names another workspace is refused and nothing is written in either workspace.
///
/// Sabotage: delete `workspace_scope(..)` from the handler (the stamp lands in the path's tenant).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_path_naming_another_workspace_is_403_and_writes_nothing() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let mine = seed_workspace(&w.su, "activity-mine").await;
    let theirs = seed_workspace(&w.su, "activity-theirs").await;
    let me = seed_human(&w.su, mine, "me-scope").await;
    let token = login(&w.http, &w.base, mine, &me.email).await;

    let response = w
        .http
        .put(activity_url(&w.base, theirs))
        .bearer_auth(&token)
        .send()
        .await
        .expect("beat into another workspace");
    assert_eq!(response.status(), 403);
    assert!(
        stamps(&w.su, theirs).await.is_empty(),
        "nothing in their workspace"
    );
    assert!(stamps(&w.su, mine).await.is_empty(), "and nothing in mine");
}

/// A real agent bearer carrying every scope the table names is refused for the route (the generic
/// 403 of the agent table), and so is an unknown one; no stamp is written for the agent.
///
/// Sabotage: add `.../presence/activity` to `required_agent_scope` (the gate answers 204 or reaches
/// the handler's own refusal instead of the table's).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_bearer_is_refused_for_the_route_and_writes_nothing() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = seed_workspace(&w.su, "activity-agent").await;
    let owner = seed_human(&w.su, ws, "owner-activity").await;
    let agent = seed_agent(&w.su, ws, owner.id).await;
    let every_scope = [
        "messages:write",
        "messages:read",
        "agent:jobs:read",
        "agent:runs:callback",
        "work:control",
    ];
    let bearer = agent_bearer(&w.su, ws, agent, &every_scope).await;

    let response = w
        .http
        .put(activity_url(&w.base, ws))
        .bearer_auth(&bearer)
        .send()
        .await
        .expect("agent beat");
    assert_eq!(
        response.status(),
        403,
        "an agent has no desktop to be active on"
    );
    let body: Value = response.json().await.unwrap_or(Value::Null);
    assert_eq!(
        body["error"]["message"].as_str().unwrap_or_default(),
        "agent bearer is not allowed for this route",
        "refused by the agent table, before the handler"
    );
    assert!(
        stamps(&w.su, ws).await.is_empty(),
        "a refused agent wrote nothing"
    );
}

/// Nothing serves the stamp back: `GET` on the path is 404 or 405 (the owner is the bearer and there
/// is no read API, so nobody can ask whether someone else is active).
///
/// Sabotage: add a `get(..)` handler on the path (the answer becomes 200).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn no_endpoint_reads_the_stamp() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = seed_workspace(&w.su, "activity-read").await;
    let me = seed_human(&w.su, ws, "me-read").await;
    let token = login(&w.http, &w.base, ws, &me.email).await;
    assert_eq!(
        w.http
            .put(activity_url(&w.base, ws))
            .bearer_auth(&token)
            .send()
            .await
            .expect("beat")
            .status(),
        204
    );
    let read = w
        .http
        .get(activity_url(&w.base, ws))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET");
    assert!(
        read.status() == 404 || read.status() == 405,
        "nothing reads the stamp, got {}",
        read.status()
    );
}

/// `member_activity` is a tenant table under RLS FORCE + `ws_isolation`: as `momo_app` (NOBYPASSRLS)
/// another tenant's row is invisible, and a row for another workspace cannot be written under this
/// tenant's GUC (the `WITH CHECK`). The superuser still sees the row, so the invisible read is RLS
/// and not an empty table.
///
/// Sabotage: drop `FORCE ROW LEVEL SECURITY` or the policy from migration 174 (the other tenant's
/// row is visible / writable).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_table_is_row_level_isolated_per_workspace() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let a = seed_workspace(&w.su, "activity-rls-a").await;
    let b = seed_workspace(&w.su, "activity-rls-b").await;
    let in_a = seed_human(&w.su, a, "rls-a").await;
    let in_b = seed_human(&w.su, b, "rls-b").await;
    sqlx::query("INSERT INTO member_activity (workspace_id, member_id) VALUES ($1, $2)")
        .bind(a)
        .bind(in_a.id)
        .execute(&w.su)
        .await
        .expect("seed a stamp in workspace A");

    // As momo_app with tenant B's GUC: A's row is invisible, B's own insert works, A's insert is refused.
    let mut tx = w.app.begin().await.expect("begin as momo_app");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(b.to_string())
        .execute(&mut *tx)
        .await
        .expect("bind tenant B");
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM member_activity")
        .fetch_one(&mut *tx)
        .await
        .expect("count as tenant B");
    assert_eq!(visible, 0, "tenant B cannot see tenant A's stamp");
    sqlx::query("INSERT INTO member_activity (workspace_id, member_id) VALUES ($1, $2)")
        .bind(b)
        .bind(in_b.id)
        .execute(&mut *tx)
        .await
        .expect("tenant B writes its own row");
    let refused =
        sqlx::query("INSERT INTO member_activity (workspace_id, member_id) VALUES ($1, $2)")
            .bind(a)
            .bind(in_a.id)
            .execute(&mut *tx)
            .await;
    match refused {
        Err(sqlx::Error::Database(error)) => assert_eq!(
            error.code().as_deref(),
            Some("42501"),
            "a row for another workspace violates the policy: {error}"
        ),
        other => panic!("tenant B must not write into workspace A: {other:?}"),
    }
    drop(tx);

    let seen_by_superuser = stamps(&w.su, a).await;
    assert_eq!(
        seen_by_superuser.len(),
        1,
        "the row exists: RLS hid it, not emptiness"
    );
}
