use std::io;

/// Errors surfaced by `momo-db`. Domain crates map these onto HTTP responses;
/// the transaction guards convert a closure error into a rollback (see
/// [`crate::tenant`]).
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("migration io error at {path}: {source}")]
    MigrationIo {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("malformed migration filename: {0}")]
    MigrationName(String),

    #[error(
        "psql client not found on PATH or Homebrew libpq locations \
         (install the PostgreSQL 18 client / libpq)"
    )]
    PsqlNotFound,

    #[error("failed to spawn psql at {psql}: {source}")]
    PsqlSpawn {
        psql: String,
        #[source]
        source: io::Error,
    },

    #[error("migration {version} failed (psql exit code {code:?})")]
    MigrationFailed { version: String, code: Option<i32> },
}
