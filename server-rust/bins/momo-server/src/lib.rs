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

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use momo_db::PgPool;

/// Shared handler state. Cheap to clone (pool handle + `Arc`'d strings).
#[derive(Clone)]
pub struct AppState {
    /// The api-role pool (`momo_app`, NOBYPASSRLS — the RLS policies must apply).
    pub pool: PgPool,
    /// HS256 App JWT secret. Never logged, never echoed in a response.
    pub jwt_secret: Arc<String>,
    /// Advertised realtime WebSocket endpoint (ADR-0110).
    pub realtime_ws_url: Arc<String>,
}

impl AppState {
    pub fn new(pool: PgPool, jwt_secret: String, realtime_ws_url: String) -> Self {
        AppState {
            pool,
            jwt_secret: Arc::new(jwt_secret),
            realtime_ws_url: Arc::new(realtime_ws_url),
        }
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
pub fn build_app(state: AppState) -> Router {
    let protected = Router::new()
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/messages",
            post(routes::messages::send).get(routes::messages::history),
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
        .merge(protected)
        .with_state(state)
}
