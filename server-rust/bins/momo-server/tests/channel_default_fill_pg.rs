//! #5837 / ADR-0224 D2·D6·D10 — migration 184 on a database that already holds channels.
//!
//! The other suites run on a database migrated from empty, where the fill has nothing to do. This
//! one builds the state production is in: migrations 001..=183 applied, **four workspaces with
//! channels in every awkward shape**, and only then 184 applied the way the runner applies it
//! (`psql --single-transaction`, `ON_ERROR_STOP`). Each throwaway database is created for the test
//! and dropped after it.
//!
//! The expected marks are **written by hand** in [`scenario`], not derived by running the
//! migration's own choice over the seed.
//!
//! | test | what it pins | sabotage that turns it red |
//! |---|---|---|
//! | `the_fill_picks_one_default_per_workspace_and_lists_only_it` | per channel `(is_default, browse_listed)`: one default per workspace that has a live public channel (a live `general`, else the oldest live public), listed; every other channel off; no default where there is no live public channel; `row_security` back on before the commit; a re-run changes nothing and keeps later choices; both CHECKs refuse a private channel and a DM | drop `browse_listed = true` from the fill; drop a CHECK; drop the closing `SET LOCAL row_security = on` |
//! | `the_row_count_assertion_aborts_a_fill_that_picks_more_than_one_per_workspace` | the `DO` block's `GET DIAGNOSTICS` assertion is live: a choice that no longer picks one row per workspace aborts the migration and rolls it back whole | drop the `IF updated <> expected` assertion |
//!
//! #5909 / migration 186 — the same fill as a safety net, on a database where 184 left the columns but
//! no default channel (what 184 does when it runs outside one transaction under a role that cannot
//! bypass row security). Seeded with the same hand-written table.
//!
//! | test | what it pins | sabotage that turns it red |
//! |---|---|---|
//! | `the_186_fill_repairs_a_database_without_defaults_by_either_route` | one transaction and autocommit `psql -f` both leave the hand-written marks; row_security back on; a re-run moves nothing and keeps an admin's later choices | drop the fill's choice or listing |
//! | `the_186_fill_stops_loudly_for_a_role_that_cannot_bypass_row_security` | a NOBYPASSRLS table owner gets an error, not exit 0, and no mark moves — in autocommit and in one transaction | drop the `set_config('row_security', 'off', …)` line |
//! | `the_186_row_count_assertion_aborts_a_fill_that_picks_more_than_one_per_workspace` | the assertion is live in 186 | drop the `IF updated <> expected` assertion |
//!
//! `#[ignore]` — needs a real Postgres (pgvector/pg18) and a role that may `CREATE DATABASE`:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test channel_default_fill_pg -- --ignored --test-threads=1
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use momo_db::migrate::{discover_migrations, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::PgPoolOptions;
use momo_db::PgPool;
use uuid::Uuid;

const MIGRATION_184: &str = "184_channel_browse_listed_and_default.sql";
const MIGRATION_186: &str = "186_channel_default_fill_safety_net.sql";

fn migrations_dir() -> PathBuf {
    momo_db::migrate::default_migrations_dir()
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

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

struct ScratchDb {
    name: String,
    admin: PgPool,
}

impl ScratchDb {
    async fn create(label: &str) -> ScratchDb {
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url())
            .await
            .expect("connect to the admin database");
        let name = format!(
            "fill5837_{label}_{}",
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

/// Copies of migrations `001..=183` (production's state before this change).
fn pre_184_dir(label: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "migrations-5837-{label}-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir_all(&dir).expect("create scratch migrations dir");
    let mut copied = 0;
    for migration in discover_migrations(&migrations_dir()).expect("discover migrations") {
        if migration.version <= 183 {
            std::fs::copy(&migration.path, dir.join(&migration.name)).expect("copy migration");
            copied += 1;
        }
    }
    assert_eq!(copied, 183, "migrations 001..=183 are all present");
    dir
}

/// Run a psql script the way the runner applies a migration (`--single-transaction`,
/// `ON_ERROR_STOP`), returning (success, stdout, stderr).
fn run_psql(
    database_url: &str,
    sql_file: &Path,
    single_transaction: bool,
) -> (bool, String, String) {
    let mut command = Command::new(resolve_psql());
    command
        .arg(database_url)
        .args(["-v", "ON_ERROR_STOP=1", "-v", "MOMO_AGENT_SEED_ENABLED=0"])
        .args(["--no-psqlrc", "--quiet", "--tuples-only", "--no-align"]);
    if single_transaction {
        command.arg("--single-transaction");
    }
    let output = command
        .arg("-f")
        .arg(sql_file)
        .output()
        .expect("spawn psql");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

/// Copies of migrations `001..=184`: the state 184 leaves when its fill found nothing.
fn through_184_dir(label: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "migrations-5909-{label}-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir_all(&dir).expect("create scratch migrations dir");
    let mut copied = 0;
    for migration in discover_migrations(&migrations_dir()).expect("discover migrations") {
        if migration.version <= 184 {
            std::fs::copy(&migration.path, dir.join(&migration.name)).expect("copy migration");
            copied += 1;
        }
    }
    assert_eq!(copied, 184, "migrations 001..=184 are all present");
    dir
}

// ---------------------------------------------------------------------------
// the seed: four workspaces, hand-written expectations
// ---------------------------------------------------------------------------

struct Seeded {
    /// label → channel id
    channels: BTreeMap<&'static str, Uuid>,
    /// label → (is_default, browse_listed) after 184, written by hand
    expected: BTreeMap<&'static str, (bool, bool)>,
}

/// (label, workspace index, kind, name, age in days — bigger is older, archived, expected
/// (is_default, browse_listed))
type Row = (
    &'static str,
    usize,
    &'static str,
    &'static str,
    i32,
    bool,
    (bool, bool),
);

fn scenario() -> Vec<Row> {
    vec![
        // ws0 — a live `general` that is neither the oldest public channel nor the only `general`.
        (
            "w0-archived-general",
            0,
            "public",
            "general",
            40,
            true,
            (false, false),
        ),
        (
            "w0-older-public",
            0,
            "public",
            "old-pub",
            20,
            false,
            (false, false),
        ),
        (
            "w0-general",
            0,
            "public",
            "general",
            10,
            false,
            (true, true),
        ),
        (
            "w0-newer-public",
            0,
            "public",
            "new-pub",
            5,
            false,
            (false, false),
        ),
        (
            "w0-private",
            0,
            "private",
            "secret",
            50,
            false,
            (false, false),
        ),
        ("w0-dm", 0, "dm", "", 60, false, (false, false)),
        // ws1 — `general` archived: the oldest LIVE public channel (Hangul name), not the older
        // private one.
        (
            "w1-private",
            1,
            "private",
            "p-first",
            60,
            false,
            (false, false),
        ),
        (
            "w1-archived-general",
            1,
            "public",
            "general",
            50,
            true,
            (false, false),
        ),
        (
            "w1-oldest-live-public",
            1,
            "public",
            "공지",
            40,
            false,
            (true, true),
        ),
        (
            "w1-newer-public",
            1,
            "public",
            "dev",
            30,
            false,
            (false, false),
        ),
        // ws2 — no public channel at all: no default.
        (
            "w2-private",
            2,
            "private",
            "only",
            30,
            false,
            (false, false),
        ),
        // ws3 — only an archived public channel: no default (the fill takes live channels only).
        (
            "w3-archived-public",
            3,
            "public",
            "general",
            30,
            true,
            (false, false),
        ),
    ]
}

async fn seed_pre_184(pool: &PgPool) -> Seeded {
    let mut tx = pool.begin().await.expect("begin seed");
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .expect("seed as owner");
    let workspaces: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
    for (index, id) in workspaces.iter().enumerate() {
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(id)
            .bind(format!(
                "fill5837-{index}-{}",
                &id.simple().to_string()[..8]
            ))
            .execute(&mut *tx)
            .await
            .expect("seed workspace");
    }
    let mut channels = BTreeMap::new();
    let mut expected = BTreeMap::new();
    for (label, ws, kind, name, age, archived, marks) in scenario() {
        let id = Uuid::new_v4();
        let (name, dm_key) = if kind == "dm" {
            (None, Some(format!("dm-{}", id.simple())))
        } else {
            (Some(name), None)
        };
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, dm_key, created_at, archived_at) \
             VALUES ($1, $2, $3::channel_kind, $4, $5, now() - make_interval(days => $6), \
                     CASE WHEN $7 THEN now() ELSE NULL END)",
        )
        .bind(id)
        .bind(workspaces[ws])
        .bind(kind)
        .bind(name)
        .bind(dm_key)
        .bind(age)
        .bind(archived)
        .execute(&mut *tx)
        .await
        .expect("seed channel");
        channels.insert(label, id);
        expected.insert(label, marks);
    }
    tx.commit().await.expect("commit seed");
    Seeded { channels, expected }
}

async fn marks(pool: &PgPool, seeded: &Seeded) -> BTreeMap<&'static str, (bool, bool)> {
    let mut out = BTreeMap::new();
    for (label, id) in &seeded.channels {
        let row: (bool, bool) =
            sqlx::query_as("SELECT is_default, browse_listed FROM channel WHERE id = $1")
                .bind(id)
                .fetch_one(pool)
                .await
                .expect("read marks");
        out.insert(*label, row);
    }
    out
}

async fn has_column(pool: &PgPool, column: &str) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
          WHERE table_name = 'channel' AND column_name = $1)",
    )
    .bind(column)
    .fetch_one(pool)
    .await
    .expect("probe column")
}

async fn prepared(label: &str) -> (ScratchDb, PgPool, Seeded, PathBuf) {
    let db = ScratchDb::create(label).await;
    let dir = pre_184_dir(label);
    run_migrations(&db.url(), &dir, SeedMode::None).expect("apply migrations 001..=183");
    let pool = db.pool().await;
    assert!(
        !has_column(&pool, "is_default").await && !has_column(&pool, "browse_listed").await,
        "the scratch database is at the pre-184 state"
    );
    let seeded = seed_pre_184(&pool).await;
    (db, pool, seeded, dir)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB that may CREATE DATABASE"]
async fn the_fill_picks_one_default_per_workspace_and_lists_only_it() {
    let (db, pool, seeded, dir) = prepared("fill").await;
    let migration = migrations_dir().join(MIGRATION_184);

    let (ok, _, stderr) = run_psql(&db.url(), &migration, true);
    assert!(ok, "184 applies to a populated database: {stderr}");
    assert_eq!(
        marks(&pool, &seeded).await,
        seeded.expected,
        "per channel (is_default, browse_listed), against the hand-written table"
    );

    // `row_security` is back on before the transaction ends: the switch is the migration's own
    // safety net and must not outlive the fill inside the transaction it runs in.
    let probe = dir.join("184_row_security_probe.sql");
    std::fs::write(
        &probe,
        format!(
            "BEGIN;\n\\i {}\nSHOW row_security;\nROLLBACK;\n",
            migration.display()
        ),
    )
    .expect("write probe");
    let (ok, stdout, stderr) = run_psql(&db.url(), &probe, false);
    assert!(ok, "the probe ran: {stderr}");
    assert_eq!(
        stdout.lines().rfind(|line| !line.trim().is_empty()),
        Some("on"),
        "row_security after the fill, same transaction: {stdout}"
    );

    // A re-run is a no-op, and it does not undo a later choice: an admin made a second default
    // channel and turned listing off on the first.
    let (w1_default, w1_newer) = (
        seeded.channels["w1-oldest-live-public"],
        seeded.channels["w1-newer-public"],
    );
    sqlx::query("UPDATE channel SET browse_listed = false WHERE id = $1")
        .bind(w1_default)
        .execute(&pool)
        .await
        .expect("an admin unlists the default");
    sqlx::query("UPDATE channel SET is_default = true WHERE id = $1")
        .bind(w1_newer)
        .execute(&pool)
        .await
        .expect("an admin adds a default");
    let before_rerun = marks(&pool, &seeded).await;
    let (ok, _, stderr) = run_psql(&db.url(), &migration, true);
    assert!(ok, "184 runs again cleanly: {stderr}");
    assert_eq!(
        marks(&pool, &seeded).await,
        before_rerun,
        "a re-run moved a mark"
    );

    // Both marks are public-only: a private channel and a DM refuse each of them.
    for label in ["w0-private", "w0-dm"] {
        for column in ["browse_listed", "is_default"] {
            let refused = sqlx::query(&format!("UPDATE channel SET {column} = true WHERE id = $1"))
                .bind(seeded.channels[label])
                .execute(&pool)
                .await
                .expect_err("a non-public channel cannot carry the mark");
            let code = refused
                .as_database_error()
                .and_then(|error| error.code().map(|code| code.to_string()));
            assert_eq!(
                code.as_deref(),
                Some("23514"),
                "{label}.{column}: {refused}"
            );
        }
    }

    pool.close().await;
    db.drop_it().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB that may CREATE DATABASE"]
async fn the_row_count_assertion_aborts_a_fill_that_picks_more_than_one_per_workspace() {
    let (db, pool, seeded, dir) = prepared("drift").await;

    let original =
        std::fs::read_to_string(migrations_dir().join(MIGRATION_184)).expect("read migration 184");
    // The choice keeps one row per workspace with `DISTINCT ON`. Without it the UPDATE takes every
    // live public channel, and only the assertion stands between that and a committed fill.
    let needle = "SELECT DISTINCT ON (candidate.workspace_id) candidate.id";
    assert_eq!(
        original.matches(needle).count(),
        1,
        "the choice is written once"
    );
    let drifted = original.replacen(needle, "SELECT candidate.id", 1);
    let sabotaged = dir.join("184_drifted.sql");
    std::fs::write(&sabotaged, &drifted).expect("write the sabotaged copy");

    let (ok, _, stderr) = run_psql(&db.url(), &sabotaged, true);
    assert!(
        !ok,
        "a fill that picks several channels per workspace must abort"
    );
    assert!(
        stderr.contains("184 default-channel fill: updated"),
        "the failure is the row-count assertion, not an unrelated error: {stderr}"
    );
    assert!(
        !has_column(&pool, "is_default").await && !has_column(&pool, "browse_listed").await,
        "the failed migration rolled back whole"
    );

    // Control: the unmodified file applies to the same data.
    let (ok, _, stderr) = run_psql(&db.url(), &migrations_dir().join(MIGRATION_184), true);
    assert!(ok, "the real migration applies to the same data: {stderr}");
    assert_eq!(marks(&pool, &seeded).await, seeded.expected);

    pool.close().await;
    db.drop_it().await;
    let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------------------
// migration 186 (#5909)
// ---------------------------------------------------------------------------

/// A database at 184 whose channels all carry the columns' default (false, false): the state a
/// fill that saw no rows leaves behind. The seed is the same four workspaces.
async fn prepared_at_184(label: &str) -> (ScratchDb, PgPool, Seeded, PathBuf) {
    let db = ScratchDb::create(label).await;
    let dir = through_184_dir(label);
    run_migrations(&db.url(), &dir, SeedMode::None).expect("apply migrations 001..=184");
    let pool = db.pool().await;
    let seeded = seed_pre_184(&pool).await;
    let none: BTreeMap<&str, (bool, bool)> = seeded
        .channels
        .keys()
        .map(|label| (*label, (false, false)))
        .collect();
    assert_eq!(
        marks(&pool, &seeded).await,
        none,
        "the seed starts with no default channel anywhere"
    );
    (db, pool, seeded, dir)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB that may CREATE DATABASE"]
async fn the_186_fill_repairs_a_database_without_defaults_by_either_route() {
    let migration = migrations_dir().join(MIGRATION_186);
    for single_transaction in [true, false] {
        let (db, pool, seeded, dir) = prepared_at_184("fix").await;

        let (ok, _, stderr) = run_psql(&db.url(), &migration, single_transaction);
        assert!(
            ok,
            "186 applies (single transaction: {single_transaction}): {stderr}"
        );
        assert_eq!(
            marks(&pool, &seeded).await,
            seeded.expected,
            "per channel (is_default, browse_listed), single transaction: {single_transaction}"
        );

        // The switch does not outlive the fill inside the transaction it ran in.
        let probe = dir.join("186_row_security_probe.sql");
        std::fs::write(
            &probe,
            format!(
                "BEGIN;\n\\i {}\nSHOW row_security;\nROLLBACK;\n",
                migration.display()
            ),
        )
        .expect("write probe");
        let (ok, stdout, stderr) = run_psql(&db.url(), &probe, false);
        assert!(ok, "the probe ran: {stderr}");
        assert_eq!(
            stdout.lines().rfind(|line| !line.trim().is_empty()),
            Some("on"),
            "row_security after the fill, same transaction: {stdout}"
        );

        // A re-run moves nothing and keeps a later admin choice: the default of ws1 was unlisted
        // and a second default was added.
        let (w1_default, w1_newer) = (
            seeded.channels["w1-oldest-live-public"],
            seeded.channels["w1-newer-public"],
        );
        sqlx::query("UPDATE channel SET browse_listed = false WHERE id = $1")
            .bind(w1_default)
            .execute(&pool)
            .await
            .expect("an admin unlists the default");
        sqlx::query("UPDATE channel SET is_default = true WHERE id = $1")
            .bind(w1_newer)
            .execute(&pool)
            .await
            .expect("an admin adds a default");
        let before_rerun = marks(&pool, &seeded).await;
        let (ok, _, stderr) = run_psql(&db.url(), &migration, single_transaction);
        assert!(ok, "186 runs again cleanly: {stderr}");
        assert_eq!(
            marks(&pool, &seeded).await,
            before_rerun,
            "a re-run moved a mark"
        );

        pool.close().await;
        db.drop_it().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB that may CREATE DATABASE"]
async fn the_186_fill_stops_loudly_for_a_role_that_cannot_bypass_row_security() {
    let migration = migrations_dir().join(MIGRATION_186);
    let (db, pool, seeded, dir) = prepared_at_184("loud").await;

    // The table's owner without BYPASSRLS: FORCE RLS applies to it, and with no `app.workspace_id`
    // it sees no channel. 184 ran like this reads 0 = 0 and passes.
    let role = format!("fill5909_{}", &Uuid::new_v4().simple().to_string()[..8]);
    let admin = db.admin.clone();
    sqlx::query(&format!(
        "CREATE ROLE {role} LOGIN PASSWORD 'fill5909-pw' NOSUPERUSER NOBYPASSRLS"
    ))
    .execute(&admin)
    .await
    .expect("create the role");
    sqlx::query(&format!("ALTER TABLE channel OWNER TO {role}"))
        .execute(&pool)
        .await
        .expect("make it the owner");
    let (head, rest) = db
        .url()
        .split_once("://")
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .unwrap();
    let (_, host_and_db) = rest
        .rsplit_once('@')
        .expect("DATABASE_URL carries credentials");
    let as_role = format!("{head}://{role}:fill5909-pw@{host_and_db}");

    let none: BTreeMap<&str, (bool, bool)> = seeded
        .channels
        .keys()
        .map(|label| (*label, (false, false)))
        .collect();
    for single_transaction in [false, true] {
        let (ok, _, stderr) = run_psql(&as_role, &migration, single_transaction);
        assert!(
            !ok,
            "a role that cannot bypass row security must fail, not pass with 0 rows \
             (single transaction: {single_transaction})"
        );
        assert!(
            stderr.contains("row-level security"),
            "the failure is the row-security error: {stderr}"
        );
        assert_eq!(
            marks(&pool, &seeded).await,
            none,
            "a failed run moved a mark (single transaction: {single_transaction})"
        );
    }

    // Control: the same file as the superuser fills the same data.
    let (ok, _, stderr) = run_psql(&db.url(), &migration, false);
    assert!(ok, "186 applies as the superuser: {stderr}");
    assert_eq!(marks(&pool, &seeded).await, seeded.expected);

    pool.close().await;
    db.drop_it().await;
    sqlx::query(&format!("DROP ROLE IF EXISTS {role}"))
        .execute(&admin)
        .await
        .expect("drop the role");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB that may CREATE DATABASE"]
async fn the_186_row_count_assertion_aborts_a_fill_that_picks_more_than_one_per_workspace() {
    let (db, pool, seeded, dir) = prepared_at_184("drift186").await;

    let original =
        std::fs::read_to_string(migrations_dir().join(MIGRATION_186)).expect("read migration 186");
    let needle = "SELECT DISTINCT ON (candidate.workspace_id) candidate.id";
    assert_eq!(
        original.matches(needle).count(),
        1,
        "the choice is written once"
    );
    let sabotaged = dir.join("186_drifted.sql");
    std::fs::write(
        &sabotaged,
        original.replacen(needle, "SELECT candidate.id", 1),
    )
    .expect("write the sabotaged copy");

    let (ok, _, stderr) = run_psql(&db.url(), &sabotaged, false);
    assert!(
        !ok,
        "a fill that picks several channels per workspace must abort"
    );
    assert!(
        stderr.contains("186 default-channel fill: updated"),
        "the failure is the row-count assertion: {stderr}"
    );
    let none: BTreeMap<&str, (bool, bool)> = seeded
        .channels
        .keys()
        .map(|label| (*label, (false, false)))
        .collect();
    assert_eq!(
        marks(&pool, &seeded).await,
        none,
        "the aborted fill left a mark behind"
    );

    pool.close().await;
    db.drop_it().await;
    let _ = std::fs::remove_dir_all(dir);
}
