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
    #[error(
        "push drain is enabled but no relay signing key is configured: set \
         MOMO_PUSH_RELAY_PRIVATE_KEY_PATH to an Ed25519 key, or set \
         MOMO_PUSH_RELAY_ALLOW_UNSIGNED=1 to accept unsigned dispatches (only a \
         local mock relay accepts those — the Dawn relay answers 403)"
    )]
    PushRelaySigningKeyMissing,
}

/// Push-candidate drain configuration (ADR-0120, batch P2).
///
/// ## Credential posture
///
/// This process holds **no APNs key**. It cannot: a self-hosted momo server has
/// no Apple Developer account, which is the whole reason the relay hop exists
/// (ADR-0120 D1-A — "Dawn만 APNs .p8을 보유·배포한다"). The only credential here
/// is the **Ed25519 key that identifies this server to the relay**.
///
/// Two rules keep a missing credential from becoming a silent non-delivery:
///
/// * **Default off.** The drain runs only when `MOMO_PUSH_NOTIFIER_ENABLED=1`,
///   and boot logs say plainly when it is disabled. That is an explicit
///   deactivation, not a loop that quietly finds nothing to do.
/// * **Enabled without a key is a boot refusal.** The Swift notifier falls back
///   to sending unsigned (`Config.swift:25-27`), which against the real relay
///   means 403 → permanent failure → a notification that is dropped and never
///   retried. Inheriting that would be exactly the "quietly pretend it worked"
///   failure this batch must not ship, so an operator who wants unsigned has to
///   say so with `MOMO_PUSH_RELAY_ALLOW_UNSIGNED=1`.
#[derive(Debug, Clone)]
pub struct PushConfig {
    /// `MOMO_PUSH_NOTIFIER_ENABLED=1`. Default off.
    pub enabled: bool,
    /// `PUSH_RELAY_URL` — the relay's `/v1/push` endpoint.
    pub relay_url: String,
    /// `PUSH_RELAY_SERVER_ID` — this server's opaque identity at the relay.
    /// Carries no conversation content and no tenant identity.
    pub server_id: String,
    /// `MOMO_PUSH_RELAY_PRIVATE_KEY_PATH` — Ed25519 PKCS#8 PEM or raw 32-byte
    /// seed. Read once at boot; never logged.
    pub signing_key_path: Option<String>,
    /// `MOMO_PUSH_RELAY_ALLOW_UNSIGNED=1` — the deliberate mock-relay escape.
    pub allow_unsigned: bool,
    /// Drain cadence; the LISTEN wakeup covers the gaps.
    pub drain_interval: Duration,
    /// Attempts before a candidate is parked as `failed`.
    pub max_attempts: i32,
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
    /// #1197 H1 lease-renewal cadence — how often the renewal loop *wakes*.
    ///
    /// Deliberately not the renewal period itself. Each adapter declares how
    /// long its own lease is and the loop simply renews every candidate on every
    /// tick, so this only has to be comfortably shorter than the shortest lease
    /// any configured provider declares. The default (30 s) leaves twelve ticks
    /// inside CubeSandbox's 360 s lease.
    pub lease_renewal_interval: Duration,
    /// Candidates claimed per iteration, per loop.
    pub claim_batch_size: i64,
    /// How long a `*ing` intent must sit before its first claim.
    pub lifecycle_claim_delay_seconds: i64,
    /// Heartbeat age past which a host counts as gone.
    pub host_offline_grace_seconds: i64,
    /// `MOMO_T3_ENABLED=1`. The sweep runs regardless — host loss is a T1/T2
    /// concern too — but the reconciler is T3-only and stays dark until opt-in.
    pub t3_enabled: bool,
    /// ADR-0120 push-candidate drain.
    pub push: PushConfig,
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
        let lease_ms: u64 = env_number("MOMO_NOTIFIER_LEASE_RENEWAL_INTERVAL_MS", 30_000u64)?;

        Ok(NotifierConfig {
            database_url,
            max_connections: env_number("NOTIFIER_DB_MAX_CONNECTIONS", 4u32)?,
            reconcile_interval: Duration::from_millis(reconcile_ms.max(1)),
            sweep_interval: Duration::from_millis(sweep_ms.max(1)),
            lease_renewal_interval: Duration::from_millis(lease_ms.max(1)),
            claim_batch_size: env_number("NOTIFIER_CLAIM_BATCH", 32i64)?.max(1),
            lifecycle_claim_delay_seconds: env_number("MOMO_T3_LIFECYCLE_CLAIM_DELAY_S", 5i64)?
                .max(0),
            host_offline_grace_seconds: env_number("MOMO_HOST_OFFLINE_GRACE_S", 90i64)?.max(1),
            t3_enabled: env("MOMO_T3_ENABLED").as_deref() == Some("1"),
            push: PushConfig::from_env(poll_ms)?,
        })
    }

    /// Config for tests/embedding: everything explicit, nothing from env.
    pub fn for_target(database_url: impl Into<String>) -> NotifierConfig {
        NotifierConfig {
            database_url: database_url.into(),
            max_connections: 4,
            reconcile_interval: Duration::from_millis(300),
            sweep_interval: Duration::from_millis(300),
            lease_renewal_interval: Duration::from_millis(300),
            claim_batch_size: 32,
            lifecycle_claim_delay_seconds: 5,
            host_offline_grace_seconds: 90,
            t3_enabled: true,
            push: PushConfig::for_target(),
        }
    }
}

/// What the drain will do about signing, decided once at boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SigningPosture {
    /// The drain is off. Nothing is claimed and nothing is sent.
    Disabled,
    /// Dispatches are signed with the key at this path.
    Signed(String),
    /// Dispatches go out unsigned because an operator explicitly allowed it.
    /// Only a local mock relay accepts these.
    UnsignedByOptIn,
}

/// Decide the signing posture from the three env inputs.
///
/// Pure so the rule can be tested without touching process environment. The
/// rule itself is the point: there is no combination that sends unsigned
/// *without someone having asked for it*, and no combination that starts a
/// drain it cannot deliver from.
pub fn resolve_signing_posture(
    enabled: bool,
    signing_key_path: Option<&str>,
    allow_unsigned: bool,
) -> Result<SigningPosture, ConfigError> {
    if !enabled {
        return Ok(SigningPosture::Disabled);
    }
    match (signing_key_path, allow_unsigned) {
        (Some(path), _) => Ok(SigningPosture::Signed(path.to_string())),
        (None, true) => Ok(SigningPosture::UnsignedByOptIn),
        // Enabled, no key, no opt-in: refuse to boot. Starting here would mean
        // claiming candidates, posting them, being refused 403 by the relay,
        // settling them as permanently failed, and reporting healthy.
        (None, false) => Err(ConfigError::PushRelaySigningKeyMissing),
    }
}

impl PushConfig {
    fn from_env(poll_ms: u64) -> Result<PushConfig, ConfigError> {
        let enabled = env("MOMO_PUSH_NOTIFIER_ENABLED").as_deref() == Some("1");
        let signing_key_path = env("MOMO_PUSH_RELAY_PRIVATE_KEY_PATH");
        let allow_unsigned = env("MOMO_PUSH_RELAY_ALLOW_UNSIGNED").as_deref() == Some("1");

        // Fail closed, and fail at boot rather than per-notification.
        resolve_signing_posture(enabled, signing_key_path.as_deref(), allow_unsigned)?;

        let drain_ms: u64 = env_number("MOMO_PUSH_NOTIFIER_DRAIN_INTERVAL_MS", poll_ms)?;
        Ok(PushConfig {
            enabled,
            relay_url: env("PUSH_RELAY_URL")
                .unwrap_or_else(|| "http://localhost:8090/v1/push".to_string()),
            server_id: env("PUSH_RELAY_SERVER_ID").unwrap_or_else(|| "momo-local".to_string()),
            signing_key_path,
            allow_unsigned,
            drain_interval: Duration::from_millis(drain_ms.max(1)),
            max_attempts: env_number("NOTIFIER_MAX_ATTEMPTS", 8i32)?.max(1),
        })
    }

    /// Test/embedding default: enabled, unsigned (the repo-local mock relay).
    pub fn for_target() -> PushConfig {
        PushConfig {
            enabled: true,
            relay_url: "http://localhost:8090/v1/push".to_string(),
            server_id: "momo-local".to_string(),
            signing_key_path: None,
            allow_unsigned: true,
            drain_interval: Duration::from_millis(300),
            max_attempts: 8,
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

    /// The red test the packet asks for: a missing credential must never
    /// resolve into "run anyway and hope".
    ///
    /// The Swift notifier falls back to unsigned when no key is configured
    /// (`Config.swift:25-27`). Against the real relay that is a 403 → a
    /// permanent failure → a notification silently dropped and never retried.
    /// Delete the `(None, false) => Err(...)` arm and this goes red.
    #[test]
    fn an_enabled_drain_without_a_signing_key_refuses_to_boot() {
        let error = resolve_signing_posture(true, None, false)
            .expect_err("an enabled drain with no key and no opt-in must not boot");
        assert!(matches!(error, ConfigError::PushRelaySigningKeyMissing));

        // And the message has to tell the operator what to do about it.
        let rendered = error.to_string();
        assert!(rendered.contains("MOMO_PUSH_RELAY_PRIVATE_KEY_PATH"));
        assert!(rendered.contains("MOMO_PUSH_RELAY_ALLOW_UNSIGNED"));
    }

    #[test]
    fn unsigned_dispatch_requires_an_explicit_opt_in() {
        assert_eq!(
            resolve_signing_posture(true, None, true).unwrap(),
            SigningPosture::UnsignedByOptIn,
            "unsigned is reachable, but only by asking for it"
        );
        assert_eq!(
            resolve_signing_posture(true, Some("/run/keys/push.pem"), false).unwrap(),
            SigningPosture::Signed("/run/keys/push.pem".to_string())
        );
        assert_eq!(
            resolve_signing_posture(true, Some("/run/keys/push.pem"), true).unwrap(),
            SigningPosture::Signed("/run/keys/push.pem".to_string()),
            "a real key wins over the unsigned escape hatch"
        );
    }

    /// Default-off is an *explicit* disable, not a silent one: nothing is
    /// claimed, so nothing can be reported as delivered.
    #[test]
    fn the_drain_is_off_until_asked_for_and_then_needs_no_key_to_stay_off() {
        assert_eq!(
            resolve_signing_posture(false, None, false).unwrap(),
            SigningPosture::Disabled
        );
        assert_eq!(
            resolve_signing_posture(false, None, true).unwrap(),
            SigningPosture::Disabled,
            "a disabled drain never needs a credential"
        );
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
