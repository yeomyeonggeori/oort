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

#[derive(Debug)]
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
        // `no_proxy`: a proxy resolves the target by name itself, so with `HTTPS_PROXY`
        // in the environment `resolve_to_addrs` would be silently skipped and the
        // address the guard checked would never be the one dialled (#4829).
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(self.timeout)
            .resolve_to_addrs(&url.host, &[addr])
            .build()
            .map_err(|error| FetchError::Failed(error.without_url().to_string()))?;
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
        // A declared length past the cap is refused before a byte is read: waiting
        // for the stream to prove it would only hold the socket open for nothing.
        // (A body that LIES small is bounded by hyper itself; one that lies large is
        // still cut off by `read_limited`.)
        if response
            .content_length()
            .is_some_and(|declared| declared > kind.max_bytes() as u64)
        {
            return Err(FetchError::TooLarge);
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
        // reqwest's Display names the full URL, query included. A link's query is
        // often a bearer token, so it never rides inside an error string (ADR-0218 D5).
        FetchError::Failed(error.without_url().to_string())
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

    // ── #4829: real sockets on 127.0.0.1 ───────────────────────────────────
    //
    // The guard refuses loopback by design, so a fake server there can never be
    // reached through it. [`Loopback`] wraps the PRODUCTION `ReqwestGet`: the guard
    // still resolves, checks and PICKS the address, the wrapper records it and swaps
    // only the IP for the fake's. Everything after that (redirect policy, headers,
    // Content-Length, the streaming cap, the timeouts) is the real reqwest path.

    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Clone)]
    enum Reply {
        /// Status + headers + a truthful Content-Length.
        Ok {
            status: u16,
            headers: Vec<(String, String)>,
            body: Vec<u8>,
        },
        /// The head exactly as written (so a LYING Content-Length is possible), then
        /// `body`, then close.
        Raw {
            head: String,
            body: Vec<u8>,
        },
        Chunked {
            chunks: Vec<Vec<u8>>,
        },
        /// The head, then silence.
        HeadersThenStall {
            head: String,
        },
        /// Reads the request and never answers.
        Hang,
        /// 200, then one byte every `every` for as long as the client listens.
        Drip {
            every: Duration,
        },
    }

    fn png() -> Vec<u8> {
        b"\x89PNG\r\n\x1a\nthe-bytes-are-not-decoded-here".to_vec()
    }
    fn ok(body: Vec<u8>) -> Reply {
        Reply::Ok {
            status: 200,
            headers: vec![("Content-Type".into(), "image/png".into())],
            body,
        }
    }
    fn redirect(to: &str) -> Reply {
        Reply::Ok {
            status: 302,
            headers: vec![("Location".into(), to.into())],
            body: Vec::new(),
        }
    }

    struct Seen {
        path: String,
        headers: Vec<(String, String)>,
    }

    struct Fake {
        addr: SocketAddr,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    type Route = Arc<dyn Fn(&str, usize) -> Reply + Send + Sync>;

    impl Fake {
        async fn start(route: impl Fn(&str, usize) -> Reply + Send + Sync + 'static) -> Fake {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("addr");
            let seen = Arc::new(Mutex::new(Vec::new()));
            let route: Route = Arc::new(route);
            let count = Arc::new(AtomicU32::new(0));
            let log = seen.clone();
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (log, route, count) = (log.clone(), route.clone(), count.clone());
                    tokio::spawn(async move {
                        let _ = serve(stream, log, route, count).await;
                    });
                }
            });
            Fake { addr, seen }
        }
        fn paths(&self) -> Vec<String> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .map(|s| s.path.clone())
                .collect()
        }
        fn header(&self, request: usize, name: &str) -> Option<String> {
            self.seen.lock().unwrap()[request]
                .headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    async fn serve(
        mut stream: TcpStream,
        seen: Arc<Mutex<Vec<Seen>>>,
        route: Route,
        count: Arc<AtomicU32>,
    ) -> std::io::Result<()> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut chunk).await?;
            if read == 0 || buffer.len() > 16 * 1024 {
                return Ok(());
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
        let text = String::from_utf8_lossy(&buffer).to_string();
        let mut lines = text.split("\r\n");
        let path = lines
            .next()
            .unwrap_or("")
            .split(' ')
            .nth(1)
            .unwrap_or("")
            .to_string();
        let headers = lines
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let nth = count.fetch_add(1, Ordering::SeqCst) as usize;
        seen.lock().unwrap().push(Seen {
            path: path.clone(),
            headers,
        });
        match route(&path, nth) {
            Reply::Ok {
                status,
                headers,
                body,
            } => {
                let mut head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (key, value) in headers {
                    head.push_str(&format!("{key}: {value}\r\n"));
                }
                head.push_str("\r\n");
                stream.write_all(head.as_bytes()).await?;
                stream.write_all(&body).await?;
            }
            Reply::Raw { head, body } => {
                stream.write_all(head.as_bytes()).await?;
                let _ = stream.write_all(&body).await;
            }
            Reply::Chunked { chunks } => {
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                    )
                    .await?;
                for piece in chunks {
                    stream
                        .write_all(format!("{:x}\r\n", piece.len()).as_bytes())
                        .await?;
                    if stream.write_all(&piece).await.is_err() {
                        return Ok(());
                    }
                    stream.write_all(b"\r\n").await?;
                }
                stream.write_all(b"0\r\n\r\n").await?;
            }
            Reply::HeadersThenStall { head } => {
                stream.write_all(head.as_bytes()).await?;
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            Reply::Hang => tokio::time::sleep(Duration::from_secs(60)).await,
            Reply::Drip { every } => {
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n",
                    )
                    .await?;
                while stream.write_all(b"x").await.is_ok() {
                    tokio::time::sleep(every).await;
                }
            }
        }
        let _ = stream.shutdown().await;
        Ok(())
    }

    /// name → answers; remembers every authority it was asked about.
    struct Dns {
        table: HashMap<String, Vec<IpAddr>>,
        asked: Mutex<Vec<String>>,
    }
    impl Dns {
        fn new(rows: &[(&str, &[&str])]) -> Dns {
            Dns {
                table: rows
                    .iter()
                    .map(|(name, ips)| {
                        (
                            name.to_string(),
                            ips.iter().map(|ip| ip.parse().unwrap()).collect(),
                        )
                    })
                    .collect(),
                asked: Mutex::new(Vec::new()),
            }
        }
    }
    impl HostResolver for Dns {
        async fn resolve(&self, authority: &str) -> Result<Vec<IpAddr>, OutboundUrlError> {
            self.asked.lock().unwrap().push(authority.to_string());
            let host = authority
                .rsplit_once(':')
                .map_or(authority, |(host, _)| host);
            self.table
                .get(host)
                .cloned()
                .ok_or(OutboundUrlError::ResolutionFailed)
        }
    }

    /// First answer is public, every later answer is loopback: the rebinding resolver.
    struct Rebind {
        calls: AtomicU32,
    }
    impl HostResolver for Rebind {
        async fn resolve(&self, _authority: &str) -> Result<Vec<IpAddr>, OutboundUrlError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(vec!["93.184.216.34".parse().unwrap()])
            } else {
                Ok(vec!["127.0.0.1".parse().unwrap()])
            }
        }
    }

    /// The production `ReqwestGet`, dialling the fake instead of the address the
    /// guard picked. What the guard picked is recorded.
    struct Loopback {
        local: SocketAddr,
        timeout: Duration,
        asked: Mutex<Vec<SocketAddr>>,
    }
    impl PinnedGet for Loopback {
        async fn get(
            &self,
            url: &OutboundUrl,
            addr: SocketAddr,
            kind: FetchKind,
        ) -> Result<RawResponse, FetchError> {
            self.asked.lock().unwrap().push(addr);
            ReqwestGet {
                timeout: self.timeout,
            }
            .get(url, self.local, kind)
            .await
        }
    }

    const SECOND: Duration = Duration::from_secs(1);

    fn at(host: &str, fake: &Fake, path: &str) -> String {
        format!("http://{host}:{}{path}", fake.addr.port())
    }

    /// Runs the real hop loop against the fake; a regression that makes the
    /// transport wait forever fails here in 8 s instead of hanging the suite.
    async fn fetch_via<R: HostResolver>(
        fake: &Fake,
        dns: &R,
        start: &str,
        timeout: Duration,
    ) -> (Result<Fetched, FetchError>, Vec<SocketAddr>) {
        let getter = Loopback {
            local: fake.addr,
            timeout,
            asked: Mutex::new(Vec::new()),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            fetch_guarded(start, FetchKind::Image, true, dns, &getter),
        )
        .await
        .expect("the transport must give up by itself");
        let asked = getter.asked.lock().unwrap().clone();
        (result, asked)
    }

    fn files_dns() -> Dns {
        Dns::new(&[("files.example", &["93.184.216.34"])])
    }

    #[tokio::test]
    async fn a_fifth_request_is_never_made_and_reqwest_never_follows_by_itself() {
        let fake = Fake::start(|path, _| match path {
            "/start" => redirect("/h1"),
            "/h1" => redirect("/h2"),
            "/h2" => redirect("/h3"),
            "/h3" => redirect("/h4"),
            _ => ok(png()),
        })
        .await;
        let (result, asked) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/start"),
            SECOND * 2,
        )
        .await;
        assert_eq!(result.unwrap_err(), FetchError::TooManyRedirects);
        assert_eq!(
            fake.paths(),
            ["/start", "/h1", "/h2", "/h3"],
            "the original and three followed hops; the fourth 3xx is refused and /h4 is never asked for"
        );
        assert_eq!(asked.len(), 4, "the guard approved exactly four connects");
    }

    #[tokio::test]
    async fn three_hops_across_hosts_are_each_resolved_checked_and_pinned() {
        // The Location headers need the fake's own port, so the route reads it from a
        // cell filled in right after bind.
        let port_cell = Arc::new(Mutex::new(0u16));
        let cell = port_cell.clone();
        let fake = Fake::start(move |path, _| {
            let port = *cell.lock().unwrap();
            match path {
                "/start" => redirect(&format!("http://cdn.example:{port}/h1")),
                "/h1" => redirect("/h2"),
                "/h2" => redirect(&format!("http://img.example:{port}/final.png")),
                _ => ok(png()),
            }
        })
        .await;
        *port_cell.lock().unwrap() = fake.addr.port();
        let dns = Dns::new(&[
            ("files.example", &["93.184.216.34"]),
            ("cdn.example", &["151.101.1.69"]),
            ("img.example", &["104.16.0.1"]),
        ]);
        let (result, asked) = fetch_via(
            &fake,
            &dns,
            &at("files.example", &fake, "/start"),
            SECOND * 2,
        )
        .await;
        assert_eq!(result.unwrap().body, png());
        let port = fake.addr.port();
        let hosts: Vec<_> = (0..4).map(|n| fake.header(n, "host").unwrap()).collect();
        assert_eq!(
            hosts,
            [
                format!("files.example:{port}"),
                format!("cdn.example:{port}"),
                format!("cdn.example:{port}"),
                format!("img.example:{port}")
            ],
            "every hop names its own host"
        );
        let expected: Vec<SocketAddr> = [
            "93.184.216.34",
            "151.101.1.69",
            "151.101.1.69",
            "104.16.0.1",
        ]
        .iter()
        .map(|ip| SocketAddr::new(ip.parse().unwrap(), port))
        .collect();
        assert_eq!(asked, expected, "each hop dials the address checked for it");
        assert_eq!(
            *dns.asked.lock().unwrap(),
            [
                format!("files.example:{port}"),
                format!("cdn.example:{port}"),
                format!("cdn.example:{port}"),
                format!("img.example:{port}")
            ],
            "one resolution per hop, no extras"
        );
    }

    #[tokio::test]
    async fn a_redirect_into_a_private_or_odd_destination_stops_before_any_connect() {
        let dns = Dns::new(&[
            ("files.example", &["93.184.216.34"]),
            ("metadata.internal", &["169.254.169.254"]),
            ("rebind.example", &["93.184.216.34", "169.254.169.254"]),
            ("nat64.example", &["64:ff9b::a9fe:a9fe"]),
        ]);
        for (label, location) in [
            ("loopback v4", "http://127.0.0.1:8080/x"),
            ("RFC 1918", "http://10.0.0.1/x"),
            (
                "link-local metadata",
                "http://169.254.169.254/latest/meta-data/",
            ),
            ("unique-local metadata v6", "http://[fd00:ec2::254]/x"),
            ("loopback v6", "http://[::1]/x"),
            ("v4-mapped loopback", "http://[::ffff:7f00:1]/x"),
            ("NAT64 metadata literal", "http://[64:ff9b::a9fe:a9fe]/x"),
            ("6to4 loopback literal", "http://[2002:7f00:1::]/x"),
            ("localhost name", "http://localhost/x"),
            ("name that resolves private", "http://metadata.internal/x"),
            ("name with one private answer", "http://rebind.example/x"),
            (
                "name that resolves to a NAT64-carried private",
                "http://nat64.example/x",
            ),
            ("userinfo", "http://user:pw@files.example/x"),
            ("file scheme", "file:///etc/passwd"),
            ("ftp scheme", "ftp://files.example/x"),
            ("gopher scheme", "gopher://files.example/x"),
            ("data scheme", "data:text/html,hi"),
            ("javascript scheme", "javascript:alert(1)"),
        ] {
            let location = location.to_string();
            let fake = Fake::start(move |path, _| match path {
                "/start" => redirect(&location),
                _ => ok(png()),
            })
            .await;
            let (result, asked) = fetch_via(
                &fake,
                &dns,
                &at("files.example", &fake, "/start"),
                SECOND * 2,
            )
            .await;
            assert_eq!(result.unwrap_err(), FetchError::Blocked, "{label}");
            assert_eq!(
                fake.paths(),
                ["/start"],
                "{label}: only the public first hop was ever requested"
            );
            assert_eq!(asked.len(), 1, "{label}: one approved connect, for hop one");
        }
    }

    #[tokio::test]
    async fn the_address_the_guard_checked_is_the_only_one_ever_dialled() {
        let fake = Fake::start(|_, _| ok(png())).await;
        let rebind = Rebind {
            calls: AtomicU32::new(0),
        };
        let (result, asked) = fetch_via(
            &fake,
            &rebind,
            &at("rebind.example", &fake, "/x.png"),
            SECOND * 2,
        )
        .await;
        result.expect("the checked public address is fine");
        assert_eq!(
            asked,
            [SocketAddr::new(
                "93.184.216.34".parse().unwrap(),
                fake.addr.port()
            )],
            "the connection goes to the first, checked answer, never to the loopback a later lookup would give"
        );
        assert_eq!(
            rebind.calls.load(Ordering::SeqCst),
            1,
            "the name is resolved once per hop; a second lookup is the rebinding window"
        );
    }

    #[tokio::test]
    async fn reqwest_dials_the_pinned_address_and_never_asks_dns() {
        let fake = Fake::start(|_, _| ok(png())).await;
        // `.invalid` can never resolve: only the pin can make this connect.
        let url = OutboundUrl {
            scheme: "http".into(),
            host: "pin.invalid".into(),
            port: Some(fake.addr.port()),
            path_and_query: "/x.png".into(),
            absolute: format!("http://pin.invalid:{}/x.png", fake.addr.port()),
        };
        let got = ReqwestGet {
            timeout: SECOND * 3,
        }
        .get(&url, fake.addr, FetchKind::Image)
        .await
        .expect("pinned to the fake, no DNS");
        assert_eq!((got.status, got.body), (200, png()));
        assert_eq!(
            fake.header(0, "host"),
            Some(format!("pin.invalid:{}", fake.addr.port())),
            "the request still names the original host"
        );
    }

    fn big(len: usize) -> Vec<Vec<u8>> {
        let mut chunks = vec![vec![b'x'; 64 * 1024]; len / (64 * 1024)];
        if !len.is_multiple_of(64 * 1024) {
            chunks.push(vec![b'x'; len % (64 * 1024)]);
        }
        chunks
    }

    #[tokio::test]
    async fn the_streaming_cap_is_exact_and_cuts_a_chunked_flood() {
        let exact = Fake::start(|_, _| Reply::Chunked {
            chunks: big(IMAGE_MAX_BYTES),
        })
        .await;
        let (result, _) = fetch_via(
            &exact,
            &files_dns(),
            &at("files.example", &exact, "/a"),
            SECOND * 5,
        )
        .await;
        assert_eq!(
            result.expect("exactly the cap is allowed").body.len(),
            IMAGE_MAX_BYTES
        );

        let over = Fake::start(|_, _| Reply::Chunked {
            chunks: big(IMAGE_MAX_BYTES + 1),
        })
        .await;
        let (result, _) = fetch_via(
            &over,
            &files_dns(),
            &at("files.example", &over, "/a"),
            SECOND * 5,
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            FetchError::TooLarge,
            "one byte over the cap, no Content-Length to warn us"
        );
    }

    #[tokio::test]
    async fn a_declared_length_past_the_cap_is_refused_without_waiting_for_the_body() {
        let fake = Fake::start(|_, _| Reply::HeadersThenStall {
            head: format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                IMAGE_MAX_BYTES + 1
            ),
        })
        .await;
        let started = Instant::now();
        let (result, _) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/a"),
            SECOND * 4,
        )
        .await;
        assert_eq!(result.unwrap_err(), FetchError::TooLarge);
        assert!(
            started.elapsed() < SECOND * 2,
            "refused on the header alone, not after the {:?} hop timeout",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_length_that_lies_small_cannot_inflate_the_buffer() {
        let fake = Fake::start(|_, _| Reply::Raw {
            head: "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n".into(),
            body: vec![b'x'; IMAGE_MAX_BYTES + 1024],
        })
        .await;
        let (result, _) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/a"),
            SECOND * 5,
        )
        .await;
        assert_eq!(result.expect("the declared 16 bytes").body.len(), 16);
    }

    #[tokio::test]
    async fn a_body_shorter_than_its_declared_length_is_a_failed_fetch_not_a_short_image() {
        let fake = Fake::start(|_, _| Reply::Raw {
            head: "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n".into(),
            body: vec![b'x'; 10],
        })
        .await;
        let (result, _) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/a"),
            SECOND * 5,
        )
        .await;
        assert!(
            matches!(result, Err(FetchError::Failed(_))),
            "a truncated body must not become a (broken) image: {result:?}"
        );
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out_at_the_hop_timeout() {
        let fake = Fake::start(|_, _| Reply::Hang).await;
        let started = Instant::now();
        let (result, _) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/a"),
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(result.unwrap_err(), FetchError::Timeout);
        assert!(started.elapsed() < SECOND * 3, "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_slow_drip_cannot_outlive_the_request_timeout() {
        let fake = Fake::start(|_, _| Reply::Drip {
            every: Duration::from_millis(40),
        })
        .await;
        let started = Instant::now();
        let (result, _) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/a"),
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            FetchError::Timeout,
            "bytes that keep trickling in do not reset the clock"
        );
        assert!(started.elapsed() < SECOND * 3, "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn only_a_user_agent_and_an_accept_header_leave_the_building() {
        let fake = Fake::start(|_, _| ok(png())).await;
        let (result, _) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/a.png?token=abc"),
            SECOND * 2,
        )
        .await;
        result.unwrap();
        let names: Vec<String> = fake.seen.lock().unwrap()[0]
            .headers
            .iter()
            .map(|(key, _)| key.clone())
            .collect();
        for name in &names {
            assert!(
                ["host", "user-agent", "accept"].contains(&name.as_str()),
                "{name} must not leave the building (no cookie, authorization, referer): {names:?}"
            );
        }
        assert_eq!(
            fake.header(0, "user-agent").as_deref(),
            Some(UNFURL_USER_AGENT)
        );
        assert!(fake.header(0, "accept").unwrap().starts_with("image/"));
        assert_eq!(
            fake.paths(),
            ["/a.png?token=abc"],
            "the query is for the wire only"
        );
    }

    #[tokio::test]
    async fn an_error_status_is_a_failed_fetch_that_names_the_status_only() {
        for status in [401u16, 403, 404, 429, 500, 503] {
            let fake = Fake::start(move |_, _| Reply::Ok {
                status,
                headers: Vec::new(),
                body: b"<html>nope</html>".to_vec(),
            })
            .await;
            let (result, _) = fetch_via(
                &fake,
                &files_dns(),
                &at("files.example", &fake, "/a"),
                SECOND * 2,
            )
            .await;
            assert_eq!(
                result.unwrap_err(),
                FetchError::Failed(format!("HTTP {status}"))
            );
        }
        let fake = Fake::start(|_, _| Reply::Ok {
            status: 302,
            headers: Vec::new(),
            body: Vec::new(),
        })
        .await;
        let (result, _) = fetch_via(
            &fake,
            &files_dns(),
            &at("files.example", &fake, "/a"),
            SECOND * 2,
        )
        .await;
        assert!(
            matches!(result, Err(FetchError::Failed(_))),
            "a 3xx without Location is a failed fetch: {result:?}"
        );
    }

    #[tokio::test]
    async fn a_failed_fetch_error_text_never_contains_the_link() {
        // A port nobody listens on: connection refused.
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = closed.local_addr().unwrap();
        drop(closed);
        let getter = Loopback {
            local,
            timeout: SECOND * 2,
            asked: Mutex::new(Vec::new()),
        };
        let start = format!("http://files.example:{}/p?token=SECRET", local.port());
        let error = fetch_guarded(&start, FetchKind::Image, true, &files_dns(), &getter)
            .await
            .unwrap_err();
        let FetchError::Failed(text) = &error else {
            panic!("expected a failed fetch, got {error:?}");
        };
        assert!(
            !text.contains("SECRET") && !text.contains("files.example") && !text.contains("/p?"),
            "reqwest names the URL in its Display; it must not survive into FetchError: {text}"
        );
    }

    #[tokio::test]
    async fn production_takes_https_only_and_a_downgrade_redirect_is_refused() {
        let getter = ScriptedGet {
            hops: AtomicU32::new(0),
            locations: Mutex::new(vec![]),
        };
        let err = fetch_guarded(
            "http://example.com/x.gif",
            FetchKind::Image,
            false,
            &public(),
            &getter,
        )
        .await
        .unwrap_err();
        assert_eq!(err, FetchError::Blocked);
        assert_eq!(
            getter.hops.load(Ordering::SeqCst),
            0,
            "no connect for plain http"
        );

        let getter = ScriptedGet {
            hops: AtomicU32::new(0),
            locations: Mutex::new(vec!["http://example.com/y.gif".into()]),
        };
        let err = fetch_guarded(
            "https://example.com/x.gif",
            FetchKind::Image,
            false,
            &public(),
            &getter,
        )
        .await
        .unwrap_err();
        assert_eq!(err, FetchError::Blocked, "https to http is a downgrade");
        assert_eq!(
            getter.hops.load(Ordering::SeqCst),
            1,
            "only the https hop connected"
        );
    }

    /// `HTTP_PROXY` in the environment must not move the connection. The probe runs
    /// in a child process so the environment is the child's alone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_system_proxy_cannot_take_over_the_pinned_connection() {
        const ORIGIN: &str = "OORT_FETCH_PROXY_PROBE_ORIGIN";
        if let Ok(origin) = std::env::var(ORIGIN) {
            let origin: SocketAddr = origin.parse().expect("origin address");
            let url = OutboundUrl {
                scheme: "http".into(),
                host: "pin.invalid".into(),
                port: Some(origin.port()),
                path_and_query: "/x.png".into(),
                absolute: format!("http://pin.invalid:{}/x.png", origin.port()),
            };
            let got = ReqwestGet {
                timeout: SECOND * 3,
            }
            .get(&url, origin, FetchKind::Image)
            .await;
            assert!(
                got.is_ok(),
                "the pinned origin must be dialled directly: {got:?}"
            );
            return;
        }
        let origin = Fake::start(|_, _| ok(png())).await;
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let hits = Arc::new(AtomicU32::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while proxy.accept().await.is_ok() {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        let exe = std::env::current_exe().unwrap();
        let origin_addr = origin.addr.to_string();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(exe)
                .args([
                    "--exact",
                    "fetch::tests::a_system_proxy_cannot_take_over_the_pinned_connection",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(ORIGIN, origin_addr)
                .env("HTTP_PROXY", format!("http://{proxy_addr}"))
                .env("http_proxy", format!("http://{proxy_addr}"))
                .env("ALL_PROXY", format!("http://{proxy_addr}"))
                .env("all_proxy", format!("http://{proxy_addr}"))
                .env_remove("NO_PROXY")
                .env_remove("no_proxy")
                .output()
                .expect("spawn the probe")
        })
        .await
        .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "probe failed (a probe that ran 0 tests must not count):\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "the proxy was dialled: the pin was bypassed"
        );
        assert_eq!(
            origin.paths(),
            ["/x.png"],
            "the origin was reached directly"
        );
    }
}
