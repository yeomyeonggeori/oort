//! Migration runner — applies the existing 60 SQL files **in place, unmodified**
//! via `psql`, matching `scripts/migrate.sh` (L4 §8.7 canonical mechanism).
//!
//! ADR-0145 / D2 §3: the 60 migrations under `server/Migrations/NNN_*.sql` are
//! Postgres DDL, language independent, and are the enforcement layer we inherit.
//!
//! **Why psql, not `sqlx::raw_sql`.** Several seed migrations (002/006/012) use
//! psql *client* meta-commands — `\if :MOMO_AGENT_SEED_ENABLED … \else … \endif`
//! — which the wire protocol does not understand. Sending those files straight
//! to the server (as `sqlx::raw_sql` did) fails at the first `\if` with
//! `42601 syntax error at "\"`. psql is already the canonical migration
//! dependency (§8.7 / `scripts/migrate.sh`), so this is no new dependency; we
//! shell out to it and never reimplement its meta-command handling.
//!
//! This runner discovers the files, orders them by their numeric `NNN` prefix,
//! and applies each with `psql <conn> -v ON_ERROR_STOP=1
//! -v MOMO_AGENT_SEED_ENABLED=<0|1> --no-psqlrc --quiet --single-transaction -f`
//! — the exact flags `migrate.sh` uses. It never edits, copies, or reorders a
//! file (hard rule). `schema_v0.sql` is a duplicate snapshot of `001` and is
//! intentionally NOT under this directory, so it is never a target.
//!
//! **Idempotent `schema_migrations` tracking (B1.6).** The runner reproduces
//! `scripts/migrate.sh`'s skip judgement (`migrate.sh:102-143`) measured
//! one-for-one:
//!   * the tracking table is the *runner's*, not a migration's — no file under
//!     `server/Migrations/` creates `schema_migrations` (007 only mentions it in
//!     a comment), so `migrate.sh:104-109` issues the `CREATE TABLE IF NOT
//!     EXISTS` itself and so does [`run_migrations`];
//!   * `version` is the **full filename** including the `NNN_` prefix and the
//!     `.sql` extension (`version=$(basename "$f")`, :122) — which is why
//!     `scripts/check_migration_numbers.sh` exists: two files sharing a numeric
//!     prefix would both apply;
//!   * a version already present → `SKIP`; only a new one is applied, and the
//!     file plus its `INSERT INTO schema_migrations` go in **one**
//!     `--single-transaction` psql invocation (:137-139), so a half-applied
//!     migration can never be recorded as done.
//!
//! Consequence for the test harnesses: a second run against an already-migrated
//! database is a no-op ([`MigrationReport::applied`] empty), so conformance
//! binaries may share one database instead of each needing a throwaway one.
//! `migrate.sh`'s in-process verify pass (:150-158) is deliberately NOT
//! duplicated here — the `momo-db` conformance test runs the runner twice for
//! real, which is the stronger form of the same evidence.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::DbError;

/// Agent-seed selection, mapped exactly as `scripts/migrate.sh` maps
/// `MOMO_AGENT_SEED_MODE` → `MOMO_AGENT_SEED_ENABLED` (`none`→0, `demo`/`e2e`→1).
/// The seed migrations gate their product-data fixtures on this psql variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SeedMode {
    /// Product default — no legacy agent fixtures (`MOMO_AGENT_SEED_ENABLED=0`).
    #[default]
    None,
    /// Deterministic demo fixtures (`=1`).
    Demo,
    /// Deterministic e2e fixtures (`=1`).
    E2e,
}

impl SeedMode {
    /// The `0|1` value passed to psql as `-v MOMO_AGENT_SEED_ENABLED=<v>`.
    fn enabled_flag(self) -> &'static str {
        match self {
            SeedMode::None => "0",
            SeedMode::Demo | SeedMode::E2e => "1",
        }
    }
}

/// One discovered migration file. `version` is the parsed `NNN` prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub version: i64,
    pub name: String,
    pub path: PathBuf,
}

/// The canonical migrations directory, resolved relative to this crate at
/// compile time: `server-rust/crates/momo-db` → repo root → `server/Migrations`.
pub fn default_migrations_dir() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../server/Migrations"
    ))
}

/// Discover and order the migration files in `dir` by numeric prefix.
///
/// Files without an `NNN_` integer prefix (e.g. a stray `schema_v0.sql`) are
/// skipped, so the runner is robust to non-migration `.sql` siblings.
pub fn discover_migrations(dir: &Path) -> Result<Vec<Migration>, DbError> {
    let entries = std::fs::read_dir(dir).map_err(|source| DbError::MigrationIo {
        path: dir.display().to_string(),
        source,
    })?;

    let mut migrations = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| DbError::MigrationIo {
            path: dir.display().to_string(),
            source,
        })?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| DbError::MigrationName(path.display().to_string()))?;

        // Expect `<version>_<description>.sql`. A missing numeric prefix means
        // this is not a versioned migration (skip, don't error).
        let Some((prefix, _rest)) = file_name.split_once('_') else {
            continue;
        };
        let Ok(version) = prefix.parse::<i64>() else {
            continue;
        };
        migrations.push(Migration {
            version,
            name: file_name.to_string(),
            path,
        });
    }

    migrations.sort_by_key(|m| m.version);
    Ok(migrations)
}

/// Locate the `psql` binary. Mirrors `migrate.sh`: PATH first (`command -v
/// psql`), then the Homebrew keg-only libpq locations.
fn resolve_psql() -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// The tracking table `scripts/migrate.sh:104-109` creates before its first
/// skip judgement. No migration file owns it, so the runner must.
const SCHEMA_MIGRATIONS_DDL: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (\
   version     text PRIMARY KEY, \
   applied_at  timestamptz NOT NULL DEFAULT now() \
 )";

/// What one [`run_migrations`] call did, in file order. The counts are the
/// runner's own `applied`/`skipped` tally (`migrate.sh:142`), and the pair is
/// what makes idempotency assertable: a second run must report
/// `applied.is_empty()`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Versions (filenames) this call applied and recorded.
    pub applied: Vec<String>,
    /// Versions already present in `schema_migrations` and therefore skipped.
    pub skipped: Vec<String>,
}

impl MigrationReport {
    /// Every version the runner considered, applied or skipped.
    pub fn total(&self) -> usize {
        self.applied.len() + self.skipped.len()
    }
}

/// Escape a SQL string literal (double any single quote). Versions are
/// filenames from disk, never user input, but a quoted literal is built here so
/// the runner cannot be surprised by a pathological filename.
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// One psql invocation with the flags `migrate.sh` uses on every call
/// (`PSQL_FLAGS`, :100): stop on the first error, pass the seed variable, no
/// psqlrc, quiet.
fn psql_command(psql: &Path, database_url: &str, seed_flag: &str) -> Command {
    let mut command = Command::new(psql);
    // Connection URI as the first positional arg, like migrate.sh
    // (`$PSQL_BIN ${DATABASE_URL}`).
    command
        .arg(database_url)
        .args(["-v", "ON_ERROR_STOP=1"])
        .args(["-v", seed_flag])
        .arg("--no-psqlrc")
        .arg("--quiet");
    command
}

/// Has `version` already been applied? Mirrors `migrate.sh:125-127`, including
/// its tolerance: a failed probe (`|| true`) is read as "not applied", so the
/// error surfaces on the apply attempt with the offending file named.
fn is_applied(
    psql: &Path,
    database_url: &str,
    seed_flag: &str,
    version: &str,
) -> Result<bool, DbError> {
    let output = psql_command(psql, database_url, seed_flag)
        .arg("-tA")
        .arg("-c")
        .arg(format!(
            "SELECT 1 FROM schema_migrations WHERE version = {};",
            sql_literal(version)
        ))
        .output()
        .map_err(|source| DbError::PsqlSpawn {
            psql: psql.display().to_string(),
            source,
        })?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "1")
}

/// Apply every not-yet-applied migration in order against `database_url` via
/// `psql`, recording each in `schema_migrations`.
///
/// Idempotent by the same judgement `scripts/migrate.sh` uses: already-applied
/// versions are skipped, only new ones are applied, and the file plus its
/// history row commit together in ONE `--single-transaction` psql invocation
/// (`migrate.sh:137-139`) — so an interrupted migration is never recorded as
/// done and simply re-applies on the next run. psql (not `sqlx::raw_sql`)
/// interprets the seed files' backslash meta-commands (`\if`, `\set`, …);
/// `seed_mode` selects the agent-seed fixtures (default [`SeedMode::None`] =
/// disabled).
///
/// Returns [`DbError::PsqlNotFound`] if no psql client is installed, and
/// [`DbError::MigrationFailed`] with the offending file + exit code on the first
/// migration psql rejects.
pub fn run_migrations(
    database_url: &str,
    dir: &Path,
    seed_mode: SeedMode,
) -> Result<MigrationReport, DbError> {
    let psql = resolve_psql().ok_or(DbError::PsqlNotFound)?;
    let seed_flag = format!("MOMO_AGENT_SEED_ENABLED={}", seed_mode.enabled_flag());

    // The tracking table belongs to the runner (no migration creates it).
    let status = psql_command(&psql, database_url, &seed_flag)
        .arg("-c")
        .arg(SCHEMA_MIGRATIONS_DDL)
        .status()
        .map_err(|source| DbError::PsqlSpawn {
            psql: psql.display().to_string(),
            source,
        })?;
    if !status.success() {
        return Err(DbError::MigrationFailed {
            version: "schema_migrations (tracking table)".to_string(),
            code: status.code(),
        });
    }

    let mut report = MigrationReport::default();
    for migration in discover_migrations(dir)? {
        if is_applied(&psql, database_url, &seed_flag, &migration.name)? {
            report.skipped.push(migration.name);
            continue;
        }

        // The file and its history row are one transaction: psql runs `-f` and
        // `-c` in the order given, under a single `--single-transaction`.
        let status = psql_command(&psql, database_url, &seed_flag)
            .arg("--single-transaction")
            .arg("-f")
            .arg(&migration.path)
            .arg("-c")
            .arg(format!(
                "INSERT INTO schema_migrations (version) VALUES ({});",
                sql_literal(&migration.name)
            ))
            .status()
            .map_err(|source| DbError::PsqlSpawn {
                psql: psql.display().to_string(),
                source,
            })?;

        if !status.success() {
            return Err(DbError::MigrationFailed {
                version: migration.name,
                code: status.code(),
            });
        }
        report.applied.push(migration.name);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Structural conformance without a DB: the on-disk migration set is exactly
    /// 001..=060, contiguous, correctly ordered, and starts at `001_init`.
    ///
    /// 060 is ADR-0146's `action_signature` sidecar — the first migration this
    /// rewrite added rather than inherited (B2.5).
    #[test]
    fn discovers_contiguous_migrations_001_to_060() {
        let dir = default_migrations_dir();
        let migrations = discover_migrations(&dir).expect("migrations directory readable");

        assert_eq!(
            migrations.len(),
            60,
            "expected 60 migrations under {}",
            dir.display()
        );
        assert_eq!(migrations.first().unwrap().version, 1);
        assert_eq!(migrations.last().unwrap().version, 60);
        assert!(migrations.first().unwrap().name.starts_with("001_init"));

        for (i, migration) in migrations.iter().enumerate() {
            assert_eq!(
                migration.version,
                (i as i64) + 1,
                "migrations must be contiguous and sorted; gap/dupe near {}",
                migration.name
            );
        }
    }

    #[test]
    fn seed_mode_maps_like_migrate_sh() {
        assert_eq!(SeedMode::None.enabled_flag(), "0");
        assert_eq!(SeedMode::Demo.enabled_flag(), "1");
        assert_eq!(SeedMode::E2e.enabled_flag(), "1");
        assert_eq!(SeedMode::default(), SeedMode::None);
    }

    /// `migrate.sh` tracks the **filename**, not the numeric prefix
    /// (`version=$(basename "$f")`, :122). Tracking the number instead would
    /// make a renamed file re-apply, and `check_migration_numbers.sh` — which
    /// exists precisely because two files with the same prefix would both apply
    /// — would be pointless.
    #[test]
    fn tracked_version_is_the_full_filename() {
        let migrations = discover_migrations(&default_migrations_dir()).expect("discover");
        let first = migrations.first().expect("at least one migration");
        assert!(
            first.name.starts_with("001_") && first.name.ends_with(".sql"),
            "version must be the basename incl. prefix and extension, got {}",
            first.name
        );
    }

    #[test]
    fn version_literals_are_quoted_and_escaped() {
        assert_eq!(sql_literal("001_init.sql"), "'001_init.sql'");
        assert_eq!(sql_literal("odd'name.sql"), "'odd''name.sql'");
    }

    /// The tracking table is the runner's own: no file under
    /// `server/Migrations/` creates `schema_migrations` (007 mentions it in a
    /// comment only), so a runner that skipped this DDL would fail its first
    /// skip probe on a fresh DB.
    #[test]
    fn the_runner_owns_the_tracking_table() {
        assert!(SCHEMA_MIGRATIONS_DDL.contains("CREATE TABLE IF NOT EXISTS schema_migrations"));
        assert!(
            SCHEMA_MIGRATIONS_DDL.contains("version")
                && SCHEMA_MIGRATIONS_DDL.contains("PRIMARY KEY"),
            "version is the primary key — the uniqueness that makes SKIP sound"
        );

        let dir = default_migrations_dir();
        let creators: Vec<String> = discover_migrations(&dir)
            .expect("discover")
            .into_iter()
            .filter(|migration| {
                std::fs::read_to_string(&migration.path)
                    .map(|sql| {
                        sql.to_lowercase()
                            .contains("create table if not exists schema_migrations")
                            || sql
                                .to_lowercase()
                                .contains("create table schema_migrations")
                    })
                    .unwrap_or(false)
            })
            .map(|migration| migration.name)
            .collect();
        assert!(
            creators.is_empty(),
            "no migration may create schema_migrations (the runner does); found {creators:?}"
        );
    }

    #[test]
    fn a_report_counts_every_considered_version() {
        let report = MigrationReport {
            applied: vec!["001_init.sql".to_string()],
            skipped: vec!["002_seed.sql".to_string(), "003_x.sql".to_string()],
        };
        assert_eq!(report.total(), 3);
        assert_eq!(MigrationReport::default().total(), 0);
    }
}
