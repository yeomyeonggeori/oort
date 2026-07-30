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
}
