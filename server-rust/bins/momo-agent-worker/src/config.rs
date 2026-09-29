//! Worker configuration, sourced only from the environment.
//!
//! Keys are the Swift AgentWorker's (`workers/AgentWorker/.../Config.swift`), so
//! one env block drives either implementation:
//!
//! * `WORKER_DATABASE_URL` (preferred, `docs/SELF_HOST.md:393`) → `RELAY_DATABASE_URL`
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
//! * `AGENT_REPORT_PROTOCOL_ENABLED` (**1**) — the one key here that is
//!   **default-on**, and therefore an opt-*out*: see
//!   [`report_protocol_enabled`]. Rust-only (the Swift worker predates #1454),
//!   so an env block shared with Swift simply ignores it.
//!
//! No `.env` reading and no baked-in credential: a missing DB URL is a boot
//! error, not a silent dev default. The connection string, the bearer, and the
//! master key are never logged (ADR-0004 Rules #2/#5).

use std::time::Duration;

use momo_agent::{context_window_size, A2aLimits};
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
    /// How long a pending approval may hold the agent's concurrency slot
    /// (goal SRV-T1, `APPROVAL_TTL_SECONDS`).
    ///
    /// `agent.max_concurrent_runs` defaults to **1**, and
    /// `momo_agent::live_run_count_in_tx` counts `awaiting_approval`, so an
    /// approval nobody answers would otherwise silence the agent permanently.
    /// One hour is short on purpose: re-asking costs a round trip, a held gate
    /// costs every later run.
    pub approval_ttl_seconds: i64,
    /// B7.2 — the A2A ceilings, already [`A2aLimits::clamped`].
    pub a2a: A2aLimits,
    /// `AGENT_GATEWAY_MODE=gateway` — decides the `outbox.method` a delegated
    /// job is written under and whether a realtime wake-up rides beside it.
    /// Read from the **same** env key `momo-server`'s `AgentGatewaySettings`
    /// reads, so a delegated job lands in the same feed as a human-triggered
    /// one; picking the wrong one makes every delegation stall silently.
    pub gateway_enabled: bool,
    /// `AGENT_CONTEXT_MAX_MESSAGES`, clamped by
    /// [`momo_agent::context_window_size`] — the history window a delegated run
    /// is given, resolved from the same key and the same clamp the server uses.
    pub context_max_messages: i64,
    /// `AGENT_CONTEXT_UTC_OFFSET_MINUTES` — the wall clock the agent is told it
    /// is living in (goal B8 L7).
    ///
    /// A workspace asking 오늘 means today where the workspace is, and the
    /// server's own `TZ` is a deployment detail rather than an answer: the QA
    /// stack runs in UTC while its readers are in Seoul. 540 (UTC+09:00) is the
    /// default because every user-facing string in this product is Korean; a
    /// deployment elsewhere sets the key. Clamped to a real offset range so a
    /// fat-fingered value cannot move the agent's calendar by weeks.
    pub utc_offset_minutes: i32,
    /// #2852: the egress policy every outbound provider call (the turn AND the
    /// OAuth token refresh) is judged by: `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`
    /// and `AGENT_PROVIDER_LOCAL_HOSTS`, plus `HERMES_BASE_URL`'s host **only
    /// when the operator actually set it**. The built-in `localhost` default is
    /// not an operator decision and must not open loopback (review M-1).
    pub egress: momo_settings::EgressPolicy,
    /// `AGENT_REPORT_PROTOCOL_ENABLED` — whether every agent turn is told the
    /// completion-report protocol (#1454, #1466). **Default on.**
    ///
    /// The block is ~6 lines of system context on every turn of every agent, so
    /// an operator running a fleet on a metered provider is entitled to weigh
    /// that cost against a card they may not use. This is the switch; nothing
    /// else about the feature moves. In particular the **reader** stays on: a
    /// model that writes a fence unprompted still has it lifted out of the
    /// visible body ([`crate::completion_report::extract`]), because the
    /// alternative to parsing an unexpected fence is printing raw JSON into a
    /// channel — worse than the card the operator declined.
    pub report_protocol_enabled: bool,
    /// #3162 — the team-memory summary loop (`MEMORY_*` keys).
    pub memory: MemoryConfig,
}

/// The team-memory summary loop's knobs (#3162, ADR-0196 D10, plan §6.1/§6.6). Every default
/// is the plan's number; an operator can only make the loop slower, cheaper or off.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryConfig {
    /// `MEMORY_SUMMARY_ENABLED` (**on**; `0|false|no|off` turns it off). On means "runs when the
    /// team 「기본 AI」 summary row resolves" — with no row it records a visible
    /// `mem.summary.unconfigured` audit row and calls no model.
    pub enabled: bool,
    /// `MEMORY_SUMMARY_POLL_SECONDS` (60) — how often a sweep looks for work.
    pub poll_interval: Duration,
    /// `MEMORY_WINDOW_MIN_MESSAGES` (40) — new top-level messages that trigger a window.
    pub window_min_messages: i64,
    /// `MEMORY_WINDOW_IDLE_MIN_MESSAGES` (5) and `MEMORY_WINDOW_IDLE_SECONDS` (1800) — a smaller
    /// pile that has gone quiet.
    pub window_idle_min_messages: i64,
    pub window_idle_seconds: i64,
    /// `MEMORY_WINDOW_MAX_MESSAGES` (60) and `MEMORY_PROMPT_MAX_CHARS` (16000) bound one call.
    pub window_max_messages: i64,
    pub prompt_max_chars: usize,
    /// Longest slice of one message put in the prompt (chars).
    pub message_max_chars: usize,
    /// `MEMORY_THREAD_MIN_REPLIES` (15) / `MEMORY_THREAD_IDLE_MIN_REPLIES` (3) — a thread's own trigger
    /// (idle uses `window_idle_seconds`).
    pub thread_min_replies: i64,
    pub thread_idle_min_replies: i64,
    /// `MEMORY_SUMMARY_MAX_OUTPUT_TOKENS` (800).
    pub max_output_tokens: i32,
    /// `MEMORY_LEASE_SECONDS` (300) — a channel lease; renewed before every model call.
    pub lease_seconds: f64,
    /// `MEMORY_DAILY_TOKEN_CAP` (300000) — used when the workspace set no `daily_token_cap`.
    pub daily_token_cap: i64,
    /// `MEMORY_BACKFILL_DAYS` (14) — a never-summarised channel starts this far back.
    pub backfill_days: i32,
    /// `MEMORY_ROLLUP_DAYS` (8) / `MEMORY_ROLLUP_WEEKS` (5) / `MEMORY_ROLLUP_HOUR` (4) — how far back a
    /// day/week rollup is looked for, and the local hour after which a finished day is rolled up.
    pub rollup_days: i64,
    pub rollup_weeks: i64,
    pub rollup_hour: i64,
    /// `MEMORY_WINDOWS_PER_CHANNEL` (3) — windows one channel gets per sweep (a backlog drains
    /// over several sweeps instead of monopolising the loop).
    pub windows_per_channel: usize,
    /// `MEMORY_APPLY_RETRIES` (3) — re-reads after 40001/23503 before leaving it to the next sweep.
    pub apply_retries: usize,
    /// `MEMORY_MAX_CHANNELS` (2000) — channels one sweep looks at.
    pub max_channels: i64,
}

impl Default for MemoryConfig {
    fn default() -> MemoryConfig {
        MemoryConfig {
            enabled: true,
            poll_interval: Duration::from_secs(60),
            window_min_messages: 40,
            window_idle_min_messages: 5,
            window_idle_seconds: 30 * 60,
            window_max_messages: 60,
            prompt_max_chars: 16_000,
            message_max_chars: 1_000,
            thread_min_replies: 15,
            thread_idle_min_replies: 3,
            max_output_tokens: 800,
            lease_seconds: 300.0,
            daily_token_cap: 300_000,
            backfill_days: 14,
            rollup_days: 8,
            rollup_weeks: 5,
            rollup_hour: 4,
            windows_per_channel: 3,
            apply_retries: 3,
            max_channels: 2_000,
        }
    }
}

impl MemoryConfig {
    pub fn from_env() -> Result<MemoryConfig, ConfigError> {
        let d = MemoryConfig::default();
        Ok(MemoryConfig {
            enabled: report_protocol_enabled(env("MEMORY_SUMMARY_ENABLED").as_deref()),
            poll_interval: Duration::from_secs(
                env_number("MEMORY_SUMMARY_POLL_SECONDS", d.poll_interval.as_secs())?.max(1),
            ),
            window_min_messages: env_number("MEMORY_WINDOW_MIN_MESSAGES", d.window_min_messages)?
                .max(1),
            window_idle_min_messages: env_number(
                "MEMORY_WINDOW_IDLE_MIN_MESSAGES",
                d.window_idle_min_messages,
            )?
            .max(1),
            window_idle_seconds: env_number("MEMORY_WINDOW_IDLE_SECONDS", d.window_idle_seconds)?
                .max(1),
            window_max_messages: env_number("MEMORY_WINDOW_MAX_MESSAGES", d.window_max_messages)?
                .clamp(2, 200),
            prompt_max_chars: env_number("MEMORY_PROMPT_MAX_CHARS", d.prompt_max_chars)?.max(500),
            message_max_chars: d.message_max_chars,
            thread_min_replies: env_number("MEMORY_THREAD_MIN_REPLIES", d.thread_min_replies)?
                .max(1),
            thread_idle_min_replies: env_number(
                "MEMORY_THREAD_IDLE_MIN_REPLIES",
                d.thread_idle_min_replies,
            )?
            .max(1),
            max_output_tokens: env_number("MEMORY_SUMMARY_MAX_OUTPUT_TOKENS", d.max_output_tokens)?
                .max(1),
            lease_seconds: env_number("MEMORY_LEASE_SECONDS", d.lease_seconds)?.max(5.0),
            daily_token_cap: env_number("MEMORY_DAILY_TOKEN_CAP", d.daily_token_cap)?.max(0),
            backfill_days: env_number("MEMORY_BACKFILL_DAYS", d.backfill_days)?.max(1),
            rollup_days: env_number("MEMORY_ROLLUP_DAYS", d.rollup_days)?.clamp(1, 60),
            rollup_weeks: env_number("MEMORY_ROLLUP_WEEKS", d.rollup_weeks)?.clamp(1, 26),
            rollup_hour: env_number("MEMORY_ROLLUP_HOUR", d.rollup_hour)?.clamp(0, 23),
            windows_per_channel: env_number("MEMORY_WINDOWS_PER_CHANNEL", d.windows_per_channel)?
                .max(1),
            apply_retries: env_number("MEMORY_APPLY_RETRIES", d.apply_retries)?,
            max_channels: env_number("MEMORY_MAX_CHANNELS", d.max_channels)?.max(1),
        })
    }
}

/// Real UTC offsets run from -12:00 to +14:00.
fn clamp_utc_offset(minutes: i32) -> i32 {
    minutes.clamp(-12 * 60, 14 * 60)
}

/// `AGENT_REPORT_PROTOCOL_ENABLED` — the #1454 protocol block's opt-out.
///
/// Parsed the opposite way round from [`gateway_enabled`], and for the same
/// reason that one falls back to `worker`: **an unrecognised value must keep the
/// shipped behaviour.** Here the shipped behaviour is on, so only an explicitly
/// negative word turns it off. An operator who meant `0` and typed `o` would
/// otherwise get a fleet that quietly stopped writing completion reports, and
/// the symptom — cards simply never appear — reads as a model that ignored the
/// protocol rather than as a config typo.
///
/// The negative vocabulary is the mirror of the positive one
/// [`momo_settings::ProviderConfig::from_env`] already accepts for
/// `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`, so one env block reads the same in
/// both directions.
fn report_protocol_enabled(raw: Option<&str>) -> bool {
    !matches!(
        raw.map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0") | Some("false") | Some("no") | Some("off")
    )
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

/// Build the worker's egress policy. `hermes_base_url_set` is whether the
/// operator wrote `HERMES_BASE_URL` — the only case its host is trusted.
pub fn egress_policy(
    provider: &ProviderConfig,
    hermes_base_url_set: bool,
    from_env: impl Fn(bool) -> momo_settings::EgressPolicy,
) -> momo_settings::EgressPolicy {
    let policy = from_env(provider.allow_local_loopback);
    if hermes_base_url_set {
        policy.with_operator_base_url(&provider.base_url)
    } else {
        policy
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
        let provider = ProviderConfig::from_env(env);
        let egress = egress_policy(
            &provider,
            env("HERMES_BASE_URL").is_some(),
            momo_settings::EgressPolicy::from_env,
        );

        Ok(WorkerConfig {
            database_url,
            max_connections: env_number("WORKER_DB_MAX_CONNECTIONS", 4u32)?,
            poll_interval: Duration::from_millis(poll_ms.max(1)),
            claim_batch_size: env_number("WORKER_CLAIM_BATCH", 8i64)?.max(1),
            lease_seconds: env_number("WORKER_LEASE_SECONDS", DEFAULT_WORKER_LEASE_SECONDS)?.max(1),
            max_attempts: env_number("WORKER_MAX_ATTEMPTS", 8i32)?,
            provider,
            egress,
            // An all-whitespace key is no key: treating it as one would make the
            // decrypt fail in a way that reads as "wrong key" instead of "unset".
            provider_link_master_key: env("PROVIDER_LINK_MASTER_KEY"),
            request_timeout: Duration::from_millis(timeout_ms.max(1)),
            default_model: env("AGENT_MODEL").unwrap_or_else(|| "hermes-agent".to_string()),
            max_output_tokens: env_number("AGENT_MAX_OUTPUT_TOKENS", 1024i32)?.max(1),
            max_context_chars: env_number("AGENT_CONTEXT_MAX_CHARS", 24_000usize)?.max(1),
            approval_ttl_seconds: env_number(
                "APPROVAL_TTL_SECONDS",
                momo_agent::approval::DEFAULT_TTL_SECONDS,
            )?
            .max(1),
            a2a: a2a_limits_from_env()?,
            gateway_enabled: gateway_enabled(env("AGENT_GATEWAY_MODE").as_deref()),
            context_max_messages: context_window_size(env("AGENT_CONTEXT_MAX_MESSAGES").as_deref()),
            utc_offset_minutes: clamp_utc_offset(env_number(
                "AGENT_CONTEXT_UTC_OFFSET_MINUTES",
                540i32,
            )?),
            report_protocol_enabled: report_protocol_enabled(
                env("AGENT_REPORT_PROTOCOL_ENABLED").as_deref(),
            ),
            memory: MemoryConfig::from_env()?,
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
            approval_ttl_seconds: momo_agent::approval::DEFAULT_TTL_SECONDS,
            a2a: A2aLimits::default().clamped(),
            gateway_enabled: false,
            context_max_messages: momo_agent::mention::CONTEXT_WINDOW_DEFAULT,
            utc_offset_minutes: 540,
            egress: momo_settings::EgressPolicy::default(),
            report_protocol_enabled: true,
            memory: MemoryConfig::default(),
        }
    }

    /// The same config with an operator env key (`HERMES_API_KEY`) set — for
    /// tests and embeddings whose turns are meant to reach a model. Since
    /// #2897 a turn with no team key calls no model at all, and
    /// [`WorkerConfig::for_target`] deliberately configures none.
    pub fn with_env_bearer(mut self, bearer: impl Into<String>) -> WorkerConfig {
        self.provider.bearer = bearer.into();
        self
    }

    /// The protocol block this configuration puts in front of a turn — `None`
    /// when the operator opted out.
    ///
    /// A method rather than an `if` at the call site because `None` is not
    /// merely "the off case": it is the **pre-#1454 value**, the one
    /// [`crate::context::assemble`] has always treated as absence, and the only
    /// one whose output is byte-identical to the context this worker assembled
    /// before the card existed. Spelling the off path as a value keeps that
    /// property from depending on whoever next edits the call site.
    pub fn report_protocol_block(&self) -> Option<&'static str> {
        self.report_protocol_enabled
            .then_some(crate::completion_report::REPORT_PROTOCOL_BLOCK)
    }
}

/// The B7.2 ceilings, from the environment.
///
/// `A2A_MAX_DEPTH` is the ticket's key; `MAX_DEPTH` / `MAX_CONSECUTIVE_AUTO` /
/// `MAX_STEPS` / `G1_STALE_RUNNING_SECONDS` are the **Swift AgentWorker's**
/// (`Config.swift:137-141`), read as the fallback so one env block still drives
/// either implementation — the stated goal of this module.
///
/// Everything is [`A2aLimits::clamped`] before it leaves: an operator's typo
/// must become a policy refusal, never a `CHECK` violation inside a turn
/// transaction. See [`momo_agent::a2a::SCHEMA_DEPTH_CEILING`].
fn a2a_limits_from_env() -> Result<A2aLimits, ConfigError> {
    let default = A2aLimits::default();
    let max_depth = match env("A2A_MAX_DEPTH") {
        Some(raw) => raw
            .trim()
            .parse::<i32>()
            .map_err(|_| ConfigError::NotANumber("A2A_MAX_DEPTH"))?,
        None => env_number("MAX_DEPTH", default.max_depth)?,
    };
    Ok(A2aLimits {
        max_depth,
        max_consecutive_auto: env_number("MAX_CONSECUTIVE_AUTO", default.max_consecutive_auto)?,
        max_steps: env_number("MAX_STEPS", default.max_steps)?,
        g1_stale_running_seconds: env_number(
            "G1_STALE_RUNNING_SECONDS",
            default.g1_stale_running_seconds,
        )?,
        max_chain_tokens: env_number("A2A_MAX_CHAIN_TOKENS", default.max_chain_tokens)?,
        max_chain_cost_micro_usd: env_number(
            "A2A_MAX_CHAIN_COST_MICRO_USD",
            default.max_chain_cost_micro_usd,
        )?,
    }
    .clamped())
}

/// `AGENT_GATEWAY_MODE` — momo-server's `AgentGatewayMode::parse` (Swift
/// `:150-155`), including the rule that matters: **anything unrecognised falls
/// back to `worker`**, so a typo cannot silently route every delegated job into
/// a feed no consumer is claiming.
fn gateway_enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("gateway")
    )
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

    /// Review M-1: the built-in `http://localhost:8088/v1` default must not
    /// become a connect-time exemption; an operator-written value does.
    #[test]
    fn only_an_operator_written_hermes_base_url_is_trusted_for_egress() {
        let default = ProviderConfig::from_env(|_| None);
        let policy = egress_policy(&default, false, |flag| momo_settings::EgressPolicy {
            allow_local: flag,
            ..Default::default()
        });
        assert!(policy.operator_hosts.is_empty(), "{policy:?}");
        assert!(policy
            .check_resolved("localhost", &["127.0.0.1".parse().unwrap()])
            .is_err());

        let written = ProviderConfig::from_env(|key| {
            (key == "HERMES_BASE_URL").then(|| "http://mock-hermes:8088/v1".to_string())
        });
        let policy = egress_policy(&written, true, |_| Default::default());
        assert_eq!(policy.operator_hosts, vec!["mock-hermes".to_string()]);
    }
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

    /// A typo in `AGENT_GATEWAY_MODE` must not move delegated jobs onto a feed
    /// nobody claims — Swift's parse falls back to `worker` for exactly this.
    #[test]
    fn only_the_literal_gateway_mode_turns_the_gateway_feed_on() {
        assert!(gateway_enabled(Some("gateway")));
        assert!(gateway_enabled(Some("  GATEWAY  ")));
        assert!(!gateway_enabled(Some("gatewey")));
        assert!(!gateway_enabled(Some("worker")));
        assert!(!gateway_enabled(None));
    }

    /// #1466 — the block ships **on**, and only an explicitly negative word
    /// takes it away.
    ///
    /// The asymmetry with [`only_the_literal_gateway_mode_turns_the_gateway_feed_on`]
    /// is the point: both fall back to the shipped behaviour on a typo, and the
    /// shipped behaviour differs. Flip this parse to "only the literal `1`
    /// keeps it" and every deployment that never heard of the key loses the
    /// card at its next boot.
    #[test]
    fn the_report_protocol_ships_on_and_only_an_explicit_word_removes_it() {
        assert!(report_protocol_enabled(None), "unset means on");
        for off in ["0", "false", "no", "off", "  OFF  ", "False"] {
            assert!(!report_protocol_enabled(Some(off)), "{off:?} must opt out");
        }
        for on in ["1", "true", "yes", "on", ""] {
            assert!(report_protocol_enabled(Some(on)), "{on:?} must keep it on");
        }
        // A typo keeps the capability rather than silently removing it.
        assert!(report_protocol_enabled(Some("offf")));
        assert!(report_protocol_enabled(Some("disabled")));
    }

    /// Off must hand the assembler the **pre-#1454 `None`**, not a block that
    /// happens to be empty: an empty `system` turn is still a turn, and the
    /// acceptance criterion is byte-identical context.
    ///
    /// The context-level proof is
    /// `context::tests::the_config_opt_out_assembles_the_byte_identical_pre_protocol_context`;
    /// this is the config half of the same seam.
    #[test]
    fn opting_out_hands_the_assembler_the_pre_protocol_none() {
        let mut config = WorkerConfig::for_target("postgres://x/y");
        assert!(config.report_protocol_enabled, "the shipped default is on");
        assert_eq!(
            config.report_protocol_block(),
            Some(crate::completion_report::REPORT_PROTOCOL_BLOCK)
        );
        config.report_protocol_enabled = false;
        assert_eq!(config.report_protocol_block(), None);
    }

    /// The shipped default is the ticket's cap, already clamped to the schema's
    /// (007 `depth <= 4`), so the worker cannot be booted into a configuration
    /// whose successful path aborts a turn transaction.
    #[test]
    fn the_default_a2a_depth_is_the_tickets_cap_and_fits_the_schema() {
        let config = WorkerConfig::for_target("postgres://x/y");
        assert_eq!(config.a2a.max_depth, momo_agent::DEFAULT_A2A_MAX_DEPTH);
        assert!(config.a2a.max_depth <= momo_agent::SCHEMA_DEPTH_CEILING);
        assert_eq!(
            config.a2a.max_consecutive_auto,
            momo_agent::DEFAULT_MAX_CONSECUTIVE_AUTO
        );
        assert_eq!(config.a2a.max_steps, momo_agent::DEFAULT_MAX_STEPS);
    }
}
