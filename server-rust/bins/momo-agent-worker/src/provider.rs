//! The LLM provider call — the one outbound HTTP this binary makes.
//!
//! ## What contract this implements, and how it was measured
//!
//! Swift `AgentWorker/HermesTransport.swift` is the ground truth, and its
//! contract is the **OpenAI-compatible `POST {base_url}/chat/completions`** with
//! `Authorization: Bearer <token>` (:123-128, :244-248). That is the shape momo
//! speaks to *every* model: an Anthropic model is reached by pointing
//! `HERMES_BASE_URL` (or the operator's `provider_link.base_url`) at the hermes
//! gateway and naming a `claude-*` model — the payload's `model` field is the
//! only thing that changes (`MessageRoutes.swift:2312`, "the RESOLVED model is
//! always on the payload"). So one adapter *is* the provider set; there is no
//! second wire format to implement, and inventing a native Anthropic client here
//! would be a second contract nobody else in the repo speaks.
//!
//! Two Swift behaviours are ported verbatim because dropping either changes what
//! a user sees:
//!
//! * **The 200-with-error-envelope check** (:174-178, :257-261). Gateways
//!   occasionally answer 200 with `{"error": {"message": …}}`. That is a
//!   response, not an outage, so it must propagate as a failure rather than
//!   fall over to a retry — and it must not be decoded as an empty successful
//!   turn, which would silently swallow the user's request.
//! * **The availability/propagate split** (`ProviderCascade.decide(status:)`,
//!   :54-61). No response and 5xx/429 are availability failures; every other
//!   4xx is a caller/config error that retrying only spends budget on. The rule
//!   already exists in Rust as [`momo_settings::chain::classify_status`], so
//!   this module reuses it rather than writing a third copy.
//!
//! **Not ported in B5.1 (deliberate):** SSE streaming and the non-stream
//! fallback pair. The packet scopes streaming out, so this issues the
//! `stream=false` request directly — which is exactly Swift's
//! `nonStreamCompletion` (:232-284), the path that already exists for gateways
//! that mangle streamed tool calls. Tool calls themselves are also out of scope
//! (approvals/work-controls are later batches); a turn that returns only tool
//! calls therefore produces no text, which the worker reports as a failed turn
//! rather than an empty reply.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use momo_settings::chain::classify_status;
use momo_settings::CascadeDecision;
use serde::Deserialize;
use serde_json::json;

/// One OpenAI-compatible chat message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> ChatMessage {
        ChatMessage {
            role: "system".to_string(),
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> ChatMessage {
        ChatMessage {
            role: "user".to_string(),
            content: content.into(),
        }
    }
}

/// One turn's request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<i32>,
}

/// The token counts a completion reports, as `usage_ledger` records them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChatUsage {
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub cached_tokens: i32,
    pub reasoning_tokens: i32,
}

/// One turn's answer. `usage == None` is what makes the ledger row
/// `was_estimated` (Swift `wasEstimated = usage == nil`, WorkerService :523).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatCompletion {
    pub text: String,
    pub usage: Option<ChatUsage>,
}

/// Where this turn's request goes and what it presents.
///
/// `Debug` is implemented by hand: the bearer is a live provider credential, and
/// a `#[derive(Debug)]` on this struct would put it in the first
/// `tracing::error!(?endpoint, …)` anyone adds (ADR-0004 Rules #2/#5).
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderEndpoint {
    pub base_url: String,
    pub bearer: String,
    /// `"database"` when the operator's `provider_link` supplied it, else
    /// `"environment"` — the only provenance fact that may be logged.
    pub source: &'static str,
}

impl std::fmt::Debug for ProviderEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderEndpoint")
            .field(
                "base_url",
                &momo_settings::redacted_endpoint_label(&self.base_url),
            )
            .field("bearer", &"<redacted>")
            .field("source", &self.source)
            .finish()
    }
}

impl ProviderEndpoint {
    /// The only endpoint string a log line may carry (userinfo/query/fragment
    /// stripped, Swift `redactedEndpointLabel`).
    pub fn label(&self) -> String {
        momo_settings::redacted_endpoint_label(&self.base_url)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("provider answered with HTTP {0}")]
    HttpStatus(u16),
    /// No answer at all: connect refused, DNS, TLS, timeout.
    #[error("provider did not answer: {0}")]
    Unreachable(String),
    /// A 200 whose body is not an OpenAI completion, or one carrying no text.
    #[error("provider returned an unusable response: {0}")]
    InvalidResponse(String),
    /// HTTP 200 with `{"error": {"message": …}}`.
    #[error("provider returned an error envelope: {0}")]
    ErrorEnvelope(String),
}

impl ProviderError {
    /// Swift `ProviderCascade.decide` (:54-77) as a two-valued question: is this
    /// worth trying again, or is retrying it spending budget on a guaranteed
    /// repeat?
    ///
    /// `Unreachable` and 5xx/429 are availability failures → retry. Every other
    /// 4xx, an undecodable body, and an error envelope are the provider telling
    /// us something true about *this request* → do not retry.
    pub fn is_retryable(&self) -> bool {
        match self {
            ProviderError::Unreachable(_) => true,
            ProviderError::HttpStatus(status) => {
                matches!(classify_status(Some(*status)), CascadeDecision::FallOver(_))
            }
            ProviderError::InvalidResponse(_) | ProviderError::ErrorEnvelope(_) => false,
        }
    }
}

/// The seam the worker calls and the conformance tests replace.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError>;
}

// ---------------------------------------------------------------------------
// The real one: OpenAI-compatible HTTP
// ---------------------------------------------------------------------------

/// `POST {base_url}/chat/completions`, `stream=false` (Swift :232-284).
pub struct OpenAiCompatProvider {
    client: reqwest::Client,
}

impl OpenAiCompatProvider {
    pub fn new(request_timeout: Duration) -> Result<OpenAiCompatProvider, reqwest::Error> {
        Ok(OpenAiCompatProvider {
            client: reqwest::Client::builder()
                .timeout(request_timeout)
                .build()?,
        })
    }
}

#[async_trait]
impl ChatProvider for OpenAiCompatProvider {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        let url = format!(
            "{}/chat/completions",
            endpoint.base_url.trim_end_matches('/')
        );
        let body = json!({
            "model": request.model,
            "messages": request
                .messages
                .iter()
                .map(|message| json!({"role": message.role, "content": message.content}))
                .collect::<Vec<_>>(),
            "stream": false,
            "max_tokens": request.max_tokens,
        });

        let response = self
            .client
            .post(url)
            .bearer_auth(&endpoint.bearer)
            .json(&body)
            .send()
            .await
            // The error is stringified through reqwest's Display, which never
            // includes the request headers — the bearer cannot ride out here.
            .map_err(|error| ProviderError::Unreachable(error.to_string()))?;

        let status = response.status().as_u16();
        if status != 200 {
            return Err(ProviderError::HttpStatus(status));
        }
        let text = response
            .text()
            .await
            .map_err(|error| ProviderError::Unreachable(error.to_string()))?;
        parse_completion(&text)
    }
}

/// Decode one non-streamed completion body. Split out from the HTTP call so the
/// two Swift-parity rejections are testable without a server.
pub fn parse_completion(body: &str) -> Result<ChatCompletion, ProviderError> {
    // The envelope check runs FIRST, exactly as Swift does (:257-261): a 200
    // carrying an error object is not a completion, and decoding it as one would
    // report an empty successful turn.
    if let Ok(envelope) = serde_json::from_str::<ErrorEnvelope>(body) {
        if let Some(message) = envelope
            .error
            .and_then(|error| error.message)
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty())
        {
            return Err(ProviderError::ErrorEnvelope(message));
        }
    }

    let completion: RawCompletion = serde_json::from_str(body)
        .map_err(|error| ProviderError::InvalidResponse(error.to_string()))?;
    let choice = completion
        .choices
        .as_deref()
        .and_then(<[RawChoice]>::first)
        .ok_or_else(|| ProviderError::InvalidResponse("completion has no choices".to_string()))?;
    let text = choice
        .message
        .as_ref()
        .and_then(|message| message.content.clone())
        .unwrap_or_default();

    Ok(ChatCompletion {
        text,
        usage: completion.usage.map(|usage| ChatUsage {
            prompt_tokens: usage.prompt_tokens.unwrap_or(0),
            completion_tokens: usage.completion_tokens.unwrap_or(0),
            cached_tokens: usage
                .prompt_tokens_details
                .and_then(|details| details.cached_tokens)
                .unwrap_or(0),
            reasoning_tokens: usage
                .completion_tokens_details
                .and_then(|details| details.reasoning_tokens)
                .unwrap_or(0),
        }),
    })
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    message: Option<String>,
}

#[derive(Deserialize)]
struct RawCompletion {
    choices: Option<Vec<RawChoice>>,
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct RawChoice {
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct RawUsage {
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    prompt_tokens_details: Option<RawPromptDetails>,
    completion_tokens_details: Option<RawCompletionDetails>,
}

#[derive(Deserialize, Clone, Copy)]
struct RawPromptDetails {
    cached_tokens: Option<i32>,
}

#[derive(Deserialize, Clone, Copy)]
struct RawCompletionDetails {
    reasoning_tokens: Option<i32>,
}

// ---------------------------------------------------------------------------
// The deterministic one: tests and local staging
// ---------------------------------------------------------------------------

/// A provider whose answer is a pure function of its input.
///
/// It exists so a conformance test can stage a whole turn — and a whole provider
/// outage — without a network, a key, or a mock server process. It is **never**
/// constructed by `main.rs`: a binary that could silently answer with canned
/// text if an env var were mistyped would be a far worse failure than a boot
/// error, so the substitution seam is the constructor, not the environment.
pub struct MockChatProvider {
    outcome: MockOutcome,
    calls: Mutex<Vec<ObservedCall>>,
}

enum MockOutcome {
    Echo,
    Fail(ProviderError),
}

/// What the mock was asked, recorded so a test can assert on it — including
/// which bearer the worker resolved for the turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedCall {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub bearer: String,
    pub base_url: String,
}

impl MockChatProvider {
    /// Answers `"mock: <last user content>"` with fixed token counts.
    pub fn echo() -> MockChatProvider {
        MockChatProvider {
            outcome: MockOutcome::Echo,
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Always fails with `error`.
    pub fn failing(error: ProviderError) -> MockChatProvider {
        MockChatProvider {
            outcome: MockOutcome::Fail(error),
            calls: Mutex::new(Vec::new()),
        }
    }

    pub fn calls(&self) -> Vec<ObservedCall> {
        self.calls.lock().expect("mock provider lock").clone()
    }

    /// The deterministic answer for a given request — exposed so a test can
    /// assert on the exact body it expects to find in the channel.
    pub fn echo_text(request: &ChatRequest) -> String {
        let last_user = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(|message| message.content.as_str())
            .unwrap_or("");
        format!("mock: {last_user}")
    }
}

#[async_trait]
impl ChatProvider for MockChatProvider {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        self.calls
            .lock()
            .expect("mock provider lock")
            .push(ObservedCall {
                model: request.model.clone(),
                messages: request.messages.clone(),
                bearer: endpoint.bearer.clone(),
                base_url: endpoint.base_url.clone(),
            });
        match &self.outcome {
            MockOutcome::Fail(error) => Err(error.clone()),
            MockOutcome::Echo => Ok(ChatCompletion {
                text: MockChatProvider::echo_text(request),
                usage: Some(ChatUsage {
                    prompt_tokens: 11,
                    completion_tokens: 7,
                    cached_tokens: 3,
                    reasoning_tokens: 2,
                }),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 200 with an error object must not decode as an empty successful turn —
    /// that is how a user's question disappears without a trace.
    #[test]
    fn a_200_error_envelope_is_a_failure_not_an_empty_answer() {
        let body = r#"{"error": {"message": "model not found"}}"#;
        assert_eq!(
            parse_completion(body),
            Err(ProviderError::ErrorEnvelope("model not found".to_string()))
        );
    }

    /// An envelope-shaped 200 with a blank message is not an envelope; it must
    /// fall through to the completion decode rather than fail as one.
    #[test]
    fn a_blank_error_message_is_not_treated_as_an_envelope() {
        let body = r#"{"error": {"message": "  "}, "choices": [{"message": {"content": "hi"}}]}"#;
        assert_eq!(
            parse_completion(body),
            Ok(ChatCompletion {
                text: "hi".to_string(),
                usage: None
            })
        );
    }

    #[test]
    fn a_completion_decodes_its_text_and_every_usage_axis() {
        let body = r#"{
            "choices": [{"message": {"content": "안녕하세요"}}],
            "usage": {
                "prompt_tokens": 100, "completion_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 60},
                "completion_tokens_details": {"reasoning_tokens": 5}
            }
        }"#;
        assert_eq!(
            parse_completion(body),
            Ok(ChatCompletion {
                text: "안녕하세요".to_string(),
                usage: Some(ChatUsage {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    cached_tokens: 60,
                    reasoning_tokens: 5,
                })
            })
        );
    }

    /// A 200 that is not a completion at all must stay terminal (Swift
    /// `TransportError.invalidResponse`, :288-290).
    #[test]
    fn a_200_that_is_not_a_completion_stays_terminal() {
        assert!(matches!(
            parse_completion("<html>gateway</html>"),
            Err(ProviderError::InvalidResponse(_))
        ));
        assert!(matches!(
            parse_completion(r#"{"choices": []}"#),
            Err(ProviderError::InvalidResponse(_))
        ));
    }

    /// The retry split, which decides whether a user waits for a second attempt
    /// or gets told now. Widening it to all 4xx would retry a bad API key eight
    /// times, at cost, and hide the real cause.
    #[test]
    fn only_no_response_and_5xx_429_are_worth_retrying() {
        assert!(ProviderError::Unreachable("connect refused".into()).is_retryable());
        assert!(ProviderError::HttpStatus(429).is_retryable());
        assert!(ProviderError::HttpStatus(500).is_retryable());
        assert!(ProviderError::HttpStatus(503).is_retryable());
        assert!(!ProviderError::HttpStatus(400).is_retryable());
        assert!(!ProviderError::HttpStatus(401).is_retryable());
        assert!(!ProviderError::HttpStatus(404).is_retryable());
        assert!(!ProviderError::InvalidResponse("x".into()).is_retryable());
        assert!(!ProviderError::ErrorEnvelope("x".into()).is_retryable());
    }

    /// The bearer must not be reachable through the ordinary debug path, because
    /// that is the one a future `tracing::error!(?endpoint)` would take.
    #[test]
    fn debugging_an_endpoint_never_prints_its_bearer() {
        let endpoint = ProviderEndpoint {
            base_url: "https://gateway.example/v1".to_string(),
            bearer: "sk-live-supersecret".to_string(),
            source: "database",
        };
        let rendered = format!("{endpoint:?}");
        assert!(!rendered.contains("sk-live-supersecret"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(rendered.contains("gateway.example"), "{rendered}");
    }

    #[tokio::test]
    async fn the_mock_echoes_the_last_user_turn_and_records_the_bearer() {
        let provider = MockChatProvider::echo();
        let endpoint = ProviderEndpoint {
            base_url: "http://mock/v1".to_string(),
            bearer: "sk-test".to_string(),
            source: "environment",
        };
        let request = ChatRequest {
            model: "m".to_string(),
            messages: vec![ChatMessage::system("sys"), ChatMessage::user("질문")],
            max_tokens: Some(64),
        };
        let completion = provider.complete(&endpoint, &request).await.expect("mock");
        assert_eq!(completion.text, "mock: 질문");
        assert_eq!(provider.calls().len(), 1);
        assert_eq!(provider.calls()[0].bearer, "sk-test");
    }
}
