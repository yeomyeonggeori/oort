//! Worker configuration, sourced only from the environment.
//!
//! Keys are the Swift AgentWorker's (`workers/AgentWorker/.../Config.swift`), so
//! one env block drives either implementation:
//!
//! * `WORKER_DATABASE_URL` (preferred, `docs/DEPLOY.md:393`) → `RELAY_DATABASE_URL`
//!   (what Swift reads first, `Config.swift:97`) → `DATABASE_URL`. The worker
//!   connects as the **BYPASSRLS `momo_worker` role** (`SECURITY.md:67`,
//!   `bootstrap_roles.sql:15-32`): it drains every tenant, which is exactly why
//!   it is a separate credential from the API's `momo_app`.
//! * `AGENT_PROVIDER_MODE` / `HERMES_BASE_URL` / `HERMES_API_KEY` /
//!   `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK` — read through
//!   [`momo_settings::ProviderConfig::from_env`] so the worker and the server's
//!   settings surface resolve the same posture from the same keys.
//! * `PROVIDER_LINK_MASTER_KEY` — optional. Unset means the worker cannot open
//!   the operator's sealed bearer and keeps the env transport, which is the
//!   backward-compatible behaviour Swift documents (`Config.swift:35-40`).
//! * `WORKER_POLL_INTERVAL_MS` (300), `WORKER_CLAIM_BATCH` (8),
//!   `WORKER_MAX_ATTEMPTS` (8), `AGENT_MODEL`, `AGENT_MAX_OUTPUT_TOKENS` (1024),
//!   `AGENT_CONTEXT_MAX_CHARS` (24000), `PROVIDER_REQUEST_TIMEOUT_MS` (120000 —
//!   Swift's `HermesTransport.requestTimeout` floor).
//!
//! No `.env` reading and no baked-in credential: a missing DB URL is a boot
//! error, not a silent dev default. The connection string, the bearer, and the
//! master key are never logged (ADR-0004 Rules #2/#5).

use std::time::Duration;

use momo_outbox::DEFAULT_WORKER_LEASE_SECONDS;
use momo_settings::ProviderConfig;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "set WORKER_DATABASE_URL (or RELAY_DATABASE_URL / DATABASE_URL) to the \
         momo_worker role connection string"
    )]
    MissingDatabaseUrl,
    #[error("{0} must be a number")]
    NotANumber(&'static str),
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// Connection string for the BYPASSRLS worker role. Never logged.
    pub database_url: String,
    pub max_connections: u32,
    /// Fallback poll cadence; NOTIFY provides the sub-second path.
    pub poll_interval: Duration,
    pub claim_batch_size: i64,
    /// How long a claimed job holds its agent's partition before another worker
    /// may take it over (crash recovery — see `momo_outbox::agent_job`).
    pub lease_seconds: i64,
    /// Give up (`status='failed'`) once `attempts` reaches this.
    pub max_attempts: i32,
    /// The env-resolved provider. A usable `provider_link` row beats it per job
    /// (ADR-0004 증보 1 P-1b); this is the fallback, not the answer.
    pub provider: ProviderConfig,
    /// AES-GCM master key for the operator's sealed bearer. Never logged.
    pub provider_link_master_key: Option<String>,
    pub request_timeout: Duration,
    /// `AGENT_MODEL` — used only when the job payload carries no model.
    pub default_model: String,
    pub max_output_tokens: i32,
    pub max_context_chars: usize,
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

impl WorkerConfig {
    pub fn from_env() -> Result<WorkerConfig, ConfigError> {
        let database_url = env("WORKER_DATABASE_URL")
            .or_else(|| env("RELAY_DATABASE_URL"))
            .or_else(|| env("DATABASE_URL"))
            .ok_or(ConfigError::MissingDatabaseUrl)?;
        let poll_ms: u64 = env_number("WORKER_POLL_INTERVAL_MS", 300u64)?;
        let timeout_ms: u64 = env_number("PROVIDER_REQUEST_TIMEOUT_MS", 120_000u64)?;

        Ok(WorkerConfig {
            database_url,
            max_connections: env_number("WORKER_DB_MAX_CONNECTIONS", 4u32)?,
            poll_interval: Duration::from_millis(poll_ms.max(1)),
            claim_batch_size: env_number("WORKER_CLAIM_BATCH", 8i64)?.max(1),
            lease_seconds: env_number("WORKER_LEASE_SECONDS", DEFAULT_WORKER_LEASE_SECONDS)?.max(1),
            max_attempts: env_number("WORKER_MAX_ATTEMPTS", 8i32)?,
            provider: ProviderConfig::from_env(env),
            // An all-whitespace key is no key: treating it as one would make the
            // decrypt fail in a way that reads as "wrong key" instead of "unset".
            provider_link_master_key: env("PROVIDER_LINK_MASTER_KEY"),
            request_timeout: Duration::from_millis(timeout_ms.max(1)),
            default_model: env("AGENT_MODEL").unwrap_or_else(|| "hermes-agent".to_string()),
            max_output_tokens: env_number("AGENT_MAX_OUTPUT_TOKENS", 1024i32)?.max(1),
            max_context_chars: env_number("AGENT_CONTEXT_MAX_CHARS", 24_000usize)?.max(1),
        })
    }

    /// Config for tests/embedding: everything explicit, nothing from env.
    pub fn for_target(database_url: impl Into<String>) -> WorkerConfig {
        WorkerConfig {
            database_url: database_url.into(),
            max_connections: 4,
            poll_interval: Duration::from_millis(300),
            claim_batch_size: 8,
            lease_seconds: DEFAULT_WORKER_LEASE_SECONDS,
            max_attempts: 8,
            provider: ProviderConfig::default(),
            provider_link_master_key: None,
            request_timeout: Duration::from_millis(120_000),
            default_model: "hermes-agent".to_string(),
            max_output_tokens: 1024,
            max_context_chars: 24_000,
        }
    }
}

/// The tracing filter directive: `RUST_LOG` wins, else the prod compose's
/// `LOG_LEVEL`, else `info`. Same rule as `momo-relay`/`momo-notifier`, kept
/// per-binary because each process owns its own environment contract.
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

    /// The struct is `Debug`-logged nowhere, but a future `tracing::info!(?config)`
    /// would be a credential leak, so the secrets are asserted to be the only
    /// fields a reviewer has to keep out of a log line.
    #[test]
    fn the_secret_bearing_fields_are_the_three_a_reviewer_must_watch() {
        let config = WorkerConfig::for_target("postgres://user:pw@host/db");
        assert!(config.provider_link_master_key.is_none());
        assert!(!config.database_url.is_empty());
        assert!(!config.provider.bearer.is_empty(), "env default bearer");
    }
}
