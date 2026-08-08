//! Per-IP request rate limiting (MOMO-300), scoped to the public join surface.
//!
//! Port of Swift `Middleware/RateLimitMiddleware.swift` — the sliding-window
//! limiter (:33-86), the client-IP resolution (:98-106), the 429 body (:108-118)
//! and the per-IP middleware (:161-200).
//!
//! ## Why this arrives with B4.3 rather than as a global middleware
//!
//! `POST /v1/join` is the **only unauthenticated write** this server mounts, and
//! the credential it accepts is a bearer string in the body. Without a limiter
//! it is an online guessing oracle against `invite_code.code_hash`: 32 base64url
//! characters is far out of reach, but "far out of reach" is a property of the
//! code generator, not of the endpoint, and an endpoint that will answer an
//! unlimited number of code guesses is a bad endpoint regardless.
//!
//! So the limiter lands with the route that needs it, mounted on that route
//! only. What is **not** ported yet, and is recorded rather than implied:
//!
//! * the global mount over every path (Swift puts it on the root router);
//! * the per-**member** axis, which needs the principal and therefore sits after
//!   the auth middleware;
//! * the `rate_limit.exceeded` `audit_log` row — and note Swift never writes it
//!   for the per-IP axis either (:186-195), because that axis runs before any
//!   principal exists and `audit_log.workspace_id` is `NOT NULL`. A per-IP
//!   violation is a server log line on both servers.
//!
//! ## v0 contract, stated because it is a real limitation
//!
//! In-process state. Counters reset on restart and are **not** shared between
//! replicas, so N replicas mean N times the limit. That is the same contract the
//! Swift server documents for the single-host v0 topology; a shared store is the
//! prerequisite for scaling the API out, not for shipping this.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::config::RateLimitConfig;
use crate::error::ApiError;
use crate::AppState;

/// How many `check` calls pass before expired buckets are swept (Swift :79).
const SWEEP_INTERVAL: u32 = 4096;

/// What the limiter decided about one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verdict {
    pub allowed: bool,
    /// Seconds until the oldest counted request leaves the window — the
    /// `Retry-After` value. Never 0 on a rejection: a client told to retry
    /// immediately would simply be rejected again.
    pub retry_after_seconds: u64,
    /// True for the first rejection of this key in the current burst, so a flood
    /// produces one log line rather than one per request.
    pub should_log: bool,
}

#[derive(Debug, Default)]
struct Bucket {
    timestamps: Vec<Instant>,
    logged: bool,
}

/// A sliding-window log keyed by an arbitrary string.
///
/// A window *log* rather than a counter because the log is what makes
/// `Retry-After` truthful: a fixed counter can only say "some time within the
/// window", and a client that retries on that guess arrives too early.
///
/// Memory is bounded by (active keys × limit) timestamps, plus the sweep.
#[derive(Debug, Default)]
pub struct SlidingWindowRateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
    calls_since_sweep: Mutex<u32>,
}

impl SlidingWindowRateLimiter {
    pub fn new() -> Self {
        SlidingWindowRateLimiter::default()
    }

    /// Count one request against `key`. A `limit` of 0 disables the axis
    /// entirely (Swift :52-54), which is how an operator turns it off.
    pub fn check(&self, key: &str, limit: u32, window: Duration) -> Verdict {
        self.check_at(key, limit, window, Instant::now())
    }

    /// [`check`](Self::check) with an injected clock, so the window logic is
    /// testable without sleeping.
    pub fn check_at(&self, key: &str, limit: u32, window: Duration, now: Instant) -> Verdict {
        if limit == 0 {
            return Verdict {
                allowed: true,
                retry_after_seconds: 0,
                should_log: false,
            };
        }
        self.sweep_if_needed(window, now);

        let mut buckets = match self.buckets.lock() {
            Ok(guard) => guard,
            // A poisoned lock means another thread panicked while holding it.
            // Recover the map rather than propagate the panic: a limiter that
            // cannot decide must not take the route down with it.
            Err(poisoned) => poisoned.into_inner(),
        };
        let bucket = buckets.entry(key.to_string()).or_default();
        let cutoff = now.checked_sub(window).unwrap_or(now);
        bucket.timestamps.retain(|stamp| *stamp > cutoff);

        if bucket.timestamps.len() >= limit as usize {
            let oldest = bucket.timestamps.first().copied().unwrap_or(now);
            // How long until `oldest` falls out of the window.
            let retry = window
                .checked_sub(now.saturating_duration_since(oldest))
                .unwrap_or_default();
            let should_log = !bucket.logged;
            bucket.logged = true;
            return Verdict {
                allowed: false,
                retry_after_seconds: retry.as_secs().max(1),
                should_log,
            };
        }

        bucket.timestamps.push(now);
        bucket.logged = false;
        Verdict {
            allowed: true,
            retry_after_seconds: 0,
            should_log: false,
        }
    }

    /// Drop buckets whose entries have all left the window (Swift :77-85).
    fn sweep_if_needed(&self, window: Duration, now: Instant) {
        let due = {
            let mut calls = match self.calls_since_sweep.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            *calls += 1;
            if *calls < SWEEP_INTERVAL {
                return;
            }
            *calls = 0;
            true
        };
        if !due {
            return;
        }
        let cutoff = now.checked_sub(window).unwrap_or(now);
        let mut buckets = match self.buckets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        buckets.retain(|_, bucket| bucket.timestamps.iter().any(|stamp| *stamp > cutoff));
    }
}

/// The client address to limit on: the first `X-Forwarded-For` hop when present,
/// else the socket peer (Swift `clientIP` :98-106).
///
/// v0 caveat, documented on both servers: a directly exposed API trusts the
/// header as written. Behind the deployed reverse proxy the header is the only
/// way to see past the proxy's own address, and trusting it there is correct;
/// the fix for a direct deployment is a trusted-proxy list, not dropping the
/// header.
///
/// `None` — no header and no peer address, which is what an in-process test
/// server without `ConnectInfo` produces — means **do not block**, exactly as
/// Swift returns early on a missing peer (:177-180). A limiter that cannot name
/// the caller cannot fairly limit them.
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<String> {
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        let first = forwarded.split(',').next().unwrap_or("").trim();
        if !first.is_empty() {
            return Some(first.to_string());
        }
    }
    peer.map(|address| address.ip().to_string())
}

/// The 429, with the `Retry-After` a client should honour. The body is the
/// standard error envelope, so a client that parses every other error parses
/// this one (Swift sends the same `{"error":{"message":"rate limit exceeded"}}`).
fn too_many_requests(retry_after_seconds: u64) -> Response {
    let mut response =
        ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded").into_response();
    if let Ok(value) = retry_after_seconds.to_string().parse() {
        response.headers_mut().insert("retry-after", value);
    }
    response
}

/// Per-IP gate for the public join route.
///
/// Mounted with `route_layer` on `/v1/join` only — see the module docs for what
/// is deliberately not covered yet.
pub async fn per_ip(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let config: &RateLimitConfig = &state.rate_limit.config;
    if config.per_ip_limit == 0 {
        return next.run(request).await;
    }
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| *address);
    let Some(ip) = client_ip(request.headers(), peer) else {
        return next.run(request).await;
    };

    let verdict = state.rate_limit.limiter.check(
        &format!("ip:{ip}"),
        config.per_ip_limit,
        Duration::from_secs(config.window_seconds),
    );
    if verdict.allowed {
        return next.run(request).await;
    }
    if verdict.should_log {
        // The path is a fixed literal here, and the IP is not a secret. The
        // request body — which carries an invite code — is never touched.
        tracing::warn!(
            ip = %ip,
            limit = config.per_ip_limit,
            window_seconds = config.window_seconds,
            "rate limit exceeded (per-ip, /v1/join)"
        );
    }
    too_many_requests(verdict.retry_after_seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(forwarded: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(value) = forwarded {
            headers.insert("x-forwarded-for", value.parse().expect("header value"));
        }
        headers
    }

    #[test]
    fn the_window_admits_exactly_the_limit_then_refuses() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let start = Instant::now();
        for attempt in 0..3 {
            assert!(
                limiter.check_at("ip:1.2.3.4", 3, window, start).allowed,
                "request {attempt} is within the limit"
            );
        }
        let refused = limiter.check_at("ip:1.2.3.4", 3, window, start);
        assert!(!refused.allowed);
        assert_eq!(
            refused.retry_after_seconds, 60,
            "the oldest request has not aged at all, so the full window remains"
        );
        assert!(refused.should_log, "the first rejection of a burst logs");
        assert!(
            !limiter.check_at("ip:1.2.3.4", 3, window, start).should_log,
            "the rest of the burst does not"
        );
    }

    /// The window slides: once the oldest request ages out, one more is allowed.
    #[test]
    fn a_request_that_left_the_window_stops_counting() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let start = Instant::now();
        assert!(limiter.check_at("k", 1, window, start).allowed);
        assert!(!limiter.check_at("k", 1, window, start).allowed);
        let later = start + Duration::from_secs(61);
        assert!(
            limiter.check_at("k", 1, window, later).allowed,
            "the only counted request is older than the window"
        );
    }

    /// `Retry-After` shrinks as the oldest request ages, and never reaches 0 —
    /// a client told to retry immediately would just be refused again.
    #[test]
    fn retry_after_tracks_the_oldest_request_and_never_reaches_zero() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let start = Instant::now();
        assert!(limiter.check_at("k", 1, window, start).allowed);
        assert_eq!(
            limiter
                .check_at("k", 1, window, start + Duration::from_secs(20))
                .retry_after_seconds,
            40
        );
        assert_eq!(
            limiter
                .check_at("k", 1, window, start + Duration::from_secs(59))
                .retry_after_seconds,
            1,
            "the floor is one second, not zero"
        );
    }

    #[test]
    fn keys_are_independent() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let start = Instant::now();
        assert!(limiter.check_at("ip:a", 1, window, start).allowed);
        assert!(!limiter.check_at("ip:a", 1, window, start).allowed);
        assert!(
            limiter.check_at("ip:b", 1, window, start).allowed,
            "one noisy address must not shut out everyone else"
        );
    }

    #[test]
    fn a_zero_limit_disables_the_axis() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let start = Instant::now();
        for _ in 0..100 {
            assert!(limiter.check_at("k", 0, window, start).allowed);
        }
    }

    #[test]
    fn the_forwarded_header_wins_over_the_socket_peer() {
        let peer: SocketAddr = "10.0.0.9:44321".parse().expect("peer");
        assert_eq!(
            client_ip(&headers(Some("203.0.113.7, 10.0.0.1")), Some(peer)),
            Some("203.0.113.7".to_string()),
            "behind a proxy the first hop is the client"
        );
        assert_eq!(
            client_ip(&headers(Some("  ")), Some(peer)),
            Some("10.0.0.9".to_string()),
            "a blank header falls through to the peer rather than keying on empty"
        );
        assert_eq!(
            client_ip(&headers(None), Some(peer)),
            Some("10.0.0.9".to_string())
        );
        assert_eq!(
            client_ip(&headers(None), None),
            None,
            "no resolvable caller means do not block (Swift :177-180)"
        );
    }
}
