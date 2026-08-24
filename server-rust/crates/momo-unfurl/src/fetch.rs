//! SSRF-guarded GET with redirect ≤3, re-checked every hop (ADR-0170 D3).
//!
//! Reuses [`momo_webhook::validated_url`] / [`momo_webhook::validated_resolved_addresses`].
//! The connection is pinned to a checked address so DNS cannot rebind between
//! the check and the socket. Redirects are followed by this module, never by
//! reqwest, because each Location has to go through the same guard.

use std::net::SocketAddr;
use std::time::Duration;

use futures::StreamExt;
use momo_webhook::{
    validated_resolved_addresses, validated_url, HostResolver, OutboundUrl, OutboundUrlError,
    SystemHostResolver,
};

pub const HTML_MAX_BYTES: usize = 512 * 1024;
pub const IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_REDIRECTS: u32 = 3;
pub const UNFURL_USER_AGENT: &str = "oort-unfurl/1";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchKind {
    Html,
    Image,
}

impl FetchKind {
    fn max_bytes(self) -> usize {
        match self {
            FetchKind::Html => HTML_MAX_BYTES,
            FetchKind::Image => IMAGE_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Fetched {
    pub final_url: String,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchError {
    #[error("destination refused by SSRF guard")]
    Blocked,
    #[error("too many redirects")]
    TooManyRedirects,
    #[error("response exceeded size limit")]
    TooLarge,
    #[error("request timed out")]
    Timeout,
    #[error("fetch failed: {0}")]
    Failed(String),
}

impl FetchError {
    pub fn is_blocked(&self) -> bool {
        matches!(self, FetchError::Blocked | FetchError::TooManyRedirects)
    }
}

/// The seam tests replace. Production is [`SafeUnfurlTransport`].
#[async_trait::async_trait]
pub trait UnfurlHttp: Send + Sync {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError>;
}

/// Production transport: OutboundHTTPPolicy + address pin + hop-by-hop redirect.
pub struct SafeUnfurlTransport {
    allow_development_http: bool,
    timeout: Duration,
}

impl SafeUnfurlTransport {
    pub fn new(allow_development_http: bool, timeout: Duration) -> SafeUnfurlTransport {
        SafeUnfurlTransport {
            allow_development_http,
            timeout,
        }
    }

    pub fn production(allow_development_http: bool) -> SafeUnfurlTransport {
        SafeUnfurlTransport::new(allow_development_http, DEFAULT_TIMEOUT)
    }
}

#[async_trait::async_trait]
impl UnfurlHttp for SafeUnfurlTransport {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        fetch_guarded(
            url,
            kind,
            self.allow_development_http,
            &SystemHostResolver,
            &ReqwestGet {
                timeout: self.timeout,
            },
        )
        .await
    }
}

#[allow(async_fn_in_trait)]
trait PinnedGet: Send + Sync {
    async fn get(
        &self,
        url: &OutboundUrl,
        addr: SocketAddr,
        kind: FetchKind,
    ) -> Result<RawResponse, FetchError>;
}

struct RawResponse {
    status: u16,
    location: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

struct ReqwestGet {
    timeout: Duration,
}

impl PinnedGet for ReqwestGet {
    async fn get(
        &self,
        url: &OutboundUrl,
        addr: SocketAddr,
        kind: FetchKind,
    ) -> Result<RawResponse, FetchError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .resolve_to_addrs(&url.host, &[addr])
            .build()
            .map_err(|error| FetchError::Failed(error.to_string()))?;
        let response = client
            .get(&url.absolute)
            .header("User-Agent", UNFURL_USER_AGENT)
            .header("Accept", accept_for(kind))
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if (300..400).contains(&status) {
            return Ok(RawResponse {
                status,
                location,
                content_type,
                body: Vec::new(),
            });
        }
        if !(200..300).contains(&status) {
            return Err(FetchError::Failed(format!("HTTP {status}")));
        }
        let body = read_limited(response, kind.max_bytes()).await?;
        Ok(RawResponse {
            status,
            location,
            content_type,
            body,
        })
    }
}

fn accept_for(kind: FetchKind) -> &'static str {
    match kind {
        FetchKind::Html => "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        FetchKind::Image => "image/*,*/*;q=0.1",
    }
}

fn map_reqwest(error: reqwest::Error) -> FetchError {
    if error.is_timeout() {
        FetchError::Timeout
    } else {
        FetchError::Failed(error.to_string())
    }
}

async fn read_limited(response: reqwest::Response, max: usize) -> Result<Vec<u8>, FetchError> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_reqwest)?;
        if body.len() + chunk.len() > max {
            return Err(FetchError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_guarded<R: HostResolver, G: PinnedGet>(
    start: &str,
    kind: FetchKind,
    allow_development_http: bool,
    resolver: &R,
    getter: &G,
) -> Result<Fetched, FetchError> {
    let mut current = start.to_string();
    let mut redirects = 0u32;
    loop {
        let parsed = match validated_url(&current, allow_development_http) {
            Ok(parsed) => parsed,
            Err(OutboundUrlError::PrivateAddress) | Err(OutboundUrlError::InvalidUrl) => {
                return Err(FetchError::Blocked);
            }
            Err(OutboundUrlError::InsecureHttp) => return Err(FetchError::Blocked),
            Err(OutboundUrlError::ResolutionFailed) => {
                return Err(FetchError::Failed("dns".into()));
            }
        };
        let addresses = validated_resolved_addresses(&parsed, resolver)
            .await
            .map_err(|error| match error {
                OutboundUrlError::PrivateAddress => FetchError::Blocked,
                OutboundUrlError::ResolutionFailed => FetchError::Failed("dns".into()),
                other => FetchError::Failed(other.to_string()),
            })?;
        let port = parsed
            .port
            .unwrap_or(if parsed.scheme == "https" { 443 } else { 80 });
        let addr = SocketAddr::new(*addresses.first().ok_or(FetchError::Blocked)?, port);
        let response = getter.get(&parsed, addr, kind).await?;
        if (300..400).contains(&response.status) {
            if redirects >= MAX_REDIRECTS {
                return Err(FetchError::TooManyRedirects);
            }
            let location = response
                .location
                .ok_or(FetchError::Failed("redirect without Location".into()))?;
            current = resolve_location(&parsed.absolute, &location)?;
            redirects += 1;
            continue;
        }
        let content_type = response.content_type.unwrap_or_else(|| match kind {
            FetchKind::Html => "text/html".into(),
            FetchKind::Image => "application/octet-stream".into(),
        });
        return Ok(Fetched {
            final_url: parsed.absolute,
            content_type,
            body: response.body,
        });
    }
}

fn resolve_location(base: &str, location: &str) -> Result<String, FetchError> {
    let base = url::Url::parse(base).map_err(|_| FetchError::Blocked)?;
    let joined = base
        .join(location.trim())
        .map_err(|_| FetchError::Blocked)?;
    if joined.username() != "" || joined.password().is_some() {
        return Err(FetchError::Blocked);
    }
    if !matches!(joined.scheme(), "http" | "https") {
        return Err(FetchError::Blocked);
    }
    Ok(joined.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    struct FixedResolver(Vec<IpAddr>);

    impl HostResolver for FixedResolver {
        async fn resolve(&self, _authority: &str) -> Result<Vec<IpAddr>, OutboundUrlError> {
            Ok(self.0.clone())
        }
    }

    struct ScriptedGet {
        hops: AtomicU32,
        locations: Mutex<Vec<String>>,
    }

    impl PinnedGet for ScriptedGet {
        async fn get(
            &self,
            _url: &OutboundUrl,
            _addr: SocketAddr,
            _kind: FetchKind,
        ) -> Result<RawResponse, FetchError> {
            let n = self.hops.fetch_add(1, Ordering::SeqCst);
            let locations = self.locations.lock().unwrap();
            if (n as usize) < locations.len() {
                Ok(RawResponse {
                    status: 302,
                    location: Some(locations[n as usize].clone()),
                    content_type: None,
                    body: Vec::new(),
                })
            } else {
                Ok(RawResponse {
                    status: 200,
                    location: None,
                    content_type: Some("text/html".into()),
                    body: b"<html></html>".to_vec(),
                })
            }
        }
    }

    fn public() -> FixedResolver {
        FixedResolver(vec!["93.184.216.34".parse().unwrap()])
    }

    #[tokio::test]
    async fn private_literals_are_blocked_before_connect() {
        let getter = ScriptedGet {
            hops: AtomicU32::new(0),
            locations: Mutex::new(vec![]),
        };
        for raw in [
            "https://127.0.0.1/",
            "https://10.1.2.3/",
            "https://169.254.169.254/latest/meta-data",
            "https://localhost/",
            "https://[::1]/",
            "https://[fe80::1]/",
            "https://[fd00::1]/",
            "https://192.168.0.1/",
            "https://172.16.0.9/",
        ] {
            let err = fetch_guarded(raw, FetchKind::Html, false, &public(), &getter)
                .await
                .unwrap_err();
            assert!(
                err.is_blocked(),
                "{raw} must be a blocked SSRF destination, got {err:?}"
            );
            assert_eq!(
                getter.hops.load(Ordering::SeqCst),
                0,
                "{raw} must not reach the socket"
            );
        }
    }

    #[tokio::test]
    async fn a_private_dns_answer_is_blocked() {
        let getter = ScriptedGet {
            hops: AtomicU32::new(0),
            locations: Mutex::new(vec![]),
        };
        let mixed = FixedResolver(vec![
            "93.184.216.34".parse().unwrap(),
            "169.254.169.254".parse().unwrap(),
        ]);
        let err = fetch_guarded(
            "https://rebind.example/",
            FetchKind::Html,
            false,
            &mixed,
            &getter,
        )
        .await
        .unwrap_err();
        assert_eq!(err, FetchError::Blocked);
        assert_eq!(getter.hops.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_fourth_redirect_is_blocked() {
        let getter = ScriptedGet {
            hops: AtomicU32::new(0),
            locations: Mutex::new(vec![
                "https://example.com/1".into(),
                "https://example.com/2".into(),
                "https://example.com/3".into(),
                "https://example.com/4".into(),
            ]),
        };
        let err = fetch_guarded(
            "https://example.com/start",
            FetchKind::Html,
            false,
            &public(),
            &getter,
        )
        .await
        .unwrap_err();
        assert_eq!(err, FetchError::TooManyRedirects);
        assert_eq!(
            getter.hops.load(Ordering::SeqCst),
            4,
            "original + 3 followed hops, refuse the 4th 3xx"
        );
    }

    #[tokio::test]
    async fn three_redirects_then_200_is_ok() {
        let getter = ScriptedGet {
            hops: AtomicU32::new(0),
            locations: Mutex::new(vec![
                "https://example.com/1".into(),
                "https://example.com/2".into(),
                "https://example.com/3".into(),
            ]),
        };
        let fetched = fetch_guarded(
            "https://example.com/start",
            FetchKind::Html,
            false,
            &public(),
            &getter,
        )
        .await
        .expect("three hops allowed");
        assert_eq!(fetched.body, b"<html></html>");
        assert_eq!(getter.hops.load(Ordering::SeqCst), 4); // 3 redirects + final
    }

    #[test]
    fn relative_location_resolves_against_the_hop() {
        assert_eq!(
            resolve_location("https://example.com/a/b", "/img.png").unwrap(),
            "https://example.com/img.png"
        );
    }
}
