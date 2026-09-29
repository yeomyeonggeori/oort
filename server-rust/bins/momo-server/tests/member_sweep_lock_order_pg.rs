//! #3109 — the member-wide token sweeps take their rows in id order.
//!
//! `revoke_member_session_tokens` and `revoke_privileged_session_tokens` are
//! `UPDATE`s over every live session row of a member, across lineages. A bare
//! `UPDATE` locks in scan order, so it can hold a high-id row while waiting on
//! a low-id one, while a lineage sweep (`lock_session_rows_in_tx`: `ORDER BY
//! id FOR UPDATE`) holds the low one and wants the high one — 40P01. Both now
//! pass through `lock_member_live_session_rows_in_tx` first.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_member_wide_sweep_and_a_lineage_sweep_never_deadlock` | drop the lock call from `revoke_member_session_tokens` |
//! | `a_privileged_sweep_and_a_lineage_sweep_never_deadlock` | drop the lock call from `revoke_privileged_session_tokens` |
//!
//! Deterministic interleaving (no timers): the rows are inserted high id
//! first, so the sweep scans the high row first; the "lineage sweep" holds the
//! low row; the test waits until the sweep is parked on a lock, then takes the
//! high row.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:27109/momo \
//!   cargo test -p momo-server --test member_sweep_lock_order_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_auth::{revoke_member_session_tokens, revoke_privileged_session_tokens};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
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
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into());
    // The bare `UPDATE`'s lock order is whatever its scan yields: with
    // `token_actor_idx` (the plan a big table gets) it is heap order, with
    // `token_workspace_id_id_uniq` it happens to be id order. Pin the heap
    // order so the test does not depend on the planner's mood.
    let options = options
        .username("momo_app")
        .password(&password)
        .options([("enable_indexscan", "off"), ("enable_bitmapscan", "off")]);
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
}

#[derive(Clone, Copy, Debug)]
enum Sweep {
    Member,
    Privileged,
}

/// One member with two live session rows; the HIGHER id is inserted first so a
/// scan reaches it first. Returns (workspace, member, high, low).
async fn seed(su: &PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("3109-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(format!("s-{}", &member.simple().to_string()[..10]))
    .execute(su)
    .await
    .expect("seed member");
    let (mut low, mut high) = (Uuid::new_v4(), Uuid::new_v4());
    if low > high {
        std::mem::swap(&mut low, &mut high);
    }
    let session = Uuid::new_v4();
    for (id, label) in [(high, "access"), (low, "refresh")] {
        sqlx::query(
            "INSERT INTO token (id, workspace_id, kind, actor_member_id, token_hash, scopes, \
                                label, session_id) \
             VALUES ($1, $2, 'session', $3, digest($4::text, 'sha256'), \
                     ARRAY['messages:read','platform:read'], $5, $6)",
        )
        .bind(id)
        .bind(workspace)
        .bind(member)
        .bind(id.to_string() + &workspace.to_string())
        .bind(label)
        .bind(session)
        .execute(su)
        .await
        .expect("seed token");
    }
    (workspace, member, high, low)
}

async fn never_deadlocks(sweep: Sweep) {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    // A heap page reuses freed line pointers, so "inserted first" does not
    // always mean "scanned first": reseed until the heap order (what the
    // pinned seq scan follows) reaches the HIGH id first (the order the bare `UPDATE` locks in).
    let (workspace, member, high, low) = {
        let mut attempt = 0;
        loop {
            let (workspace, member, high, low) = seed(&su).await;
            let scanned: Vec<Uuid> = sqlx::query_scalar(
                "SELECT id FROM token WHERE workspace_id = $1 AND actor_member_id = $2 \
                    AND kind = 'session' AND revoked_at IS NULL \
                  ORDER BY ctid",
            )
            .bind(workspace)
            .bind(member)
            .fetch_all(&su)
            .await
            .unwrap();
            if scanned == vec![high, low] {
                break (workspace, member, high, low);
            }
            sqlx::query("DELETE FROM workspace WHERE id = $1")
                .bind(workspace)
                .execute(&su)
                .await
                .unwrap();
            attempt += 1;
            assert!(
                attempt < 50,
                "premise: an unordered scan reaches the high id first"
            );
        }
    };

    // The lineage sweep's shape: it holds the low row, and will want the high.
    let mut lineage = su.begin().await.expect("begin");
    sqlx::query("SELECT id FROM token WHERE id = $1 FOR UPDATE")
        .bind(low)
        .fetch_one(&mut *lineage)
        .await
        .expect("hold the low row");

    let pool = app.clone();
    let sweeping = tokio::spawn(async move {
        with_tenant_tx(&pool, workspace, move |conn| {
            Box::pin(async move {
                match sweep {
                    Sweep::Member => revoke_member_session_tokens(conn, workspace, member).await,
                    Sweep::Privileged => {
                        revoke_privileged_session_tokens(conn, workspace, member).await
                    }
                }
                .map_err(DbError::from)
            })
        })
        .await
    });

    // Wait until the sweep is parked on a row lock (not on a timer).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let parked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
              WHERE datname = current_database() AND usename = 'momo_app' \
                AND state = 'active' AND wait_event_type = 'Lock'",
        )
        .fetch_one(&su)
        .await
        .unwrap();
        if parked == 1 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the sweep never parked on the held low row"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    // Unordered: the sweep already holds `high`, so this closes a cycle and
    // Postgres kills one side after deadlock_timeout. Ordered: the sweep holds
    // nothing yet and this succeeds at once.
    sqlx::query("SELECT id FROM token WHERE id = $1 FOR UPDATE")
        .bind(high)
        .fetch_one(&mut *lineage)
        .await
        .unwrap_or_else(|err| panic!("{sweep:?}: lineage sweep lost to a deadlock: {err}"));
    lineage.commit().await.expect("lineage sweep commits");

    let revoked = sweeping
        .await
        .expect("sweep task")
        .unwrap_or_else(|err| panic!("{sweep:?}: the sweep died: {err}"));
    assert_eq!(revoked, 2, "{sweep:?} flips both live rows");

    sqlx::query("DELETE FROM workspace WHERE id = $1")
        .bind(workspace)
        .execute(&su)
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_wide_sweep_and_a_lineage_sweep_never_deadlock() {
    never_deadlocks(Sweep::Member).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_privileged_sweep_and_a_lineage_sweep_never_deadlock() {
    never_deadlocks(Sweep::Privileged).await;
}
