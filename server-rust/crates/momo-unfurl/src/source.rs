//! The link-receiving half of an expression import (ADR-0218 D5, #4829).
//!
//! No downloader lives here. The bytes arrive through [`crate::fetch`], the same
//! SSRF-guarded, address-pinned, hop-by-hop GET the link unfurl uses: HTTPS only,
//! every DNS answer checked, the connection pinned to a checked answer, redirects
//! <= 3 re-checked per hop, 5 MiB streaming cap. Copying that guard into a second
//! downloader is exactly what D5 forbids.
//!
//! This module owns only what is particular to a link a MEMBER typed in:
//!
//! * which URLs are accepted at all, and the one string that is remembered
//!   ([`parse_source_url`]: credentials, fragments and the query never reach the
//!   database, a card or a log);
//! * the one deadline for the whole fetch ([`SOURCE_DEADLINE`]; the transport's own
//!   timeout is per hop, so a 3-redirect chain could otherwise take 4x as long);
//! * the closed set of reasons a fetch can fail with ([`SourceFailure`]), so the
//!   card says "source link + upload it yourself" and never carries reqwest text.

use std::time::Duration;

use momo_webhook::{validated_url, OutboundUrlError};

use crate::fetch::{FetchError, FetchKind, UnfurlHttp, IMAGE_MAX_BYTES};

/// ADR-0218 D5: one 5 s deadline for DNS, every hop and the body together.
pub const SOURCE_DEADLINE: Duration = Duration::from_secs(5);
/// ADR-0218 D3/D5: a link's bytes are at most 5 MiB.
pub const SOURCE_MAX_BYTES: usize = IMAGE_MAX_BYTES;

/// `ImportRequest.url` is at most 2048 characters (`contracts.schema.json`).
const MAX_URL_CHARS: usize = 2048;

/// Why a typed link is refused before anything leaves the building (a 400).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceUrlError {
    /// Not a link this contract can describe: wrong scheme, credentials, fragment,
    /// whitespace, a host the stored origin could not represent...
    Invalid,
    /// Well formed, but private from the start: a loopback, link-local, metadata or
    /// RFC 1918 address (any spelling), or `localhost`. ADR-0218: "처음부터 사설
    /// 목적지인 URL은 400이다". Names that only RESOLVE private are the transport's
    /// to refuse, and surface as a `source_blocked` card.
    Private,
}

/// An accepted link, in the two shapes it is allowed to have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceUrl {
    fetch: String,
    origin: String,
}

impl SourceUrl {
    /// What the transport requests: normalised, the query kept (a link's query is
    /// part of what makes it work). Lives only as long as the fetch. Never store,
    /// log or audit this.
    pub fn fetch_url(&self) -> &str {
        &self.fetch
    }

    /// What may be remembered and shown: `https://host[:port]/path`. No userinfo,
    /// no query, no fragment (ADR-0218 D5); it satisfies `Origin.sourceUrl`.
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

/// Accept or refuse a link a member typed in. Pure: no DNS, no socket.
///
/// The URL is normalised through the WHATWG parser (the same one reqwest will use)
/// BEFORE the address guard sees it, so the guard judges what will actually be
/// dialled: `https://2130706433/`, `https://0x7f.1/`, `https://127.1/` and
/// percent-encoded or full-width digits all become `127.0.0.1` here and are refused
/// as [`SourceUrlError::Private`] instead of reaching a resolver as an unknown name.
pub fn parse_source_url(raw: &str) -> Result<SourceUrl, SourceUrlError> {
    use SourceUrlError::{Invalid, Private};
    // The wire contract bounds what a client may SEND. This is not implied by the
    // guard's own 2048-byte bound on the normalised URL: `/./` segments and a `:443`
    // normalise away, so a longer-than-allowed request can normalise under it.
    if raw.chars().count() > MAX_URL_CHARS {
        return Err(Invalid);
    }
    // `^https://[^\s/@#]+(?:/[^\s#]*)?$`. Backslash is refused on top: WHATWG reads
    // it as `/` in a special scheme, which is how `https://good.example\@evil/`
    // turns two parsers into two different hosts.
    if raw
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '#' | '\\'))
    {
        return Err(Invalid);
    }
    let rest = raw.strip_prefix("https://").ok_or(Invalid)?;
    let authority = &rest[..rest.find(['/', '?']).unwrap_or(rest.len())];
    if authority.is_empty() || authority.contains('@') {
        return Err(Invalid);
    }
    let parsed = url::Url::parse(raw).map_err(|_| Invalid)?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(Invalid);
    }
    let host = parsed.host_str().ok_or(Invalid)?;
    if !origin_host(host) {
        return Err(Invalid);
    }
    let origin = format!("https://{host}{}", parsed.path());
    let fetch = parsed.as_str().to_string();
    // `validated_url` also bounds `fetch` to 2048 bytes. The origin is the same URL
    // without its query, so it is never longer: percent-encoding that would push the
    // stored link past the contract's 2048 is refused here (and again where it is stored).
    match validated_url(&fetch, false) {
        // 443 only (planner, 10-30): `:443` normalises away, so any explicit port left is a
        // link this endpoint does not fetch. Judged after the private check so a metadata
        // address on any port stays a [`SourceUrlError::Private`].
        Ok(_) if parsed.port().is_some() => Err(Invalid),
        Ok(_) => Ok(SourceUrl { fetch, origin }),
        Err(OutboundUrlError::PrivateAddress) => Err(Private),
        Err(_) => Err(Invalid),
    }
}

/// `Origin.sourceUrl`'s host: lowercase letters, digits, `.`, `-`, or a bracketed
/// IPv6 literal in lowercase hex.
fn origin_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b':');
    }
    !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// Why a link that passed [`parse_source_url`] still gave no bytes. Each variant is
/// one `source_*` card code (ADR-0218 appendix C); nothing here carries a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFailure {
    /// The guard refused: a hop or an answer was private, a scheme was not https,
    /// a redirect left the rules, or there were too many.
    Blocked,
    /// The guard refused the **first** hop: the address the caller itself named resolves
    /// private (or is not on 443). Not a card: the caller answers 400 and writes nothing
    /// (ADR-0218 D5, planner decision 2). [`SourceFailure::code`] is only a total fallback.
    PrivateOrigin,
    /// DNS, connect, a non-2xx answer, a truncated body, a redirect without Location.
    Unavailable,
    /// Declared or streamed past 5 MiB.
    TooLarge,
    /// The deadline, or the transport's own timeout.
    Timeout,
}

impl SourceFailure {
    /// Refused at the first hop (see [`SourceFailure::PrivateOrigin`]).
    pub fn is_private_origin(self) -> bool {
        self == SourceFailure::PrivateOrigin
    }

    pub fn code(self) -> &'static str {
        match self {
            SourceFailure::Blocked | SourceFailure::PrivateOrigin => "source_blocked",
            SourceFailure::Unavailable => "source_unavailable",
            SourceFailure::TooLarge => "source_too_large",
            SourceFailure::Timeout => "source_timeout",
        }
    }
}

impl From<&FetchError> for SourceFailure {
    fn from(error: &FetchError) -> SourceFailure {
        match error {
            FetchError::Blocked | FetchError::TooManyRedirects => SourceFailure::Blocked,
            FetchError::OriginBlocked => SourceFailure::PrivateOrigin,
            FetchError::TooLarge => SourceFailure::TooLarge,
            FetchError::Timeout => SourceFailure::Timeout,
            // `Failed` carries transport text. It is dropped here on purpose.
            FetchError::Failed(_) => SourceFailure::Unavailable,
        }
    }
}

/// Fetch a link's bytes under the one deadline. `http` is the guarded transport
/// (production: `SafeUnfurlTransport`); dropping the future on timeout cancels the
/// in-flight request.
pub async fn fetch_source(
    http: &dyn UnfurlHttp,
    url: &SourceUrl,
    deadline: Duration,
) -> Result<Vec<u8>, SourceFailure> {
    let fetched = tokio::time::timeout(deadline, http.fetch(url.fetch_url(), FetchKind::Source))
        .await
        .map_err(|_| SourceFailure::Timeout)?
        .map_err(|error| SourceFailure::from(&error))?;
    // The transport enforces this already; a transport that did not must not be
    // able to hand an oversized body to the decoder.
    if fetched.body.len() > SOURCE_MAX_BYTES {
        return Err(SourceFailure::TooLarge);
    }
    Ok(fetched.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::Fetched;
    use std::sync::Mutex;
    use std::time::Instant;

    #[test]
    fn accepted_links_keep_the_query_for_the_wire_and_drop_it_from_the_origin() {
        for (raw, fetch, origin) in [
            (
                "https://media.giphy.com/media/abc/giphy.gif",
                "https://media.giphy.com/media/abc/giphy.gif",
                "https://media.giphy.com/media/abc/giphy.gif",
            ),
            (
                "https://Example.COM/Path/a.GIF?token=SECRET&x=1",
                "https://example.com/Path/a.GIF?token=SECRET&x=1",
                "https://example.com/Path/a.GIF",
            ),
            (
                "https://example.com",
                "https://example.com/",
                "https://example.com/",
            ),
            (
                "https://example.com?x=1",
                "https://example.com/?x=1",
                "https://example.com/",
            ),
            (
                "https://example.com:443/x.png",
                "https://example.com/x.png",
                "https://example.com/x.png",
            ),
            (
                "https://例え.jp/猫.gif",
                "https://xn--r8jz45g.jp/%E7%8C%AB.gif",
                "https://xn--r8jz45g.jp/%E7%8C%AB.gif",
            ),
            (
                "https://[2606:4700::1111]/x.gif",
                "https://[2606:4700::1111]/x.gif",
                "https://[2606:4700::1111]/x.gif",
            ),
            (
                "https://93.184.216.34/x.gif",
                "https://93.184.216.34/x.gif",
                "https://93.184.216.34/x.gif",
            ),
            (
                "https://example.com/a%20b.png",
                "https://example.com/a%20b.png",
                "https://example.com/a%20b.png",
            ),
        ] {
            let parsed = parse_source_url(raw).unwrap_or_else(|e| panic!("{raw}: {e:?}"));
            assert_eq!(parsed.fetch_url(), fetch, "{raw}");
            assert_eq!(parsed.origin(), origin, "{raw}");
            assert!(
                !parsed.origin().contains(['?', '#', '@']),
                "{raw}: the origin is host/path only"
            );
        }
    }

    #[test]
    fn links_that_this_contract_cannot_describe_are_invalid() {
        let long = format!("https://example.com/{}", "a".repeat(2048));
        let encoded_longer = format!("https://example.com/{}", "é".repeat(1100));
        // 2,207 characters that normalise to `https://example.com/x.gif`.
        let shrinks = format!("https://example.com/{}x.gif", "./".repeat(1093));
        let mut wrong = Vec::new();
        for (raw, why) in [
            ("", "empty"),
            ("https://", "no host"),
            ("https:///x.gif", "empty host"),
            ("http://example.com/x.gif", "plain http"),
            (
                "HTTPS://example.com/x.gif",
                "the contract's literal is lowercase https://",
            ),
            ("ftp://example.com/x.gif", "ftp"),
            ("//example.com/x.gif", "scheme-relative"),
            ("example.com/x.gif", "no scheme"),
            ("https://user:pw@example.com/x.gif", "credentials"),
            ("https://user@example.com/x.gif", "userinfo"),
            ("https://@example.com/x.gif", "empty userinfo"),
            (
                "https://example.com@evil.example/x.gif",
                "host smuggled behind @",
            ),
            ("https://example.com/x.gif#frag", "fragment"),
            ("https://example.com/#", "empty fragment"),
            ("https://example.com/a b.gif", "space"),
            ("https://example.com/a\tb.gif", "tab"),
            ("https://example.com/a\nb.gif", "newline"),
            ("https://example.com/a\u{0}b.gif", "NUL"),
            ("https://example.com/a\u{a0}b.gif", "no-break space"),
            (
                "https://example.com\\@evil.example/x.gif",
                "backslash before @",
            ),
            (
                "https://example.com\\evil/x.gif",
                "backslash path confusion",
            ),
            ("https://example.com:0/x.gif", "port 0"),
            ("https://example.com:8443/x.png", "a port other than 443"),
            ("https://example.com:444/x.png", "another port"),
            ("https://example.com:99999/x.gif", "port out of range"),
            ("https://example.com:abc/x.gif", "port not a number"),
            (
                "https://exa_mple.com/x.gif",
                "underscore host: the stored origin could not hold it",
            ),
            ("https://exa mple.com/x.gif", "space in host"),
            (long.as_str(), "over 2048 characters"),
            (
                shrinks.as_str(),
                "over 2048 as sent, though it normalises well under",
            ),
            (
                encoded_longer.as_str(),
                "percent-encoding pushes the origin past 2048",
            ),
        ] {
            if parse_source_url(raw) != Err(SourceUrlError::Invalid) {
                wrong.push(format!("{why}: {raw:?}"));
            }
        }
        assert!(
            wrong.is_empty(),
            "accepted, or refused for the wrong reason:\n{}",
            wrong.join("\n")
        );
    }

    #[test]
    fn destinations_that_are_private_from_the_start_are_refused_in_every_spelling() {
        let mut wrong = Vec::new();
        for (raw, why) in [
            ("https://127.0.0.1/x.gif", "loopback"),
            ("https://127.0.0.2/x.gif", "loopback /8"),
            ("https://localhost/x.gif", "localhost"),
            ("https://LOCALHOST/x.gif", "LOCALHOST"),
            ("https://img.localhost/x.gif", "*.localhost"),
            ("https://10.0.0.1/x.gif", "RFC 1918 /8"),
            ("https://172.16.0.1/x.gif", "RFC 1918 /12"),
            ("https://192.168.1.1/x.gif", "RFC 1918 /16"),
            ("https://100.64.0.1/x.gif", "CGNAT"),
            (
                "https://169.254.169.254/latest/meta-data/",
                "cloud metadata",
            ),
            ("https://0.0.0.0/x.gif", "unspecified"),
            ("https://[::1]/x.gif", "v6 loopback"),
            ("https://[fe80::1]/x.gif", "v6 link-local"),
            ("https://[fd00:ec2::254]/x.gif", "v6 metadata"),
            ("https://[::ffff:127.0.0.1]/x.gif", "v4-mapped loopback"),
            (
                "https://[::ffff:a9fe:a9fe]/x.gif",
                "v4-mapped metadata, hex",
            ),
            ("https://[64:ff9b::a9fe:a9fe]/x.gif", "NAT64 metadata"),
            ("https://[2002:7f00:1::]/x.gif", "6to4 loopback"),
            ("https://2130706433/x.gif", "decimal 127.0.0.1"),
            ("https://0x7f000001/x.gif", "hex 127.0.0.1"),
            ("https://0x7f.1/x.gif", "mixed hex 127.0.0.1"),
            ("https://0177.0.0.1/x.gif", "octal 127.0.0.1"),
            ("https://127.1/x.gif", "short 127.0.0.1"),
            ("https://%31%32%37.0.0.1/x.gif", "percent-encoded digits"),
            ("https://１２７.０.０.１/x.gif", "full-width digits"),
            ("https://127.0.0.1./x.gif", "trailing dot"),
            ("https://169.254.169.254:8080/x.gif", "metadata on a port"),
        ] {
            if parse_source_url(raw) != Err(SourceUrlError::Private) {
                wrong.push(format!("{why}: {raw}"));
            }
        }
        assert!(
            wrong.is_empty(),
            "not refused as private:\n{}",
            wrong.join("\n")
        );
    }

    /// Planner decision 2 (10-30): a name that merely RESOLVES private cannot be known
    /// without DNS, so parsing still accepts it; but the transport's first-hop refusal is a
    /// private origin (the route answers 400 and stores nothing), while a refusal after a
    /// redirect is the `source_blocked` card.
    #[test]
    fn a_name_that_resolves_private_is_a_private_origin_not_a_card() {
        assert!(parse_source_url("https://metadata.google.internal/x.gif").is_ok());
        assert!(parse_source_url("https://127.0.0.1.nip.io/x.gif").is_ok());
        assert!(SourceFailure::from(&FetchError::OriginBlocked).is_private_origin());
        for card in [FetchError::Blocked, FetchError::TooManyRedirects] {
            let failure = SourceFailure::from(&card);
            assert!(!failure.is_private_origin());
            assert_eq!(failure.code(), "source_blocked");
        }
    }

    #[test]
    fn every_failure_has_exactly_one_card_code() {
        use FetchError::*;
        let table = [
            (Blocked, SourceFailure::Blocked, "source_blocked"),
            (TooManyRedirects, SourceFailure::Blocked, "source_blocked"),
            (TooLarge, SourceFailure::TooLarge, "source_too_large"),
            (Timeout, SourceFailure::Timeout, "source_timeout"),
            (
                Failed("dns".into()),
                SourceFailure::Unavailable,
                "source_unavailable",
            ),
            (
                Failed("HTTP 404".into()),
                SourceFailure::Unavailable,
                "source_unavailable",
            ),
            (
                Failed("HTTP 429".into()),
                SourceFailure::Unavailable,
                "source_unavailable",
            ),
            (
                Failed("HTTP 503".into()),
                SourceFailure::Unavailable,
                "source_unavailable",
            ),
        ];
        for (error, failure, code) in table {
            assert_eq!(SourceFailure::from(&error), failure, "{error:?}");
            assert_eq!(failure.code(), code);
        }
    }

    /// A transport that answers with a scripted result after a scripted delay and
    /// remembers the URL it was asked for.
    struct Scripted {
        delay: Duration,
        answer: Mutex<Option<Result<Fetched, FetchError>>>,
        asked: Mutex<Vec<(String, FetchKind)>>,
    }

    impl Scripted {
        fn new(delay: Duration, answer: Result<Fetched, FetchError>) -> Scripted {
            Scripted {
                delay,
                answer: Mutex::new(Some(answer)),
                asked: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl UnfurlHttp for Scripted {
        async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
            self.asked.lock().unwrap().push((url.to_string(), kind));
            tokio::time::sleep(self.delay).await;
            self.answer.lock().unwrap().take().expect("asked once")
        }
    }

    fn bytes(body: Vec<u8>) -> Result<Fetched, FetchError> {
        Ok(Fetched {
            final_url: "https://elsewhere.example/final.png".into(),
            content_type: "text/html".into(),
            body,
        })
    }

    #[tokio::test]
    async fn the_transport_is_asked_for_the_query_bearing_url_as_an_image() {
        let http = Scripted::new(Duration::ZERO, bytes(b"abc".to_vec()));
        let url = parse_source_url("https://example.com/a.png?token=SECRET").unwrap();
        let got = fetch_source(&http, &url, SOURCE_DEADLINE).await.unwrap();
        assert_eq!(got, b"abc");
        assert_eq!(
            *http.asked.lock().unwrap(),
            [(
                "https://example.com/a.png?token=SECRET".to_string(),
                FetchKind::Source
            )]
        );
    }

    #[tokio::test]
    async fn one_deadline_covers_the_whole_fetch_even_when_the_transport_would_not() {
        // A transport that takes 3 s with a 100 ms deadline: the per-hop timeout inside
        // a real transport would never fire here, the outer deadline must.
        let http = Scripted::new(Duration::from_secs(3), bytes(b"late".to_vec()));
        let url = parse_source_url("https://example.com/a.png").unwrap();
        let started = Instant::now();
        let got = fetch_source(&http, &url, Duration::from_millis(100)).await;
        assert_eq!(got, Err(SourceFailure::Timeout));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn an_oversized_body_from_a_careless_transport_is_still_refused() {
        let url = parse_source_url("https://example.com/a.png").unwrap();
        let at_cap = Scripted::new(Duration::ZERO, bytes(vec![0; SOURCE_MAX_BYTES]));
        assert_eq!(
            fetch_source(&at_cap, &url, SOURCE_DEADLINE)
                .await
                .unwrap()
                .len(),
            SOURCE_MAX_BYTES
        );
        let over = Scripted::new(Duration::ZERO, bytes(vec![0; SOURCE_MAX_BYTES + 1]));
        assert_eq!(
            fetch_source(&over, &url, SOURCE_DEADLINE).await,
            Err(SourceFailure::TooLarge)
        );
    }

    #[tokio::test]
    async fn a_failed_fetch_surfaces_only_its_card_code() {
        let url = parse_source_url("https://example.com/a.png?token=SECRET").unwrap();
        for (error, code) in [
            (FetchError::Blocked, "source_blocked"),
            (FetchError::TooManyRedirects, "source_blocked"),
            (FetchError::TooLarge, "source_too_large"),
            (FetchError::Timeout, "source_timeout"),
            (
                FetchError::Failed(
                    "error sending request for url (https://example.com/a.png?token=SECRET)".into(),
                ),
                "source_unavailable",
            ),
        ] {
            let http = Scripted::new(Duration::ZERO, Err(error));
            let failure = fetch_source(&http, &url, SOURCE_DEADLINE)
                .await
                .unwrap_err();
            assert_eq!(failure.code(), code);
            assert!(
                !format!("{failure:?}{}", failure.code()).contains("SECRET"),
                "nothing the transport said survives"
            );
        }
    }
}
