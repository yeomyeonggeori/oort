//! Error surface for the agent-run domain crate.
//!
//! Same split as `momo-messaging`: the `*_in_tx` seams speak
//! [`momo_db::DbError`] so they compose inside a `with_tenant_tx` closure, and
//! the *decisions* travel as `Ok(...)` values (see [`crate::run::RunOutcome`]).
//! A rejection is not a transaction failure — Swift can throw an `HTTPError` out
//! of a Postgres transaction closure and have PostgresNIO wrap it (which is why
//! `AgentGatewayRoutes` defines `GatewayEventResult` and comments *"Expected 4xx
//! outcomes must cross the Postgres transaction as values"*, :1096-1098); Rust
//! cannot, so every expected outcome is a value here too.

use momo_db::DbError;

/// Errors returned by the pool-level agent API.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    /// A database / transaction error (RLS rejection, constraint violation,
    /// connection failure, …).
    #[error(transparent)]
    Db(#[from] DbError),
}

impl From<sqlx::Error> for AgentError {
    fn from(err: sqlx::Error) -> Self {
        AgentError::Db(DbError::from(err))
    }
}
