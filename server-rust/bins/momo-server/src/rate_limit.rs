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
//! * the Swift **global** per-member axis (`RATE_LIMIT_PER_MEMBER`, every
//!   authenticated route). What replaced it is narrower on purpose: the per-member
//!   **write** budget at the bottom of this file (#4234, ADR-0208 D10 증보), mounted
//!   on the five write endpoints (three surfaces) a member can flood. Reads and the
//!   streaming `PATCH` have no per-member budget;
//! * the per-IP `audit_log` row. Swift never writes it for the per-IP axis either
//!   (:186-195), because that axis runs before any principal exists and
//!   `audit_log.workspace_id` is `NOT NULL`: a per-IP violation is a server log
//!   line on both servers. The per-**member** axis does have its row (Swift's
//!   `rate_limit.exceeded`), because it runs after the principal is known.
//!
//! ## v0 contract, stated because it is a real limitation
//!
//! In-process state. Counters reset on restart and are **not** shared between
//! replicas, so N replicas mean N times the limit. That is the same contract the
//! Swift server documents for the single-host v0 topology; a shared store is the
//! prerequisite for scaling the API out, not for shipping this.

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::json;
use uuid::Uuid;

use crate::config::RateLimitConfig;
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, audit_via_token_id};
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

    /// Without counting anything: is `key` already at `limit` inside the window? `Some(retry
    /// after seconds)` when it is. Used to turn an address away **before** the handler runs
    /// (the refused-credential budget of the runner routes), so an exhausted address no longer
    /// costs a transaction per guess.
    pub fn exhausted(&self, key: &str, limit: u32, window: Duration) -> Option<u64> {
        self.exhausted_at(key, limit, window, Instant::now())
    }

    /// [`exhausted`](Self::exhausted) with an injected clock, for the same reason
    /// [`check_at`](Self::check_at) has one.
    pub fn exhausted_at(
        &self,
        key: &str,
        limit: u32,
        window: Duration,
        now: Instant,
    ) -> Option<u64> {
        if limit == 0 {
            return None;
        }
        let buckets = match self.buckets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let bucket = buckets.get(key)?;
        let cutoff = now.checked_sub(window);
        let live: Vec<&Instant> = bucket
            .timestamps
            .iter()
            .filter(|at| cutoff.is_none_or(|cutoff| **at > cutoff))
            .collect();
        if live.len() < limit as usize {
            return None;
        }
        let oldest = live.iter().min().copied()?;
        Some(
            window
                .saturating_sub(now.duration_since(*oldest))
                .as_secs()
                .max(1),
        )
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
pub(crate) fn too_many_requests(retry_after_seconds: u64) -> Response {
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

/// Per-IP gate for the GitHub App manifest callback (ADR-0205 D2). Reuses the claim budget (no
/// new env) on an independent key so it cannot starve — or be starved by — claim / QR redeem.
pub async fn per_ip_github_callback(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    gate_per_ip(
        state,
        request,
        next,
        "ip:github-callback",
        |config| config.claim_per_ip_limit,
        "/v1/integrations/github/app/callback",
    )
    .await
}

/// Per-IP gate for GitHub's setup-URL redirect (ADR-0205 D3). Same claim budget, own key.
pub async fn per_ip_github_setup(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    gate_per_ip(
        state,
        request,
        next,
        "ip:github-setup",
        |config| config.claim_per_ip_limit,
        "/v1/integrations/github/setup",
    )
    .await
}

/// Per-IP budget for **refused** upload capabilities (#2628; #2631 review R12).
///
/// Mounted with `route_layer` on `/__momo_stub/drive/uploads/{token}`, but it
/// lets the handler decide first: the handler answers **404** for every
/// capability it refuses — malformed, unknown, spent or expired — and for
/// nothing else. Most of those refusals come before a byte of the body is read;
/// a capability that was live when its body started and was spent by a
/// concurrent PUT, or expired, before the body finished is refused after it.
/// Only that 404 spends the address's budget; once it is spent, the address's
/// refusals become 429s.
///
/// A live capability is never refused on this axis and spends none of it.
/// Where every client reaches the api from the edge's own address — Fly T1's
/// TCP passthrough, a Cloudflare tunnel, Railway without `X-Real-IP` — one
/// address is the whole instance, and a budget that counted every PUT would let
/// an anonymous fake-token flood refuse every real attachment and avatar upload.
///
/// **This budget does not slow guessing.** The handler runs first, so a PUT
/// from an address whose budget is spent is still handled in full: a wrong
/// token gets 429 where it would have got 404, a live one lands as before. All
/// the budget adds is 429 + `Retry-After`, and one WARN line per burst, on one
/// address's excess refusals. The defence against guessing is the token: 122
/// random bits (UUIDv4), spent by its first upload, dead after
/// `momo_drive::UPLOAD_SESSION_TTL`.
///
/// The surface logged is the route's shape: the token in the path is a
/// capability and never reaches a log line.
pub async fn per_ip_drive_upload(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let config: &RateLimitConfig = &state.rate_limit.config;
    let limit = config.drive_upload_per_ip_limit;
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| *address);
    let ip = client_ip(request.headers(), peer);

    let response = next.run(request).await;
    if limit == 0 || response.status() != StatusCode::NOT_FOUND {
        return response;
    }
    let Some(ip) = ip else {
        return response;
    };
    let verdict = state.rate_limit.limiter.check(
        &format!("{DRIVE_UPLOAD_KEY}:{ip}"),
        limit,
        Duration::from_secs(config.window_seconds),
    );
    if verdict.allowed {
        return response;
    }
    if verdict.should_log {
        tracing::warn!(
            ip = %ip,
            limit,
            window_seconds = config.window_seconds,
            surface = "PUT /__momo_stub/drive/uploads/{token}",
            "rate limit exceeded (per-ip, refused upload capabilities)"
        );
    }
    too_many_requests(verdict.retry_after_seconds)
}

/// A per-IP budget that only **refused credentials** spend (#3505): the handler
/// runs first and a `401` counts against the caller's address; once the budget is
/// spent the address's refusals become `429` + `Retry-After`. An accepted request
/// spends nothing, so a runner polling every few seconds is never throttled.
pub(crate) async fn per_ip_refused(
    state: AppState,
    request: Request,
    next: Next,
    key_prefix: &'static str,
    limit_of: fn(&RateLimitConfig) -> u32,
) -> Response {
    let config: &RateLimitConfig = &state.rate_limit.config;
    let limit = limit_of(config);
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| *address);
    let ip = client_ip(request.headers(), peer);
    // Pre-check: an address whose refused-credential budget is already spent is turned away
    // before the handler (and its database transaction) runs.
    if let Some(ip) = ip.as_deref() {
        if let Some(retry_after) = state.rate_limit.limiter.exhausted(
            &format!("{key_prefix}:{ip}"),
            limit,
            Duration::from_secs(config.window_seconds),
        ) {
            return too_many_requests(retry_after);
        }
    }

    let response = next.run(request).await;
    if limit == 0 || response.status() != StatusCode::UNAUTHORIZED {
        return response;
    }
    let Some(ip) = ip else {
        return response;
    };
    let verdict = state.rate_limit.limiter.check(
        &format!("{key_prefix}:{ip}"),
        limit,
        Duration::from_secs(config.window_seconds),
    );
    if verdict.allowed {
        return response;
    }
    if verdict.should_log {
        tracing::warn!(
            ip = %ip,
            limit,
            window_seconds = config.window_seconds,
            surface = key_prefix,
            "rate limit exceeded (per-ip, refused credentials)"
        );
    }
    too_many_requests(verdict.retry_after_seconds)
}

/// The upload budget's own key prefix — never the join/claim prefixes, so
/// spending one surface's budget cannot refuse another's (#2631 review S10).
const DRIVE_UPLOAD_KEY: &str = "ip:drive-upload";

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

// ---------------------------------------------------------------------------
// #4234 — the per-member write budget (ADR-0208 D10 증보)
// ---------------------------------------------------------------------------
//
// Five write endpoints (three surfaces) are mounted behind `require_principal` and each does
// work out of proportion to its request line: a message send is a channel-seq bump + a
// message row + an outbox row (+ mention routing) in one transaction, an upload
// start is a Google Drive API call plus a `pending` row, and a scheduled-message
// create/edit is a transaction that locks the member's session and schedule rows
// and writes an outbox event. Before this budget nothing bounded how many of
// them one credential could ask for: a runaway agent loop or a leaked token
// could write at line rate.
//
// **Why a `route_layer` middleware and not a call in each handler.**
//
// * It runs before the handler's extractors, so a refused request costs neither a
//   JSON parse of up to 2 MiB nor a database connection — and the upload gate is
//   structurally ahead of the Drive call, which is the expensive part.
// * `ApiError` has no header slot, so a handler cannot answer a 429 with the
//   `Retry-After` the contract promises (`password::admit_password_change` cannot,
//   today). A middleware returns the whole `Response`.
// * The route table is where a reader looks to learn what is guarded.
//
// **Whose budget.** The key is the authenticated principal's member id, never
// anything the request carries, so a caller can only spend its own budget and can
// create no key it does not own. Humans and agents are different credentials with
// different traffic shapes, so the send surface has two limits (the limit follows
// `Principal::kind`); the other surfaces are not reachable by an agent bearer at
// all (`required_agent_scope`, `scheduled_messages::require_human`), so they have
// one limit and a non-human principal that ever reached them would be held to it.
//
// **State.** A dedicated limiter, not `RateLimitState::limiter`: that map is shared
// by axes with other windows, and its sweep drops a bucket whose entries are all
// older than the window of *whichever call* triggered the sweep — which would
// forget part of a member's history. Same contract as every limiter here: in
// process, reset by a restart, not shared between replicas (N replicas admit N
// times the limit).

/// The write surfaces that carry a per-member budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberWrite {
    /// `POST …/channels/{ch}/messages` and `POST …/scheduled-messages/{id}/send-now`.
    /// The second is the same canonical send, so it spends the same budget and the
    /// two cannot be alternated to double it.
    MessageSend,
    /// `POST …/channels/{ch}/scheduled-messages` and `PATCH …/scheduled-messages/{id}`.
    /// Cancelling (`DELETE`) is not a write that is budgeted: it is the safety action.
    ScheduledWrite,
    /// `POST …/channels/{ch}/attachments/uploads`.
    UploadStart,
}

impl MemberWrite {
    /// The stable name an audit row and a log line carry. Never a path: a route's
    /// shape may change, and the ids in it are not the point.
    pub const fn label(self) -> &'static str {
        match self {
            MemberWrite::MessageSend => "message_send",
            MemberWrite::ScheduledWrite => "scheduled_write",
            MemberWrite::UploadStart => "upload_start",
        }
    }

    /// One key space per surface, so spending one cannot refuse another — the
    /// reason the per-IP axes each have their own prefix.
    const fn key_prefix(self) -> &'static str {
        match self {
            MemberWrite::MessageSend => "write:send",
            MemberWrite::ScheduledWrite => "write:schedule",
            MemberWrite::UploadStart => "write:upload",
        }
    }
}

/// `audit_log.action` of a per-member refusal. Swift's name (`RateLimitMiddleware`),
/// kept so a query written against the old server still finds the rows.
pub const MEMBER_WRITE_RATE_LIMIT_ACTION: &str = "rate_limit.exceeded";
const MEMBER_WRITE_AUDIT_SCHEMA: &str = "oort.rate_limit.exceeded.v1";

/// How many requests `kind` may make on `surface` in one window; 0 = no budget.
///
/// Only the send surface tells humans from agents (see the section header). A
/// work-host credential counts with the agents: it is a machine, and its traffic
/// has the agents' shape.
pub fn member_write_limit(
    config: &RateLimitConfig,
    surface: MemberWrite,
    kind: PrincipalKind,
) -> u32 {
    match (surface, kind) {
        (MemberWrite::MessageSend, PrincipalKind::Human) => config.message_send_per_member_limit,
        (MemberWrite::MessageSend, PrincipalKind::Agent | PrincipalKind::WorkHost) => {
            config.message_send_per_agent_limit
        }
        (MemberWrite::ScheduledWrite, _) => config.scheduled_write_per_member_limit,
        (MemberWrite::UploadStart, _) => config.upload_start_per_member_limit,
    }
}

const fn principal_kind_label(kind: PrincipalKind) -> &'static str {
    match kind {
        PrincipalKind::Human => "human",
        PrincipalKind::Agent => "agent",
        PrincipalKind::WorkHost => "work_host",
    }
}

fn member_write_key(surface: MemberWrite, member_id: Uuid) -> String {
    format!("{}:{member_id}", surface.key_prefix())
}

/// The per-member write gate. Mount it with `route_layer` on the method that does
/// the write, and only there: `route_layer` leaves every other method of the same
/// path untouched, which is what keeps `DELETE …/scheduled-messages/{id}` and
/// `PATCH …/messages/{id}` (streaming slices) outside the budget.
///
/// It sits inside `auth::require_principal`, so the principal is already in the
/// request extensions. A request with none cannot be named and so cannot be
/// fairly limited; it is passed on, where the handler's own `Extension<Principal>`
/// extractor refuses it as it always has.
pub async fn member_write(
    State((state, surface)): State<(AppState, MemberWrite)>,
    request: Request,
    next: Next,
) -> Response {
    let Some(principal) = request.extensions().get::<Principal>().cloned() else {
        return next.run(request).await;
    };
    let config = &state.rate_limit.config;
    let limit = member_write_limit(config, surface, principal.kind);
    if limit == 0 {
        return next.run(request).await;
    }
    let key = member_write_key(surface, principal.member_id);
    let window = Duration::from_secs(config.window_seconds);
    let verdict = state.rate_limit.member_writes.check(&key, limit, window);
    if verdict.allowed {
        return next.run(request).await;
    }
    // Only the first denial of a burst owns a reservation, so a flood of parallel refusals has
    // exactly one request that goes on to the database.
    if let Some(reservation) = verdict.log_reservation {
        record_member_write_denial(&state, &principal, surface, limit, &key, reservation).await;
    }
    too_many_requests(verdict.retry_after_seconds)
}

/// The audit half of a first denial. Never fails the request: an audit that cannot
/// be written is logged and the 429 stands (Swift's rule: auditing must not turn a
/// 429 into a 500).
async fn record_member_write_denial(
    state: &AppState,
    principal: &Principal,
    surface: MemberWrite,
    limit: u32,
    key: &str,
    reservation: u64,
) {
    let window_seconds = state.rate_limit.config.window_seconds;
    tracing::warn!(
        member_id = %principal.member_id,
        surface = surface.label(),
        kind = principal_kind_label(principal.kind),
        limit,
        window_seconds,
        "rate limit exceeded (per-member write)"
    );
    // What the row says is what the limiter decided: who, which surface, which
    // budget. No path, no body, no id from the request.
    let mut entry = AuditEntry::new(principal.workspace_id, MEMBER_WRITE_RATE_LIMIT_ACTION)
        .by(principal.member_id)
        .via_token(audit_via_token_id(principal))
        .with_schema(
            MEMBER_WRITE_AUDIT_SCHEMA,
            json!({
                "scope": "member",
                "surface": surface.label(),
                "kind": principal_kind_label(principal.kind),
                "limit": limit,
                "window_seconds": window_seconds,
            }),
        );
    entry.target_type = Some("route".to_string());
    let (pool, workspace_id) = (state.pool.clone(), principal.workspace_id);
    audit_denial_once(
        &state.rate_limit.member_writes,
        key,
        reservation,
        Duration::from_secs(window_seconds),
        Instant::now(),
        || async move {
            agent_tenant_tx(&pool, workspace_id, move |conn| {
                Box::pin(async move { write_audit(conn, &entry).await.map(|_| ()) })
            })
            .await
        },
    )
    .await;
}

/// Spend the one audit row a burst of denials may carry. Returns whether a row was
/// committed.
///
/// Two bounds, because the limiter's first-denial marker alone is not enough. It is
/// atomic, so a flood of parallel denials produces one writer, not a hundred. But it
/// resets whenever the key admits a request again, and a caller that stays just
/// over the limit is admitted once for every request that ages out of the window,
/// so every one of those starts a new "burst". Without the second bound that is up
/// to `limit` audit rows per window per surface — an agent's 600 a minute — from a
/// loop the budget was supposed to quiet. So a committed row also closes an
/// **audit slot** for the window (`audit:` key, one per window): the log line says
/// every first denial, the table says at most one a window.
///
/// The slot is only closed by a row that committed. When the write fails the
/// burst's marker is handed back, so the next denial retries the row instead of the
/// burst going unrecorded (the Agent Port and webhook budgets do the same).
///
/// `write` is the database half, injected so this bookkeeping can be tested with an
/// injected clock and without a database.
async fn audit_denial_once<W, Fut>(
    limiter: &SlidingWindowRateLimiter,
    key: &str,
    reservation: u64,
    window: Duration,
    now: Instant,
    write: W,
) -> bool
where
    W: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), DbError>>,
{
    let slot = format!("audit:{key}");
    if limiter.exhausted_at(&slot, 1, window, now).is_some() {
        return false;
    }
    match write().await {
        Ok(()) => {
            limiter.check_at(&slot, 1, window, now);
            true
        }
        Err(error) => {
            limiter.release_log_reservation(key, reservation);
            tracing::error!(
                error = %error,
                key,
                "rate limit audit row failed; the 429 stands and the next denial retries the row"
            );
            false
        }
    }
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
    // -- #4234 per-member write budget -----------------------------------------

    use std::sync::atomic::AtomicUsize;

    /// Four different numbers, so a swapped field cannot pass by coincidence.
    fn budget_config() -> RateLimitConfig {
        RateLimitConfig {
            message_send_per_member_limit: 11,
            message_send_per_agent_limit: 22,
            scheduled_write_per_member_limit: 33,
            upload_start_per_member_limit: 44,
            ..RateLimitConfig::default()
        }
    }

    #[test]
    fn the_limit_follows_the_surface_and_only_the_send_surface_tells_humans_from_agents() {
        let config = budget_config();
        let limit = |surface, kind| member_write_limit(&config, surface, kind);
        assert_eq!(limit(MemberWrite::MessageSend, PrincipalKind::Human), 11);
        assert_eq!(limit(MemberWrite::MessageSend, PrincipalKind::Agent), 22);
        assert_eq!(
            limit(MemberWrite::MessageSend, PrincipalKind::WorkHost),
            22,
            "a machine credential is held to the agents' budget, not the humans'"
        );
        for kind in [
            PrincipalKind::Human,
            PrincipalKind::Agent,
            PrincipalKind::WorkHost,
        ] {
            assert_eq!(limit(MemberWrite::ScheduledWrite, kind), 33);
            assert_eq!(
                limit(MemberWrite::UploadStart, kind),
                44,
                "an agent bearer cannot reach this route today; if one ever does it is held to a budget, not exempt"
            );
        }
    }

    /// The labels are an audit-row contract (`detail.surface`) and the prefixes keep one
    /// surface's spending from refusing another's.
    #[test]
    fn every_surface_has_its_own_label_and_its_own_key_space() {
        let member = Uuid::from_u128(7);
        let surfaces = [
            (MemberWrite::MessageSend, "message_send"),
            (MemberWrite::ScheduledWrite, "scheduled_write"),
            (MemberWrite::UploadStart, "upload_start"),
        ];
        let mut keys = std::collections::HashSet::new();
        for (surface, label) in surfaces {
            assert_eq!(surface.label(), label);
            assert!(keys.insert(member_write_key(surface, member)));
        }
        assert_eq!(keys.len(), 3);
        assert_ne!(
            member_write_key(MemberWrite::MessageSend, member),
            member_write_key(MemberWrite::MessageSend, Uuid::from_u128(8)),
            "two members never share a bucket"
        );
    }

    fn db_failure() -> DbError {
        DbError::from(momo_db::sqlx::Error::PoolClosed)
    }

    /// Run the audit bookkeeping with a stand-in writer that counts its calls.
    async fn audit_with(
        limiter: &SlidingWindowRateLimiter,
        key: &str,
        reservation: u64,
        now: Instant,
        write_succeeds: bool,
        calls: &AtomicUsize,
    ) -> bool {
        audit_denial_once(
            limiter,
            key,
            reservation,
            Duration::from_secs(60),
            now,
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                if write_succeeds {
                    Ok(())
                } else {
                    Err(db_failure())
                }
            },
        )
        .await
    }

    /// A caller that stays just over the limit is admitted once for every request that
    /// ages out, and each admission resets the burst marker — so "one row per burst"
    /// alone is up to `limit` rows a window. The audit slot is what makes it one.
    #[tokio::test]
    async fn a_committed_audit_row_closes_the_slot_even_when_the_burst_restarts() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let (key, calls, t0) = ("write:send:m", AtomicUsize::new(0), Instant::now());
        let at = |millis: u64| t0 + Duration::from_millis(millis);

        assert!(limiter.check_at(key, 2, window, at(0)).allowed);
        assert!(limiter.check_at(key, 2, window, at(10_000)).allowed);
        let first = limiter.check_at(key, 2, window, at(11_000));
        assert!(!first.allowed);
        let reservation = first
            .log_reservation
            .expect("the first denial owns the marker");
        assert!(audit_with(&limiter, key, reservation, at(11_000), true, &calls).await);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // The oldest request ages out, the key admits one and the marker resets: the next
        // denial is a NEW burst, inside the window the audit slot already covers.
        assert!(limiter.check_at(key, 2, window, at(60_500)).allowed);
        let restarted = limiter.check_at(key, 2, window, at(60_600));
        assert!(!restarted.allowed);
        assert!(restarted.should_log, "the limiter calls this a new burst");
        let again = restarted.log_reservation.expect("a new marker");
        assert!(
            !audit_with(&limiter, key, again, at(60_600), true, &calls).await,
            "…and the slot refuses a second row in the same window"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "the writer never ran");

        // A window after the row committed (11 s + 60 s) the slot is open again.
        assert!(limiter.check_at(key, 2, window, at(71_500)).allowed);
        let next = limiter.check_at(key, 2, window, at(71_600));
        assert!(next.should_log);
        assert!(
            audit_with(
                &limiter,
                key,
                next.log_reservation.expect("a marker"),
                at(71_600),
                true,
                &calls
            )
            .await
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// A row that did not commit must not count as recorded: the burst's marker is handed
    /// back so the next denial retries it, and the slot stays open for that retry.
    #[tokio::test]
    async fn a_failed_audit_row_hands_the_marker_back_and_leaves_the_slot_open() {
        let limiter = SlidingWindowRateLimiter::new();
        let window = Duration::from_secs(60);
        let (key, calls, t0) = ("write:upload:m", AtomicUsize::new(0), Instant::now());

        assert!(limiter.check_at(key, 1, window, t0).allowed);
        let denied = limiter.check_at(key, 1, window, t0);
        let reservation = denied.log_reservation.expect("first denial");
        assert!(!audit_with(&limiter, key, reservation, t0, false, &calls).await);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let retry = limiter.check_at(key, 1, window, t0);
        assert!(
            retry.should_log,
            "the marker came back, so the same burst's next denial carries the retry"
        );
        assert!(
            audit_with(
                &limiter,
                key,
                retry.log_reservation.expect("a marker"),
                t0,
                true,
                &calls
            )
            .await,
            "a failure did not close the slot, so the retry wrote"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(
            !limiter.check_at(key, 1, window, t0).should_log,
            "a committed row keeps its marker: the rest of the burst logs nothing"
        );
    }
}
