//! Process configuration, sourced **only** from the environment.
//!
//! Deliberately narrow: this batch's routes need a listen address, a DB pool, the
//! app JWT secret, the environment label, and the realtime URL advertised to
//! sessions. The Swift `Config.swift` surface is ported incrementally: each
//! subsystem's keys land with the Rust batch that consumes them.
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
    /// must never derive it from the API origin. `same-origin` (ADR-0167) is a
    /// per-request derivation, not a boot-time URL.
    pub realtime_ws_url: crate::realtime_advert::RealtimeAdvert,
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
    /// MOMO-300 rate-limit knobs (B4.3) — consumed by the public join and
    /// claim writes. **On by default**, because those routes are unauthenticated
    /// writes on the instance.
    pub rate_limit: RateLimitConfig,
    /// ADR-0162 / HAP-E2 Agent Port transport and its dedicated abuse bounds.
    /// These knobs are separate from the public join limiter so changing one
    /// surface can never silently widen the other.
    pub agent_port: AgentPortConfig,
    /// Mention→run routing knobs (B5.2). Always on; only the history window is
    /// configurable.
    pub mentions: MentionSettings,
    /// 휘발 신호 (ADR-0149, goal SRV-T2) — **off unless the operator hands this
    /// process the Centrifugo publish credential**, which no deployment did
    /// before this batch.
    pub ephemeral: EphemeralSettings,
    /// #1222 웹훅 — the outbound signing master key and the local-only plain-HTTP
    /// escape hatch. Never fatal and never closing: an operator who set neither
    /// gets `OUTBOUND_WEBHOOK_MASTER_KEY = JWT_HMAC` (Swift's own fallback) and
    /// an HTTPS-only destination policy.
    pub webhook: WebhookSettings,
    /// MOMO-605 CORS origin allowlist — **empty unless the operator names an
    /// origin**, and an empty one mounts no middleware at all.
    pub cors: CorsConfig,
    /// ADR-0151 / ADR-0169 Drive archive — **unavailable unless the operator
    /// names a backend**. Empty → 503. `local` writes a directory; `google`/`sa`
    /// need a service-account key and a shared drive. Same fail-closed posture
    /// as every other subsystem above.
    pub drive: DriveSettings,
    /// ADR-0122 / HD-1 — LiveKit is optional as one complete unit. If any of
    /// key, secret, or public URL is absent or invalid, all huddle routes stay
    /// mounted and answer 503 `허들 미구성`.
    pub livekit: Option<LiveKitConfig>,
    /// LIVE-5a / ADR-0165 증보 1 D3-2 — the oort-operated TURN relay's ephemeral
    /// credential policy. `None` on any instance that named no relay or no
    /// secret, and `None` means the display routes hand back an **empty**
    /// `ice_servers`, which is byte-for-byte what every deployment gets today.
    ///
    /// That emptiness is not a degraded mode, it is the retirement order: the
    /// producer template still carries the static credential the install runbook
    /// shipped, so an instance that has not been given the secret keeps working
    /// exactly as it did while the new path is proved beside it. Removing the
    /// static credential is a separate, later act — on the relay, not here.
    pub turn: Option<momo_t3::TurnCredentialPolicy>,
    /// The `MOMO_TURN_CREDENTIAL_TTL_SECONDS` the operator asked for, when it was
    /// **above the ceiling** and was clamped (LIVE-5a). `None` when they asked
    /// for something inside the bound, or for nothing at all.
    ///
    /// Carried as a fact rather than warned about where it is discovered,
    /// matching `CorsConfig::rejected_entries`: this file reads the environment
    /// and `main` owns the boot log, so a warning written here would be a second
    /// place deciding what an operator hears at startup.
    pub turn_ttl_clamped_from: Option<i64>,
}

/// LiveKit token issuer settings. The API secret is intentionally private and
/// the hand-written Debug implementation never prints credentials.
#[derive(Clone, PartialEq, Eq)]
pub struct LiveKitConfig {
    api_key: String,
    api_secret: String,
    pub url: String,
}

impl LiveKitConfig {
    pub fn parse(
        api_key: Option<&str>,
        api_secret: Option<&str>,
        url: Option<&str>,
    ) -> Option<Self> {
        let api_key = nonempty(api_key)?;
        let api_secret = nonempty(api_secret)?;
        let url = nonempty(url)?;
        let uri: axum::http::Uri = url.parse().ok()?;
        let valid_scheme = uri.scheme_str().is_some_and(|scheme| {
            ["http", "https", "ws", "wss"]
                .iter()
                .any(|candidate| scheme.eq_ignore_ascii_case(candidate))
        });
        if !valid_scheme || uri.host().is_none() {
            return None;
        }
        Some(LiveKitConfig {
            api_key: api_key.to_string(),
            api_secret: api_secret.to_string(),
            url: url.to_string(),
        })
    }

    pub fn from_env() -> Option<Self> {
        let api_key = env("MOMO_LIVEKIT_API_KEY");
        let api_secret = env("MOMO_LIVEKIT_API_SECRET");
        let url = env("MOMO_LIVEKIT_URL");
        Self::parse(api_key.as_deref(), api_secret.as_deref(), url.as_deref())
    }

    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn api_secret(&self) -> &str {
        &self.api_secret
    }
}

impl std::fmt::Debug for LiveKitConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LiveKitConfig")
            .field("api_key_configured", &true)
            .field("api_secret", &"<redacted>")
            .field("url", &self.url)
            .finish()
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// The workspace Drive archive's environment block (Swift
/// `DriveArchiveClientFactory`, `DriveArchiveClient.swift:76-129`).
///
/// Names kept verbatim so one env block configures either implementation during
/// the cutover — `MOMO_DRIVE_ARCHIVE_BACKEND` with `MOMO_DRIVE_BACKEND` as the
/// legacy alias, plus `MOMO_DRIVE_SA_KEY_PATH` and `MOMO_DRIVE_SHARED_DRIVE_ID`.
/// ADR-0169 adds `MOMO_DRIVE_LOCAL_DIR` for the self-host local-volume backend.
///
/// **No credential is in this struct.** `sa_key_path` is a path the operator
/// owns; the key material is read inside `momo-drive` and never comes back out
/// (ADR-0004: provider credentials do not flow through momo). `local` has no
/// credential at all.
#[derive(Debug, Clone, Default)]
pub struct DriveSettings {
    pub backend: String,
    pub sa_key_path: Option<String>,
    pub shared_drive_id: Option<String>,
    pub local_dir: Option<String>,
}

impl DriveSettings {
    pub fn from_env() -> DriveSettings {
        DriveSettings {
            backend: env("MOMO_DRIVE_ARCHIVE_BACKEND")
                .or_else(|| env("MOMO_DRIVE_BACKEND"))
                .map(|value| value.trim().to_lowercase())
                .unwrap_or_default(),
            sa_key_path: env("MOMO_DRIVE_SA_KEY_PATH"),
            shared_drive_id: env("MOMO_DRIVE_SHARED_DRIVE_ID"),
            local_dir: env("MOMO_DRIVE_LOCAL_DIR"),
        }
    }

    /// Boot refusals (Swift `DriveArchiveClientFactory.validateForBoot`, :77-87,
    /// plus ADR-0169).
    ///
    /// Fatal rather than degrading, unlike an *absent* archive:
    ///
    /// * A **stub** archive in a deployed environment accepts uploads, reports
    ///   them complete, and loses every byte on restart. That is the one Drive
    ///   configuration worth refusing to start over.
    /// * A **local** archive whose directory cannot be created or written would
    ///   look configured and then 503 every upload. Missing directory → create;
    ///   unwritable → refuse the boot. `local` itself is allowed in deployed
    ///   environments because the bytes survive a restart.
    pub fn boot_error(&self, environment: &str) -> Option<&'static str> {
        if self.backend == momo_drive::STUB_BACKEND && requires_strict_secrets(environment) {
            return Some(
                "MOMO_DRIVE_ARCHIVE_BACKEND=stub is forbidden in a deployed environment \
                 (staging/prod/production/internal-host)",
            );
        }
        if self.backend == momo_drive::LOCAL_BACKEND {
            let Some(dir) = self
                .local_dir
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                return Some(
                    "MOMO_DRIVE_LOCAL_DIR is required when MOMO_DRIVE_ARCHIVE_BACKEND=local",
                );
            };
            if let Err(message) = momo_drive::prepare_local_dir(dir) {
                return Some(message);
            }
        }
        None
    }

    /// Translate to the archive factory's own config.
    ///
    /// `stub_base_url` is the address **this process** answers on, because the
    /// stub's upload capability URLs point back at its own
    /// `/__momo_stub/drive/uploads/{token}` route. Swift resolves it the same
    /// way (`App.swift:32-33`): `MOMO_DRIVE_ARCHIVE_STUB_BASE_URL` if the
    /// operator named one, otherwise loopback on the serving port — which is
    /// right for a stub, since nothing outside the host should be uploading to
    /// an in-memory archive.
    pub fn backend_config(&self, port: u16) -> momo_drive::DriveBackendConfig {
        let stub_base_url = env("MOMO_DRIVE_ARCHIVE_STUB_BASE_URL")
            .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
        let local_base_url =
            env("MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL").unwrap_or_else(|| stub_base_url.clone());
        momo_drive::DriveBackendConfig {
            mode: self.backend.clone(),
            sa_key_path: self.sa_key_path.clone(),
            shared_drive_id: self.shared_drive_id.clone(),
            stub_base_url,
            local_dir: self.local_dir.clone(),
            local_base_url,
        }
    }
}

/// MOMO-300 request rate limiting (Swift `RateLimitConfig`, `Config.swift:283-302`).
///
/// Same environment keys and same defaults as the Swift server, so one env block
/// configures either implementation. A limit of 0 disables the axis.
///
/// The per-IP axis is mounted on the two unauthenticated writes (`/v1/join`
/// and `/v1/claim`). The per-member axis is not ported yet and the field is
/// deliberately absent rather than present-and-ignored — a knob that does
/// nothing is worse documentation than no knob.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitConfig {
    /// `RATE_LIMIT_WINDOW_SECONDS`, floor 1 (default 60).
    pub window_seconds: u64,
    /// `RATE_LIMIT_PER_IP` (default 1200). 0 disables. Join surface.
    pub per_ip_limit: u32,
    /// `RATE_LIMIT_CLAIM_PER_IP` (default 30). 0 disables. Claim surface.
    /// Independent of join so invite traffic cannot starve first-owner setup.
    pub claim_per_ip_limit: u32,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        RateLimitConfig {
            window_seconds: 60,
            per_ip_limit: 1200,
            claim_per_ip_limit: 30,
        }
    }
}

impl RateLimitConfig {
    pub fn from_env() -> RateLimitConfig {
        let defaults = RateLimitConfig::default();
        RateLimitConfig {
            window_seconds: env("RATE_LIMIT_WINDOW_SECONDS")
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(defaults.window_seconds)
                .max(1),
            per_ip_limit: env("RATE_LIMIT_PER_IP")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.per_ip_limit),
            claim_per_ip_limit: env("RATE_LIMIT_CLAIM_PER_IP")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.claim_per_ip_limit),
        }
    }
}

/// Stateless Agent Port transport configuration (ADR-0162 D2/D4).
///
/// The first wave is static-bearer only. `external_origin` is therefore not an
/// OAuth issuer or resource-metadata URL; it is solely the trusted comparison
/// value for a present browser `Origin` header. Native/provider HTTP clients
/// normally omit `Origin` and continue to work when it is unset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPortConfig {
    /// Exact HTTPS origin from `MOMO_AGENT_PORT_EXTERNAL_ORIGIN`, normalized to
    /// RFC 6454 serialization. `None` means every *present* Origin is refused.
    pub external_origin: Option<String>,
    /// Dedicated sliding-window width (default 60 seconds).
    pub window_seconds: u64,
    /// Requests per credential token id per window. 0 disables this axis.
    pub per_token_limit: u32,
    /// Requests per agent member id per window. 0 disables this axis.
    pub per_agent_limit: u32,
    /// Requests per socket peer per window. 0 disables this axis.
    pub per_ip_limit: u32,
    /// ADR-0162 HAP-E5/E6 — **the per-agent selector's gate: closed by default,
    /// and now an operator decision rather than a compile-time impossibility.**
    ///
    /// It governs the selector only: whether a mention of an agent with a live
    /// hosted connection is routed to the hosted gateway at all. The tool
    /// surface itself is gated by pairing, human confirmation, proof and
    /// scopes, none of which an operator can skip.
    ///
    /// HAP-E5 landed this field with [`hosted_delivery_from_env`] compiled only
    /// under `debug_assertions`, so a release binary answered `false` whatever
    /// the environment held. The reason was named in the issue: opening the
    /// selector before a disconnect lifecycle existed would hand work to a
    /// connection nobody could take back. **HAP-E6 (#1367) is that lifecycle**
    /// — an atomic revoke + pause + suppression start, a per-kind cleanup
    /// manifest, and a `disconnected` terminal that cannot be claimed while any
    /// required artifact is unresolved — so the `cfg` is gone and the variable
    /// is read in every build.
    ///
    /// What did **not** change: the default is `false`, only an exact `true`
    /// opens it, and constructing [`AgentPortConfig`] directly still overrides
    /// the environment (which is how every fixture and verifier sets it).
    /// Enabling hosted delivery in production is now an operator's explicit act,
    /// backed by the disconnect lifecycle that makes it revocable.
    pub hosted_delivery_enabled: bool,
    /// ADR-0162 증보 1 / HAP-E7 — the MCP OAuth 2.1 authorization server.
    ///
    /// **Disabled by default, and disabled is not "degraded".** With this off
    /// the server publishes no RFC 9728 protected-resource metadata, no RFC
    /// 8414 authorization-server metadata, and mounts no `/v1/oauth/*` route:
    /// the well-knowns and the endpoints are 404, exactly as they were before
    /// HAP-E7 existed. An OAuth access credential presented at the Agent Port
    /// is refused with the same `invalid_token` challenge as any other
    /// unrecognised string, so the flag cannot be probed.
    ///
    /// It stays off until #1369's consent surface lands and the runtime proof
    /// closes, because advertising an authorization server whose resource owner
    /// cannot actually see what they are approving is worse than advertising
    /// none.
    pub oauth: AgentPortOauthConfig,
}

/// One pre-registered public OAuth client.
///
/// First wave accepts **only** clients an operator wrote into the environment.
/// There is no Dynamic Client Registration and no URL-form Client ID Metadata
/// Document, so this server never fetches a URL a client named — the SSRF
/// surface those two features open needs its own ADR and threat model first.
///
/// There is no secret here and there is no field for one: every registered
/// client is public and proves possession with PKCE alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredOauthClient {
    pub client_id: String,
    /// Exact redirect URIs. Comparison is byte-exact at request time.
    pub redirect_uris: Vec<String>,
}

/// The authorization server's identity and client allowlist.
///
/// `issuer` is operator configuration and nothing else. `Host`, `Forwarded` and
/// `X-Forwarded-*` are never consulted, so a proxy or a caller cannot move the
/// issuer or the resource — which is the whole point of RFC 9207 issuer
/// identification and of RFC 9728's `authorization_servers` naming one exact
/// value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentPortOauthConfig {
    enabled: bool,
    issuer: Option<String>,
    /// Absolute https URL of the resource owner's consent screen (#1369).
    consent_url: Option<String>,
    clients: Vec<RegisteredOauthClient>,
}

impl AgentPortOauthConfig {
    /// The one predicate every OAuth surface asks. False means 404, not 503:
    /// a disabled authorization server does not exist, it is not merely busy.
    pub fn is_enabled(&self) -> bool {
        self.enabled
            && self.issuer.is_some()
            && self.consent_url.is_some()
            && !self.clients.is_empty()
    }

    pub fn issuer(&self) -> Option<&str> {
        self.is_enabled()
            .then_some(self.issuer.as_deref())
            .flatten()
    }

    pub fn consent_url(&self) -> Option<&str> {
        self.is_enabled()
            .then_some(self.consent_url.as_deref())
            .flatten()
    }

    /// The canonical Agent Port resource, derived from the issuer so the two can
    /// never disagree and neither can be moved by a request header.
    pub fn resource(&self) -> Option<String> {
        self.issuer()
            .map(|issuer| format!("{issuer}{}", momo_auth::HOSTED_AGENT_PORT_AUDIENCE))
    }

    pub fn endpoint(&self, path: &str) -> Option<String> {
        self.issuer().map(|issuer| format!("{issuer}{path}"))
    }

    /// The registered client, or `None`. Unknown ids are indistinguishable from
    /// a disabled server.
    pub fn client(&self, client_id: &str) -> Option<&RegisteredOauthClient> {
        self.is_enabled()
            .then(|| {
                self.clients
                    .iter()
                    .find(|client| client.client_id == client_id)
            })
            .flatten()
    }

    /// Construct directly (fixtures and verifiers), bypassing the environment.
    pub fn for_tests(
        issuer: &str,
        consent_url: &str,
        clients: Vec<RegisteredOauthClient>,
    ) -> AgentPortOauthConfig {
        AgentPortOauthConfig {
            enabled: true,
            issuer: Some(issuer.to_string()),
            consent_url: Some(consent_url.to_string()),
            clients,
        }
    }

    fn from_env() -> Result<AgentPortOauthConfig, ConfigError> {
        // Exactly one spelling opens it, the same discipline the hosted
        // delivery gate uses: a capability a typo can enable is a capability
        // nobody decided to enable.
        let enabled =
            env("MOMO_AGENT_PORT_OAUTH_ENABLED").is_some_and(|value| value.trim() == "true");
        if !enabled {
            return Ok(AgentPortOauthConfig::default());
        }
        let issuer = env("MOMO_AGENT_PORT_OAUTH_ISSUER")
            .as_deref()
            .and_then(normalized_origin)
            .filter(|origin| origin.starts_with("https://"))
            .ok_or(ConfigError::InvalidSecurity(
                "MOMO_AGENT_PORT_OAUTH_ISSUER must be one exact https origin",
            ))?;
        let consent_url = env("MOMO_AGENT_PORT_OAUTH_CONSENT_URL")
            .map(|value| value.trim().to_string())
            .filter(|value| value.starts_with("https://") && !value.contains(['#', ' ']))
            .ok_or(ConfigError::InvalidSecurity(
                "MOMO_AGENT_PORT_OAUTH_CONSENT_URL must be one absolute https URL",
            ))?;
        let clients = parse_registered_oauth_clients(
            env("MOMO_AGENT_PORT_OAUTH_CLIENTS")
                .as_deref()
                .unwrap_or(""),
        )
        .ok_or(ConfigError::InvalidSecurity(
            "MOMO_AGENT_PORT_OAUTH_CLIENTS must be id=https://redirect[|https://redirect] entries",
        ))?;
        if clients.is_empty() {
            return Err(ConfigError::InvalidSecurity(
                "MOMO_AGENT_PORT_OAUTH_CLIENTS must register at least one public client",
            ));
        }
        Ok(AgentPortOauthConfig {
            enabled,
            issuer: Some(issuer),
            consent_url: Some(consent_url),
            clients,
        })
    }
}

/// Parse `id=https://a/cb|https://b/cb;other=https://c/cb`.
///
/// Every rejection is total: one malformed entry refuses the whole variable
/// rather than registering the entries that happened to parse, because a client
/// allowlist that silently shrinks is an outage and one that silently keeps a
/// half-parsed redirect is an open redirect.
fn parse_registered_oauth_clients(raw: &str) -> Option<Vec<RegisteredOauthClient>> {
    let mut clients: Vec<RegisteredOauthClient> = Vec::new();
    for entry in raw
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let (client_id, redirects) = entry.split_once('=')?;
        let client_id = client_id.trim();
        if client_id.is_empty()
            || client_id.len() > 200
            || !client_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~:".contains(&byte))
            || clients.iter().any(|client| client.client_id == client_id)
        {
            return None;
        }
        let mut redirect_uris: Vec<String> = Vec::new();
        for redirect in redirects.split('|').map(str::trim) {
            // Loopback http is the one non-https redirect OAuth 2.1 keeps, for
            // native clients that cannot hold a certificate. Everything else
            // must be https, and no redirect may carry a fragment.
            let loopback =
                redirect.starts_with("http://127.0.0.1:") || redirect.starts_with("http://[::1]:");
            if redirect.is_empty()
                || redirect.len() > 2000
                || !(redirect.starts_with("https://") || loopback)
                || redirect.contains('#')
                || redirect.chars().any(char::is_whitespace)
                || redirect_uris.iter().any(|existing| existing == redirect)
            {
                return None;
            }
            redirect_uris.push(redirect.to_string());
        }
        if redirect_uris.is_empty() {
            return None;
        }
        clients.push(RegisteredOauthClient {
            client_id: client_id.to_string(),
            redirect_uris,
        });
    }
    Some(clients)
}

impl Default for AgentPortConfig {
    fn default() -> Self {
        AgentPortConfig {
            external_origin: None,
            window_seconds: 60,
            per_token_limit: 240,
            per_agent_limit: 480,
            per_ip_limit: 1200,
            hosted_delivery_enabled: false,
            oauth: AgentPortOauthConfig::default(),
        }
    }
}

/// Read the hosted-delivery gate. One implementation, every build (HAP-E6).
///
/// Exactly one spelling opens it: the lowercase word `true`, surrounding
/// whitespace trimmed because an env-file line ends in a newline and that is
/// not a typo. `True`, `TRUE`, `1`, `yes`, `on` and an empty value all leave it
/// closed, and so does an unset variable. The asymmetry is deliberate: a
/// delivery path that a misspelling could open is a delivery path nobody
/// decided to open.
fn hosted_delivery_from_env() -> bool {
    hosted_delivery_gate_open(env("MOMO_HOSTED_DELIVERY_ENABLED").as_deref())
}

/// The parse, separated from the environment so the table above is a test
/// rather than a sentence.
fn hosted_delivery_gate_open(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.trim() == "true")
}

/// ADR-0171 D6 — same spelling as the hosted-delivery gate: lowercase `true`
/// only. `True` / `1` / `yes` stay closed.
fn doorbell_gate_open(value: Option<&str>) -> bool {
    hosted_delivery_gate_open(value)
}

impl AgentPortConfig {
    pub fn from_env() -> Result<AgentPortConfig, ConfigError> {
        let defaults = AgentPortConfig::default();
        let external_origin = match env("MOMO_AGENT_PORT_EXTERNAL_ORIGIN") {
            Some(value) => {
                let origin =
                    normalized_origin(&value).filter(|origin| origin.starts_with("https://"));
                Some(origin.ok_or(ConfigError::InvalidSecurity(
                    "MOMO_AGENT_PORT_EXTERNAL_ORIGIN must be one exact https origin",
                ))?)
            }
            None => None,
        };
        Ok(AgentPortConfig {
            external_origin,
            window_seconds: env_number(
                "MOMO_AGENT_PORT_RATE_LIMIT_WINDOW_SECONDS",
                defaults.window_seconds,
            )?
            .max(1),
            per_token_limit: env_number(
                "MOMO_AGENT_PORT_RATE_LIMIT_PER_TOKEN",
                defaults.per_token_limit,
            )?,
            per_agent_limit: env_number(
                "MOMO_AGENT_PORT_RATE_LIMIT_PER_AGENT",
                defaults.per_agent_limit,
            )?,
            per_ip_limit: env_number("MOMO_AGENT_PORT_RATE_LIMIT_PER_IP", defaults.per_ip_limit)?,
            hosted_delivery_enabled: hosted_delivery_from_env(),
            oauth: AgentPortOauthConfig::from_env()?,
        })
    }

    /// `Origin` is optional for native/server clients. Once present it must be
    /// the single operator-controlled HTTPS origin; Host and forwarding headers
    /// are intentionally not inputs.
    pub fn origin_is_allowed(&self, presented: Option<&str>) -> bool {
        match presented {
            None => true,
            Some(value) => normalized_origin(value)
                .zip(self.external_origin.as_ref())
                .is_some_and(|(presented, expected)| &presented == expected),
        }
    }
}

/// MOMO-605 / ADR-0133 P2 — browser & webview CORS origin allowlist.
///
/// Rust port of the Swift `CORSConfig` (`server/Sources/MomoServer/Config.swift:304-447`).
/// The Swift server shipped this in #768; the Axum rewrite never carried it over
/// (`infra/rust/README.md` §7 lists `MOMO_CORS_ALLOWED_ORIGINS` as 미소비), which
/// is why the packaged desktop build cannot log in: it issues genuinely
/// cross-origin `/v1/*` calls from `tauri://localhost` and the webview blocks
/// every one of them, preflight included (`OPTIONS` currently 405s).
///
/// Contract (deliberately conservative, identical to the Swift one so one env
/// block configures either implementation):
///   * `MOMO_CORS_ALLOWED_ORIGINS` is a comma-separated **exact-match** allowlist.
///     **Unset or empty is the default and means "no change at all"** — the
///     middleware is not even mounted, so not a single response header, no
///     `Vary`, and no `OPTIONS` short-circuit differ from today's server.
///   * **Wildcards are forbidden.** Any entry containing `*` (a bare `*` or a
///     subdomain pattern like `https://*.example.com`) is rejected at parse
///     time, as is the literal `null` origin (sandboxed iframes / `file://`
///     documents). Rejected entries are dropped and kept so the boot can warn
///     once; a typo can therefore only ever make the surface *narrower*.
///   * Credentials stay off. momo authenticates with a bearer token in the
///     `Authorization` header and issues no cookies (`grep -rn Set-Cookie
///     server-rust/` = 0), so `Access-Control-Allow-Credentials` is never sent.
///     Combined with the exact-match echo, the forbidden `Allow-Origin: *` +
///     `Allow-Credentials: true` pair is unrepresentable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CorsConfig {
    /// Normalized (lowercased, exact) origins allowed to make cross-origin calls.
    pub allowed_origins: Vec<String>,
    /// Entries refused while parsing (wildcard, `null`, or malformed origin).
    /// Kept so the boot can warn once instead of failing silently.
    pub rejected_entries: Vec<String>,
}

impl CorsConfig {
    /// Environment variable that drives the allowlist. Spelled once, here.
    pub const ENV_KEY: &'static str = "MOMO_CORS_ALLOWED_ORIGINS";

    pub fn from_env() -> CorsConfig {
        CorsConfig::parse(env(CorsConfig::ENV_KEY).as_deref())
    }

    /// Mount the middleware only when at least one origin survived parsing.
    pub fn is_enabled(&self) -> bool {
        !self.allowed_origins.is_empty()
    }

    pub fn parse(raw: Option<&str>) -> CorsConfig {
        let Some(raw) = raw else {
            return CorsConfig::default();
        };
        let mut allowed: Vec<String> = Vec::new();
        let mut rejected: Vec<String> = Vec::new();
        for entry in raw.split(',') {
            let trimmed = entry.trim();
            // Blank slots (trailing comma, `MOMO_CORS_ALLOWED_ORIGINS=`) are the
            // documented "off" spelling — not an operator error.
            if trimmed.is_empty() {
                continue;
            }
            match normalized_origin(trimmed) {
                Some(origin) => {
                    if !allowed.contains(&origin) {
                        allowed.push(origin);
                    }
                }
                None => rejected.push(trimmed.to_string()),
            }
        }
        CorsConfig {
            allowed_origins: allowed,
            rejected_entries: rejected,
        }
    }

    /// The single gate decision, split out so it is unit-testable without a live
    /// socket: returns the normalized origin when the request must receive CORS
    /// headers, `None` when the middleware has to be a no-op. `None` covers "no
    /// `Origin` header" (every native momo client, curl, the work host daemon and
    /// the Centrifugo subscribe proxy) and "origin not on the allowlist" alike.
    pub fn matched_origin(&self, origin_header: Option<&str>) -> Option<String> {
        if self.allowed_origins.is_empty() {
            return None;
        }
        let origin = normalized_origin(origin_header?)?;
        self.allowed_origins.contains(&origin).then_some(origin)
    }
}

/// Canonicalize one allowlist entry (or an inbound `Origin` header) to the
/// serialized form RFC 6454 §6.1 defines: `scheme "://" host [ ":" port ]`,
/// ASCII-lowercased, with no path, query, fragment, userinfo, or trailing slash.
/// Returns `None` for anything else — including wildcards and `null`.
pub fn normalized_origin(raw: &str) -> Option<String> {
    let candidate = raw.trim().to_ascii_lowercase();
    if candidate.is_empty() || candidate == "null" {
        return None;
    }
    // Wildcards are banned outright: momo never answers `*`, and a pattern entry
    // must not silently degrade into an exact-match miss either.
    if candidate.contains('*') || candidate.chars().any(char::is_whitespace) {
        return None;
    }

    let separator = candidate.find("://")?;
    let scheme = &candidate[..separator];
    let authority = &candidate[separator + "://".len()..];
    if !is_valid_scheme(scheme) || authority.is_empty() {
        return None;
    }
    // Anything after the authority (path/query/fragment) or userinfo makes this
    // not an origin. A trailing slash is the common operator typo.
    if authority
        .chars()
        .any(|character| "/?#@\\".contains(character))
    {
        return None;
    }

    let (host, port) = if authority.starts_with('[') {
        // IPv6 literal: `[::1]:8080`.
        let close = authority.find(']')?;
        let host = &authority[..=close];
        let rest = &authority[close + 1..];
        let port = if rest.is_empty() {
            None
        } else {
            Some(rest.strip_prefix(':')?)
        };
        if !is_valid_ipv6_literal(host) {
            return None;
        }
        (host, port)
    } else {
        let parts: Vec<&str> = authority.split(':').collect();
        if parts.len() > 2 {
            return None;
        }
        let host = parts[0];
        if !is_valid_host(host) {
            return None;
        }
        (host, parts.get(1).copied())
    };

    match port {
        // ASCII digits only: `"+80"` and non-ASCII digits must not sneak through.
        Some(port) => {
            if port.is_empty() || !port.chars().all(|character| character.is_ascii_digit()) {
                return None;
            }
            let number: u32 = port.parse().ok()?;
            (1..=65535)
                .contains(&number)
                .then(|| format!("{scheme}://{host}:{port}"))
        }
        None => Some(format!("{scheme}://{host}")),
    }
}

/// RFC 3986 scheme: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
/// Custom webview schemes such as `tauri` are first-class here.
fn is_valid_scheme(scheme: &str) -> bool {
    let mut characters = scheme.chars();
    if !characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
    {
        return false;
    }
    scheme
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
}

fn is_valid_host(host: &str) -> bool {
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return false;
    }
    host.chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
}

fn is_valid_ipv6_literal(host: &str) -> bool {
    if !host.starts_with('[') || !host.ends_with(']') || host.len() <= 2 {
        return false;
    }
    host[1..host.len() - 1]
        .chars()
        .all(|character| character.is_ascii_hexdigit() || matches!(character, ':' | '.' | '%'))
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

/// Mention→run routing knobs (B5.2).
///
/// One key today, and it lives here rather than being read from the process
/// environment at request time for the reason every other setting in this file
/// does: a handler that calls `std::env::var` makes its behaviour untestable and
/// its configuration invisible at boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionSettings {
    /// `AGENT_CONTEXT_MAX_MESSAGES` (default 30, clamped 1…200) — the history
    /// window projected into the `agent_job` payload (Swift
    /// `MessageRoutes.agentContextMaxMessages`, :1742-1751).
    pub context_max_messages: i64,
}

impl Default for MentionSettings {
    fn default() -> Self {
        MentionSettings {
            context_max_messages: momo_agent::mention::CONTEXT_WINDOW_DEFAULT,
        }
    }
}

impl MentionSettings {
    pub fn from_env() -> MentionSettings {
        MentionSettings {
            context_max_messages: momo_agent::context_window_size(
                env("AGENT_CONTEXT_MAX_MESSAGES").as_deref(),
            ),
        }
    }
}

/// 휘발 신호 configuration (ADR-0149, goal SRV-T2).
///
/// **This is the struct that turns momo-server into the second Centrifugo
/// writer**, so it is fail-closed twice over: absent `CENT_API_URL`/`CENT_API_KEY`
/// means no publisher is built at all, and no publisher means both 휘발 routes
/// answer 503. `infra/rust/docker-compose.rust.yml` deliberately withheld those
/// two keys from the api service until now ("momo-server has NO HTTP client"),
/// so an un-updated deployment simply keeps the feature off rather than
/// half-opening it.
///
/// The rate limits are ADR-0149 guard 5 — *"클라가 얼마나 자주 보내든 채널당·
/// 사람당 상한을 서버가 건다"* — and they are sized against the client cadence
/// rather than guessed:
///
/// | axis | default | what it allows |
/// |---|---|---|
/// | per member **per channel** | 30 / 60s | a sustained 2s republish, 1.5× the 3s the client actually uses |
/// | per member, all channels | 120 / 60s | four channels typed in at once, at cadence |
/// | grant mints, per member per channel | 10 / 60s | 10× the one-per-60s a client needs, and the only axis that bounds Postgres reads |
///
/// A limit of 0 disables that axis, the same contract [`RateLimitConfig`] has.
#[derive(Clone, PartialEq, Eq)]
pub struct EphemeralSettings {
    /// `CENT_API_URL`, e.g. `http://centrifugo:8000/api`. `None` ⇒ 휘발 신호 off.
    pub cent_api_url: Option<String>,
    /// `CENT_API_KEY`. **Never logged, never echoed** — this is the credential
    /// that can publish anything to any channel, which is precisely why the
    /// publisher wrapping it exposes only `publish(&EphemeralSignal)`.
    pub cent_api_key: Option<String>,
    /// `MOMO_EPHEMERAL_WINDOW_SECONDS` (default 60, floor 1).
    pub window_seconds: u64,
    /// `MOMO_EPHEMERAL_PER_CHANNEL` (default 30). 0 disables.
    pub per_channel_limit: u32,
    /// `MOMO_EPHEMERAL_PER_MEMBER` (default 120). 0 disables.
    pub per_member_limit: u32,
    /// `MOMO_EPHEMERAL_GRANT_LIMIT` (default 10). 0 disables.
    pub grant_limit: u32,
}

impl Default for EphemeralSettings {
    fn default() -> Self {
        EphemeralSettings {
            cent_api_url: None,
            cent_api_key: None,
            window_seconds: 60,
            per_channel_limit: 30,
            per_member_limit: 120,
            grant_limit: 10,
        }
    }
}

impl std::fmt::Debug for EphemeralSettings {
    /// Hand-written for the same reason [`SettingsConfig`]'s is: `cent_api_key`
    /// is the Centrifugo server-API credential, and a `{:?}` in a log line is
    /// how it would reach a log aggregator.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EphemeralSettings")
            .field("cent_api_url", &self.cent_api_url)
            .field("cent_api_key_configured", &self.cent_api_key.is_some())
            .field("per_channel_limit", &self.per_channel_limit)
            .field("per_member_limit", &self.per_member_limit)
            .field("grant_limit", &self.grant_limit)
            .finish_non_exhaustive()
    }
}

impl EphemeralSettings {
    pub fn from_env() -> EphemeralSettings {
        let defaults = EphemeralSettings::default();
        EphemeralSettings {
            cent_api_url: env("CENT_API_URL").map(|value| value.trim().to_string()),
            cent_api_key: env("CENT_API_KEY"),
            window_seconds: env("MOMO_EPHEMERAL_WINDOW_SECONDS")
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(defaults.window_seconds)
                .max(1),
            per_channel_limit: env("MOMO_EPHEMERAL_PER_CHANNEL")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.per_channel_limit),
            per_member_limit: env("MOMO_EPHEMERAL_PER_MEMBER")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.per_member_limit),
            grant_limit: env("MOMO_EPHEMERAL_GRANT_LIMIT")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.grant_limit),
        }
    }

    /// The publish credential, present only when BOTH halves are configured. A
    /// URL without a key would post unauthenticated requests at Centrifugo
    /// forever; a key without a URL has nowhere to go.
    pub fn transport(&self) -> Option<(&str, &str)> {
        let url = self.cent_api_url.as_deref()?;
        let key = self.cent_api_key.as_deref()?;
        if url.is_empty() || key.is_empty() {
            return None;
        }
        Some((url, key))
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
    /// "oort Cloud(T3)는 기본 비활성입니다" (`CloudProvisionerRoutes.disabledError`).
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

/// The two webhook families' knobs (#1222).
///
/// ## Why there are two master keys and not one
///
/// The **inbound** native ingress secret is derived from `JWT_HMAC`
/// (Swift `App.swift:265` hands `WebhookRoutes` `config.jwtHMAC`), while the
/// **outbound** event-subscription secret is derived from
/// `OUTBOUND_WEBHOOK_MASTER_KEY` (`App.swift:207`). This struct carries only the
/// second, because the first is already on [`crate::AppState::jwt_secret`] and a
/// duplicate would be a second value that could drift from it.
///
/// `outbound_master_key` is `None` when the operator set nothing, and the
/// resolver ([`WebhookSettings::outbound_master_key_or`]) then falls back to the
/// JWT secret — byte-for-byte Swift's `env("OUTBOUND_WEBHOOK_MASTER_KEY", jwtHMAC)`.
/// That fallback is what lets an un-updated deployment keep verifying the
/// credentials it has already issued: a subscription's secret is *derived*, so
/// changing the key silently invalidates every live subscriber. Swift's strict
/// environments still refuse to boot when the two are equal, and that check is
/// unchanged — it lives in `SettingsConfig::boot_error`'s family, not here.
#[derive(Clone, PartialEq, Eq)]
pub struct WebhookSettings {
    /// `OUTBOUND_WEBHOOK_MASTER_KEY`. Held in memory only; never logged, never
    /// echoed, used for nothing but HMAC derivation.
    pub outbound_master_key: Option<String>,
    /// `MOMO_ENV=local` **and** `MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP=1`.
    ///
    /// Both halves are required, which is the same pair the Swift relay reads
    /// (`relay/OutboxRelay/.../Config.swift:66-68`). A single flag would be one
    /// typo away from letting a staging instance ship message bodies over plain
    /// HTTP; requiring the environment label too means the flag cannot be
    /// effective anywhere it should not be.
    pub allow_development_http: bool,
    /// ADR-0171 D6. Exactly the lowercase word `true` opens the doorbell
    /// register/unregister routes and the sender drain. Default off.
    pub doorbell_enabled: bool,
}

impl Default for WebhookSettings {
    /// Fail-closed: no dedicated key (fall back to the JWT secret, as Swift
    /// does) and HTTPS required.
    fn default() -> Self {
        WebhookSettings {
            outbound_master_key: None,
            allow_development_http: false,
            doorbell_enabled: false,
        }
    }
}

impl std::fmt::Debug for WebhookSettings {
    /// Hand-written for the same reason [`SettingsConfig`]'s is: the field is a
    /// master key, and a `{:?}` in a log line is how one reaches an aggregator.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebhookSettings")
            .field(
                "outbound_master_key_configured",
                &self.outbound_master_key.is_some(),
            )
            .field("allow_development_http", &self.allow_development_http)
            .field("doorbell_enabled", &self.doorbell_enabled)
            .finish_non_exhaustive()
    }
}

impl WebhookSettings {
    pub fn from_env() -> WebhookSettings {
        WebhookSettings {
            outbound_master_key: env("OUTBOUND_WEBHOOK_MASTER_KEY"),
            allow_development_http: env_or("MOMO_ENV", "local")
                .trim()
                .eq_ignore_ascii_case("local")
                && env_or("MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP", "0").trim() == "1",
            doorbell_enabled: doorbell_gate_open(env("MOMO_DOORBELL_ENABLED").as_deref()),
        }
    }

    /// The key outbound secrets are derived from, falling back to the app JWT
    /// secret exactly as Swift does.
    pub fn outbound_master_key_or<'a>(&'a self, jwt_secret: &'a str) -> &'a str {
        self.outbound_master_key.as_deref().unwrap_or(jwt_secret)
    }
}

/// The oort TURN relay's ephemeral-credential policy, or `None` when this
/// instance was not given one (LIVE-5a).
///
/// Three names, and all three must be present for anything to be minted:
///
/// | env | meaning |
/// |---|---|
/// | `MOMO_TURN_URLS` | comma-separated `turn:` URLs — the same relay over udp and tcp |
/// | `MOMO_TURN_STATIC_AUTH_SECRET` | coturn's `static-auth-secret`. Never logged, never echoed |
/// | `MOMO_TURN_CREDENTIAL_TTL_SECONDS` | optional, default [`momo_t3::DEFAULT_TURN_CREDENTIAL_TTL_SECONDS`] |
///
/// Half a configuration mints nothing, which is [`momo_t3::TurnCredentialPolicy::new`]'s
/// rule and not this function's — stated there so a second caller cannot get a
/// different answer.
///
/// **`MOMO_TURN_URLS` is not validated against a host allow-list here**, and
/// that absence is deliberate rather than forgotten: ADR-0165 D3 says the relay
/// is oort's own, and the thing that enforces it is the operator's environment
/// plus `scripts/verify_display_attach.sh`'s conformance read — not a hostname
/// this process would have to be taught and re-taught.
///
/// Returns the policy plus **the TTL the operator asked for when it exceeded the
/// ceiling**, so `main` can say so in the boot log. The clamp itself is
/// [`momo_t3::TurnCredentialPolicy::new`]'s, not this function's: putting it in
/// the constructor is what stops a second caller from reaching a different
/// ceiling, and this function only re-derives whether it fired.
fn turn_policy_from_env() -> (Option<momo_t3::TurnCredentialPolicy>, Option<i64>) {
    let Some(raw_urls) = env("MOMO_TURN_URLS") else {
        return (None, None);
    };
    let urls: Vec<String> = raw_urls
        .split(',')
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .collect();
    let Some(secret) = env("MOMO_TURN_STATIC_AUTH_SECRET") else {
        return (None, None);
    };
    // A value this cannot parse falls back to the default rather than to zero:
    // zero is refused by the constructor, which would close the relay surface
    // over a typo in a knob that has a perfectly good default.
    let requested = env("MOMO_TURN_CREDENTIAL_TTL_SECONDS")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(momo_t3::DEFAULT_TURN_CREDENTIAL_TTL_SECONDS);
    let clamped_from = (requested > momo_t3::MAX_TURN_CREDENTIAL_TTL_SECONDS).then_some(requested);
    (
        momo_t3::TurnCredentialPolicy::new(urls, secret, requested),
        clamped_from,
    )
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

        // ADR-0151: the one Drive misconfiguration that is fatal — see
        // [`DriveSettings::boot_error`] for why a *missing* archive is not.
        let drive = DriveSettings::from_env();
        if let Some(message) = drive.boot_error(&environment) {
            return Err(ConfigError::InvalidSecurity(message));
        }

        let (turn, turn_ttl_clamped_from) = turn_policy_from_env();

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
            rate_limit: RateLimitConfig::from_env(),
            agent_port: AgentPortConfig::from_env()?,
            mentions: MentionSettings::from_env(),
            // ADR-0149: never fatal. An instance that was not given the
            // Centrifugo publish credential keeps 휘발 신호 off and answers 503
            // on the two routes — the same posture as every other subsystem
            // here, and byte-for-byte today's behaviour for a deployment that
            // does not update its env block.
            ephemeral: EphemeralSettings::from_env(),
            // #1222: never fatal. `OUTBOUND_WEBHOOK_MASTER_KEY` is optional
            // precisely because it has a defined fallback — changing the key an
            // outbound secret is derived from invalidates every already-issued
            // subscriber credential, so a missing value must mean "keep the one
            // in use", not "pick a new one".
            webhook: WebhookSettings::from_env(),
            // MOMO-605: never fatal. A malformed entry narrows the allowlist and
            // the boot warns; refusing to start over a browser knob would take
            // the whole instance down for a desktop-only concern.
            cors: CorsConfig::from_env(),
            drive,
            // ADR-0122: optional as a complete unit. Partial or invalid input
            // closes only the huddle surface; the rest of the server boots.
            livekit: LiveKitConfig::from_env(),
            // LIVE-5a: never fatal, and never closing. An instance that names no
            // relay hands back an empty `ice_servers`, and the producer keeps
            // the static credential the template already carries — which is the
            // retirement order the install runbook demands (prove the new path,
            // then remove the old one), expressed as a default.
            turn,
            turn_ttl_clamped_from,
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

/// Port of Swift `Config.realtimeWebSocketURL(environment:)` plus ADR-0167:
/// `MOMO_CENTRIFUGO_WS_URL=same-origin` is a sentinel (trim + lowercase);
/// an explicit ws/wss URL with a host is still Fixed verbatim; otherwise the
/// loopback default on `CENT_PORT`.
pub fn realtime_ws_url_from_env() -> Result<crate::realtime_advert::RealtimeAdvert, ConfigError> {
    let port: u16 = env_number("CENT_PORT", 8000u16)?;
    Ok(crate::realtime_advert::RealtimeAdvert::from_env_value(
        env("MOMO_CENTRIFUGO_WS_URL").as_deref(),
        port,
    ))
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
    fn agent_port_origin_is_optional_but_present_values_are_exact_https() {
        let unset = AgentPortConfig::default();
        assert!(unset.origin_is_allowed(None));
        assert!(!unset.origin_is_allowed(Some("https://app.oor7.com")));

        let configured = AgentPortConfig {
            external_origin: Some("https://app.oor7.com".to_string()),
            ..AgentPortConfig::default()
        };
        assert!(configured.origin_is_allowed(None));
        assert!(configured.origin_is_allowed(Some("HTTPS://APP.OOR7.COM")));
        for value in [
            "http://app.oor7.com",
            "https://app.oor7.com.evil.example",
            "https://app.oor7.com/",
            "null",
        ] {
            assert!(!configured.origin_is_allowed(Some(value)), "{value}");
        }
    }

    #[test]
    fn doorbell_is_closed_by_default_and_opens_only_on_an_exact_true() {
        assert!(
            !WebhookSettings::default().doorbell_enabled,
            "ADR-0171 D6: shipped default is closed"
        );
        assert!(doorbell_gate_open(Some("true")));
        assert!(doorbell_gate_open(Some(" true\n")));
        for closed in [
            None,
            Some(""),
            Some("True"),
            Some("TRUE"),
            Some("1"),
            Some("yes"),
            Some("on"),
            Some("false"),
        ] {
            assert!(!doorbell_gate_open(closed), "{closed:?}");
        }
    }

    /// HAP-E6 opened this gate to release builds. The default and the parse are
    /// the two things that must not have moved with it.
    #[test]
    fn hosted_delivery_is_closed_by_default_and_opens_only_on_an_exact_true() {
        assert!(
            !AgentPortConfig::default().hosted_delivery_enabled,
            "the shipped default is closed in every build"
        );
        assert!(hosted_delivery_gate_open(Some("true")));
        assert!(
            hosted_delivery_gate_open(Some(" true\n")),
            "an env-file line ends in a newline; that is not a typo"
        );
        for closed in [
            None,
            Some(""),
            Some("   "),
            Some("True"),
            Some("TRUE"),
            Some("tru e"),
            Some("1"),
            Some("yes"),
            Some("on"),
            Some("false"),
            Some("truex"),
        ] {
            assert!(!hosted_delivery_gate_open(closed), "{closed:?}");
        }
    }

    /// Direct construction still wins over the environment — the override every
    /// fixture and verifier uses to open the selector without touching a
    /// machine-wide variable.
    #[test]
    fn a_directly_constructed_config_still_overrides_the_environment() {
        let opened = AgentPortConfig {
            hosted_delivery_enabled: true,
            ..AgentPortConfig::default()
        };
        assert!(opened.hosted_delivery_enabled);
        assert!(!AgentPortConfig::default().hosted_delivery_enabled);
    }

    #[test]
    fn log_filter_prefers_rust_log_then_the_compose_log_level() {
        assert_eq!(choose_log_filter(None, None), "info");
        assert_eq!(choose_log_filter(None, Some("debug")), "debug");
        assert_eq!(choose_log_filter(Some("warn"), Some("debug")), "warn");
        assert_eq!(choose_log_filter(None, Some(" info ")), "info");
    }

    // -- MOMO-605 CORS allowlist -------------------------------------------
    //
    // Parity with the Swift `CORSAllowlistTests`: same env key, same wildcard
    // ban, same normalization. These are the cheap half of the red test; the
    // over-the-wire half is `tests/cors_allowlist.rs`.

    /// The shipped default. Unset and empty must both mean "mount nothing" —
    /// the acceptance criterion that protects every existing deployment.
    #[test]
    fn the_cors_allowlist_is_empty_unless_the_operator_names_an_origin() {
        assert!(!CorsConfig::default().is_enabled());
        assert!(!CorsConfig::parse(None).is_enabled());
        assert!(!CorsConfig::parse(Some("")).is_enabled());
        assert!(!CorsConfig::parse(Some("   ")).is_enabled());
        assert!(!CorsConfig::parse(Some(",,")).is_enabled());
        // A blank slot is the documented "off" spelling, not an operator error,
        // so it must not be reported as a rejected entry.
        assert!(CorsConfig::parse(Some(",,")).rejected_entries.is_empty());
        assert_eq!(CorsConfig::ENV_KEY, "MOMO_CORS_ALLOWED_ORIGINS");
    }

    #[test]
    fn the_desktop_origins_parse_and_match_exactly() {
        let config = CorsConfig::parse(Some(" tauri://localhost , http://tauri.localhost "));
        assert_eq!(
            config.allowed_origins,
            vec!["tauri://localhost", "http://tauri.localhost"]
        );
        assert!(config.is_enabled());
        assert!(config.rejected_entries.is_empty());
        // Case-insensitive on the wire (RFC 6454 serialization is lowercased),
        // exact everywhere else.
        assert_eq!(
            config.matched_origin(Some("TAURI://LOCALHOST")).as_deref(),
            Some("tauri://localhost")
        );
        assert_eq!(config.matched_origin(None), None);
        assert_eq!(config.matched_origin(Some("https://evil.example")), None);
        // Suffix/prefix attacks on the allowlisted host.
        assert_eq!(
            config.matched_origin(Some("tauri://localhost.evil.example")),
            None
        );
        assert_eq!(config.matched_origin(Some("tauri://evil-localhost")), None);
        // A port the operator never named is a different origin.
        assert_eq!(config.matched_origin(Some("tauri://localhost:8080")), None);
    }

    /// A wildcard must be refused at PARSE time, so `Allow-Origin: *` is not
    /// merely unused but unrepresentable.
    #[test]
    fn wildcards_and_null_are_refused_and_never_widen_the_surface() {
        for value in [
            "*",
            "https://*.oor7.com",
            "null",
            "NULL",
            "https://app.oor7.com/", // trailing slash
            "https://app.oor7.com/path",
            "https://user:pw@app.oor7.com", // userinfo
            "app.oor7.com",                 // no scheme
            "https://",                     // no authority
            "https://app.oor7.com:0",       // port out of range
            "https://app.oor7.com:99999",
            "https://app.oor7.com:+80",
            "https://app.oor7.com:http",
            "https://app oor7.com", // whitespace
            "https://.oor7.com",    // leading dot
            "https://oor7..com",
            "1https://app.oor7.com", // scheme must start with a letter
        ] {
            let config = CorsConfig::parse(Some(value));
            assert!(
                !config.is_enabled(),
                "{value} must not produce an allowed origin"
            );
            assert_eq!(
                config.rejected_entries,
                vec![value.trim().to_string()],
                "{value} must be reported so the boot can warn"
            );
            assert_eq!(normalized_origin(value), None, "{value}");
        }
    }

    /// A typo beside a good entry narrows the allowlist; it must not disable the
    /// good entry, and it must not be promoted to a match.
    #[test]
    fn a_rejected_entry_does_not_take_the_valid_ones_down_with_it() {
        let config = CorsConfig::parse(Some("https://*.evil.example,tauri://localhost"));
        assert_eq!(config.allowed_origins, vec!["tauri://localhost"]);
        assert_eq!(config.rejected_entries, vec!["https://*.evil.example"]);
        assert!(config.is_enabled());
        assert_eq!(config.matched_origin(Some("https://a.evil.example")), None);
    }

    #[test]
    fn origins_normalize_the_way_rfc_6454_serializes_them() {
        assert_eq!(
            normalized_origin("HTTPS://App.Oor7.Com").as_deref(),
            Some("https://app.oor7.com")
        );
        assert_eq!(
            normalized_origin("http://localhost:5173").as_deref(),
            Some("http://localhost:5173")
        );
        assert_eq!(
            normalized_origin("http://[::1]:8080").as_deref(),
            Some("http://[::1]:8080")
        );
        assert_eq!(
            normalized_origin("tauri://localhost").as_deref(),
            Some("tauri://localhost")
        );
        // Duplicates collapse rather than doubling the list.
        assert_eq!(
            CorsConfig::parse(Some("tauri://localhost,TAURI://localhost")).allowed_origins,
            vec!["tauri://localhost"]
        );
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

    // -- B4.3 rate limit ---------------------------------------------------

    /// The defaults are Swift's, and the axis is ON by default: the route it
    /// guards takes an unauthenticated bearer string.
    #[test]
    fn the_rate_limit_defaults_match_swift_and_are_not_off() {
        let defaults = RateLimitConfig::default();
        assert_eq!(defaults.window_seconds, 60);
        assert_eq!(defaults.per_ip_limit, 1200);
        assert_eq!(defaults.claim_per_ip_limit, 30);
        assert!(
            defaults.per_ip_limit > 0,
            "a default of 0 would ship the public join route unguarded"
        );
        assert!(
            defaults.claim_per_ip_limit > 0,
            "a default of 0 would ship the public claim route unguarded"
        );
    }

    // -- ADR-0149 휘발 신호 --------------------------------------------------

    /// The default must be OFF, and off for the right reason: no publish
    /// credential means no publisher, which means both routes 503. A deployment
    /// that does not update its env block therefore behaves exactly as it does
    /// today.
    #[test]
    fn ephemeral_signals_are_off_until_the_operator_hands_over_the_publish_credential() {
        let defaults = EphemeralSettings::default();
        assert_eq!(defaults.transport(), None);
        assert_eq!(
            EphemeralSettings {
                cent_api_url: Some("http://centrifugo:8000/api".into()),
                ..EphemeralSettings::default()
            }
            .transport(),
            None,
            "a URL with no key would post unauthenticated requests forever"
        );
        assert_eq!(
            EphemeralSettings {
                cent_api_key: Some("k".into()),
                ..EphemeralSettings::default()
            }
            .transport(),
            None,
            "a key with no URL has nowhere to go"
        );
        assert_eq!(
            EphemeralSettings {
                cent_api_url: Some("http://centrifugo:8000/api".into()),
                cent_api_key: Some("k".into()),
                ..EphemeralSettings::default()
            }
            .transport(),
            Some(("http://centrifugo:8000/api", "k"))
        );
    }

    /// Guard 5's numbers are a pair with the client cadence, not free
    /// parameters: the per-channel budget has to admit a 3s republish with
    /// headroom, and the per-member budget has to admit several channels at
    /// once — otherwise the limiter fires on ordinary use and the feature looks
    /// broken instead of protected.
    #[test]
    fn the_ephemeral_rate_limits_admit_the_shipped_cadence_with_headroom() {
        let defaults = EphemeralSettings::default();
        let window = defaults.window_seconds as i64;
        let publishes_at_cadence = window * 1000 / momo_ephemeral::TYPING_REPUBLISH_INTERVAL_MS;
        assert!(
            defaults.per_channel_limit as i64 > publishes_at_cadence,
            "{} must exceed the {publishes_at_cadence} publishes a 3s cadence makes per window",
            defaults.per_channel_limit
        );
        assert!(
            defaults.per_member_limit >= defaults.per_channel_limit * 4,
            "a person typing in four channels at once must not be throttled"
        );
        assert!(
            defaults.grant_limit > 0,
            "the grant axis is the only thing bounding Postgres reads on this surface"
        );
    }

    /// The api key must never be printable, however the struct is logged.
    #[test]
    fn the_ephemeral_debug_never_prints_the_publish_credential() {
        let rendered = format!(
            "{:?}",
            EphemeralSettings {
                cent_api_url: Some("http://centrifugo:8000/api".into()),
                cent_api_key: Some("super-secret-api-key".into()),
                ..EphemeralSettings::default()
            }
        );
        assert!(!rendered.contains("super-secret-api-key"), "{rendered}");
        assert!(
            rendered.contains("cent_api_key_configured: true"),
            "{rendered}"
        );
    }

    #[test]
    fn livekit_is_configured_only_as_a_complete_valid_unit() {
        assert!(LiveKitConfig::parse(None, None, None).is_none());
        assert!(LiveKitConfig::parse(Some("key"), Some("secret"), None).is_none());
        assert!(
            LiveKitConfig::parse(Some("key"), Some("secret"), Some("localhost:7880")).is_none()
        );
        assert!(
            LiveKitConfig::parse(Some("key"), Some("secret"), Some("ftp://livekit:7880")).is_none()
        );
        let config = LiveKitConfig::parse(
            Some(" key "),
            Some(" secret "),
            Some("ws://livekit.example:7880"),
        )
        .expect("complete LiveKit config");
        assert_eq!(config.api_key(), "key");
        assert_eq!(config.api_secret(), "secret");
        assert_eq!(config.url, "ws://livekit.example:7880");
        assert!(
            LiveKitConfig::parse(Some("key"), Some("secret"), Some("WSS://livekit.example"))
                .is_some()
        );
    }

    #[test]
    fn livekit_debug_never_prints_credentials() {
        let config = LiveKitConfig::parse(
            Some("public-but-redacted-key"),
            Some("super-secret-livekit-value"),
            Some("wss://livekit.example"),
        )
        .unwrap();
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("public-but-redacted-key"), "{rendered}");
        assert!(
            !rendered.contains("super-secret-livekit-value"),
            "{rendered}"
        );
        assert!(rendered.contains("api_key_configured: true"), "{rendered}");
    }

    #[test]
    fn strict_environments_are_the_deployed_ones() {
        assert!(requires_strict_secrets("prod"));
        assert!(requires_strict_secrets(" Staging "));
        assert!(requires_strict_secrets("internal-host"));
        assert!(!requires_strict_secrets("local"));
        assert!(!requires_strict_secrets("test"));
    }

    #[test]
    fn a_stub_archive_is_a_boot_error_only_in_deployed_environments() {
        let stub = DriveSettings {
            backend: momo_drive::STUB_BACKEND.into(),
            ..DriveSettings::default()
        };
        assert!(stub.boot_error("staging").is_some());
        assert!(stub.boot_error("prod").is_some());
        assert!(stub.boot_error("local").is_none());
    }

    #[test]
    fn a_local_archive_is_allowed_in_a_deployed_environment_when_the_dir_is_writable() {
        let dir = std::env::temp_dir().join(format!(
            "oort-drive-boot-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let local = DriveSettings {
            backend: momo_drive::LOCAL_BACKEND.into(),
            local_dir: Some(dir.to_string_lossy().into_owned()),
            ..DriveSettings::default()
        };
        assert!(local.boot_error("staging").is_none());
        assert!(dir.join("objects").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_local_archive_without_a_directory_is_a_boot_error() {
        let local = DriveSettings {
            backend: momo_drive::LOCAL_BACKEND.into(),
            local_dir: None,
            ..DriveSettings::default()
        };
        assert_eq!(
            local.boot_error("staging"),
            Some("MOMO_DRIVE_LOCAL_DIR is required when MOMO_DRIVE_ARCHIVE_BACKEND=local")
        );
        assert_eq!(
            local.boot_error("local"),
            Some("MOMO_DRIVE_LOCAL_DIR is required when MOMO_DRIVE_ARCHIVE_BACKEND=local")
        );
    }

    #[test]
    fn a_local_archive_pointing_at_a_file_is_a_boot_error() {
        let dir = std::env::temp_dir().join(format!(
            "oort-drive-boot-file-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&dir, b"not a directory").expect("file");
        let local = DriveSettings {
            backend: momo_drive::LOCAL_BACKEND.into(),
            local_dir: Some(dir.to_string_lossy().into_owned()),
            ..DriveSettings::default()
        };
        assert_eq!(
            local.boot_error("staging"),
            Some("MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")
        );
        let _ = std::fs::remove_file(&dir);
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
