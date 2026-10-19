//! The Hermes login relay client (#4079, ADR-0203 증보 2026-10-19 L4, ADR-0004 증보 7).
//!
//! `momo-server` links no HTTP client (invariant #2); this is the one hop it gets to the login relay
//! sidecar that runs **inside** the operator's Hermes container (`infra/hermes/login_relay.py`). The only
//! operations are the five the sidecar documents:
//!
//! | call | request |
//! |---|---|
//! | [`LoginRelayClient::start`] | `POST /v1/login` `{kind, target, operator}` |
//! | [`LoginRelayClient::complete`] | `POST /v1/login/{id}/complete` `{pasted}` + `X-Operator` |
//! | [`LoginRelayClient::poll`] | `GET /v1/login/{id}` + `X-Operator` |
//! | [`LoginRelayClient::cancel`] | `DELETE /v1/login/{id}` + `X-Operator` |
//! | [`LoginRelayClient::status`] | `GET /v1/status` |
//!
//! ## The 0-byte boundary
//!
//! What may cross this crate, and how it is held:
//!
//! * The **pasted** one-time code (Q1): a [`Pasted`] — `Debug`/`Serialize` print `<redacted>`, the only way
//!   to read it is [`Pasted::expose`], which this crate calls exactly once, to build the sidecar request body.
//! * The **device code** and the **authorization URL** come back in [`StartReply`] only; its `Debug`
//!   redacts both. They are never stored by this crate.
//! * **Tokens** (access/refresh) never reach this process at all: Hermes exchanges the code with the vendor
//!   and writes its own volume. Nothing here parses a token field.
//!
//! Like the other probes, nothing that comes back carries a response body, a header value or transport
//! error text: failures are one of [`RelayFailure`]'s fixed words. The guarded client has no redirects,
//! no proxy, and the #2852 egress guard on every resolved address.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use momo_egress::{EgressGuard, HostLookup, SystemLookup};
use momo_settings::EgressPolicy;
use serde::{Deserialize, Serialize};

use super::{read_capped, BodyRead};

/// `POST /v1/login` waits for the sidecar to find the URL (up to 30 s there).
pub const RELAY_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_PASTED: usize = 2048;
const MAX_TARGETS: usize = 64;

/// A one-time value an operator pasted back (the authorization code of a Claude or MCP login). The
/// **masking wrapper** of the red proof: it has no `Display`, and `Debug` and `Serialize` never print the
/// value, so a struct that holds it can be logged, traced or serialised without the code in the output.
/// Turning this into a plain `String` is what the 0-byte test is built to catch.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct Pasted(String);

impl Pasted {
    pub fn new(value: impl Into<String>) -> Pasted {
        Pasted(value.into())
    }

    /// Shape only (the sidecar knows `state` and the redirect, oort does not): non-empty, bounded, printable
    /// ASCII — no newline, NUL or other control character, so the sidecar's single stdin line stays one line.
    pub fn is_well_formed(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= MAX_PASTED
            && self.0.bytes().all(|b| (0x20..=0x7e).contains(&b))
    }

    /// The only reader. Its single caller builds the request to the sidecar.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Pasted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pasted(<redacted>)")
    }
}

impl Serialize for Pasted {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("<redacted>")
    }
}

/// Where the sidecar is and the key it wants. `Debug` never prints the key.
#[derive(Clone)]
pub struct RelayTarget {
    pub base_url: String,
    pub key: String,
}

impl std::fmt::Debug for RelayTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayTarget")
            .field("key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayKind {
    /// `provider/openai-codex`, `provider/anthropic`.
    Provider,
    /// `mcp/<server>`.
    Mcp,
}

impl RelayKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RelayKind::Provider => "provider",
            RelayKind::Mcp => "mcp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayMode {
    /// Codex: show the URL and the device code, then poll.
    Device,
    /// Claude and MCP apps: open the URL, paste back what the vendor page shows.
    Paste,
}

impl RelayMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RelayMode::Device => "device",
            RelayMode::Paste => "paste",
        }
    }
}

/// The answer to a start. `url` and `user_code` are for the screen, once: `Debug` prints neither.
#[derive(Clone, PartialEq, Eq)]
pub struct StartReply {
    pub login_id: String,
    pub mode: RelayMode,
    pub url: String,
    pub user_code: Option<String>,
    pub expires_at: i64,
}

impl std::fmt::Debug for StartReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartReply")
            .field("mode", &self.mode)
            .field("url", &"<redacted>")
            .field("user_code", &self.user_code.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// `pending | submitted | done | failed | expired | cancelled`, plus a reason from a fixed vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusReply {
    pub status: &'static str,
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetStatus {
    pub kind: RelayKind,
    pub target: String,
    pub connected: bool,
}

/// Why a relay call produced nothing usable. Fixed words only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayFailure {
    /// The address, key or a field this side would send is not usable; nothing was sent.
    Invalid,
    /// The egress guard refused the address; nothing was sent.
    EgressDenied,
    /// No HTTP answer (connect/timeout/reset).
    Unreachable,
    /// An answer that is not the documented shape.
    BadResponse,
    /// The sidecar refused: its HTTP status and a code from the sidecar's own vocabulary
    /// (`relay_error` for anything outside it).
    Refused { status: u16, code: &'static str },
}

impl RelayFailure {
    pub fn code(self) -> &'static str {
        match self {
            RelayFailure::Invalid => "relay_invalid",
            RelayFailure::EgressDenied => "relay_egress_denied",
            RelayFailure::Unreachable => "relay_unreachable",
            RelayFailure::BadResponse => "relay_bad_response",
            RelayFailure::Refused { code, .. } => code,
        }
    }
}

/// The sealed surface `momo-server` calls.
#[async_trait]
pub trait LoginRelayClient: Send + Sync {
    async fn start(
        &self,
        target: &RelayTarget,
        kind: RelayKind,
        name: &str,
        operator: &str,
    ) -> Result<StartReply, RelayFailure>;
    async fn complete(
        &self,
        target: &RelayTarget,
        login_id: &str,
        operator: &str,
        pasted: &Pasted,
    ) -> Result<StatusReply, RelayFailure>;
    async fn poll(
        &self,
        target: &RelayTarget,
        login_id: &str,
        operator: &str,
    ) -> Result<StatusReply, RelayFailure>;
    async fn cancel(
        &self,
        target: &RelayTarget,
        login_id: &str,
        operator: &str,
    ) -> Result<StatusReply, RelayFailure>;
    async fn status(&self, target: &RelayTarget) -> Result<Vec<TargetStatus>, RelayFailure>;
}

/// `true` for `^[A-Za-z0-9_-]{16,64}$` — what the sidecar issues; nothing else is put in a path.
pub fn is_login_id(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `^[A-Za-z0-9._@+-]{1,128}$` — the `X-Operator` value.
fn is_operator_label(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b'+' | b'-'))
}

/// `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn is_target_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= 64
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// The sidecar's own error vocabulary; anything else is `relay_error`.
fn known_code(code: &str) -> &'static str {
    const CODES: [&str; 22] = [
        "unauthorized",
        "invalid_target",
        "invalid_operator",
        "operator_required",
        "rate_limited",
        "login_in_progress",
        "start_failed",
        "parse_failed",
        "url_rejected",
        "start_timeout",
        "not_found",
        "operator_mismatch",
        "not_paste_mode",
        "not_pending",
        "already_submitted",
        "bad_paste",
        "extra_params",
        "redirect_mismatch",
        "state_mismatch",
        "bad_request",
        "too_large",
        "internal",
    ];
    CODES
        .iter()
        .find(|known| **known == code)
        .copied()
        .unwrap_or("relay_error")
}

fn known_status(status: &str) -> Option<&'static str> {
    [
        "pending",
        "submitted",
        "done",
        "failed",
        "expired",
        "cancelled",
    ]
    .into_iter()
    .find(|known| *known == status)
}

fn known_reason(reason: &str) -> &'static str {
    [
        "state_mismatch",
        "timeout",
        "vendor_denied",
        "exit_nonzero",
        "exit_unsubmitted",
        "cancelled",
        "too_many_attempts",
        "start_timeout",
        "parse_failed",
        "url_rejected",
    ]
    .into_iter()
    .find(|known| *known == reason)
    .unwrap_or("other")
}

/// `(origin, host)` for the relay address: `scheme://host[:port]` and nothing else (no path, userinfo,
/// query or fragment), and the host the write gate read is the host the socket is opened for.
fn relay_origin(base_url: &str) -> Option<(String, String)> {
    let parsed = reqwest::Url::parse(base_url.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let gate_host = momo_settings::url_host(base_url)?;
    if host.trim_matches(['[', ']']) != gate_host {
        return None;
    }
    let origin = match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    };
    Some((origin, host))
}

/// The guarded client. One per process; `main.rs` gives it the operator's egress policy plus the relay's
/// own host as an exact-match opt-in.
pub struct GuardedLoginRelay {
    client: Option<reqwest::Client>,
    guard: EgressGuard,
    timeout: Duration,
    /// A plain `http://127.0.0.1` / `localhost` authorization URL is displayable. Off in production; only the
    /// Docker harness (a mock authorization server on loopback) turns it on.
    allow_loopback_http_urls: bool,
}

impl GuardedLoginRelay {
    pub fn new(policy: EgressPolicy, timeout: Duration) -> GuardedLoginRelay {
        GuardedLoginRelay::with_lookup(policy, Arc::new(SystemLookup), timeout)
    }

    pub fn with_lookup(
        policy: EgressPolicy,
        lookup: Arc<dyn HostLookup>,
        timeout: Duration,
    ) -> GuardedLoginRelay {
        let guard = EgressGuard::new(policy, lookup, timeout);
        let client = guard
            .client(
                reqwest::Client::builder()
                    .timeout(timeout)
                    .connect_timeout(timeout.min(Duration::from_secs(5))),
            )
            .map_err(|_| {
                tracing::warn!("login relay client build failed; calls will report unreachable")
            })
            .ok();
        GuardedLoginRelay {
            client,
            guard,
            timeout,
            allow_loopback_http_urls: false,
        }
    }

    /// Test harness only (see the field).
    pub fn with_loopback_http_urls(mut self, allow: bool) -> GuardedLoginRelay {
        self.allow_loopback_http_urls = allow;
        self
    }

    async fn call(
        &self,
        target: &RelayTarget,
        method: reqwest::Method,
        path: &str,
        operator: Option<&str>,
        body: Option<Vec<u8>>,
    ) -> Result<(u16, serde_json::Value), RelayFailure> {
        let Some((origin, host)) = relay_origin(&target.base_url) else {
            return Err(RelayFailure::Invalid);
        };
        if let Some(operator) = operator {
            if !is_operator_label(operator) {
                return Err(RelayFailure::Invalid);
            }
        }
        match tokio::time::timeout(self.timeout, self.guard.precheck_host(&host)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(RelayFailure::EgressDenied),
            Err(_) => return Err(RelayFailure::Unreachable),
        }
        let Some(client) = self.client.as_ref() else {
            return Err(RelayFailure::Unreachable);
        };
        let mut request = client
            .request(method, format!("{origin}{path}"))
            .header("accept", "application/json")
            .bearer_auth(&target.key);
        if let Some(operator) = operator {
            request = request.header("x-operator", operator);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return Err(match momo_egress::denied_in_chain(&error) {
                    Some(_) => RelayFailure::EgressDenied,
                    None => RelayFailure::Unreachable,
                });
            }
        };
        let status = response.status().as_u16();
        let bytes = match read_capped(&mut response).await {
            BodyRead::Complete(bytes) => bytes,
            _ => return Err(RelayFailure::BadResponse),
        };
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| RelayFailure::BadResponse)?;
        if (200..300).contains(&status) {
            return Ok((status, value));
        }
        let code = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .map(known_code)
            .unwrap_or("relay_error");
        Err(RelayFailure::Refused { status, code })
    }

    fn status_reply(value: &serde_json::Value) -> Result<StatusReply, RelayFailure> {
        let status = value
            .get("status")
            .and_then(serde_json::Value::as_str)
            .and_then(known_status)
            .ok_or(RelayFailure::BadResponse)?;
        let reason = value
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(known_reason);
        Ok(StatusReply { status, reason })
    }
}

/// The hosts a provider login may send the operator to (the sidecar checks the same list; this is the second lock).
const PROVIDER_URL_HOSTS: [&str; 2] = ["auth.openai.com", "claude.ai"];

/// A URL the screen may open: `https` (a provider login: only the vendor hosts above; an app login: any host the
/// sidecar vetted against the configured server), or plain `http` to a loopback literal when the harness allows it.
/// Anything else (`javascript:`, `data:`, an `http://` remote, userinfo, whitespace or control characters in the raw
/// text that `Url::parse` would silently strip) is refused even though the sidecar already vetted it. Returns the
/// parsed, normalised spelling, never the raw string.
fn displayable_url(url: &str, kind: RelayKind, allow_loopback_http: bool) -> Option<String> {
    if url.len() > 2048 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let ok = match parsed.scheme() {
        "https" => {
            kind == RelayKind::Mcp
                || (PROVIDER_URL_HOSTS.contains(&host.as_str()) && parsed.port().is_none())
        }
        "http" => {
            allow_loopback_http
                && kind == RelayKind::Mcp
                && matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]")
        }
        _ => false,
    };
    ok.then(|| parsed.as_str().to_string())
}

#[async_trait]
impl LoginRelayClient for GuardedLoginRelay {
    async fn start(
        &self,
        target: &RelayTarget,
        kind: RelayKind,
        name: &str,
        operator: &str,
    ) -> Result<StartReply, RelayFailure> {
        if !is_target_name(name) || !is_operator_label(operator) {
            return Err(RelayFailure::Invalid);
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "kind": kind.as_str(),
            "target": name,
            "operator": operator,
        }))
        .map_err(|_| RelayFailure::Invalid)?;
        let (_, value) = self
            .call(target, reqwest::Method::POST, "/v1/login", None, Some(body))
            .await?;
        let login_id = value
            .get("login_id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| is_login_id(id))
            .ok_or(RelayFailure::BadResponse)?;
        let mode = match value.get("mode").and_then(serde_json::Value::as_str) {
            Some("device") => RelayMode::Device,
            Some("paste") => RelayMode::Paste,
            _ => return Err(RelayFailure::BadResponse),
        };
        let url = value
            .get("url")
            .and_then(serde_json::Value::as_str)
            .and_then(|url| displayable_url(url, kind, self.allow_loopback_http_urls))
            .ok_or(RelayFailure::BadResponse)?;
        let user_code = match value.get("user_code") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(code))
                if code.len() <= 32
                    && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') =>
            {
                Some(code.clone())
            }
            Some(_) => return Err(RelayFailure::BadResponse),
        };
        if (mode == RelayMode::Device) != user_code.is_some() {
            return Err(RelayFailure::BadResponse);
        }
        let expires_at = value
            .get("expires_at")
            .and_then(serde_json::Value::as_i64)
            .ok_or(RelayFailure::BadResponse)?;
        Ok(StartReply {
            login_id: login_id.to_string(),
            mode,
            url,
            user_code,
            expires_at,
        })
    }

    async fn complete(
        &self,
        target: &RelayTarget,
        login_id: &str,
        operator: &str,
        pasted: &Pasted,
    ) -> Result<StatusReply, RelayFailure> {
        if !is_login_id(login_id) || !pasted.is_well_formed() {
            return Err(RelayFailure::Invalid);
        }
        let body = serde_json::to_vec(&serde_json::json!({ "pasted": pasted.expose() }))
            .map_err(|_| RelayFailure::Invalid)?;
        let (_, value) = self
            .call(
                target,
                reqwest::Method::POST,
                &format!("/v1/login/{login_id}/complete"),
                Some(operator),
                Some(body),
            )
            .await?;
        GuardedLoginRelay::status_reply(&value)
    }

    async fn poll(
        &self,
        target: &RelayTarget,
        login_id: &str,
        operator: &str,
    ) -> Result<StatusReply, RelayFailure> {
        if !is_login_id(login_id) {
            return Err(RelayFailure::Invalid);
        }
        let (_, value) = self
            .call(
                target,
                reqwest::Method::GET,
                &format!("/v1/login/{login_id}"),
                Some(operator),
                None,
            )
            .await?;
        GuardedLoginRelay::status_reply(&value)
    }

    async fn cancel(
        &self,
        target: &RelayTarget,
        login_id: &str,
        operator: &str,
    ) -> Result<StatusReply, RelayFailure> {
        if !is_login_id(login_id) {
            return Err(RelayFailure::Invalid);
        }
        let (_, value) = self
            .call(
                target,
                reqwest::Method::DELETE,
                &format!("/v1/login/{login_id}"),
                Some(operator),
                None,
            )
            .await?;
        GuardedLoginRelay::status_reply(&value)
    }

    async fn status(&self, target: &RelayTarget) -> Result<Vec<TargetStatus>, RelayFailure> {
        let (_, value) = self
            .call(target, reqwest::Method::GET, "/v1/status", None, None)
            .await?;
        let list = value
            .get("targets")
            .and_then(serde_json::Value::as_array)
            .filter(|list| list.len() <= MAX_TARGETS)
            .ok_or(RelayFailure::BadResponse)?;
        let mut out = Vec::with_capacity(list.len());
        for item in list {
            let kind = match item.get("kind").and_then(serde_json::Value::as_str) {
                Some("provider") => RelayKind::Provider,
                Some("mcp") => RelayKind::Mcp,
                _ => return Err(RelayFailure::BadResponse),
            };
            let name = item
                .get("target")
                .and_then(serde_json::Value::as_str)
                .filter(|name| is_target_name(name))
                .ok_or(RelayFailure::BadResponse)?;
            let connected = item
                .get("connected")
                .and_then(serde_json::Value::as_bool)
                .ok_or(RelayFailure::BadResponse)?;
            out.push(TargetStatus {
                kind,
                target: name.to_string(),
                connected,
            });
        }
        Ok(out)
    }
}
