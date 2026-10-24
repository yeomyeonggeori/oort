//! #4227 / ADR-0177 증보 D9 — the `last_readable_seq` **backfill** in migration 146, on a database
//! that already holds messages (수용 기준 7).
//!
//! The other suite (`dm_closure_conformance_pg.rs`) runs on a database migrated from empty, where a
//! backfill has nothing to do. This one builds the state production is in: migrations 001..=145
//! applied, **two workspaces with messages in every awkward shape**, and only then 146 applied
//! through the real runner (`momo_db::migrate::run_migrations`, psql, `--single-transaction`).
//!
//! Each throwaway database is created for the test and dropped after it, so nothing here touches the
//! shared conformance database.
//!
//! The expected values are **written by hand** in [`scenario`] (`expected_readable_seq`), not derived
//! by running the migration's own filter over the seed — a backfill and a test that share a filter
//! agree on a wrong answer.
//!
//! | test | what it pins | sabotage (value-based, ADR 수용 기준 7) |
//! |---|---|---|
//! | `the_backfill_fills_each_channel_with_its_newest_readable_seq` | per-channel values, both tenants, empty and machine-only channels untouched, trigger live afterwards | remove the `kind` condition from the backfill's filter → work-session channel values go red |
//! | `the_row_count_assertion_fails_the_migration_when_the_filter_drifts` | the `DO` block's `GET DIAGNOSTICS` assertion is live: a filter that no longer matches the `EXISTS` recount aborts the migration and rolls it back whole | (the test *is* the sabotage, applied to a copy of the file in memory) |
//! | `the_trigger_is_created_before_the_backfill_runs` | file order: trigger, then backfill (no gap) — runs without a database | swap the two blocks |
//!
//! `SET LOCAL row_security = off` is a safety net, not a bypass (the migration role already bypasses
//! RLS) and is **not** a test subject — ADR 수용 기준 7, 독립 검토 2회차 N1.
//!
//! `#[ignore]` — needs a real Postgres (pgvector/pg18) and a role that may `CREATE DATABASE`:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:20252/momo \
//!   cargo test -p momo-server --test dm_closure_backfill_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use momo_db::migrate::{discover_migrations, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::PgPoolOptions;
use momo_db::PgPool;
use serde_json::{json, Value};
use uuid::Uuid;

const MIGRATION_146: &str = "146_dm_closure.sql";

fn migrations_dir() -> PathBuf {
    momo_db::migrate::default_migrations_dir()
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

/// `DATABASE_URL` with its database name replaced.
fn url_for(database: &str) -> String {
    let url = database_url();
    let (head, _) = url
        .rsplit_once('/')
        .expect("DATABASE_URL ends with /<database>");
    format!("{head}/{database}")
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

async fn admin_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url())
        .await
        .expect("connect to the admin database")
}

/// A throwaway database, dropped (with its connections) when the test finishes.
struct ScratchDb {
    name: String,
    admin: PgPool,
}

impl ScratchDb {
    async fn create(label: &str) -> ScratchDb {
        let admin = admin_pool().await;
        let name = format!(
            "bf4227_{label}_{}",
            &Uuid::new_v4().simple().to_string()[..8]
        );
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .expect("CREATE DATABASE (the role must be allowed to)");
        ScratchDb { name, admin }
    }

    fn url(&self) -> String {
        url_for(&self.name)
    }

    async fn pool(&self) -> PgPool {
        PgPoolOptions::new()
            .max_connections(4)
            .connect(&self.url())
            .await
            .expect("connect to the scratch database")
    }

    async fn drop_it(self) {
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ))
        .execute(&self.admin)
        .await
        .expect("DROP DATABASE");
    }
}

/// A fresh directory holding copies of migrations `001..=145` (production's state before this
/// change), so the real runner can bring a scratch database to that state.
fn pre_146_dir(label: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "migrations-{label}-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir_all(&dir).expect("create scratch migrations dir");
    let mut copied = 0;
    for migration in discover_migrations(&migrations_dir()).expect("discover migrations") {
        if migration.version <= 145 {
            std::fs::copy(&migration.path, dir.join(&migration.name)).expect("copy migration");
            copied += 1;
        }
    }
    assert_eq!(copied, 145, "migrations 001..=145 are all present");
    dir
}

/// Apply one SQL file the way the runner does (`psql --single-transaction`, `ON_ERROR_STOP`),
/// returning (success, stderr). Used for the one case where the test needs psql's error text.
fn apply_sql(database_url: &str, sql_file: &Path) -> (bool, String) {
    let output = Command::new(resolve_psql())
        .arg(database_url)
        .args(["-v", "ON_ERROR_STOP=1"])
        .args(["-v", "MOMO_AGENT_SEED_ENABLED=0"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(sql_file)
        .output()
        .expect("spawn psql");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

// ---------------------------------------------------------------------------
// the seed: two workspaces, awkward channels, hand-written expectations
// ---------------------------------------------------------------------------

/// (seq, message_type, props, state)
type Msg = (i64, &'static str, Value, &'static str);

struct Channel {
    label: &'static str,
    workspace: usize,
    messages: Vec<Msg>,
    /// Written by hand: the newest readable seq, `0` when there is none.
    expected_readable_seq: i64,
}

fn scenario() -> Vec<Channel> {
    let text = |seq: i64| -> Msg { (seq, "text", json!({}), "sent") };
    let work_session = |seq: i64| -> Msg { (seq, "text", json!({"kind": "work_session"}), "sent") };
    vec![
        Channel {
            label: "ws1-mixed-machine-tail",
            workspace: 0,
            // 1,2 readable; 3 work-session card; 4 tool call; 5 system — the newest *readable* is 2.
            messages: vec![
                text(1),
                (2, "text", json!({"kind": "note"}), "sent"),
                work_session(3),
                (4, "tool_call", json!({}), "sent"),
                (5, "system", json!({}), "sent"),
            ],
            expected_readable_seq: 2,
        },
        Channel {
            label: "ws1-plain-text-only",
            workspace: 0,
            // `props` has no `kind`: `props->>'kind'` is NULL. A `<>` filter drops this to 0.
            messages: vec![text(1)],
            expected_readable_seq: 1,
        },
        Channel {
            label: "ws1-machine-only",
            workspace: 0,
            // Nothing readable: the channel must stay at 0 and must not be counted as updated.
            messages: vec![work_session(1), (2, "system", json!({}), "sent")],
            expected_readable_seq: 0,
        },
        Channel {
            label: "ws1-newest-is-deleted",
            workspace: 0,
            // ADR D9: "나중에 삭제된 메시지도 세요" — the backfill counts a deleted message exactly as
            // the live trigger would have when it was inserted.
            messages: vec![text(1), (2, "text", json!({}), "deleted")],
            expected_readable_seq: 2,
        },
        Channel {
            label: "ws1-empty",
            workspace: 0,
            messages: vec![],
            expected_readable_seq: 0,
        },
        Channel {
            label: "ws1-readable-types",
            workspace: 0,
            // diff / artifact / approval_request are readable, whatever their position.
            messages: vec![
                text(1),
                (2, "diff", json!({}), "sent"),
                (3, "artifact", json!({}), "sent"),
                (4, "approval_request", json!({}), "sent"),
                work_session(5),
            ],
            expected_readable_seq: 4,
        },
        Channel {
            label: "ws2-mixed-machine-tail",
            workspace: 1,
            // The other tenant: must be filled in the same pass (the migration walks all tenants).
            messages: vec![
                text(1),
                (2, "tool_result", json!({}), "sent"),
                work_session(3),
            ],
            expected_readable_seq: 1,
        },
        Channel {
            label: "ws2-all-readable",
            workspace: 1,
            messages: vec![text(1), text(2), text(3), text(4)],
            expected_readable_seq: 4,
        },
    ]
}

struct Seeded {
    /// label → channel id
    channels: BTreeMap<&'static str, Uuid>,
}

async fn seed_pre_146(pool: &PgPool, scenario: &[Channel]) -> Seeded {
    let mut workspaces = Vec::new();
    let mut authors = Vec::new();
    for index in 0..2 {
        let workspace = Uuid::new_v4();
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(workspace)
            .bind(format!("backfill-{index}-{workspace}"))
            .execute(pool)
            .await
            .expect("seed workspace");
        let author = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'human', 'seed', $3)",
        )
        .bind(author)
        .bind(workspace)
        .bind(format!("seed-{}", &author.simple().to_string()[..8]))
        .execute(pool)
        .await
        .expect("seed member");
        workspaces.push(workspace);
        authors.push(author);
    }

    let mut channels = BTreeMap::new();
    for channel in scenario {
        let id = Uuid::new_v4();
        let workspace = workspaces[channel.workspace];
        let author = authors[channel.workspace];
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
             VALUES ($1, $2, 'public', $3, '', $4)",
        )
        .bind(id)
        .bind(workspace)
        .bind(channel.label)
        .bind(author)
        .execute(pool)
        .await
        .expect("seed channel");
        let head = channel.messages.iter().map(|m| m.0).max().unwrap_or(0);
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, $3)",
        )
        .bind(id)
        .bind(workspace)
        .bind(head)
        .execute(pool)
        .await
        .expect("seed channel_seq");
        for (seq, message_type, props, state) in &channel.messages {
            sqlx::query(
                "INSERT INTO message \
                   (workspace_id, channel_id, seq, hlc_ts, author_member_id, type, state, props, \
                    deleted_at) \
                 VALUES ($1, $2, $3, $3, $4, $5::message_type, $6::message_state, $7, \
                         CASE WHEN $6 = 'deleted' THEN now() END)",
            )
            .bind(workspace)
            .bind(id)
            .bind(seq)
            .bind(author)
            .bind(message_type)
            .bind(state)
            .bind(props)
            .execute(pool)
            .await
            .expect("seed message");
        }
        channels.insert(channel.label, id);
    }
    Seeded { channels }
}

/// A scratch database brought to the pre-146 state and seeded.
async fn prepared(label: &str) -> (ScratchDb, PgPool, Seeded, PathBuf) {
    let db = ScratchDb::create(label).await;
    let dir = pre_146_dir(label);
    run_migrations(&db.url(), &dir, SeedMode::None).expect("apply migrations 001..=145");
    let pool = db.pool().await;
    // Control: the column the migration adds is not there yet, so what we measure afterwards is
    // 146's doing.
    let has_column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
          WHERE table_name = 'channel_seq' AND column_name = 'last_readable_seq')",
    )
    .fetch_one(&pool)
    .await
    .expect("probe column");
    assert!(!has_column, "the scratch database is at the pre-146 state");
    let seeded = seed_pre_146(&pool, &scenario()).await;
    (db, pool, seeded, dir)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB that may CREATE DATABASE"]
async fn the_backfill_fills_each_channel_with_its_newest_readable_seq() {
    let (db, pool, seeded, dir) = prepared("fill").await;

    // The real runner, the real file.
    std::fs::copy(
        migrations_dir().join(MIGRATION_146),
        dir.join(MIGRATION_146),
    )
    .expect("copy 146");
    let report = run_migrations(&db.url(), &dir, SeedMode::None).expect("apply 146 on seeded data");
    assert_eq!(
        report.applied,
        vec![MIGRATION_146.to_string()],
        "only 146 was new"
    );

    let rows: Vec<(Uuid, i64, i64)> =
        sqlx::query_as("SELECT channel_id, last_seq, last_readable_seq FROM channel_seq")
            .fetch_all(&pool)
            .await
            .expect("read channel_seq");
    let by_id: BTreeMap<Uuid, (i64, i64)> = rows
        .into_iter()
        .map(|(id, last, readable)| (id, (last, readable)))
        .collect();
    // `002_seed.sql` leaves its own channels behind (empty ones, `last_seq` 0): they are not part of
    // the scenario and must come through the backfill still at 0.
    let seeded_ids: Vec<Uuid> = seeded.channels.values().copied().collect();
    assert_eq!(seeded_ids.len(), scenario().len());
    for (id, (last_seq, readable)) in &by_id {
        if !seeded_ids.contains(id) {
            assert_eq!(
                (*last_seq, *readable),
                (0, 0),
                "a channel the scenario does not mention stays untouched"
            );
        }
    }

    let mut updated_channels = 0;
    for channel in scenario() {
        let id = seeded.channels[channel.label];
        let (last_seq, readable) = by_id[&id];
        assert_eq!(
            readable, channel.expected_readable_seq,
            "{}: last_readable_seq (last_seq {last_seq})",
            channel.label
        );
        assert!(
            readable <= last_seq,
            "{}: the readable head never passes the head",
            channel.label
        );
        if channel.expected_readable_seq > 0 {
            updated_channels += 1;
        }
    }
    // Row-count assertion (the test-side twin of the migration's own `GET DIAGNOSTICS` check): the
    // channels with something readable are exactly the ones that moved off 0.
    let moved: i64 =
        sqlx::query_scalar("SELECT count(*) FROM channel_seq WHERE last_readable_seq > 0")
            .fetch_one(&pool)
            .await
            .expect("count moved");
    assert_eq!(moved, updated_channels);
    assert_eq!(
        moved, 6,
        "six of the eight seeded channels hold something readable"
    );
    let untouched: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channel_seq cs JOIN channel c ON c.id = cs.channel_id \
          WHERE cs.last_readable_seq = 0 AND c.name IN ('ws1-machine-only', 'ws1-empty')",
    )
    .fetch_one(&pool)
    .await
    .expect("count untouched");
    assert_eq!(untouched, 2, "machine-only and empty channels stay at 0");

    // 146 left the rest of the world as it was: no closure rows, nothing but channel_seq touched.
    let closures: i64 = sqlx::query_scalar("SELECT count(*) FROM dm_closure")
        .fetch_one(&pool)
        .await
        .expect("count dm_closure");
    assert_eq!(closures, 0, "no row is invented for anyone");

    // And the trigger the backfill followed is live: a new readable message on top of a backfilled
    // channel raises the value, a machine one does not.
    let mixed = seeded.channels["ws1-mixed-machine-tail"];
    let (workspace, author): (Uuid, Uuid) =
        sqlx::query_as("SELECT workspace_id, created_by FROM channel WHERE id = $1")
            .bind(mixed)
            .fetch_one(&pool)
            .await
            .expect("channel owner");
    for (seq, message_type, expected) in [(6_i64, "text", 6_i64), (7, "system", 6), (8, "text", 8)]
    {
        sqlx::query("UPDATE channel_seq SET last_seq = $2 WHERE channel_id = $1")
            .bind(mixed)
            .bind(seq)
            .execute(&pool)
            .await
            .expect("bump the head");
        sqlx::query(
            "INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, author_member_id, type, props) \
             VALUES ($1, $2, $3, $3, $4, $5::message_type, '{}')",
        )
        .bind(workspace)
        .bind(mixed)
        .bind(seq)
        .bind(author)
        .bind(message_type)
        .execute(&pool)
        .await
        .expect("insert after the migration");
        let readable: i64 =
            sqlx::query_scalar("SELECT last_readable_seq FROM channel_seq WHERE channel_id = $1")
                .bind(mixed)
                .fetch_one(&pool)
                .await
                .expect("read");
        assert_eq!(readable, expected, "after a {message_type} at seq {seq}");
    }

    pool.close().await;
    db.drop_it().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The migration's own `DO` block asserts that the backfill `UPDATE` touched exactly the channels
/// an independent `EXISTS` recount says hold something readable. This proves the assertion is
/// **live**: the file is rewritten in memory so the backfill's `kind` condition is gone (the
/// sabotage the ADR names), and applied to a seeded database — it must fail, name the mismatch, and
/// roll the whole migration back (`--single-transaction`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB that may CREATE DATABASE"]
async fn the_row_count_assertion_fails_the_migration_when_the_filter_drifts() {
    let (db, pool, _seeded, dir) = prepared("drift").await;

    let original =
        std::fs::read_to_string(migrations_dir().join(MIGRATION_146)).expect("read migration 146");
    // The backfill's LATERAL filter is the first use of the alias `m.props`; the trigger body uses
    // `NEW.props` and the recount uses `m.props` a second time. Drop only the first.
    let needle = "AND (m.props->>'kind') IS DISTINCT FROM 'work_session'";
    assert!(
        original.matches(needle).count() >= 2,
        "the backfill and its recount both carry the kind condition"
    );
    let drifted = original.replacen(needle, "AND true", 1);
    assert_ne!(drifted, original, "the sabotage actually changed the file");
    let sabotaged = dir.join("146_drifted.sql");
    std::fs::write(&sabotaged, &drifted).expect("write the sabotaged copy");

    let (ok, stderr) = apply_sql(&db.url(), &sabotaged);
    assert!(
        !ok,
        "a backfill whose filter drifted must abort the migration"
    );
    assert!(
        stderr.contains("146 backfill: updated"),
        "the failure is the row-count assertion, not an unrelated error: {stderr}"
    );

    // Atomic: nothing of 146 survives the failed run.
    let column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
          WHERE table_name = 'channel_seq' AND column_name = 'last_readable_seq')",
    )
    .fetch_one(&pool)
    .await
    .expect("probe column");
    let table: bool = sqlx::query_scalar("SELECT to_regclass('public.dm_closure') IS NOT NULL")
        .fetch_one(&pool)
        .await
        .expect("probe table");
    let trigger: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'message_last_readable_seq_trg')",
    )
    .fetch_one(&pool)
    .await
    .expect("probe trigger");
    assert!(
        !column && !table && !trigger,
        "the failed migration rolled back whole: column={column} table={table} trigger={trigger}"
    );

    // Control: the unmodified file applies cleanly on the same database. If this failed too, the
    // failure above would prove nothing about the filter.
    let clean = dir.join("146_clean.sql");
    std::fs::write(&clean, &original).expect("write the clean copy");
    let (ok, stderr) = apply_sql(&db.url(), &clean);
    assert!(ok, "the real migration applies to the same data: {stderr}");

    pool.close().await;
    db.drop_it().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// File order: the trigger exists before the backfill statement runs, so no message can slip
/// between them (ADR D9 「순서」). Text-level on purpose and database-free, so it runs in plain
/// `cargo test --workspace` too.
#[test]
fn the_trigger_is_created_before_the_backfill_runs() {
    let sql = std::fs::read_to_string(migrations_dir().join(MIGRATION_146)).expect("read 146");
    let trigger = sql
        .find("CREATE TRIGGER message_last_readable_seq_trg")
        .expect("the migration creates the trigger");
    let backfill = sql
        .find("UPDATE channel_seq cs")
        .expect("the migration backfills channel_seq");
    let dm_closure = sql
        .find("CREATE TABLE dm_closure")
        .expect("the migration creates dm_closure");
    let row_security = sql
        .find("SET LOCAL row_security = off;")
        .expect("the backfill runs with row_security off");
    assert!(
        trigger < backfill,
        "the trigger (at {trigger}) must be created before the backfill (at {backfill})"
    );
    assert!(
        row_security < backfill,
        "row_security is switched off before the backfill statement"
    );
    let restore = sql
        .find("SET LOCAL row_security = on;")
        .expect("row_security is switched back on");
    assert!(
        backfill < restore && restore < dm_closure,
        "row_security is back on before dm_closure is created"
    );
    assert!(
        sql.contains("IS DISTINCT FROM 'work_session'") && !sql.contains("<> 'work_session'"),
        "the NULL-safe comparison, never `<>`"
    );
    assert!(
        sql.contains("GET DIAGNOSTICS updated = ROW_COUNT"),
        "the backfill asserts its row count"
    );
}
