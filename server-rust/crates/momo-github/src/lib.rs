//! The manifest-conversion hop of the GitHub App registration flow (ADR-0205 D2).
//!
//! GitHub hands the browser a short-lived `code` after the operator approves the
//! app; the server trades it for the app's credentials with one unauthenticated
//! `POST /app-manifests/{code}/conversions`. That is the **only** call to GitHub
//! phase 1 makes (D8), and this crate is the only place it can be made.
//!
//! ## What leaves this crate
//!
//! A [`ConvertedApp`]: the numeric app id, slug, client id, the owner's login and
//! type, and the two secrets (`pem`, `webhook_secret`) wrapped in [`Plaintext`].
//! GitHub's response also carries a `client_secret`. **This crate has no field
//! for it**, so it is dropped at parse time and cannot be stored, logged or
//! returned by any caller (ADR-0205 D1: 「받는 즉시 버린다」).
//!
//! [`Plaintext`] prints as `<redacted>` under `Debug` and `Display`; the caller
//! (the callback route) seals both secrets inside the same function that
//! received them and lets them drop. No error value carries response text.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use momo_egress::{EgressGuard, HostLookup, SystemLookup};
use momo_settings::EgressPolicy;
use serde::Deserialize;

/// The production API origin. Fixed: nothing a request supplies can change it.
pub const GITHUB_API_BASE: &str = "https://api.github.com";

/// The conversion body is a handful of short fields plus a PEM (~2 KiB). A
/// response above this is not a conversion.
const MAX_CONVERSION_BYTES: usize = 64 * 1024;

/// A secret in transit between the parse and the seal.
pub struct Plaintext(String);

impl Plaintext {
    /// Wrap a secret. The converter builds these from a parsed response; a test double in a
    /// consumer crate builds them from fixtures.
    pub fn new(value: impl Into<String>) -> Plaintext {
        Plaintext(value.into())
    }

    /// The one way to read it. Call sites are the seal and nothing else.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Plaintext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl fmt::Display for Plaintext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

/// What a successful conversion yields. There is deliberately no `client_secret`.
#[derive(Debug)]
pub struct ConvertedApp {
    pub app_id: i64,
    pub slug: String,
    pub client_id: String,
    pub owner_login: String,
    /// `User` or `Organization`, as GitHub names it.
    pub owner_type: String,
    pub pem: Plaintext,
    pub webhook_secret: Plaintext,
}

/// Why a conversion did not produce an app. Labels only — never response text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvertError {
    /// The code is wrong, spent or older than GitHub's one hour (404/422).
    CodeRejected,
    /// The egress guard refused the address, or the host did not answer.
    Unreachable,
    /// GitHub answered with something that is not a conversion.
    InvalidResponse,
}

impl ConvertError {
    pub fn label(self) -> &'static str {
        match self {
            ConvertError::CodeRejected => "code_rejected",
            ConvertError::Unreachable => "unreachable",
            ConvertError::InvalidResponse => "invalid_response",
        }
    }
}

/// The sealed surface momo-server calls.
#[async_trait]
pub trait GithubAppConverter: Send + Sync {
    async fn convert_manifest(&self, code: &str) -> Result<ConvertedApp, ConvertError>;
}

/// `code` is interpolated into a URL path. GitHub's codes are hex-ish; refuse
/// anything that is not a plain token so a caller cannot reshape the path.
pub fn code_is_plain(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The production converter: the guarded client and nothing else.
pub struct GuardedGithubConverter {
    base: String,
    client: Option<reqwest::Client>,
    guard: EgressGuard,
    timeout: Duration,
}

impl GuardedGithubConverter {
    /// `https://api.github.com` under the default (public-addresses-only) policy.
    pub fn production(timeout: Duration) -> GuardedGithubConverter {
        GuardedGithubConverter::with_base(
            GITHUB_API_BASE,
            EgressPolicy::default(),
            Arc::new(SystemLookup),
            timeout,
        )
    }

    /// Tests point `base` at a loopback mock under a loopback-permitting policy.
    pub fn with_base(
        base: &str,
        policy: EgressPolicy,
        lookup: Arc<dyn HostLookup>,
        timeout: Duration,
    ) -> GuardedGithubConverter {
        let guard = EgressGuard::new(policy, lookup, timeout);
        let client = guard
            .client(
                reqwest::Client::builder()
                    .timeout(timeout)
                    .connect_timeout(timeout.min(Duration::from_secs(5))),
            )
            .map_err(|_| tracing::warn!("github converter client build failed"))
            .ok();
        GuardedGithubConverter {
            base: base.trim_end_matches('/').to_string(),
            client,
            guard,
            timeout,
        }
    }
}

#[derive(Deserialize)]
struct ConversionBody {
    id: i64,
    slug: String,
    client_id: String,
    pem: String,
    webhook_secret: String,
    owner: ConversionOwner,
    // `client_secret` is intentionally NOT declared: serde drops unknown fields.
}

#[derive(Deserialize)]
struct ConversionOwner {
    login: String,
    #[serde(rename = "type")]
    kind: String,
}

fn parse_conversion(bytes: &[u8]) -> Result<ConvertedApp, ConvertError> {
    let body: ConversionBody =
        serde_json::from_slice(bytes).map_err(|_| ConvertError::InvalidResponse)?;
    if body.id <= 0
        || body.slug.trim().is_empty()
        || body.client_id.trim().is_empty()
        || body.pem.trim().is_empty()
        || body.webhook_secret.trim().is_empty()
        || body.owner.login.trim().is_empty()
        || !matches!(body.owner.kind.as_str(), "User" | "Organization")
    {
        return Err(ConvertError::InvalidResponse);
    }
    Ok(ConvertedApp {
        app_id: body.id,
        slug: body.slug,
        client_id: body.client_id,
        owner_login: body.owner.login,
        owner_type: body.owner.kind,
        pem: Plaintext(body.pem),
        webhook_secret: Plaintext(body.webhook_secret),
    })
}

#[async_trait]
impl GithubAppConverter for GuardedGithubConverter {
    async fn convert_manifest(&self, code: &str) -> Result<ConvertedApp, ConvertError> {
        if !code_is_plain(code) {
            return Err(ConvertError::CodeRejected);
        }
        let url = format!("{}/app-manifests/{code}/conversions", self.base);
        let host = reqwest::Url::parse(&url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_ascii_lowercase))
            .ok_or(ConvertError::Unreachable)?;
        match tokio::time::timeout(self.timeout, self.guard.precheck_host(&host)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => return Err(ConvertError::Unreachable),
        }
        let client = self.client.as_ref().ok_or(ConvertError::Unreachable)?;
        let mut response = client
            .post(&url)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .header("user-agent", "oort-github-app-registration")
            .send()
            .await
            // The error's Display would carry the URL (and so the code).
            .map_err(|_| ConvertError::Unreachable)?;
        match response.status().as_u16() {
            200..=299 => {}
            404 | 422 => return Err(ConvertError::CodeRejected),
            _ => return Err(ConvertError::InvalidResponse),
        }
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > MAX_CONVERSION_BYTES {
                        return Err(ConvertError::InvalidResponse);
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => return Err(ConvertError::Unreachable),
            }
        }
        parse_conversion(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"id":4242,"slug":"oort-test","client_id":"Iv1.abc",
        "client_secret":"CLIENT-SECRET-MARKER-xyz","pem":"-----BEGIN RSA PRIVATE KEY-----\nPEM-MARKER\n-----END RSA PRIVATE KEY-----\n",
        "webhook_secret":"WEBHOOK-MARKER-123","owner":{"login":"acme","type":"Organization"}}"#;

    #[test]
    fn a_conversion_keeps_only_the_fields_the_instance_needs() {
        let app = parse_conversion(GOOD.as_bytes()).expect("parse");
        assert_eq!(app.app_id, 4242);
        assert_eq!(app.slug, "oort-test");
        assert_eq!(app.owner_type, "Organization");
        // The client_secret has nowhere to live: no field, so no Debug output either.
        let printed = format!("{app:?}");
        assert!(!printed.contains("CLIENT-SECRET-MARKER"), "{printed}");
        assert!(!printed.contains("PEM-MARKER"), "{printed}");
        assert!(!printed.contains("WEBHOOK-MARKER"), "{printed}");
        assert!(printed.contains("<redacted>"));
    }

    #[test]
    fn a_response_that_is_not_a_conversion_is_invalid() {
        for bad in [
            "{}",
            "not json",
            r#"{"id":0,"slug":"s","client_id":"c","pem":"p","webhook_secret":"w","owner":{"login":"a","type":"User"}}"#,
            r#"{"id":1,"slug":"s","client_id":"c","pem":" ","webhook_secret":"w","owner":{"login":"a","type":"User"}}"#,
            r#"{"id":1,"slug":"s","client_id":"c","pem":"p","webhook_secret":"w","owner":{"login":"a","type":"Bot"}}"#,
        ] {
            assert_eq!(
                parse_conversion(bad.as_bytes()).err(),
                Some(ConvertError::InvalidResponse),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_code_cannot_reshape_the_url_path() {
        assert!(code_is_plain("a1b2-c3_D4"));
        for bad in ["", "a/b", "a?b", "a b", "../x", "a#b", "%2e%2e"] {
            assert!(!code_is_plain(bad), "{bad}");
        }
    }

    async fn mock(status: u16, body: &'static str) -> (String, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::routing::post;
        let app = axum::Router::new().route(
            "/app-manifests/{code}/conversions",
            post(move || async move { (StatusCode::from_u16(status).unwrap(), body) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://127.0.0.1:{port}"), handle)
    }

    fn loopback_converter(base: &str) -> GuardedGithubConverter {
        GuardedGithubConverter::with_base(
            base,
            EgressPolicy {
                allow_local: true,
                local_hosts: Vec::new(),
                operator_hosts: Vec::new(),
            },
            Arc::new(SystemLookup),
            Duration::from_secs(5),
        )
    }

    #[tokio::test]
    async fn the_converter_trades_a_code_for_an_app() {
        let (base, _server) = mock(201, GOOD).await;
        let app = loopback_converter(&base)
            .convert_manifest("code123")
            .await
            .expect("convert");
        assert_eq!(app.app_id, 4242);
        assert_eq!(app.webhook_secret.expose(), "WEBHOOK-MARKER-123");
    }

    #[tokio::test]
    async fn a_spent_code_is_rejected_without_response_text() {
        let (base, _server) = mock(404, r#"{"message":"Not Found CLIENT-SECRET-MARKER"}"#).await;
        let error = loopback_converter(&base)
            .convert_manifest("code123")
            .await
            .expect_err("404");
        assert_eq!(error, ConvertError::CodeRejected);
        assert!(!format!("{error:?}").contains("MARKER"));
    }

    /// Under the default policy a loopback origin is refused before any socket
    /// is opened (the guard, not the caller, decides which hosts are reachable).
    #[tokio::test]
    async fn the_default_policy_refuses_a_private_origin() {
        let (base, _server) = mock(201, GOOD).await;
        let converter = GuardedGithubConverter::with_base(
            &base,
            EgressPolicy::default(),
            Arc::new(SystemLookup),
            Duration::from_secs(5),
        );
        assert_eq!(
            converter.convert_manifest("code123").await.err(),
            Some(ConvertError::Unreachable)
        );
    }
}
