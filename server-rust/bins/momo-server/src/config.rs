//! Process configuration, sourced **only** from the environment.
//!
//! Deliberately narrow: this batch's routes need a listen address, a DB pool, the
//! app JWT secret, the environment label, and the realtime URL advertised to
//! sessions. The Swift `Config.swift` surface (provider keys, rate limits, CORS,
//! LiveKit, …) is intentionally NOT ported here — each lands with the batch that
//! needs it.
//!
//! **The deployed env contract is `infra/prod/docker-compose.prod.yml`'s `api`
//! service (:148-189), not this file** (B1.7): every key read here is spelled the
//! way that compose spells it — `MOMO_ENV`, `HOST`, `PORT`, `DATABASE_URL`,
//! `JWT_HMAC`, `MOMO_CENTRIFUGO_WS_URL`, `LOG_LEVEL` — so one env block boots
//! either implementation. Keys that compose sets and this server does not yet
//! consume (`CENT_*`, `HERMES_*`, `AGENT_*`, `MOMO_S3_*`, the webhook/provider
//! master keys, `MOMO_METRICS_*`) are **ignored, never fatal**: an unread
//! variable must not block a boot. The reverse — a *required* key missing — is
//! always fatal, never a baked-in default.
//!
//! There is no `.env` reader anywhere in this crate: injecting the environment
//! is the operator's job (compose/systemd), so no secret is ever read from a file
//! by this process, and no secret value is ever logged.

use momo_db::pool::PoolConfig;

/// Fatal misconfiguration found at boot. Messages name environment *keys* only —
/// never values.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("set DATABASE_URL (or POSTGRES_HOST/PORT/USER/PASSWORD/DB)")]
    MissingDatabase,
    #[error("DATABASE_URL is not a postgres connection string: {0}")]
    InvalidDatabaseUrl(&'static str),
    #[error("set JWT_HMAC (or MOMO_JWT_SECRET) to the app JWT signing secret")]
    MissingJwtSecret,
    #[error("{0} must be a number")]
    NotANumber(&'static str),
    /// A security contract the operator asked for but did not supply the input
    /// for. Names the environment **key**, never the value.
    #[error("invalid security config: {0}")]
    InvalidSecurity(&'static str),
}

/// Everything the server needs to boot.
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub db: PoolConfig,
    /// HS256 secret for App JWTs. Held in memory only; never logged.
    pub jwt_secret: String,
    /// `MOMO_ENV` label (local/staging/prod), used for log context.
    pub environment: String,
    /// The ONLY authority for the realtime WebSocket address (ADR-0110): clients
    /// must never derive it from the API origin.
    pub realtime_ws_url: String,
    /// T3 (momo Cloud) settings — **off unless the operator turns them on**
    /// (B2.2).
    pub t3: T3Settings,
    /// AgentGateway settings — **`worker` mode unless the operator selects
    /// `gateway`** (B2.6).
    pub agent_gateway: AgentGatewaySettings,
    /// Centrifugo connection-token / subscribe-proxy settings — **fail-closed
    /// unless the operator supplies the two secrets** (B4).
    pub realtime: RealtimeSettings,
    /// 설정 표면 settings (B4.2) — provider master key, the env provider tier,
    /// and the instance-operator allow-list. Fail-closed by default.
    pub settings: SettingsConfig,
}

/// MOMO-325 native gateway mode (Swift `AgentGatewayMode`, `Config.swift:150-155`).
///
/// `worker` is the product default: AgentWorker claims `agent_job` outbox rows
/// and calls the provider directly, and the gateway callback surface does not
/// exist. `gateway` is the Hermes platform-adapter path this batch implements —
/// the server owns the authoritative run/ledger shell and accepts status/result
/// callbacks over REST.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AgentGatewayMode {
    #[default]
    Worker,
    Gateway,
}

impl AgentGatewayMode {
    /// Swift `AgentGatewayMode.parse` (:150-155): trimmed, lowercased, and
    /// **anything unrecognised falls back to `worker`** — a typo must not
    /// silently expose the callback surface.
    pub fn parse(raw: Option<&str>) -> AgentGatewayMode {
        match raw
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("gateway") => AgentGatewayMode::Gateway,
            _ => AgentGatewayMode::Worker,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AgentGatewayMode::Worker => "worker",
            AgentGatewayMode::Gateway => "gateway",
        }
    }
}

/// Process-level AgentGateway configuration (Swift `AgentGatewayConfig`,
/// `Config.swift:468-492`).
///
/// `secret` is the **deprecated** shared secret, kept only so an existing Hermes
/// deployment can finish rotating to per-agent bearers. It is inert unless all
/// three of mode/flag/quality hold ([`AgentGatewaySettings::legacy_secret_enabled`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentGatewaySettings {
    pub mode: AgentGatewayMode,
    /// `AGENT_GATEWAY_SECRET`. Never logged, never echoed; used for a
    /// constant-time comparison and for redacting itself out of gateway-reported
    /// error text.
    pub secret: String,
    /// `MOMO_ALLOW_LEGACY_GATEWAY_SECRET`.
    pub allow_legacy_secret: bool,
}

impl AgentGatewaySettings {
    pub fn from_env() -> AgentGatewaySettings {
        AgentGatewaySettings {
            mode: AgentGatewayMode::parse(env("AGENT_GATEWAY_MODE").as_deref()),
            secret: env("AGENT_GATEWAY_SECRET").unwrap_or_default(),
            allow_legacy_secret: bool_flag(env("MOMO_ALLOW_LEGACY_GATEWAY_SECRET").as_deref()),
        }
    }

    /// Whether the gateway callback surface exists at all (Swift `enabled`).
    pub fn enabled(&self) -> bool {
        self.mode == AgentGatewayMode::Gateway
    }

    /// Whether `secret` is a real value rather than a placeholder (Swift
    /// `secretConfigured`).
    pub fn secret_configured(&self) -> bool {
        !is_unsafe_secret(&self.secret)
    }

    /// The legacy shared-secret header is accepted only when gateway mode is on,
    /// the operator explicitly opted in, **and** the secret is not a placeholder
    /// (Swift `legacySecretEnabled` :489-491).
    ///
    /// The third condition is the one that matters: without it, setting the
    /// opt-in flag with an unset `AGENT_GATEWAY_SECRET` would make the empty
    /// string a valid credential for every callback on the instance.
    pub fn legacy_secret_enabled(&self) -> bool {
        self.enabled() && self.allow_legacy_secret && self.secret_configured()
    }

    /// Swift `validateSecurityForBoot`'s first check (`Config.swift:163-171`):
    /// asking for the legacy path without a usable secret is a **boot error**,
    /// not a warning — the operator asked for a credential that cannot exist.
    pub fn boot_error(&self) -> Option<&'static str> {
        if self.enabled() && self.allow_legacy_secret && !self.secret_configured() {
            Some("AGENT_GATEWAY_SECRET is required when MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1")
        } else {
            None
        }
    }
}

/// Swift `AgentProviderConfig.boolFlag` (`Config.swift:679-686`).
pub fn bool_flag(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Swift `AgentProviderConfig.isUnsafeSecret` (`Config.swift:646-657`), verbatim.
///
/// Ported rather than reduced to "is it empty" because the placeholder list is
/// what catches the actual failure mode: a `.env.example` copied to `.env` with
/// `change-me` left in place boots, looks configured, and accepts a secret the
/// whole internet knows.
pub fn is_unsafe_secret(value: &str) -> bool {
    let lowered = value.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return true;
    }
    const RESERVED: [&str; 11] = [
        "password",
        "secret",
        "token",
        "default",
        "dev",
        "test",
        "staging",
        "prod",
        "production",
        "admin",
        "momo",
    ];
    if RESERVED.contains(&lowered.as_str()) {
        return true;
    }
    [
        "change-me",
        "changeme",
        "dev-insecure",
        "placeholder",
        "example",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

/// Constant-time string comparison (Swift `ConstantTime.equals`,
/// `Auth/ConstantTime.swift:13-22`).
///
/// Used for the legacy gateway secret. A `==` here would leak the secret one byte
/// at a time to an attacker who can measure the response, which is precisely the
/// attack a shared secret with no other binding is exposed to.
pub fn constant_time_eq(lhs: &str, rhs: &str) -> bool {
    let (lhs, rhs) = (lhs.as_bytes(), rhs.as_bytes());
    if lhs.len() != rhs.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in lhs.iter().zip(rhs.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

/// Process-level **realtime** configuration (B4).
///
/// Two secrets, two different jobs, and neither has a baked-in default — the
/// same rule the rest of this file follows. `infra/prod/docker-compose.prod.yml`
/// already injects both into the `api` service (:159, :164), so this reads the
/// deployed spelling rather than inventing one.
///
/// * `CENT_TOKEN_HMAC` signs the short-lived Centrifugo **connection** token.
///   Distinct from `JWT_HMAC` on purpose (Swift registers them under separate
///   kids, `Auth/JWT.swift:104-113`): one key for the broker, one for REST, so a
///   broker-side leak cannot mint API access tokens.
/// * `CENT_PROXY_SECRET` authenticates Centrifugo's **subscribe proxy**
///   callback. Absent, the callback route refuses every request — network
///   position alone never authenticates it (MOMO-300).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RealtimeSettings {
    /// `CENT_TOKEN_HMAC`. `None` = this instance cannot issue connection tokens
    /// and `POST /v1/auth/realtime-token` answers 503.
    pub cent_token_hmac: Option<String>,
    /// `CENT_PROXY_SECRET`. `None` = every subscribe callback is a 401.
    pub cent_proxy_secret: Option<String>,
    /// `CENT_CONNECTION_TOKEN_TTL_SECONDS`, clamped by
    /// [`clamp_connection_token_ttl`] (Swift default 300).
    pub connection_token_ttl_seconds: i64,
}

/// Connection-token TTL bounds, Swift `Config.clampedCentConnectionTokenTTL`
/// (`Config.swift:138-140`) verbatim: `[60s, 30m]`.
///
/// Both ends are real. Below the floor every reconnect becomes a token fetch,
/// so a flaky network turns into a request storm against the auth path. Above
/// the ceiling a revoked session keeps a *usable* connection token for as long
/// as the operator typed, which is the window the whole `meta.token_id` binding
/// exists to keep short.
pub fn clamp_connection_token_ttl(seconds: i64) -> i64 {
    seconds.clamp(60, 30 * 60)
}

impl RealtimeSettings {
    pub fn from_env() -> RealtimeSettings {
        RealtimeSettings {
            cent_token_hmac: env("CENT_TOKEN_HMAC"),
            cent_proxy_secret: env("CENT_PROXY_SECRET"),
            connection_token_ttl_seconds: clamp_connection_token_ttl(
                env("CENT_CONNECTION_TOKEN_TTL_SECONDS")
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(momo_auth::CONNECTION_TOKEN_TTL_SECONDS),
            ),
        }
    }

    /// Swift `Config.validateSecurityForBoot` (:163-180) for the one key it
    /// checks here: in a **strict** environment a missing or placeholder
    /// `CENT_PROXY_SECRET` is a boot error, because both outcomes are bad and
    /// silent — either nobody can subscribe, or (had we skipped verification)
    /// anybody could forge the callback. Local/dev is left alone, exactly like
    /// Swift, so a laptop stack still boots on the committed placeholder.
    pub fn boot_error(&self, environment: &str) -> Option<&'static str> {
        if !requires_strict_secrets(environment) {
            return None;
        }
        let usable = self
            .cent_proxy_secret
            .as_deref()
            .is_some_and(|secret| !is_unsafe_secret(secret));
        if usable {
            None
        } else {
            Some("CENT_PROXY_SECRET is missing or uses a placeholder/dev value")
        }
    }
}

/// Settings-surface configuration (B4.2) — everything the 설정 표면 needs that
/// is not already in [`Config`].
///
/// Two of the three fields are *fail-closed switches*, not tuning:
///
/// * `provider_link_master_key` absent ⇒ the whole `/v1/provider/link[…]` family
///   answers **503**. It is the AES-GCM key migrations 039/042 sealed every
///   stored bearer under; without it this server can neither open a stored row
///   nor seal a new one, and answering anything other than "not configured"
///   would mean guessing at an operator credential.
/// * `platform_admin_emails` empty ⇒ the listed-instance-operator path is closed
///   and only a `platform:read` token reaches the instance-global surfaces. That
///   is the MOMO-583 posture: an arbitrary workspace owner is **not** an
///   instance operator, and an unset allow-list grants nobody.
///
/// `env_provider` is the boot-time `HERMES_*` trio — the *env tier* of the
/// ADR-0004 증보 1 precedence (DB link > env). It carries a bearer, so it is
/// never `Debug`-printed; see the manual impl below.
#[derive(Clone)]
pub struct SettingsConfig {
    /// `PROVIDER_LINK_MASTER_KEY`. Held in memory only; never logged, never
    /// echoed, never used for anything but AES-GCM key derivation.
    pub provider_link_master_key: Option<String>,
    /// The `HERMES_*` env trio, resolved once at boot.
    pub env_provider: momo_settings::ProviderConfig,
    /// `PLATFORM_ADMIN_EMAILS`, lowercased — the same key [`T3Settings`] reads.
    /// One operator allow-list, two consumers.
    pub platform_admin_emails: Vec<String>,
    /// `MOMO_ENV`, carried here rather than read off [`Config`] because the
    /// base-URL gate needs it on every provider write: in a strict environment
    /// (`staging`/`prod`/…) an operator's local-loopback flag stops applying, so
    /// the environment label is an input to an authorization-shaped decision and
    /// belongs beside the other settings inputs.
    pub environment: String,
}

impl Default for SettingsConfig {
    /// Fail-closed: no master key (the AI-연결 family answers 503), no listed
    /// operator, and `local` — which is the *permissive* environment label, so a
    /// test or an embedded boot never has a strict gate silently applied to it.
    fn default() -> Self {
        SettingsConfig {
            provider_link_master_key: None,
            env_provider: momo_settings::ProviderConfig::default(),
            platform_admin_emails: Vec::new(),
            environment: "local".to_string(),
        }
    }
}

impl std::fmt::Debug for SettingsConfig {
    /// Hand-written for the same reason [`crate::AppState`]'s is: `env_provider`
    /// holds `HERMES_API_KEY`, and a `{:?}` in a log line is exactly how a
    /// provider bearer reaches a log aggregator.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SettingsConfig")
            .field(
                "provider_link_master_key_configured",
                &self.provider_link_master_key.is_some(),
            )
            .field("provider_mode", &self.env_provider.mode.as_str())
            .field("platform_admin_emails", &self.platform_admin_emails.len())
            .finish_non_exhaustive()
    }
}

impl SettingsConfig {
    pub fn from_env() -> SettingsConfig {
        SettingsConfig {
            provider_link_master_key: env("PROVIDER_LINK_MASTER_KEY"),
            env_provider: momo_settings::ProviderConfig::from_env(env),
            platform_admin_emails: platform_admin_emails_from_env(),
            environment: env_or("MOMO_ENV", "local"),
        }
    }

    /// Swift's `Config` refuses to boot when the provider master key REUSES
    /// another master key (migration 039 header: never `JWT_HMAC`, never
    /// `OUTBOUND_WEBHOOK_MASTER_KEY`).
    ///
    /// Reuse would make a provider-bearer leak a token-signing leak: one
    /// compromised value would both open every stored provider credential and
    /// mint App JWTs. **Absence** is not an error — it closes the surface with a
    /// 503 instead, because an instance that never configured a DB provider link
    /// is a perfectly good instance.
    pub fn boot_error(&self, jwt_secret: &str) -> Option<&'static str> {
        let key = self.provider_link_master_key.as_deref()?;
        if key == jwt_secret {
            return Some("PROVIDER_LINK_MASTER_KEY must not reuse JWT_HMAC");
        }
        if env("OUTBOUND_WEBHOOK_MASTER_KEY").as_deref() == Some(key) {
            return Some("PROVIDER_LINK_MASTER_KEY must not reuse OUTBOUND_WEBHOOK_MASTER_KEY");
        }
        None
    }
}

/// `PLATFORM_ADMIN_EMAILS` → lowercased, comma-split, blanks dropped.
fn platform_admin_emails_from_env() -> Vec<String> {
    env("PLATFORM_ADMIN_EMAILS")
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

/// Swift `AgentProviderConfig.requiresStrictExternalProvider`
/// (`Config.swift:637-644`), verbatim: the deployed environments where a
/// placeholder secret is a boot error rather than a developer convenience.
pub fn requires_strict_secrets(environment: &str) -> bool {
    matches!(
        environment.trim().to_ascii_lowercase().as_str(),
        "staging" | "prod" | "production" | "internal-host"
    )
}

/// Process-level T3 configuration (B2.2).
///
/// Port of Swift `CloudProviderSettings.load` + `requireReady`
/// (`services/CloudProviderKit/.../CloudProviderSettings.swift:49-113`) reduced
/// to what the REST surface reads. Two things are deliberately **absent**:
///
/// * **provider endpoints/credentials.** They are loaded by
///   `momo_t3::provider::registry` into the process only (ADR-0142 D4,
///   invariant #7) and no route ever sees them. This struct carries the
///   *default provider id*, which is a registry key, not a credential.
/// * **any `.env` reading.** As with the rest of this file, injecting the
///   environment is the operator's job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct T3Settings {
    /// `MOMO_T3_ENABLED == "1"`. Swift's default is OFF and so is this one:
    /// "momo Cloud(T3)는 기본 비활성입니다" (`CloudProvisionerRoutes.disabledError`).
    pub enabled: bool,
    /// `MOMO_T3_PROVIDER`, a registry id. Default `byoc` — the one adapter that
    /// needs no operator credential at all.
    pub default_provider_id: String,
    /// `MOMO_PUBLIC_BASE_URL`. Handed to a workd as the address it registers
    /// against, so it must be an absolute https URL or T3 stays shut.
    pub public_base_url: Option<String>,
    /// `MOMO_T3_RATE_MICRO_USD_PER_SECOND` (default 25, floor 1).
    pub unit_rate_micro_usd_second: i64,
    /// `PLATFORM_ADMIN_EMAILS`, lowercased. The listed-instance-operator path of
    /// `CloudCreditRoutes.requireCreditWriter`.
    pub platform_admin_emails: Vec<String>,
}

impl Default for T3Settings {
    fn default() -> Self {
        T3Settings {
            enabled: false,
            default_provider_id: "byoc".to_string(),
            public_base_url: None,
            unit_rate_micro_usd_second: 25,
            platform_admin_emails: Vec::new(),
        }
    }
}

impl T3Settings {
    pub fn from_env() -> T3Settings {
        T3Settings {
            enabled: env("MOMO_T3_ENABLED").as_deref() == Some("1"),
            default_provider_id: env("MOMO_T3_PROVIDER")
                .map(|value| value.trim().to_lowercase())
                .unwrap_or_else(|| "byoc".to_string()),
            public_base_url: env("MOMO_PUBLIC_BASE_URL").map(|value| value.trim().to_string()),
            unit_rate_micro_usd_second: env("MOMO_T3_RATE_MICRO_USD_PER_SECOND")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(25)
                .max(1),
            platform_admin_emails: env("PLATFORM_ADMIN_EMAILS")
                .unwrap_or_default()
                .split(',')
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty())
                .collect(),
        }
    }

    /// `requireReady`'s public-URL half: absolute **https** with a host, trailing
    /// slashes trimmed. Returns `None` when T3 must stay shut.
    ///
    /// https is not decoration: this URL is where a workd will send a bearer
    /// bootstrap token, so an http endpoint would put a one-shot credential on
    /// the wire in clear text.
    pub fn ready_public_base_url(&self) -> Option<String> {
        let raw = self.public_base_url.as_deref()?.trim();
        let rest = raw.strip_prefix("https://")?;
        let host = rest.split('/').next().unwrap_or("");
        if host.is_empty() {
            return None;
        }
        Some(raw.trim_end_matches('/').to_string())
    }
}

fn env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    env(key).unwrap_or_else(|| fallback.to_string())
}

fn env_number<T: std::str::FromStr>(key: &'static str, fallback: T) -> Result<T, ConfigError> {
    match env(key) {
        Some(raw) => raw.parse::<T>().map_err(|_| ConfigError::NotANumber(key)),
        None => Ok(fallback),
    }
}

impl Config {
    /// Read the process environment. Fails closed on a missing DB target or JWT
    /// secret rather than falling back to a baked-in development credential.
    pub fn from_env() -> Result<Config, ConfigError> {
        let db = pool_config_from_env()?;
        // `JWT_HMAC` is the canonical name: it is what the prod compose api
        // service injects (`docker-compose.prod.yml:153`) and what every
        // deploy/verifier script already exports. `MOMO_JWT_SECRET` stays as a
        // compatibility fallback for the B1.5 local harnesses; if both are set
        // the deployed name wins, so a stale developer export can never silently
        // sign tokens with a different key than the operator configured.
        let jwt_secret = env("JWT_HMAC")
            .or_else(|| env("MOMO_JWT_SECRET"))
            .ok_or(ConfigError::MissingJwtSecret)?;

        // B2.6: fail the boot, do not degrade. Swift's `validateSecurityForBoot`
        // throws here too — an instance that advertises a credential path it
        // cannot honour is worse than one that refuses to start.
        let agent_gateway = AgentGatewaySettings::from_env();
        if let Some(message) = agent_gateway.boot_error() {
            return Err(ConfigError::InvalidSecurity(message));
        }

        let environment = env_or("MOMO_ENV", "local");
        // B4: same fail-the-boot posture. An instance that advertises a realtime
        // rail whose proxy callback can never be authenticated would look healthy
        // and serve nothing.
        let realtime = RealtimeSettings::from_env();
        if let Some(message) = realtime.boot_error(&environment) {
            return Err(ConfigError::InvalidSecurity(message));
        }

        // B4.2: the only settings misconfiguration worth refusing a boot over.
        // A *missing* provider master key closes the surface (503); a *reused*
        // one silently merges two blast radii, so it is fatal here rather than
        // discovered after a leak.
        let settings = SettingsConfig::from_env();
        if let Some(message) = settings.boot_error(&jwt_secret) {
            return Err(ConfigError::InvalidSecurity(message));
        }

        Ok(Config {
            host: env_or("HOST", "0.0.0.0"),
            port: env_number("PORT", 8080u16)?,
            db,
            jwt_secret,
            environment,
            realtime_ws_url: realtime_ws_url_from_env()?,
            t3: T3Settings::from_env(),
            agent_gateway,
            realtime,
            settings,
        })
    }
}

/// Build the api-role pool config. `DATABASE_URL` wins (the same variable the
/// Swift server, the migration runner and compose already use); the
/// `POSTGRES_*` pieces are the fallback.
pub fn pool_config_from_env() -> Result<PoolConfig, ConfigError> {
    let max_connections = env_number("MOMO_DB_MAX_CONNECTIONS", 10u32)?;
    if let Some(url) = env("DATABASE_URL") {
        let parts = parse_database_url(&url)?;
        return Ok(PoolConfig {
            host: parts.host,
            port: parts.port,
            username: parts.username,
            password: parts.password,
            database: parts.database,
            max_connections,
        });
    }
    let (Some(username), Some(password)) = (env("POSTGRES_USER"), env("POSTGRES_PASSWORD")) else {
        return Err(ConfigError::MissingDatabase);
    };
    Ok(PoolConfig {
        host: env_or("POSTGRES_HOST", "localhost"),
        port: env_number("POSTGRES_PORT", 5432u16)?,
        username,
        password,
        database: env_or("POSTGRES_DB", "momo"),
        max_connections,
    })
}

/// The pieces of a `postgres://` URL this process cares about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseUrlParts {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: String,
}

/// Minimal `postgres://user:pass@host:port/db` parser, mirroring the Swift
/// relay/server `parseDatabaseURL` (no URL crate dependency for one call site).
/// Percent-escapes in the userinfo and database name are decoded.
pub fn parse_database_url(raw: &str) -> Result<DatabaseUrlParts, ConfigError> {
    let rest = raw
        .strip_prefix("postgres://")
        .or_else(|| raw.strip_prefix("postgresql://"))
        .ok_or(ConfigError::InvalidDatabaseUrl(
            "expected a postgres:// or postgresql:// scheme",
        ))?;

    // Strip any query string; connection parameters are not used by this batch.
    let rest = rest.split('?').next().unwrap_or(rest);
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => (rest, ""),
    };
    // The userinfo may contain '@' only percent-encoded, so the LAST '@'
    // separates userinfo from host.
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((userinfo, hostport)) => (userinfo, hostport),
        None => ("", authority),
    };
    let (username, password) = match userinfo.split_once(':') {
        Some((user, pass)) => (percent_decode(user), percent_decode(pass)),
        None => (percent_decode(userinfo), String::new()),
    };
    let (host, port) = split_host_port(hostport)?;
    if host.is_empty() {
        return Err(ConfigError::InvalidDatabaseUrl("missing host"));
    }
    let database = percent_decode(path);
    Ok(DatabaseUrlParts {
        host,
        port,
        username,
        password,
        database: if database.is_empty() {
            "momo".to_string()
        } else {
            database
        },
    })
}

fn split_host_port(hostport: &str) -> Result<(String, u16), ConfigError> {
    // Bracketed IPv6 literal: [::1]:5432
    if let Some(close) = hostport.find(']') {
        if hostport.starts_with('[') {
            let host = hostport[1..close].to_string();
            let port = match hostport[close + 1..].strip_prefix(':') {
                Some(port) => port
                    .parse()
                    .map_err(|_| ConfigError::InvalidDatabaseUrl("port is not a number"))?,
                None => 5432,
            };
            return Ok((host, port));
        }
    }
    match hostport.rsplit_once(':') {
        Some((host, port)) => Ok((
            host.to_string(),
            port.parse()
                .map_err(|_| ConfigError::InvalidDatabaseUrl("port is not a number"))?,
        )),
        None => Ok((hostport.to_string(), 5432)),
    }
}

/// Decode `%XX` escapes; anything malformed is passed through verbatim.
fn percent_decode(raw: &str) -> String {
    if !raw.contains('%') {
        return raw.to_string();
    }
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Port of Swift `Config.realtimeWebSocketURL(environment:)`: an explicit
/// `MOMO_CENTRIFUGO_WS_URL` wins when it is a ws/wss URL with a host; otherwise
/// the loopback default on `CENT_PORT`.
pub fn realtime_ws_url_from_env() -> Result<String, ConfigError> {
    if let Some(raw) = env("MOMO_CENTRIFUGO_WS_URL") {
        let raw = raw.trim();
        let host = raw
            .strip_prefix("ws://")
            .or_else(|| raw.strip_prefix("wss://"))
            .map(|rest| rest.split('/').next().unwrap_or(""))
            .unwrap_or("");
        if !host.is_empty() {
            return Ok(raw.to_string());
        }
    }
    let port: u16 = env_number("CENT_PORT", 8000u16)?;
    let port = if port == 0 { 8000 } else { port };
    Ok(format!("ws://127.0.0.1:{port}/connection/websocket"))
}

/// The tracing filter directive for this process.
///
/// `RUST_LOG` wins (the Rust ecosystem convention, and the only way to express a
/// per-target filter); otherwise the prod compose's `LOG_LEVEL`
/// (`docker-compose.prod.yml:189`) is honoured so an operator turning the stack
/// to `debug` actually changes what the Rust binaries emit — before B1.7 that
/// variable was silently inert. Neither set → `info`.
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
        assert_eq!(choose_log_filter(None, Some(" info ")), "info");
    }

    // -- B4 realtime -------------------------------------------------------

    fn realtime(proxy_secret: Option<&str>) -> RealtimeSettings {
        RealtimeSettings {
            cent_token_hmac: None,
            cent_proxy_secret: proxy_secret.map(str::to_string),
            connection_token_ttl_seconds: momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
        }
    }

    /// The default must be the closed one: an instance that configured nothing
    /// cannot mint a connection token and cannot authenticate a proxy callback.
    #[test]
    fn the_realtime_rail_is_shut_unless_the_operator_supplies_both_secrets() {
        let default = RealtimeSettings::default();
        assert!(default.cent_token_hmac.is_none());
        assert!(default.cent_proxy_secret.is_none());
    }

    /// Swift throws at boot for a placeholder proxy secret in a deployed
    /// environment, and tolerates it locally. Both halves matter: the first
    /// stops a stack that would either deny everything or accept a forged
    /// callback, the second keeps a laptop bootable.
    #[test]
    fn a_placeholder_proxy_secret_is_a_boot_error_only_in_strict_environments() {
        for environment in ["staging", "prod", "production", "internal-host", "PROD"] {
            assert!(
                realtime(None).boot_error(environment).is_some(),
                "{environment}: a missing CENT_PROXY_SECRET must fail the boot"
            );
            assert!(
                realtime(Some("dev-insecure-cent-proxy-secret"))
                    .boot_error(environment)
                    .is_some(),
                "{environment}: the committed placeholder must fail the boot"
            );
            assert!(
                realtime(Some("Zk3-a-real-rotated-value"))
                    .boot_error(environment)
                    .is_none(),
                "{environment}: a real secret boots"
            );
        }
        for environment in ["local", "dev-machine", ""] {
            assert!(
                realtime(None).boot_error(environment).is_none(),
                "{environment}: local is not strict"
            );
        }
    }

    /// Swift's exact bounds. A 5-second token would make every reconnect a
    /// token fetch; a day-long one would outlive the revocation it is bound to.
    #[test]
    fn the_connection_token_ttl_is_clamped_to_swifts_window() {
        assert_eq!(clamp_connection_token_ttl(300), 300);
        assert_eq!(clamp_connection_token_ttl(5), 60);
        assert_eq!(clamp_connection_token_ttl(0), 60);
        assert_eq!(clamp_connection_token_ttl(-1), 60);
        assert_eq!(clamp_connection_token_ttl(86_400), 1_800);
        assert_eq!(
            clamp_connection_token_ttl(momo_auth::CONNECTION_TOKEN_TTL_SECONDS),
            momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
            "the default must survive its own clamp"
        );
    }

    #[test]
    fn strict_environments_are_the_deployed_ones() {
        assert!(requires_strict_secrets("prod"));
        assert!(requires_strict_secrets(" Staging "));
        assert!(requires_strict_secrets("internal-host"));
        assert!(!requires_strict_secrets("local"));
        assert!(!requires_strict_secrets("test"));
    }

    // -- B2.6 agent gateway ------------------------------------------------

    fn gateway(mode: AgentGatewayMode, secret: &str, allow: bool) -> AgentGatewaySettings {
        AgentGatewaySettings {
            mode,
            secret: secret.to_string(),
            allow_legacy_secret: allow,
        }
    }

    /// The default must be the closed one: an operator who set nothing has no
    /// gateway callback surface at all.
    #[test]
    fn the_gateway_is_off_unless_the_operator_spells_gateway() {
        assert_eq!(
            AgentGatewaySettings::default().mode,
            AgentGatewayMode::Worker
        );
        assert!(!AgentGatewaySettings::default().enabled());
        for raw in [None, Some("worker"), Some("Gatway"), Some(""), Some("1")] {
            assert_eq!(AgentGatewayMode::parse(raw), AgentGatewayMode::Worker);
        }
        for raw in ["gateway", " GATEWAY ", "Gateway"] {
            assert_eq!(
                AgentGatewayMode::parse(Some(raw)),
                AgentGatewayMode::Gateway
            );
        }
    }

    /// All three conditions, and the third is the security-relevant one.
    #[test]
    fn the_legacy_secret_needs_mode_optin_and_a_real_value() {
        let real = "R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa";
        assert!(gateway(AgentGatewayMode::Gateway, real, true).legacy_secret_enabled());
        assert!(
            !gateway(AgentGatewayMode::Worker, real, true).legacy_secret_enabled(),
            "worker mode has no gateway surface to authenticate against"
        );
        assert!(
            !gateway(AgentGatewayMode::Gateway, real, false).legacy_secret_enabled(),
            "the deprecated path requires an explicit opt-in"
        );
        assert!(
            !gateway(AgentGatewayMode::Gateway, "", true).legacy_secret_enabled(),
            "an empty secret must never become a valid credential"
        );
        assert!(
            !gateway(AgentGatewayMode::Gateway, "change-me-please", true).legacy_secret_enabled(),
            "a placeholder must never become a valid credential"
        );
    }

    /// Asking for a credential path with no usable secret is fatal at boot, not
    /// a warning that leaves the instance half-open.
    #[test]
    fn an_optin_without_a_secret_is_a_boot_error() {
        assert_eq!(
            gateway(AgentGatewayMode::Gateway, "changeme", true).boot_error(),
            Some("AGENT_GATEWAY_SECRET is required when MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1")
        );
        // Without the opt-in the missing secret is simply unused, not an error.
        assert_eq!(
            gateway(AgentGatewayMode::Gateway, "", false).boot_error(),
            None
        );
        assert_eq!(
            gateway(AgentGatewayMode::Worker, "", true).boot_error(),
            None
        );
    }

    #[test]
    fn the_placeholder_list_matches_swift() {
        for value in [
            "",
            "  ",
            "secret",
            "PASSWORD",
            "dev",
            "prod",
            "momo",
            "admin",
            "token",
            "default",
            "test",
            "staging",
            "production",
            "change-me",
            "xCHANGEMEx",
            "dev-insecure-key",
            "my-placeholder",
            "example-secret",
        ] {
            assert!(is_unsafe_secret(value), "{value:?} must be rejected");
        }
        for value in ["R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa", "correct horse battery"] {
            assert!(!is_unsafe_secret(value), "{value:?} must be accepted");
        }
    }

    #[test]
    fn bool_flag_matches_swift() {
        for raw in ["1", "true", "yes", "on", " TRUE "] {
            assert!(bool_flag(Some(raw)));
        }
        for raw in ["0", "false", "no", "off", "", "maybe"] {
            assert!(!bool_flag(Some(raw)));
        }
        assert!(!bool_flag(None));
    }

    #[test]
    fn constant_time_eq_agrees_with_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("", "a"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn parses_a_full_database_url() {
        let parts = parse_database_url("postgres://someuser:somepass@db.internal:15432/momo")
            .expect("parse");
        assert_eq!(parts.host, "db.internal");
        assert_eq!(parts.port, 15432);
        assert_eq!(parts.username, "someuser");
        assert_eq!(parts.password, "somepass");
        assert_eq!(parts.database, "momo");
    }

    #[test]
    fn defaults_port_and_database() {
        let parts = parse_database_url("postgresql://u:p@localhost").expect("parse");
        assert_eq!(parts.port, 5432);
        assert_eq!(parts.database, "momo");
    }

    #[test]
    fn strips_query_parameters_and_decodes_escapes() {
        let parts =
            parse_database_url("postgres://a%40b:p%3Aw@localhost:5432/momo?sslmode=disable")
                .expect("parse");
        assert_eq!(parts.username, "a@b");
        assert_eq!(parts.password, "p:w");
        assert_eq!(parts.database, "momo");
    }

    #[test]
    fn parses_ipv6_authority() {
        let parts = parse_database_url("postgres://u:p@[::1]:6543/momo").expect("parse");
        assert_eq!(parts.host, "::1");
        assert_eq!(parts.port, 6543);
    }

    #[test]
    fn t3_is_off_and_byoc_by_default() {
        let settings = T3Settings::default();
        assert!(
            !settings.enabled,
            "momo Cloud must be opt-in (Swift parity)"
        );
        assert_eq!(settings.default_provider_id, "byoc");
        assert_eq!(settings.unit_rate_micro_usd_second, 25);
        assert!(settings.platform_admin_emails.is_empty());
        assert_eq!(settings.ready_public_base_url(), None);
    }

    #[test]
    fn the_public_base_url_must_be_absolute_https() {
        let with = |raw: &str| T3Settings {
            public_base_url: Some(raw.to_string()),
            ..T3Settings::default()
        };
        assert_eq!(
            with("https://momo.example.com/").ready_public_base_url(),
            Some("https://momo.example.com".to_string()),
            "trailing slashes are trimmed so the register URL joins cleanly"
        );
        // A bootstrap token is a bearer credential: plaintext transport is a
        // configuration error, not a warning.
        assert_eq!(
            with("http://momo.example.com").ready_public_base_url(),
            None
        );
        assert_eq!(with("https://").ready_public_base_url(), None);
        assert_eq!(with("momo.example.com").ready_public_base_url(), None);
    }

    #[test]
    fn rejects_a_non_postgres_url() {
        assert!(matches!(
            parse_database_url("mysql://u:p@localhost/momo"),
            Err(ConfigError::InvalidDatabaseUrl(_))
        ));
    }
}
