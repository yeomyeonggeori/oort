//! `momo-server` — the Axum HTTP API (ADR-0145 B안, batch B1.5).
//!
//! This crate is the **orchestrator**: it mounts routers, wires middleware, and
//! translates HTTP to domain calls. It owns no SQL and no invariant of its own —
//! every invariant it touches is enforced one layer down (buzz's rule, D1 §2:
//! the server binary composes subsystems, subsystems do not call each other):
//!
//! | invariant | enforced by | this crate's part |
//! |---|---|---|
//! | #1 PG = SoT | `momo-messaging` writes to PG only | reads/writes nothing else |
//! | #2 Centrifugo = transport-only | `momo-relay` publishes the durable rail | holds **only** `momo-ephemeral`, whose whole API is `publish(&EphemeralSignal)` |
//! | #3 single write path | `momo_outbox::emit_outbox` | calls `send_message_in_tx`, never the outbox |
//! | #4 gapless seq | `channel_seq` row lock + UNIQUE | returns the authoritative `seq` |
//! | #5 agent = member | one `member` table | no agent branch in any handler |
//! | #6 RLS FORCE | `momo_db::with_tenant_tx` | opens every tenant access through it, keyed by the credential |
//!
//! **Row #2 changed with ADR-0149 (goal SRV-T2) and the change is the whole
//! cost of that decision.** Until then this crate had no HTTP client at all,
//! which made "only the relay publishes" a fact about the dependency graph. It
//! now has exactly one — `momo-ephemeral` — and the property that replaces the
//! old one is narrower but still mechanical: `reqwest` is *not* a dependency of
//! this crate, so no handler can build a request of its own, and the single
//! thing it can reach accepts a sealed [`momo_ephemeral::EphemeralSignal`]
//! rather than a channel and a JSON blob. Centrifugo is still transport-only;
//! there are simply two authors of that transport now, and neither of them can
//! be reached with arbitrary data.
//!
//! The router is a library so `tests/http_smoke_pg.rs` can boot the real app on
//! an ephemeral port; `main.rs` only reads the environment and serves.

pub mod auth;
pub mod config;
pub mod cors;
pub mod dto;
pub mod error;
mod livekit;
pub mod rate_limit;
pub mod realtime_advert;
pub mod routes;
pub mod work_host_auth;

pub use realtime_advert::{
    host_is_loopback_or_lan, requires_device_link_sas, DriveLocalBase, RealtimeAdvert,
    RealtimeAdvertError,
};

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::HeaderMap;
use axum::routing::{delete, get, patch, post, put};
use axum::Router;
use momo_db::PgPool;

use crate::config::{
    AgentGatewaySettings, AgentPortConfig, CorsConfig, EphemeralSettings, LiveKitConfig,
    MentionSettings, RateLimitConfig, RealtimeSettings, SettingsConfig, T3Settings,
    WebhookSettings,
};
use crate::error::ApiError;
use crate::rate_limit::SlidingWindowRateLimiter;

/// The MOMO-300 limiter and the knobs it reads, held together because neither is
/// useful alone. Shared across handler clones by `Arc` so the window is
/// process-wide rather than per-request.
#[derive(Debug, Default)]
pub struct RateLimitState {
    pub config: RateLimitConfig,
    pub limiter: SlidingWindowRateLimiter,
}

/// Agent Port's own bounded process-local limiter and trusted-origin config.
/// A separate state object keeps its keys and knobs out of the unauthenticated
/// join limiter, while one limiter map with `token:`/`agent:`/`ip:` prefixes
/// bounds all three Agent Port axes.
#[derive(Default)]
pub struct AgentPortState {
    pub config: AgentPortConfig,
    pub limiter: SlidingWindowRateLimiter,
    /// The key behind the two opaque Agent Port envelopes — HAP-E4's inbox
    /// cursor and HAP-E5's `leaseHandle`.
    ///
    /// It is a **secret**, so it is private and this struct's `Debug` redacts
    /// it: an `AgentPortState` reaches a `tracing` field the moment someone adds
    /// a diagnostic, and the derived formatter would have printed the key that
    /// authenticates every cursor and lease on the instance.
    ///
    /// Empty on a default state, which makes both codecs refuse rather than
    /// seal under a guessable key.
    envelope_secret: String,
}

impl std::fmt::Debug for AgentPortState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentPortState")
            .field("config", &self.config)
            .field("limiter", &self.limiter)
            .field("envelope_secret", &"<redacted>")
            .finish()
    }
}

impl AgentPortState {
    /// The Agent Port envelope key. Callers hand it straight to a codec and
    /// never log, echo or persist it.
    pub fn envelope_secret(&self) -> &str {
        &self.envelope_secret
    }
}

/// 휘발 신호 state (ADR-0149): the operator's knobs plus the one object in this
/// process that can talk to Centrifugo.
///
/// `publisher` is `None` on any instance that was not handed `CENT_API_URL` +
/// `CENT_API_KEY`, and `None` is what makes the two 휘발 routes answer 503. The
/// capability and the switch are therefore the same value — there is no way to
/// have the routes enabled without a publisher, or a publisher with no
/// credential behind it.
#[derive(Debug, Default)]
pub struct EphemeralState {
    pub settings: EphemeralSettings,
    pub publisher: Option<momo_ephemeral::EphemeralPublisher>,
}

impl EphemeralState {
    /// Build the state for `settings`, constructing the publisher only when the
    /// transport is fully configured.
    ///
    /// A publisher that fails to build (a TLS backend that will not initialise)
    /// is logged and left `None`: the surface closes, and no other route on the
    /// instance is affected by a failure in a typing indicator.
    pub fn new(settings: EphemeralSettings) -> EphemeralState {
        let publisher = settings.transport().and_then(|(url, key)| {
            match momo_ephemeral::EphemeralPublisher::new(url, key) {
                Ok(publisher) => Some(publisher),
                Err(error) => {
                    tracing::error!(%error, "ephemeral publisher unavailable; 휘발 신호 stays off");
                    None
                }
            }
        });
        EphemeralState {
            settings,
            publisher,
        }
    }
}

/// Shared handler state. Cheap to clone (pool handle + `Arc`'d strings).
#[derive(Clone)]
pub struct AppState {
    /// The api-role pool (`momo_app`, NOBYPASSRLS — the RLS policies must apply).
    pub pool: PgPool,
    /// HS256 App JWT secret. Never logged, never echoed in a response.
    pub jwt_secret: Arc<String>,
    /// Advertised realtime WebSocket endpoint (ADR-0110 / ADR-0167).
    pub realtime_ws_url: Arc<RealtimeAdvert>,
    /// T3 (momo Cloud) settings. **Off** unless [`AppState::with_t3`] says
    /// otherwise, so a deployment that never configured T3 answers 503 on every
    /// T3 route instead of half-provisioning something billable.
    pub t3: Arc<T3Settings>,
    /// The managed provisioner for [`T3Settings::default_provider_id`]
    /// (ADR-0156 D4-④). `None` on every instance that named no managed
    /// substrate — including every BYOC-only one — and `None` is what makes the
    /// managed acquisition route answer 503.
    ///
    /// It is the **only** object in this process that can create a billable
    /// instance, and its API is the [`momo_t3::CloudProvisioner`] surface: a
    /// deterministic bootstrap credential and a create. Same shape and same
    /// reason as [`EphemeralState::publisher`] — this crate still carries no
    /// `reqwest`, so no handler can build a provider request of its own
    /// (invariant #2).
    pub t3_provisioner: Option<Arc<momo_t3::CloudProvisioner>>,
    /// AgentGateway settings (B2.6). **`worker` mode** unless
    /// [`AppState::with_agent_gateway`] says otherwise, so the callback surface
    /// answers 403 on a deployment that never chose it.
    pub agent_gateway: Arc<AgentGatewaySettings>,
    /// Centrifugo connection-token / subscribe-proxy settings (B4). **Empty**
    /// unless [`AppState::with_realtime`] says otherwise, so an instance that
    /// never configured the broker refuses to mint connection tokens and denies
    /// every subscribe callback rather than half-authorizing one.
    pub realtime: Arc<RealtimeSettings>,
    /// 설정 표면 configuration (B4.2). **Empty** unless
    /// [`AppState::with_settings`] says otherwise, so an instance that never
    /// configured a provider master key answers 503 on the AI-연결 family rather
    /// than guessing at a key, and an empty `PLATFORM_ADMIN_EMAILS` grants the
    /// listed-instance-operator path to nobody.
    pub settings: Arc<SettingsConfig>,
    /// MOMO-300 per-IP limiter state (B4.3). Unlike every other field here the
    /// default is **on**, not fail-closed-off: the surfaces it guards
    /// (`POST /v1/join`, `POST /v1/claim`) are unauthenticated writes, so
    /// "the operator configured nothing" has to mean *limited*, not *open*.
    pub rate_limit: Arc<RateLimitState>,
    /// ADR-0162 Agent Port transport policy. It carries no session or product
    /// data; only trusted origin input and process-local abuse counters.
    pub agent_port: Arc<AgentPortState>,
    /// Mention→run routing knobs (B5.2). The default is the shipped one, not a
    /// disabled state: routing an `@mention` to its agent is the product, so an
    /// instance that configured nothing still does it.
    pub mentions: Arc<MentionSettings>,
    /// MOMO-605 CORS origin allowlist (ADR-0133 P2). Fail-closed-empty like the
    /// rest: an instance that named no origin mounts no CORS middleware at all,
    /// which is byte-for-byte today's behaviour.
    pub cors: Arc<CorsConfig>,
    /// 휘발 신호 (ADR-0149, goal SRV-T2). Fail-closed like the realtime family:
    /// no Centrifugo publish credential ⇒ no publisher ⇒ both 휘발 routes answer
    /// 503, which is what every deployment that has not updated its env block
    /// gets.
    pub ephemeral: Arc<EphemeralState>,
    /// ADR-0151 — the workspace Drive archive. Fail-closed like the rest: an
    /// instance that named no service-account key holds
    /// `momo_drive::UnavailableDriveArchive`, so the three attachment routes are
    /// still mounted and answer **503 "Drive archive is not configured"**. They
    /// are mounted rather than conditionally absent so a client can distinguish
    /// "this server has no archive" from "this server is too old to have the
    /// route".
    ///
    /// Typed as the trait object, not the concrete backend, and that is the
    /// whole reason the conformance suite can drive the completion route's
    /// mismatch branch: a test supplies its own archive without a test-only
    /// branch existing anywhere in the handlers.
    pub drive: Arc<dyn momo_drive::DriveArchive>,
    /// ADR-0169 증보 1 — how local-archive capability URLs are advertised.
    /// Default is Fixed-empty (no rewrite) so every existing `AppState::new`
    /// call site keeps today's URL. `with_drive_local_base` opts into
    /// same-origin derivation; google/stub never select `SameOrigin`.
    pub drive_local_base: Arc<DriveLocalBase>,
    /// ADR-0122 / HD-1 — complete LiveKit issuer settings, or no huddle
    /// capability. The routes remain mounted in both cases so clients can tell
    /// 503 "not configured" from a server too old to know the path.
    pub livekit: Option<Arc<LiveKitConfig>>,
    /// #1222 — the two webhook families' knobs. Default: no dedicated outbound
    /// master key (the JWT secret stands in, as it does in Swift) and HTTPS
    /// required. Nothing here is a switch that *closes* a surface: an operator
    /// who configured nothing still gets working webhook management, because the
    /// derivation has a defined fallback and the strict URL policy is the safe
    /// end of its own axis.
    pub webhook: Arc<WebhookSettings>,
    /// The key `ephemeral_grant`s are signed and verified with, derived once at
    /// startup from the app JWT secret (`momo_auth::ephemeral_grant_key`).
    ///
    /// Derived once rather than per request because it is a hash of a secret:
    /// recomputing it in a handler would put `jwt_secret` on the hot path for no
    /// reason. Never logged — [`AppState`]'s hand-written `Debug` covers it by
    /// listing nothing.
    pub ephemeral_grant_key: Arc<String>,
    /// LIVE-5a — the oort TURN relay's ephemeral-credential policy
    /// (ADR-0165 증보 1 D3-2). `None` unless [`AppState::with_turn`] says
    /// otherwise, and `None` means the two display routes answer with an
    /// **empty** `ice_servers` rather than a credential nothing can verify.
    ///
    /// Fail-closed like the rest, with one difference worth naming: an empty
    /// array is not a closed surface. The producer template still carries the
    /// static credential the install runbook shipped, so an instance without
    /// this policy streams exactly as it does today. That overlap **is** the
    /// retirement order — 신규 단명 자격 실증 먼저, 정적 제거는 그다음 — and it
    /// lives in the default rather than in a runbook step somebody remembers.
    pub turn: Option<Arc<momo_t3::TurnCredentialPolicy>>,
    /// ADR-0170 — the only object in this process that can GET a remote URL.
    /// Default is the SSRF-guarded transport. Tests inject a loopback client.
    pub unfurl_http: Arc<dyn momo_unfurl::UnfurlHttp>,
    pub unfurl_cache: Arc<momo_unfurl::ImageCache>,
}

impl AppState {
    pub fn new(
        pool: PgPool,
        jwt_secret: String,
        realtime_ws_url: impl Into<RealtimeAdvert>,
    ) -> Self {
        let ephemeral_grant_key = momo_auth::ephemeral_grant_key(&jwt_secret);
        AppState {
            pool,
            jwt_secret: Arc::new(jwt_secret),
            realtime_ws_url: Arc::new(realtime_ws_url.into()),
            t3: Arc::new(T3Settings::default()),
            t3_provisioner: None,
            agent_gateway: Arc::new(AgentGatewaySettings::default()),
            realtime: Arc::new(RealtimeSettings::default()),
            settings: Arc::new(SettingsConfig::default()),
            rate_limit: Arc::new(RateLimitState::default()),
            agent_port: Arc::new(AgentPortState::default()),
            mentions: Arc::new(MentionSettings::default()),
            cors: Arc::new(CorsConfig::default()),
            ephemeral: Arc::new(EphemeralState::default()),
            webhook: Arc::new(WebhookSettings::default()),
            drive: Arc::new(momo_drive::UnavailableDriveArchive),
            drive_local_base: Arc::new(DriveLocalBase::Fixed(String::new())),
            livekit: None,
            ephemeral_grant_key: Arc::new(ephemeral_grant_key),
            turn: None,
            unfurl_http: Arc::new(momo_unfurl::SafeUnfurlTransport::production(false)),
            unfurl_cache: Arc::new(momo_unfurl::ImageCache::default()),
        }
    }

    /// Replace the unfurl HTTP hop (conformance tests with a mock origin).
    pub fn with_unfurl_http(mut self, http: Arc<dyn momo_unfurl::UnfurlHttp>) -> Self {
        self.unfurl_http = http;
        self
    }

    /// The URL login/join/claim put in `realtimeWebSocketUrl` (ADR-0110 / ADR-0167).
    pub fn advertised_realtime_ws_url(
        &self,
        headers: &HeaderMap,
        connection_scheme: Option<&str>,
    ) -> Result<String, ApiError> {
        self.realtime_ws_url
            .advertise_from_headers(headers, connection_scheme)
            .map_err(|error| ApiError::internal("realtime.advertise", error))
    }

    /// Local-archive capability URL for this request (ADR-0169 증보 1).
    ///
    /// Fixed leaves the archive's boot-time URL alone. SameOrigin rewrites
    /// through [`DriveLocalBase::apply_to_upload_url`], which is the 0167
    /// Host / X-Forwarded-Proto pair — not the raw request URI.
    pub fn advertised_local_upload_url(
        &self,
        headers: &HeaderMap,
        connection_scheme: Option<&str>,
        upload_url: String,
    ) -> Result<String, ApiError> {
        self.drive_local_base
            .apply_to_upload_url(headers, connection_scheme, &upload_url)
            .map_err(|error| ApiError::internal("drive.advertise", error))
    }

    /// Attach the oort TURN relay's ephemeral-credential policy (LIVE-5a).
    ///
    /// A builder like every other, and the default it leaves alone is the one
    /// that matters: without it the display routes mint no credential and the
    /// producer keeps the static one, which is how the new path is proved beside
    /// the old rather than instead of it.
    pub fn with_turn(mut self, policy: momo_t3::TurnCredentialPolicy) -> Self {
        self.turn = Some(Arc::new(policy));
        self
    }

    /// Attach the operator's Drive archive (ADR-0151), same rationale as every
    /// builder above: the default is an attachment surface that says "not
    /// configured", not one that quietly stores bytes somewhere nobody chose.
    pub fn with_drive(mut self, archive: Arc<dyn momo_drive::DriveArchive>) -> Self {
        self.drive = archive;
        self
    }

    /// Attach the local-archive URL advertisement mode (ADR-0169 증보 1).
    pub fn with_drive_local_base(mut self, base: DriveLocalBase) -> Self {
        self.drive_local_base = Arc::new(base);
        self
    }

    /// Attach the complete LiveKit issuer unit. The default remains `None`,
    /// which closes every huddle route with the Swift-compatible 503.
    pub fn with_livekit(mut self, config: LiveKitConfig) -> Self {
        self.livekit = Some(Arc::new(config));
        self
    }

    /// Attach the operator's T3 configuration (B2.2). A builder rather than a
    /// `new` parameter so every existing call site keeps compiling *and* keeps
    /// the fail-closed default.
    pub fn with_t3(mut self, settings: T3Settings) -> Self {
        self.t3 = Arc::new(settings);
        self
    }

    /// Attach the managed provisioner for the configured default provider
    /// (ADR-0156 D4-④).
    ///
    /// Separate from [`AppState::with_t3`] rather than folded into it, and the
    /// split is the fail-closed property: `T3Settings` is operator *intent* read
    /// from the environment, while this is the *capability* that intent asks for.
    /// An instance that named a managed provider but supplied no endpoint gets
    /// intent without capability, which is a 503 on the acquisition route — never
    /// a durable row against a substrate nobody can reach.
    pub fn with_t3_provisioner(mut self, provisioner: Arc<momo_t3::CloudProvisioner>) -> Self {
        self.t3_provisioner = Some(provisioner);
        self
    }

    /// Attach the operator's AgentGateway configuration (B2.6), same rationale.
    pub fn with_agent_gateway(mut self, settings: AgentGatewaySettings) -> Self {
        self.agent_gateway = Arc::new(settings);
        self
    }

    /// Attach the operator's Centrifugo configuration (B4), same rationale: the
    /// default is a realtime rail that cannot be opened, not one opened on a
    /// guessed secret.
    pub fn with_realtime(mut self, settings: RealtimeSettings) -> Self {
        self.realtime = Arc::new(settings);
        self
    }

    /// Attach the 설정 표면 configuration (B4.2), same rationale again: the
    /// default is a provider-link family that answers "not configured", not one
    /// that opens stored ciphertext with a guessed key.
    pub fn with_settings(mut self, settings: SettingsConfig) -> Self {
        self.settings = Arc::new(settings);
        self
    }

    /// Attach the operator's MOMO-300 knobs (B4.3), and with them a **fresh**
    /// limiter — the window is per-process state, so replacing the config
    /// replaces the counters it was measured against.
    pub fn with_rate_limit(mut self, config: RateLimitConfig) -> Self {
        self.rate_limit = Arc::new(RateLimitState {
            config,
            limiter: SlidingWindowRateLimiter::new(),
        });
        self
    }

    /// Attach Agent Port's dedicated transport knobs and start with empty
    /// process-local buckets. This is intentionally independent of `/v1/join`.
    pub fn with_agent_port(mut self, config: AgentPortConfig) -> Self {
        // The envelope key is derived from the app JWT secret rather than taken
        // from a second env var, the way `OUTBOUND_WEBHOOK_MASTER_KEY` falls
        // back to `JWT_HMAC`: an operator who configured nothing still gets a
        // per-instance key instead of a default one, and the derivation is
        // domain-separated inside each codec so a cursor and a lease handle
        // never share a key.
        let envelope_secret = format!("oort/agent-port/envelope/v1|{}", self.jwt_secret);
        self.agent_port = Arc::new(AgentPortState {
            config,
            limiter: SlidingWindowRateLimiter::new(),
            envelope_secret,
        });
        self
    }

    /// Attach the mention-routing knobs (B5.2).
    pub fn with_mentions(mut self, settings: MentionSettings) -> Self {
        self.mentions = Arc::new(settings);
        self
    }

    /// Attach the MOMO-605 CORS allowlist. Same rationale as every builder
    /// above: the default is "no cross-origin surface at all", and an operator
    /// has to name each origin to open one.
    pub fn with_cors(mut self, config: CorsConfig) -> Self {
        self.cors = Arc::new(config);
        self
    }

    /// Attach the 휘발 신호 configuration (ADR-0149), and with it the publisher
    /// — the two are one value because the credential *is* the switch.
    pub fn with_ephemeral(mut self, settings: EphemeralSettings) -> Self {
        self.ephemeral = Arc::new(EphemeralState::new(settings));
        self
    }

    /// Attach the operator's webhook configuration (#1222).
    pub fn with_webhook(mut self, settings: WebhookSettings) -> Self {
        self.webhook = Arc::new(settings);
        self
    }
}

impl std::fmt::Debug for AppState {
    /// Hand-written so a `{:?}` of the state can never print the JWT secret.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppState")
            .field("realtime_ws_url", &self.realtime_ws_url)
            .finish_non_exhaustive()
    }
}

/// Build the application router.
///
/// Public routes (`/healthz`, `/health`, `/v1/auth/login`, `/v1/auth/refresh`,
/// `/v1/auth/logout`) are mounted OUTSIDE the auth middleware, exactly like the
/// Swift server's public router group (`AuthRoutes.swift:36-44`); everything
/// else sits behind [`auth::require_principal`].
///
/// refresh and logout verify the presented JWT themselves. logout in particular
/// **must** stay outside the middleware: the middleware's MOMO-300 revocation
/// check would turn a second logout into a 401, and logout is specified as
/// idempotent (200 with `alreadyRevoked=true`).
///
/// B2.2 adds two more public routes, and both are public for a reason that is
/// measured, not assumed:
///   * `…/work-hosts/{host}/heartbeat` — Swift mounts it with `addPublic`
///     (`WorkHostRoutes.swift:116-118`); a daemon authenticates with an Ed25519
///     signature over the heartbeat payload, never with a bearer token.
///   * `…/work-hosts/cloud/register` — Swift `addPublic`
///     (`CloudProvisionerRoutes.swift:75-77`); the workd spending its one-shot
///     bootstrap token has no bearer credential yet, by construction.
///
/// B2.4 adds a third, for the same measured reason: a **daemon** holds a signing
/// key, never a bearer.
///   * `…/work-hosts/{host}/terminal-attach/validate` — the direct PTY host
///     asking whether a capability is still good. Authenticated inside the
///     handler by [`work_host_auth`] (v2 request signature + one-time request
///     id, migration 048); mounting it behind the bearer middleware would have
///     inverted its authorization.
///
/// Everything else this batch mounts sits behind [`auth::require_principal`].
pub fn build_app(state: AppState) -> Router {
    let protected = Router::new()
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/messages",
            post(routes::messages::send).get(routes::messages::history),
        )
        // B4.1 — one level of threads, the way the client already asks for them:
        // replies are read here and written through the send above with a
        // `rootId`. There is no second write path.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies",
            get(routes::messages::replies),
        )
        // B11 — the things you can do to a message that is already sent.
        // Message-scoped, not channel-scoped: Swift mounts these under
        // `/workspaces/{ws}/messages/{id}` (`MessageRoutes.swift:28-31`) because
        // a message id is already unique inside a tenant, and its channel is a
        // fact about the row rather than an argument the caller gets to assert.
        // None of them consumes a `seq` — see `momo_messaging::interaction`.
        .route(
            "/v1/workspaces/{ws}/messages/{id}",
            patch(routes::messages::edit).delete(routes::messages::delete_message),
        )
        .route(
            "/v1/workspaces/{ws}/messages/{id}/reactions/{emoji}",
            put(routes::messages::add_reaction).delete(routes::messages::remove_reaction),
        )
        // The cold-load counterpart of history: that returns messages, this
        // returns the reactions on them. Two calls rather than one join, exactly
        // like Swift — a reaction changes far more often than the message it
        // annotates, and folding it into the history projection would make every
        // page re-read the whole reaction table.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/reactions",
            get(routes::messages::reaction_snapshot),
        )
        // 이슈 #1112 — pin. Message-scoped verbs like the reaction toggle above,
        // for the same reason: a pin is a fact *about a message*, and its channel
        // is a column on that row rather than an argument the caller asserts.
        // The channel-scoped list is its cold-load counterpart, exactly as
        // `/reactions` is to the reaction toggle — one read per channel, then
        // `message.pinned`/`message.unpinned` keeps it live.
        .route(
            "/v1/workspaces/{ws}/messages/{id}/pin",
            put(routes::messages::pin_message).delete(routes::messages::unpin_message),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/pins",
            get(routes::messages::pin_list),
        )
        // ADR-0170 — link unfurl server half. Workspace on/off is owner/admin;
        // message-level remove is the author; the image bytes never leave this
        // origin (CSP). Personal render-fold is the client ticket.
        .route(
            "/v1/workspaces/{ws}/unfurl-settings",
            get(routes::unfurl::get_settings).put(routes::unfurl::put_settings),
        )
        .route(
            "/v1/workspaces/{ws}/messages/{id}/unfurls",
            get(routes::unfurl::list).delete(routes::unfurl::remove),
        )
        .route(
            "/v1/workspaces/{ws}/unfurls/{id}/image",
            get(routes::unfurl::image),
        )
        // ADR-0151 — 첨부. Three routes, and the split between them is the
        // decision: the upload session hands out a Drive capability so the bytes
        // never cross this process, while the content proxy reads them here so
        // that authorization stays with PostgreSQL. A client is never given a
        // URL it can read a file from.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/attachments/uploads",
            post(routes::attachments::create_upload),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/attachments/{attachment}/complete",
            post(routes::attachments::complete),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/attachments/{attachment}/content",
            get(routes::attachments::content),
        )
        // ADR-0122 / HD-1 — PostgreSQL lifecycle + transactional outbox;
        // LiveKit is only the optional media plane and grant verifier.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/huddles",
            post(routes::huddles::start),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/huddles/active",
            get(routes::huddles::active),
        )
        .route(
            "/v1/workspaces/{ws}/huddles/{huddle}/join",
            post(routes::huddles::join),
        )
        .route(
            "/v1/workspaces/{ws}/huddles/{huddle}/leave",
            post(routes::huddles::leave),
        )
        // ADR-0161 D5 — the workspace avatar media surface. The attachment three
        // re-aimed at a workspace: owner/admin sets, any member reads, the bytes
        // ride the same Drive primitive. `content` carries the rail's avatar for
        // everyone (a wider read scope than an attachment's channel membership).
        .route(
            "/v1/workspaces/{ws}/avatar/uploads",
            post(routes::workspace_avatar::avatar_create_upload),
        )
        .route(
            "/v1/workspaces/{ws}/avatar/{id}/complete",
            post(routes::workspace_avatar::avatar_complete),
        )
        .route(
            "/v1/workspaces/{ws}/avatar/content",
            get(routes::workspace_avatar::avatar_content),
        )
        // B4 — the client's first authenticated read after login. Without it the
        // sidebar has nothing and there is no way into a conversation.
        // B4.1 adds the write beside it (D-7): a dogfooding workspace that
        // cannot grow past its seeded channels is not being used.
        .route(
            "/v1/workspaces/{ws}/channels",
            get(routes::channels::list).post(routes::channels::create),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/notification-pref",
            put(routes::channels::notification_pref),
        )
        // B5.3a — channel membership. This is what makes an invited agent
        // *mentionable*: `POST …/agents` mints the identity, this puts it in a
        // room, and only then does an `@handle` become a run instead of an
        // audited `agent_not_channel_member` no-op. No agent branch either side
        // (invariant #5) — a human joins through the same route.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/members",
            post(routes::channels::add_member),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/members/{member}",
            delete(routes::channels::remove_member),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/members/me",
            delete(routes::member_lifecycle::leave_channel),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/members/{member}/role",
            patch(routes::member_lifecycle::change_channel_role),
        )
        // B4.1 — the roster. Not a feature: without it every message, mention
        // and sidebar row is labelled with a uuid prefix (diff matrix D-1).
        // Swift serves the same handler at both paths (`RosterRoutes.swift:18-19`).
        .route("/v1/workspaces/{ws}/roster", get(routes::roster::roster))
        .route("/v1/workspaces/{ws}/members", get(routes::roster::roster))
        // B4.1 — the settings panel's first read (workspace name + the rename
        // endpoint's concurrency token).
        .route("/v1/workspaces/{ws}", get(routes::workspaces::get))
        // #1800 — operator-only bag. Not folded into GET /{ws}: that surface is
        // every member, and settings may later hold keys not every member may read.
        .route(
            "/v1/workspaces/{ws}/settings",
            get(routes::workspace_settings::get).patch(routes::workspace_settings::patch),
        )
        // ADR-0161 D4 — self-leave. The higher-scoped sibling of channel leave:
        // ends the caller's whole workspace membership. The last owner is refused
        // (409) so a workspace is never orphaned.
        // #1873 — PATCH is the self display-name write (human only). Mounted on
        // the same path so `/me` stays the caller's own row; a body cannot name
        // another member.
        .route(
            "/v1/workspaces/{ws}/members/me",
            delete(routes::workspaces::leave).patch(routes::self_profile::rename_self),
        )
        // ADR-0177 / #1932 — the caller's own sidebar organization (custom
        // sections + channel placement + stars). Human-only and member-owned:
        // `/me` is the entire addressing scheme, so no request can name another
        // member's layout. Separate path from the `/me` PATCH above because this
        // is a personal *preference* blob, not an identity field.
        .route(
            "/v1/workspaces/{ws}/members/me/sidebar-prefs",
            get(routes::sidebar_prefs::get).put(routes::sidebar_prefs::put),
        )
        // #1767 — self password change. Separate path from leave so a PATCH
        // cannot be read as a lifecycle mutation.
        .route(
            "/v1/workspaces/{ws}/members/me/password",
            patch(routes::password::change_own_password),
        )
        // #1767 — operator-issued reset token. Raw token in the 201 once;
        // operator delivers the /claim/<token> link out of band.
        .route(
            "/v1/workspaces/{ws}/members/{member}/password-reset",
            post(routes::password::issue_password_reset),
        )
        // #1768 — ADR-0128 D2/D3. Role/status/ban mutations; leave `/me` stays
        // the more specific sibling registered above.
        .route(
            "/v1/workspaces/{ws}/members/{member}/role",
            patch(routes::member_lifecycle::change_workspace_role),
        )
        .route(
            "/v1/workspaces/{ws}/members/{member}/suspend",
            post(routes::member_lifecycle::suspend),
        )
        .route(
            "/v1/workspaces/{ws}/members/{member}/reinstate",
            post(routes::member_lifecycle::reinstate),
        )
        .route(
            "/v1/workspaces/{ws}/members/{member}",
            delete(routes::member_lifecycle::remove),
        )
        .route(
            "/v1/workspaces/{ws}/bans",
            get(routes::member_lifecycle::list_bans).post(routes::member_lifecycle::create_ban),
        )
        .route(
            "/v1/workspaces/{ws}/bans/{ban}",
            delete(routes::member_lifecycle::delete_ban),
        )
        // B4.2 — 설정 표면 (diff matrix D-3). Three authorization tiers sit in
        // this block and the grouping is deliberate:
        //
        //   * `/v1/provider/link[…]` and `POST /v1/workspaces` are
        //     INSTANCE-GLOBAL: one row (or one new tenant) that every workspace
        //     on this instance shares, so they take the MOMO-583 gate
        //     (`platform:read` or a listed instance operator).
        //   * `work-host-engine`, `work-tier-policy` and the invite pair are
        //     PER-WORKSPACE rows under the uniform RLS policy, so a workspace
        //     owner/admin is the right authority.
        //   * `effort-table` and `quota-snapshots` are reads with no tenant row
        //     and no secret — any authenticated principal, and any active
        //     member, respectively.
        .route("/v1/workspaces", post(routes::workspaces::create))
        .route(
            "/v1/provider/link",
            get(routes::provider_link::get)
                .put(routes::provider_link::put)
                .delete(routes::provider_link::delete),
        )
        .route("/v1/provider/link/test", post(routes::provider_link::test))
        .route(
            "/v1/provider/link/chain",
            get(routes::provider_link::get_chain)
                .put(routes::provider_link::put_chain)
                .delete(routes::provider_link::delete_chain),
        )
        .route(
            "/v1/provider/work-host-engine",
            get(routes::provider_settings::get_work_host_engine)
                .put(routes::provider_settings::put_work_host_engine),
        )
        .route(
            "/v1/provider/effort-table",
            get(routes::provider_settings::get_effort_table),
        )
        .route(
            "/v1/provider/quota-snapshots",
            get(routes::provider_settings::get_quota_snapshots),
        )
        .route(
            "/v1/workspaces/{ws}/work-tier-policy",
            get(routes::work_tier_policy::get_workspace_default)
                .put(routes::work_tier_policy::put_workspace_default),
        )
        .route(
            "/v1/workspaces/{ws}/work-tier-policy/me",
            get(routes::work_tier_policy::get_member_override)
                .put(routes::work_tier_policy::put_member_override),
        )
        // ADR-0124 증보 1 — the caller's member-global notification rules (DND +
        // mention exception). A PER-WORKSPACE self-scoped row like
        // `work-tier-policy/me`: the member id is the credential's, never the
        // path's, so it takes an active-membership gate rather than the operator
        // one. The per-CHANNEL sibling is `channels/{ch}/notification-pref` above.
        .route(
            "/v1/workspaces/{ws}/notification-rules",
            get(routes::notification_rules::get).put(routes::notification_rules::put),
        )
        // ADR-0175 / #1888 — personal message reminders. Human-only, owner
        // scoped, no outbox fan-out (v1 is a client poll).
        .route(
            "/v1/workspaces/{ws}/reminders",
            post(routes::reminders::create).get(routes::reminders::list),
        )
        .route(
            "/v1/workspaces/{ws}/reminders/{id}",
            patch(routes::reminders::update).delete(routes::reminders::delete),
        )
        .route(
            "/v1/workspaces/{ws}/invites",
            get(routes::invites::list).post(routes::invites::create),
        )
        .route(
            "/v1/workspaces/{ws}/invites/redeem",
            post(routes::invites::redeem),
        )
        .route(
            "/v1/workspaces/{ws}/invites/{invite}",
            get(routes::invites::get_one).delete(routes::invites::revoke),
        )
        .route(
            "/v1/workspaces/{ws}/invites/{invite}/revoke",
            post(routes::invites::revoke),
        )
        .route(
            "/v1/workspaces/{ws}/invites/{invite}/regenerate",
            post(routes::invites::regenerate),
        )
        // B4 — the Centrifugo connection token (Swift mounts it protected too:
        // `AuthRoutes.addProtected`, :46-49).
        .route(
            "/v1/auth/realtime-token",
            post(routes::realtime::issue_token),
        )
        // ADR-0180 — human issuer only. The phone redeem half is public (below).
        .route(
            "/v1/auth/device-link",
            post(routes::device_link::issue),
        )
        .route(
            "/v1/auth/device-link/{id}",
            get(routes::device_link::status),
        )
        .route(
            "/v1/auth/device-link/{id}/confirm-sas",
            post(routes::device_link::confirm_sas),
        )
        // ADR-0149 (SRV-T2) — 「작성 중」. The first surface on this server whose
        // handler does not go through Postgres, and the pair is what makes that
        // safe: the grant route does the ONE membership read (under RLS, with
        // the same predicate the subscribe proxy uses) and the signal route
        // verifies its result. Both are protected — 휘발 신호 is not a public
        // surface, and the credential is what binds a grant to its caller.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/typing/grant",
            post(routes::ephemeral::issue_grant),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/typing",
            post(routes::ephemeral::typing),
        )
        // Presence (ADR-0160, 프레즌스 6b). Declared status ③ is durable
        // (REST→PG→outbox), availability ② rides the same channel-scoped grant
        // the typing route mints and the same 휘발 rail beside it.
        .route(
            "/v1/workspaces/{ws}/presence",
            get(routes::presence::get_presence).put(routes::presence::set_presence),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/availability",
            post(routes::ephemeral::availability),
        )
        // messenger breadth (B1.2) — DM, read state, search. All three sit
        // behind the same credential gate as messages: there is no anonymous
        // read of a workspace's conversations.
        .route(
            "/v1/workspaces/{ws}/dms",
            get(routes::dms::list).post(routes::dms::open),
        )
        .route(
            "/v1/workspaces/{ws}/read-state",
            get(routes::read_state::list),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/read-state",
            put(routes::read_state::update),
        )
        .route(
            "/v1/workspaces/{ws}/search/messages",
            get(routes::search::messages),
        )
        // APNs devices (ADR-0120 D4, P2). Workspace-scoped like every other
        // tenant-data surface: `device`/`push_token` carry a NOT NULL
        // workspace_id under FORCE RLS, so registration keeps the same guard
        // and RLS path as the rest of the router.
        .route(
            "/v1/workspaces/{ws}/devices",
            post(routes::devices::register).get(routes::devices::list),
        )
        .route(
            "/v1/workspaces/{ws}/devices/{device}",
            delete(routes::devices::revoke),
        )
        // work hosts (ADR-0125 registry)
        .route(
            "/v1/workspaces/{ws}/work-hosts",
            post(routes::work_hosts::register).get(routes::work_hosts::list),
        )
        .route(
            "/v1/workspaces/{ws}/work-hosts/{host}",
            delete(routes::work_hosts::revoke),
        )
        // #1114: the daemon's queue. Protected like its Swift twin
        // (`addProtected` :97-100) — the credential is a `MomoHost` signature,
        // which `auth::require_principal` now resolves to a `WorkHost`
        // principal, so this route needs no mounting of its own.
        .route(
            "/v1/workspaces/{ws}/work-hosts/{host}/pending-controls",
            get(routes::work_hosts::pending_controls),
        )
        // cloud hosts (ADR-0142 BYOC + ADR-0136 D1-A managed acquisition).
        // Both end at the same row and the same public `register`; only the
        // managed one calls a provider, and it can only do so on an instance the
        // operator handed a provisioner (ADR-0156 D4-④).
        .route(
            "/v1/workspaces/{ws}/work-hosts/byoc/enrollments",
            post(routes::cloud_hosts::enroll),
        )
        .route(
            "/v1/workspaces/{ws}/work-hosts/cloud",
            post(routes::cloud_hosts::provision),
        )
        .route(
            "/v1/workspaces/{ws}/work-hosts/cloud/{provision}",
            get(routes::cloud_hosts::get_cloud_host),
        )
        // work sessions (ADR-0114 ledger + ADR-0140 billing)
        .route(
            "/v1/workspaces/{ws}/work-sessions",
            post(routes::work_sessions::create).get(routes::work_sessions::list),
        )
        .route(
            "/v1/workspaces/{ws}/work-sessions/{session}",
            patch(routes::work_sessions::end),
        )
        .route(
            "/v1/workspaces/{ws}/work-sessions/{session}/resume",
            post(routes::work_sessions::resume),
        )
        // work controls — the host-control ledger (#1114, ADR-0114 D4/D5)
        .route(
            "/v1/workspaces/{ws}/work-controls",
            post(routes::work_controls::create),
        )
        .route(
            "/v1/workspaces/{ws}/work-controls/{control}/ack",
            post(routes::work_controls::acknowledge),
        )
        .route(
            "/v1/workspaces/{ws}/work-auto-approvals",
            get(routes::work_controls::list_auto_approvals),
        )
        .route(
            "/v1/workspaces/{ws}/work-auto-approvals/{tool}",
            put(routes::work_controls::enable_auto_approve)
                .delete(routes::work_controls::disable_auto_approve),
        )
        // #1777: daemon-boot catalog. GET only — Swift CRUD stays unported.
        .route(
            "/v1/workspaces/{ws}/work-tool-profiles",
            get(routes::work_tool_profiles::list),
        )
        // reattach + replay (ADR-0139)
        .route(
            "/v1/workspaces/{ws}/work-sessions/{session}/reattach",
            get(routes::reattach::reattach),
        )
        // terminal attach capability (ADR-0125 D10 / ADR-0126 D1)
        .route(
            "/v1/workspaces/{ws}/work-sessions/{session}/terminal-attach",
            post(routes::terminal_attach::issue),
        )
        // display attach capability (ADR-0165 / LIVE-1). The issue half is a
        // human asking to watch, so it sits behind the bearer middleware beside
        // its PTY twin. The publish half is a **daemon** telling the ledger which
        // screen it serves — protected like `…/pending-controls`, because
        // `auth::require_principal` resolves a `MomoHost` authorization into a
        // `WorkHost` principal and the route therefore needs no mounting of its
        // own. It is the first work-session write this server accepts from a
        // signed host, and it is deliberately narrow: two columns, one session,
        // and a signer pinned to that session's host inside the handler.
        .route(
            "/v1/workspaces/{ws}/work-sessions/{session}/display-attach",
            post(routes::display_attach::issue),
        )
        .route(
            "/v1/workspaces/{ws}/work-sessions/{session}/display-binding",
            post(routes::display_attach::publish_binding),
        )
        // The 반환 half of ADR-0004 증보 3 (LIVE-3). DELETE because what is
        // addressed is the open control window and the act is ending it — which
        // also gives a return the retry semantics it needs, since deleting
        // something already gone is success.
        .route(
            "/v1/workspaces/{ws}/work-sessions/{session}/display-control",
            delete(routes::display_attach::return_control),
        )
        // paid credit
        .route(
            "/v1/admin/workspaces/{ws}/credits/topups",
            post(routes::credits::topup),
        )
        // agent runs (B2.6) — creation is human-only; the gateway callbacks below
        // are the agent/gateway half of the same run's life.
        //
        // #1223 mounted the `GET` beside the `POST`. Until it did, this path was
        // POST-only, so a read answered **405** rather than 404 — which is why
        // the client's absence judgement has to read 405 as "not here" at all
        // (`features/capabilities/serverSurfaces.ts`). Writing the pair on one
        // `.route()` is the shape that keeps them from drifting apart.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/agent-runs",
            post(routes::agent_runs::create).get(routes::agent_runs::list),
        )
        // The other two reads of the same record (#1223): one agent's
        // workspace-global history (MOMO-653 — bounded summaries, joined to the
        // reader's own channel membership) and one run in full.
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/runs",
            get(routes::agent_runs::list_by_agent),
        )
        .route(
            "/v1/workspaces/{ws}/agent-runs/{run}",
            get(routes::agent_runs::detail),
        )
        // goal SRV-C2 — the other end of that life, and the one that was
        // missing: a person's "멈춰라". Human-only like creation, but authorized
        // by **channel membership** rather than ownership (ADR-0132 D1), because
        // an agent looping in a room is the room's problem to end.
        .route(
            "/v1/workspaces/{ws}/agent-runs/{run}/cancel",
            post(routes::agent_runs::cancel),
        )
        // B5.2 — "에이전트 초대". There is no bot to install: an agent is a
        // `member` with `kind='agent'`, so creating one puts it in the roster
        // beside the humans and makes it mentionable as soon as it is added to a
        // channel. The profile read is the minimum a hub UI consumes.
        .route("/v1/workspaces/{ws}/agents", post(routes::agents::create))
        // HAP-E1 — human owner/admin lifecycle for generic per-agent bearer
        // credentials. Hosted-connection credentials will be connection-managed
        // by HAP-E3 through the typed policy seam in momo-auth.
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/credentials",
            post(routes::agent_credentials::create).get(routes::agent_credentials::list),
        )
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/credentials/{credential}/revoke",
            post(routes::agent_credentials::revoke),
        )
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections",
            post(routes::hosted_agent_connections::create)
                .get(routes::hosted_agent_connections::list),
        )
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections/{connection}",
            get(routes::hosted_agent_connections::get),
        )
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections/{connection}/pairing-challenge/regenerate",
            post(routes::hosted_agent_connections::regenerate),
        )
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections/{connection}/confirm",
            post(routes::hosted_agent_connections::confirm),
        )
        // HAP-E6 — the disconnect lifecycle. `disconnect` is the atomic start
        // (revoke + pause + suppress + `cleanup_pending` + manifest seed);
        // `disconnect/complete` is the terminal transition, refused while any
        // required artifact is unresolved; the acknowledge route is the manual
        // half of cleanup confirmation.
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections/{connection}/disconnect",
            post(routes::hosted_agent_connections::disconnect),
        )
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections/{connection}/disconnect/complete",
            post(routes::hosted_agent_connections::complete_disconnect),
        )
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections/{connection}/cleanup-artifacts/{artifact}/acknowledge",
            post(routes::hosted_agent_connections::acknowledge_cleanup_artifact),
        )
        // ADR-0171 — doorbell register/unregister. Mounted unconditionally so
        // the router shape does not leak the gate; handlers answer empty 404
        // when MOMO_DOORBELL_ENABLED is not the exact word `true`.
        .route(
            "/v1/workspaces/{ws}/hosted-agent-connections/{connection}/doorbell",
            put(routes::hosted_agent_doorbell::register)
                .delete(routes::hosted_agent_doorbell::unregister),
        )
        // B5.3a completes the pair: B5.2 could read a profile and respect
        // `paused`, but nothing could write either — an agent's behaviour was
        // fixed at birth and the only way to stop one was to remove it from
        // every channel. `allowed-models` is the picker's vocabulary and the
        // only agent read a plain member may make.
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/profile",
            get(routes::agents::get_profile).put(routes::agents::put_profile),
        )
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/pause",
            put(routes::agents::put_pause),
        )
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/allowed-models",
            get(routes::agents::allowed_models),
        )
        // agent gateway (MOMO-325 / migration 008)
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/gateway/jobs/pending",
            get(routes::agent_gateway::pending_jobs),
        )
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/gateway/jobs/{job}/lease/renew",
            post(routes::agent_gateway::renew_lease),
        )
        .route(
            "/v1/workspaces/{ws}/agents/{agent}/gateway/jobs/{job}/lease/release",
            post(routes::agent_gateway::release_lease),
        )
        .route(
            "/v1/workspaces/{ws}/agent-runs/{run}/gateway/events",
            post(routes::agent_gateway::event),
        )
        .route(
            "/v1/workspaces/{ws}/agent-runs/{run}/gateway/complete",
            post(routes::agent_gateway::complete),
        )
        // approvals (goal SRV-T1) — ADR-0137 D5's third v0 axis, and the one
        // that had no server surface at all: `INSERT INTO approval` was 0, so
        // porting these routes alone would have served an empty inbox. The
        // producer is the agent worker's tool-call branch; these are the two
        // things a person meets — the inbox, and the tap that decides. The
        // second POST is Swift's compatibility route
        // (`ApprovalDecisionRoutes.swift:19`); it has no `{ws}` segment and
        // takes its workspace from the credential, exactly as Swift does.
        .route(
            "/v1/workspaces/{ws}/approvals",
            get(routes::approvals::list),
        )
        .route(
            "/v1/workspaces/{ws}/approvals/{approval}/decision",
            post(routes::approvals::decide_by_approval),
        )
        .route(
            "/v1/agent-runs/{run}/approval-decisions",
            post(routes::approvals::decide_by_run),
        )
        // LLM spend (MOMO-615) — the read side of the ledger B2.6 finally writes.
        .route(
            "/v1/workspaces/{ws}/usage/summary",
            get(routes::usage::summary),
        )
        // #1222 (T13) — the two webhook families, both workspace owner/admin.
        //
        // They are mounted together because they are one decision surface even
        // though they point in opposite directions: `/webhooks` is what an
        // outside system may push INTO a channel, `/event-subscriptions` is what
        // oort pushes OUT of the workspace. Both were live on the Swift server
        // and both had a deployed client waiting on them
        // (`features/webhooks/api.ts`, `features/settings/eventSubscriptions.ts`),
        // so until this block existed the two settings panels talked to a 404.
        //
        // The outbound half is the one with a privacy boundary attached: the 033
        // mention/approval projections carry the message BODY to a third-party
        // address, which is why the sender writes an egress audit row (#1204)
        // and why this surface — the only place a person can turn that off —
        // takes the owner/admin gate rather than plain membership.
        .route(
            "/v1/workspaces/{ws}/webhooks",
            get(routes::webhooks::list).post(routes::webhooks::create),
        )
        .route(
            "/v1/workspaces/{ws}/webhooks/{installation}/rotate",
            post(routes::webhooks::rotate),
        )
        .route(
            "/v1/workspaces/{ws}/webhooks/{installation}",
            delete(routes::webhooks::revoke),
        )
        .route(
            "/v1/workspaces/{ws}/event-subscriptions",
            get(routes::event_subscriptions::list).post(routes::event_subscriptions::create),
        )
        // ADR-0162 증보 1 / HAP-E7 — the resource owner's half of an OAuth
        // authorization request. Inside the bearer middleware because the only
        // caller is a logged-in human owner/admin: the browser redirect that
        // starts the flow is unauthenticated and lives on the public router
        // below, and it writes nothing.
        .route(
            "/v1/workspaces/{ws}/oauth/authorization-requests/preview",
            get(routes::agent_port_oauth::preview),
        )
        .route(
            "/v1/workspaces/{ws}/oauth/authorization-requests/approve",
            post(routes::agent_port_oauth::approve),
        )
        .route(
            "/v1/workspaces/{ws}/oauth/authorization-requests/deny",
            post(routes::agent_port_oauth::deny),
        )
        .route(
            "/v1/workspaces/{ws}/event-subscriptions/{subscription}",
            put(routes::event_subscriptions::update).delete(routes::event_subscriptions::delete),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_principal,
        ));

    // MOMO-605: taken before `with_state` moves the state below.
    let cors = state.cors.clone();
    // ADR-0151 / ADR-0169: the in-process upload endpoint exists when the
    // archive accepts stub-shaped PUTs (the in-memory stub, or the local-volume
    // archive). Swift gated it on the same predicate (`App.swift:115-117`). A
    // deployed environment cannot reach this branch via the stub (that is a
    // boot error); `local` is allowed there because the bytes survive a restart.
    let accepts_stub_uploads = state.drive.accepts_stub_uploads();

    let app = Router::new()
        .route("/healthz", get(routes::health::health))
        // Swift serves `/health`; every verification script polls it. Keep both.
        .route("/health", get(routes::health::health))
        .route("/v1/auth/login", post(routes::auth_routes::login))
        .route("/v1/auth/refresh", post(routes::auth_routes::refresh))
        .route("/v1/auth/logout", post(routes::auth_routes::logout))
        // ADR-0162 / HAP-E2 — intentionally outside generic bearer middleware:
        // this route accepts only agent bearers, emits MCP-specific challenges,
        // and never falls through to human JWT authentication.
        .route("/v1/mcp/agent-port", post(routes::agent_port::post))
        // ADR-0162 증보 1 / HAP-E7 — the OAuth 2.1 authorization server.
        //
        // Public for the same structural reason `/v1/join` is: the callers hold
        // no oort credential. A browser arriving at `/authorize` has a provider
        // redirect and nothing else, and a client at `/token` presents an
        // authorization code or a refresh credential — neither is a bearer this
        // middleware could resolve, and putting them behind it would make the
        // flow permanently unstartable.
        //
        // Every one of these five answers 404 while
        // `AgentPortOauthConfig::is_enabled` is false, which is the default and
        // stays the default until #1369's consent surface lands. The routes are
        // mounted unconditionally so the router shape does not itself leak the
        // operator's configuration.
        .route(
            "/.well-known/oauth-protected-resource/v1/mcp/agent-port",
            get(routes::agent_port_oauth::protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(routes::agent_port_oauth::authorization_server),
        )
        .route(
            "/v1/oauth/authorize",
            get(routes::agent_port_oauth::authorize),
        )
        .route("/v1/oauth/token", post(routes::agent_port_oauth::token))
        .route("/v1/oauth/revoke", post(routes::agent_port_oauth::revoke))
        .route(
            "/v1/workspaces/{ws}/work-hosts/{host}/heartbeat",
            post(routes::work_hosts::heartbeat),
        )
        .route(
            "/v1/workspaces/{ws}/work-hosts/cloud/register",
            post(routes::cloud_hosts::register_cloud_host),
        )
        .route(
            "/v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate",
            post(routes::terminal_attach::validate),
        )
        // LIVE-1's twin of the line above, public for the identical reason: the
        // caller is the WebRTC producer inside the sandbox, and it holds a
        // signing key rather than a bearer.
        .route(
            "/v1/workspaces/{ws}/work-hosts/{host}/display-attach/validate",
            post(routes::display_attach::validate),
        )
        // B4 adds the fourth, and it is public for the same measured reason: the
        // caller is **Centrifugo**, which holds no bearer at all. It presents the
        // `X-Centrifugo-Proxy-Secret` static header instead, checked in constant
        // time inside the handler (Swift mounts it with the same rationale,
        // `CentrifugoRoutes.swift:35-39`). Putting it behind the bearer
        // middleware would make the broker permanently unable to ask.
        .route(
            "/v1/centrifugo/subscribe",
            post(routes::realtime::subscribe),
        )
        // B4.3 adds the fifth, and it is the one that is public by
        // *construction* rather than by credential shape: the caller holds an
        // invite code and nothing else, so there is no bearer it could present
        // and no workspace it could be scoped to before the code is resolved
        // (Swift mounts it outside AuthMiddleware for the same reason,
        // `JoinRoutes.swift:6-12`).
        //
        // It is therefore an unauthenticated WRITE, and it carries a rate
        // limiter: `route_layer` runs the per-IP gate ahead of the handler and
        // — unlike `layer` — leaves every other route untouched, so this stays
        // a decision about the join surface rather than an accidental global one.
        .route(
            "/v1/join",
            post(routes::join::join).route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                rate_limit::per_ip,
            )),
        )
        // ADR-0166 / T-1: the sixth public write, and public for the same
        // construction reason as `/v1/join`. The caller holds a one-time claim
        // token and no bearer. Mounted outside auth middleware; own per-IP
        // budget so join traffic cannot starve first-owner setup.
        .route(
            "/v1/claim",
            post(routes::claim::claim).route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                rate_limit::per_ip_claim,
            )),
        )
        // ADR-0180: public for the same construction reason as `/v1/join` and
        // `/v1/claim`. The phone holds a one-time voucher and no bearer.
        .route(
            "/v1/auth/device-link/redeem",
            post(routes::device_link::redeem).route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                rate_limit::per_ip_device_link,
            )),
        )
        .merge(protected);

    // The stand-in for Google's resumable session URL. Public for the same
    // reason that URL is: the client uploading has no bearer to present to it,
    // and its authorization is the unguessable token in the path.
    let app = if accepts_stub_uploads {
        app.route(
            "/__momo_stub/drive/uploads/{token}",
            put(routes::attachments::stub_upload).layer(DefaultBodyLimit::max(
                momo_drive::MAX_ATTACHMENT_BYTES as usize,
            )),
        )
    } else {
        app
    };
    let app = app.with_state(state);

    // MOMO-605 / ADR-0133 P2 — the desktop webview's cross-origin gate.
    //
    // `layer` (not `route_layer`) on purpose: it wraps the router itself, so an
    // allowlisted `OPTIONS` is answered by the middleware BEFORE routing turns it
    // into the 405 that was breaking desktop login, and a 429 from the `/v1/join`
    // limiter still carries `Access-Control-Allow-Origin`.
    //
    // When the operator named no origin the layer is not attached at all — this
    // branch, not a pass-through middleware, is what makes the default
    // deployment byte-for-byte identical to the pre-MOMO-605 server.
    if cors.is_enabled() {
        app.layer(axum::middleware::from_fn_with_state(cors, cors::allowlist))
    } else {
        app
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Building the router must not panic.
    ///
    /// `axum`/`matchit` rejects conflicting routes when the `Router` is built,
    /// not when it is compiled — and B2.2 mounted several paths that overlap by
    /// shape (`…/work-hosts/{host}` vs `…/work-hosts/cloud/{provision}`,
    /// `…/work-hosts/{host}/heartbeat` vs `…/work-hosts/cloud/register`). Without
    /// this test the first proof that they coexist would be a boot-time panic in
    /// a docker gate; with it, `cargo test` says so in milliseconds.
    ///
    /// `connect_lazy` builds a pool handle without touching the network (it does
    /// want a Tokio context), so this stays a DB-free unit test.
    #[tokio::test]
    async fn the_router_builds_without_conflicting_routes() {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        let state = AppState::new(
            pool,
            "test-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        );
        let _router = build_app(state);
    }
}
