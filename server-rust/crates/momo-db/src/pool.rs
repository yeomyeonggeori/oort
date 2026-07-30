use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;

use crate::error::DbError;

/// Connection parameters for the api role pool (`momo_app`, `NOBYPASSRLS`).
///
/// Deliberately a plain struct rather than an env reader: the binary layer
/// (B1+) is responsible for sourcing credentials, so this crate never reads a
/// `.env` or holds a secret literal.
#[derive(Debug, Clone)]
pub struct PoolConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: String,
    pub max_connections: u32,
}

impl PoolConfig {
    fn connect_options(&self) -> PgConnectOptions {
        // TLS is disabled for the v0 single-host compose (PG on a private
        // network), matching the Swift `Database.makeClient` note. Non-loopback
        // deploys flip this to require TLS.
        PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .username(&self.username)
            .password(&self.password)
            .database(&self.database)
    }
}

/// Build the api-role pool. The pool must be supervised by the binary's async
/// runtime; this crate only constructs it.
pub async fn connect(config: &PoolConfig) -> Result<PgPool, DbError> {
    let pool = PgPoolOptions::new()
        .max_connections(config.max_connections)
        .connect_with(config.connect_options())
        .await?;
    Ok(pool)
}
