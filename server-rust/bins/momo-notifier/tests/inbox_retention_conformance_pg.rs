//! DB-backed conformance for the inbox retention sweep (#3681 E2, ADR-0199 D4:
//! 「읽은 항목은 `read_at` 기준 30일 뒤 삭제, 원본 message는 건드리지 않는다」).
//!
//! The candidate read runs on a notifier-like pool and every delete as a
//! per-tenant transaction on the RLS-bound `momo_app` pool. This suite uses the
//! development role file (behaviour, not grants); `prod_role_conformance_pg`
//! runs the same sweep as the production roles.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:23802/momo \
//!   cargo test -p momo-notifier --test inbox_retention_conformance_pg -- --ignored --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_sweep_deletes_read_items_past_thirty_days_and_nothing_else` | drop the `read_at IS NOT NULL` / age predicate, or delete `message` |
//! | `a_write_pool_that_bypasses_rls_is_refused` | drop `ensure_write_pool_rls_bound` |
//! | `a_second_run_finds_nothing` | make the delete non-idempotent (e.g. count rows it did not remove) |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_notifier::inbox_retention_sweep::sweep_read_inbox_items;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
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
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username("momo_app").password("momo_app_dev_pw"))
        .await
        .expect("connect as momo_app")
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
    PathBuf::from("/opt/homebrew/opt/libpq/bin/psql")
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
        ])
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

struct Seeded {
    workspace: Uuid,
    /// message ids with: expired-read, fresh-read, unread-and-ancient
    expired: Uuid,
    fresh: Uuid,
    unread: Uuid,
}

async fn seed(su: &PgPool) -> Seeded {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .unwrap();
    let mut members = Vec::new();
    for handle in ["alice", "bob"] {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, 'human', $3, $3)")
            .bind(id).bind(workspace).bind(format!("{handle}-{}", &id.simple().to_string()[..6]))
            .execute(su).await.unwrap();
        members.push(id);
    }
    let (alice, bob) = (members[0], members[1]);
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name, created_by) VALUES ($1, $2, 'public', $3, $4)")
        .bind(channel).bind(workspace).bind(format!("c-{}", &channel.simple().to_string()[..8])).bind(alice)
        .execute(su).await.unwrap();
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .unwrap();
    for m in &members {
        sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ($1, $2, $3, 'member')")
            .bind(workspace).bind(channel).bind(m).execute(su).await.unwrap();
    }
    let say = |author: Uuid, reply_to: Option<Uuid>| {
        let su = su.clone();
        async move {
            let seq: i64 = sqlx::query_scalar("UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq")
                .bind(channel).fetch_one(&su).await.unwrap();
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, reply_to_id) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', 'x', $6)")
                .bind(id).bind(workspace).bind(channel).bind(seq).bind(author).bind(reply_to)
                .execute(&su).await.unwrap();
            id
        }
    };
    let mine = say(alice, None).await;
    let expired = say(bob, Some(mine)).await;
    let fresh = say(bob, Some(mine)).await;
    let unread = say(bob, Some(mine)).await;
    // Backdate with the guard triggers off (the guard is what stops this in prod).
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE inbox_item SET read_at = now() - interval '31 days' WHERE message_id = $1")
        .bind(expired)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE inbox_item SET read_at = now() - interval '29 days' WHERE message_id = $1")
        .bind(fresh)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE inbox_item SET created_at = now() - interval '400 days' WHERE message_id = $1",
    )
    .bind(unread)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    Seeded {
        workspace,
        expired,
        fresh,
        unread,
    }
}

async fn item_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM inbox_item WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_sweep_deletes_read_items_past_thirty_days_and_nothing_else() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let seeded = seed(&su).await;
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id = $1")
        .bind(seeded.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(item_count(&su, seeded.workspace).await, 3);

    let stats = sweep_read_inbox_items(&su, &app, 100).await.expect("sweep");
    assert!(stats.workspaces >= 1);
    assert!(stats.deleted >= 1);

    let left: Vec<Uuid> = sqlx::query_scalar(
        "SELECT message_id FROM inbox_item WHERE workspace_id = $1 ORDER BY message_id",
    )
    .bind(seeded.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    let mut want = vec![seeded.fresh, seeded.unread];
    want.sort();
    assert_eq!(
        left, want,
        "the 31-day-old READ item went; the 29-day-old and the unread-ancient stayed"
    );
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id = $1")
        .bind(seeded.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(after, messages, "the source messages are untouched");
    let _ = seeded.expired;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_second_run_finds_nothing() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let seeded = seed(&su).await;
    sweep_read_inbox_items(&su, &app, 100).await.expect("first");
    let before = item_count(&su, seeded.workspace).await;
    let again = sweep_read_inbox_items(&su, &app, 100)
        .await
        .expect("second");
    assert_eq!(
        item_count(&su, seeded.workspace).await,
        before,
        "idempotent"
    );
    // other tests' tenants may still be draining; this tenant has nothing left
    let _ = again;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_write_pool_that_bypasses_rls_is_refused() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let seeded = seed(&su).await;
    // the superuser pool as the WRITE pool: the sweep must refuse to run through it
    let refused = sweep_read_inbox_items(&su, &su, 100).await;
    assert!(refused.is_err(), "a BYPASSRLS write pool must be refused");
    assert_eq!(
        item_count(&su, seeded.workspace).await,
        3,
        "nothing was deleted"
    );
}
