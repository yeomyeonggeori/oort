//! The provider-boundary vocabulary: mode, effective config, endpoint
//! redaction, and the base-URL gate.
//!
//! Port of Swift `Config.swift:502-700` (`AgentProviderMode` /
//! `AgentProviderConfig`) plus `AgentRoutes.validatedBaseURL` (:199-247), which
//! is the *write* gate the two provider surfaces share.
//!
//! ## Why the URL work is hand-rolled
//!
//! Swift leans on `URLComponents`. Rust has no such type in `std`, and the two
//! things this module actually needs — "does this string carry userinfo / query
//! / fragment" and "what is its host" — are precisely the questions a permissive
//! URL parser answers *generously*, which is the wrong direction for a gate.
//! [`split_url`] is therefore deliberately strict: anything it cannot parse into
//! exactly `scheme://host[:port][/path]` is rejected rather than normalised into
//! something the operator did not type.

/// `AgentProviderMode` (Swift :502-513). The three values migration 039's CHECK
/// constraint accepts, and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderMode {
    LocalMock,
    InternalHostMock,
    ExternalHermes,
}

impl ProviderMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderMode::LocalMock => "local-mock",
            ProviderMode::InternalHostMock => "internal-host-mock",
            ProviderMode::ExternalHermes => "external-hermes",
        }
    }

    pub fn from_label(label: &str) -> Option<ProviderMode> {
        Some(match label.trim().to_ascii_lowercase().as_str() {
            "local-mock" => ProviderMode::LocalMock,
            "internal-host-mock" => ProviderMode::InternalHostMock,
            "external-hermes" => ProviderMode::ExternalHermes,
            _ => return None,
        })
    }

    /// Swift `AgentProviderMode.parse` (:508-512): an unrecognised value falls
    /// back to `local-mock`. A typo must never silently select the external
    /// boundary.
    pub fn parse_env(raw: Option<&str>) -> ProviderMode {
        raw.and_then(ProviderMode::from_label)
            .unwrap_or(ProviderMode::LocalMock)
    }
}

/// The effective provider configuration (Swift `AgentProviderConfig` :514-533),
/// narrowed to the fields the settings surface reads.
///
/// `model` / `agent_handle` / `display_name` are deliberately absent: they are
/// agent-runtime facts, and no route in this batch projects them. `bearer` is
/// present because [`ResolvedProvider`](crate::link::ResolvedProvider) has to
/// carry it to the cascade — it is never serialized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderConfig {
    pub mode: ProviderMode,
    pub base_url: String,
    pub bearer: String,
    pub allow_local_loopback: bool,
}

impl Default for ProviderConfig {
    /// The Swift defaults — i.e. what a process that sets none of the three keys
    /// resolves to. Written as "read an empty environment" rather than as a
    /// second literal so the two can never drift.
    fn default() -> Self {
        ProviderConfig::from_env(|_| None)
    }
}

impl ProviderConfig {
    /// Swift `AgentProviderConfig.load` (:522-533) for the three keys this
    /// surface resolves. The defaults are Swift's, so an instance that sets
    /// nothing reports the same `local-mock` posture on either server.
    pub fn from_env(read: impl Fn(&str) -> Option<String>) -> ProviderConfig {
        ProviderConfig {
            mode: ProviderMode::parse_env(read("AGENT_PROVIDER_MODE").as_deref()),
            base_url: read("HERMES_BASE_URL").unwrap_or_else(|| "http://localhost:8088/v1".into()),
            bearer: read("HERMES_API_KEY").unwrap_or_else(|| "dev-insecure-hermes-bearer".into()),
            allow_local_loopback: matches!(
                read("AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK")
                    .map(|value| value.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1") | Some("true") | Some("yes") | Some("on")
            ),
        }
    }

    pub fn endpoint_label(&self) -> String {
        redacted_endpoint_label(&self.base_url)
    }

    /// Swift `keyConfigured` (:546-549): present **and** not a placeholder. A
    /// dev default counts as unconfigured, which is what keeps a shipped
    /// `dev-insecure-…` from reading as a working provider.
    pub fn key_configured(&self) -> bool {
        !self.bearer.trim().is_empty() && !is_unsafe_secret(&self.bearer)
    }

    /// Swift `availability` (:551-558).
    pub fn availability(&self) -> &'static str {
        match self.mode {
            ProviderMode::LocalMock | ProviderMode::InternalHostMock => "mock",
            ProviderMode::ExternalHermes => {
                if self.validation_errors(true, None).is_empty() {
                    "available"
                } else {
                    "degraded"
                }
            }
        }
    }

    /// Swift `validationErrors` (:597-635), message for message.
    ///
    /// The message strings are part of the contract: the settings panel shows
    /// them verbatim as `diagnostics`, so an operator reading the Rust server
    /// gets the sentence they already know from the Swift one.
    pub fn validation_errors(
        &self,
        strict_environment: bool,
        allow_local_loopback: Option<bool>,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        let local_loopback_allowed = allow_local_loopback.unwrap_or(self.allow_local_loopback);
        let trimmed = self.base_url.trim();
        if trimmed.is_empty() {
            errors.push("HERMES_BASE_URL is missing".to_string());
        } else if self.mode == ProviderMode::ExternalHermes || strict_environment {
            match split_url(trimmed) {
                None => {
                    errors.push("HERMES_BASE_URL must be an absolute HTTP(S) URL".to_string());
                    errors.extend(self.key_errors());
                    return errors;
                }
                Some(parts) => {
                    let is_loopback = is_allowed_loopback_host(&parts.host);
                    if parts.scheme == "http" {
                        if !(local_loopback_allowed && is_loopback) {
                            errors.push(
                                "HERMES_BASE_URL must use https:// unless \
                                 AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 targets localhost/127.0.0.1 \
                                 in local mode"
                                    .to_string(),
                            );
                        }
                    } else if parts.scheme != "https" {
                        errors.push("HERMES_BASE_URL must use http:// or https://".to_string());
                    }
                    if is_mock_host(&parts.host) {
                        errors.push(
                            "HERMES_BASE_URL must not point at mock-hermes for external-hermes"
                                .to_string(),
                        );
                    } else if is_local_or_mock_host(&parts.host)
                        && !(local_loopback_allowed && is_loopback)
                    {
                        errors.push(
                            "HERMES_BASE_URL must not point at localhost for external-hermes \
                             unless AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 in local mode"
                                .to_string(),
                        );
                    }
                }
            }
        }
        errors.extend(self.key_errors());
        errors
    }

    fn key_errors(&self) -> Vec<String> {
        if self.bearer.trim().is_empty() {
            return vec!["HERMES_API_KEY is missing".to_string()];
        }
        if is_unsafe_secret(&self.bearer) {
            return vec!["HERMES_API_KEY uses a placeholder/dev value".to_string()];
        }
        Vec::new()
    }
}

/// Swift `requiresStrictExternalProvider` (:637-644). Mirrors
/// `momo_server::config::requires_strict_secrets`, which answers the same
/// question for the *boot* secrets; kept here so this crate does not depend on
/// the binary it serves.
pub fn requires_strict_external_provider(environment_name: &str) -> bool {
    matches!(
        environment_name.trim().to_ascii_lowercase().as_str(),
        "staging" | "prod" | "production" | "internal-host"
    )
}

/// Swift `isUnsafeSecret` (:646-659), list for list.
pub fn is_unsafe_secret(value: &str) -> bool {
    let lowered = value.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return true;
    }
    const RESERVED: [&str; 11] = [
        "password",
        "secret",
        "token",
        "default",
        "dev",
        "test",
        "staging",
        "prod",
        "production",
        "admin",
        "momo",
    ];
    if RESERVED.contains(&lowered.as_str()) {
        return true;
    }
    [
        "change-me",
        "changeme",
        "dev-insecure",
        "placeholder",
        "example",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

/// Swift `isLocalOrMockHost` (:661-669).
pub fn is_local_or_mock_host(host: &str) -> bool {
    let lowered = host.to_ascii_lowercase();
    matches!(
        lowered.as_str(),
        "localhost" | "127.0.0.1" | "0.0.0.0" | "::1"
    ) || lowered.contains("mock")
}

/// Swift `isAllowedLoopbackHost` (:671-676).
pub fn is_allowed_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

/// Swift `isMockHost` (:678-680).
pub fn is_mock_host(host: &str) -> bool {
    host.to_ascii_lowercase().contains("mock")
}

/// Swift `redactedEndpointLabel` (:688-700).
///
/// This is the ONLY projection of a base URL that may enter a response, an audit
/// row, or a log line: userinfo, query, and fragment are dropped because each of
/// them is a documented place operators paste keys into.
pub fn redacted_endpoint_label(raw: &str) -> String {
    match split_url(raw) {
        Some(parts) => parts.rebuild(),
        None => {
            if raw.is_empty() {
                "not configured".to_string()
            } else {
                "invalid url".to_string()
            }
        }
    }
}

/// Rejection reasons of the write-side base-URL gate, each carrying the Swift
/// message verbatim (`AgentRoutes.validatedBaseURL` :199-247).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BaseUrlInvalid {
    #[error("baseUrl must be an absolute HTTP(S) URL without userinfo, query, or fragment")]
    Shape,
    #[error("baseUrl must use http:// or https://")]
    Scheme,
    #[error("baseUrl must not target a mock provider host")]
    MockHost,
    #[error("loopback baseUrl requires local mode and AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1")]
    LoopbackNotAllowed,
    #[error("loopback baseUrl must include an explicit port")]
    LoopbackPortMissing,
    #[error("non-loopback baseUrl must use https://")]
    PlaintextRemote,
}

/// The write gate every stored provider base URL passes (Swift
/// `AgentRoutes.validatedBaseURL`).
///
/// Returns the **normalised** URL (lower-cased scheme and host), which is what
/// gets stored — so two operators typing `HTTPS://Api.Example.com/v1` and
/// `https://api.example.com/v1` cannot end up with two different rows meaning
/// the same endpoint.
pub fn validated_base_url(
    raw: &str,
    environment_name: &str,
    allow_local_loopback: bool,
) -> Result<String, BaseUrlInvalid> {
    let value = raw.trim();
    let parts = split_url(value).ok_or(BaseUrlInvalid::Shape)?;
    if parts.has_userinfo || parts.has_query || parts.has_fragment {
        return Err(BaseUrlInvalid::Shape);
    }
    if parts.scheme != "http" && parts.scheme != "https" {
        return Err(BaseUrlInvalid::Scheme);
    }
    if is_mock_host(&parts.host) {
        return Err(BaseUrlInvalid::MockHost);
    }

    let is_loopback = is_allowed_loopback_host(&parts.host);
    let strict = requires_strict_external_provider(environment_name);
    let loopback_allowed = allow_local_loopback && !strict && is_loopback;

    if is_loopback {
        if !loopback_allowed {
            return Err(BaseUrlInvalid::LoopbackNotAllowed);
        }
        if parts.port.is_none() {
            return Err(BaseUrlInvalid::LoopbackPortMissing);
        }
    } else if parts.scheme != "https" {
        return Err(BaseUrlInvalid::PlaintextRemote);
    }

    Ok(parts.rebuild())
}

/// The strict `scheme://host[:port][/path]` decomposition both gates share.
#[derive(Debug, PartialEq, Eq)]
struct UrlParts {
    scheme: String,
    /// Lower-cased, **without** IPv6 brackets so the host predicates
    /// (`::1`, `localhost`, …) compare against one spelling.
    host: String,
    /// The authority was a bracketed IPv6 literal, so rebuilding must restore
    /// the brackets — `https://::1:8443/v1` is not a URL.
    ipv6_literal: bool,
    port: Option<u16>,
    path: String,
    has_userinfo: bool,
    has_query: bool,
    has_fragment: bool,
}

impl UrlParts {
    /// The redacted, normalised spelling: scheme and host lower-cased, userinfo
    /// / query / fragment gone.
    fn rebuild(&self) -> String {
        let host = if self.ipv6_literal {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        let port = self.port.map(|port| format!(":{port}")).unwrap_or_default();
        format!("{}://{host}{port}{}", self.scheme, self.path)
    }
}

/// Split an absolute URL, or `None` when it is not one.
///
/// Strictness is the feature: a missing scheme, an empty host, a non-numeric
/// port, or a bracketed IPv6 literal that never closes are all `None` rather
/// than a best-effort guess, because every caller treats `None` as "refuse".
fn split_url(raw: &str) -> Option<UrlParts> {
    let value = raw.trim();
    let (scheme, rest) = value.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }

    // Authority ends at the first `/`, `?` or `#`.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    if authority.is_empty() {
        return None;
    }

    let has_userinfo = authority.contains('@');
    // Userinfo is rejected by the write gate, but the read-side redaction has to
    // be able to drop it, so parse past it either way.
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, after)| after);

    let (host, port_text, ipv6_literal) = if let Some(stripped) = host_port.strip_prefix('[') {
        // IPv6 literal: `[::1]` or `[::1]:8443`.
        let (inside, after) = stripped.split_once(']')?;
        let port = match after {
            "" => None,
            other => Some(other.strip_prefix(':')?),
        };
        (inside.to_string(), port, true)
    } else {
        match host_port.split_once(':') {
            Some((host, port)) => (host.to_string(), Some(port), false),
            None => (host_port.to_string(), None, false),
        }
    };
    if host.is_empty() {
        return None;
    }
    let port = match port_text {
        None => None,
        Some(text) => Some(text.parse::<u16>().ok()?),
    };

    let has_query = tail.contains('?');
    let has_fragment = tail.contains('#');
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let path = tail[..path_end].to_string();

    Some(UrlParts {
        scheme: scheme.to_ascii_lowercase(),
        host: host.to_ascii_lowercase(),
        ipv6_literal,
        port,
        path,
        has_userinfo,
        has_query,
        has_fragment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_mode_falls_back_to_the_mock_never_to_the_external_boundary() {
        assert_eq!(
            ProviderMode::parse_env(Some("EXTERNAL-HERMES")),
            ProviderMode::ExternalHermes
        );
        assert_eq!(
            ProviderMode::parse_env(Some("externl-hermes")),
            ProviderMode::LocalMock,
            "a typo must not select the external provider"
        );
        assert_eq!(ProviderMode::parse_env(None), ProviderMode::LocalMock);
    }

    /// The three places an operator pastes a key into a URL, all dropped.
    #[test]
    fn redaction_removes_userinfo_query_and_fragment() {
        assert_eq!(
            redacted_endpoint_label(
                "https://user:sk-live-secret@api.example.com:8443/v1?key=sk-live#f"
            ),
            "https://api.example.com:8443/v1"
        );
        assert_eq!(
            redacted_endpoint_label("https://api.example.com/v1"),
            "https://api.example.com/v1"
        );
        assert_eq!(redacted_endpoint_label(""), "not configured");
        assert_eq!(redacted_endpoint_label("api.example.com/v1"), "invalid url");
    }

    #[test]
    fn the_base_url_gate_refuses_every_credential_carrying_shape() {
        for (raw, expected) in [
            ("api.example.com/v1", BaseUrlInvalid::Shape),
            ("https://user:pw@api.example.com/v1", BaseUrlInvalid::Shape),
            ("https://api.example.com/v1?key=sk", BaseUrlInvalid::Shape),
            ("https://api.example.com/v1#frag", BaseUrlInvalid::Shape),
            ("ftp://api.example.com/v1", BaseUrlInvalid::Scheme),
            ("https://mock-hermes.internal/v1", BaseUrlInvalid::MockHost),
            ("http://api.example.com/v1", BaseUrlInvalid::PlaintextRemote),
        ] {
            assert_eq!(
                validated_base_url(raw, "local", true).expect_err(raw),
                expected,
                "{raw}"
            );
        }
    }

    #[test]
    fn loopback_needs_local_mode_the_flag_and_an_explicit_port() {
        assert_eq!(
            validated_base_url("http://127.0.0.1:8088/v1", "local", true).expect("allowed"),
            "http://127.0.0.1:8088/v1"
        );
        assert_eq!(
            validated_base_url("http://127.0.0.1:8088/v1", "local", false).expect_err("flag off"),
            BaseUrlInvalid::LoopbackNotAllowed
        );
        assert_eq!(
            validated_base_url("http://127.0.0.1:8088/v1", "prod", true).expect_err("prod"),
            BaseUrlInvalid::LoopbackNotAllowed,
            "a strict environment overrides the operator's local-loopback flag"
        );
        assert_eq!(
            validated_base_url("http://localhost/v1", "local", true).expect_err("no port"),
            BaseUrlInvalid::LoopbackPortMissing
        );
    }

    /// Storing the normalised form is what stops two rows meaning one endpoint.
    #[test]
    fn the_stored_url_is_normalised() {
        assert_eq!(
            validated_base_url("HTTPS://Api.Example.COM/v1", "local", false).expect("valid"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn a_dev_placeholder_key_never_counts_as_configured() {
        let config = ProviderConfig {
            mode: ProviderMode::ExternalHermes,
            base_url: "https://api.example.com/v1".into(),
            bearer: "dev-insecure-hermes-bearer".into(),
            allow_local_loopback: false,
        };
        assert!(!config.key_configured());
        assert_eq!(config.availability(), "degraded");
        assert!(config
            .validation_errors(true, None)
            .contains(&"HERMES_API_KEY uses a placeholder/dev value".to_string()));

        let real = ProviderConfig {
            bearer: "sk-live-9f2c4a".into(),
            ..config
        };
        assert!(real.key_configured());
        assert_eq!(real.availability(), "available");
        assert!(real.validation_errors(true, None).is_empty());
    }

    /// A mock mode reports `mock`, never `degraded` — a self-hosted default is
    /// not a broken instance.
    #[test]
    fn a_mock_mode_reports_mock_availability() {
        let config = ProviderConfig {
            mode: ProviderMode::LocalMock,
            base_url: "http://localhost:8088/v1".into(),
            bearer: "dev-insecure-hermes-bearer".into(),
            allow_local_loopback: false,
        };
        assert_eq!(config.availability(), "mock");
    }

    #[test]
    fn ipv6_authorities_keep_their_brackets_through_the_round_trip() {
        assert_eq!(
            redacted_endpoint_label("https://[2001:db8::1]:8443/v1"),
            "https://[2001:db8::1]:8443/v1",
            "dropping the brackets would emit a string that is no longer a URL"
        );
        assert_eq!(
            validated_base_url("http://[::1]:8088/v1", "local", true).expect("loopback v6"),
            "http://[::1]:8088/v1"
        );
    }

    #[test]
    fn the_env_defaults_are_the_swift_defaults() {
        let config = ProviderConfig::from_env(|_| None);
        assert_eq!(config.mode, ProviderMode::LocalMock);
        assert_eq!(config.base_url, "http://localhost:8088/v1");
        assert_eq!(config.bearer, "dev-insecure-hermes-bearer");
        assert!(!config.allow_local_loopback);
    }
}
