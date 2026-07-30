//! Migration runner — applies the existing 59 SQL files **in place, unmodified**
//! via `psql`, matching `scripts/migrate.sh` (L4 §8.7 canonical mechanism).
//!
//! ADR-0145 / D2 §3: the 59 migrations under `server/Migrations/NNN_*.sql` are
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
//! Idempotent `schema_migrations` tracking (migrate.sh's skip/verify passes) is
//! a B1 concern; B0 targets a fresh DB (the orchestrator gate), applying
//! 001..059 once.

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

/// Apply every discovered migration in order against `database_url` via `psql`.
///
/// Each file is applied in its own transaction (`--single-transaction`), exactly
/// as `scripts/migrate.sh` does, with the psql client interpreting any backslash
/// meta-commands (`\if`, `\set`, …). `seed_mode` selects the agent-seed fixtures
/// (default [`SeedMode::None`] = disabled). Intended for a fresh DB in the
/// orchestrator's conformance harness.
///
/// Returns [`DbError::PsqlNotFound`] if no psql client is installed, and
/// [`DbError::MigrationFailed`] with the offending file + exit code on the first
/// migration psql rejects.
pub fn run_migrations(database_url: &str, dir: &Path, seed_mode: SeedMode) -> Result<(), DbError> {
    let psql = resolve_psql().ok_or(DbError::PsqlNotFound)?;
    let seed_flag = format!("MOMO_AGENT_SEED_ENABLED={}", seed_mode.enabled_flag());

    for migration in discover_migrations(dir)? {
        let status = Command::new(&psql)
            // Connection URI as the first positional arg, like migrate.sh
            // (`$PSQL_BIN ${DATABASE_URL}`).
            .arg(database_url)
            .args(["-v", "ON_ERROR_STOP=1"])
            .args(["-v", &seed_flag])
            .arg("--no-psqlrc")
            .arg("--quiet")
            .arg("--single-transaction")
            .arg("-f")
            .arg(&migration.path)
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
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Structural conformance without a DB: the on-disk migration set is exactly
    /// 001..=059, contiguous, correctly ordered, and starts at `001_init`.
    #[test]
    fn discovers_contiguous_migrations_001_to_059() {
        let dir = default_migrations_dir();
        let migrations = discover_migrations(&dir).expect("migrations directory readable");

        assert_eq!(
            migrations.len(),
            59,
            "expected 59 migrations under {}",
            dir.display()
        );
        assert_eq!(migrations.first().unwrap().version, 1);
        assert_eq!(migrations.last().unwrap().version, 59);
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
}
