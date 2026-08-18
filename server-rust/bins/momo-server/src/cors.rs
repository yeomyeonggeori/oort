//! MOMO-605 / ADR-0133 P2 — CORS origin allowlist middleware.
//!
//! Rust port of the Swift `OriginAllowlistCORSMiddleware`
//! (`server/Sources/MomoServer/Middleware/CORSMiddleware.swift`). The allowlist
//! itself — parsing, normalization and the wildcard ban — lives beside every
//! other settings struct in [`crate::config::CorsConfig`].
//!
//! Why this exists: the web SPA is served same-origin (Caddy serves the bundle
//! and proxies `/v1/*` on the one `APP_DOMAIN` site, ADR-0119 D1-A) so it never
//! needed CORS, and nobody noticed the Axum rewrite had dropped it. A packaged
//! Tauri desktop build cannot use that trick — its frontend loads from a
//! webview-owned origin (`tauri://localhost`, or `http://tauri.localhost` on
//! Windows/Android) while the API lives on a real host, so every `/v1/*` call is
//! genuinely cross-origin and the webview enforces CORS exactly like a browser.
//! Login was failing at the *preflight*: `OPTIONS /v1/auth/login` matched no
//! route and Axum answered 405.
//!
//! Contract:
//!   * **OFF BY DEFAULT.** [`crate::build_app`] mounts this only when
//!     `MOMO_CORS_ALLOWED_ORIGINS` named at least one valid origin. An
//!     unconfigured server is byte-for-byte the pre-MOMO-605 server: no
//!     `Access-Control-*`, no `Vary`, no `OPTIONS` short-circuit.
//!   * **EXACT MATCH ONLY.** The inbound `Origin` is normalized (RFC 6454 §6.1,
//!     ASCII-lowercased) and must equal an allowlist entry. `CorsConfig` refuses
//!     wildcard and `null` entries at parse time, so `Access-Control-Allow-Origin: *`
//!     can never be produced.
//!   * **NO CREDENTIALS.** momo carries its session in the `Authorization`
//!     bearer header and sets no cookies, so `Access-Control-Allow-Credentials`
//!     is never sent — clients use `credentials: "omit"` (the fetch default) and
//!     attach the token header themselves. This keeps the dangerous
//!     `Allow-Origin: *` + `Allow-Credentials: true` pair unrepresentable and
//!     means a hostile page cannot ride ambient credentials even if an operator
//!     allowlists a wrong origin.
//!   * **UNKNOWN ORIGINS PASS THROUGH UNCHANGED**, not rejected with a 403. The
//!     response simply carries no CORS headers, so the browser blocks it while
//!     every non-browser caller (the macOS/iOS clients, curl, the work-host
//!     daemon, the Centrifugo subscribe proxy) keeps its existing behaviour —
//!     none of them sends `Origin`.
//!
//! Mount position: [`crate::build_app`] applies this with `Router::layer`, i.e.
//! OUTSIDE routing and outside the MOMO-300 per-IP limiter that `/v1/join`
//! carries. Both halves of that matter. Outside routing is what lets an
//! allowlisted `OPTIONS` short-circuit at all (inside, it would already have
//! become the 405 this ticket is fixing); outside the limiter is what keeps a
//! 429 carrying `Access-Control-Allow-Origin`, without which the browser reports
//! an opaque network error instead of the real rate-limit response.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

use crate::config::CorsConfig;

/// Headers a browser may send on an allowlisted cross-origin request. Fixed on
/// purpose — reflecting `Access-Control-Request-Headers` back would make the
/// allowance unbounded. These are exactly what the web/desktop client sends:
/// `authorization` (the bearer) and `content-type` (JSON bodies), plus the two
/// the fetch spec lets through anyway. The server's other custom headers
/// (`x-momo-work-host-*`, `x-momo-agent-gateway-secret`,
/// `x-centrifugo-proxy-secret`) belong to daemons and the broker, which are not
/// browsers and never preflight — listing them here would widen the browser
/// surface for callers that cannot use it.
pub const ALLOWED_REQUEST_HEADERS: &str =
    "accept, authorization, content-type, origin, mcp-protocol-version, mcp-method, mcp-name";

/// Methods the momo REST surface actually routes (`build_app`), plus `OPTIONS`.
pub const ALLOWED_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/// Response headers a browser may read. `Retry-After` accompanies the MOMO-300
/// 429 and is useless to the client unless exposed.
pub const EXPOSED_RESPONSE_HEADERS: &str = "retry-after";

/// Preflight cache lifetime, in seconds. Short enough that an allowlist change
/// takes effect within one restart cycle of operator patience.
pub const PREFLIGHT_MAX_AGE_SECONDS: u32 = 600;

/// The allowlist gate. See the module docs for the contract.
pub async fn allowlist(
    State(config): State<Arc<CorsConfig>>,
    request: Request,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    let Some(matched) = config.matched_origin(origin.as_deref()) else {
        // No `Origin` (every native momo client), or an origin we do not trust:
        // behave exactly as if this middleware were absent.
        return next.run(request).await;
    };
    // `HeaderValue` from a normalized origin cannot fail — normalization already
    // rejected whitespace and every non-ASCII byte — but a panic in a middleware
    // is never worth the shortcut.
    let Ok(allow_origin) = HeaderValue::from_str(&matched) else {
        return next.run(request).await;
    };

    // Preflight. Deliberately keyed on the method alone rather than on the
    // presence of `Access-Control-Request-Method`: no route in `build_app` is
    // mounted for OPTIONS, so an allowlisted OPTIONS has no other meaning, and
    // keying on the method keeps a plain `curl -X OPTIONS -H 'Origin: …'` — the
    // way this gets verified against a live deploy — answering the same way the
    // browser sees.
    if request.method() == Method::OPTIONS {
        let mut response = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .expect("a status-and-empty-body response always builds");
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(ALLOWED_METHODS),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(ALLOWED_REQUEST_HEADERS),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from(PREFLIGHT_MAX_AGE_SECONDS),
        );
        // The answer depends on the request's `Origin`, so any shared cache in
        // front of this must key on it.
        headers.insert(header::VARY, HeaderValue::from_static("origin"));
        // NOTE: no `Access-Control-Allow-Credentials`. See the module docs.
        return response;
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSED_RESPONSE_HEADERS),
    );
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    response
}
