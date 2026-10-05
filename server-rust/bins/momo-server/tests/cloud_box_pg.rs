//! #3500 — personal cloud box (ADR-0197 M1): schema, lifecycle table, REST contract
//! and the runner queue, on the real router against a `momo_app` (NOBYPASSRLS) pool.
//!
//! | test | proves | revert that makes it red |
//! |---|---|---|
//! | `the_database_lifecycle_table_equals_the_rust_table_for_all_49_pairs` | `cloud_box_transition_guard` accepts exactly the pairs `next_state` allows (14 distinct + the 7 same-state), and refuses every other with the lifecycle-table error | a pair added/removed in either table |
//! | `one_live_box_per_member_and_tombstones_do_not_block_a_new_one` | partial unique index; `delete_failed` keeps the slot; `deleted` frees it; initial state, limit ceilings, owner/workspace immutability, owner-is-human | the index predicate; `cloud_box_initial_state`; `cloud_box_limits_ck` |
//! | `neither_table_has_a_secret_column_or_a_free_payload` | exact column allow-list for both tables | any added column |
//! | `rls_is_forced_and_hides_other_workspaces` | FORCE flag + policy: another workspace's rows invisible, cross-workspace insert refused, no GUC = no rows | `FORCE ROW LEVEL SECURITY`; the policy |
//! | `owner_only_controls_and_admin_resource_controls` | create/start/keep-awake owner-only (admin 403, other member 404); admin may list/stop/delete; idempotent repeats write nothing; supersede; audit trail | the owner check in `standing`; the table |
//! | `the_workspace_cap_of_five_holds_under_concurrency` | 8 concurrent creates → exactly 5 succeed; a start past the cap is refused | the advisory lock / cap count |
//! | `a_closed_instance_exposes_nothing` | default `AppState` → every route 404, no rows | the default of `CloudBoxConfig` |
//! | `the_control_queue_is_closed_ordered_and_leased` | five verbs only, create-only limits, one in flight per box, claim/lease/complete, tenant-scoped | the verb CHECK; the shape CHECKs |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::{
    AgentGatewayMode, AgentGatewaySettings, AgentPortConfig, SettingsConfig,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "cloud-box-pg-signing-secret";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the isolated PG"))
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
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into()),
        ))
        .await
        .expect("connect as momo_app after bootstrap_roles.sql")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join("psql");
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema mutex");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .args([
            "-h",
            &required_pg_env("PGHOST"),
            "-p",
            &required_pg_env("PGPORT"),
            "-U",
            &required_pg_env("PGUSER"),
            "-d",
        ])
        .arg(required_pg_env("PGDATABASE"))
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

async fn insert_human(pool: &PgPool, workspace: Uuid, name: &str, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(name)
    .bind(format!("h-{}", id.simple()))
    .execute(pool)
    .await
    .expect("human member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("{id}@cb.test"))
    .execute(pool)
    .await
    .expect("human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::text::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(pool)
    .await
    .expect("human membership");
    let jwt = momo_auth::sign_access(id, workspace, &[], TEST_JWT_SECRET)
        .expect("sign")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'cb-conformance')",
    )
    .bind(workspace)
    .bind(id)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("session token");
    (id, jwt)
}

async fn call(
    client: &reqwest::Client,
    method: &str,
    url: String,
    jwt: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = match method {
        "GET" => client.get(url),
        _ => client.post(url),
    }
    .bearer_auth(jwt);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("request");
    let status = response.status().as_u16();
    let text = response.text().await.expect("body");
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, value)
}

use std::collections::BTreeSet;

use momo_settings::cloud_box::{
    apply_event_in_tx, claim_controls_in_tx, complete_control_in_tx, next_state, ApplyOutcome,
    BoxEvent, BoxState, ControlVerb,
};

struct World {
    workspace: Uuid,
    admin: Uuid,
    admin_jwt: String,
    m: Uuid,
    m_jwt: String,
    n: Uuid,
    n_jwt: String,
    guest_jwt: String,
}

async fn seed_world(pool: &PgPool) -> World {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("cb-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("workspace");
    let (admin, admin_jwt) = insert_human(pool, workspace, "관리자", "owner").await;
    let (m, m_jwt) = insert_human(pool, workspace, "엠", "member").await;
    let (n, n_jwt) = insert_human(pool, workspace, "엔", "member").await;
    let (_g, guest_jwt) = insert_human(pool, workspace, "게스트", "guest").await;
    World {
        workspace,
        admin,
        admin_jwt,
        m,
        m_jwt,
        n,
        n_jwt,
        guest_jwt,
    }
}

async fn start_server(pool: PgPool, enabled: Option<bool>) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: None,
        env_provider: momo_settings::ProviderConfig::default(),
        platform_admin_emails: vec![],
        environment: "local".to_string(),
    })
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "cloud-box-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        ..AgentPortConfig::default()
    });
    // `None` leaves the default untouched: that is the closed instance.
    if let Some(enabled) = enabled {
        state = state.with_cloud_box(momo_server::config::CloudBoxConfig { enabled });
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

fn boxes_url(base: &str, workspace: Uuid, tail: &str) -> String {
    format!("{base}/v1/workspaces/{workspace}/cloud-boxes{tail}")
}

fn error_code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or("")
}

/// What the runner would report, applied the way a tenant-scoped runner would.
async fn runner_event(
    app: &PgPool,
    workspace: Uuid,
    box_id: Uuid,
    event: BoxEvent,
) -> ApplyOutcome {
    momo_db::with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { apply_event_in_tx(conn, workspace, box_id, event, None, None).await })
    })
    .await
    .expect("runner event")
}

/// The runner takes every control and reports it done.
async fn drain_controls(app: &PgPool, workspace: Uuid) -> Vec<String> {
    momo_db::with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let controls = claim_controls_in_tx(conn, workspace, 50, 60).await?;
            let mut verbs = Vec::new();
            for control in controls {
                assert!(complete_control_in_tx(conn, workspace, control.id, true).await?);
                verbs.push(control.verb);
            }
            Ok(verbs)
        })
    })
    .await
    .expect("drain")
}

async fn box_state(su: &PgPool, id: &str) -> String {
    sqlx::query_scalar("SELECT state FROM cloud_box WHERE id = $1::uuid")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("box state")
}

async fn controls_of(su: &PgPool, id: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT verb, status FROM cloud_box_control WHERE box_id = $1::uuid ORDER BY seq",
    )
    .bind(id)
    .fetch_all(su)
    .await
    .expect("controls")
}

async fn audit_actions(su: &PgPool, id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_type = 'cloud_box' AND target_id = $1::uuid \
          ORDER BY created_at, id",
    )
    .bind(id)
    .fetch_all(su)
    .await
    .expect("audit")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// the lifecycle table, database side
// ---------------------------------------------------------------------------

fn state_columns(state: BoxState) -> &'static str {
    match state {
        BoxState::Creating => "state='creating', closed_reason=NULL, idle_since=NULL, stopped_at=NULL, deleted_at=NULL, keep_awake_until=NULL",
        BoxState::Running => "state='running', closed_reason=NULL, idle_since=NULL, stopped_at=NULL, deleted_at=NULL, keep_awake_until=NULL",
        BoxState::Idle => "state='idle', closed_reason=NULL, idle_since=now(), stopped_at=NULL, deleted_at=NULL, keep_awake_until=NULL",
        BoxState::Stopped => "state='stopped', closed_reason=NULL, idle_since=NULL, stopped_at=now(), deleted_at=NULL, keep_awake_until=NULL",
        BoxState::Deleting => "state='deleting', closed_reason='owner_delete', idle_since=NULL, stopped_at=NULL, deleted_at=NULL, keep_awake_until=NULL",
        BoxState::DeleteFailed => "state='delete_failed', closed_reason='owner_delete', idle_since=NULL, stopped_at=NULL, deleted_at=NULL, keep_awake_until=NULL",
        BoxState::Deleted => "state='deleted', closed_reason='owner_delete', idle_since=NULL, stopped_at=NULL, deleted_at=now(), keep_awake_until=NULL",
    }
}

fn rust_allows(from: BoxState, to: BoxState) -> bool {
    from == to
        || BoxEvent::ALL
            .into_iter()
            .any(|event| next_state(from, event) == Some(to))
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn the_database_lifecycle_table_equals_the_rust_table_for_all_49_pairs() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = seed_world(&su).await;

    let distinct: BTreeSet<(&str, &str)> = BoxState::ALL
        .into_iter()
        .flat_map(|from| {
            BoxState::ALL
                .into_iter()
                .filter(move |to| from != *to && rust_allows(from, *to))
                .map(move |to| (from.as_str(), to.as_str()))
        })
        .collect();
    assert_eq!(
        distinct.len(),
        14,
        "the lifecycle table has 14 distinct moves: {distinct:?}"
    );

    let mut checked = 0;
    for from in BoxState::ALL {
        for to in BoxState::ALL {
            let mut tx = su.begin().await.expect("tx");
            let id: Uuid = sqlx::query_scalar(
                "INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2) RETURNING id",
            )
            .bind(w.workspace)
            .bind(w.m)
            .fetch_one(&mut *tx)
            .await
            .expect("insert creating");
            // Park the row in `from` without going through the guard.
            sqlx::query("SET LOCAL session_replication_role = replica")
                .execute(&mut *tx)
                .await
                .expect("replica");
            sqlx::query(&format!(
                "UPDATE cloud_box SET {} WHERE id = $1",
                state_columns(from)
            ))
            .bind(id)
            .execute(&mut *tx)
            .await
            .expect("park");
            sqlx::query("SET LOCAL session_replication_role = origin")
                .execute(&mut *tx)
                .await
                .expect("origin");
            let moved = sqlx::query(&format!(
                "UPDATE cloud_box SET {} WHERE id = $1",
                state_columns(to)
            ))
            .bind(id)
            .execute(&mut *tx)
            .await;
            match (rust_allows(from, to), moved) {
                (true, Ok(_)) => {}
                (true, Err(error)) => {
                    panic!("{from:?} -> {to:?} is in the Rust table but the database refused it: {error}")
                }
                (false, Ok(_)) => {
                    panic!("{from:?} -> {to:?} is NOT in the Rust table but the database accepted it")
                }
                (false, Err(error)) => assert!(
                    error.to_string().contains("is not in the lifecycle table"),
                    "{from:?} -> {to:?} was refused by something other than the transition guard: {error}"
                ),
            }
            tx.rollback().await.expect("rollback");
            checked += 1;
        }
    }
    assert_eq!(checked, 49);
}

// ---------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------

async fn expect_db_error(result: Result<sqlx::postgres::PgQueryResult, sqlx::Error>, needle: &str) {
    let error = result.expect_err(&format!(
        "expected a database refusal containing {needle:?}"
    ));
    assert!(
        error.to_string().contains(needle),
        "expected {needle:?} in: {error}"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn one_live_box_per_member_and_tombstones_do_not_block_a_new_one() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = seed_world(&su).await;
    let insert = "INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2) RETURNING id";

    let first: Uuid = sqlx::query_scalar(insert)
        .bind(w.workspace)
        .bind(w.m)
        .fetch_one(&su)
        .await
        .expect("first box");
    // Same member, same workspace: the partial unique index says no.
    let second = sqlx::query(insert)
        .bind(w.workspace)
        .bind(w.m)
        .execute(&su)
        .await;
    expect_db_error(second, "cloud_box_member_live_uk").await;
    // Another member is unaffected.
    sqlx::query(insert)
        .bind(w.workspace)
        .bind(w.n)
        .execute(&su)
        .await
        .expect("another member's box");

    // delete_failed keeps the slot: the volume may still exist.
    for column_set in [
        "state='deleting', closed_reason='owner_delete'",
        "state='delete_failed'",
    ] {
        sqlx::query(&format!("UPDATE cloud_box SET {column_set} WHERE id = $1"))
            .bind(first)
            .execute(&su)
            .await
            .expect("walk to delete_failed");
    }
    expect_db_error(
        sqlx::query(insert)
            .bind(w.workspace)
            .bind(w.m)
            .execute(&su)
            .await,
        "cloud_box_member_live_uk",
    )
    .await;
    // deleted is a tombstone: it stays, and it frees the slot.
    for column_set in ["state='deleting'", "state='deleted', deleted_at=now()"] {
        sqlx::query(&format!("UPDATE cloud_box SET {column_set} WHERE id = $1"))
            .bind(first)
            .execute(&su)
            .await
            .expect("walk to deleted");
    }
    sqlx::query(insert)
        .bind(w.workspace)
        .bind(w.m)
        .execute(&su)
        .await
        .expect("a new box after the tombstone");
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM cloud_box WHERE member_id = $1")
        .bind(w.m)
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(rows, 2, "the tombstone row is kept");
    // The tombstone is terminal.
    expect_db_error(
        sqlx::query("UPDATE cloud_box SET state='running', deleted_at=NULL, closed_reason=NULL WHERE id = $1")
            .bind(first)
            .execute(&su)
            .await,
        "is not in the lifecycle table",
    )
    .await;

    // Initial state, ceilings, immutability, owner kind, RESTRICT.
    let k = insert_human(&su, w.workspace, "케이", "member").await.0;
    expect_db_error(
        sqlx::query(
            "INSERT INTO cloud_box (workspace_id, member_id, state) VALUES ($1, $2, 'running')",
        )
        .bind(w.workspace)
        .bind(k)
        .execute(&su)
        .await,
        "starts in creating",
    )
    .await;
    for (column, value) in [
        ("cpu_millis", 2000),
        ("memory_mb", 4096),
        ("disk_gb", 11),
        ("pids", 513),
        ("idle_minutes", 31),
        ("stopped_delete_days", 31),
        ("keep_awake_max_hours", 13),
    ] {
        expect_db_error(
            sqlx::query(&format!(
                "INSERT INTO cloud_box (workspace_id, member_id, {column}) VALUES ($1, $2, {value})"
            ))
            .bind(w.workspace)
            .bind(k)
            .execute(&su)
            .await,
            "cloud_box_limits_ck",
        )
        .await;
    }
    let live: Uuid =
        sqlx::query_scalar("SELECT id FROM cloud_box WHERE member_id = $1 AND state <> 'deleted'")
            .bind(w.m)
            .fetch_one(&su)
            .await
            .expect("live box");
    expect_db_error(
        sqlx::query("UPDATE cloud_box SET member_id = $2 WHERE id = $1")
            .bind(live)
            .bind(w.n)
            .execute(&su)
            .await,
        "cannot change",
    )
    .await;
    // Agents hold no boxes.
    let agent = Uuid::new_v4();
    sqlx::query("INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'agent','봇',$3)")
        .bind(agent)
        .bind(w.workspace)
        .bind(format!("bot-{}", agent.simple()))
        .execute(&su)
        .await
        .expect("agent member");
    expect_db_error(
        sqlx::query(insert)
            .bind(w.workspace)
            .bind(agent)
            .execute(&su)
            .await,
        "must be a human member",
    )
    .await;
    // The tombstone pins its owner: a member row with a box cannot be deleted.
    expect_db_error(
        sqlx::query("DELETE FROM member WHERE id = $1")
            .bind(w.m)
            .execute(&su)
            .await,
        "cloud_box_member_id_fkey",
    )
    .await;
    // Deleting a reason-less deletion or a reasoned live box is refused.
    expect_db_error(
        sqlx::query("UPDATE cloud_box SET closed_reason = 'owner_delete' WHERE id = $1")
            .bind(live)
            .execute(&su)
            .await,
        "cloud_box_closed_reason_state_ck",
    )
    .await;
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn neither_table_has_a_secret_column_or_a_free_payload() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    for (table, expected) in [
        (
            "cloud_box",
            vec![
                "closed_reason",
                "cpu_millis",
                "created_at",
                "deleted_at",
                "disk_gb",
                "id",
                "idle_minutes",
                "idle_since",
                "keep_awake_max_hours",
                "keep_awake_until",
                "last_attached_at",
                "member_id",
                "memory_mb",
                "pids",
                "state",
                "state_changed_at",
                "stopped_at",
                "stopped_delete_days",
                "updated_at",
                "workspace_id",
            ],
        ),
        (
            "cloud_box_control",
            vec![
                "attempts",
                "box_id",
                "claimed_at",
                "completed_at",
                "cpu_millis",
                "created_at",
                "disk_gb",
                "id",
                "lease_expires_at",
                "memory_mb",
                "pids",
                "requested_by",
                "result_code",
                "seq",
                "status",
                "verb",
                "workspace_id",
            ],
        ),
    ] {
        let columns: Vec<String> = sqlx::query_scalar(
            "SELECT column_name::text FROM information_schema.columns \
              WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
        )
        .bind(table)
        .fetch_all(&su)
        .await
        .expect("columns");
        assert_eq!(
            columns, expected,
            "{table}: a column was added or removed; ADR-0197 D10 keeps secrets, host keys, login state and free payloads off this table"
        );
        let udt: Vec<String> = sqlx::query_scalar(
            "SELECT udt_name::text FROM information_schema.columns \
              WHERE table_schema = 'public' AND table_name = $1 AND udt_name IN ('jsonb', 'json', 'bytea')",
        )
        .bind(table)
        .fetch_all(&su)
        .await
        .expect("types");
        assert!(
            udt.is_empty(),
            "{table} has a free-form column type: {udt:?}"
        );
    }
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn rls_is_forced_and_hides_other_workspaces() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let a = seed_world(&su).await;
    let b = seed_world(&su).await;
    let mut ids = Vec::new();
    for w in [&a, &b] {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(w.workspace)
        .bind(w.m)
        .fetch_one(&su)
        .await
        .expect("box");
        sqlx::query(
            "INSERT INTO cloud_box_control (workspace_id, box_id, verb, cpu_millis, memory_mb, disk_gb, pids) \
             VALUES ($1, $2, 'create', 1000, 2048, 10, 512)",
        )
        .bind(w.workspace)
        .bind(id)
        .execute(&su)
        .await
        .expect("control");
        ids.push(id);
    }
    for table in ["cloud_box", "cloud_box_control"] {
        let (enabled, forced): (bool, bool) = sqlx::query_as(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
        )
        .bind(table)
        .fetch_one(&su)
        .await
        .expect("flags");
        assert!(
            enabled && forced,
            "{table} must ENABLE and FORCE row level security"
        );
        let policies: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_policies WHERE tablename = $1 AND policyname = 'ws_isolation'",
        )
        .bind(table)
        .fetch_one(&su)
        .await
        .expect("policies");
        assert_eq!(policies, 1, "{table}: ws_isolation policy");
    }

    let app = momo_app_pool().await;
    // Returns the raw query result: only the no-GUC case below may tolerate an error.
    let table_rows = |table: &'static str, ws: Option<Uuid>, id: Uuid| {
        let app = app.clone();
        async move {
            let mut tx = app.begin().await.expect("tx");
            if let Some(ws) = ws {
                sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
                    .bind(ws.to_string())
                    .execute(&mut *tx)
                    .await
                    .expect("guc");
            }
            let column = if table == "cloud_box" { "id" } else { "box_id" };
            let count: Result<i64, sqlx::Error> =
                sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE {column} = $1"))
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await;
            tx.rollback().await.expect("rollback");
            count
        }
    };
    for table in ["cloud_box", "cloud_box_control"] {
        assert_eq!(
            table_rows(table, Some(a.workspace), ids[0])
                .await
                .expect("own rows"),
            1,
            "{table}: own rows"
        );
        assert_eq!(
            table_rows(table, Some(a.workspace), ids[1])
                .await
                .expect("foreign count"),
            0,
            "{table}: workspace A saw workspace B's row"
        );
        // No tenant GUC: never set on this connection (zero rows) or reset to '' by an earlier
        // transaction (the policy's uuid cast refuses). Anything else would be a leak.
        match table_rows(table, None, ids[0]).await {
            Ok(count) => assert_eq!(count, 0, "{table}: no tenant GUC must mean no rows"),
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("invalid input syntax for type uuid"),
                "{table}: unexpected error without a tenant GUC: {error}"
            ),
        }
    }
    // A write into another workspace is refused by the policy's WITH CHECK.
    let mut tx = app.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(a.workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    // The BEFORE INSERT owner trigger runs ahead of the policy's WITH CHECK and cannot see B's
    // member through RLS, so it is the refusal here; the policy itself is proved on the control table below.
    expect_db_error(
        sqlx::query("INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2)")
            .bind(b.workspace)
            .bind(b.n)
            .execute(&mut *tx)
            .await,
        "must be a human member of the workspace",
    )
    .await;
    tx.rollback().await.expect("rollback");
    // …and the policy's own WITH CHECK, on the table that has no insert trigger.
    let mut tx = app.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(a.workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    expect_db_error(
        sqlx::query(
            "INSERT INTO cloud_box_control (workspace_id, box_id, verb) VALUES ($1, $2, 'stop')",
        )
        .bind(b.workspace)
        .bind(ids[1])
        .execute(&mut *tx)
        .await,
        "row-level security",
    )
    .await;
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// REST contract
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn owner_only_controls_and_admin_resource_controls() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = seed_world(&su).await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone(), Some(true)).await;
    let client = reqwest::Client::new();
    let ws = w.workspace;

    // A guest cannot own a box; a member can, once.
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, ""),
        &w.guest_jwt,
        None,
    )
    .await;
    assert_eq!(status, 403, "a guest created a box");
    let (status, created) = call(&client, "POST", boxes_url(&base, ws, ""), &w.m_jwt, None).await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["state"], "creating");
    assert_eq!(created["memberId"], w.m.to_string());
    assert_eq!(
        created["limits"],
        json!({"cpuMillis":1000,"memoryMb":2048,"diskGb":10,"pids":512,"idleMinutes":30,"stoppedDeleteDays":30,"keepAwakeMaxHours":12})
    );
    let id = created["id"].as_str().expect("id").to_string();
    let box_uuid: Uuid = id.parse().expect("uuid");
    let (status, again) = call(&client, "POST", boxes_url(&base, ws, ""), &w.m_jwt, None).await;
    assert_eq!(status, 409);
    assert_eq!(error_code(&again), "cloud_box_already_exists");

    // `mine` is the caller's own; the owner filter is not a parameter.
    let (_, mine) = call(
        &client,
        "GET",
        boxes_url(&base, ws, "/mine"),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(mine["box"]["id"], id);
    let (_, theirs) = call(
        &client,
        "GET",
        boxes_url(&base, ws, "/mine"),
        &w.n_jwt,
        None,
    )
    .await;
    assert!(theirs["box"].is_null(), "{theirs}");

    // The create control is queued in the same transaction, with the closed payload.
    let create_control: (String, String, Option<i32>, Option<i32>, Option<i32>, Option<i32>) = sqlx::query_as(
        "SELECT verb, status, cpu_millis, memory_mb, disk_gb, pids FROM cloud_box_control WHERE box_id = $1",
    )
    .bind(box_uuid)
    .fetch_one(&su)
    .await
    .expect("create control");
    assert_eq!(
        create_control,
        (
            "create".into(),
            "pending".into(),
            Some(1000),
            Some(2048),
            Some(10),
            Some(512)
        )
    );

    // creating: nothing but delete is allowed.
    let (status, conflict) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/start")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(
        (status, error_code(&conflict)),
        (409, "cloud_box_state_conflict")
    );
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/stop")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 409);

    // The runner finishes creating.
    assert_eq!(drain_controls(&app, ws).await, vec!["create"]);
    assert!(matches!(
        runner_event(&app, ws, box_uuid, BoxEvent::RunnerReady).await,
        ApplyOutcome::Applied { .. }
    ));
    assert_eq!(box_state(&su, &id).await, "running");

    // --- owner-only controls: the admin is refused, a stranger learns nothing.
    let owner_only = [("start", "POST"), ("keep-awake", "POST")];
    for (verb, method) in owner_only {
        let body = (verb == "keep-awake").then(|| json!({"enabled": true}));
        let (status, refused) = call(
            &client,
            method,
            boxes_url(&base, ws, &format!("/{id}/{verb}")),
            &w.admin_jwt,
            body.clone(),
        )
        .await;
        assert_eq!(status, 403, "admin {verb}: {refused}");
        assert_eq!(error_code(&refused), "cloud_box_owner_only");
        let (status, _) = call(
            &client,
            method,
            boxes_url(&base, ws, &format!("/{id}/{verb}")),
            &w.n_jwt,
            body,
        )
        .await;
        assert_eq!(
            status, 404,
            "another member {verb} must look like a missing box"
        );
    }
    for verb in ["stop", "delete"] {
        let (status, _) = call(
            &client,
            "POST",
            boxes_url(&base, ws, &format!("/{id}/{verb}")),
            &w.n_jwt,
            None,
        )
        .await;
        assert_eq!(status, 404, "another member {verb}");
    }
    assert_eq!(
        box_state(&su, &id).await,
        "running",
        "a refused request changed the box"
    );
    let (status, _) = call(&client, "GET", boxes_url(&base, ws, ""), &w.n_jwt, None).await;
    assert_eq!(status, 403, "a member listed every box");
    let (status, listed) = call(&client, "GET", boxes_url(&base, ws, ""), &w.admin_jwt, None).await;
    assert_eq!(status, 200);
    assert_eq!(listed["boxes"].as_array().expect("boxes").len(), 1);
    assert_eq!(listed["boxes"][0]["memberId"], w.m.to_string());

    // --- keep awake: owner, up to 12 hours, only while on.
    let before = now_ms();
    let (status, kept) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/keep-awake")),
        &w.m_jwt,
        Some(json!({"enabled": true})),
    )
    .await;
    assert_eq!(status, 200, "{kept}");
    let until = kept["keepAwakeUntilMs"].as_i64().expect("deadline");
    let twelve_hours = 12 * 3600 * 1000;
    assert!(
        (until - before - twelve_hours).abs() < 120_000,
        "deadline is not ~12h out: {}",
        until - before
    );
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/keep-awake")),
        &w.m_jwt,
        Some(json!({"enabled": true, "hours": 13})),
    )
    .await;
    assert_eq!(status, 400, "13 hours is past the ceiling");
    let (status, cleared) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/keep-awake")),
        &w.m_jwt,
        Some(json!({"enabled": false})),
    )
    .await;
    assert_eq!(status, 200);
    assert!(cleared.get("keepAwakeUntilMs").is_none(), "{cleared}");
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/keep-awake")),
        &w.m_jwt,
        Some(json!({"enabled": true, "extra": 1})),
    )
    .await;
    assert!(
        status == 400 || status == 422,
        "unknown field accepted: {status}"
    );

    // --- the admin may stop (resource management)…
    let (status, stopped) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/stop")),
        &w.admin_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["state"], "stopped");
    // …and repeating it writes nothing.
    let controls_before = controls_of(&su, &id).await.len();
    let audits_before = audit_actions(&su, &id).await.len();
    let (status, repeat) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/stop")),
        &w.admin_jwt,
        None,
    )
    .await;
    assert_eq!((status, repeat["state"].as_str()), (200, Some("stopped")));
    assert_eq!(
        controls_of(&su, &id).await.len(),
        controls_before,
        "a repeat queued a second control"
    );
    assert_eq!(
        audit_actions(&su, &id).await.len(),
        audits_before,
        "a repeat wrote a second audit row"
    );
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/keep-awake")),
        &w.m_jwt,
        Some(json!({"enabled": true})),
    )
    .await;
    assert_eq!(status, 409, "keep-awake on a stopped box");

    // --- the owner starts it again; the stale `stop` the runner never took is superseded.
    let (status, started) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/start")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["state"], "running");
    assert_eq!(
        controls_of(&su, &id).await,
        vec![
            ("create".to_string(), "done".to_string()),
            ("stop".to_string(), "cancelled".to_string()),
            ("start".to_string(), "pending".to_string()),
        ]
    );
    let (status, same) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/start")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(
        (status, same["state"].as_str()),
        (200, Some("running")),
        "starting a running box is a no-op"
    );
    assert_eq!(drain_controls(&app, ws).await, vec!["start"]);

    // --- the owner deletes; the admin could too. A repeat is a no-op.
    let (status, deleting) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/delete")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "{deleting}");
    assert_eq!(deleting["state"], "deleting");
    assert_eq!(deleting["closedReason"], "owner_delete");
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/delete")),
        &w.admin_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "deleting what is being deleted is idempotent");
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/start")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 409, "start on a box being deleted");
    assert_eq!(drain_controls(&app, ws).await, vec!["delete"]);

    // The runner cannot delete (the volume is stuck), then can.
    assert!(matches!(
        runner_event(&app, ws, box_uuid, BoxEvent::RunnerDeleteFailed).await,
        ApplyOutcome::Applied { .. }
    ));
    let (status, mine) = call(
        &client,
        "GET",
        boxes_url(&base, ws, "/mine"),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(
        (status, mine["box"]["state"].as_str()),
        (200, Some("delete_failed"))
    );
    let (status, taken) = call(&client, "POST", boxes_url(&base, ws, ""), &w.m_jwt, None).await;
    assert_eq!(
        (status, error_code(&taken)),
        (409, "cloud_box_already_exists"),
        "delete_failed keeps the slot"
    );
    let (status, retried) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/delete")),
        &w.admin_jwt,
        None,
    )
    .await;
    assert_eq!(
        (status, retried["state"].as_str()),
        (200, Some("deleting")),
        "retry by the admin"
    );
    assert_eq!(drain_controls(&app, ws).await, vec!["delete"]);
    assert!(matches!(
        runner_event(&app, ws, box_uuid, BoxEvent::RunnerDeleted).await,
        ApplyOutcome::Applied { .. }
    ));
    let (_, mine) = call(
        &client,
        "GET",
        boxes_url(&base, ws, "/mine"),
        &w.m_jwt,
        None,
    )
    .await;
    assert!(mine["box"].is_null(), "a deleted box is not 'mine'");
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/start")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 404, "start on a tombstone");
    let (status, fresh) = call(&client, "POST", boxes_url(&base, ws, ""), &w.m_jwt, None).await;
    assert_eq!(
        status, 201,
        "the tombstone must not block a new box: {fresh}"
    );
    assert_ne!(fresh["id"], id.as_str());

    // --- the audit trail: every transition, who did it, nothing but ids and states.
    assert_eq!(
        audit_actions(&su, &id).await,
        vec![
            "cloud_box.created",
            "cloud_box.ready",
            "cloud_box.keep_awake_set",
            "cloud_box.keep_awake_cleared",
            "cloud_box.stopped",
            "cloud_box.started",
            "cloud_box.delete_requested",
            "cloud_box.delete_failed",
            "cloud_box.delete_retried",
            "cloud_box.deleted",
        ]
    );
    let details: Vec<(Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT actor_member_id, detail FROM audit_log WHERE target_id = $1 AND action LIKE 'cloud_box.%' ORDER BY created_at, id",
    )
    .bind(box_uuid)
    .fetch_all(&su)
    .await
    .expect("details");
    let expected_keys: BTreeSet<&str> = [
        "schema",
        "box_id",
        "owner_member_id",
        "from",
        "to",
        "actor_role",
        "reason",
    ]
    .into();
    for (_, detail) in &details {
        let keys: BTreeSet<&str> = detail
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, expected_keys, "audit detail grew a field: {detail}");
        assert_eq!(detail["schema"], "momo.cloud_box.audit.v1");
    }
    let by_action = |action: &str| {
        details
            .iter()
            .zip([
                "cloud_box.created",
                "cloud_box.ready",
                "cloud_box.keep_awake_set",
                "cloud_box.keep_awake_cleared",
                "cloud_box.stopped",
                "cloud_box.started",
                "cloud_box.delete_requested",
                "cloud_box.delete_failed",
                "cloud_box.delete_retried",
                "cloud_box.deleted",
            ])
            .find(|(_, name)| *name == action)
            .map(|((actor, detail), _)| {
                (
                    *actor,
                    detail["actor_role"].as_str().unwrap_or("").to_string(),
                )
            })
            .expect("audit row")
    };
    assert_eq!(
        by_action("cloud_box.stopped"),
        (Some(w.admin), "admin".to_string()),
        "the admin's stop is attributed to the admin"
    );
    assert_eq!(
        by_action("cloud_box.started"),
        (Some(w.m), "owner".to_string())
    );
    assert_eq!(
        by_action("cloud_box.ready"),
        (None, "runner".to_string()),
        "the runner has no member behind it"
    );
    assert_eq!(
        by_action("cloud_box.delete_retried"),
        (Some(w.admin), "admin".to_string())
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn the_workspace_cap_of_five_holds_under_concurrency() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = seed_world(&su).await;
    let mut jwts = Vec::new();
    for index in 0..8 {
        jwts.push(insert_human(&su, w.workspace, &format!("동시{index}"), "member").await);
    }
    let app = momo_app_pool().await;
    let base = start_server(app.clone(), Some(true)).await;
    let client = reqwest::Client::new();

    let mut handles = Vec::new();
    for (_, jwt) in &jwts {
        let (client, url, jwt) = (
            client.clone(),
            boxes_url(&base, w.workspace, ""),
            jwt.clone(),
        );
        handles.push(tokio::spawn(async move {
            call(&client, "POST", url, &jwt, None).await
        }));
    }
    let mut created = Vec::new();
    let mut refused = 0;
    for (index, handle) in handles.into_iter().enumerate() {
        let (status, body) = handle.await.expect("join");
        match status {
            201 => created.push((index, body["id"].as_str().expect("id").to_string())),
            409 => {
                assert_eq!(error_code(&body), "cloud_box_no_capacity", "{body}");
                refused += 1;
            }
            other => panic!("unexpected {other}: {body}"),
        }
    }
    assert_eq!(
        (created.len(), refused),
        (5, 3),
        "the cap of 5 was not held under concurrency"
    );

    // Free one slot by stopping a running box; a refused member can then create…
    let (first_index, first_id) = created[0].clone();
    let first_uuid: Uuid = first_id.parse().expect("uuid");
    runner_event(&app, w.workspace, first_uuid, BoxEvent::RunnerReady).await;
    drain_controls(&app, w.workspace).await;
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{first_id}/stop")),
        &jwts[first_index].1,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let created_indices: BTreeSet<usize> = created.iter().map(|(index, _)| *index).collect();
    let waiting = (0..8)
        .find(|index| !created_indices.contains(index))
        .expect("a refused member");
    let (status, body) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, ""),
        &jwts[waiting].1,
        None,
    )
    .await;
    assert_eq!(status, 201, "{body}");
    // …and then the stopped box cannot be started past the cap.
    let (status, body) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{first_id}/start")),
        &jwts[first_index].1,
        None,
    )
    .await;
    assert_eq!(
        (status, error_code(&body)),
        (409, "cloud_box_no_capacity"),
        "{body}"
    );
    assert_eq!(box_state(&su, &first_id).await, "stopped");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn a_closed_instance_exposes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = seed_world(&su).await;
    // A real, running box of a real owner: a closed instance must not act on it.
    let box_id: Uuid = sqlx::query_scalar(
        "INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(w.workspace)
    .bind(w.m)
    .fetch_one(&su)
    .await
    .expect("box");
    sqlx::query("UPDATE cloud_box SET state='running' WHERE id = $1")
        .bind(box_id)
        .execute(&su)
        .await
        .expect("running");
    // `None`: AppState's own default, not an explicit `enabled: false`.
    let base = start_server(momo_app_pool().await, None).await;
    let explicit_off = start_server(momo_app_pool().await, Some(false)).await;
    let client = reqwest::Client::new();
    for base in [&base, &explicit_off] {
        for (method, tail, body) in [
            ("POST", String::new(), None),
            ("GET", String::new(), None),
            ("GET", "/mine".to_string(), None),
            ("POST", format!("/{box_id}/start"), None),
            ("POST", format!("/{box_id}/stop"), None),
            ("POST", format!("/{box_id}/delete"), None),
            (
                "POST",
                format!("/{box_id}/keep-awake"),
                Some(json!({"enabled": true})),
            ),
        ] {
            // The owner, who would be allowed on an open instance, and the admin.
            for jwt in [&w.m_jwt, &w.admin_jwt] {
                let (status, _) = call(
                    &client,
                    method,
                    boxes_url(base, w.workspace, &tail),
                    jwt,
                    body.clone(),
                )
                .await;
                assert_eq!(status, 404, "{method} {tail} answered on a closed instance");
            }
        }
    }
    // Nothing happened: same state, no control, no audit row, no new box.
    assert_eq!(box_state(&su, &box_id.to_string()).await, "running");
    assert!(controls_of(&su, &box_id.to_string()).await.is_empty());
    assert!(audit_actions(&su, &box_id.to_string()).await.is_empty());
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM cloud_box WHERE workspace_id = $1")
        .bind(w.workspace)
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(rows, 1);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn a_member_demoted_to_guest_no_longer_controls_their_box() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = seed_world(&su).await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone(), Some(true)).await;
    let client = reqwest::Client::new();
    let ws = w.workspace;
    let (_, created) = call(&client, "POST", boxes_url(&base, ws, ""), &w.m_jwt, None).await;
    let id = created["id"].as_str().expect("id").to_string();
    let box_uuid: Uuid = id.parse().expect("uuid");
    runner_event(&app, ws, box_uuid, BoxEvent::RunnerReady).await;
    drain_controls(&app, ws).await;

    sqlx::query("UPDATE workspace_membership SET role = 'guest'::text::membership_role WHERE workspace_id = $1 AND member_id = $2")
        .bind(ws)
        .bind(w.m)
        .execute(&su)
        .await
        .expect("demote");
    for (verb, body) in [
        ("start", None),
        ("stop", None),
        ("delete", None),
        ("keep-awake", Some(json!({"enabled": true}))),
    ] {
        let (status, refused) = call(
            &client,
            "POST",
            boxes_url(&base, ws, &format!("/{id}/{verb}")),
            &w.m_jwt,
            body,
        )
        .await;
        assert_eq!(status, 403, "a guest owner {verb}: {refused}");
        assert_eq!(error_code(&refused), "cloud_box_guest");
    }
    let (status, _) = call(
        &client,
        "GET",
        boxes_url(&base, ws, "/mine"),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 403, "a guest read their box");
    assert_eq!(
        box_state(&su, &id).await,
        "running",
        "a refused guest changed the box"
    );
    // The admin still manages it.
    let (status, stopped) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/stop")),
        &w.admin_jwt,
        None,
    )
    .await;
    assert_eq!((status, stopped["state"].as_str()), (200, Some("stopped")));
    let (status, deleting) = call(
        &client,
        "POST",
        boxes_url(&base, ws, &format!("/{id}/delete")),
        &w.admin_jwt,
        None,
    )
    .await;
    assert_eq!(
        (status, deleting["state"].as_str()),
        (200, Some("deleting"))
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn runtime_roles_have_least_privilege_on_the_box_tables() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    for table in ["cloud_box", "cloud_box_control"] {
        for role in ["momo_relay", "momo_worker", "momo_notifier"] {
            for privilege in [
                "SELECT",
                "INSERT",
                "UPDATE",
                "DELETE",
                "TRUNCATE",
                "REFERENCES",
                "TRIGGER",
            ] {
                let has: bool = sqlx::query_scalar("SELECT has_table_privilege($1, $2, $3)")
                    .bind(role)
                    .bind(table)
                    .bind(privilege)
                    .fetch_one(&su)
                    .await
                    .expect("privilege");
                assert!(
                    !has,
                    "{role} has {privilege} on {table}: BYPASSRLS roles must not touch box rows"
                );
            }
        }
        for (privilege, want) in [
            ("SELECT", true),
            ("INSERT", true),
            ("UPDATE", true),
            ("DELETE", false),
            ("TRUNCATE", false),
            ("REFERENCES", false),
            ("TRIGGER", false),
        ] {
            let has: bool = sqlx::query_scalar("SELECT has_table_privilege('momo_app', $1, $2)")
                .bind(table)
                .bind(privilege)
                .fetch_one(&su)
                .await
                .expect("privilege");
            assert_eq!(has, want, "momo_app {privilege} on {table}");
        }
    }
    // The API role cannot delete, and the database refuses deletion of live rows even for the owner role.
    let w = seed_world(&su).await;
    let box_id: Uuid = sqlx::query_scalar(
        "INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(w.workspace)
    .bind(w.m)
    .fetch_one(&su)
    .await
    .expect("box");
    sqlx::query("INSERT INTO cloud_box_control (workspace_id, box_id, verb, cpu_millis, memory_mb, disk_gb, pids) VALUES ($1, $2, 'create', 1000, 2048, 10, 512)")
        .bind(w.workspace)
        .bind(box_id)
        .execute(&su)
        .await
        .expect("control");
    let app = momo_app_pool().await;
    let mut tx = app.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(w.workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    expect_db_error(
        sqlx::query("DELETE FROM cloud_box WHERE id = $1")
            .bind(box_id)
            .execute(&mut *tx)
            .await,
        "permission denied",
    )
    .await;
    tx.rollback().await.expect("rollback");
    expect_db_error(
        sqlx::query("DELETE FROM cloud_box WHERE id = $1")
            .bind(box_id)
            .execute(&su)
            .await,
        "tombstone until deleted",
    )
    .await;
    expect_db_error(
        sqlx::query("DELETE FROM cloud_box_control WHERE box_id = $1")
            .bind(box_id)
            .execute(&su)
            .await,
        "in flight cannot be removed",
    )
    .await;
    // A finished control, and a box that reached `deleted`, can be removed by the owner role.
    sqlx::query(
        "UPDATE cloud_box_control SET status='cancelled', completed_at=now() WHERE box_id = $1",
    )
    .bind(box_id)
    .execute(&su)
    .await
    .expect("cancel");
    let removed = sqlx::query("DELETE FROM cloud_box_control WHERE box_id = $1")
        .bind(box_id)
        .execute(&su)
        .await
        .expect("finished control is removable");
    assert_eq!(removed.rows_affected(), 1);
    sqlx::query(
        "UPDATE cloud_box SET state='deleting', closed_reason='owner_delete' WHERE id = $1",
    )
    .bind(box_id)
    .execute(&su)
    .await
    .expect("deleting");
    sqlx::query("UPDATE cloud_box SET state='deleted', deleted_at=now() WHERE id = $1")
        .bind(box_id)
        .execute(&su)
        .await
        .expect("deleted");
    sqlx::query("DELETE FROM cloud_box WHERE id = $1")
        .bind(box_id)
        .execute(&su)
        .await
        .expect("tombstone removable");
}

// ---------------------------------------------------------------------------
// the runner queue
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3500-*)"]
async fn the_control_queue_is_closed_ordered_and_leased() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let w = seed_world(&su).await;
    let other = seed_world(&su).await;
    let app = momo_app_pool().await;
    let box_id: Uuid = sqlx::query_scalar(
        "INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(w.workspace)
    .bind(w.m)
    .fetch_one(&su)
    .await
    .expect("box");

    // The verb list is the five of D2; nothing that reaches into a box is storable.
    assert_eq!(
        ControlVerb::ALL.map(|verb| verb.as_str()),
        ["create", "start", "stop", "delete", "status"]
    );
    for forbidden in [
        "exec", "cp", "commit", "export", "snapshot", "attach", "inspect",
    ] {
        expect_db_error(
            sqlx::query(
                "INSERT INTO cloud_box_control (workspace_id, box_id, verb, status, result_code, completed_at) \
                 VALUES ($1, $2, $3, 'done', 'ok', now())",
            )
            .bind(w.workspace)
            .bind(box_id)
            .bind(forbidden)
            .execute(&su)
            .await,
            "cloud_box_control_verb_ck",
        )
        .await;
    }
    for verb in ControlVerb::ALL {
        let limits = verb == ControlVerb::Create;
        sqlx::query(&format!(
            "INSERT INTO cloud_box_control (workspace_id, box_id, verb, status, result_code, completed_at{}) \
             VALUES ($1, $2, $3, 'done', 'ok', now(){})",
            if limits { ", cpu_millis, memory_mb, disk_gb, pids" } else { "" },
            if limits { ", 1000, 2048, 10, 512" } else { "" },
        ))
        .bind(w.workspace)
        .bind(box_id)
        .bind(verb.as_str())
        .execute(&su)
        .await
        .unwrap_or_else(|error| panic!("verb {} must be storable: {error}", verb.as_str()));
    }
    // `create` carries exactly the four limits; no other verb may carry any, and none may exceed the ceiling.
    expect_db_error(
        sqlx::query("INSERT INTO cloud_box_control (workspace_id, box_id, verb, status, result_code, completed_at) VALUES ($1, $2, 'create', 'done', 'ok', now())")
            .bind(w.workspace).bind(box_id).execute(&su).await,
        "cloud_box_control_limits_ck",
    ).await;
    expect_db_error(
        sqlx::query("INSERT INTO cloud_box_control (workspace_id, box_id, verb, cpu_millis, memory_mb, disk_gb, pids, status, result_code, completed_at) VALUES ($1, $2, 'start', 1, 1, 1, 1, 'done', 'ok', now())")
            .bind(w.workspace).bind(box_id).execute(&su).await,
        "cloud_box_control_limits_ck",
    ).await;
    expect_db_error(
        sqlx::query("INSERT INTO cloud_box_control (workspace_id, box_id, verb, cpu_millis, memory_mb, disk_gb, pids, status, result_code, completed_at) VALUES ($1, $2, 'create', 4000, 2048, 10, 512, 'done', 'ok', now())")
            .bind(w.workspace).bind(box_id).execute(&su).await,
        "cloud_box_control_limits_ck",
    ).await;
    // A control cannot point a box of one workspace at another.
    expect_db_error(
        sqlx::query("INSERT INTO cloud_box_control (workspace_id, box_id, verb, status, result_code, completed_at) VALUES ($1, $2, 'stop', 'done', 'ok', now())")
            .bind(other.workspace).bind(box_id).execute(&su).await,
        "violates foreign key",
    ).await;

    // One control in flight per box.
    sqlx::query(
        "INSERT INTO cloud_box_control (workspace_id, box_id, verb) VALUES ($1, $2, 'status')",
    )
    .bind(w.workspace)
    .bind(box_id)
    .execute(&su)
    .await
    .expect("first pending");
    expect_db_error(
        sqlx::query(
            "INSERT INTO cloud_box_control (workspace_id, box_id, verb) VALUES ($1, $2, 'stop')",
        )
        .bind(w.workspace)
        .bind(box_id)
        .execute(&su)
        .await,
        "cloud_box_control_in_flight_uk",
    )
    .await;
    // What a control says cannot be edited afterwards.
    expect_db_error(
        sqlx::query(
            "UPDATE cloud_box_control SET verb = 'delete' WHERE box_id = $1 AND status = 'pending'",
        )
        .bind(box_id)
        .execute(&su)
        .await,
        "cannot change",
    )
    .await;

    // Claim, lease, complete — inside the tenant, nobody else's.
    let ws = w.workspace;
    let foreign = momo_db::with_tenant_tx(&app, other.workspace, move |conn| {
        Box::pin(async move { claim_controls_in_tx(conn, other.workspace, 10, 60).await })
    })
    .await
    .expect("foreign claim");
    assert!(
        foreign.is_empty(),
        "another workspace's runner was handed this workspace's control"
    );
    let claimed = momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { claim_controls_in_tx(conn, ws, 10, 60).await })
    })
    .await
    .expect("claim");
    assert_eq!(claimed.len(), 1);
    assert_eq!(
        (
            claimed[0].verb.as_str(),
            claimed[0].attempts,
            claimed[0].box_id
        ),
        ("status", 1, box_id)
    );
    let again = momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { claim_controls_in_tx(conn, ws, 10, 60).await })
    })
    .await
    .expect("second claim");
    assert!(again.is_empty(), "a leased control was handed out twice");
    // The lease runs out: the same control comes back, attempt 2.
    sqlx::query(
        "UPDATE cloud_box_control SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    )
    .bind(claimed[0].id)
    .execute(&su)
    .await
    .expect("expire lease");
    let retaken = momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { claim_controls_in_tx(conn, ws, 10, 60).await })
    })
    .await
    .expect("reclaim");
    assert_eq!(
        (retaken.len(), retaken[0].id, retaken[0].attempts),
        (1, claimed[0].id, 2)
    );
    let control_id = retaken[0].id;
    let completed = momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let first = complete_control_in_tx(conn, ws, control_id, false).await?;
            let second = complete_control_in_tx(conn, ws, control_id, true).await?;
            Ok((first, second))
        })
    })
    .await
    .expect("complete");
    assert_eq!(
        completed,
        (true, false),
        "a finished control must not be completed twice"
    );
    let result: (String, String) =
        sqlx::query_as("SELECT status, result_code FROM cloud_box_control WHERE id = $1")
            .bind(control_id)
            .fetch_one(&su)
            .await
            .expect("result");
    assert_eq!(result, ("failed".to_string(), "failed".to_string()));

    // Delivery is oldest-first.
    let mut members = Vec::new();
    for index in 0..3 {
        let member = insert_human(&su, w.workspace, &format!("순서{index}"), "member")
            .await
            .0;
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO cloud_box (workspace_id, member_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(w.workspace)
        .bind(member)
        .fetch_one(&su)
        .await
        .expect("box");
        sqlx::query("INSERT INTO cloud_box_control (workspace_id, box_id, verb, cpu_millis, memory_mb, disk_gb, pids) VALUES ($1, $2, 'create', 1000, 2048, 10, 512)")
            .bind(w.workspace).bind(id).execute(&su).await.expect("control");
        members.push(id);
    }
    let order = momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { claim_controls_in_tx(conn, ws, 10, 60).await })
    })
    .await
    .expect("ordered claim");
    assert_eq!(order.iter().map(|c| c.box_id).collect::<Vec<_>>(), members);
    assert!(order.windows(2).all(|pair| pair[0].seq < pair[1].seq));
}
