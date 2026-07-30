//! Notifier configuration, sourced only from the environment.
//!
//! Keys match the Swift notifier (`workers/NotifierWorker/.../Config.swift`) and
//! the e2e compose `notifier` service verbatim
//! (`infra/docker-compose.e2e.yml:476-495`), so one env block drives either
//! implementation:
//!
//! * `NOTIFIER_DATABASE_URL` (preferred) or `DATABASE_URL` — the worker connects
//!   as the **BYPASSRLS `momo_notifier` role** (`bootstrap_roles.sql:33`) because
//!   a durable intent must converge whichever tenant owns it (Config.swift:52-53).
//! * `NOTIFIER_POLL_INTERVAL_MS` (300) — Swift runs both loops off one wake
//!   ticker at this cadence (Config.swift:56, `NotifierService.swift:67-91`);
//!   `MOMO_NOTIFIER_RECONCILE_INTERVAL_MS` / `MOMO_NOTIFIER_SWEEP_INTERVAL_MS`
//!   override each loop when an operator wants them to differ.
//! * `NOTIFIER_CLAIM_BATCH` (32) — candidates per iteration (Config.swift:71).
//! * `MOMO_HOST_OFFLINE_GRACE_S` (90, floored at 1) — ADR-0125 D11 stale
//!   heartbeat grace (Config.swift:73).
//! * `MOMO_T3_LIFECYCLE_CLAIM_DELAY_S` (5) — Swift's `interval '5 seconds'`
//!   claim delay (`CloudLifecycleReconciler.swift:54/117/138`), named here rather
//!   than baked in.
//! * `MOMO_T3_ENABLED` — `"1"` enables the reconciler
//!   (`CloudProviderSettings.swift:74`). T3 is unreleased and default-off: when
//!   it is off the reconciler does not even poll for candidates.
//!
//! No `.env` reading and no baked-in credential: a missing DB URL is a boot
//! error, not a silent dev default.

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "set NOTIFIER_DATABASE_URL (or DATABASE_URL) to the momo_notifier role connection string"
    )]
    MissingDatabaseUrl,
    #[error("{0} must be a number")]
    NotANumber(&'static str),
}

#[derive(Debug, Clone)]
pub struct NotifierConfig {
    /// Connection string for the BYPASSRLS notifier role. Never logged.
    pub database_url: String,
    pub max_connections: u32,
    /// ADR-0140 D4 reconciliation cadence.
    pub reconcile_interval: Duration,
    /// ADR-0125 D11 tier-fallback cadence.
    pub sweep_interval: Duration,
    /// Candidates claimed per iteration, per loop.
    pub claim_batch_size: i64,
    /// How long a `*ing` intent must sit before its first claim.
    pub lifecycle_claim_delay_seconds: i64,
    /// Heartbeat age past which a host counts as gone.
    pub host_offline_grace_seconds: i64,
    /// `MOMO_T3_ENABLED=1`. The sweep runs regardless — host loss is a T1/T2
    /// concern too — but the reconciler is T3-only and stays dark until opt-in.
    pub t3_enabled: bool,
}

fn env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

fn env_number<T: std::str::FromStr>(key: &'static str, fallback: T) -> Result<T, ConfigError> {
    match env(key) {
        Some(raw) => raw
            .trim()
            .parse::<T>()
            .map_err(|_| ConfigError::NotANumber(key)),
        None => Ok(fallback),
    }
}

impl NotifierConfig {
    pub fn from_env() -> Result<NotifierConfig, ConfigError> {
        let database_url = env("NOTIFIER_DATABASE_URL")
            .or_else(|| env("DATABASE_URL"))
            .ok_or(ConfigError::MissingDatabaseUrl)?;
        let poll_ms: u64 = env_number("NOTIFIER_POLL_INTERVAL_MS", 300u64)?;
        let reconcile_ms: u64 = env_number("MOMO_NOTIFIER_RECONCILE_INTERVAL_MS", poll_ms)?;
        let sweep_ms: u64 = env_number("MOMO_NOTIFIER_SWEEP_INTERVAL_MS", poll_ms)?;

        Ok(NotifierConfig {
            database_url,
            max_connections: env_number("NOTIFIER_DB_MAX_CONNECTIONS", 4u32)?,
            reconcile_interval: Duration::from_millis(reconcile_ms.max(1)),
            sweep_interval: Duration::from_millis(sweep_ms.max(1)),
            claim_batch_size: env_number("NOTIFIER_CLAIM_BATCH", 32i64)?.max(1),
            lifecycle_claim_delay_seconds: env_number("MOMO_T3_LIFECYCLE_CLAIM_DELAY_S", 5i64)?
                .max(0),
            host_offline_grace_seconds: env_number("MOMO_HOST_OFFLINE_GRACE_S", 90i64)?.max(1),
            t3_enabled: env("MOMO_T3_ENABLED").as_deref() == Some("1"),
        })
    }

    /// Config for tests/embedding: everything explicit, nothing from env.
    pub fn for_target(database_url: impl Into<String>) -> NotifierConfig {
        NotifierConfig {
            database_url: database_url.into(),
            max_connections: 4,
            reconcile_interval: Duration::from_millis(300),
            sweep_interval: Duration::from_millis(300),
            claim_batch_size: 32,
            lifecycle_claim_delay_seconds: 5,
            host_offline_grace_seconds: 90,
            t3_enabled: true,
        }
    }
}

/// The tracing filter directive: `RUST_LOG` wins, else the compose `LOG_LEVEL`,
/// else `info`. Same rule as `momo-relay`, kept per-binary because each process
/// owns its own environment contract.
pub fn log_filter() -> String {
    choose_log_filter(env("RUST_LOG").as_deref(), env("LOG_LEVEL").as_deref())
}

fn choose_log_filter(rust_log: Option<&str>, log_level: Option<&str>) -> String {
    rust_log
        .or(log_level)
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| "info".to_string())
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

    #[test]
    fn a_test_config_is_explicit_about_every_cadence() {
        let config = NotifierConfig::for_target("postgres://notifier@localhost/momo");
        assert_eq!(config.reconcile_interval, Duration::from_millis(300));
        assert_eq!(config.sweep_interval, Duration::from_millis(300));
        assert_eq!(config.lifecycle_claim_delay_seconds, 5);
        assert_eq!(config.host_offline_grace_seconds, 90);
    }
}
