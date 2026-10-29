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
//! | `two_downgrading_rotations_on_two_lineages_never_deadlock` | make `lock_member_wide_sweep_in_tx` a no-op (the ordered pre-lock alone is a SECOND acquisition after the lineage lock and does not save this) |
//! | `a_member_wide_sweep_and_a_dev_lineage_sweep_never_deadlock` | (ADR-0216 R9) drop the ordered `LOCK_MEMBER_LIVE_DEV_ROWS_SQL` fetch from `revoke_member_dev_tokens_in_tx`; or drop its call from `revoke_member_session_tokens` (the dev rows then stay live) |
//! | `two_dev_rotations_each_sweeping_the_member_never_deadlock` | (ADR-0216 R9) make `lock_member_wide_sweep_in_tx` a no-op — the developer rows ride the same per-member queue as the session rows |
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

use momo_auth::dev_token::{
    issue_dev_login_in_tx, revoke_member_dev_tokens_in_tx, rotate_dev_refresh_in_tx, DevRotation,
    DevTool, IssuedDevLogin, NewDevLogin, DEV_READ_ONLY_SCOPES, FIXED_POLICY,
};
use momo_auth::{
    lock_member_wide_sweep_in_tx, lock_session_rows_in_tx, revoke_member_session_tokens,
    revoke_privileged_session_tokens,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
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

/// The issue's own scenario: two downgrading rotations of one member, on two
/// devices whose lineages interleave by id (`{a,c}` and `{b,d}`, a<b<c<d).
/// Each holds its lineage (`lock_session_rows_in_tx`, as `recover_lineage` /
/// the linked branch do) and then sweeps the member's privileged rows. The
/// route's first move is `lock_member_wide_sweep_in_tx`; here A waits for B to
/// have locked its lineage or for 1.5 s — whichever comes first — so the
/// interleaving is the same with and without the queue: without it both
/// lineages are held and each sweep wants the other's (40P01); with it B
/// cannot even lock its lineage until A has committed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn two_downgrading_rotations_on_two_lineages_never_deadlock() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let (workspace, member, _, _) = seed(&su).await;
    // Two lineages of the same member with interleaved ids.
    let mut ids: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
    ids.sort();
    let (l1, l2) = (Uuid::new_v4(), Uuid::new_v4());
    let lineage_a = [ids[0], ids[2]];
    let lineage_b = [ids[1], ids[3]];
    for (lineage, rows) in [(l1, lineage_a), (l2, lineage_b)] {
        for row in rows {
            sqlx::query(
                "INSERT INTO token (id, workspace_id, kind, actor_member_id, token_hash, \
                                    scopes, label, session_id) \
                 VALUES ($1, $2, 'session', $3, digest($4::text, 'sha256'), \
                         ARRAY['messages:read','platform:read'], 'access', $5)",
            )
            .bind(row)
            .bind(workspace)
            .bind(member)
            .bind(row.to_string() + &workspace.to_string())
            .bind(lineage)
            .execute(&su)
            .await
            .expect("seed lineage row");
        }
    }

    let b_locked = std::sync::Arc::new(tokio::sync::Notify::new());
    let a_locked = std::sync::Arc::new(tokio::sync::Notify::new());
    let rotation = |lineage: Uuid,
                    mine: std::sync::Arc<tokio::sync::Notify>,
                    wait_for: Option<std::sync::Arc<tokio::sync::Notify>>,
                    peer: Option<std::sync::Arc<tokio::sync::Notify>>| {
        let pool = app.clone();
        tokio::spawn(async move {
            if let Some(gate) = peer {
                gate.notified().await;
            }
            with_tenant_tx(&pool, workspace, move |conn| {
                Box::pin(async move {
                    lock_member_wide_sweep_in_tx(conn, workspace, member)
                        .await
                        .map_err(DbError::from)?;
                    lock_session_rows_in_tx(conn, workspace, member, Some(lineage), &[])
                        .await
                        .map_err(DbError::from)?;
                    mine.notify_one();
                    if let Some(other) = wait_for {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_millis(1500),
                            other.notified(),
                        )
                        .await;
                    }
                    revoke_privileged_session_tokens(conn, workspace, member)
                        .await
                        .map_err(DbError::from)
                })
            })
            .await
        })
    };
    let a = rotation(l1, a_locked.clone(), Some(b_locked.clone()), None);
    let b = rotation(l2, b_locked.clone(), None, Some(a_locked.clone()));
    let a = a
        .await
        .expect("task A")
        .unwrap_or_else(|err| panic!("rotation A died: {err}"));
    let b = b
        .await
        .expect("task B")
        .unwrap_or_else(|err| panic!("rotation B died: {err}"));
    // The four lineage rows plus the two `seed` rows (same member, privileged).
    assert_eq!(a + b, 6, "between them the two sweeps flip every live row");

    sqlx::query("DELETE FROM workspace WHERE id = $1")
        .bind(workspace)
        .execute(&su)
        .await
        .expect("cleanup");
}

// ---------------------------------------------------------------------------
// ADR-0216 R9 — the developer tokens (`kind = 'dev'`) ride the same sweep discipline
// ---------------------------------------------------------------------------

/// A workspace and one **active admin** human — the role `FIXED_POLICY` admits and the one a rotation
/// needs. No token rows: the callers write exactly the developer rows they mean to sweep.
async fn seed_dev_member(su: &PgPool) -> (Uuid, Uuid) {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("4660-{workspace}"))
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
    .bind(format!("d-{}", &member.simple().to_string()[..10]))
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'admin')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed membership");
    (workspace, member)
}

/// One developer row written the way the issuance functions write it (`lineage` is the login
/// session's id; `None` makes a card).
async fn insert_dev_row(
    conn: &mut PgConnection,
    workspace: Uuid,
    member: Uuid,
    id: Uuid,
    form: &str,
    lineage: Option<Uuid>,
) {
    sqlx::query(
        "INSERT INTO token (id, workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                            session_id, created_at, expires_at, created_by, dev_form, dev_tool, \
                            dev_client, dev_lineage_expires_at) \
         VALUES ($1, $2, 'dev', $3, digest($4::text, 'sha256'), \
                 ARRAY['dev:identity', 'dev:channels:read'], 'lock probe', $5, now(), \
                 now() + interval '1 day', $3, $6, 'cli', $7, \
                 CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() + interval '2160 hours' END)",
    )
    .bind(id)
    .bind(workspace)
    .bind(member)
    .bind(id.to_string() + &workspace.to_string())
    .bind(lineage)
    .bind(form)
    .bind(lineage.map(|_| "oort-cli/0.1.0"))
    .execute(conn)
    .await
    .expect("seed developer row");
}

/// One member with three live developer rows — a card and the two halves of one login lineage — written
/// in the order HIGH, middle, LOW id on ONE connection, so they sit in the heap in the order they were
/// written and a sequential scan reaches the low id last. That is checked, not assumed: a nearly full
/// page can send the last row to an earlier one (the table is shared with whatever else ran), and then
/// the workspace is reseeded. Returns `(workspace, member, low, first)`, where `first` is the row an
/// unordered scan locks first — what the lineage sweep will want once the sweep is parked.
async fn seed_dev_rows(su: &PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
    for _ in 0..50 {
        let (workspace, member) = seed_dev_member(su).await;
        let mut ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        ids.sort();
        let [low, middle, high] = ids;
        let lineage = Uuid::new_v4();
        {
            let mut conn = su
                .acquire()
                .await
                .expect("one connection for all the inserts");
            insert_dev_row(&mut conn, workspace, member, high, "access", Some(lineage)).await;
            insert_dev_row(&mut conn, workspace, member, middle, "card", None).await;
            insert_dev_row(&mut conn, workspace, member, low, "refresh", Some(lineage)).await;
        }
        let scanned: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM token WHERE workspace_id = $1 AND actor_member_id = $2 \
                AND kind = 'dev' AND revoked_at IS NULL \
              ORDER BY ctid",
        )
        .bind(workspace)
        .bind(member)
        .fetch_all(su)
        .await
        .unwrap();
        // The premise: an unordered scan locks something before it reaches the low id.
        if scanned.len() == 3 && scanned[0] != low {
            return (workspace, member, low, scanned[0]);
        }
        sqlx::query("DELETE FROM workspace WHERE id = $1")
            .bind(workspace)
            .execute(su)
            .await
            .unwrap();
    }
    panic!("premise: an unordered scan reaches the low id after another row");
}

/// The password path's sweep (`revoke_member_session_tokens`, which a change and a reset both call)
/// against a lineage sweep that already holds the LOW developer row — the shape of
/// [`never_deadlocks`], on `kind = 'dev'` rows. The sweep must take its rows in id order (parking on the
/// low one while holding nothing), or its bare `UPDATE` holds whatever it scans first and closes a
/// cycle. And it must actually end the developer rows: that is the D7 trap's own assertion.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_wide_sweep_and_a_dev_lineage_sweep_never_deadlock() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let (workspace, member, low, first) = seed_dev_rows(&su).await;

    // The lineage sweep's shape: it holds the low row, and will want the one the sweep scans first.
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
                revoke_member_session_tokens(conn, workspace, member)
                    .await
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
            "the sweep never parked on the held low developer row"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    // Unordered: the sweep already holds `first`, so this closes a cycle and Postgres kills one side
    // after deadlock_timeout. Ordered: the sweep holds nothing yet and this succeeds at once.
    sqlx::query("SELECT id FROM token WHERE id = $1 FOR UPDATE")
        .bind(first)
        .fetch_one(&mut *lineage)
        .await
        .unwrap_or_else(|err| panic!("dev lineage sweep lost to a deadlock: {err}"));
    lineage.commit().await.expect("lineage sweep commits");

    // The count `revoke_member_session_tokens` returns is sessions only (the audit's
    // `sessions_revoked`): none here. The developer rows are ended all the same.
    let sessions = sweeping
        .await
        .expect("sweep task")
        .unwrap_or_else(|err| panic!("the sweep died: {err}"));
    assert_eq!(sessions, 0, "no session row was seeded");
    let (live, total): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE revoked_at IS NULL), count(*) FROM token \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'dev'",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        (live, total),
        (0, 3),
        "the password path's sweep ends the card and both halves of the lineage"
    );

    sqlx::query("DELETE FROM workspace WHERE id = $1")
        .bind(workspace)
        .execute(&su)
        .await
        .expect("cleanup");
}

async fn open_dev_lineage(app: &PgPool, workspace: Uuid, member: Uuid) -> IssuedDevLogin {
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            issue_dev_login_in_tx(
                conn,
                workspace,
                member,
                &NewDevLogin {
                    label: "oort CLI · 노트북".to_string(),
                    tool: DevTool::Cli,
                    client: "oort-cli/0.1.0".to_string(),
                    device_name: None,
                    scopes: DEV_READ_ONLY_SCOPES
                        .iter()
                        .map(|scope| (*scope).to_string())
                        .collect(),
                    channel_ids: None,
                },
                FIXED_POLICY,
            )
            .await
            .map_err(DbError::from)
        })
    })
    .await
    .expect("tenant transaction")
    .expect("the lineage is opened")
}

/// [`two_downgrading_rotations_on_two_lineages_never_deadlock`]'s composed shape, on developer rows and
/// with the real rotation: two of one member's login lineages each rotate (`rotate_dev_refresh_in_tx`
/// holds that lineage's rows) and THEN sweep the whole member (`revoke_member_dev_tokens_in_tx` — what a
/// switch narrowing or any later member-wide dev sweep does after its own lineage work). A waits for B to
/// have done its rotation or for 1.5 s, whichever comes first, so the interleaving is the same with and
/// without the per-member queue: without it both lineages are held and each sweep wants the other's
/// (40P01); with it B cannot even start its rotation until A has committed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn two_dev_rotations_each_sweeping_the_member_never_deadlock() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let (workspace, member) = seed_dev_member(&su).await;
    let first = open_dev_lineage(&app, workspace, member).await;
    let second = open_dev_lineage(&app, workspace, member).await;

    let b_started = std::sync::Arc::new(tokio::sync::Notify::new());
    let a_started = std::sync::Arc::new(tokio::sync::Notify::new());
    let rotation = |refresh: String,
                    mine: std::sync::Arc<tokio::sync::Notify>,
                    wait_for: Option<std::sync::Arc<tokio::sync::Notify>>,
                    peer: Option<std::sync::Arc<tokio::sync::Notify>>| {
        let pool = app.clone();
        tokio::spawn(async move {
            if let Some(gate) = peer {
                gate.notified().await;
            }
            with_tenant_tx(&pool, workspace, move |conn| {
                Box::pin(async move {
                    // The route's first move, as the rotation's own first move is the same call.
                    lock_member_wide_sweep_in_tx(conn, workspace, member)
                        .await
                        .map_err(DbError::from)?;
                    let rotation =
                        rotate_dev_refresh_in_tx(conn, workspace, &refresh, FIXED_POLICY)
                            .await
                            .map_err(DbError::from)?;
                    mine.notify_one();
                    if let Some(other) = wait_for {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_millis(1500),
                            other.notified(),
                        )
                        .await;
                    }
                    let swept = revoke_member_dev_tokens_in_tx(conn, workspace, member)
                        .await
                        .map_err(DbError::from)?;
                    Ok((rotation, swept))
                })
            })
            .await
        })
    };
    let a = rotation(
        first.refresh.clone(),
        a_started.clone(),
        Some(b_started.clone()),
        None,
    );
    let b = rotation(
        second.refresh.clone(),
        b_started.clone(),
        None,
        Some(a_started.clone()),
    );
    let (a_rotation, a_swept) = a
        .await
        .expect("task A")
        .unwrap_or_else(|err| panic!("rotation A died: {err}"));
    let (b_rotation, b_swept) = b
        .await
        .expect("task B")
        .unwrap_or_else(|err| panic!("rotation B died: {err}"));

    // Queued behind A, B finds its refresh already ended by A's sweep: a spent refresh, nothing to
    // revoke. A had rotated its own lineage first.
    assert!(
        matches!(a_rotation, DevRotation::Rotated(_)),
        "A rotates its live refresh, got {a_rotation:?}"
    );
    assert!(
        matches!(b_rotation, DevRotation::ReuseDetected { revoked: 0, .. }),
        "B starts after A's sweep and meets an ended lineage, got {b_rotation:?}"
    );
    // A's sweep ended A's new pair and B's untouched pair (4 rows); B's found nothing left.
    assert_eq!((a_swept, b_swept), (4, 0));
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'dev' AND revoked_at IS NULL",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(live, 0, "between them the two sweeps leave nothing live");

    sqlx::query("DELETE FROM workspace WHERE id = $1")
        .bind(workspace)
        .execute(&su)
        .await
        .expect("cleanup");
}
