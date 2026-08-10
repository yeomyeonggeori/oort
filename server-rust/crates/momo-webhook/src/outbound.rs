//! The outbound destination policy — a port of Swift
//! `services/OutboundHTTPPolicy/.../OutboundHTTPPolicy.swift`.
//!
//! An event subscription is an operator-supplied URL that a server-side process
//! will fetch. That is the textbook SSRF shape, and the two-stage answer here is
//! the Swift one, kept whole because both halves are load bearing:
//!
//! 1. [`validated_url`] — the *literal* must be an absolute http(s) URL with no
//!    embedded credentials and no fragment, and its host must not itself be a
//!    private/loopback/reserved literal. Production additionally requires https.
//! 2. [`validated_resolved_addresses`] — **every** DNS answer must be public,
//!    and the checked answers are returned so the caller can pin its connection
//!    to one of them. Checking one answer and connecting to another is the
//!    classic rebinding hole; returning the list is what closes it.
//!
//! Both run at save time (the admin gets a 400 instead of a row that can never
//! deliver) **and again in the sender at delivery time**, because a name that
//! resolved publicly on Tuesday can resolve to 169.254.169.254 on Wednesday.
//! Neither call site is redundant; the first is UX, the second is the guard.
//!
//! The denied set is transcribed rather than reasoned about: `0.0.0.0/8`,
//! `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`,
//! `192.0.2/24`, `192.168/16`, `198.18/16`, `198.19/16`, `198.51/16`,
//! `203.0.113/24`, and everything from `224/4` up; for v6 the unspecified and
//! loopback addresses, multicast, unique-local, link-local, the documentation
//! prefix `2001:db8::/32`, and v4-mapped addresses re-checked as v4.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Why a destination was refused. The variants exist separately because the
/// route turns each into different Korean copy — "use HTTPS" and "that address
/// is private" are different things for an admin to fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OutboundUrlError {
    #[error("webhook URL must be an absolute HTTP(S) URL without credentials or fragment")]
    InvalidUrl,
    #[error("webhook URL must use HTTPS")]
    InsecureHttp,
    #[error("webhook URL resolves to a private or reserved address")]
    PrivateAddress,
    #[error("webhook URL host could not be resolved")]
    ResolutionFailed,
}

/// The parsed, accepted destination. Kept as parts rather than a URL type so
/// this crate needs no URL dependency: the sender rebuilds the request from
/// exactly these fields, and the host is what both the SSRF check and the
/// `target_host` audit column read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundUrl {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
    /// Path + optional `?query`, already including the leading `/`.
    pub path_and_query: String,
    /// The absolute URL, normalised exactly as it will be requested.
    pub absolute: String,
}

impl OutboundUrl {
    /// `host:port` for the DNS lookup, with the scheme's default port when the
    /// URL named none.
    pub fn authority(&self) -> String {
        let port = self
            .port
            .unwrap_or(if self.scheme == "https" { 443 } else { 80 });
        format!("{}:{}", self.host, port)
    }
}

/// How the guard learns a host's addresses. A trait so tests can drive a
/// rebinding scenario without a resolver that answers differently on demand.
#[allow(async_fn_in_trait)]
pub trait HostResolver: Send + Sync {
    /// Every address `authority` (`host:port`) resolves to, in any order.
    async fn resolve(&self, authority: &str) -> Result<Vec<IpAddr>, OutboundUrlError>;
}

/// `tokio::net::lookup_host` and nothing else.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemHostResolver;

impl HostResolver for SystemHostResolver {
    async fn resolve(&self, authority: &str) -> Result<Vec<IpAddr>, OutboundUrlError> {
        let authority = authority.to_string();
        let addresses = tokio::net::lookup_host(authority)
            .await
            .map_err(|_| OutboundUrlError::ResolutionFailed)?
            .map(|socket| socket.ip())
            .collect::<Vec<_>>();
        if addresses.is_empty() {
            return Err(OutboundUrlError::ResolutionFailed);
        }
        Ok(addresses)
    }
}

/// Maximum destination length — `event_subscription_url_ck` (`1..2048`). Checked
/// here as well so an over-long URL is a 400 rather than a constraint violation
/// rendered as a 500.
pub const MAX_URL_BYTES: usize = 2_048;

/// Stage one: the literal.
///
/// `allow_development_http` is the ONLY way an `http://` destination is accepted
/// and it is off everywhere but a local instance — the caller passes
/// `MOMO_ENV=local && MOMO_EVENT_SUBSCRIPTION_ALLOW_HTTP=1`, the same pair the
/// Swift relay reads (`relay/OutboxRelay/.../Config.swift:66-68`).
pub fn validated_url(
    raw: &str,
    allow_development_http: bool,
) -> Result<OutboundUrl, OutboundUrlError> {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_URL_BYTES {
        return Err(OutboundUrlError::InvalidUrl);
    }
    // A fragment can never be sent on the wire, so a URL carrying one is a
    // destination whose author is describing something other than what will be
    // requested. Swift refuses it; refusing it here keeps the row honest.
    if value.contains('#') {
        return Err(OutboundUrlError::InvalidUrl);
    }
    let (scheme, rest) = value
        .split_once("://")
        .ok_or(OutboundUrlError::InvalidUrl)?;
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "https" => {}
        "http" => {
            if !allow_development_http {
                return Err(OutboundUrlError::InsecureHttp);
            }
        }
        _ => return Err(OutboundUrlError::InvalidUrl),
    }

    let (authority, path_and_query) = match rest.find(['/', '?']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    // Embedded credentials would be replayed on every retry and would sit in
    // plaintext in a column an admin can read back. There is no supported way to
    // authenticate an outbound destination that way, so it is refused rather
    // than silently stripped.
    if authority.contains('@') || authority.is_empty() {
        return Err(OutboundUrlError::InvalidUrl);
    }

    let (host, port) = split_authority(authority)?;
    if host.is_empty() {
        return Err(OutboundUrlError::InvalidUrl);
    }
    if is_denied_address(&host) {
        return Err(OutboundUrlError::PrivateAddress);
    }

    let path_and_query = if path_and_query.is_empty() {
        "/".to_string()
    } else if let Some(stripped) = path_and_query.strip_prefix('?') {
        format!("/?{stripped}")
    } else {
        path_and_query.to_string()
    };
    let absolute = match port {
        Some(port) => format!(
            "{scheme}://{authority_host}:{port}{path_and_query}",
            authority_host = display_host(&host)
        ),
        None => format!("{scheme}://{}{path_and_query}", display_host(&host)),
    };
    Ok(OutboundUrl {
        scheme,
        host,
        port,
        path_and_query,
        absolute,
    })
}

/// Re-add the brackets an IPv6 literal needs in a URL. `host` is stored
/// unbracketed because that is what the address check and the audit column want.
fn display_host(host: &str) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn split_authority(authority: &str) -> Result<(String, Option<u16>), OutboundUrlError> {
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 literal: `[::1]` or `[::1]:8443`.
        let (host, tail) = rest.split_once(']').ok_or(OutboundUrlError::InvalidUrl)?;
        let port = match tail {
            "" => None,
            other => Some(
                other
                    .strip_prefix(':')
                    .ok_or(OutboundUrlError::InvalidUrl)?
                    .parse()
                    .map_err(|_| OutboundUrlError::InvalidUrl)?,
            ),
        };
        return Ok((host.to_ascii_lowercase(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => Ok((
            host.to_ascii_lowercase(),
            Some(port.parse().map_err(|_| OutboundUrlError::InvalidUrl)?),
        )),
        None => Ok((authority.to_ascii_lowercase(), None)),
    }
}

/// Stage two: resolve, refuse if **any** answer is non-public, and return the
/// checked answers sorted so the caller pins to one it has verified.
///
/// "Any", not "the first": a name with one public and one private A record is a
/// rebinding attack with the work already done for it.
pub async fn validated_resolved_addresses<R: HostResolver>(
    url: &OutboundUrl,
    resolver: &R,
) -> Result<Vec<IpAddr>, OutboundUrlError> {
    if is_denied_address(&url.host) {
        return Err(OutboundUrlError::PrivateAddress);
    }
    let mut addresses = resolver.resolve(&url.authority()).await?;
    if addresses.is_empty() {
        return Err(OutboundUrlError::ResolutionFailed);
    }
    if addresses.iter().any(is_denied_ip) {
        return Err(OutboundUrlError::PrivateAddress);
    }
    addresses.sort();
    addresses.dedup();
    Ok(addresses)
}

/// Is this host string — a name or a literal — one we refuse outright?
///
/// A *name* is only refused when it is `localhost`/`*.localhost`; every other
/// name is decided by [`validated_resolved_addresses`] after DNS, because a name
/// tells you nothing about where it points.
pub fn is_denied_address(raw: &str) -> bool {
    let host = raw
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(address) => is_denied_ip(&address),
        Err(_) => false,
    }
}

fn is_denied_ip(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_denied_v4(v4),
        IpAddr::V6(v6) => is_denied_v6(v6),
    }
}

fn is_denied_v4(address: &Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19 || b == 51))
        || (a == 203 && b == 0 && c == 113)
}

fn is_denied_v6(address: &Ipv6Addr) -> bool {
    let bytes = address.octets();
    if bytes.iter().all(|byte| *byte == 0) {
        return true; // ::
    }
    if bytes[..15].iter().all(|byte| *byte == 0) && bytes[15] == 1 {
        return true; // ::1
    }
    if bytes[0] == 0xff || (bytes[0] & 0xfe) == 0xfc {
        return true; // multicast / unique-local
    }
    if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80 {
        return true; // link-local
    }
    if bytes[..4] == [0x20, 0x01, 0x0d, 0xb8] {
        return true; // 2001:db8::/32 documentation
    }
    if bytes[..10].iter().all(|byte| *byte == 0) && bytes[10] == 0xff && bytes[11] == 0xff {
        // v4-mapped: decide it as the v4 address it really is.
        return is_denied_v4(&Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15]));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedResolver(Vec<IpAddr>);

    impl HostResolver for FixedResolver {
        async fn resolve(&self, _authority: &str) -> Result<Vec<IpAddr>, OutboundUrlError> {
            Ok(self.0.clone())
        }
    }

    fn ip(raw: &str) -> IpAddr {
        raw.parse().expect("test address")
    }

    #[test]
    fn production_requires_https_and_local_development_may_opt_out() {
        assert_eq!(
            validated_url("http://example.com/hook", false).unwrap_err(),
            OutboundUrlError::InsecureHttp
        );
        assert!(validated_url("http://example.com/hook", true).is_ok());
        assert!(validated_url("https://example.com/hook", false).is_ok());
        assert_eq!(
            validated_url("ftp://example.com/hook", true).unwrap_err(),
            OutboundUrlError::InvalidUrl
        );
        assert_eq!(
            validated_url("/hook", true).unwrap_err(),
            OutboundUrlError::InvalidUrl
        );
    }

    #[test]
    fn credentials_and_fragments_are_refused_rather_than_stripped() {
        assert_eq!(
            validated_url("https://user:pass@example.com/hook", false).unwrap_err(),
            OutboundUrlError::InvalidUrl
        );
        assert_eq!(
            validated_url("https://example.com/hook#frag", false).unwrap_err(),
            OutboundUrlError::InvalidUrl
        );
    }

    #[test]
    fn a_private_literal_never_reaches_dns() {
        for raw in [
            "https://127.0.0.1/hook",
            "https://localhost/hook",
            "https://metrics.localhost/hook",
            "https://10.1.2.3/hook",
            "https://169.254.169.254/latest/meta-data",
            "https://172.16.0.1/hook",
            "https://192.168.1.1/hook",
            "https://[::1]/hook",
            "https://[fd00::1]/hook",
            "https://[fe80::1]/hook",
            "https://[::ffff:127.0.0.1]/hook",
        ] {
            assert_eq!(
                validated_url(raw, false).unwrap_err(),
                OutboundUrlError::PrivateAddress,
                "{raw} must be refused before any lookup"
            );
        }
    }

    /// The rebinding case, and the reason the guard checks every answer.
    #[tokio::test]
    async fn one_private_answer_poisons_the_whole_name() {
        let url = validated_url("https://rebind.example/hook", false).expect("public literal");
        let mixed = FixedResolver(vec![ip("93.184.216.34"), ip("169.254.169.254")]);
        assert_eq!(
            validated_resolved_addresses(&url, &mixed)
                .await
                .unwrap_err(),
            OutboundUrlError::PrivateAddress,
            "checking only the first answer is the whole rebinding hole"
        );

        let public = FixedResolver(vec![ip("93.184.216.34")]);
        assert_eq!(
            validated_resolved_addresses(&url, &public).await.unwrap(),
            vec![ip("93.184.216.34")]
        );
    }

    #[tokio::test]
    async fn an_empty_answer_is_a_resolution_failure_not_an_allow() {
        let url = validated_url("https://void.example/hook", false).expect("public literal");
        assert_eq!(
            validated_resolved_addresses(&url, &FixedResolver(vec![]))
                .await
                .unwrap_err(),
            OutboundUrlError::ResolutionFailed
        );
    }

    #[test]
    fn the_absolute_form_is_what_will_actually_be_requested() {
        let url = validated_url("https://Example.COM:8443/a/b?x=1", false).expect("valid");
        assert_eq!(url.host, "example.com");
        assert_eq!(url.port, Some(8443));
        assert_eq!(url.path_and_query, "/a/b?x=1");
        assert_eq!(url.absolute, "https://example.com:8443/a/b?x=1");
        assert_eq!(url.authority(), "example.com:8443");

        let bare = validated_url("https://example.com", false).expect("valid");
        assert_eq!(bare.absolute, "https://example.com/");
        assert_eq!(bare.authority(), "example.com:443");

        let v6 = validated_url("https://[2606:4700::1111]/hook", false).expect("valid");
        assert_eq!(v6.host, "2606:4700::1111");
        assert_eq!(v6.absolute, "https://[2606:4700::1111]/hook");
    }

    #[test]
    fn the_length_bound_matches_the_check_constraint() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(
            validated_url(&long, false).unwrap_err(),
            OutboundUrlError::InvalidUrl,
            "an over-long URL must be a 400, not a constraint violation rendered as a 500"
        );
    }
}
