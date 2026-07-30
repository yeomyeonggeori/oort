//! Relay configuration, sourced only from the environment.
//!
//! Keys match the Swift relay (`relay/OutboxRelay/.../Config.swift`) **and the
//! prod compose `relay` service verbatim** (`infra/prod/docker-compose.prod.yml:200-216`),
//! so one env block drives either implementation. Keys that compose sets and
//! this process does not consume (`MOMO_ENV`, `OUTBOUND_WEBHOOK_MASTER_KEY`,
//! `MOMO_METRICS_*`) are ignored and never block a boot; a missing *required*
//! key is always fatal:
//!   * `RELAY_DATABASE_URL` (preferred) or `DATABASE_URL` — the relay connects as
//!     the **BYPASSRLS `momo_relay` role** so it drains every tenant (L4 §2.2).
//!   * `CENT_API_URL` (default `http://localhost:8000/api`), `CENT_API_KEY`
//!   * `RELAY_POLL_INTERVAL_MS` (300 — the spec fallback cadence),
//!     `RELAY_CLAIM_BATCH` (64), `RELAY_MAX_ATTEMPTS` (8)
//!
//! No `.env` reading, no baked-in credential: a missing DB URL or API key is a
//! boot error, not a silent dev default.

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("set RELAY_DATABASE_URL (or DATABASE_URL) to the momo_relay role connection string")]
    MissingDatabaseUrl,
    #[error("set CENT_API_KEY to the Centrifugo server API key")]
    MissingCentrifugoApiKey,
    #[error("{0} must be a number")]
    NotANumber(&'static str),
}

#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// Connection string for the BYPASSRLS relay role. Never logged.
    pub database_url: String,
    pub max_connections: u32,
    /// Centrifugo server API base, e.g. `http://centrifugo:8000/api`.
    pub cent_api_url: String,
    /// `X-API-Key` for `POST /api/publish`. Never logged.
    pub cent_api_key: String,
    /// Fallback poll cadence; NOTIFY provides the sub-second path.
    pub poll_interval: Duration,
    pub claim_batch_size: i64,
    /// Give up (`status='failed'`) once `attempts` reaches this.
    pub max_attempts: i32,
}

fn env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

fn env_number<T: std::str::FromStr>(key: &'static str, fallback: T) -> Result<T, ConfigError> {
    match env(key) {
        Some(raw) => raw.parse::<T>().map_err(|_| ConfigError::NotANumber(key)),
        None => Ok(fallback),
    }
}

impl RelayConfig {
    pub fn from_env() -> Result<RelayConfig, ConfigError> {
        let database_url = env("RELAY_DATABASE_URL")
            .or_else(|| env("DATABASE_URL"))
            .ok_or(ConfigError::MissingDatabaseUrl)?;
        let cent_api_key = env("CENT_API_KEY").ok_or(ConfigError::MissingCentrifugoApiKey)?;
        let poll_ms: u64 = env_number("RELAY_POLL_INTERVAL_MS", 300u64)?;

        Ok(RelayConfig {
            database_url,
            max_connections: env_number("RELAY_DB_MAX_CONNECTIONS", 4u32)?,
            cent_api_url: env("CENT_API_URL")
                .unwrap_or_else(|| "http://localhost:8000/api".to_string()),
            cent_api_key,
            poll_interval: Duration::from_millis(poll_ms.max(1)),
            claim_batch_size: env_number("RELAY_CLAIM_BATCH", 64i64)?,
            max_attempts: env_number("RELAY_MAX_ATTEMPTS", 8i32)?,
        })
    }
}

/// The tracing filter directive: `RUST_LOG` wins, else the prod compose's
/// `LOG_LEVEL` (`docker-compose.prod.yml:189` sets it for the stack), else
/// `info`. Same rule as `momo-server`, kept per-binary because each process owns
/// its own environment contract.
pub fn log_filter() -> String {
    choose_log_filter(env("RUST_LOG").as_deref(), env("LOG_LEVEL").as_deref())
}

fn choose_log_filter(rust_log: Option<&str>, log_level: Option<&str>) -> String {
    rust_log
        .or(log_level)
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| "info".to_string())
}

impl RelayConfig {
    /// Config for tests/embedding: everything explicit, nothing from env.
    pub fn for_target(
        database_url: impl Into<String>,
        cent_api_url: impl Into<String>,
        cent_api_key: impl Into<String>,
    ) -> RelayConfig {
        RelayConfig {
            database_url: database_url.into(),
            max_connections: 4,
            cent_api_url: cent_api_url.into(),
            cent_api_key: cent_api_key.into(),
            poll_interval: Duration::from_millis(300),
            claim_batch_size: 64,
            max_attempts: 8,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_filter_prefers_rust_log_then_the_compose_log_level() {
        assert_eq!(choose_log_filter(None, None), "info");
        assert_eq!(choose_log_filter(None, Some("debug")), "debug");
        assert_eq!(choose_log_filter(Some("warn"), Some("debug")), "warn");
    }
}
