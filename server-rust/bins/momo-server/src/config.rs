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

use momo_auth::RefreshProofMode;
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
    /// ADR-0004 증보 4 D2(a): the webhook master keys have no fallback any more,
    /// so an absent one is fatal. The sentence carries the **next action**
    /// because fail-closed is only humane when the operator is told how to
    /// close it — the generator's add-only backfill copies the value already in
    /// use, which is why nothing gets invalidated by following it.
    #[error(
        "set {0} — webhook master keys no longer fall back to JWT_HMAC (ADR-0004 증보 4). \
Run `scripts/oort upgrade` (or `scripts/self_host_env.sh --ensure-managed-keys`) to backfill \
the key already in use; it re-issues nothing."
    )]
    MissingWebhookMasterKey(&'static str),
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
    /// ADR-0205 D1 — the GitHub App's dedicated master key (optional: absent closes only the
    /// GitHub surface with a 503).
    pub github: GithubAppSettings,
    /// ADR-0203 — the operator's declaration about a co-hosted agent.
    pub cohosted: CohostedAgentConfig,
    /// #4079: the Hermes login relay (`HERMES_LOGIN_RELAY_URL` + `HERMES_LOGIN_RELAY_KEY`).
    pub login_relay: LoginRelayConfig,
    /// MOMO-300 rate-limit knobs (B4.3) — consumed by the public join and
    /// claim writes. **On by default**, because those routes are unauthenticated
    /// writes on the instance.
    pub rate_limit: RateLimitConfig,
    /// ADR-0162 / HAP-E2 Agent Port transport and its dedicated abuse bounds.
    /// These knobs are separate from the public join limiter so changing one
    /// surface can never silently widen the other.
    pub agent_port: AgentPortConfig,
    /// ADR-0216 D9 (#4660) — the developer-token door's budgets. Never off: 0 and
    /// garbage keep the default.
    pub dev_access: DevAccessConfig,
    /// Mention→run routing knobs (B5.2). Always on; only the history window is
    /// configurable.
    pub mentions: MentionSettings,
    /// ADR-0208 D15 — the scheduled-message tick: on by default, four optional knobs.
    pub scheduler: SchedulerSettings,
    /// #4443 / ADR-0151 증보 2 D4 — the attachment reclaim tick of the api process (the
    /// local-volume half). **Ships off**: it deletes nothing unless `MOMO_ATTACHMENT_RECLAIM` is
    /// exactly `1`. Runs only on the `local` backend (the notifier reclaims a Google Drive).
    pub attachment_reclaim: AttachmentReclaimSettings,
    /// ADR-0146 개정 2026-09-28 (R2) — the server instance id signed statements
    /// echo, and whether a member-scoped host registration must carry its root
    /// key's `host_register` signature. **Off by default** (D-11 / Q11: the R2
    /// switches close until the R1 re-review PASS); turning it on without an
    /// instance id is a boot error.
    pub device_keys: DeviceKeySettings,
    /// ADR-0197 M1 (#3500) — the personal cloud box API switch. **Off unless the
    /// operator sets `MOMO_CLOUD_BOX_ENABLED=true`** (M5's per-workspace consent
    /// is a separate, later gate; this one keeps the whole surface unexposed).
    pub cloud_box: CloudBoxConfig,
    /// 휘발 신호 (ADR-0149, goal SRV-T2) — **off unless the operator hands this
    /// process the Centrifugo publish credential**, which no deployment did
    /// before this batch.
    pub ephemeral: EphemeralSettings,
    /// #1222 웹훅 — the two webhook master keys and the local-only plain-HTTP
    /// escape hatch. **Fatal when either key is absent** (ADR-0004 증보 4 D2(a),
    /// #2066): the Swift-era `env("OUTBOUND_WEBHOOK_MASTER_KEY", jwtHMAC)`
    /// fallback is gone, because a defaulted key is a JWT secret quietly doing
    /// a second job — rotate the JWT and every issued webhook secret dies with
    /// no row recording it. The destination policy stays HTTPS-only.
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
    ///
    /// `local_base_url` is the archive's **boot-time** URL assembly only. When
    /// the operator named `same-origin` the HTTP layer rewrites the capability
    /// URL from the request (ADR-0169 증보 1); the archive still gets a
    /// concrete placeholder so `create_resumable_upload` can mint a path.
    pub fn backend_config(&self, port: u16) -> momo_drive::DriveBackendConfig {
        let stub_base_url = env("MOMO_DRIVE_ARCHIVE_STUB_BASE_URL")
            .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
        let local_base = self.local_base(port, &stub_base_url);
        let local_base_url = match &local_base {
            crate::DriveLocalBase::SameOrigin => stub_base_url.clone(),
            crate::DriveLocalBase::Fixed(url) => url.clone(),
        };
        momo_drive::DriveBackendConfig {
            mode: self.backend.clone(),
            sa_key_path: self.sa_key_path.clone(),
            shared_drive_id: self.shared_drive_id.clone(),
            stub_base_url,
            local_dir: self.local_dir.clone(),
            local_base_url,
        }
    }

    /// How local-archive capability URLs are advertised (ADR-0169 증보 1).
    ///
    /// Only `MOMO_DRIVE_ARCHIVE_BACKEND=local` ever returns [`crate::DriveLocalBase::SameOrigin`].
    /// google / stub / empty stay `Fixed` so their URLs are never rewritten.
    pub fn local_base(&self, port: u16, stub_fallback: &str) -> crate::DriveLocalBase {
        if self.backend != momo_drive::LOCAL_BACKEND {
            return crate::DriveLocalBase::Fixed(String::new());
        }
        let fallback = if stub_fallback.trim().is_empty() {
            format!("http://127.0.0.1:{port}")
        } else {
            stub_fallback.trim_end_matches('/').to_string()
        };
        crate::DriveLocalBase::from_env_value(
            env("MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL").as_deref(),
            &fallback,
        )
    }
}

/// MOMO-300 request rate limiting (Swift `RateLimitConfig`, `Config.swift:283-302`).
///
/// Same environment keys and same defaults as the Swift server, so one env block
/// configures either implementation. A limit of 0 disables the axis.
///
/// The per-IP axis is mounted on the two unauthenticated writes (`/v1/join`
/// and `/v1/claim`). The Swift **global** per-member axis (`RATE_LIMIT_PER_MEMBER`,
/// every authenticated route, default 600) is still not ported and the field is
/// deliberately absent rather than present-and-ignored — a knob that does
/// nothing is worse documentation than no knob. What exists instead is the
/// per-member **write** budget below (ADR-0208 D10 증보, #4234): four knobs for the
/// three write surfaces a member can flood (the send surface has one for people and one
/// for agents), each read by a middleware that is mounted on exactly those routes
/// (`rate_limit::member_write`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitConfig {
    /// `RATE_LIMIT_WINDOW_SECONDS`, floor 1 (default 60).
    pub window_seconds: u64,
    /// `RATE_LIMIT_PER_IP` (default 1200). 0 disables. Join surface.
    pub per_ip_limit: u32,
    /// `RATE_LIMIT_CLAIM_PER_IP` (default 30). 0 disables. Claim surface.
    /// Independent of join so invite traffic cannot starve first-owner setup.
    pub claim_per_ip_limit: u32,
    /// `RATE_LIMIT_PASSWORD_CHANGE_PER_MEMBER` (default 10). 0 disables.
    /// Brute-force of the current-password reconfirm on PATCH …/me/password.
    pub password_change_per_member_limit: u32,
    /// `RATE_LIMIT_PASSWORD_CHANGE_PER_IP` (default 30). 0 disables.
    pub password_change_per_ip_limit: u32,
    /// `RATE_LIMIT_PASSWORD_GUESS_PER_ACCOUNT` (default 5 per window). **No off
    /// switch**: 0 and a value that is not a number both keep the default, because
    /// this is a password-guessing surface (ADR-0215 D6 — a knob on a guessable
    /// surface does not get an "off").
    ///
    /// Guesses at one account's password made through a door that lets a caller who
    /// holds no session name the account — today `POST /v1/join`, which compares a
    /// password only for an address that already has an `active` account. The key is
    /// the account (workspace + stored address), never the invite code or the
    /// caller's address, so another code or another source address does not buy a
    /// fresh budget. Every comparison is counted, a right one included, and the
    /// budget is spent *before* the comparison runs. Login has no limiter yet
    /// (ADR-0215 F9, #4597); when it gets one it should spend this same key.
    ///
    /// The window is `RATE_LIMIT_WINDOW_SECONDS`, which every limiter in this file
    /// shares: this knob is how many guesses fit in it, and only a value of 0 is
    /// refused. An operator who shortens the window to a second turns "5 a minute"
    /// into "5 a second", for this budget and for the rest.
    pub password_guess_per_account_limit: u32,
    /// `RATE_LIMIT_DRIVE_UPLOAD_PER_IP` (default 120). 0 disables. The public
    /// upload PUT (`/__momo_stub/drive/uploads/{token}`, #2628), which answers
    /// anyone who knows the path shape. Its own key, so upload traffic and the
    /// join/claim surfaces cannot starve each other.
    ///
    /// Only **refused** capabilities spend it (#2631 review R12; see
    /// `rate_limit::per_ip_drive_upload`): a live upload is never refused on
    /// this axis. A working client meets a refusal only for a URL that was
    /// spent or expired, and then restarts with a new session, so 120 refusals
    /// a minute is far above what one address's real traffic produces — an
    /// office NAT, or a whole instance whose clients all arrive from the edge's
    /// address. What it adds is 429 + `Retry-After` and one WARN line per burst
    /// on the excess; it does not slow guessing, which the token's 122 random
    /// bits, single use and one-hour lifetime answer.
    pub drive_upload_per_ip_limit: u32,
    /// `RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE` (default 30 per window). 0 disables. The public photo
    /// address `GET /v1/self-media/{ws}/{token}` (#4820 C2a, ADR-0218 G4), which answers anyone who
    /// knows the path shape.
    ///
    /// Its **own** budget, no longer the claim budget it borrowed, and **split by the workspace in
    /// the path**: the key is the caller's address *and* that workspace id. The co-hosted Hermes
    /// reaches the api from one address for every workspace, and its picture tool lets any
    /// well-shaped address through (the guard cannot know whether a token was ever minted), so a
    /// model that invents addresses can only spend the workspace it names — not every workspace's
    /// photos (security review L7). Only the route's one 404 spends it and a served picture spends
    /// nothing. A path whose workspace is not a canonical id has none to charge and shares one
    /// bucket per address (`rate_limit::per_ip_self_media`).
    ///
    /// Because the path names the workspace, a caller can rotate it and never spend the same budget
    /// twice, so the route also has an address-wide ceiling of ten times this number across all
    /// workspaces (`rate_limit::per_ip_self_media_ceiling`; 0 here disables both). It keeps the
    /// unauthenticated transaction rate per address bounded; the cost is that a flood past the
    /// ceiling is turned away for every workspace until the window passes.
    ///
    /// What it does not do: slow guessing (the token's 256 random bits do that) or stop a caller who
    /// names *another* workspace's id in the path from spending that workspace's budget for their
    /// own address — the cost is at most that workspace's photo addresses for one window, and it
    /// takes knowing that workspace's id.
    pub self_media_per_workspace_limit: u32,
    /// `RATE_LIMIT_MESSAGE_SEND_PER_MEMBER` (default 120 per window). 0 disables.
    /// A **human** member's message sends: `POST …/channels/{ch}/messages` (thread
    /// replies included) and `POST …/scheduled-messages/{id}/send-now`, which is the
    /// same canonical send, so the two share one budget and cannot be used to
    /// double it. Two a second sustained is above what anyone types and above Slack's
    /// own ~1 message/second/channel (`chat.postMessage`, special tier, short bursts
    /// allowed), and it still admits a client that flushes ~100 queued messages after
    /// a reconnect. See ADR-0208 D10 증보 for the numbers.
    pub message_send_per_member_limit: u32,
    /// `RATE_LIMIT_MESSAGE_SEND_PER_AGENT` (default 600 per window). 0 disables.
    /// The same send surface for an **agent** (or work-host) credential. Higher
    /// because an adapter posts one `tool_call` and one `tool_result` per tool
    /// execution (the Prime adapter, `adapters/prime/prime_adapter.py`), so a busy
    /// run is bursty by construction. A run's steps are capped by `agent.max_run_steps`
    /// (schema default 50) and an agent's concurrent runs by `agent.max_concurrent_runs`
    /// (default 1), so one run posts at most ~100 of them and four concurrent runs ~400;
    /// 600 is 200 tool executions a minute from one agent identity, above that, and never
    /// stricter than the Agent Port's own per-agent ceiling
    /// (`MOMO_AGENT_PORT_RATE_LIMIT_PER_AGENT`, 480), so a REST-only adapter is not
    /// throttled harder than the MCP path that does the same job. Adapters retry a 429 for
    /// about a second and do not read `Retry-After`, which is why this is the number to
    /// raise, not to tighten, if a real run ever meets it. Streaming slices are
    /// `PATCH …/messages/{id}` and are deliberately **not** on this axis.
    pub message_send_per_agent_limit: u32,
    /// `RATE_LIMIT_SCHEDULED_WRITE_PER_MEMBER` (default 60 per window). 0 disables.
    /// Creating and editing a scheduled message (`POST …/channels/{ch}/scheduled-messages`,
    /// `PATCH …/scheduled-messages/{id}`). Cancelling is **never** counted: it is the
    /// safety action (ADR-0208 D9) and a member who is being throttled must still be
    /// able to stop what is queued. The default is not below the 50-schedule pending
    /// cap, so a bulk fill of the whole cap is not refused by the rate before it meets
    /// the cap. What the rate adds is the part the cap cannot bound: create/cancel
    /// churn and an edit loop, each of which is a transaction that locks the member's
    /// session and schedule rows and writes an outbox event.
    pub scheduled_write_per_member_limit: u32,
    /// `RATE_LIMIT_UPLOAD_START_PER_MEMBER` (default 60 per window). 0 disables.
    /// Starting an attachment upload (`POST …/channels/{ch}/attachments/uploads`),
    /// which makes one Google Drive API call and writes one `pending` row per
    /// request. The gate runs before the Drive call. 60 is three full 20-file
    /// messages' worth of starts in one window.
    pub upload_start_per_member_limit: u32,
    /// `RATE_LIMIT_UNFURL_PROXY_PER_MEMBER` (default 240 per window). 0 disables.
    /// Link-card pictures and icons fetched through the proxy (`GET …/unfurls/{id}/image` and
    /// `…/icon`), counted **only when the request makes this server fetch from the card's remote
    /// site**: a picture already in memory, and an address that failed lately, cost the remote
    /// site nothing and spend nothing. Each one that is spent is up to four GETs from this
    /// server's address to a site a member chose, which is what the budget keeps from becoming a
    /// probe of other people's servers. 240 is above what opening a channel cold needs (twenty
    /// cards on a screen is forty fetches, a picture and an icon each, and every one that
    /// succeeds is then kept) and four a second sustained; it is the figure a developer token
    /// gets per window. A request refused here is retried by the client after `Retry-After` and
    /// shows its fallback meanwhile. See ADR-0170 증보 D13.
    pub unfurl_proxy_per_member_limit: u32,
    /// `RATE_LIMIT_UNFURL_PREVIEW_PER_MEMBER` (default 60 per window). 0 disables.
    /// A link a member typed into the composer, asked about before the message exists
    /// (`POST …/channels/{ch}/unfurl-previews`), counted **only when the request makes this server
    /// fetch the page**: an answer the server already holds for that member and address, a switch
    /// that is off, and a request turned away for want of a place cost the remote site nothing and
    /// spend nothing. This is the one request where the member names the address and the answer
    /// comes straight back, so it is the proxy's other half of the same brake (the proxy's figure
    /// is for pictures a page chose). 60 is a sustained one a second: the composer asks about a
    /// link a moment after typing stops, once per address, and an address typed slowly leaves a
    /// few half-written ones on the way; that fits with room to spare, and anything past it is
    /// retried by the client after `Retry-After`. See ADR-0170 증보 2026-11-01 D20.
    pub unfurl_preview_per_member_limit: u32,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        RateLimitConfig {
            window_seconds: 60,
            per_ip_limit: 1200,
            claim_per_ip_limit: 30,
            password_change_per_member_limit: 10,
            password_change_per_ip_limit: 30,
            password_guess_per_account_limit: 5,
            drive_upload_per_ip_limit: 120,
            self_media_per_workspace_limit: 30,
            message_send_per_member_limit: 120,
            message_send_per_agent_limit: 600,
            scheduled_write_per_member_limit: 60,
            upload_start_per_member_limit: 60,
            unfurl_proxy_per_member_limit: 240,
            unfurl_preview_per_member_limit: 60,
        }
    }
}

impl RateLimitConfig {
    pub fn from_env() -> RateLimitConfig {
        Self::from_lookup(env)
    }

    /// [`from_env`](Self::from_env) over any lookup, so every env name is testable
    /// without touching the process environment (a misspelt name would otherwise fall
    /// back to its default without a word).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> RateLimitConfig {
        let defaults = RateLimitConfig::default();
        RateLimitConfig {
            window_seconds: lookup("RATE_LIMIT_WINDOW_SECONDS")
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(defaults.window_seconds)
                .max(1),
            per_ip_limit: lookup("RATE_LIMIT_PER_IP")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.per_ip_limit),
            claim_per_ip_limit: lookup("RATE_LIMIT_CLAIM_PER_IP")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.claim_per_ip_limit),
            password_change_per_member_limit: lookup("RATE_LIMIT_PASSWORD_CHANGE_PER_MEMBER")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.password_change_per_member_limit),
            password_change_per_ip_limit: lookup("RATE_LIMIT_PASSWORD_CHANGE_PER_IP")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.password_change_per_ip_limit),
            // No off switch (see the field): 0 is filtered out and falls to the default.
            password_guess_per_account_limit: lookup("RATE_LIMIT_PASSWORD_GUESS_PER_ACCOUNT")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .filter(|limit| *limit > 0)
                .unwrap_or(defaults.password_guess_per_account_limit),
            drive_upload_per_ip_limit: lookup("RATE_LIMIT_DRIVE_UPLOAD_PER_IP")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.drive_upload_per_ip_limit),
            self_media_per_workspace_limit: lookup("RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.self_media_per_workspace_limit),
            message_send_per_member_limit: lookup("RATE_LIMIT_MESSAGE_SEND_PER_MEMBER")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.message_send_per_member_limit),
            message_send_per_agent_limit: lookup("RATE_LIMIT_MESSAGE_SEND_PER_AGENT")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.message_send_per_agent_limit),
            scheduled_write_per_member_limit: lookup("RATE_LIMIT_SCHEDULED_WRITE_PER_MEMBER")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.scheduled_write_per_member_limit),
            upload_start_per_member_limit: lookup("RATE_LIMIT_UPLOAD_START_PER_MEMBER")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.upload_start_per_member_limit),
            unfurl_proxy_per_member_limit: lookup("RATE_LIMIT_UNFURL_PROXY_PER_MEMBER")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.unfurl_proxy_per_member_limit),
            unfurl_preview_per_member_limit: lookup("RATE_LIMIT_UNFURL_PREVIEW_PER_MEMBER")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(defaults.unfurl_preview_per_member_limit),
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
    /// ADR-0162 증보 3 부록 (#3530, AT-8) — the lease a **hosted** claim/renew
    /// mints, in seconds. `MOMO_AGENT_PORT_HOSTED_LEASE_MINUTES` (default 30),
    /// clamped to 5..=120 minutes. The managed gateway keeps its 30 seconds.
    pub hosted_lease_seconds: i64,
    /// ADR-0193 D6 (#2815) — **the subscription-agent kill switch: on by
    /// default, off on any value but an exact `true`.**
    ///
    /// `MOMO_SUBSCRIPTION_AGENTS_ENABLED`. Off means: joining through the
    /// subscription path (`invocationScope: owner_only`) is refused, no call —
    /// not even the owner's — is delivered to an existing `owner_only` agent
    /// (mention/DM routing, hosted inbox fan-out, the Agent Port tool view,
    /// the welcome speaker), and the agent answers once with the D6 sentence.
    /// Turning it back on resumes delivery with no announcement.
    ///
    /// It is a server setting rather than a workspace setting on purpose: the
    /// reason to flip it is a change in a provider's consumer terms, which is
    /// an operator's decision for the whole instance. A workspace setting would
    /// let a workspace admin reopen what the operator closed. Clients read the
    /// effective value as `WorkspaceDto.subscriptionAgentsEnabled`.
    ///
    /// The parse leans toward *off* (the reverse of the hosted-delivery gate's
    /// direction, same exact-`true` spelling): unset and `true` keep it on,
    /// every other value — `false`, `0`, `off`, a typo — turns it off, so a
    /// misspelled kill never leaves the path open.
    pub subscription_agents_enabled: bool,
    /// ADR-0193 증보 2026-10-03 (#3397 결재) — **Claude subscription agents:
    /// off by default, on only for an exact `true`.**
    ///
    /// `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`. The owner's decision: driving a
    /// Claude subscription agent on someone's behalf stays 「회색·문의 중」 until
    /// Anthropic replies, so a fresh instance does not register one. Off means:
    /// `POST …/subscription-agents/register` with `harness: claude_code` is
    /// refused with `error.code = claude_subscription_agent_paused` and writes
    /// nothing, and agent rows of that kind report
    /// `brainUnavailableReason = claude_subscription_agent_paused`. Codex is not
    /// affected. An operator turns it on knowingly, per instance.
    ///
    /// This flag governs the **registration path and the status field only**.
    /// Blocking and announcing runtime delivery to Claude `owner_only` agents
    /// that already exist is #3397's job, not this switch's.
    ///
    /// The parse leans toward *off*: unset, blank, `True`, `1`, a typo — all off.
    pub claude_subscription_agents_enabled: bool,
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
    /// ADR-0216 D6 (나) / #4700 — the **human-subject arm** (`oort login`).
    ///
    /// Independent of the hosted arm above: an operator may open either, both or
    /// neither, and the hosted accessors ([`Self::is_enabled`], [`Self::issuer`],
    /// [`Self::consent_url`], [`Self::resource`], [`Self::client`]) mean exactly what
    /// they meant before this arm existed — they never answer for it, so turning
    /// this arm on cannot advertise the hosted resource or accept a hosted client.
    /// The two arms share one issuer (`MOMO_AGENT_PORT_OAUTH_ISSUER`): a server has
    /// one authorization-server identity.
    dev_login_enabled: bool,
    /// Absolute https URL of the developer-login consent screen (`/oauth/cli`).
    dev_login_consent_url: Option<String>,
}

/// The canonical resource of the human-subject arm, derived from the issuer so the
/// two can never disagree. It is the human MCP endpoint's path (ADR-0216 D5).
pub const DEV_LOGIN_RESOURCE_PATH: &str = "/v1/mcp/me";

impl AgentPortOauthConfig {
    /// The one predicate every **hosted** OAuth surface asks. False means 404, not
    /// 503: a disabled authorization server does not exist, it is not merely busy.
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

    /// The human-subject arm's predicate. False means the built-in `oort-cli`
    /// client does not exist: a request naming it is answered exactly like one
    /// naming an unknown client.
    pub fn dev_login_enabled(&self) -> bool {
        self.dev_login_enabled && self.issuer.is_some() && self.dev_login_consent_url.is_some()
    }

    pub fn dev_login_issuer(&self) -> Option<&str> {
        self.dev_login_enabled()
            .then_some(self.issuer.as_deref())
            .flatten()
    }

    pub fn dev_login_consent_url(&self) -> Option<&str> {
        self.dev_login_enabled()
            .then_some(self.dev_login_consent_url.as_deref())
            .flatten()
    }

    /// The human-subject arm's canonical resource (issuer + `/v1/mcp/me`). Not the
    /// hosted [`Self::resource`]: the two audiences are different credentials.
    pub fn dev_login_resource(&self) -> Option<String> {
        self.dev_login_issuer()
            .map(|issuer| format!("{issuer}{DEV_LOGIN_RESOURCE_PATH}"))
    }

    pub fn dev_login_endpoint(&self, path: &str) -> Option<String> {
        self.dev_login_issuer()
            .map(|issuer| format!("{issuer}{path}"))
    }

    /// The issuer an authorization-server **metadata** document may name: either
    /// arm being open is enough, and a document never advertises an arm that is
    /// closed. `None` when both are closed (the well-known is then 404).
    pub fn server_issuer(&self) -> Option<&str> {
        self.issuer().or_else(|| self.dev_login_issuer())
    }

    /// Construct directly (fixtures and verifiers), bypassing the environment.
    /// Opens the hosted arm only.
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
            dev_login_enabled: false,
            dev_login_consent_url: None,
        }
    }

    /// Fixtures: the human-subject arm alone (the hosted arm stays closed).
    pub fn for_tests_dev_login(issuer: &str, consent_url: &str) -> AgentPortOauthConfig {
        AgentPortOauthConfig {
            issuer: Some(issuer.to_string()),
            dev_login_enabled: true,
            dev_login_consent_url: Some(consent_url.to_string()),
            ..AgentPortOauthConfig::default()
        }
    }

    /// Fixtures: this config with the human-subject arm opened as well. The two
    /// arms share the issuer already in `self`.
    pub fn with_dev_login_for_tests(mut self, consent_url: &str) -> AgentPortOauthConfig {
        self.dev_login_enabled = true;
        self.dev_login_consent_url = Some(consent_url.to_string());
        self
    }

    fn from_env() -> Result<AgentPortOauthConfig, ConfigError> {
        Self::from_lookup(env)
    }

    /// The environment grammar, over an injectable lookup so it is testable
    /// without touching the process environment.
    pub fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<AgentPortOauthConfig, ConfigError> {
        let value = |name: &str| lookup(name).filter(|raw| !raw.trim().is_empty());
        // Exactly one spelling opens an arm, the same discipline the hosted
        // delivery gate uses: a capability a typo can enable is a capability
        // nobody decided to enable.
        let opted_in = |name: &str| value(name).is_some_and(|raw| raw.trim() == "true");
        let enabled = opted_in("MOMO_AGENT_PORT_OAUTH_ENABLED");
        let dev_login_enabled = opted_in("MOMO_DEV_LOGIN_OAUTH_ENABLED");
        if !enabled && !dev_login_enabled {
            return Ok(AgentPortOauthConfig::default());
        }
        let https_url = |raw: String| {
            let trimmed = raw.trim().to_string();
            (trimmed.starts_with("https://") && !trimmed.contains(['#', ' '])).then_some(trimmed)
        };
        // One server, one authorization-server identity: both arms need it.
        let issuer = value("MOMO_AGENT_PORT_OAUTH_ISSUER")
            .as_deref()
            .and_then(normalized_origin)
            .filter(|origin| origin.starts_with("https://"))
            .ok_or(ConfigError::InvalidSecurity(
                "MOMO_AGENT_PORT_OAUTH_ISSUER must be one exact https origin",
            ))?;
        let (consent_url, clients) = if enabled {
            let consent_url = value("MOMO_AGENT_PORT_OAUTH_CONSENT_URL")
                .and_then(https_url)
                .ok_or(ConfigError::InvalidSecurity(
                    "MOMO_AGENT_PORT_OAUTH_CONSENT_URL must be one absolute https URL",
                ))?;
            let clients = parse_registered_oauth_clients(
                value("MOMO_AGENT_PORT_OAUTH_CLIENTS")
                    .as_deref()
                    .unwrap_or(""),
            )
            .ok_or(ConfigError::InvalidSecurity(
                "MOMO_AGENT_PORT_OAUTH_CLIENTS must be id=https://redirect[|https://redirect] entries (the id oort-cli is built in and cannot be registered)",
            ))?;
            if clients.is_empty() {
                return Err(ConfigError::InvalidSecurity(
                    "MOMO_AGENT_PORT_OAUTH_CLIENTS must register at least one public client",
                ));
            }
            (Some(consent_url), clients)
        } else {
            (None, Vec::new())
        };
        let dev_login_consent_url = if dev_login_enabled {
            Some(
                value("MOMO_DEV_LOGIN_OAUTH_CONSENT_URL")
                    .and_then(https_url)
                    .ok_or(ConfigError::InvalidSecurity(
                        "MOMO_DEV_LOGIN_OAUTH_CONSENT_URL must be one absolute https URL",
                    ))?,
            )
        } else {
            None
        };
        Ok(AgentPortOauthConfig {
            enabled,
            issuer: Some(issuer),
            consent_url,
            clients,
            dev_login_enabled,
            dev_login_consent_url,
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
        // `oort-cli` is the built-in human-subject client (ADR-0216 D6): its
        // redirects are the sealed loopback list, never an operator's string.
        if client_id.is_empty()
            || client_id == momo_mcp::oauth::OORT_CLI_CLIENT_ID
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
            hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
            subscription_agents_enabled: true,
            claude_subscription_agents_enabled: false,
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

/// ADR-0193 D6 (#2815) — read the subscription-agent kill switch.
fn subscription_agents_from_env() -> bool {
    subscription_agents_switch_on(env("MOMO_SUBSCRIPTION_AGENTS_ENABLED").as_deref())
}

/// #3397 — read the Claude subscription-agent opt-in. Off unless an exact `true`.
/// The operator's team-AI ceilings as this process reads them (ADR-0201 증보 v3 B9-3, #4944) — the
/// same rule the agent-worker enforces by (`parse_operator_cap`): unset or empty = no ceiling, `0` =
/// off, a positive number = the ceiling. The api only **explains** the ceiling, so a value it cannot
/// read is a warning and "not shown", never a refusal to boot (the worker, which enforces, fails
/// loudly on the same value).
pub fn team_ai_caps_from_env() -> momo_workspace_actions::team_ai_limits::OperatorCaps {
    use momo_workspace_actions::team_ai_limits::{parse_operator_cap, OperatorCaps};
    let read = |key: &'static str| match parse_operator_cap(key, env(key).as_deref()) {
        Ok(cap) => cap,
        Err(invalid) => {
            tracing::warn!(
                variable = invalid.0,
                "unreadable team AI ceiling; the settings screen will not show it"
            );
            None
        }
    };
    OperatorCaps {
        daily_tokens: read("TEAM_AI_DAILY_TOKEN_CAP"),
        daily_searches: read("TEAM_AI_DAILY_SEARCH_CAP"),
    }
}

fn claude_subscription_agents_from_env() -> bool {
    claude_subscription_agents_switch_on(env("MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED").as_deref())
}

fn claude_subscription_agents_switch_on(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.trim() == "true")
}

/// Unset = on (the shipped default); an exact `true` = on; **anything else =
/// off**. Blank counts as unset because an env file that declares the key with
/// no value has not decided anything.
fn subscription_agents_switch_on(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        None | Some("") => true,
        Some(value) => value == "true",
    }
}

/// ADR-0171 D6 — same spelling as the hosted-delivery gate: lowercase `true`
/// only. `True` / `1` / `yes` stay closed.
fn doorbell_gate_open(value: Option<&str>) -> bool {
    hosted_delivery_gate_open(value)
}

/// `MOMO_AGENT_PORT_HOSTED_LEASE_MINUTES` -> clamped seconds. A value outside
/// 5..=120 minutes is clamped, and the operator is told once at boot (#3530).
fn hosted_lease_seconds_from_env() -> Result<i64, ConfigError> {
    let minutes = env_number::<i64>(
        "MOMO_AGENT_PORT_HOSTED_LEASE_MINUTES",
        momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT / 60,
    )?;
    let requested = minutes.saturating_mul(60);
    let clamped = momo_outbox::clamp_hosted_lease_seconds(requested);
    if clamped != requested {
        tracing::warn!(
            requested_minutes = minutes,
            effective_minutes = clamped / 60,
            "MOMO_AGENT_PORT_HOSTED_LEASE_MINUTES is outside 5..=120 and was clamped"
        );
    }
    Ok(clamped)
}

/// ADR-0200 D4 (#3742) — the windows behind `responsive` / `quiet` / `unresponsive` /
/// `woken_not_collected`, read once from the environment:
/// `MOMO_AGENT_PORT_LIVENESS_RESPONSIVE_MINUTES` (default 20, a 15-minute routine plus
/// slack), `MOMO_AGENT_PORT_LIVENESS_QUIET_MINUTES` (60, never below the responsive
/// window), `MOMO_AGENT_PORT_LIVENESS_WOKEN_GRACE_MINUTES` (5). Each is clamped so a typo
/// cannot make every agent look permanently silent (or permanently fine); an unparsable
/// value falls back to the default with a warning — a display threshold is not worth a
/// failed boot. A process-wide read rather than an `AgentPortConfig` field so the fixtures
/// that build that struct literally are untouched.
pub fn liveness_thresholds() -> momo_agent::LivenessThresholds {
    static THRESHOLDS: std::sync::OnceLock<momo_agent::LivenessThresholds> =
        std::sync::OnceLock::new();
    *THRESHOLDS.get_or_init(|| match liveness_thresholds_from_env() {
        Ok(thresholds) => thresholds,
        Err(error) => {
            tracing::warn!(error = %error, "liveness thresholds unreadable; using the defaults");
            momo_agent::LivenessThresholds::default()
        }
    })
}

fn liveness_thresholds_from_env() -> Result<momo_agent::LivenessThresholds, ConfigError> {
    let defaults = momo_agent::LivenessThresholds::default();
    let responsive = env_number::<i64>(
        "MOMO_AGENT_PORT_LIVENESS_RESPONSIVE_MINUTES",
        defaults.responsive.num_minutes(),
    )?
    .clamp(1, 240);
    let quiet = env_number::<i64>(
        "MOMO_AGENT_PORT_LIVENESS_QUIET_MINUTES",
        defaults.quiet.num_minutes(),
    )?
    .clamp(responsive, 1440);
    let grace = env_number::<i64>(
        "MOMO_AGENT_PORT_LIVENESS_WOKEN_GRACE_MINUTES",
        defaults.woken_grace.num_minutes(),
    )?
    .clamp(1, 60);
    Ok(momo_agent::LivenessThresholds {
        responsive: chrono::Duration::minutes(responsive),
        quiet: chrono::Duration::minutes(quiet),
        woken_grace: chrono::Duration::minutes(grace),
    })
}

/// The three variables an operator sets, in the order [`InitiativeLimits::from_env_values`] takes
/// their values: cards an hour, cards a day, hours a card waits.
///
/// [`InitiativeLimits::from_env_values`]: momo_agent::initiative::InitiativeLimits::from_env_values
const INITIATIVE_LIMIT_VARIABLES: [&str; 3] = [
    "MOMO_AGENT_INITIATIVE_PER_HOUR",
    "MOMO_AGENT_INITIATIVE_PER_DAY",
    "MOMO_AGENT_INITIATIVE_TTL_HOURS",
];

/// ADR-0186 증보 v5 U-d (#4704 PR B) — the rate and the lifetime of a card an agent raises
/// **unasked**, read once from the environment: `MOMO_AGENT_INITIATIVE_PER_HOUR` (default 6,
/// 1..=60), `MOMO_AGENT_INITIATIVE_PER_DAY` (20, 1..=240) and `MOMO_AGENT_INITIATIVE_TTL_HOURS`
/// (24, 1..=168). Each is clamped to its range and a value that is not a number falls back to the
/// default, both with a warning when it is read (at startup: `main` asks once): a typo must not close
/// the door (a zero) nor open it past the ceiling, and an abuse limit is not worth a failed boot. A
/// process-wide read for the reason `liveness_thresholds` is: the fixtures that build
/// [`AgentPortConfig`] literally are untouched.
pub fn initiative_limits() -> momo_agent::initiative::InitiativeLimits {
    static LIMITS: std::sync::OnceLock<momo_agent::initiative::InitiativeLimits> =
        std::sync::OnceLock::new();
    *LIMITS.get_or_init(|| initiative_limits_from(env))
}

/// [`initiative_limits`] over any source of variables, so a test can say which name feeds which
/// number (a variable misnamed here would be an operator's setting silently ignored).
fn initiative_limits_from(
    read: impl Fn(&str) -> Option<String>,
) -> momo_agent::initiative::InitiativeLimits {
    let [per_hour, per_day, ttl_hours] = INITIATIVE_LIMIT_VARIABLES;
    let (limits, readings) = momo_agent::initiative::InitiativeLimits::from_env_values(
        read(per_hour).as_deref(),
        read(per_day).as_deref(),
        read(ttl_hours).as_deref(),
    );
    for (name, reading) in INITIATIVE_LIMIT_VARIABLES.into_iter().zip(readings) {
        match reading {
            momo_agent::initiative::LimitReading::Clamped { requested } => tracing::warn!(
                variable = name,
                requested,
                "an agent-initiative limit is outside its range and was clamped"
            ),
            momo_agent::initiative::LimitReading::Unparsable => tracing::warn!(
                variable = name,
                "an agent-initiative limit is not a number; using the default"
            ),
            _ => {}
        }
    }
    limits
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
            hosted_lease_seconds: hosted_lease_seconds_from_env()?,
            subscription_agents_enabled: subscription_agents_from_env(),
            claude_subscription_agents_enabled: claude_subscription_agents_from_env(),
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

/// ADR-0216 D9 (#4660) — the developer-token door's three budgets: per token, per
/// member, and the write row (L6, `dev:messages:write`) per token. The counters are
/// keyed on stable ids (`token.id`, `member.id`), never an address, and live in the
/// Agent Port limiter map under `dev:` keys (`crate::dev_access`).
///
/// **No off switch** (ADR-0180 C6). A developer token is a person's credential driven
/// by a program, so every knob here is a ceiling an operator may move but not remove:
/// 0, a negative number, a blank value and anything that does not parse all keep the
/// default. That is the opposite of [`AgentPortConfig`], where 0 disables an axis and
/// garbage fails the boot (`env_number`), and the same discipline as
/// [`RateLimitConfig::password_guess_per_account_limit`]. The door applies
/// [`DevAccessConfig::normalized`] again at use, so a config built by hand with a 0
/// cannot unbudget the door either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DevAccessConfig {
    /// `MOMO_DEV_ACCESS_RATE_LIMIT_WINDOW_SECONDS` (default 60).
    pub window_seconds: u64,
    /// `MOMO_DEV_ACCESS_RATE_LIMIT_PER_TOKEN` (default 240 per window — the Agent
    /// Port's per-token number).
    pub per_token_limit: u32,
    /// `MOMO_DEV_ACCESS_RATE_LIMIT_PER_MEMBER` (default 480 per window — the Agent
    /// Port's per-agent number), shared by every developer token of one member.
    pub per_member_limit: u32,
    /// `MOMO_DEV_ACCESS_RATE_LIMIT_WRITE_PER_TOKEN` (default 30 per window): the send
    /// row only. Counted on top of the per-token budget, never instead of it.
    pub write_per_token_limit: u32,
}

impl Default for DevAccessConfig {
    fn default() -> Self {
        DevAccessConfig {
            window_seconds: 60,
            per_token_limit: 240,
            per_member_limit: 480,
            write_per_token_limit: 30,
        }
    }
}

impl DevAccessConfig {
    pub fn from_env() -> DevAccessConfig {
        Self::from_lookup(env)
    }

    /// [`from_env`](Self::from_env) over any lookup, so every env name and the
    /// "no off switch" rule are testable without touching the process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> DevAccessConfig {
        let defaults = DevAccessConfig::default();
        DevAccessConfig {
            window_seconds: Self::positive_or(
                lookup("MOMO_DEV_ACCESS_RATE_LIMIT_WINDOW_SECONDS"),
                defaults.window_seconds,
            ),
            per_token_limit: Self::positive_or(
                lookup("MOMO_DEV_ACCESS_RATE_LIMIT_PER_TOKEN"),
                defaults.per_token_limit,
            ),
            per_member_limit: Self::positive_or(
                lookup("MOMO_DEV_ACCESS_RATE_LIMIT_PER_MEMBER"),
                defaults.per_member_limit,
            ),
            write_per_token_limit: Self::positive_or(
                lookup("MOMO_DEV_ACCESS_RATE_LIMIT_WRITE_PER_TOKEN"),
                defaults.write_per_token_limit,
            ),
        }
    }

    /// Every 0 replaced by its default. The limiter reads a limit of 0 as "this axis
    /// is off", which is exactly what this config must never mean.
    pub fn normalized(self) -> DevAccessConfig {
        let defaults = DevAccessConfig::default();
        let keep = |value: u32, fallback: u32| if value == 0 { fallback } else { value };
        DevAccessConfig {
            window_seconds: if self.window_seconds == 0 {
                defaults.window_seconds
            } else {
                self.window_seconds
            },
            per_token_limit: keep(self.per_token_limit, defaults.per_token_limit),
            per_member_limit: keep(self.per_member_limit, defaults.per_member_limit),
            write_per_token_limit: keep(self.write_per_token_limit, defaults.write_per_token_limit),
        }
    }

    /// A strictly positive number, or `fallback` for anything else (absent, blank,
    /// 0, negative, not a number).
    fn positive_or<T>(raw: Option<String>, fallback: T) -> T
    where
        T: std::str::FromStr + PartialOrd + Default,
    {
        raw.and_then(|value| value.trim().parse::<T>().ok())
            .filter(|value| *value > T::default())
            .unwrap_or(fallback)
    }
}

#[cfg(test)]
mod dev_access_config_tests {
    use super::DevAccessConfig;

    fn lookup_all(value: &'static str) -> impl Fn(&str) -> Option<String> {
        move |key: &str| {
            key.starts_with("MOMO_DEV_ACCESS_RATE_LIMIT_")
                .then(|| value.to_string())
        }
    }

    /// ADR-0216 D9: the ADR's numbers when nothing is configured.
    #[test]
    fn nothing_configured_is_the_adr_numbers() {
        let config = DevAccessConfig::from_lookup(|_| None);
        assert_eq!(config, DevAccessConfig::default());
        assert_eq!(
            (
                config.window_seconds,
                config.per_token_limit,
                config.per_member_limit,
                config.write_per_token_limit
            ),
            (60, 240, 480, 30)
        );
    }

    /// ADR-0180 C6 / ADR-0216 R13: no value turns a budget off. 0, garbage, a negative
    /// number and a blank value all keep the default, on every knob.
    #[test]
    fn zero_garbage_negative_and_blank_keep_the_default() {
        for raw in ["0", "abc", "-5", "   ", "", "1.5", "0x10"] {
            assert_eq!(
                DevAccessConfig::from_lookup(lookup_all(raw)),
                DevAccessConfig::default(),
                "raw value {raw:?} must not change any budget"
            );
        }
    }

    /// A real number is taken as written (surrounding whitespace from an env file
    /// trimmed), each knob from its own name.
    #[test]
    fn a_positive_value_is_taken_from_its_own_name() {
        let config = DevAccessConfig::from_lookup(|key| {
            Some(
                match key {
                    "MOMO_DEV_ACCESS_RATE_LIMIT_WINDOW_SECONDS" => "120",
                    "MOMO_DEV_ACCESS_RATE_LIMIT_PER_TOKEN" => " 3\n",
                    "MOMO_DEV_ACCESS_RATE_LIMIT_PER_MEMBER" => "7",
                    "MOMO_DEV_ACCESS_RATE_LIMIT_WRITE_PER_TOKEN" => "2",
                    _ => return None,
                }
                .to_string(),
            )
        });
        assert_eq!(
            config,
            DevAccessConfig {
                window_seconds: 120,
                per_token_limit: 3,
                per_member_limit: 7,
                write_per_token_limit: 2,
            }
        );
    }

    /// A config built by hand (a fixture, a future caller) with 0s is normalized back
    /// to the defaults before the door reads it; non-zero values are kept.
    #[test]
    fn normalizing_replaces_only_the_zeros() {
        let hand_built = DevAccessConfig {
            window_seconds: 0,
            per_token_limit: 0,
            per_member_limit: 9,
            write_per_token_limit: 0,
        };
        assert_eq!(
            hand_built.normalized(),
            DevAccessConfig {
                window_seconds: 60,
                per_token_limit: 240,
                per_member_limit: 9,
                write_per_token_limit: 30,
            }
        );
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
    /// ADR-0162 증보 5 G5 (#3857) — `MOMO_HOSTED_INPLACE_GRANT_ENABLED`.
    ///
    /// On (the default): a person's mention of a hosted agent in a channel its
    /// connection is not approved for raises an in-place 「이 채널에서 쓰기」
    /// approval card with a held run. Off: the old notice line, nothing else.
    /// It is the door's off switch, not a widening of HAP-E3 — the grant still
    /// needs a workspace admin's explicit approval of that one channel.
    ///
    /// Parsed like the subscription switch: unset, blank or an exact `true` is
    /// on; any other value is off, so a misspelled "off" closes the door.
    pub hosted_inplace_grant_enabled: bool,
}

impl Default for MentionSettings {
    fn default() -> Self {
        MentionSettings {
            context_max_messages: momo_agent::mention::CONTEXT_WINDOW_DEFAULT,
            hosted_inplace_grant_enabled: true,
        }
    }
}

impl MentionSettings {
    pub fn from_env() -> MentionSettings {
        MentionSettings {
            context_max_messages: momo_agent::context_window_size(
                env("AGENT_CONTEXT_MAX_MESSAGES").as_deref(),
            ),
            hosted_inplace_grant_enabled: hosted_inplace_grant_switch_on(
                env("MOMO_HOSTED_INPLACE_GRANT_ENABLED").as_deref(),
            ),
        }
    }
}

/// ADR-0208 D15 (#4214) — the scheduled-message tick's four optional knobs. Every one has a
/// default and none is required, so an instance that configured nothing runs the scheduler
/// exactly as the ADR describes.
///
/// `MOMO_SCHEDULER_ENABLED=0` is a kill switch with a **visible** off state: the tick does not
/// run and creating, editing or sending-now a schedule answers 503 `scheduler_disabled`
/// (listing and deleting still work), so a schedule is never silently accepted by a server that
/// will not send it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulerSettings {
    /// `MOMO_SCHEDULER_ENABLED` — default on. See [`parse_scheduler_enabled`].
    pub enabled: bool,
    /// `MOMO_SCHEDULER_TICK_MS` — how often the tick looks for due schedules. Default 5000, floor 1000.
    pub tick_ms: u64,
    /// `MOMO_SCHEDULER_BATCH` — due rows taken per look. Default 100, 1..=200 (the definer function's own cap).
    pub batch: i32,
    /// `MOMO_SCHEDULER_GRACE_SECONDS` — how late a schedule may still be sent after its time (a rolling
    /// deploy, a restart, a short outage). Default 3600, 300..=86400. Past it the row is closed `failed`
    /// and the author decides (ADR-0208 D7).
    pub grace_seconds: i64,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        SchedulerSettings {
            enabled: true,
            tick_ms: SCHEDULER_TICK_MS_DEFAULT,
            batch: SCHEDULER_BATCH_DEFAULT,
            grace_seconds: SCHEDULER_GRACE_SECONDS_DEFAULT,
        }
    }
}

pub const SCHEDULER_TICK_MS_DEFAULT: u64 = 5000;
pub const SCHEDULER_TICK_MS_FLOOR: u64 = 1000;
pub const SCHEDULER_BATCH_DEFAULT: i32 = 100;
pub const SCHEDULER_BATCH_MAX: i32 = 200;
pub const SCHEDULER_GRACE_SECONDS_DEFAULT: i64 = 3600;
pub const SCHEDULER_GRACE_SECONDS_MIN: i64 = 300;
pub const SCHEDULER_GRACE_SECONDS_MAX: i64 = 86400;

/// Unset or blank = on; an explicit `1`/`true`/`on`/`yes` (any case) = on; **anything else = off**.
/// Off is the fail-closed side here — it is visible (503) rather than silent — so a value that is
/// not clearly "on" does not keep accepting schedules the tick may not send.
pub fn parse_scheduler_enabled(raw: Option<&str>) -> bool {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None => true,
        Some(value) => ["1", "true", "on", "yes"]
            .iter()
            .any(|on| value.eq_ignore_ascii_case(on)),
    }
}

/// Unparsable falls back to the default (a typo in a knob must not stop the tick); below the floor is raised to it.
pub fn parse_scheduler_tick_ms(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(SCHEDULER_TICK_MS_DEFAULT, |ms| {
            ms.max(SCHEDULER_TICK_MS_FLOOR)
        })
}

pub fn parse_scheduler_batch(raw: Option<&str>) -> i32 {
    raw.and_then(|value| value.trim().parse::<i32>().ok())
        .map_or(SCHEDULER_BATCH_DEFAULT, |batch| {
            batch.clamp(1, SCHEDULER_BATCH_MAX)
        })
}

pub fn parse_scheduler_grace_seconds(raw: Option<&str>) -> i64 {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .map_or(SCHEDULER_GRACE_SECONDS_DEFAULT, |seconds| {
            seconds.clamp(SCHEDULER_GRACE_SECONDS_MIN, SCHEDULER_GRACE_SECONDS_MAX)
        })
}

impl SchedulerSettings {
    pub fn from_env() -> SchedulerSettings {
        SchedulerSettings {
            enabled: parse_scheduler_enabled(env("MOMO_SCHEDULER_ENABLED").as_deref()),
            tick_ms: parse_scheduler_tick_ms(env("MOMO_SCHEDULER_TICK_MS").as_deref()),
            batch: parse_scheduler_batch(env("MOMO_SCHEDULER_BATCH").as_deref()),
            grace_seconds: parse_scheduler_grace_seconds(
                env("MOMO_SCHEDULER_GRACE_SECONDS").as_deref(),
            ),
        }
    }
}

/// #4443 / ADR-0151 증보 2 D4 — the attachment reclaim tick that lives in the api process.
///
/// The same variable names and defaults as the notifier's Google-Drive sweep (an operator sets
/// one spelling and whichever process owns the backend reads it):
///
/// * `MOMO_ATTACHMENT_RECLAIM` — **exactly `1` turns the delete on**; unset, empty, `0`, `true`,
///   a typo all leave it looking only (`momo_messaging::attachment_reclaim::delete_switch_is_on`,
///   the one definition both processes call). The job deletes files nobody can get back, so it
///   ships off; switched off, every tick writes one dry-run line with what it *would* delete.
/// * `MOMO_ATTACHMENT_RECLAIM_INTERVAL_MS` — 600000, floored at 10000. Unparsable → default.
/// * `MOMO_ATTACHMENT_RECLAIM_BATCH` — files per tick, 50, clamped 1..=500. Unparsable → default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentReclaimSettings {
    pub delete_enabled: bool,
    pub interval_ms: u64,
    pub batch: i64,
}

pub const ATTACHMENT_RECLAIM_INTERVAL_MS_DEFAULT: u64 = 600_000;
pub const ATTACHMENT_RECLAIM_INTERVAL_MS_FLOOR: u64 = 10_000;
pub const ATTACHMENT_RECLAIM_BATCH_DEFAULT: i64 = 50;
pub const ATTACHMENT_RECLAIM_BATCH_MAX: i64 = 500;

impl Default for AttachmentReclaimSettings {
    fn default() -> Self {
        AttachmentReclaimSettings {
            delete_enabled: false,
            interval_ms: ATTACHMENT_RECLAIM_INTERVAL_MS_DEFAULT,
            batch: ATTACHMENT_RECLAIM_BATCH_DEFAULT,
        }
    }
}

pub fn parse_attachment_reclaim_interval_ms(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(ATTACHMENT_RECLAIM_INTERVAL_MS_DEFAULT, |ms| {
            ms.max(ATTACHMENT_RECLAIM_INTERVAL_MS_FLOOR)
        })
}

pub fn parse_attachment_reclaim_batch(raw: Option<&str>) -> i64 {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .map_or(ATTACHMENT_RECLAIM_BATCH_DEFAULT, |batch| {
            batch.clamp(1, ATTACHMENT_RECLAIM_BATCH_MAX)
        })
}

impl AttachmentReclaimSettings {
    pub fn from_env() -> AttachmentReclaimSettings {
        AttachmentReclaimSettings::from_lookup(&env)
    }

    /// [`AttachmentReclaimSettings::from_env`] with the lookup handed in, so a test proves that
    /// the **switch variable** reaches `delete_enabled` (the one line that decides whether this
    /// process deletes files) without touching the process environment.
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> AttachmentReclaimSettings {
        AttachmentReclaimSettings {
            delete_enabled: momo_messaging::attachment_reclaim::delete_switch_is_on(
                get("MOMO_ATTACHMENT_RECLAIM").as_deref(),
            ),
            interval_ms: parse_attachment_reclaim_interval_ms(
                get("MOMO_ATTACHMENT_RECLAIM_INTERVAL_MS").as_deref(),
            ),
            batch: parse_attachment_reclaim_batch(get("MOMO_ATTACHMENT_RECLAIM_BATCH").as_deref()),
        }
    }
}

/// Unset / blank / exact `true` = on; anything else = off (G5).
fn hosted_inplace_grant_switch_on(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        None | Some("") => true,
        Some(value) => value == "true",
    }
}

/// ADR-0197 M1 (#3500) — whether the personal cloud box routes answer at all.
///
/// `MOMO_CLOUD_BOX_ENABLED`, **exact `true` opens it**; unset, `True`, `1`, `yes`,
/// a typo all stay closed. Closed means every cloud-box route answers 404 before
/// any database read, so a production instance that never opted in exposes
/// nothing. Constructing the struct directly overrides the environment (how the
/// PG suites open it).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudBoxConfig {
    pub enabled: bool,
}

impl CloudBoxConfig {
    pub fn from_env() -> Self {
        CloudBoxConfig {
            enabled: cloud_box_gate_open(env("MOMO_CLOUD_BOX_ENABLED").as_deref()),
        }
    }
}

/// The parse, separated from the environment so the table is a test.
fn cloud_box_gate_open(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.trim() == "true")
}

/// Human device-key settings (ADR-0146 개정 2026-09-28, #3022).
///
/// * `MOMO_INSTANCE_ID` — the value every `momo.human.control.v2` statement
///   carries in its `instance_id` line, so a statement signed for one instance
///   does not verify on another (D-5). Opaque, operator-chosen, stable for the
///   life of the instance. Clients never build it from a URL: E3 (#3023)
///   serves this same value for them to echo.
/// * `MOMO_HOST_REGISTER_SIGNATURE_REQUIRED` — `true` makes a member-scoped
///   `POST …/work-hosts` without a verified root-key `host_register` signature
///   a 403 `device_signature_required` (D-8). Default **off**: no desktop build
///   signs yet (E5 #3025), and ADR-0146 D-11 keeps the R2 switches closed
///   until the R1 security re-review PASS. A signature that IS sent is verified
///   either way.
/// * `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS` — `true` makes a refresh-token
///   reuse end the lineage of every session (ADR-0188 §4 R1). Default **off**:
///   QR-linked (phone) lineages are swept regardless; password sign-ins wait
///   until the web client coordinates rotation across tabs, because a tab
///   opened later spends the token an older tab holds and the server cannot
///   tell that from theft (#3022 review H2).
/// * `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` — `true` makes a person's
///   instruction to a member-scoped host (a permission **allow** today; the
///   signed `input`/`spawn` route is E7 #3027) without a verified
///   `momo.human.control.v2` signature a 403 `device_signature_required`, and
///   refuses the owner's resume onto a member host (v1 cannot sign a spawn
///   into a session the server chose, #3024 M2). Default **off** (ADR-0146
///   D-11, Q11: closed until the R1 re-review and the R2 review PASS). A
///   signature that IS sent is verified either way (#3023).
/// * `MOMO_REFRESH_PROOF_MODE` — `off` | `observe` | `require` (#3079,
///   ADR-0146 D-7 증보). How `POST /v1/auth/refresh` treats the
///   `momo.human.refresh_proof.v1` proof a native client signs with its
///   lineage's refresh key. Default **`observe`**: a proof that is sent binds
///   the lineage's key (first proof) and a verified one recovers a lineage
///   whose rotation response was lost, however long ago; a missing or bad
///   proof changes nothing. `require` makes a key-bound lineage need a
///   verified proof on every refresh and ends it when its spent token comes
///   back without one (inside the 30 s window too). Lineages bound under
///   `observe` are enforced the moment the mode flips. `off` ignores proofs.
///   Any other value is a boot error.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceKeySettings {
    pub instance_id: Option<String>,
    pub host_register_signature_required: bool,
    pub refresh_reuse_sweep_all_sessions: bool,
    pub human_control_signature_required: bool,
    pub refresh_proof_mode: RefreshProofMode,
    /// `MOMO_REFRESH_PROOF_MODE` was set to something unparseable.
    pub refresh_proof_mode_invalid: bool,
}

impl DeviceKeySettings {
    pub fn from_env() -> DeviceKeySettings {
        let refresh_proof_mode = match env("MOMO_REFRESH_PROOF_MODE") {
            None => Some(RefreshProofMode::default()),
            Some(raw) => RefreshProofMode::parse(&raw),
        };
        DeviceKeySettings {
            instance_id: env("MOMO_INSTANCE_ID").map(|value| value.trim().to_string()),
            host_register_signature_required: env("MOMO_HOST_REGISTER_SIGNATURE_REQUIRED")
                .is_some_and(|value| value.trim() == "true"),
            refresh_reuse_sweep_all_sessions: env("MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS")
                .is_some_and(|value| value.trim() == "true"),
            human_control_signature_required: env("MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED")
                .is_some_and(|value| value.trim() == "true"),
            refresh_proof_mode: refresh_proof_mode.unwrap_or_default(),
            refresh_proof_mode_invalid: refresh_proof_mode.is_none(),
        }
    }

    /// A requirement nobody could satisfy is a misconfiguration, not a closed
    /// door: with no instance id no statement can be rebuilt, so every
    /// member-scoped registration would be refused.
    pub fn boot_error(&self) -> Option<&'static str> {
        if self.refresh_proof_mode_invalid {
            return Some("MOMO_REFRESH_PROOF_MODE must be off, observe or require");
        }
        if self.host_register_signature_required && self.instance_id.is_none() {
            return Some(
                "MOMO_HOST_REGISTER_SIGNATURE_REQUIRED=true needs MOMO_INSTANCE_ID (the instance id signed statements carry)",
            );
        }
        if self.human_control_signature_required && self.instance_id.is_none() {
            return Some(
                "MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED=true needs MOMO_INSTANCE_ID (the instance id signed statements carry)",
            );
        }
        if self
            .instance_id
            .as_deref()
            .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Some("MOMO_INSTANCE_ID must be 1..=256 bytes");
        }
        if self
            .instance_id
            .as_deref()
            .is_some_and(|id| id.chars().any(char::is_control))
        {
            return Some("MOMO_INSTANCE_ID must not contain control characters");
        }
        None
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

/// ADR-0203 (#3883) — what the operator declared about a co-hosted agent.
///
/// * `declared`: the operator wrote `HERMES_BASE_URL` (Q1 (a): the same variable,
///   so no second egress-exempt input). [`momo_settings::ProviderConfig`] fills
///   a localhost default when it is unset, so that default must never be read as
///   a declaration: with `declared == false` the feature makes **zero** network
///   calls. What the screen may show then is only a plan for the instance
///   operator, never a finding about an agent (ADR-0203 증보 2026-10-25 F6).
/// * `tools_locked`: `OORT_COHOSTED_AGENT_TOOLS_LOCKED` — the operator's own
///   statement that they followed the tool-lock checklist (D6). It is an
///   attestation, not a verification; the server cannot see the agent's tools.
/// * `platform`: #4337 (ADR-0203 증보 2026-10-25 F1·F3) — which host the process
///   runs on, **classified once at boot into a closed enum**. The raw
///   `MOMO_SELF_HOST_PLATFORM` / `RAILWAY_ENVIRONMENT_ID` strings are not kept
///   (this struct derives `Debug`); the value only picks wording on the operator's
///   screen and decides nothing else.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CohostedAgentConfig {
    pub declared: bool,
    pub tools_locked: bool,
    /// #3948 (ADR-0203 증보 K4): `OORT_COHOSTED_AGENT_CONNECTORS_LOCKED` — the
    /// operator's own statement that Hermes's connectors follow the checklist
    /// (`trust: untrusted`, `sampling` off, an exact `tools.include`, no write
    /// tools). Self-declared, not verified by oort.
    pub connectors_locked: bool,
    /// #3948: `OORT_COHOSTED_AGENT_CONNECTOR_APPS` — the app ids the operator
    /// switched on in Hermes. Empty when unset or when any entry is malformed.
    pub connector_apps: Vec<String>,
    /// #4337: where this process runs, classified at boot (see the struct doc).
    pub platform: crate::host_platform::HostPlatform,
}

impl CohostedAgentConfig {
    pub fn from_env() -> CohostedAgentConfig {
        Self::from_lookup(env)
    }

    /// [`from_env`](Self::from_env) over any lookup, so the parse is testable
    /// without touching the process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> CohostedAgentConfig {
        let attest = momo_agent::ConnectorTrialAttest::from_env(&lookup);
        CohostedAgentConfig {
            declared: lookup("HERMES_BASE_URL").is_some(),
            tools_locked: attest.tools_locked,
            connectors_locked: attest.connectors_locked,
            connector_apps: attest.apps,
            platform: crate::host_platform::HostPlatform::classify(&lookup),
        }
    }

    /// The attestation the delivery gate compares against.
    pub fn attest(&self) -> momo_agent::ConnectorTrialAttest {
        momo_agent::ConnectorTrialAttest {
            tools_locked: self.tools_locked,
            connectors_locked: self.connectors_locked,
            apps: self.connector_apps.clone(),
        }
    }
}

/// #4079 (ADR-0203 증보 2026-10-19 L2·L4, Q3): where the Hermes login relay sidecar listens and the key it
/// wants. **Both or neither**: with either missing (or a key that is not 32-256 characters of
/// `[A-Za-z0-9._~+/=-]`, which also refuses an unresolved `${{shared.X}}` reference left in the variable) the
/// relay is off, every route answers `409 login_relay_off` and the screen shows the shell command instead.
/// The key is its own secret, never the chat key (`HERMES_API_KEY`). `Debug` never prints it.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct LoginRelayConfig {
    url: Option<String>,
    key: Option<String>,
    /// #4081: the operator declared (`HERMES_APP_LOGIN_GOOGLE_PUBLISHING=testing`) that the Google OAuth project is
    /// External and in Testing, where Google expires a refresh token about 7 days after consent. oort cannot read
    /// the project's real status, so this is a declaration and the screen words it as one.
    google_testing: bool,
}

impl std::fmt::Debug for LoginRelayConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRelayConfig")
            .field(
                "url",
                &self
                    .url
                    .as_deref()
                    .map(momo_settings::redacted_endpoint_label),
            )
            .field("key", &self.key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl LoginRelayConfig {
    pub fn new(url: impl Into<String>, key: impl Into<String>) -> Self {
        let (url, key) = (url.into(), key.into());
        LoginRelayConfig::from_lookup(|name| match name {
            "HERMES_LOGIN_RELAY_URL" => Some(url.clone()),
            "HERMES_LOGIN_RELAY_KEY" => Some(key.clone()),
            _ => None,
        })
    }

    pub fn from_env() -> Self {
        Self::from_lookup(env)
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let url = lookup("HERMES_LOGIN_RELAY_URL")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let key = lookup("HERMES_LOGIN_RELAY_KEY")
            .map(|v| v.trim().to_string())
            .filter(|k| {
                (32..=256).contains(&k.len())
                    && k.bytes().all(|b| {
                        b.is_ascii_alphanumeric()
                            || matches!(b, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
                    })
            });
        match (url, key) {
            (Some(url), Some(key)) => LoginRelayConfig {
                url: Some(url),
                key: Some(key),
                google_testing: lookup("HERMES_APP_LOGIN_GOOGLE_PUBLISHING")
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("testing")),
            },
            _ => LoginRelayConfig::default(),
        }
    }

    /// Declare (or not) the Google OAuth project as External + Testing, as `HERMES_APP_LOGIN_GOOGLE_PUBLISHING=testing` does.
    pub fn with_google_testing(mut self, on: bool) -> Self {
        self.google_testing = on;
        self
    }

    /// Whether the operator declared the Google OAuth project as External + Testing (7-day refresh expiry).
    pub fn google_testing(&self) -> bool {
        self.google_testing
    }

    pub fn configured(&self) -> bool {
        self.url.is_some() && self.key.is_some()
    }

    /// The address passes the same write gate as `HERMES_BASE_URL` (plaintext `http://` for a non-public host
    /// needs the operator's own `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK` + exact `AGENT_PROVIDER_LOCAL_HOSTS`),
    /// and `None` means off.
    pub fn target(&self, settings: &SettingsConfig) -> Option<momo_provider_probe::RelayTarget> {
        let (url, key) = (self.url.as_ref()?, self.key.as_ref()?);
        let approved = momo_settings::validated_base_url(
            url,
            &settings.environment,
            settings.env_provider.allow_local_loopback,
        )
        .ok()?;
        // The relay is dialled at its origin only; a path would pass the write gate and then fail every call,
        // which reads as a broken request. Off is the honest answer for such a value.
        let has_path = approved
            .split_once("://")
            .and_then(|(_, rest)| rest.split_once('/'))
            .is_some_and(|(_, path)| !path.is_empty());
        if has_path {
            return None;
        }
        Some(momo_provider_probe::RelayTarget {
            base_url: approved,
            key: key.clone(),
        })
    }

    /// The egress policy for the relay hop: the operator's policy plus the relay host as an **exact-match**
    /// opt-in (the sidecar lives on an internal host the public-address rule would otherwise refuse).
    pub fn egress_policy(&self, base: momo_settings::EgressPolicy) -> momo_settings::EgressPolicy {
        match &self.url {
            Some(url) if self.configured() => base.with_operator_base_url(url),
            _ => base,
        }
    }
}

/// #2960: the egress policy the 「연결 확인」 probe dials under — the same inputs
/// the agent-worker's provider client reads (`bins/momo-agent-worker/src/config.rs`
/// `egress_policy`), so the probe reaches exactly what a real turn would. There
/// is deliberately **no** strict-environment narrowing: ADR-0004 증보
/// (2026-09-08) keeps the operator flag valid under `MOMO_ENV=staging` (the
/// self-host default), the write gate (`momo_settings::validated_base_url`)
/// ignores the environment for the same reason, and the worker dials such a
/// host — so refusing it here would report a false failure (review #2972 M2).
/// `hermes_base_url_set` is whether the operator wrote `HERMES_BASE_URL`; only
/// then is its host trusted.
pub fn provider_probe_policy(
    settings: &SettingsConfig,
    hermes_base_url_set: bool,
    from_env: impl Fn(bool) -> momo_settings::EgressPolicy,
) -> momo_settings::EgressPolicy {
    let policy = from_env(settings.env_provider.allow_local_loopback);
    if hermes_base_url_set {
        policy.with_operator_base_url(&settings.env_provider.base_url)
    } else {
        policy
    }
}

/// Read [`provider_probe_policy`]'s inputs from the process environment.
pub fn provider_probe_policy_from_env(settings: &SettingsConfig) -> momo_settings::EgressPolicy {
    provider_probe_policy(
        settings,
        env("HERMES_BASE_URL").is_some(),
        momo_settings::EgressPolicy::from_env,
    )
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
    ///
    /// #2066: the webhook keys arrive as an argument instead of being re-read
    /// from the process environment. One reader is what makes this decidable in
    /// a unit test, and it removes the hole the old `env(...)` call had — it
    /// compared against the *raw* variable while [`WebhookSettings`] compared
    /// against the resolved one.
    pub fn boot_error(&self, jwt_secret: &str, webhook: &WebhookSettings) -> Option<&'static str> {
        let key = self.provider_link_master_key.as_deref()?;
        if key == jwt_secret {
            return Some("PROVIDER_LINK_MASTER_KEY must not reuse JWT_HMAC");
        }
        if webhook.outbound_master_key == key {
            return Some("PROVIDER_LINK_MASTER_KEY must not reuse OUTBOUND_WEBHOOK_MASTER_KEY");
        }
        if webhook.ingress_master_key == key {
            return Some("PROVIDER_LINK_MASTER_KEY must not reuse WEBHOOK_INGRESS_MASTER_KEY");
        }
        None
    }
}

/// ADR-0205 D1 (#3947) — the GitHub App's sealing key.
///
/// `master_key` is `GITHUB_APP_MASTER_KEY`, an **independent** root: the App's private key and
/// webhook secrets are sealed under `SHA256("momo.github_app.key.v1\n" || key)`.
///
/// * absent ⇒ every `/v1/integrations/github/*` route answers **503** and nothing else changes
///   (the same shape `PROVIDER_LINK_MASTER_KEY` has for the AI-연결 family);
/// * equal to the JWT secret or to the provider-link / webhook ingress / outbound master key ⇒
///   the boot is **refused**: reuse would make a leak of any of them open the App's credentials
///   (which, with `contents: read`, reach installed repositories' code — ADR-0205 D6), or the
///   reverse.
///
/// Held in memory only; never logged, never echoed — [`Debug`] reports presence.
#[derive(Clone, Default)]
pub struct GithubAppSettings {
    pub master_key: Option<String>,
}

impl GithubAppSettings {
    pub fn from_env() -> GithubAppSettings {
        GithubAppSettings {
            master_key: env("GITHUB_APP_MASTER_KEY"),
        }
    }

    /// The reuse guard (ADR-0205 D1). **Absence is not an error** — it closes the surface.
    /// `provider_link_master_key` is passed in (not re-read from the environment) so the
    /// comparison is decidable in a unit test and uses the same resolved value the provider
    /// surface does (the #2066 lesson).
    pub fn boot_error(
        &self,
        jwt_secret: &str,
        webhook: &WebhookSettings,
        provider_link_master_key: Option<&str>,
    ) -> Option<&'static str> {
        let key = self.master_key.as_deref()?;
        if key == jwt_secret {
            return Some("GITHUB_APP_MASTER_KEY must not reuse JWT_HMAC");
        }
        if webhook.outbound_master_key == key {
            return Some("GITHUB_APP_MASTER_KEY must not reuse OUTBOUND_WEBHOOK_MASTER_KEY");
        }
        if webhook.ingress_master_key == key {
            return Some("GITHUB_APP_MASTER_KEY must not reuse WEBHOOK_INGRESS_MASTER_KEY");
        }
        if provider_link_master_key == Some(key) {
            return Some("GITHUB_APP_MASTER_KEY must not reuse PROVIDER_LINK_MASTER_KEY");
        }
        None
    }
}

impl std::fmt::Debug for GithubAppSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GithubAppSettings")
            .field("master_key_configured", &self.master_key.is_some())
            .finish()
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

/// The two webhook families' knobs (#1222, ADR-0004 증보 4 / #2066).
///
/// ## Why there are two master keys and neither is the JWT secret
///
/// Until #2066 the **inbound** native ingress secret was derived from `JWT_HMAC`
/// (Swift `App.swift:265` hands `WebhookRoutes` `config.jwtHMAC`) and the
/// **outbound** event-subscription secret from `OUTBOUND_WEBHOOK_MASTER_KEY`
/// *or*, unset, that same JWT secret (`App.swift:207`). Both derivations are
/// domain-separated (`momo-webhook/src/crypto.rs`), so the reuse was never a
/// cryptographic break — it was an **operational** one: rotating `JWT_HMAC`
/// invalidated every already-issued webhook secret at once, with no row
/// anywhere recording that it had happened.
///
/// So both keys are now required and independent, and the fallback is deleted.
/// The migration that makes that safe is not in this file: the generator's
/// add-only backfill writes each new key as an explicit **copy of the value
/// already in use** (ADR-0004 증보 4 D2(a)), so the day the fallback disappears
/// every derivation is byte-identical to the day before. From then on the keys
/// are independent variables and a JWT rotation touches nothing here.
///
/// `ingress_master_key == outbound_master_key == JWT_HMAC` is therefore the
/// expected state of a freshly upgraded install: [`WebhookSettings::boot_error`]
/// permits exactly that window and `oort doctor` carries the rotation nudge.
#[derive(Clone, PartialEq, Eq)]
pub struct WebhookSettings {
    /// `WEBHOOK_INGRESS_MASTER_KEY` — the derivation root for inbound native
    /// ingress secrets (`momo_whsec_v1.*`). Held in memory only; never logged,
    /// never echoed, used for nothing but HMAC derivation.
    pub ingress_master_key: String,
    /// `OUTBOUND_WEBHOOK_MASTER_KEY` — the derivation root for outbound event
    /// subscription and doorbell secrets (`momo_evtsec_v1.*`). Same handling
    /// rules as the field above.
    pub outbound_master_key: String,
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
    /// ADR-0115 D3: sliding-window per-installation ingress cap.
    /// `RATE_LIMIT_WEBHOOK_PER_INSTALLATION` (default 60). 0 disables.
    pub per_installation_limit: u32,
}

impl Default for WebhookSettings {
    /// HTTPS required, doorbell shut, and **empty master keys**.
    ///
    /// Empty is the honest default for a value that has no defensible one, and
    /// it is unreachable in a booted server: [`Config::from_env`] returns
    /// [`ConfigError::MissingWebhookMasterKey`] before a `Config` exists, and
    /// `main` is the only producer of the `AppState` the routes read. What is
    /// left is the test `AppState`, which either names its own keys or never
    /// touches a webhook route.
    fn default() -> Self {
        WebhookSettings {
            ingress_master_key: String::new(),
            outbound_master_key: String::new(),
            allow_development_http: false,
            doorbell_enabled: false,
            per_installation_limit: 60,
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
                "ingress_master_key_configured",
                &!self.ingress_master_key.is_empty(),
            )
            .field(
                "outbound_master_key_configured",
                &!self.outbound_master_key.is_empty(),
            )
            .field("allow_development_http", &self.allow_development_http)
            .field("doorbell_enabled", &self.doorbell_enabled)
            .field("per_installation_limit", &self.per_installation_limit)
            .finish_non_exhaustive()
    }
}

impl WebhookSettings {
    /// ADR-0004 증보 4 D1: both keys are required. `env` already treats an empty
    /// or whitespace-only value as absent, which matters because compose passes
    /// these with the optional `${VAR:-}` form — an operator who emptied the key
    /// gets the same fail-closed sentence as one who deleted it.
    pub fn from_env() -> Result<WebhookSettings, ConfigError> {
        let ingress_master_key = env("WEBHOOK_INGRESS_MASTER_KEY").ok_or(
            ConfigError::MissingWebhookMasterKey("WEBHOOK_INGRESS_MASTER_KEY"),
        )?;
        let outbound_master_key = env("OUTBOUND_WEBHOOK_MASTER_KEY").ok_or(
            ConfigError::MissingWebhookMasterKey("OUTBOUND_WEBHOOK_MASTER_KEY"),
        )?;
        Ok(WebhookSettings {
            ingress_master_key,
            outbound_master_key,
            allow_development_http: env_or("MOMO_ENV", "local")
                .trim()
                .eq_ignore_ascii_case("local")
                && env_or("MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP", "0").trim() == "1",
            doorbell_enabled: doorbell_gate_open(env("MOMO_DOORBELL_ENABLED").as_deref()),
            per_installation_limit: env("RATE_LIMIT_WEBHOOK_PER_INSTALLATION")
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(60),
        })
    }

    /// The reuse guard [`SettingsConfig::boot_error`] applies to the provider
    /// master key, extended to these two (ADR-0004 증보 4 D1) — with the one
    /// exception D2(a) buys.
    ///
    /// | state | verdict | why |
    /// |---|---|---|
    /// | either key == the other, both == `JWT_HMAC` | **boot** | the D2(a) migration window: this is what the backfill just wrote, and refusing it would take down every upgrading install |
    /// | either key == `JWT_HMAC` (only one of them) | **boot** | half-migrated is still a copy of a value in use, not a new blast radius; doctor asks for the rotation |
    /// | the two keys equal each other, neither == `JWT_HMAC` | **refuse** | two rotated keys that landed on one value merge the inbound and outbound blast radii for no reason a rotation could have intended |
    ///
    /// Returning `Some` is fatal; the transition window instead surfaces through
    /// [`WebhookSettings::reuses_jwt_secret`], which boot logs once and
    /// `oort doctor` records as a warning.
    pub fn boot_error(&self, jwt_secret: &str) -> Option<&'static str> {
        if self.ingress_master_key == self.outbound_master_key
            && self.ingress_master_key != jwt_secret
        {
            return Some(
                "WEBHOOK_INGRESS_MASTER_KEY and OUTBOUND_WEBHOOK_MASTER_KEY must not be the same value",
            );
        }
        None
    }

    /// True while either key is still the D2(a) copy of the app JWT secret.
    /// Not an error — a nudge, and the only thing that reads it is a log line
    /// and a doctor record. **Never** returns or logs the value itself.
    pub fn reuses_jwt_secret(&self, jwt_secret: &str) -> bool {
        self.ingress_master_key == jwt_secret || self.outbound_master_key == jwt_secret
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

        // ADR-0004 증보 4 (#2066). Absent keys are fatal (the error names the
        // backfill command), an inter-key collision is fatal, and the D2(a)
        // migration window — either key still a copy of JWT_HMAC — boots with a
        // single warning that names no value.
        let webhook = WebhookSettings::from_env()?;
        if let Some(message) = webhook.boot_error(&jwt_secret) {
            return Err(ConfigError::InvalidSecurity(message));
        }
        if webhook.reuses_jwt_secret(&jwt_secret) {
            tracing::warn!(
                "webhook 마스터키가 JWT 시크릿과 같다 (ADR-0004 증보 4 D2(a) 이행 창) — \
회전을 권고한다: docs/SELF_HOST.md §시크릿 회전. 회전하면 발급된 webhook secret 은 재발급이 필요하다."
            );
        }

        // B4.2: the only settings misconfiguration worth refusing a boot over.
        // A *missing* provider master key closes the surface (503); a *reused*
        // one silently merges two blast radii, so it is fatal here rather than
        // discovered after a leak.
        let settings = SettingsConfig::from_env();
        let cohosted = CohostedAgentConfig::from_env();
        let login_relay = LoginRelayConfig::from_env();
        if let Some(message) = settings.boot_error(&jwt_secret, &webhook) {
            return Err(ConfigError::InvalidSecurity(message));
        }
        // ADR-0205 D1 (#3947): the GitHub App key is an independent root. Absent is fine (503);
        // a key shared with JWT / provider link / either webhook root refuses the boot.
        let github = GithubAppSettings::from_env();
        if let Some(message) = github.boot_error(
            &jwt_secret,
            &webhook,
            settings.provider_link_master_key.as_deref(),
        ) {
            return Err(ConfigError::InvalidSecurity(message));
        }

        // ADR-0151: the one Drive misconfiguration that is fatal — see
        // [`DriveSettings::boot_error`] for why a *missing* archive is not.
        let drive = DriveSettings::from_env();
        if let Some(message) = drive.boot_error(&environment) {
            return Err(ConfigError::InvalidSecurity(message));
        }

        let (turn, turn_ttl_clamped_from) = turn_policy_from_env();

        // ADR-0146 개정 (#3022): a signature requirement nobody can meet.
        let device_keys = DeviceKeySettings::from_env();
        if let Some(message) = device_keys.boot_error() {
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
            github,
            cohosted,
            login_relay,
            rate_limit: RateLimitConfig::from_env(),
            agent_port: AgentPortConfig::from_env()?,
            // ADR-0216 D9: never fatal and never off — a bad value keeps the default.
            dev_access: DevAccessConfig::from_env(),
            mentions: MentionSettings::from_env(),
            scheduler: SchedulerSettings::from_env(),
            attachment_reclaim: AttachmentReclaimSettings::from_env(),
            device_keys,
            cloud_box: CloudBoxConfig::from_env(),
            // ADR-0149: never fatal. An instance that was not given the
            // Centrifugo publish credential keeps 휘발 신호 off and answers 503
            // on the two routes — the same posture as every other subsystem
            // here, and byte-for-byte today's behaviour for a deployment that
            // does not update its env block.
            ephemeral: EphemeralSettings::from_env(),
            // #1222 / ADR-0004 증보 4: validated above, because unlike every
            // other subsystem here an absent value cannot mean "closed" — a
            // webhook secret is *derived*, so a defaulted key silently changes
            // credentials that are already in the field.
            webhook,
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

    /// ADR-0162 증보 5 G5 (#3857): the in-place grant door is on by default and
    /// only an exact `true` (or nothing) keeps it on.
    #[test]
    fn the_in_place_grant_switch_is_on_by_default_and_any_other_value_closes_it() {
        assert!(MentionSettings::default().hosted_inplace_grant_enabled);
        for on in [None, Some(""), Some("  "), Some("true"), Some(" true\n")] {
            assert!(hosted_inplace_grant_switch_on(on), "{on:?}");
        }
        for off in [
            Some("false"),
            Some("0"),
            Some("off"),
            Some("True"),
            Some("yes"),
        ] {
            assert!(!hosted_inplace_grant_switch_on(off), "{off:?}");
        }
    }

    /// ADR-0186 증보 v5 U-d (#4704 PR B, L6): each `MOMO_AGENT_INITIATIVE_*` variable feeds **its own**
    /// number and nothing else, under the names the runbook gives — a swapped or misspelled name would
    /// be an operator's setting silently ignored, which the pure parser's own test cannot see.
    #[test]
    fn each_initiative_variable_sets_its_own_number_under_the_name_the_runbook_gives() {
        use std::collections::HashMap;
        let defaults = momo_agent::initiative::InitiativeLimits::default();
        let limits = |set: &[(&str, &str)]| {
            let set: HashMap<String, String> = set
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect();
            initiative_limits_from(|name| set.get(name).cloned())
        };
        assert_eq!(limits(&[]), defaults, "nothing set: the defaults");
        // One at a time: the other two stay what they were.
        let hour = limits(&[("MOMO_AGENT_INITIATIVE_PER_HOUR", "3")]);
        assert_eq!(
            (hour.per_hour, hour.per_day, hour.ttl_seconds),
            (3, defaults.per_day, defaults.ttl_seconds)
        );
        let day = limits(&[("MOMO_AGENT_INITIATIVE_PER_DAY", "50")]);
        assert_eq!(
            (day.per_hour, day.per_day, day.ttl_seconds),
            (defaults.per_hour, 50, defaults.ttl_seconds)
        );
        let ttl = limits(&[("MOMO_AGENT_INITIATIVE_TTL_HOURS", "48")]);
        assert_eq!(
            (ttl.per_hour, ttl.per_day, ttl.ttl_seconds),
            (defaults.per_hour, defaults.per_day, 48 * 3600)
        );
        // And the range is applied to what the operator wrote, not only in the parser's own test.
        let wild = limits(&[
            ("MOMO_AGENT_INITIATIVE_PER_HOUR", "0"),
            ("MOMO_AGENT_INITIATIVE_PER_DAY", "100000"),
            ("MOMO_AGENT_INITIATIVE_TTL_HOURS", "banana"),
        ]);
        assert_eq!((wild.per_hour, wild.per_day), (1, 240));
        assert_eq!(
            wild.ttl_seconds, defaults.ttl_seconds,
            "not a number: the default"
        );
        // The names themselves are pinned, so renaming one is a deliberate act: the runbook and the
        // ADR spell exactly these, and an operator's environment file has them by heart.
        assert_eq!(
            INITIATIVE_LIMIT_VARIABLES,
            [
                "MOMO_AGENT_INITIATIVE_PER_HOUR",
                "MOMO_AGENT_INITIATIVE_PER_DAY",
                "MOMO_AGENT_INITIATIVE_TTL_HOURS"
            ]
        );
    }

    /// #4443: the api process's reclaim tick reads the notifier's variable names with the
    /// notifier's defaults, and — like the notifier — deletes only on the exact text `1`.
    #[test]
    fn the_attachment_reclaim_tick_ships_off_and_reads_the_notifiers_names() {
        let default = AttachmentReclaimSettings::default();
        assert!(!default.delete_enabled, "ships off");
        assert_eq!(default.interval_ms, 600_000);
        assert_eq!(default.batch, 50);

        assert_eq!(parse_attachment_reclaim_interval_ms(None), 600_000);
        assert_eq!(
            parse_attachment_reclaim_interval_ms(Some("5")),
            10_000,
            "floor 10 s"
        );
        assert_eq!(parse_attachment_reclaim_interval_ms(Some("60000")), 60_000);
        assert_eq!(
            parse_attachment_reclaim_interval_ms(Some("soon")),
            600_000,
            "a typo keeps the default"
        );
        assert_eq!(parse_attachment_reclaim_batch(None), 50);
        assert_eq!(parse_attachment_reclaim_batch(Some("0")), 1, "at least one");
        assert_eq!(
            parse_attachment_reclaim_batch(Some("9999")),
            500,
            "at most 500"
        );
        assert_eq!(parse_attachment_reclaim_batch(Some("lots")), 50);

        // The variable the operator sets is the one that reaches `delete_enabled` (the line that
        // decides whether this process deletes files), through the same parser `from_env` uses.
        let with_switch = |switch: Option<&'static str>| {
            AttachmentReclaimSettings::from_lookup(&|key: &str| {
                (key == "MOMO_ATTACHMENT_RECLAIM")
                    .then(|| switch.map(str::to_string))
                    .flatten()
            })
        };
        assert!(!with_switch(None).delete_enabled, "nothing set: off");
        assert!(with_switch(Some("1")).delete_enabled);
        for near_miss in ["0", "true", "yes", " 1", "01", "on"] {
            assert!(
                !with_switch(Some(near_miss)).delete_enabled,
                "{near_miss:?} leaves it off"
            );
        }
        let tuned = AttachmentReclaimSettings::from_lookup(&|key: &str| match key {
            "MOMO_ATTACHMENT_RECLAIM_INTERVAL_MS" => Some("60000".to_string()),
            "MOMO_ATTACHMENT_RECLAIM_BATCH" => Some("7".to_string()),
            _ => None,
        });
        assert_eq!((tuned.interval_ms, tuned.batch), (60_000, 7));
        assert!(
            !tuned.delete_enabled,
            "tuning the cadence does not turn the delete on"
        );

        // The one switch: only the exact text `1` (the messaging crate's definition).
        for near_miss in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some("yes"),
            Some(" 1"),
            Some("01"),
        ] {
            assert!(
                !momo_messaging::attachment_reclaim::delete_switch_is_on(near_miss),
                "{near_miss:?}"
            );
        }
        assert!(momo_messaging::attachment_reclaim::delete_switch_is_on(
            Some("1")
        ));
    }

    /// ADR-0208 D15 — four optional knobs, every one with a default, none required.
    #[test]
    fn the_scheduler_knobs_default_to_the_adr_and_clamp_to_its_ranges() {
        let default = SchedulerSettings::default();
        assert!(default.enabled);
        assert_eq!(default.tick_ms, 5000);
        assert_eq!(default.batch, 100);
        assert_eq!(default.grace_seconds, 3600);

        // Unset / blank = on; "0" is how an operator turns it off; a value that is not
        // clearly "on" is off (visible as a 503, never a silent accept).
        for on in [
            None,
            Some(""),
            Some("  "),
            Some("1"),
            Some("true"),
            Some("TRUE"),
            Some("on"),
            Some("Yes"),
        ] {
            assert!(parse_scheduler_enabled(on), "{on:?}");
        }
        for off in [
            Some("0"),
            Some("false"),
            Some("off"),
            Some("no"),
            Some("disabled"),
            Some("2"),
        ] {
            assert!(!parse_scheduler_enabled(off), "{off:?}");
        }

        assert_eq!(parse_scheduler_tick_ms(None), 5000);
        assert_eq!(parse_scheduler_tick_ms(Some("250")), 1000, "floor 1 s");
        assert_eq!(parse_scheduler_tick_ms(Some("1000")), 1000);
        assert_eq!(parse_scheduler_tick_ms(Some("12000")), 12000);
        assert_eq!(
            parse_scheduler_tick_ms(Some("soon")),
            5000,
            "a typo keeps the default"
        );

        assert_eq!(parse_scheduler_batch(None), 100);
        assert_eq!(parse_scheduler_batch(Some("0")), 1);
        assert_eq!(parse_scheduler_batch(Some("500")), 200);
        assert_eq!(parse_scheduler_batch(Some("64")), 64);
        assert_eq!(parse_scheduler_batch(Some("many")), 100);

        assert_eq!(parse_scheduler_grace_seconds(None), 3600);
        assert_eq!(
            parse_scheduler_grace_seconds(Some("60")),
            300,
            "five minutes at least"
        );
        assert_eq!(
            parse_scheduler_grace_seconds(Some("999999")),
            86400,
            "a day at most"
        );
        assert_eq!(parse_scheduler_grace_seconds(Some("1800")), 1800);
        assert_eq!(parse_scheduler_grace_seconds(Some("an hour")), 3600);
    }

    /// #3022: the requirement is off by default, and turning it on without the
    /// instance id every signed statement carries is refused at boot.
    #[test]
    fn device_key_settings_default_off_and_refuse_an_unsatisfiable_requirement() {
        let default = DeviceKeySettings::default();
        assert!(!default.host_register_signature_required);
        assert!(
            !default.refresh_reuse_sweep_all_sessions,
            "password sign-ins are not swept until the web client coordinates tabs"
        );
        assert_eq!(default.boot_error(), None);
        assert!(
            !default.human_control_signature_required,
            "ADR-0146 D-11: signed instructions stay optional until R1 and R2 PASS"
        );
        assert_eq!(
            default.refresh_proof_mode,
            RefreshProofMode::Observe,
            "#3079: proofs are honored but not required until the clients ship"
        );
        let garbled = DeviceKeySettings {
            refresh_proof_mode_invalid: true,
            ..DeviceKeySettings::default()
        };
        assert!(garbled.boot_error().is_some());
        let unsatisfiable = DeviceKeySettings {
            instance_id: None,
            host_register_signature_required: true,
            ..DeviceKeySettings::default()
        };
        assert!(unsatisfiable.boot_error().is_some());
        let unsatisfiable_control = DeviceKeySettings {
            instance_id: None,
            human_control_signature_required: true,
            ..DeviceKeySettings::default()
        };
        assert!(unsatisfiable_control.boot_error().is_some());
        let on = DeviceKeySettings {
            instance_id: Some("inst_a".into()),
            host_register_signature_required: true,
            human_control_signature_required: true,
            ..DeviceKeySettings::default()
        };
        assert_eq!(on.boot_error(), None);
        let smuggled = DeviceKeySettings {
            instance_id: Some("inst\nb".into()),
            ..DeviceKeySettings::default()
        };
        assert!(smuggled.boot_error().is_some());
        let oversized = DeviceKeySettings {
            instance_id: Some("i".repeat(257)),
            ..DeviceKeySettings::default()
        };
        assert!(oversized.boot_error().is_some());
    }

    #[test]
    fn cloud_box_gate_is_closed_unless_exactly_true() {
        assert!(!CloudBoxConfig::default().enabled);
        assert!(!cloud_box_gate_open(None));
        for closed in ["", "false", "0", "1", "yes", "True", "TRUE", "on", "tru"] {
            assert!(
                !cloud_box_gate_open(Some(closed)),
                "{closed:?} must stay closed"
            );
        }
        assert!(cloud_box_gate_open(Some("true")));
        assert!(cloud_box_gate_open(Some(" true\n")));
    }

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

    /// ADR-0193 D6 (#2815). On by default; only unset/blank or an exact `true`
    /// keep it on, so a typo in the kill value still kills.
    #[test]
    fn the_subscription_kill_switch_is_on_by_default_and_any_other_value_turns_it_off() {
        assert!(
            AgentPortConfig::default().subscription_agents_enabled,
            "the shipped default is on"
        );
        for on in [None, Some(""), Some("  "), Some("true"), Some(" true\n")] {
            assert!(subscription_agents_switch_on(on), "{on:?}");
        }
        for off in [
            Some("false"),
            Some("False"),
            Some("FALSE"),
            Some("0"),
            Some("off"),
            Some("no"),
            Some("True"),
            Some("1"),
            Some("ture"),
            Some("fasle"),
        ] {
            assert!(!subscription_agents_switch_on(off), "{off:?}");
        }
    }

    /// #3397 결재. Off by default; only an exact `true` opens it.
    #[test]
    fn the_claude_subscription_opt_in_is_off_by_default_and_only_an_exact_true_opens_it() {
        assert!(!AgentPortConfig::default().claude_subscription_agents_enabled);
        for on in [Some("true"), Some(" true\n")] {
            assert!(claude_subscription_agents_switch_on(on), "{on:?}");
        }
        for off in [
            None,
            Some(""),
            Some("false"),
            Some("True"),
            Some("1"),
            Some("yes"),
            Some("ture"),
        ] {
            assert!(!claude_subscription_agents_switch_on(off), "{off:?}");
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
        assert_eq!(defaults.password_change_per_member_limit, 10);
        assert_eq!(defaults.password_change_per_ip_limit, 30);
        assert_eq!(defaults.password_guess_per_account_limit, 5);
        assert!(
            defaults.per_ip_limit > 0,
            "a default of 0 would ship the public join route unguarded"
        );
        assert!(
            defaults.claim_per_ip_limit > 0,
            "a default of 0 would ship the public claim route unguarded"
        );
        assert!(
            defaults.password_change_per_member_limit > 0,
            "a default of 0 would ship PATCH …/me/password unguarded"
        );
        assert!(
            defaults.password_guess_per_account_limit > 0,
            "a default of 0 would ship the join door's password check unbudgeted"
        );
    }

    /// The per-account password-guess knob (#4625): its own env name, moves only its
    /// own field, and — unlike every other knob here — has no off switch.
    #[test]
    fn the_password_guess_knob_is_named_moves_only_itself_and_cannot_be_switched_off() {
        let lookup = |name: &'static str, value: &'static str| {
            move |key: &str| (key == name).then(|| value.to_string())
        };
        let defaults = RateLimitConfig::default();
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_PASSWORD_GUESS_PER_ACCOUNT", " 3 ")),
            RateLimitConfig {
                password_guess_per_account_limit: 3,
                ..defaults
            },
            "the documented name moves exactly its own field, whitespace trimmed"
        );
        for refused in ["0", "many", "-1", ""] {
            assert_eq!(
                RateLimitConfig::from_lookup(lookup(
                    "RATE_LIMIT_PASSWORD_GUESS_PER_ACCOUNT",
                    refused
                )),
                defaults,
                "{refused:?} must keep the default: a guessable surface has no off value"
            );
        }
        // the other password knob does not leak into this one
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_PASSWORD_CHANGE_PER_MEMBER", "2"))
                .password_guess_per_account_limit,
            defaults.password_guess_per_account_limit
        );
    }

    // -- #4820 C2a security review (L7): the photo address's own budget ------------------

    /// The photo address has a budget of its own: its env name moves only its own field (not the
    /// claim budget it used to borrow, and not the other way round), 0 is the operator's off switch
    /// and not a number keeps the default. The default stays at the 30 the claim budget had, so a
    /// route that was fine before is fine now.
    #[test]
    fn the_photo_address_budget_is_its_own_knob() {
        let lookup = |name: &'static str, value: &'static str| {
            move |key: &str| (key == name).then(|| value.to_string())
        };
        let defaults = RateLimitConfig::default();
        assert_eq!(defaults.self_media_per_workspace_limit, 30);
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE", " 5 ")),
            RateLimitConfig {
                self_media_per_workspace_limit: 5,
                ..defaults
            },
            "its own name moves its own field, whitespace trimmed like every knob"
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_CLAIM_PER_IP", "7")),
            RateLimitConfig {
                claim_per_ip_limit: 7,
                ..defaults
            },
            "the claim budget no longer moves the photo address's"
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE", "0"))
                .self_media_per_workspace_limit,
            0
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE", "many")),
            defaults,
            "an unparseable value keeps the default instead of switching the axis off"
        );
    }

    // -- #4234 per-member write budget ------------------------------------------

    /// The member-write defaults are not free parameters: each is pinned against the
    /// number it must not undercut, so a later "tighten it" edit that turns ordinary
    /// use into a 429 fails here first (the same discipline as the ephemeral limits
    /// below). The derivations are in ADR-0208 D10 증보.
    #[test]
    fn the_member_write_defaults_admit_ordinary_use_with_headroom() {
        let defaults = RateLimitConfig::default();
        // The numbers ADR-0208 증보 1, the openapi `RateLimited` response and `.env.example`
        // quote, pinned by value: the relations below leave room, so without this a default could
        // move and leave those documents saying something else (sabotage E22/E35-E37).
        assert_eq!(
            (
                defaults.message_send_per_member_limit,
                defaults.message_send_per_agent_limit,
                defaults.scheduled_write_per_member_limit,
                defaults.upload_start_per_member_limit,
                defaults.unfurl_proxy_per_member_limit,
                defaults.unfurl_preview_per_member_limit,
            ),
            (120, 600, 60, 60, 240, 60),
            "a default changed: update ADR-0208 증보 1 (ADR-0170 증보 D13 and 2026-11-01 D20 for the last two), docs/api/openapi.yaml and infra/.env.example with it"
        );
        for (name, limit) in [
            (
                "message send, human",
                defaults.message_send_per_member_limit,
            ),
            ("message send, agent", defaults.message_send_per_agent_limit),
            ("scheduled write", defaults.scheduled_write_per_member_limit),
            ("upload start", defaults.upload_start_per_member_limit),
            ("unfurl proxy", defaults.unfurl_proxy_per_member_limit),
            ("unfurl preview", defaults.unfurl_preview_per_member_limit),
        ] {
            assert!(
                limit > 0,
                "a default of 0 would ship the {name} surface unguarded"
            );
        }
        assert!(
            i64::from(defaults.scheduled_write_per_member_limit)
                >= momo_messaging::SCHEDULE_PENDING_LIMIT,
            "filling the whole pending cap must not be refused by the rate before it meets the cap"
        );
        assert!(
            defaults.upload_start_per_member_limit as usize
                >= 2 * momo_messaging::MAX_ATTACHMENTS_PER_MESSAGE,
            "two full messages' worth of attachment uploads must fit in one window"
        );
        assert!(
            defaults.message_send_per_agent_limit >= AgentPortConfig::default().per_agent_limit,
            "a REST-only adapter must not be throttled harder than the MCP path that does the same job"
        );
        assert!(
            defaults.message_send_per_agent_limit > defaults.message_send_per_member_limit,
            "an agent's tool-result bursts are the reason the agent budget is the larger one"
        );
    }

    /// Every env name is the documented one and moves only its own field. A misspelt
    /// name would otherwise fall back to its default without a word, which is the way
    /// a knob stops working in production while looking configured.
    #[test]
    fn the_member_write_env_names_move_exactly_their_own_field() {
        let lookup = |name: &'static str, value: &'static str| {
            move |key: &str| (key == name).then(|| value.to_string())
        };
        let defaults = RateLimitConfig::default();
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_MESSAGE_SEND_PER_MEMBER", "7")),
            RateLimitConfig {
                message_send_per_member_limit: 7,
                ..defaults
            }
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_MESSAGE_SEND_PER_AGENT", "8")),
            RateLimitConfig {
                message_send_per_agent_limit: 8,
                ..defaults
            }
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_SCHEDULED_WRITE_PER_MEMBER", "9")),
            RateLimitConfig {
                scheduled_write_per_member_limit: 9,
                ..defaults
            }
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_UPLOAD_START_PER_MEMBER", " 11 ")),
            RateLimitConfig {
                upload_start_per_member_limit: 11,
                ..defaults
            },
            "surrounding whitespace is trimmed, as for every other knob"
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_UNFURL_PROXY_PER_MEMBER", "13")),
            RateLimitConfig {
                unfurl_proxy_per_member_limit: 13,
                ..defaults
            }
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_UNFURL_PREVIEW_PER_MEMBER", "7")),
            RateLimitConfig {
                unfurl_preview_per_member_limit: 7,
                ..defaults
            },
            "the preview name moves the preview field and nothing else"
        );
        // 0 is the operator's off switch; a value that is not a number is not one.
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_MESSAGE_SEND_PER_AGENT", "0"))
                .message_send_per_agent_limit,
            0
        );
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_MESSAGE_SEND_PER_AGENT", "many")),
            defaults,
            "an unparseable value keeps the default instead of switching the axis off"
        );
        // the Swift global name stays unread: it is not a knob on this server
        assert_eq!(
            RateLimitConfig::from_lookup(lookup("RATE_LIMIT_PER_MEMBER", "1")),
            defaults
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

    #[test]
    fn local_base_is_inert_unless_the_backend_is_local() {
        let google = DriveSettings {
            backend: "google".into(),
            ..DriveSettings::default()
        };
        assert_eq!(
            google.local_base(8080, "http://127.0.0.1:8080"),
            crate::DriveLocalBase::Fixed(String::new())
        );
        let stub = DriveSettings {
            backend: momo_drive::STUB_BACKEND.into(),
            ..DriveSettings::default()
        };
        assert_eq!(
            stub.local_base(8080, "http://127.0.0.1:8080"),
            crate::DriveLocalBase::Fixed(String::new())
        );
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

    // -- ADR-0004 증보 4 / #2066 ------------------------------------------

    /// `WebhookSettings::from_env` and the `Config::from_env` that wraps it are
    /// the only readers of these two variables in the whole binary, so a lock
    /// held across the set/read/restore is enough to make them deterministic.
    static WEBHOOK_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn webhook(ingress: &str, outbound: &str) -> WebhookSettings {
        WebhookSettings {
            ingress_master_key: ingress.to_string(),
            outbound_master_key: outbound.to_string(),
            ..WebhookSettings::default()
        }
    }

    #[test]
    fn a_webhook_master_key_has_no_fallback_and_an_absent_one_refuses_the_boot() {
        let guard = WEBHOOK_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let restore: Vec<(&str, Option<String>)> =
            ["WEBHOOK_INGRESS_MASTER_KEY", "OUTBOUND_WEBHOOK_MASTER_KEY"]
                .iter()
                .map(|key| (*key, std::env::var(key).ok()))
                .collect();

        // Absent.
        std::env::remove_var("WEBHOOK_INGRESS_MASTER_KEY");
        std::env::remove_var("OUTBOUND_WEBHOOK_MASTER_KEY");
        assert!(
            matches!(
                WebhookSettings::from_env(),
                Err(ConfigError::MissingWebhookMasterKey(
                    "WEBHOOK_INGRESS_MASTER_KEY"
                ))
            ),
            "an absent ingress master key must refuse the boot, not fall back to JWT_HMAC"
        );

        // Present but empty — compose passes these with the optional `${VAR:-}`
        // form, so "" is how an un-backfilled install actually arrives.
        std::env::set_var("WEBHOOK_INGRESS_MASTER_KEY", "   ");
        assert!(
            matches!(
                WebhookSettings::from_env(),
                Err(ConfigError::MissingWebhookMasterKey(
                    "WEBHOOK_INGRESS_MASTER_KEY"
                ))
            ),
            "an empty ingress master key is absence, not a key"
        );

        std::env::set_var("WEBHOOK_INGRESS_MASTER_KEY", "ingress-key");
        assert!(
            matches!(
                WebhookSettings::from_env(),
                Err(ConfigError::MissingWebhookMasterKey(
                    "OUTBOUND_WEBHOOK_MASTER_KEY"
                ))
            ),
            "the outbound key is required on its own terms"
        );

        std::env::set_var("OUTBOUND_WEBHOOK_MASTER_KEY", "outbound-key");
        let settings = WebhookSettings::from_env().expect("both keys present");
        assert_eq!(settings.ingress_master_key, "ingress-key");
        assert_eq!(settings.outbound_master_key, "outbound-key");

        for (key, value) in restore {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        drop(guard);
    }

    #[test]
    fn the_missing_key_sentence_names_the_backfill_and_no_value() {
        let rendered =
            ConfigError::MissingWebhookMasterKey("OUTBOUND_WEBHOOK_MASTER_KEY").to_string();
        assert!(rendered.contains("OUTBOUND_WEBHOOK_MASTER_KEY"));
        assert!(
            rendered.contains("scripts/oort upgrade") && rendered.contains("--ensure-managed-keys"),
            "fail-closed is only humane when the sentence carries the next action: {rendered}"
        );
    }

    #[test]
    fn the_d2a_migration_window_boots_and_says_so_without_naming_a_value() {
        // What the backfill writes: both keys are an explicit copy of JWT_HMAC.
        let migrating = webhook("jwt-secret", "jwt-secret");
        assert_eq!(
            migrating.boot_error("jwt-secret"),
            None,
            "refusing the copy the backfill just wrote would take down every upgrading install"
        );
        assert!(migrating.reuses_jwt_secret("jwt-secret"));

        // Half-rotated is still a copy of a value in use, not a new blast radius.
        let half = webhook("jwt-secret", "rotated-outbound");
        assert_eq!(half.boot_error("jwt-secret"), None);
        assert!(half.reuses_jwt_secret("jwt-secret"));

        // Fully rotated: nothing to nudge about.
        let rotated = webhook("rotated-ingress", "rotated-outbound");
        assert_eq!(rotated.boot_error("jwt-secret"), None);
        assert!(!rotated.reuses_jwt_secret("jwt-secret"));
    }

    #[test]
    fn two_rotated_webhook_keys_that_landed_on_one_value_refuse_the_boot() {
        let merged = webhook("same-rotated-key", "same-rotated-key");
        assert_eq!(
            merged.boot_error("jwt-secret"),
            Some(
                "WEBHOOK_INGRESS_MASTER_KEY and OUTBOUND_WEBHOOK_MASTER_KEY must not be the same value"
            )
        );
    }

    #[test]
    fn the_provider_master_key_may_reuse_neither_webhook_key() {
        let settings = |key: &str| SettingsConfig {
            provider_link_master_key: Some(key.to_string()),
            ..SettingsConfig::default()
        };
        let keys = webhook("ingress-key", "outbound-key");

        assert_eq!(
            settings("ingress-key").boot_error("jwt-secret", &keys),
            Some("PROVIDER_LINK_MASTER_KEY must not reuse WEBHOOK_INGRESS_MASTER_KEY")
        );
        assert_eq!(
            settings("outbound-key").boot_error("jwt-secret", &keys),
            Some("PROVIDER_LINK_MASTER_KEY must not reuse OUTBOUND_WEBHOOK_MASTER_KEY")
        );
        assert_eq!(
            settings("jwt-secret").boot_error("jwt-secret", &keys),
            Some("PROVIDER_LINK_MASTER_KEY must not reuse JWT_HMAC")
        );
        assert_eq!(
            settings("its-own-key").boot_error("jwt-secret", &keys),
            None
        );
    }

    /// ADR-0205 D1 / acceptance 8: the GitHub key may reuse none of the other four roots.
    #[test]
    fn the_github_app_master_key_may_reuse_no_other_root() {
        let github = |key: &str| GithubAppSettings {
            master_key: Some(key.to_string()),
        };
        let keys = webhook("ingress-key", "outbound-key");
        let provider = Some("provider-key");

        assert_eq!(
            github("jwt-secret").boot_error("jwt-secret", &keys, provider),
            Some("GITHUB_APP_MASTER_KEY must not reuse JWT_HMAC")
        );
        assert_eq!(
            github("outbound-key").boot_error("jwt-secret", &keys, provider),
            Some("GITHUB_APP_MASTER_KEY must not reuse OUTBOUND_WEBHOOK_MASTER_KEY")
        );
        assert_eq!(
            github("ingress-key").boot_error("jwt-secret", &keys, provider),
            Some("GITHUB_APP_MASTER_KEY must not reuse WEBHOOK_INGRESS_MASTER_KEY")
        );
        assert_eq!(
            github("provider-key").boot_error("jwt-secret", &keys, provider),
            Some("GITHUB_APP_MASTER_KEY must not reuse PROVIDER_LINK_MASTER_KEY")
        );
        assert_eq!(
            github("its-own-key").boot_error("jwt-secret", &keys, provider),
            None
        );
        // No provider key configured: nothing to collide with, and the others still apply.
        assert_eq!(
            github("its-own-key").boot_error("jwt-secret", &keys, None),
            None
        );
    }

    /// Absence closes the GitHub surface; it never refuses a boot.
    #[test]
    fn an_absent_github_app_master_key_is_not_a_boot_error() {
        let keys = webhook("ingress-key", "outbound-key");
        assert_eq!(
            GithubAppSettings::default().boot_error("jwt-secret", &keys, Some("provider-key")),
            None
        );
        let rendered = format!(
            "{:?}",
            GithubAppSettings {
                master_key: Some("super-secret-github-key".to_string())
            }
        );
        assert!(rendered.contains("master_key_configured: true"));
        assert!(!rendered.contains("super-secret"), "{rendered}");
    }

    #[test]
    fn the_debug_rendering_reports_presence_and_never_a_key() {
        let rendered = format!("{:?}", webhook("ingress-key", "outbound-key"));
        assert!(rendered.contains("ingress_master_key_configured: true"));
        assert!(rendered.contains("outbound_master_key_configured: true"));
        assert!(
            !rendered.contains("ingress-key") && !rendered.contains("outbound-key"),
            "a master key reached a Debug rendering: {rendered}"
        );
    }

    /// #2960 / review M2: the probe's egress policy mirrors the worker's and
    /// the write gate's — the operator opt-in holds in a strict environment
    /// (ADR-0004 증보 2026-09-08), and without the opt-in the address is refused.
    #[test]
    fn the_probe_policy_mirrors_the_worker_including_strict_environments() {
        use std::net::IpAddr;
        let fake_env = |allow_local: bool| momo_settings::EgressPolicy {
            allow_local,
            local_hosts: vec!["llm.internal".into()],
            operator_hosts: Vec::new(),
        };
        let internal: [IpAddr; 1] = ["10.0.0.5".parse().unwrap()];
        let mut settings = SettingsConfig {
            environment: "staging".into(),
            ..Default::default()
        };
        settings.env_provider.base_url = "http://mock-hermes:8088/v1".into();

        settings.env_provider.allow_local_loopback = true;
        let opted_in = provider_probe_policy(&settings, false, fake_env);
        assert!(
            opted_in.check_resolved("llm.internal", &internal).is_ok(),
            "staging + opt-in: the listed host is checked, not refused"
        );
        assert!(
            opted_in.operator_hosts.is_empty(),
            "HERMES_BASE_URL unset: no trust"
        );
        let with_env = provider_probe_policy(&settings, true, fake_env);
        assert_eq!(with_env.operator_hosts, vec!["mock-hermes".to_string()]);

        settings.env_provider.allow_local_loopback = false;
        let not_opted_in = provider_probe_policy(&settings, false, fake_env);
        assert!(
            not_opted_in
                .check_resolved("llm.internal", &internal)
                .is_err(),
            "staging without the opt-in: refused"
        );
    }

    // ----- AgentPortOauthConfig: the human-subject arm (ADR-0216 D6 나) ---------

    fn oauth_lookup(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<&'static str, &'static str> =
            pairs.iter().copied().collect();
        move |key: &str| map.get(key).map(|value| (*value).to_string())
    }

    const OAUTH_ISSUER: (&str, &str) = ("MOMO_AGENT_PORT_OAUTH_ISSUER", "https://oort.example");
    const DEV_ON: (&str, &str) = ("MOMO_DEV_LOGIN_OAUTH_ENABLED", "true");
    const DEV_CONSENT: (&str, &str) = (
        "MOMO_DEV_LOGIN_OAUTH_CONSENT_URL",
        "https://oort.example/oauth/cli",
    );
    const HOSTED_ON: (&str, &str) = ("MOMO_AGENT_PORT_OAUTH_ENABLED", "true");
    const HOSTED_CONSENT: (&str, &str) = (
        "MOMO_AGENT_PORT_OAUTH_CONSENT_URL",
        "https://oort.example/oauth/consent",
    );
    const HOSTED_CLIENTS: (&str, &str) = (
        "MOMO_AGENT_PORT_OAUTH_CLIENTS",
        "some-client=https://client.example/cb",
    );

    #[test]
    fn the_oauth_server_stays_closed_unless_an_arm_is_opted_in_with_exactly_true() {
        for spelling in ["True", "1", "yes", "TRUE", "false", " "] {
            let config = AgentPortOauthConfig::from_lookup(|key| match key {
                "MOMO_DEV_LOGIN_OAUTH_ENABLED" | "MOMO_AGENT_PORT_OAUTH_ENABLED" => {
                    Some(spelling.to_string())
                }
                "MOMO_AGENT_PORT_OAUTH_ISSUER" => Some("https://oort.example".to_string()),
                _ => None,
            })
            .expect("a closed server needs no other variable");
            assert_eq!(config, AgentPortOauthConfig::default(), "{spelling:?}");
            assert!(!config.dev_login_enabled() && !config.is_enabled());
            assert_eq!(config.server_issuer(), None);
        }
    }

    #[test]
    fn the_developer_login_arm_opens_alone_without_opening_any_hosted_surface() {
        let config =
            AgentPortOauthConfig::from_lookup(oauth_lookup(&[OAUTH_ISSUER, DEV_ON, DEV_CONSENT]))
                .expect("the dev arm needs only the shared issuer and its own consent URL");
        assert!(config.dev_login_enabled());
        assert_eq!(config.dev_login_issuer(), Some("https://oort.example"));
        assert_eq!(
            config.dev_login_consent_url(),
            Some("https://oort.example/oauth/cli")
        );
        assert_eq!(
            config.dev_login_resource().as_deref(),
            Some("https://oort.example/v1/mcp/me")
        );
        assert_eq!(config.server_issuer(), Some("https://oort.example"));
        // The hosted accessors keep their pre-existing meaning: they answer for the
        // hosted arm only, so the dev arm cannot advertise the hosted resource.
        assert!(!config.is_enabled());
        assert_eq!(config.issuer(), None);
        assert_eq!(config.consent_url(), None);
        assert_eq!(config.resource(), None);
        assert_eq!(config.endpoint("/v1/oauth/token"), None);
        assert!(config.client("oort-cli").is_none());
    }

    #[test]
    fn each_arm_demands_the_values_it_needs_and_a_missing_one_refuses_to_boot() {
        // The dev arm without the shared issuer, or without its own consent URL.
        assert!(AgentPortOauthConfig::from_lookup(oauth_lookup(&[DEV_ON, DEV_CONSENT])).is_err());
        assert!(AgentPortOauthConfig::from_lookup(oauth_lookup(&[OAUTH_ISSUER, DEV_ON])).is_err());
        // Not https, or carrying a fragment, is refused.
        for bad in [
            "http://oort.example/oauth/cli",
            "https://oort.example/oauth/cli#x",
        ] {
            let config = AgentPortOauthConfig::from_lookup(|key| match key {
                "MOMO_DEV_LOGIN_OAUTH_ENABLED" => Some("true".to_string()),
                "MOMO_AGENT_PORT_OAUTH_ISSUER" => Some("https://oort.example".to_string()),
                "MOMO_DEV_LOGIN_OAUTH_CONSENT_URL" => Some(bad.to_string()),
                _ => None,
            });
            assert!(config.is_err(), "{bad}");
        }
        // The hosted arm still demands its consent URL and at least one client.
        assert!(
            AgentPortOauthConfig::from_lookup(oauth_lookup(&[OAUTH_ISSUER, HOSTED_ON])).is_err()
        );
        assert!(AgentPortOauthConfig::from_lookup(oauth_lookup(&[
            OAUTH_ISSUER,
            HOSTED_ON,
            HOSTED_CONSENT
        ]))
        .is_err());
    }

    #[test]
    fn the_hosted_arm_alone_leaves_the_developer_arm_closed_and_both_can_be_open() {
        let hosted = AgentPortOauthConfig::from_lookup(oauth_lookup(&[
            OAUTH_ISSUER,
            HOSTED_ON,
            HOSTED_CONSENT,
            HOSTED_CLIENTS,
        ]))
        .expect("hosted arm");
        assert!(hosted.is_enabled());
        assert!(!hosted.dev_login_enabled());
        assert_eq!(hosted.dev_login_issuer(), None);
        assert_eq!(hosted.dev_login_resource(), None);
        assert_eq!(hosted.server_issuer(), Some("https://oort.example"));
        assert_eq!(
            hosted.resource().as_deref(),
            Some("https://oort.example/v1/mcp/agent-port")
        );

        let both = AgentPortOauthConfig::from_lookup(oauth_lookup(&[
            OAUTH_ISSUER,
            HOSTED_ON,
            HOSTED_CONSENT,
            HOSTED_CLIENTS,
            DEV_ON,
            DEV_CONSENT,
        ]))
        .expect("both arms");
        assert!(both.is_enabled() && both.dev_login_enabled());
        // Two audiences, never one: the resources differ.
        assert_ne!(both.resource(), both.dev_login_resource());
    }

    #[test]
    fn the_built_in_client_id_cannot_be_registered_by_an_operator() {
        assert!(parse_registered_oauth_clients("oort-cli=https://evil.example/cb").is_none());
        assert!(parse_registered_oauth_clients(
            "some-client=https://client.example/cb;oort-cli=http://127.0.0.1:24681/callback"
        )
        .is_none());
        assert!(parse_registered_oauth_clients("some-client=https://client.example/cb").is_some());
        // And through the environment grammar: the whole variable is refused.
        assert!(AgentPortOauthConfig::from_lookup(oauth_lookup(&[
            OAUTH_ISSUER,
            HOSTED_ON,
            HOSTED_CONSENT,
            (
                "MOMO_AGENT_PORT_OAUTH_CLIENTS",
                "oort-cli=https://evil.example/cb"
            ),
        ]))
        .is_err());
    }

    #[test]
    fn the_fixture_constructors_open_exactly_the_arm_they_name() {
        let dev = AgentPortOauthConfig::for_tests_dev_login(
            "https://oort.example",
            "https://oort.example/oauth/cli",
        );
        assert!(dev.dev_login_enabled() && !dev.is_enabled());
        let hosted = AgentPortOauthConfig::for_tests(
            "https://oort.example",
            "https://oort.example/oauth/consent",
            vec![RegisteredOauthClient {
                client_id: "some-client".to_string(),
                redirect_uris: vec!["https://client.example/cb".to_string()],
            }],
        );
        assert!(hosted.is_enabled() && !hosted.dev_login_enabled());
        let both = hosted.with_dev_login_for_tests("https://oort.example/oauth/cli");
        assert!(both.is_enabled() && both.dev_login_enabled());
    }
}
