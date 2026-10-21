//! The co-hosted agent probe (#3883, ADR-0203 D2).
//!
//! One operator-declared host (`HERMES_BASE_URL`), two fixed read-only GETs:
//!
//! | step | request | why |
//! |---|---|---|
//! | health | `GET {origin}/health` | something answers on the declared address |
//! | models | `GET {origin}/v1/models` | an OpenAI-compatible server, and the bearer is right |
//!
//! plus, only when the caller asks (`with_toolsets`), `GET {origin}/v1/toolsets`
//! as a **warning signal** (ADR-0203 Q4 (b)). It is the server describing
//! itself, so it can raise a caution but it can never count as proof that the
//! tools are off.
//!
//! The paths are constants, never taken from the declared URL: the declared base
//! path may only be empty or `/v1`, otherwise nothing is dialled. There is no
//! caller-supplied path, no redirect (the guarded client follows none), and the
//! host is the declared one only. Like [`crate::ProviderProbe`], nothing that
//! comes back carries a response body, a header value or transport error text;
//! the toolsets step reports only which of three fixed names it saw.

use std::time::Instant;

use async_trait::async_trait;
use momo_settings::UNREACHABLE_REASON;

use super::{
    denied_report, read_capped, BodyRead, GuardedProviderProbe, ProbeMethod, ProbeOutcome,
    AUTH_FAILED_REASON, EGRESS_DENIED_REASON, INVALID_RESPONSE_REASON,
};

/// The declared base URL has a path other than empty or `/v1`; nothing was sent.
pub const COHOSTED_BASE_PATH_UNSUPPORTED: &str = "cohosted_base_path_unsupported";

const HEALTH_PATH: &str = "/health";
const MODELS_PATH: &str = "/v1/models";
const TOOLSETS_PATH: &str = "/v1/toolsets";
/// #4143 (ADR-0203 증보 2026-10-20 M2): the fourth fixed read-only GET, issued
/// only by [`CohostedAgentProbe::read_model_options`] and only on the same host.
/// It lives at the origin, **not** under `/v1`.
const MODEL_OPTIONS_PATH: &str = "/api/model/options";
/// Providers / models kept from one options answer; the rest is dropped.
const MAX_OPTION_PROVIDERS: usize = 32;

/// The toolsets ADR-0203 D6 requires off. Only these names are ever reported.
const DANGEROUS_TOOLSETS: [&str; 3] = ["terminal", "code_execution", "browser"];

/// What to dial: the operator's declared env link.
#[derive(Clone)]
pub struct CohostedTarget {
    pub base_url: String,
    pub bearer: String,
}

impl std::fmt::Debug for CohostedTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CohostedTarget")
            .field("bearer", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// What `GET /v1/toolsets` said, reduced to a caution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolsetsSignal {
    /// The request was not made.
    NotChecked,
    /// The endpoint is absent or refused (404/405/401/…): no signal either way.
    Unavailable,
    /// A 2xx whose body this crate could not read as a list of names.
    Unreadable,
    /// The body names none of the three. **Not proof** the tools are off.
    NoneListed,
    /// The body names at least one of `terminal`, `code_execution`, `browser`.
    Listed(Vec<&'static str>),
}

impl ToolsetsSignal {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolsetsSignal::NotChecked => "not_checked",
            ToolsetsSignal::Unavailable => "unavailable",
            ToolsetsSignal::Unreadable => "unreadable",
            ToolsetsSignal::NoneListed => "none_listed",
            ToolsetsSignal::Listed(_) => "dangerous_listed",
        }
    }
}

/// The whole result. Carries no text from the agent.
#[derive(Debug, Clone, PartialEq)]
pub struct CohostedReport {
    /// `Ok` only when both required steps answered in their documented shape.
    pub outcome: ProbeOutcome,
    /// `None` exactly when `outcome` is `Ok`.
    pub reason: Option<String>,
    /// Requests that left this process (0 when the declared URL was unusable).
    pub requests_sent: u8,
    pub health_status: Option<u16>,
    pub models_status: Option<u16>,
    pub model_count: Option<u64>,
    /// Sanitized `data[].id` values (see [`crate::model_ids`]).
    pub model_ids: Vec<String>,
    pub toolsets: ToolsetsSignal,
    pub latency_ms: u64,
}

impl CohostedReport {
    fn refused(outcome: ProbeOutcome, reason: &str) -> CohostedReport {
        CohostedReport {
            outcome,
            reason: Some(reason.to_string()),
            requests_sent: 0,
            health_status: None,
            models_status: None,
            model_count: None,
            model_ids: Vec::new(),
            toolsets: ToolsetsSignal::NotChecked,
            latency_ms: 0,
        }
    }
}

/// One `(provider, model)` pair, both sanitized (see [`provider_slug`] and
/// `momo_settings::sanitized_model_id`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelChoice {
    pub provider: String,
    pub model: String,
}

/// One **logged-in** provider and the models Hermes lists for it, in Hermes's
/// own order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderModels {
    pub provider: String,
    pub models: Vec<String>,
}

/// `GET /api/model/options`, reduced to slugs. Carries no text from the agent
/// beyond sanitized provider slugs and model ids, and **only providers Hermes
/// marks `authenticated: true`**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelOptionsReport {
    /// `Ok` only when the answer had the documented shape.
    pub outcome: ProbeOutcome,
    pub reason: Option<String>,
    /// Requests that left this process (0 when nothing was dialled).
    pub requests_sent: u8,
    /// Hermes's current provider and model (its top-level `provider` / `model`),
    /// when both are usable slugs **and** the provider is one of `providers`
    /// (logged in).
    pub current: Option<ModelChoice>,
    pub providers: Vec<ProviderModels>,
}

impl ModelOptionsReport {
    pub fn unavailable(outcome: ProbeOutcome, reason: &str) -> ModelOptionsReport {
        ModelOptionsReport {
            outcome,
            reason: Some(reason.to_string()),
            requests_sent: 0,
            current: None,
            providers: Vec::new(),
        }
    }

    /// Whether `provider` is logged in and lists `model`. The one membership
    /// question the model-choice route asks.
    pub fn lists(&self, provider: &str, model: &str) -> bool {
        self.providers
            .iter()
            .any(|p| p.provider == provider && p.models.iter().any(|m| m == model))
    }
}

/// A Hermes provider slug (`anthropic`, `openai-codex`, `openrouter`): lowercase
/// alphanumerics with `.`, `_`, `-`, at most 64 bytes. Matches migration 144's
/// CHECK, so a slug that passes here can always be stored.
pub fn provider_slug(raw: &str) -> Option<String> {
    let slug = raw.trim();
    let first = slug.chars().next()?;
    if slug.len() > 64 || !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return None;
    }
    slug.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        .then(|| slug.to_string())
}

/// Parse an options body. Pure, so the shape is tested without a socket.
///
/// `{"model": "...", "provider": "...", "providers": [{"slug": "...",
/// "authenticated": true, "models": ["..."] }]}` — a model entry may also be an
/// object with an `id`. A provider whose `authenticated` is anything but the
/// boolean `true` is dropped, as is one with no usable model. `secret` is the
/// bearer: an id repeating any 8-byte piece of it is dropped like in
/// [`crate::model_ids`].
pub fn parse_model_options(value: &serde_json::Value, secret: &str) -> ModelOptionsReport {
    let mut report = ModelOptionsReport::unavailable(ProbeOutcome::Ok, "");
    report.reason = None;
    let Some(rows) = value.get("providers").and_then(serde_json::Value::as_array) else {
        return ModelOptionsReport::unavailable(ProbeOutcome::Unknown, INVALID_RESPONSE_REASON);
    };
    let leaks = |id: &str| crate::id_repeats_secret(id, secret);
    for row in rows {
        if report.providers.len() == MAX_OPTION_PROVIDERS {
            break;
        }
        if row.get("authenticated") != Some(&serde_json::Value::Bool(true)) {
            continue;
        }
        let Some(provider) = row
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .and_then(provider_slug)
        else {
            continue;
        };
        if report.providers.iter().any(|p| p.provider == provider) {
            continue;
        }
        let mut models: Vec<String> = Vec::new();
        for item in row
            .get("models")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            let raw = item
                .as_str()
                .or_else(|| item.get("id").and_then(serde_json::Value::as_str));
            let Some(id) = raw.and_then(momo_settings::sanitized_model_id) else {
                continue;
            };
            if leaks(&id) || models.contains(&id) {
                continue;
            }
            if models.len() == momo_settings::MAX_PROBE_MODEL_IDS {
                break;
            }
            models.push(id);
        }
        if !models.is_empty() {
            report.providers.push(ProviderModels { provider, models });
        }
    }
    report.current = match (
        value
            .get("provider")
            .and_then(serde_json::Value::as_str)
            .and_then(provider_slug),
        value
            .get("model")
            .and_then(serde_json::Value::as_str)
            .and_then(momo_settings::sanitized_model_id),
    ) {
        // A current provider Hermes does not mark logged in (or that lists no
        // usable model) is not a route anyone can answer on: connect must not pin
        // it (#4159 L1).
        (Some(provider), Some(model))
            if report.providers.iter().any(|p| p.provider == provider) =>
        {
            Some(ModelChoice { provider, model })
        }
        _ => None,
    };
    report
}

/// The sealed surface momo-server calls for the co-hosted agent.
#[async_trait]
pub trait CohostedAgentProbe: Send + Sync {
    async fn probe_cohosted(&self, target: &CohostedTarget, with_toolsets: bool) -> CohostedReport;

    /// `GET {origin}/api/model/options` on the declared host (#4143). The default
    /// dials nothing, so a probe that predates this method keeps compiling and
    /// reports "no options" (callers then behave exactly as before #4143).
    async fn read_model_options(&self, _target: &CohostedTarget) -> ModelOptionsReport {
        ModelOptionsReport::unavailable(ProbeOutcome::Unknown, INVALID_RESPONSE_REASON)
    }
}

/// `(origin, host)` for the declared URL, or `None` when the base path is not
/// empty / `/v1` or the URL has parts that could redirect a request (userinfo,
/// query, fragment).
pub(crate) fn origin_of(base_url: &str) -> Option<(String, String)> {
    let parsed = reqwest::Url::parse(base_url.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    if !matches!(parsed.path().trim_end_matches('/'), "" | "/v1") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    // The write gate (`validated_base_url`) reads the URL with momo-settings' own
    // splitter, and the socket is opened for the host reqwest reads. They must
    // name the same host, or a spelling one of them reads differently could let a
    // URL the gate approved dial somewhere else. A disagreement dials nothing.
    let gate_host = momo_settings::url_host(base_url)?;
    if host.trim_matches(['[', ']']) != gate_host {
        return None;
    }
    // `host_str` returns an IPv6 literal already bracketed.
    let origin = match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    };
    Some((origin, host))
}

enum Step {
    /// A transport failure or an egress refusal: no HTTP answer. `sent` is
    /// whether a request left the process (an egress refusal sends nothing).
    NoAnswer {
        reason: &'static str,
        sent: bool,
    },
    Answered {
        status: u16,
        body: BodyRead,
    },
}

impl GuardedProviderProbe {
    async fn cohosted_get(&self, url: &str, host: &str, bearer: &str) -> Step {
        match tokio::time::timeout(self.timeout, self.guard.precheck_host(host)).await {
            Ok(Ok(())) => {}
            Ok(Err(denied)) => {
                let report = denied_report(ProbeMethod::Models, denied);
                let reason = if report.reason.as_deref() == Some(EGRESS_DENIED_REASON) {
                    EGRESS_DENIED_REASON
                } else {
                    UNREACHABLE_REASON
                };
                return Step::NoAnswer {
                    reason,
                    sent: false,
                };
            }
            Err(_) => {
                return Step::NoAnswer {
                    reason: UNREACHABLE_REASON,
                    sent: false,
                }
            }
        }
        let Some(client) = self.client.as_ref() else {
            return Step::NoAnswer {
                reason: UNREACHABLE_REASON,
                sent: false,
            };
        };
        let mut response = match client
            .get(url)
            .header("accept", "application/json")
            .bearer_auth(bearer)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return match momo_egress::denied_in_chain(&error) {
                    Some(_) => Step::NoAnswer {
                        reason: EGRESS_DENIED_REASON,
                        sent: false,
                    },
                    None => Step::NoAnswer {
                        reason: UNREACHABLE_REASON,
                        sent: true,
                    },
                };
            }
        };
        let status = response.status().as_u16();
        let body = if (200..300).contains(&status) {
            read_capped(&mut response).await
        } else {
            BodyRead::Complete(Vec::new())
        };
        Step::Answered { status, body }
    }
}

fn classify(status: u16) -> (ProbeOutcome, Option<String>) {
    match status {
        200..=299 => (ProbeOutcome::Ok, None),
        401 | 403 => (ProbeOutcome::Rejected, Some(AUTH_FAILED_REASON.to_string())),
        429 => (
            ProbeOutcome::RateLimited,
            Some(momo_settings::RATE_LIMITED_REASON.to_string()),
        ),
        other => (
            ProbeOutcome::Unknown,
            Some(format!("provider_status_{other}")),
        ),
    }
}

/// An object whose `enabled` is exactly boolean `false`.
fn is_switched_off(value: &serde_json::Value) -> bool {
    value.get("enabled") == Some(&serde_json::Value::Bool(false))
}

/// Which of the three dangerous names the body mentions — as an object key or a
/// string value anywhere in the JSON. The shape of `/v1/toolsets` is not
/// documented to this crate, so it reads leniently and reports only fixed names.
fn dangerous_names(value: &serde_json::Value, found: &mut Vec<&'static str>) {
    let mut note = |text: &str| {
        let text = text.trim();
        if let Some(name) = DANGEROUS_TOOLSETS.iter().find(|name| **name == text) {
            if !found.contains(name) {
                found.push(name);
            }
        }
    };
    fn walk(value: &serde_json::Value, note: &mut dyn FnMut(&str), depth: usize) {
        if depth > 6 {
            return;
        }
        match value {
            serde_json::Value::String(text) => note(text),
            serde_json::Value::Array(items) => items.iter().for_each(|v| walk(v, note, depth + 1)),
            serde_json::Value::Object(map) => {
                // Hermes lists every toolset with `enabled`; a JSON `false`
                // (exactly) means off. `true`, a missing field or any other
                // type stays conservative and is still reported.
                let off = is_switched_off(value);
                for (key, inner) in map {
                    if off && key == "name" && inner.is_string() {
                        continue;
                    }
                    if !is_switched_off(inner) {
                        note(key);
                    }
                    walk(inner, note, depth + 1);
                }
            }
            _ => {}
        }
    }
    walk(value, &mut note, 0);
}

#[async_trait]
impl CohostedAgentProbe for GuardedProviderProbe {
    async fn probe_cohosted(&self, target: &CohostedTarget, with_toolsets: bool) -> CohostedReport {
        let Some((origin, host)) = origin_of(&target.base_url) else {
            return CohostedReport::refused(ProbeOutcome::Unknown, COHOSTED_BASE_PATH_UNSUPPORTED);
        };
        let started = Instant::now();
        let mut report = CohostedReport::refused(ProbeOutcome::Unknown, INVALID_RESPONSE_REASON);

        // ---- step 1: /health ----
        let health = self
            .cohosted_get(&format!("{origin}{HEALTH_PATH}"), &host, &target.bearer)
            .await;
        let (health_outcome, health_reason) = match health {
            Step::NoAnswer { reason, sent } => {
                report.requests_sent = u8::from(sent);
                report.outcome = ProbeOutcome::Unreachable;
                report.reason = Some(reason.to_string());
                report.latency_ms = elapsed_ms(started);
                return report;
            }
            Step::Answered { status, .. } => {
                report.requests_sent = 1;
                report.health_status = Some(status);
                classify(status)
            }
        };

        // ---- step 2: /v1/models (always, once /health answered at all) ----
        match self
            .cohosted_get(&format!("{origin}{MODELS_PATH}"), &host, &target.bearer)
            .await
        {
            Step::NoAnswer { reason, sent } => {
                report.requests_sent += u8::from(sent);
                report.outcome = ProbeOutcome::Unreachable;
                report.reason = Some(reason.to_string());
                report.latency_ms = elapsed_ms(started);
                return report;
            }
            Step::Answered { status, body } => {
                report.requests_sent = 2;
                report.models_status = Some(status);
                let (models_outcome, models_reason) = classify(status);
                if models_outcome == ProbeOutcome::Ok {
                    let parsed = match body {
                        BodyRead::Complete(bytes) => {
                            serde_json::from_slice::<serde_json::Value>(&bytes).ok()
                        }
                        _ => None,
                    };
                    match parsed
                        .as_ref()
                        .and_then(|value| value.get("data")?.as_array().map(|a| (value, a.len())))
                    {
                        Some((value, len)) => {
                            let paginated = value
                                .get("has_more")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false);
                            report.model_count = (!paginated).then_some(len as u64);
                            report.model_ids = crate::model_ids(value, &target.bearer).0;
                            if health_outcome == ProbeOutcome::Ok {
                                report.outcome = ProbeOutcome::Ok;
                                report.reason = None;
                            } else {
                                report.outcome = health_outcome;
                                report.reason = health_reason;
                            }
                        }
                        None => {
                            report.outcome = ProbeOutcome::Unknown;
                            report.reason = Some(INVALID_RESPONSE_REASON.to_string());
                        }
                    }
                } else {
                    report.outcome = models_outcome;
                    report.reason = models_reason;
                }
            }
        }

        // ---- optional step 3: /v1/toolsets, a caution only ----
        report.toolsets = ToolsetsSignal::NotChecked;
        if with_toolsets && report.outcome == ProbeOutcome::Ok {
            report.toolsets = match self
                .cohosted_get(&format!("{origin}{TOOLSETS_PATH}"), &host, &target.bearer)
                .await
            {
                Step::NoAnswer { sent, .. } => {
                    report.requests_sent += u8::from(sent);
                    ToolsetsSignal::Unavailable
                }
                Step::Answered { status, body } if (200..300).contains(&status) => {
                    report.requests_sent += 1;
                    match body {
                        BodyRead::Complete(bytes) => {
                            match serde_json::from_slice::<serde_json::Value>(&bytes) {
                                Ok(value) => {
                                    let mut found = Vec::new();
                                    dangerous_names(&value, &mut found);
                                    if found.is_empty() {
                                        ToolsetsSignal::NoneListed
                                    } else {
                                        ToolsetsSignal::Listed(found)
                                    }
                                }
                                Err(_) => ToolsetsSignal::Unreadable,
                            }
                        }
                        _ => ToolsetsSignal::Unreadable,
                    }
                }
                Step::Answered { .. } => {
                    report.requests_sent += 1;
                    ToolsetsSignal::Unavailable
                }
            };
        }
        report.latency_ms = elapsed_ms(started);
        report
    }

    async fn read_model_options(&self, target: &CohostedTarget) -> ModelOptionsReport {
        let Some((origin, host)) = origin_of(&target.base_url) else {
            return ModelOptionsReport::unavailable(
                ProbeOutcome::Unknown,
                COHOSTED_BASE_PATH_UNSUPPORTED,
            );
        };
        match self
            .cohosted_get(
                &format!("{origin}{MODEL_OPTIONS_PATH}"),
                &host,
                &target.bearer,
            )
            .await
        {
            Step::NoAnswer { reason, sent } => {
                let mut report = ModelOptionsReport::unavailable(ProbeOutcome::Unreachable, reason);
                report.requests_sent = u8::from(sent);
                report
            }
            Step::Answered { status, body } => {
                let (outcome, reason) = classify(status);
                let mut report = if outcome == ProbeOutcome::Ok {
                    match body {
                        BodyRead::Complete(bytes) => {
                            match serde_json::from_slice::<serde_json::Value>(&bytes) {
                                Ok(value) => parse_model_options(&value, &target.bearer),
                                Err(_) => ModelOptionsReport::unavailable(
                                    ProbeOutcome::Unknown,
                                    INVALID_RESPONSE_REASON,
                                ),
                            }
                        }
                        _ => ModelOptionsReport::unavailable(
                            ProbeOutcome::Unknown,
                            INVALID_RESPONSE_REASON,
                        ),
                    }
                } else {
                    ModelOptionsReport::unavailable(outcome, reason.as_deref().unwrap_or(""))
                };
                report.requests_sent = 1;
                report
            }
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}
