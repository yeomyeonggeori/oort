//! Realtime WebSocket URL advertisement (ADR-0110 + ADR-0167).
//!
//! Login/join/claim return `realtimeWebSocketUrl`. The process environment
//! names the *mode*:
//!
//! * an absolute `ws://` / `wss://` URL is advertised verbatim (ADR-0110 —
//!   production split-domain stays a boot-time constant);
//! * the sentinel `same-origin` derives the URL from the request's `Host` and
//!   `X-Forwarded-Proto` (ADR-0167 — self-host tunnels);
//! * anything else, including unset, keeps the historical loopback fallback.
//!
//! Derivation lives in **one** function ([`derive_same_origin_ws_url`]) so the
//! three advertisement sites cannot drift.

use axum::http::header;
use axum::http::HeaderMap;

/// What this process will put in `realtimeWebSocketUrl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealtimeAdvert {
    /// Boot-time absolute URL. Host / proto headers are ignored.
    Fixed(String),
    /// Per-request same-origin derivation (ADR-0167).
    SameOrigin,
}

/// Why same-origin derivation refused to produce a URL.
///
/// The HTTP layer maps every variant to an opaque 500 — the body must not echo
/// the Host header (it is a trust boundary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeAdvertError {
    MissingHost,
    InvalidHost,
    InvalidScheme,
}

impl std::fmt::Display for RealtimeAdvertError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingHost => {
                formatter.write_str("Host header is required for same-origin realtime")
            }
            Self::InvalidHost => formatter.write_str("Host header is not a safe authority"),
            Self::InvalidScheme => formatter.write_str("derived realtime URL is not ws/wss"),
        }
    }
}

impl std::error::Error for RealtimeAdvertError {}

impl std::fmt::Display for RealtimeAdvert {
    /// Boot log: Fixed prints the URL, SameOrigin prints the mode name.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fixed(url) => formatter.write_str(url),
            Self::SameOrigin => formatter.write_str("same-origin"),
        }
    }
}

impl From<String> for RealtimeAdvert {
    fn from(url: String) -> Self {
        Self::Fixed(url)
    }
}

impl From<&str> for RealtimeAdvert {
    fn from(url: &str) -> Self {
        Self::Fixed(url.to_string())
    }
}

impl RealtimeAdvert {
    /// Parse `MOMO_CENTRIFUGO_WS_URL` (already trimmed-empty-as-absent by the
    /// env helper). `same-origin` is case-insensitive; absolute ws/wss URLs are
    /// kept verbatim after trim; everything else is the loopback fallback.
    pub fn from_env_value(raw: Option<&str>, fallback_port: u16) -> Self {
        if let Some(raw) = raw {
            let trimmed = raw.trim();
            if trimmed.eq_ignore_ascii_case("same-origin") {
                return Self::SameOrigin;
            }
            let host = trimmed
                .strip_prefix("ws://")
                .or_else(|| trimmed.strip_prefix("wss://"))
                .map(|rest| rest.split('/').next().unwrap_or(""))
                .unwrap_or("");
            if !host.is_empty() {
                return Self::Fixed(trimmed.to_string());
            }
        }
        let port = if fallback_port == 0 {
            8000
        } else {
            fallback_port
        };
        Self::Fixed(format!("ws://127.0.0.1:{port}/connection/websocket"))
    }

    /// Advertise the URL for this request. Fixed ignores headers.
    pub fn advertise(
        &self,
        forwarded_proto: Option<&str>,
        host: Option<&str>,
        connection_scheme: Option<&str>,
    ) -> Result<String, RealtimeAdvertError> {
        match self {
            Self::Fixed(url) => Ok(url.clone()),
            Self::SameOrigin => derive_same_origin_ws_url(forwarded_proto, host, connection_scheme),
        }
    }

    /// Same as [`Self::advertise`], reading `Host` / `X-Forwarded-Proto` from
    /// the request. This is the only helper the three advertisement sites call.
    pub fn advertise_from_headers(
        &self,
        headers: &HeaderMap,
        connection_scheme: Option<&str>,
    ) -> Result<String, RealtimeAdvertError> {
        let forwarded_proto = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok());
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok());
        self.advertise(forwarded_proto, host, connection_scheme)
    }
}

/// Derive `ws(s)://<Host>/connection/websocket`.
///
/// * `X-Forwarded-Proto` `https` → `wss`, `http` → `ws`. First CSV hop wins.
/// * Missing / unusable proto falls back to `connection_scheme`, then `http`.
/// * `Host` is preserved including its port. CRLF and other control bytes are
///   rejected — Host is a trust boundary.
/// * The produced scheme is whitelisted: only `ws` / `wss` ever leave here.
pub fn derive_same_origin_ws_url(
    forwarded_proto: Option<&str>,
    host: Option<&str>,
    connection_scheme: Option<&str>,
) -> Result<String, RealtimeAdvertError> {
    let host = host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(RealtimeAdvertError::MissingHost)?;
    if !host_is_safe(host) {
        return Err(RealtimeAdvertError::InvalidHost);
    }
    let scheme = websocket_scheme(forwarded_proto, connection_scheme);
    if scheme != "ws" && scheme != "wss" {
        return Err(RealtimeAdvertError::InvalidScheme);
    }
    Ok(format!("{scheme}://{host}/connection/websocket"))
}

fn host_is_safe(host: &str) -> bool {
    if host.is_empty() || !host.is_ascii() {
        return false;
    }
    host.bytes().all(|byte| {
        byte > 0x20
            && byte < 0x7F
            && byte != b'/'
            && byte != b'\\'
            && byte != b'@'
            && byte != b'?'
            && byte != b'#'
            && byte != b'%'
    })
}

fn first_hop(raw: Option<&str>) -> Option<&str> {
    let token = raw?.split(',').next()?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn http_like_to_ws(token: &str) -> Option<&'static str> {
    match token.to_ascii_lowercase().as_str() {
        "https" | "wss" => Some("wss"),
        "http" | "ws" => Some("ws"),
        _ => None,
    }
}

fn websocket_scheme(
    forwarded_proto: Option<&str>,
    connection_scheme: Option<&str>,
) -> &'static str {
    first_hop(forwarded_proto)
        .and_then(http_like_to_ws)
        .or_else(|| first_hop(connection_scheme).and_then(http_like_to_ws))
        .unwrap_or("ws")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(host: &str, forwarded_proto: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).expect("host"));
        if let Some(proto) = forwarded_proto {
            headers.insert(
                "x-forwarded-proto",
                HeaderValue::from_str(proto).expect("proto"),
            );
        }
        headers
    }

    #[test]
    fn sentinel_parse_three_ways() {
        assert_eq!(
            RealtimeAdvert::from_env_value(Some("same-origin"), 8000),
            RealtimeAdvert::SameOrigin
        );
        assert_eq!(
            RealtimeAdvert::from_env_value(Some(" SAME-ORIGIN \n"), 8000),
            RealtimeAdvert::SameOrigin
        );
        assert_eq!(
            RealtimeAdvert::from_env_value(Some("wss://rt.oor7.com/connection/websocket"), 8000),
            RealtimeAdvert::Fixed("wss://rt.oor7.com/connection/websocket".to_string())
        );
        assert_eq!(
            RealtimeAdvert::from_env_value(
                Some("  ws://localhost:8088/connection/websocket  "),
                9000
            ),
            RealtimeAdvert::Fixed("ws://localhost:8088/connection/websocket".to_string())
        );
        assert_eq!(
            RealtimeAdvert::from_env_value(None, 8000),
            RealtimeAdvert::Fixed("ws://127.0.0.1:8000/connection/websocket".to_string())
        );
        assert_eq!(
            RealtimeAdvert::from_env_value(Some("http://example.com"), 4321),
            RealtimeAdvert::Fixed("ws://127.0.0.1:4321/connection/websocket".to_string())
        );
        assert_eq!(
            RealtimeAdvert::from_env_value(Some("ws://"), 8000),
            RealtimeAdvert::Fixed("ws://127.0.0.1:8000/connection/websocket".to_string())
        );
        assert_eq!(
            RealtimeAdvert::from_env_value(None, 0),
            RealtimeAdvert::Fixed("ws://127.0.0.1:8000/connection/websocket".to_string())
        );
    }

    #[test]
    fn derive_xfp_https_is_wss_and_http_is_ws() {
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("app.example"), None).unwrap(),
            "wss://app.example/connection/websocket"
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("http"), Some("app.example"), None).unwrap(),
            "ws://app.example/connection/websocket"
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("HTTPS"), Some("app.example"), None).unwrap(),
            "wss://app.example/connection/websocket"
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https, http"), Some("app.example"), None).unwrap(),
            "wss://app.example/connection/websocket"
        );
    }

    #[test]
    fn derive_preserves_host_port() {
        assert_eq!(
            derive_same_origin_ws_url(Some("http"), Some("localhost:8088"), None).unwrap(),
            "ws://localhost:8088/connection/websocket"
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("cursor.tailb1aad3.ts.net:8443"), None)
                .unwrap(),
            "wss://cursor.tailb1aad3.ts.net:8443/connection/websocket"
        );
    }

    #[test]
    fn derive_falls_back_to_connection_scheme_when_xfp_absent() {
        assert_eq!(
            derive_same_origin_ws_url(None, Some("app.example"), Some("https")).unwrap(),
            "wss://app.example/connection/websocket"
        );
        assert_eq!(
            derive_same_origin_ws_url(None, Some("app.example"), Some("http")).unwrap(),
            "ws://app.example/connection/websocket"
        );
        assert_eq!(
            derive_same_origin_ws_url(None, Some("app.example"), None).unwrap(),
            "ws://app.example/connection/websocket"
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("ftp"), Some("app.example"), Some("https")).unwrap(),
            "wss://app.example/connection/websocket"
        );
    }

    #[test]
    fn derive_rejects_missing_and_injected_hosts() {
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), None, None),
            Err(RealtimeAdvertError::MissingHost)
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("  "), None),
            Err(RealtimeAdvertError::MissingHost)
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("evil.example\r\nX-Injected: yes"), None),
            Err(RealtimeAdvertError::InvalidHost)
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("evil.example\nX-Injected: yes"), None),
            Err(RealtimeAdvertError::InvalidHost)
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("evil.example/path"), None),
            Err(RealtimeAdvertError::InvalidHost)
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("user@evil.example"), None),
            Err(RealtimeAdvertError::InvalidHost)
        );
        assert_eq!(
            derive_same_origin_ws_url(Some("https"), Some("evil.example\tfoo"), None),
            Err(RealtimeAdvertError::InvalidHost)
        );
    }

    #[test]
    fn derived_scheme_is_only_ws_or_wss() {
        for proto in [
            Some("https"),
            Some("http"),
            Some("wss"),
            Some("ws"),
            Some("HTTPS"),
            None,
        ] {
            let url = derive_same_origin_ws_url(proto, Some("h.example"), None).unwrap();
            assert!(
                url.starts_with("ws://") || url.starts_with("wss://"),
                "{url}"
            );
        }
    }

    #[test]
    fn red_proof_legacy_localhost_default_ignores_remote_host() {
        let advert =
            RealtimeAdvert::from_env_value(Some("ws://localhost:8088/connection/websocket"), 8000);
        let url = advert
            .advertise_from_headers(&headers("cursor.tailb1aad3.ts.net", Some("https")), None)
            .unwrap();
        assert_eq!(url, "ws://localhost:8088/connection/websocket");
    }

    #[test]
    fn red_proof_same_origin_derives_wss_from_forwarded_host() {
        let advert = RealtimeAdvert::from_env_value(Some("same-origin"), 8000);
        let url = advert
            .advertise_from_headers(&headers("cursor.tailb1aad3.ts.net", Some("https")), None)
            .unwrap();
        assert_eq!(url, "wss://cursor.tailb1aad3.ts.net/connection/websocket");
    }

    #[test]
    fn red_proof_absolute_url_ignores_host_adr_0110() {
        let advert =
            RealtimeAdvert::from_env_value(Some("wss://rt.oor7.com/connection/websocket"), 8000);
        let url = advert
            .advertise_from_headers(&headers("cursor.tailb1aad3.ts.net", Some("https")), None)
            .unwrap();
        assert_eq!(url, "wss://rt.oor7.com/connection/websocket");
    }

    #[test]
    fn production_split_domain_is_unaffected_by_same_origin_mode() {
        // Production compose still ships an absolute wss URL on a separate
        // realtime domain. That path must not start reading Host.
        let advert = RealtimeAdvert::Fixed("wss://rt.oor7.com/connection/websocket".to_string());
        assert_eq!(
            advert
                .advertise(Some("http"), Some("app.oor7.com"), Some("http"))
                .unwrap(),
            "wss://rt.oor7.com/connection/websocket"
        );
    }

    #[test]
    fn boot_log_prints_url_or_mode_name() {
        assert_eq!(
            RealtimeAdvert::Fixed("wss://rt.example/connection/websocket".to_string()).to_string(),
            "wss://rt.example/connection/websocket"
        );
        assert_eq!(RealtimeAdvert::SameOrigin.to_string(), "same-origin");
    }
}
