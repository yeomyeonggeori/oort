//! Migration runner — applies the existing 59 SQL files **in place, unmodified**.
//!
//! ADR-0145 / D2 §3: the 59 migrations under `server/Migrations/NNN_*.sql` are
//! Postgres DDL, language independent, and are the enforcement layer we inherit.
//! This runner discovers them, orders them by their numeric `NNN` prefix, and
//! applies each file's SQL verbatim on a fresh database. It never edits, copies,
//! or reorders a file (hard rule). `schema_v0.sql` is a duplicate snapshot of
//! `001` and is intentionally NOT under this directory, so it is never a target.
//!
//! B0 does not run this against a live PG (orchestrator's job); the unit test
//! below asserts the on-disk set is complete and contiguously versioned without
//! a database.

use std::path::{Path, PathBuf};

use sqlx::PgConnection;

use crate::error::DbError;

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

/// Apply every discovered migration in order on a fresh connection.
///
/// Each file is executed as one multi-statement batch (`sqlx::raw_sql`),
/// preserving the file's own statement boundaries. Intended for a fresh DB in
/// the orchestrator's conformance harness; idempotent skip-tracking is a B1
/// concern (the Swift bootstrap likewise applied 001..059 to an empty DB).
pub async fn run_migrations(conn: &mut PgConnection, dir: &Path) -> Result<(), DbError> {
    for migration in discover_migrations(dir)? {
        let sql =
            std::fs::read_to_string(&migration.path).map_err(|source| DbError::MigrationIo {
                path: migration.path.display().to_string(),
                source,
            })?;
        sqlx::raw_sql(&sql).execute(&mut *conn).await?;
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
}
