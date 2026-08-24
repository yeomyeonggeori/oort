//! Unfurl worker knobs. Sourced from the environment, never from a file.

use std::time::Duration;

#[derive(Clone)]
pub struct UnfurlConfig {
    pub database_url: String,
    pub max_connections: u32,
    pub enabled: bool,
    pub allow_development_http: bool,
    pub poll_interval: Duration,
    pub claim_batch_size: i64,
    pub max_attempts: i32,
    pub request_timeout: Duration,
}

impl std::fmt::Debug for UnfurlConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UnfurlConfig")
            .field("enabled", &self.enabled)
            .field("allow_development_http", &self.allow_development_http)
            .field("claim_batch_size", &self.claim_batch_size)
            .field("max_attempts", &self.max_attempts)
            .finish_non_exhaustive()
    }
}

fn env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

impl UnfurlConfig {
    pub fn from_env() -> UnfurlConfig {
        let poll_ms: u64 = env("UNFURL_POLL_INTERVAL_MS")
            .and_then(|raw| raw.parse().ok())
            .unwrap_or(500);
        let timeout_ms: u64 = env("UNFURL_TIMEOUT_MS")
            .and_then(|raw| raw.parse().ok())
            .unwrap_or(5_000);
        UnfurlConfig {
            database_url: env("WEBHOOK_SENDER_DATABASE_URL")
                .or_else(|| env("RELAY_DATABASE_URL"))
                .or_else(|| env("DATABASE_URL"))
                .unwrap_or_default(),
            max_connections: env("UNFURL_DB_MAX_CONNECTIONS")
                .and_then(|raw| raw.parse().ok())
                .unwrap_or(4),
            enabled: crate::enabled_from_env(),
            allow_development_http: env("MOMO_ENV")
                .unwrap_or_else(|| "local".into())
                .trim()
                .eq_ignore_ascii_case("local")
                && env("MOMO_UNFURL_ALLOW_HTTP").as_deref() == Some("1"),
            poll_interval: Duration::from_millis(poll_ms.max(1)),
            claim_batch_size: env("UNFURL_CLAIM_BATCH")
                .and_then(|raw| raw.parse().ok())
                .unwrap_or(8),
            max_attempts: env("UNFURL_MAX_ATTEMPTS")
                .and_then(|raw| raw.parse().ok())
                .unwrap_or(3),
            request_timeout: Duration::from_millis(timeout_ms.max(1)),
        }
    }

    pub fn for_tests(database_url: impl Into<String>, enabled: bool) -> UnfurlConfig {
        UnfurlConfig {
            database_url: database_url.into(),
            max_connections: 4,
            enabled,
            allow_development_http: true,
            poll_interval: Duration::from_millis(50),
            claim_batch_size: 8,
            max_attempts: 3,
            request_timeout: Duration::from_secs(5),
        }
    }
}
