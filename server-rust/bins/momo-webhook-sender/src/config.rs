//! Sender configuration, sourced only from the environment.
//!
//! Keys are the Swift relay's verbatim (`relay/OutboxRelay/.../Config.swift`) so
//! one env block drives either implementation during the cutover — with one
//! deliberate addition: `WEBHOOK_SENDER_DATABASE_URL`, preferred over
//! `RELAY_DATABASE_URL`/`DATABASE_URL`, so an operator *can* give the sender its
//! own credential without being forced to.
//!
//! Nothing here is a `.env` reader and nothing is a baked-in credential: a
//! missing DB URL is a boot error, and the signing master key falls back to
//! `JWT_HMAC` exactly as the api and the Swift relay do. That fallback is not
//! laxity — an outbound secret is *derived* from the key, so changing it
//! silently invalidates every already-issued subscriber credential. "Unset" has
//! to mean "keep using the one in use".

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "set WEBHOOK_SENDER_DATABASE_URL (or RELAY_DATABASE_URL / DATABASE_URL) \
         to a BYPASSRLS role connection string"
    )]
    MissingDatabaseUrl,
    #[error("set JWT_HMAC (or OUTBOUND_WEBHOOK_MASTER_KEY) — outbound signing has no default")]
    MissingSigningKey,
    #[error("{0} must be a number")]
    NotANumber(&'static str),
}

#[derive(Clone)]
pub struct SenderConfig {
    /// Connection string for the BYPASSRLS role. Never logged.
    pub database_url: String,
    pub max_connections: u32,
    /// `OUTBOUND_WEBHOOK_MASTER_KEY`, else `JWT_HMAC`. **Never logged.**
    pub signing_master_key: String,
    /// Fallback poll cadence; NOTIFY provides the sub-second path.
    pub poll_interval: Duration,
    pub claim_batch_size: i64,
    /// Give up (`status='failed'`) once `attempts` reaches this.
    pub max_attempts: i32,
    /// Consecutive destination 5xx before the subscription is auto-disabled
    /// (`WEBHOOK_DISABLE_AFTER_5XX`, default 5, floor 1). Swift's
    /// `webhookDisableAfterServerFailures`.
    pub disable_after_server_failures: i32,
    /// Per-request timeout. Swift's `HTTPClient.execute(timeout: .seconds(5))`.
    pub request_timeout: Duration,
    /// `MOMO_ENV=local` **and** `MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP=1`. Both
    /// halves required, so the flag cannot be effective in staging or prod.
    pub allow_development_http: bool,
}

impl std::fmt::Debug for SenderConfig {
    /// Hand-written: `signing_master_key` is a master key and `database_url`
    /// carries a password. A `{:?}` in a log line is how either reaches an
    /// aggregator.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SenderConfig")
            .field("claim_batch_size", &self.claim_batch_size)
            .field("max_attempts", &self.max_attempts)
            .field(
                "disable_after_server_failures",
                &self.disable_after_server_failures,
            )
            .field("request_timeout", &self.request_timeout)
            .field("allow_development_http", &self.allow_development_http)
            .finish_non_exhaustive()
    }
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

impl SenderConfig {
    pub fn from_env() -> Result<SenderConfig, ConfigError> {
        let database_url = env("WEBHOOK_SENDER_DATABASE_URL")
            .or_else(|| env("RELAY_DATABASE_URL"))
            .or_else(|| env("DATABASE_URL"))
            .ok_or(ConfigError::MissingDatabaseUrl)?;
        let signing_master_key = env("OUTBOUND_WEBHOOK_MASTER_KEY")
            .or_else(|| env("JWT_HMAC"))
            .ok_or(ConfigError::MissingSigningKey)?;
        let poll_ms: u64 = env_number("WEBHOOK_SENDER_POLL_INTERVAL_MS", 300u64)?;
        let timeout_ms: u64 = env_number("WEBHOOK_SENDER_TIMEOUT_MS", 5_000u64)?;

        Ok(SenderConfig {
            database_url,
            max_connections: env_number("WEBHOOK_SENDER_DB_MAX_CONNECTIONS", 4u32)?,
            signing_master_key,
            poll_interval: Duration::from_millis(poll_ms.max(1)),
            claim_batch_size: env_number("WEBHOOK_SENDER_CLAIM_BATCH", 16i64)?,
            max_attempts: env_number("WEBHOOK_SENDER_MAX_ATTEMPTS", 8i32)?,
            disable_after_server_failures: env_number("WEBHOOK_DISABLE_AFTER_5XX", 5i32)?.max(1),
            request_timeout: Duration::from_millis(timeout_ms.max(1)),
            allow_development_http: env("MOMO_ENV")
                .unwrap_or_else(|| "local".to_string())
                .trim()
                .eq_ignore_ascii_case("local")
                && env("MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP").as_deref() == Some("1"),
        })
    }

    /// Config for tests/embedding: everything explicit, nothing from env.
    pub fn for_target(
        database_url: impl Into<String>,
        signing_master_key: impl Into<String>,
    ) -> SenderConfig {
        SenderConfig {
            database_url: database_url.into(),
            max_connections: 4,
            signing_master_key: signing_master_key.into(),
            poll_interval: Duration::from_millis(300),
            claim_batch_size: 16,
            max_attempts: 8,
            disable_after_server_failures: 5,
            request_timeout: Duration::from_secs(5),
            allow_development_http: false,
        }
    }
}

/// `RUST_LOG` wins, else the compose stack's `LOG_LEVEL`, else `info`. Same rule
/// as every other binary, kept per-binary because each process owns its own
/// environment contract.
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

    /// Neither secret may be printable by accident.
    #[test]
    fn debug_never_prints_the_master_key_or_the_dsn() {
        let rendered = format!(
            "{:?}",
            SenderConfig::for_target("postgres://momo:hunter2@db/momo", "super-secret-master-key")
        );
        assert!(!rendered.contains("hunter2"), "{rendered}");
        assert!(!rendered.contains("super-secret-master-key"), "{rendered}");
    }
}
