//! Sender configuration, sourced only from the environment.
//!
//! Keys are the Swift relay's verbatim (`relay/OutboxRelay/.../Config.swift`) so
//! one env block drives either implementation during the cutover — with one
//! deliberate addition: `WEBHOOK_SENDER_DATABASE_URL`, preferred over
//! `RELAY_DATABASE_URL`/`DATABASE_URL`, so an operator *can* give the sender its
//! own credential without being forced to.
//!
//! Nothing here is a `.env` reader and nothing is a baked-in credential: a
//! missing DB URL is a boot error, and so — since ADR-0004 증보 4 / #2066 — is a
//! missing `OUTBOUND_WEBHOOK_MASTER_KEY`. The old `JWT_HMAC` fallback is
//! **deleted**, exactly as the api deleted its own: an outbound secret is
//! *derived* from that key, so a process that quietly signs with a different
//! root than the api used to mint the subscriber's credential produces exactly
//! the symptomless mismatch #2066 exists to remove. "Keep using the one in use"
//! is now the backfill's job (`scripts/oort upgrade`), not this binary's guess —
//! and that matters most where no compose `:?` catches the omission first
//! (Railway injects variables per service; see `infra/railway/railway.json`).

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "set WEBHOOK_SENDER_DATABASE_URL (or RELAY_DATABASE_URL / DATABASE_URL) \
         to a BYPASSRLS role connection string"
    )]
    MissingDatabaseUrl,
    /// ADR-0004 증보 4 D2(a) / #2066. The sentence carries the **next action**,
    /// the same one the api prints, because fail-closed is only humane when the
    /// operator is told how to close it — the generator's add-only backfill
    /// copies the value already in use, so following it re-issues nothing.
    #[error(
        "set OUTBOUND_WEBHOOK_MASTER_KEY — outbound signing no longer falls back to JWT_HMAC \
(ADR-0004 증보 4). Run `scripts/oort upgrade` (or `scripts/self_host_env.sh --ensure-managed-keys`) \
to backfill the key already in use; it re-issues nothing. It must be the **same value the api \
has** — a sender signing with a different root than the api minted with is a silent mismatch."
    )]
    MissingSigningKey,
    #[error("{0} must be a number")]
    NotANumber(&'static str),
}

#[derive(Clone)]
pub struct SenderConfig {
    /// Connection string for the BYPASSRLS role. Never logged.
    pub database_url: String,
    pub max_connections: u32,
    /// `OUTBOUND_WEBHOOK_MASTER_KEY`, and nothing else (#2066: the `JWT_HMAC`
    /// fallback is deleted). Must equal the api's. **Never logged.**
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
    /// ADR-0171 D6. Exact lowercase `true` only.
    pub doorbell_enabled: bool,
    /// Cooldown window (D4). Default 60s.
    pub doorbell_cooldown: Duration,
    /// Per-doorbell POST timeout. Default 10s (D5).
    pub doorbell_timeout: Duration,
    /// Retries after the first attempt (D5 ≤2). Total attempts = 1 + this.
    pub doorbell_retries: u32,
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
            .field("doorbell_enabled", &self.doorbell_enabled)
            .field("doorbell_cooldown", &self.doorbell_cooldown)
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
        let signing_master_key =
            env("OUTBOUND_WEBHOOK_MASTER_KEY").ok_or(ConfigError::MissingSigningKey)?;
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
            doorbell_enabled: env("MOMO_DOORBELL_ENABLED")
                .as_deref()
                .is_some_and(|value| value.trim() == "true"),
            doorbell_cooldown: Duration::from_secs(env_number(
                "MOMO_DOORBELL_COOLDOWN_SECONDS",
                60u64,
            )?),
            doorbell_timeout: Duration::from_millis(
                env_number("MOMO_DOORBELL_TIMEOUT_MS", 10_000u64)?.max(1),
            ),
            doorbell_retries: env_number("MOMO_DOORBELL_RETRIES", 2u32)?.min(2),
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
            doorbell_enabled: false,
            doorbell_cooldown: Duration::from_secs(60),
            doorbell_timeout: Duration::from_secs(10),
            doorbell_retries: 2,
        }
    }

    pub fn with_doorbell_enabled(mut self, enabled: bool) -> SenderConfig {
        self.doorbell_enabled = enabled;
        self
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

    // -- ADR-0004 증보 4 / #2066 ------------------------------------------

    /// `SenderConfig::from_env` is this binary's only reader of these
    /// variables, so a lock held across set/read/restore makes them
    /// deterministic under the test harness's threads.
    static SENDER_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The api refuses to boot without `OUTBOUND_WEBHOOK_MASTER_KEY`; this
    /// process must refuse on the same terms. A `JWT_HMAC` fallback here is
    /// worse than a missing key: the sender would sign with a root the api
    /// never minted with, and every delivery would fail the subscriber's
    /// verification with no boot error to point at. Railway is the live path —
    /// it injects variables per service, so "api has it, sender does not" is a
    /// reachable shape with no compose `:?` in the way.
    ///
    /// Restoring the `.or_else(|| env("JWT_HMAC"))` makes this RED.
    #[test]
    fn outbound_signing_has_no_jwt_hmac_fallback() {
        let guard = SENDER_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let restore: Vec<(&str, Option<String>)> = [
            "WEBHOOK_SENDER_DATABASE_URL",
            "RELAY_DATABASE_URL",
            "DATABASE_URL",
            "OUTBOUND_WEBHOOK_MASTER_KEY",
            "JWT_HMAC",
        ]
        .iter()
        .map(|key| (*key, std::env::var(key).ok()))
        .collect();

        // The DB URL is read first, so it has to be satisfied or this test
        // would measure `MissingDatabaseUrl` and prove nothing.
        std::env::set_var(
            "WEBHOOK_SENDER_DATABASE_URL",
            "postgres://momo_relay:fixture@127.0.0.1:1/momo",
        );
        std::env::remove_var("RELAY_DATABASE_URL");
        std::env::remove_var("DATABASE_URL");

        // The shape #2066 removes: the app JWT secret present, the master key
        // absent. Before this change it booted and signed with the JWT secret.
        std::env::remove_var("OUTBOUND_WEBHOOK_MASTER_KEY");
        std::env::set_var("JWT_HMAC", "jwt-secret-that-must-not-sign-webhooks");
        assert!(
            matches!(
                SenderConfig::from_env(),
                Err(ConfigError::MissingSigningKey)
            ),
            "an absent OUTBOUND_WEBHOOK_MASTER_KEY must refuse the boot, not fall back to JWT_HMAC"
        );

        // Present but empty — a platform variable set to "" is how an
        // un-backfilled install actually arrives.
        std::env::set_var("OUTBOUND_WEBHOOK_MASTER_KEY", "   ");
        assert!(
            matches!(
                SenderConfig::from_env(),
                Err(ConfigError::MissingSigningKey)
            ),
            "an empty OUTBOUND_WEBHOOK_MASTER_KEY is absence, not a key"
        );

        std::env::set_var("OUTBOUND_WEBHOOK_MASTER_KEY", "outbound-key");
        let config = SenderConfig::from_env().expect("both the DSN and the master key are present");
        assert_eq!(
            config.signing_master_key, "outbound-key",
            "the master key is the only signing root; JWT_HMAC must not reach it"
        );

        for (key, value) in restore {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        drop(guard);
    }

    /// Fail-closed is only humane when the sentence carries the next action —
    /// and it must never carry a value.
    #[test]
    fn the_missing_signing_key_sentence_names_the_backfill() {
        let rendered = ConfigError::MissingSigningKey.to_string();
        assert!(rendered.contains("OUTBOUND_WEBHOOK_MASTER_KEY"));
        assert!(
            rendered.contains("scripts/oort upgrade") && rendered.contains("--ensure-managed-keys"),
            "the sentence must name the backfill: {rendered}"
        );
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
