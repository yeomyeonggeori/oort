//! DB-backed B0 conformance (orchestrator docker gate for ADR-0145 B안).
//!
//! Proves the two things the DB-free unit tests cannot:
//!  1. the Rust migration runner reproduces the Swift bootstrap schema on a
//!     fresh `pgvector/pgvector:pg18` DB — all 65 files apply in place, unmodified
//!     (incl. the `vector`/`pg_trgm`/`pgcrypto` extensions and the DDL the whole
//!     enforcement layer lives in);
//!  2. `with_tenant_tx` actually sets the `app.workspace_id` RLS GUC (the single
//!     wiring point for invariant #6).
//!
//! B1.6 adds a third: the runner is **idempotent** — a second run against the
//! same database applies nothing and skips every file (`schema_migrations`
//! tracking, `scripts/migrate.sh:117-143` parity).
//!
//! `#[ignore]` — needs a superuser DB. It no longer has to be a *fresh* one
//! (that is exactly what the idempotency test proves), but a fresh
//! `pgvector/pgvector:pg18` container is still the cleanest way to run it:
//!   DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!     cargo test -p momo-db --test conformance_pg -- --ignored --nocapture
//!
//! Full cross-tenant *data* red (as `momo_app` with seeded rows) is a B1
//! conformance concern (needs multi-table seed); B0 proves apply + GUC wiring.

use std::sync::OnceLock;

use momo_db::migrate::{default_migrations_dir, discover_migrations, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::{with_tenant_tx, DbError, PgPool};
use uuid::Uuid;

/// The runner is process-global state on one database, so the two tests that
/// drive it are serialized; otherwise an interleaved run would make either
/// test's APPLY/SKIP accounting nondeterministic.
async fn migration_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB");
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("connect to conformance DB")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB"]
async fn migration_runner_applies_all_65_and_matches_schema() {
    let _guard = migration_lock().await;
    let pool = superuser_pool().await;
    let mut conn = pool.acquire().await.expect("acquire");

    // discovery = exactly the 65 versioned files, contiguous
    let migs = discover_migrations(&default_migrations_dir()).expect("discover");
    assert_eq!(migs.len(), 65, "expected 65 migrations, got {}", migs.len());

    // THE runner — applies 001..061 in place via psql (incl. pgvector 028 and
    // the seed migrations' `\if` meta-commands). An ordering/role dependency or
    // a psql-rejected file would surface here as a real finding. Product default
    // seed mode (no legacy agent fixtures).
    let report = run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("all 65 migrations apply on a fresh pgvector/pg18 DB");
    assert_eq!(
        report.total(),
        65,
        "the runner must consider all 65 files (applying them, or SKIPping the \
         ones a previous run already recorded)"
    );

    // outbox table + full enum (emit.rs OutboxKind must be a subset of these)
    let outbox_exists: bool = sqlx::query_scalar("SELECT to_regclass('public.outbox') IS NOT NULL")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert!(outbox_exists, "outbox table must exist");

    let labels: Vec<String> =
        sqlx::query_scalar("SELECT unnest(enum_range(NULL::outbox_kind))::text")
            .fetch_all(&mut *conn)
            .await
            .unwrap();
    for want in [
        "broadcast",
        "agent_job",
        "push_candidate",
        "webhook_delivery",
    ] {
        assert!(
            labels.iter().any(|l| l == want),
            "outbox_kind missing '{want}'; got {labels:?}"
        );
    }

    // gapless seq backstop (invariant #4): app-code row-lock + DB UNIQUE
    let seq_uniq: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='message_seq_uniq')",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert!(
        seq_uniq,
        "message_seq_uniq UNIQUE(channel_id, seq) must exist"
    );
    let channel_seq: bool =
        sqlx::query_scalar("SELECT to_regclass('public.channel_seq') IS NOT NULL")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert!(channel_seq, "channel_seq table must exist");

    // invariant #6 backstop lives in the DB: many tables carry FORCE RLS
    let forced: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class WHERE relkind='r' AND relforcerowsecurity",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert!(
        forced >= 30,
        "expected many FORCE-RLS tables (D2 #6), got {forced}"
    );

    println!(
        "conformance: 65 migrations applied; outbox_kind={labels:?}; FORCE-RLS tables={forced}"
    );
}

/// **RED for B1.6 소품 B.** Running the runner twice against the same database
/// must be a no-op the second time: every file `SKIP`, zero new applies.
///
/// Before `schema_migrations` tracking this test could not pass at all — the
/// second run re-applied `001_init.sql`, psql rejected the duplicate DDL, and
/// `run_migrations` returned `MigrationFailed`. Delete the skip judgement from
/// `migrate.rs` and it goes red again in exactly that way.
///
/// It also pins the tracking contract itself: one row per file, keyed by the
/// **filename** (`migrate.sh:122`), which is what makes SKIP survive a runner
/// restart.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn migration_runner_is_idempotent_across_runs() {
    let _guard = migration_lock().await;
    let pool = superuser_pool().await;
    let expected = discover_migrations(&default_migrations_dir())
        .expect("discover")
        .len();

    // First run: may itself be a full apply (fresh DB) or a full skip (the
    // sibling test already migrated) — either way it must consider every file.
    let first = run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("first run");
    assert_eq!(
        first.total(),
        expected,
        "every discovered migration must be considered"
    );

    // Second run: the whole point. Nothing new, everything skipped.
    let second = run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("a second run must not fail — it must skip");
    assert!(
        second.applied.is_empty(),
        "re-running the runner must apply nothing new, applied={:?}",
        second.applied
    );
    assert_eq!(
        second.skipped.len(),
        expected,
        "every already-applied migration must be SKIPped"
    );

    // The tracking table holds exactly one row per file, keyed by filename.
    let tracked: Vec<String> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .expect("read schema_migrations");
    assert_eq!(
        tracked.len(),
        expected,
        "one schema_migrations row per migration file (no dupes, no gaps)"
    );
    let mut names: Vec<String> = discover_migrations(&default_migrations_dir())
        .expect("discover")
        .into_iter()
        .map(|migration| migration.name)
        .collect();
    names.sort();
    assert_eq!(
        tracked, names,
        "schema_migrations.version must be the migration FILENAME (migrate.sh:122)"
    );

    println!(
        "conformance: runner idempotent — second run applied={} skipped={}",
        second.applied.len(),
        second.skipped.len()
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB"]
async fn with_tenant_tx_sets_the_rls_guc() {
    let pool = superuser_pool().await;
    let ws = Uuid::from_u128(0x0000_1234_5678_9abc_def0_1234_5678_9abc);

    let read: String = with_tenant_tx(&pool, ws, move |c| {
        Box::pin(async move {
            let v: String = sqlx::query_scalar("SELECT current_setting('app.workspace_id', true)")
                .fetch_one(&mut *c)
                .await
                .map_err(DbError::from)?;
            Ok(v)
        })
    })
    .await
    .expect("tenant tx");

    assert_eq!(
        read,
        ws.to_string(),
        "with_tenant_tx must set app.workspace_id to the bound workspace id"
    );
    println!("conformance: with_tenant_tx bound app.workspace_id = {read}");
}
