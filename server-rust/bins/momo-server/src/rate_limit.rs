//! Per-IP request rate limiting (MOMO-300), scoped to the public join and claim surfaces.
//!
//! Port of Swift `Middleware/RateLimitMiddleware.swift` — the sliding-window
//! limiter (:33-86), the client-IP resolution (:98-106), the 429 body (:108-118)
//! and the per-IP middleware (:161-200).
//!
//! ## Why this arrives with B4.3 rather than as a global middleware
//!
//! `POST /v1/join` and `POST /v1/claim` are the unauthenticated writes this
//! server mounts, and each accepts a bearer string in the body. Without a
//! limiter they are online guessing oracles against stored sha256 hashes.
//! "Far out of reach" is a property of the generator, not of the endpoint, and
//! an endpoint that will answer an unlimited number of guesses is a bad
//! endpoint regardless.
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
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// Reservation that owns the first-denial log marker. Database-backed
    /// callers release it when their audit transaction fails, allowing a later
    /// denial to retry the bounded audit without opening a duplicate-write
    /// flood. Immediate log callers leave the reservation committed.
    pub(crate) log_reservation: Option<u64>,
}

#[derive(Debug, Default)]
struct Bucket {
    timestamps: Vec<Instant>,
    log_reservation: Option<u64>,
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
    next_log_reservation: AtomicU64,
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
        self.check_many_at(&[(key, limit)], window, now)[0]
    }

    /// Atomically admit a request against several independent keys.
    ///
    /// If any enabled key is full, none of the otherwise-open keys consume a
    /// timestamp. That makes the maximum denied-axis `Retry-After` truthful:
    /// retrying after it expires cannot discover that the rejected request
    /// silently filled another axis. The result order matches `checks`.
    pub fn check_many(&self, checks: &[(&str, u32)], window: Duration) -> Vec<Verdict> {
        self.check_many_at(checks, window, Instant::now())
    }

    /// [`check_many`](Self::check_many) with an injected clock.
    pub fn check_many_at(
        &self,
        checks: &[(&str, u32)],
        window: Duration,
        now: Instant,
    ) -> Vec<Verdict> {
        if checks.is_empty() {
            return Vec::new();
        }
        self.sweep_if_needed(window, now);

        let mut buckets = match self.buckets.lock() {
            Ok(guard) => guard,
            // A poisoned lock means another thread panicked while holding it.
            // Recover the map rather than propagate the panic: a limiter that
            // cannot decide must not take the route down with it.
            Err(poisoned) => poisoned.into_inner(),
        };
        let cutoff = now.checked_sub(window);
        for (key, limit) in checks {
            if *limit == 0 {
                continue;
            }
            buckets
                .entry((*key).to_string())
                .or_default()
                .timestamps
                .retain(|stamp| cutoff.is_none_or(|cutoff| *stamp > cutoff));
        }

        let any_denied = checks.iter().any(|(key, limit)| {
            *limit > 0
                && buckets
                    .get(*key)
                    .is_some_and(|bucket| bucket.timestamps.len() >= *limit as usize)
        });

        checks
            .iter()
            .map(|(key, limit)| {
                if *limit == 0 {
                    return Verdict {
                        allowed: true,
                        retry_after_seconds: 0,
                        should_log: false,
                        log_reservation: None,
                    };
                }
                let bucket = buckets
                    .get_mut(*key)
                    .expect("enabled bucket was inserted before admission");
                if bucket.timestamps.len() >= *limit as usize {
                    let oldest = bucket.timestamps.first().copied().unwrap_or(now);
                    let retry = window
                        .checked_sub(now.saturating_duration_since(oldest))
                        .unwrap_or_default();
                    let retry_seconds = retry
                        .as_secs()
                        .saturating_add(u64::from(retry.subsec_nanos() != 0));
                    let log_reservation = if bucket.log_reservation.is_none() {
                        let reservation = self
                            .next_log_reservation
                            .fetch_add(1, Ordering::Relaxed)
                            .wrapping_add(1);
                        bucket.log_reservation = Some(reservation);
                        Some(reservation)
                    } else {
                        None
                    };
                    Verdict {
                        allowed: false,
                        retry_after_seconds: retry_seconds.max(1),
                        should_log: log_reservation.is_some(),
                        log_reservation,
                    }
                } else {
                    if !any_denied {
                        bucket.timestamps.push(now);
                        bucket.log_reservation = None;
                    }
                    Verdict {
                        allowed: true,
                        retry_after_seconds: 0,
                        should_log: false,
                        log_reservation: None,
                    }
                }
            })
            .collect()
    }

    /// Release an uncommitted first-denial marker iff this caller still owns
    /// it. The reservation comparison prevents a late failing transaction from
    /// clearing a newer window's marker after the bucket was reused.
    pub(crate) fn release_log_reservation(&self, key: &str, reservation: u64) {
        let mut buckets = match self.buckets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(bucket) = buckets.get_mut(key) {
            if bucket.log_reservation == Some(reservation) {
                bucket.log_reservation = None;
            }
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
        let cutoff = now.checked_sub(window);
        let mut buckets = match self.buckets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        buckets.retain(|_, bucket| {
            cutoff.is_none_or(|cutoff| bucket.timestamps.iter().any(|stamp| *stamp > cutoff))
        });
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
    gate_per_ip(
        state,
        request,
        next,
        "ip",
        |config| config.per_ip_limit,
        "/v1/join",
    )
    .await
}

/// Per-IP gate for the public claim route. Independent key prefix and budget
/// from join so the two surfaces cannot starve each other.
pub async fn per_ip_claim(State(state): State<AppState>, request: Request, next: Next) -> Response {
    gate_per_ip(
        state,
        request,
        next,
        "ip:claim",
        |config| config.claim_per_ip_limit,
        "/v1/claim",
    )
    .await
}

/// Per-IP gate for public device-link redeem. Reuses the claim budget (no new
/// env) on an independent key so claim traffic cannot starve QR redeem.
pub async fn per_ip_device_link(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    gate_per_ip(
        state,
        request,
        next,
        "ip:device-link",
        |config| config.claim_per_ip_limit,
        "/v1/auth/device-link/redeem",
    )
    .await
}

async fn gate_per_ip(
    state: AppState,
    request: Request,
    next: Next,
    key_prefix: &'static str,
    limit_of: fn(&RateLimitConfig) -> u32,
    surface: &'static str,
) -> Response {
    let config: &RateLimitConfig = &state.rate_limit.config;
    let limit = limit_of(config);
    if limit == 0 {
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
        &format!("{key_prefix}:{ip}"),
        limit,
        Duration::from_secs(config.window_seconds),
    );
    if verdict.allowed {
        return next.run(request).await;
    }
    if verdict.should_log {
        // The path is a fixed literal here, and the IP is not a secret. The
        // request body — which carries a token — is never touched.
        tracing::warn!(
            ip = %ip,
            limit,
            window_seconds = config.window_seconds,
            surface,
            "rate limit exceeded (per-ip)"
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
        assert_eq!(
            limiter
                .check_at("k", 1, window, start + Duration::from_millis(500))
                .retry_after_seconds,
            60,
            "fractional remaining time is rounded up so Retry-After is sufficient"
        );
        assert!(
            limiter
                .check_at("k", 1, window, start + Duration::from_millis(60_500))
                .allowed,
            "waiting the advertised whole seconds must admit the retry"
        );
    }

    #[test]
    fn multi_axis_denial_does_not_consume_an_open_axis() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let start = Instant::now();
        assert!(limiter.check_at("agent", 1, window, start).allowed);

        let denied = limiter.check_many_at(
            &[("new-token", 1), ("agent", 1)],
            window,
            start + Duration::from_secs(59),
        );
        assert!(denied[0].allowed);
        assert!(!denied[1].allowed);
        assert_eq!(denied[1].retry_after_seconds, 1);

        let retry = limiter.check_many_at(
            &[("new-token", 1), ("agent", 1)],
            window,
            start + Duration::from_secs(60),
        );
        assert!(
            retry.iter().all(|verdict| verdict.allowed),
            "the rejected request must not silently fill the token bucket"
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
    fn an_unrepresentably_large_window_fails_closed() {
        let limiter = SlidingWindowRateLimiter::new();
        let start = Instant::now();
        assert!(limiter.check_at("k", 1, Duration::MAX, start).allowed);
        assert!(
            !limiter.check_at("k", 1, Duration::MAX, start).allowed,
            "checked_sub underflow must retain rather than erase the bucket"
        );
    }

    #[test]
    fn a_failed_audit_can_release_only_its_own_log_reservation() {
        let limiter = SlidingWindowRateLimiter::new();
        let start = Instant::now();
        let window = Duration::from_secs(60);
        assert!(limiter.check_at("token", 1, window, start).allowed);

        let first_denial = limiter.check_at("token", 1, window, start);
        let reservation = first_denial
            .log_reservation
            .expect("first denial owns the audit reservation");
        assert!(first_denial.should_log);
        assert!(!limiter.check_at("token", 1, window, start).should_log);

        limiter.release_log_reservation("token", reservation.wrapping_add(1));
        assert!(
            !limiter.check_at("token", 1, window, start).should_log,
            "a stale or foreign reservation cannot reopen the audit marker"
        );

        limiter.release_log_reservation("token", reservation);
        assert!(
            limiter.check_at("token", 1, window, start).should_log,
            "a rolled-back audit lets one later denial retry"
        );
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
