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

        Ok(Config {
            host: env_or("HOST", "0.0.0.0"),
            port: env_number("PORT", 8080u16)?,
            db,
            jwt_secret,
            environment: env_or("MOMO_ENV", "local"),
            realtime_ws_url: realtime_ws_url_from_env()?,
            t3: T3Settings::from_env(),
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
