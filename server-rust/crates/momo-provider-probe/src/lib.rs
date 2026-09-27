//! 「연결 확인」 — one bounded, read-only provider call per hop (#2960).
//!
//! `POST /v1/provider/link/test` used to stop short of the network and answer
//! `probe_not_run` for every configured hop, because `momo-server` links no HTTP
//! client (invariant #2). This crate is how it gets one without getting *any*
//! client: the only operation is [`ProviderProbe::probe`], and the only
//! requests it can issue are
//!
//! | credential | request | why this one |
//! |---|---|---|
//! | bearer (OpenAI, xAI, any OpenAI-compatible) | `GET {base}/models`, `Authorization: Bearer` | free, authenticated, lists what the key can use |
//! | bearer on `openrouter.ai` | `GET {base}/key`, `Authorization: Bearer` | OpenRouter's `/models` is **public** — it would call a wrong key a success. `/key` is authenticated and is the balance source AI 계정 Q5 names |
//! | Anthropic key (`anthropic-key` kind) | `GET {base}/models`, `x-api-key` + `anthropic-version` | Messages API's own model list; no Authorization header, as the wire requires |
//!
//! No completion is ever sent: a provider link carries no model id, so a
//! "1 token" call would have to invent one. A base URL without `/models` is
//! reported as the status it answered with.
//!
//! ## What comes back
//!
//! A [`ProbeReport`]: one of five outcomes, a machine reason from the vocabulary
//! the settings panel already renders, and **only numbers the provider itself
//! stated** — the model count from the list body (withheld when the list says it
//! is paginated), the rate-limit headers (`x-ratelimit-*`,
//! `anthropic-ratelimit-*`, `retry-after`), and OpenRouter's key `limit` /
//! `limit_remaining` / `usage`. No response body, no header value that is not a
//! parsed number, and no transport error text leaves this crate — so a provider
//! that echoes the key back in its error has nowhere to put it.
//!
//! ## What guards the socket
//!
//! [`momo_egress::EgressGuard`] — the #2852 egress policy on every resolved
//! address, no redirects, no proxy, and a deadline on every DNS lookup. It is
//! the same plumbing the agent-worker's provider client uses (#2976), so the
//! probe and a real turn cannot disagree about which hosts are reachable. A name that resolves (now, or on the connect-time lookup) to a
//! private, loopback, link-local or metadata address is refused before connect
//! and reported as `provider_egress_denied`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use momo_settings::{EgressDenied, EgressPolicy, RATE_LIMITED_REASON, UNREACHABLE_REASON};
use sha2::{Digest, Sha256};

use momo_egress::EgressGuard;
pub use momo_egress::{HostLookup, SystemLookup};

/// 401/403 — the provider refused the stored key. Already in the panel's
/// vocabulary (`chainModel.ts:probeReasonCopy`).
pub const AUTH_FAILED_REASON: &str = "provider_auth_failed";
/// The egress guard refused the address; nothing was sent.
pub const EGRESS_DENIED_REASON: &str = "provider_egress_denied";
/// A 2xx that is not the shape the endpoint documents — typically a base URL
/// that points at a website rather than an API.
pub const INVALID_RESPONSE_REASON: &str = "provider_invalid_response";

/// `anthropic-version` sent with the Anthropic model list (ADR-0147 증보
/// 2026-09-27 D1 — the same value the Messages wire sends).
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// A models page is small; this bounds what a hostile endpoint can make the api
/// buffer.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// The credential the hop would present, chosen by the sealed envelope's kind —
/// never by the host name.
#[derive(Clone)]
pub enum ProbeCredential {
    Bearer(String),
    AnthropicKey(String),
}

impl std::fmt::Debug for ProbeCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeCredential::Bearer(_) => f.write_str("Bearer(<redacted>)"),
            ProbeCredential::AnthropicKey(_) => f.write_str("AnthropicKey(<redacted>)"),
        }
    }
}

impl ProbeCredential {
    fn kind(&self) -> &'static str {
        match self {
            ProbeCredential::Bearer(_) => "bearer",
            ProbeCredential::AnthropicKey(_) => "anthropic-key",
        }
    }

    fn secret(&self) -> &str {
        match self {
            ProbeCredential::Bearer(secret) | ProbeCredential::AnthropicKey(secret) => secret,
        }
    }
}

/// One hop to check.
#[derive(Debug, Clone)]
pub struct ProbeTarget {
    pub base_url: String,
    pub credential: ProbeCredential,
}

impl ProbeTarget {
    /// The per-link throttle key. A digest over (kind, base URL, secret), so a
    /// rotated key or an edited URL is a new link that may be probed at once,
    /// while the secret itself is never a map key or a log field.
    pub fn cache_key(&self, position: i32) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"momo.provider_probe.v1\0");
        hasher.update(self.credential.kind().as_bytes());
        hasher.update(b"\0");
        hasher.update(self.base_url.as_bytes());
        hasher.update(b"\0");
        hasher.update(self.credential.secret().as_bytes());
        let digest = hex::encode(hasher.finalize());
        format!("{position}:{}", &digest[..32])
    }
}

/// The five classes the settings panel distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// Authenticated and answered in the documented shape.
    Ok,
    /// 401/403 — the key was refused.
    Rejected,
    /// No answer: DNS, connect, TLS, timeout — or the egress guard refused it.
    Unreachable,
    /// 429.
    RateLimited,
    /// Anything else: another status, or a 2xx we cannot read as the endpoint.
    Unknown,
}

impl ProbeOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeOutcome::Ok => "ok",
            ProbeOutcome::Rejected => "rejected",
            ProbeOutcome::Unreachable => "unreachable",
            ProbeOutcome::RateLimited => "rate_limited",
            ProbeOutcome::Unknown => "unknown",
        }
    }
}

/// Which request ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeMethod {
    /// `GET {base}/models`
    Models,
    /// `GET {base}/key` (OpenRouter)
    Key,
}

impl ProbeMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeMethod::Models => "models",
            ProbeMethod::Key => "key",
        }
    }
}

/// Rate-limit numbers as the provider's headers stated them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RateLimitNumbers {
    /// `x-ratelimit` or `anthropic-ratelimit` — the header family they came from.
    pub source: &'static str,
    pub requests_limit: Option<u64>,
    pub requests_remaining: Option<u64>,
    pub tokens_limit: Option<u64>,
    pub tokens_remaining: Option<u64>,
}

/// OpenRouter `GET /key` → `data.limit` / `data.limit_remaining` / `data.usage`
/// (credits, USD). `limit: null` means the key has no cap.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KeyCredit {
    pub limit: Option<f64>,
    pub limit_remaining: Option<f64>,
    pub usage: Option<f64>,
}

/// The whole result of one probe. Carries no text from the provider.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeReport {
    pub outcome: ProbeOutcome,
    /// `None` exactly when `outcome` is `Ok`.
    pub reason: Option<String>,
    pub method: ProbeMethod,
    /// `None` when no response arrived.
    pub http_status: Option<u16>,
    pub latency_ms: u64,
    pub model_count: Option<u64>,
    pub rate_limit: Option<RateLimitNumbers>,
    pub retry_after_seconds: Option<u64>,
    pub credit: Option<KeyCredit>,
}

impl ProbeReport {
    fn failed(method: ProbeMethod, outcome: ProbeOutcome, reason: &str) -> ProbeReport {
        ProbeReport {
            outcome,
            reason: Some(reason.to_string()),
            method,
            http_status: None,
            latency_ms: 0,
            model_count: None,
            rate_limit: None,
            retry_after_seconds: None,
            credit: None,
        }
    }
}

/// The sealed surface momo-server calls.
#[async_trait]
pub trait ProviderProbe: Send + Sync {
    async fn probe(&self, target: &ProbeTarget) -> ProbeReport;
}

/// The production probe: the guarded client and nothing else.
pub struct GuardedProviderProbe {
    /// `None` when the guarded client could not be built. There is no
    /// unguarded fallback: a probe that cannot be guarded reports unreachable.
    client: Option<reqwest::Client>,
    guard: EgressGuard,
    /// The per-hop bound. It covers the pre-request DNS lookup as well as the
    /// request itself (review M1): `getaddrinfo` has no deadline of its own.
    /// The guard carries the same value as its lookup deadline; the wrap in
    /// `probe` is kept as the hop-level bound around the whole precheck.
    timeout: Duration,
}

impl GuardedProviderProbe {
    /// System DNS. `policy` is the api's egress policy — the same inputs the
    /// agent-worker reads (`AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`,
    /// `AGENT_PROVIDER_LOCAL_HOSTS`, the operator's own `HERMES_BASE_URL` host).
    pub fn new(policy: EgressPolicy, timeout: Duration) -> GuardedProviderProbe {
        GuardedProviderProbe::with_lookup(policy, Arc::new(SystemLookup), timeout)
    }

    /// Tests inject a scripted resolver; production passes [`SystemLookup`].
    pub fn with_lookup(
        policy: EgressPolicy,
        lookup: Arc<dyn HostLookup>,
        timeout: Duration,
    ) -> GuardedProviderProbe {
        let guard = EgressGuard::new(policy, lookup, timeout);
        let client = guard
            .client(
                reqwest::Client::builder()
                    .timeout(timeout)
                    .connect_timeout(timeout.min(Duration::from_secs(5))),
            )
            .map_err(|_| {
                tracing::warn!(
                    "provider probe client build failed; probes will report unreachable"
                );
            })
            .ok();
        GuardedProviderProbe {
            client,
            guard,
            timeout,
        }
    }
}

/// `{base}/models`, or `{base}/key` on OpenRouter, plus the host to vet.
fn plan(base_url: &str) -> Option<(ProbeMethod, String, String)> {
    let parsed = reqwest::Url::parse(base_url.trim()).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    // A trailing dot is the same host (review nit 1): `openrouter.ai.` must not
    // fall back to the public `/models`.
    let method = if host.trim_end_matches('.') == "openrouter.ai" {
        ProbeMethod::Key
    } else {
        ProbeMethod::Models
    };
    let base = base_url.trim().trim_end_matches('/');
    let url = match method {
        ProbeMethod::Models => format!("{base}/models"),
        ProbeMethod::Key => format!("{base}/key"),
    };
    Some((method, url, host))
}

#[async_trait]
impl ProviderProbe for GuardedProviderProbe {
    async fn probe(&self, target: &ProbeTarget) -> ProbeReport {
        let Some((method, url, host)) = plan(&target.base_url) else {
            return ProbeReport::failed(
                ProbeMethod::Models,
                ProbeOutcome::Unreachable,
                UNREACHABLE_REASON,
            );
        };
        match tokio::time::timeout(self.timeout, self.guard.precheck_host(&host)).await {
            Ok(Ok(())) => {}
            Ok(Err(denied)) => return denied_report(method, denied),
            // A lookup that outlives the hop's budget is an unanswered hop.
            Err(_) => {
                return ProbeReport::failed(method, ProbeOutcome::Unreachable, UNREACHABLE_REASON)
            }
        }
        let Some(client) = self.client.as_ref() else {
            return ProbeReport::failed(method, ProbeOutcome::Unreachable, UNREACHABLE_REASON);
        };

        let request = client.get(&url).header("accept", "application/json");
        let request = match &target.credential {
            ProbeCredential::Bearer(secret) => request.bearer_auth(secret),
            ProbeCredential::AnthropicKey(secret) => request
                .header("x-api-key", secret)
                .header("anthropic-version", ANTHROPIC_VERSION),
        };

        let started = Instant::now();
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                // The error's Display is never used: it would carry the URL, and
                // a probe result carries only labels.
                return match momo_egress::denied_in_chain(&error) {
                    Some(denied) => denied_report(method, denied),
                    None => {
                        ProbeReport::failed(method, ProbeOutcome::Unreachable, UNREACHABLE_REASON)
                    }
                };
            }
        };
        let latency_ms = started.elapsed().as_millis() as u64;
        let status = response.status().as_u16();
        let rate_limit = rate_limit_numbers(response.headers());
        let retry_after_seconds = header_number(response.headers(), "retry-after");

        let mut report = ProbeReport {
            outcome: ProbeOutcome::Unknown,
            reason: None,
            method,
            http_status: Some(status),
            latency_ms,
            model_count: None,
            rate_limit,
            retry_after_seconds,
            credit: None,
        };

        match status {
            200..=299 => {
                let body = match read_capped(&mut response).await {
                    BodyRead::Complete(bytes) => Some(bytes),
                    BodyRead::TooLarge => None,
                    // Timeout or reset mid-body (review nit 3): the provider
                    // stopped answering, which is availability, not shape.
                    BodyRead::Failed => {
                        report.outcome = ProbeOutcome::Unreachable;
                        report.reason = Some(UNREACHABLE_REASON.to_string());
                        return report;
                    }
                };
                let parsed = body
                    .as_deref()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok());
                match parsed.as_ref().and_then(|value| read_body(method, value)) {
                    Some((model_count, credit)) => {
                        report.outcome = ProbeOutcome::Ok;
                        report.model_count = model_count;
                        report.credit = credit;
                    }
                    None => {
                        report.outcome = ProbeOutcome::Unknown;
                        report.reason = Some(INVALID_RESPONSE_REASON.to_string());
                    }
                }
            }
            401 | 403 => {
                report.outcome = ProbeOutcome::Rejected;
                report.reason = Some(AUTH_FAILED_REASON.to_string());
            }
            429 => {
                report.outcome = ProbeOutcome::RateLimited;
                report.reason = Some(RATE_LIMITED_REASON.to_string());
            }
            other => {
                report.outcome = ProbeOutcome::Unknown;
                report.reason = Some(format!("provider_status_{other}"));
            }
        }
        report
    }
}

fn denied_report(method: ProbeMethod, denied: EgressDenied) -> ProbeReport {
    match denied {
        // An unresolvable name is availability, not policy.
        EgressDenied::NoAddress => {
            ProbeReport::failed(method, ProbeOutcome::Unreachable, UNREACHABLE_REASON)
        }
        EgressDenied::NonPublicAddress => {
            ProbeReport::failed(method, ProbeOutcome::Unreachable, EGRESS_DENIED_REASON)
        }
    }
}

enum BodyRead {
    Complete(Vec<u8>),
    TooLarge,
    Failed,
}

async fn read_capped(response: &mut reqwest::Response) -> BodyRead {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return BodyRead::TooLarge;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return BodyRead::Complete(body),
            Err(_) => return BodyRead::Failed,
        }
    }
}

/// `Some((model_count, credit))` when the body is the documented shape.
#[allow(clippy::type_complexity)]
fn read_body(
    method: ProbeMethod,
    value: &serde_json::Value,
) -> Option<(Option<u64>, Option<KeyCredit>)> {
    let data = value.get("data")?;
    match method {
        ProbeMethod::Models => {
            let models = data.as_array()?;
            // Anthropic paginates (`has_more`); a first-page length is not the
            // number of models, so it is not reported as one.
            let paginated = value
                .get("has_more")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Some(((!paginated).then_some(models.len() as u64), None))
        }
        ProbeMethod::Key => {
            let data = data.as_object()?;
            let number = |key: &str| data.get(key).and_then(serde_json::Value::as_f64);
            Some((
                None,
                Some(KeyCredit {
                    limit: number("limit"),
                    limit_remaining: number("limit_remaining"),
                    usage: number("usage"),
                }),
            ))
        }
    }
}

fn header_number(headers: &reqwest::header::HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.trim().parse::<u64>().ok()
}

fn rate_limit_numbers(headers: &reqwest::header::HeaderMap) -> Option<RateLimitNumbers> {
    let families: [(&'static str, [&str; 4]); 2] = [
        (
            "anthropic-ratelimit",
            [
                "anthropic-ratelimit-requests-limit",
                "anthropic-ratelimit-requests-remaining",
                "anthropic-ratelimit-tokens-limit",
                "anthropic-ratelimit-tokens-remaining",
            ],
        ),
        (
            "x-ratelimit",
            [
                "x-ratelimit-limit-requests",
                "x-ratelimit-remaining-requests",
                "x-ratelimit-limit-tokens",
                "x-ratelimit-remaining-tokens",
            ],
        ),
    ];
    families.into_iter().find_map(|(source, [rl, rr, tl, tr])| {
        let numbers = RateLimitNumbers {
            source,
            requests_limit: header_number(headers, rl),
            requests_remaining: header_number(headers, rr),
            tokens_limit: header_number(headers, tl),
            tokens_remaining: header_number(headers, tr),
        };
        (numbers.requests_limit.is_some()
            || numbers.requests_remaining.is_some()
            || numbers.tokens_limit.is_some()
            || numbers.tokens_remaining.is_some())
        .then_some(numbers)
    })
}

// ---------------------------------------------------------------------------
// per-link throttle
// ---------------------------------------------------------------------------

/// The last report per link, reused inside `ttl` instead of dialling again.
///
/// In-process, like the api's other limiters: N replicas mean N calls per
/// window at most, which is still bounded.
pub struct ProbeCache {
    ttl: Duration,
    entries: Mutex<HashMap<String, (Instant, i64, ProbeReport)>>,
}

impl ProbeCache {
    pub fn new(ttl: Duration) -> ProbeCache {
        ProbeCache {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// The cached `(probed_at_ms, report)` for `key`, if still fresh.
    pub fn get(&self, key: &str) -> Option<(i64, ProbeReport)> {
        let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        entries
            .get(key)
            .filter(|(stored, _, _)| stored.elapsed() < self.ttl)
            .map(|(_, probed_at_ms, report)| (*probed_at_ms, report.clone()))
    }

    pub fn put(&self, key: String, probed_at_ms: i64, report: ProbeReport) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let ttl = self.ttl;
        entries.retain(|_, (stored, _, _)| stored.elapsed() < ttl);
        entries.insert(key, (Instant::now(), probed_at_ms, report));
    }
}

#[cfg(test)]
mod tests;
