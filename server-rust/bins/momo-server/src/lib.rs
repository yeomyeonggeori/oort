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
pub mod rate_limit;
pub mod routes;
pub mod work_host_auth;

use std::sync::Arc;

use axum::routing::{delete, get, patch, post, put};
use axum::Router;
use momo_db::PgPool;

use crate::config::{
    AgentGatewaySettings, CorsConfig, EphemeralSettings, MentionSettings, RateLimitConfig,
    RealtimeSettings, SettingsConfig, T3Settings,
};
use crate::rate_limit::SlidingWindowRateLimiter;

/// The MOMO-300 limiter and the knobs it reads, held together because neither is
/// useful alone. Shared across handler clones by `Arc` so the window is
/// process-wide rather than per-request.
#[derive(Debug, Default)]
pub struct RateLimitState {
    pub config: RateLimitConfig,
    pub limiter: SlidingWindowRateLimiter,
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
    /// Advertised realtime WebSocket endpoint (ADR-0110).
    pub realtime_ws_url: Arc<String>,
    /// T3 (momo Cloud) settings. **Off** unless [`AppState::with_t3`] says
    /// otherwise, so a deployment that never configured T3 answers 503 on every
    /// T3 route instead of half-provisioning something billable.
    pub t3: Arc<T3Settings>,
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
    /// default is **on**, not fail-closed-off: the surface it guards
    /// (`POST /v1/join`) is the one unauthenticated write on the instance, so
    /// "the operator configured nothing" has to mean *limited*, not *open*.
    pub rate_limit: Arc<RateLimitState>,
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
    /// The key `ephemeral_grant`s are signed and verified with, derived once at
    /// startup from the app JWT secret (`momo_auth::ephemeral_grant_key`).
    ///
    /// Derived once rather than per request because it is a hash of a secret:
    /// recomputing it in a handler would put `jwt_secret` on the hot path for no
    /// reason. Never logged — [`AppState`]'s hand-written `Debug` covers it by
    /// listing nothing.
    pub ephemeral_grant_key: Arc<String>,
}

impl AppState {
    pub fn new(pool: PgPool, jwt_secret: String, realtime_ws_url: String) -> Self {
        let ephemeral_grant_key = momo_auth::ephemeral_grant_key(&jwt_secret);
        AppState {
            pool,
            jwt_secret: Arc::new(jwt_secret),
            realtime_ws_url: Arc::new(realtime_ws_url),
            t3: Arc::new(T3Settings::default()),
            agent_gateway: Arc::new(AgentGatewaySettings::default()),
            realtime: Arc::new(RealtimeSettings::default()),
            settings: Arc::new(SettingsConfig::default()),
            rate_limit: Arc::new(RateLimitState::default()),
            mentions: Arc::new(MentionSettings::default()),
            cors: Arc::new(CorsConfig::default()),
            ephemeral: Arc::new(EphemeralState::default()),
            ephemeral_grant_key: Arc::new(ephemeral_grant_key),
        }
    }

    /// Attach the operator's T3 configuration (B2.2). A builder rather than a
    /// `new` parameter so every existing call site keeps compiling *and* keeps
    /// the fail-closed default.
    pub fn with_t3(mut self, settings: T3Settings) -> Self {
        self.t3 = Arc::new(settings);
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
        // B4.1 — the roster. Not a feature: without it every message, mention
        // and sidebar row is labelled with a uuid prefix (diff matrix D-1).
        // Swift serves the same handler at both paths (`RosterRoutes.swift:18-19`).
        .route("/v1/workspaces/{ws}/roster", get(routes::roster::roster))
        .route("/v1/workspaces/{ws}/members", get(routes::roster::roster))
        // B4.1 — the settings panel's first read (workspace name + the rename
        // endpoint's concurrency token).
        .route("/v1/workspaces/{ws}", get(routes::workspaces::get))
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
        .route(
            "/v1/workspaces/{ws}/invites",
            get(routes::invites::list).post(routes::invites::create),
        )
        // B4 — the Centrifugo connection token (Swift mounts it protected too:
        // `AuthRoutes.addProtected`, :46-49).
        .route(
            "/v1/auth/realtime-token",
            post(routes::realtime::issue_token),
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
        // cloud hosts (ADR-0142 BYOC)
        .route(
            "/v1/workspaces/{ws}/work-hosts/byoc/enrollments",
            post(routes::cloud_hosts::enroll),
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
        // paid credit
        .route(
            "/v1/admin/workspaces/{ws}/credits/topups",
            post(routes::credits::topup),
        )
        // agent runs (B2.6) — creation is human-only; the gateway callbacks below
        // are the agent/gateway half of the same run's life.
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/agent-runs",
            post(routes::agent_runs::create),
        )
        // B5.2 — "에이전트 초대". There is no bot to install: an agent is a
        // `member` with `kind='agent'`, so creating one puts it in the roster
        // beside the humans and makes it mentionable as soon as it is added to a
        // channel. The profile read is the minimum a hub UI consumes.
        .route("/v1/workspaces/{ws}/agents", post(routes::agents::create))
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
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_principal,
        ));

    // MOMO-605: taken before `with_state` moves the state below.
    let cors = state.cors.clone();

    let app = Router::new()
        .route("/healthz", get(routes::health::health))
        // Swift serves `/health`; every verification script polls it. Keep both.
        .route("/health", get(routes::health::health))
        .route("/v1/auth/login", post(routes::auth_routes::login))
        .route("/v1/auth/refresh", post(routes::auth_routes::refresh))
        .route("/v1/auth/logout", post(routes::auth_routes::logout))
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
        // It is therefore the only unauthenticated WRITE on this server, and the
        // only route carrying a rate limiter: `route_layer` runs the per-IP gate
        // ahead of the handler and — unlike `layer` — leaves every other route
        // untouched, so this stays a decision about the join surface rather than
        // an accidental global one.
        .route(
            "/v1/join",
            post(routes::join::join).route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                rate_limit::per_ip,
            )),
        )
        .merge(protected)
        .with_state(state);

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
