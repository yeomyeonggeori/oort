//! The OAuth token refresh half of the OpenAI provider (ADR-0147 결정 2).
//!
//! ## Why the refresh lives here and not in momo-server
//!
//! ADR-0147 결정 4 keeps invariant #2 intact: "momo-server는 여전히 HTTP 0 …
//! OAuth 호출·갱신은 전부 agent-worker". This binary already owns the only
//! outbound HTTP in the write path, so the refresh call adds a *method* to an
//! existing boundary rather than a new boundary. `momo-server` links no HTTP
//! client and still does not.
//!
//! ## The wire, measured
//!
//! Ground truth is the shipped Codex CLI (`@openai/codex` 0.144.1, platform
//! binary `codex-darwin-arm64`), read as strings — never as credentials:
//!
//! * token endpoint `https://auth.openai.com/oauth/token`;
//! * request body `CreateOAuth2TokenRequestBody{client_id, grant_type, code,
//!   redirect_uri, code_verifier, refresh_token}`;
//! * response body `CreateOAuth2TokenResponseBody{token_type, expires_in,
//!   refresh_token, access_token, id_token}`.
//!
//! That is a plain RFC 6749 §6 refresh grant, so this module sends exactly
//! `{grant_type: "refresh_token", refresh_token, client_id?}` and reads back
//! `access_token` (required), `refresh_token` (optional — rotation), and
//! `expires_in` (optional). Nothing provider-proprietary is invented, and the
//! endpoint is per-link data (see [`momo_settings::OpenAiOAuthCredential`]) so a
//! test — or a second tenant — points it elsewhere without a code change.
//!
//! ## What a failure means to a user
//!
//! A refresh that fails is **not** a transient provider outage: the grant is
//! gone, revoked, rotated away, or was never valid. Retrying it eight times over
//! a backoff spends the turn's budget on a guaranteed repeat and leaves the
//! person staring at silence. So [`RefreshError::is_retryable`] admits only the
//! two shapes that genuinely are transient (no answer, 5xx), and everything else
//! ends the run with [`relogin_message`] — a sentence that names the one action
//! that fixes it.

use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

/// How far ahead of expiry a token counts as expired.
///
/// A request issued a second before the deadline can still arrive after it, and
/// that costs a full round trip plus a 401 before the retry. One minute is the
/// same order as the `expires_in` values OAuth providers issue for this grant
/// (tens of minutes), so it buys the margin without materially shortening the
/// token's useful life.
pub const EXPIRY_SKEW_MS: i64 = 60_000;

/// What the token endpoint answered.
#[derive(Clone, PartialEq, Eq)]
pub struct RefreshedTokens {
    pub access_token: String,
    /// Present only when the provider rotated the grant.
    pub refresh_token: Option<String>,
    /// Lifetime in seconds, as `expires_in`. Absent when the provider does not
    /// say — the credential then records no deadline and refreshes reactively.
    pub expires_in_secs: Option<i64>,
}

impl std::fmt::Debug for RefreshedTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshedTokens")
            .field("access_token", &"<redacted>")
            .field("rotated_refresh_token", &self.refresh_token.is_some())
            .field("expires_in_secs", &self.expires_in_secs)
            .finish()
    }
}

impl RefreshedTokens {
    /// The absolute deadline this answer implies, or `None` when the provider
    /// reported no lifetime.
    pub fn expires_at_ms(&self, now_ms: i64) -> Option<i64> {
        self.expires_in_secs
            .filter(|seconds| *seconds > 0)
            .map(|seconds| now_ms.saturating_add(seconds.saturating_mul(1_000)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RefreshError {
    /// The endpoint refused the grant (`invalid_grant`, 400/401/403). Terminal.
    #[error("token endpoint rejected the refresh grant: {0}")]
    Rejected(String),
    #[error("token endpoint answered with HTTP {0}")]
    HttpStatus(u16),
    #[error("token endpoint did not answer: {0}")]
    Unreachable(String),
    #[error("token endpoint returned an unusable response: {0}")]
    InvalidResponse(String),
    /// The link has no grant to refresh with — a half-written OAuth link.
    #[error("provider link carries no refresh token")]
    MissingGrant,
}

impl RefreshError {
    /// Only "no answer" and 5xx are worth a second attempt. A rejected grant, a
    /// 4xx, and an undecodable body all repeat identically, and each retry
    /// leaves the user waiting through another backoff for the same outcome.
    pub fn is_retryable(&self) -> bool {
        match self {
            RefreshError::Unreachable(_) => true,
            RefreshError::HttpStatus(status) => (500..600).contains(status),
            RefreshError::Rejected(_)
            | RefreshError::InvalidResponse(_)
            | RefreshError::MissingGrant => false,
        }
    }
}

/// The user-visible sentence for a dead grant (ADR-0147 결정 2: "갱신 실패 = run
/// 실패 + 사용자 가시 오류(재로그인 안내)").
///
/// It names the actual repair — re-run the local login and re-register the
/// result — because the person reading it in a channel cannot fix an OAuth grant
/// any other way, and "provider error" would send them to the wrong place.
pub fn relogin_message(reason: &str) -> String {
    let trimmed = reason.trim();
    let detail = if trimmed.is_empty() {
        "refresh grant was refused"
    } else {
        trimmed
    };
    format!(
        "연결된 ChatGPT 계정의 로그인이 만료되어 갱신하지 못했습니다. \
         로컬에서 다시 로그인한 뒤 설정 > AI 연결에서 토큰을 다시 등록해 주세요. \
         Details: {detail}"
    )
}

/// The seam the worker calls and the conformance harness points at its own
/// server.
#[async_trait]
pub trait TokenRefresher: Send + Sync {
    async fn refresh(
        &self,
        token_endpoint: &str,
        client_id: Option<&str>,
        refresh_token: &str,
    ) -> Result<RefreshedTokens, RefreshError>;
}

// ---------------------------------------------------------------------------
// the real one
// ---------------------------------------------------------------------------

/// `POST {token_endpoint}` with an RFC 6749 §6 refresh grant.
pub struct HttpTokenRefresher {
    client: reqwest::Client,
}

impl HttpTokenRefresher {
    pub fn new(request_timeout: Duration) -> HttpTokenRefresher {
        // A client that will not build is a TLS/runtime misconfiguration, not a
        // per-call error. Degrading to the default client keeps the worker
        // draining (every other job still works) and the refresh then fails with
        // an ordinary transport error the operator can read.
        let client = reqwest::Client::builder()
            .timeout(request_timeout)
            .build()
            .unwrap_or_else(|error| {
                tracing::warn!(error = %error, "oauth refresh client build failed; using defaults");
                reqwest::Client::new()
            });
        HttpTokenRefresher { client }
    }
}

#[async_trait]
impl TokenRefresher for HttpTokenRefresher {
    async fn refresh(
        &self,
        token_endpoint: &str,
        client_id: Option<&str>,
        refresh_token: &str,
    ) -> Result<RefreshedTokens, RefreshError> {
        if refresh_token.trim().is_empty() {
            return Err(RefreshError::MissingGrant);
        }
        let mut body = json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        });
        if let Some(client_id) = client_id.map(str::trim).filter(|value| !value.is_empty()) {
            body["client_id"] = json!(client_id);
        }

        let response = self
            .client
            .post(token_endpoint)
            .json(&body)
            .send()
            .await
            // `reqwest`'s Display prints the URL but never the request body, so
            // the grant cannot ride out through this string. The turn loop
            // redacts it a second time before anything durable sees it.
            .map_err(|error| RefreshError::Unreachable(error.to_string()))?;

        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|error| RefreshError::Unreachable(error.to_string()))?;
        if status != 200 {
            // An OAuth error body is `{"error": "...", "error_description": "..."}`
            // (RFC 6749 §5.2). Reporting that code is what turns "HTTP 400" into
            // "invalid_grant", which is the difference between an operator
            // guessing and an operator knowing to log in again.
            if let Some(reason) = decode_oauth_error(&text) {
                return Err(RefreshError::Rejected(reason));
            }
            return Err(RefreshError::HttpStatus(status));
        }
        parse_token_response(&text)
    }
}

/// Decode one token-endpoint success body.
pub fn parse_token_response(body: &str) -> Result<RefreshedTokens, RefreshError> {
    // A 200 carrying an OAuth error object is a refusal, not a token. Decoding it
    // as a token would produce an empty access token and a turn that fails one
    // layer later with a much less useful reason.
    if let Some(reason) = decode_oauth_error(body) {
        return Err(RefreshError::Rejected(reason));
    }
    let raw: RawTokenResponse = serde_json::from_str(body)
        .map_err(|error| RefreshError::InvalidResponse(error.to_string()))?;
    let access_token = raw
        .access_token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| RefreshError::InvalidResponse("response carries no access_token".into()))?;
    Ok(RefreshedTokens {
        access_token,
        refresh_token: raw
            .refresh_token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty()),
        expires_in_secs: raw.expires_in,
    })
}

/// `{"error": "...", "error_description": "..."}` → the label to report.
fn decode_oauth_error(body: &str) -> Option<String> {
    let raw: RawOAuthError = serde_json::from_str(body).ok()?;
    let code = raw.error?.trim().to_string();
    if code.is_empty() {
        return None;
    }
    match raw
        .error_description
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
    {
        Some(description) => Some(format!("{code}: {description}")),
        None => Some(code),
    }
}

#[derive(Deserialize)]
struct RawTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct RawOAuthError {
    error: Option<String>,
    error_description: Option<String>,
}

// ---------------------------------------------------------------------------
// the deterministic one
// ---------------------------------------------------------------------------

/// A refresher whose answer is fixed at construction, for unit tests that need
/// no socket. The DB-backed conformance suite deliberately uses the **real**
/// [`HttpTokenRefresher`] against its own in-test server instead, so the wire
/// above is exercised rather than assumed.
pub struct MockTokenRefresher {
    outcome: Result<RefreshedTokens, RefreshError>,
    calls: std::sync::Mutex<Vec<(String, Option<String>, String)>>,
}

impl MockTokenRefresher {
    pub fn answering(tokens: RefreshedTokens) -> MockTokenRefresher {
        MockTokenRefresher {
            outcome: Ok(tokens),
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn failing(error: RefreshError) -> MockTokenRefresher {
        MockTokenRefresher {
            outcome: Err(error),
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// `(token_endpoint, client_id, refresh_token)` per call.
    pub fn calls(&self) -> Vec<(String, Option<String>, String)> {
        self.calls.lock().expect("mock refresher lock").clone()
    }
}

#[async_trait]
impl TokenRefresher for MockTokenRefresher {
    async fn refresh(
        &self,
        token_endpoint: &str,
        client_id: Option<&str>,
        refresh_token: &str,
    ) -> Result<RefreshedTokens, RefreshError> {
        self.calls.lock().expect("mock refresher lock").push((
            token_endpoint.to_string(),
            client_id.map(str::to_string),
            refresh_token.to_string(),
        ));
        self.outcome.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refresh_answer_decodes_its_token_rotation_and_lifetime() {
        let body = r#"{"token_type":"Bearer","access_token":"at-new",
                       "refresh_token":"rt-new","expires_in":3600,"id_token":"ignored"}"#;
        let tokens = parse_token_response(body).expect("decode");
        assert_eq!(tokens.access_token, "at-new");
        assert_eq!(tokens.refresh_token.as_deref(), Some("rt-new"));
        assert_eq!(tokens.expires_at_ms(1_000), Some(3_601_000));
    }

    /// A provider that does not rotate omits `refresh_token`; the stored grant
    /// must survive that, which is asserted where it matters
    /// (`OpenAiOAuthCredential::apply_refresh`). Here: it decodes as `None`
    /// rather than as an empty rotation.
    #[test]
    fn a_non_rotating_answer_reports_no_rotation_and_no_deadline() {
        let tokens = parse_token_response(r#"{"access_token":"at-new"}"#).expect("decode");
        assert_eq!(tokens.refresh_token, None);
        assert_eq!(tokens.expires_at_ms(1_000), None);
        // `expires_in: 0` is not a lifetime — treating it as one would record a
        // deadline already in the past and refresh on every single turn.
        let zero = parse_token_response(r#"{"access_token":"a","expires_in":0}"#).expect("decode");
        assert_eq!(zero.expires_at_ms(1_000), None);
    }

    /// The difference between "log in again" and "the provider is having a bad
    /// day" is this decode. RFC 6749 §5.2 puts the answer in the body.
    #[test]
    fn an_oauth_error_body_is_named_rather_than_reported_as_a_bare_status() {
        assert_eq!(
            parse_token_response(
                r#"{"error":"invalid_grant","error_description":"token expired or revoked"}"#
            ),
            Err(RefreshError::Rejected(
                "invalid_grant: token expired or revoked".to_string()
            ))
        );
        assert_eq!(
            parse_token_response(r#"{"error":"invalid_grant"}"#),
            Err(RefreshError::Rejected("invalid_grant".to_string()))
        );
    }

    #[test]
    fn a_200_without_an_access_token_is_not_a_refresh() {
        assert!(matches!(
            parse_token_response(r#"{"token_type":"Bearer"}"#),
            Err(RefreshError::InvalidResponse(_))
        ));
        assert!(matches!(
            parse_token_response(r#"{"access_token":"   "}"#),
            Err(RefreshError::InvalidResponse(_))
        ));
        assert!(matches!(
            parse_token_response("<html>gateway</html>"),
            Err(RefreshError::InvalidResponse(_))
        ));
    }

    /// Retrying a refused grant eight times over a backoff spends the user's
    /// turn on a guaranteed repeat and delays the one message that helps them.
    #[test]
    fn only_no_answer_and_5xx_are_worth_retrying() {
        assert!(RefreshError::Unreachable("connect refused".into()).is_retryable());
        assert!(RefreshError::HttpStatus(503).is_retryable());
        assert!(!RefreshError::HttpStatus(400).is_retryable());
        assert!(!RefreshError::HttpStatus(401).is_retryable());
        assert!(!RefreshError::Rejected("invalid_grant".into()).is_retryable());
        assert!(!RefreshError::MissingGrant.is_retryable());
        assert!(!RefreshError::InvalidResponse("x".into()).is_retryable());
    }

    /// The message a person actually reads. It has to name the repair, because
    /// nobody can fix a revoked OAuth grant from inside the chat.
    #[test]
    fn the_relogin_message_names_the_repair_not_just_the_symptom() {
        let message = relogin_message("invalid_grant: token expired");
        assert!(message.contains("다시 로그인"));
        assert!(message.contains("AI 연결"));
        assert!(message.ends_with("Details: invalid_grant: token expired"));
        assert!(relogin_message("  ").contains("refresh grant was refused"));
    }

    /// The debug path a future `tracing::error!(?tokens)` would take.
    #[test]
    fn debugging_a_refresh_answer_never_prints_a_token() {
        let tokens = RefreshedTokens {
            access_token: "at-supersecret".into(),
            refresh_token: Some("rt-supersecret".into()),
            expires_in_secs: Some(60),
        };
        let rendered = format!("{tokens:?}");
        assert!(!rendered.contains("supersecret"), "{rendered}");
        assert!(
            rendered.contains("rotated_refresh_token: true"),
            "{rendered}"
        );
    }

    #[tokio::test]
    async fn a_link_without_a_grant_never_reaches_the_network() {
        let refresher = HttpTokenRefresher::new(Duration::from_millis(1));
        assert_eq!(
            refresher
                .refresh("http://127.0.0.1:1/oauth/token", None, "   ")
                .await,
            Err(RefreshError::MissingGrant),
            "an empty grant is a config fact, not a request to make"
        );
    }
}
