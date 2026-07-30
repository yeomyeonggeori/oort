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
//! | #2 Centrifugo = transport-only | `momo-relay` is the sole publisher | **has no HTTP client** |
//! | #3 single write path | `momo_outbox::emit_outbox` | calls `send_message_in_tx`, never the outbox |
//! | #4 gapless seq | `channel_seq` row lock + UNIQUE | returns the authoritative `seq` |
//! | #5 agent = member | one `member` table | no agent branch in any handler |
//! | #6 RLS FORCE | `momo_db::with_tenant_tx` | opens every tenant access through it, keyed by the credential |
//!
//! The router is a library so `tests/http_smoke_pg.rs` can boot the real app on
//! an ephemeral port; `main.rs` only reads the environment and serves.

pub mod auth;
pub mod config;
pub mod dto;
pub mod error;
pub mod routes;
pub mod work_host_auth;

use std::sync::Arc;

use axum::routing::{delete, get, patch, post};
use axum::Router;
use momo_db::PgPool;

use crate::config::T3Settings;

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
}

impl AppState {
    pub fn new(pool: PgPool, jwt_secret: String, realtime_ws_url: String) -> Self {
        AppState {
            pool,
            jwt_secret: Arc::new(jwt_secret),
            realtime_ws_url: Arc::new(realtime_ws_url),
            t3: Arc::new(T3Settings::default()),
        }
    }

    /// Attach the operator's T3 configuration (B2.2). A builder rather than a
    /// `new` parameter so every existing call site keeps compiling *and* keeps
    /// the fail-closed default.
    pub fn with_t3(mut self, settings: T3Settings) -> Self {
        self.t3 = Arc::new(settings);
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
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_principal,
        ));

    Router::new()
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
        .merge(protected)
        .with_state(state)
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
