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
//! ## B5.4 / ADR-0147: what a subscription OAuth token changes here — and what
//! it does not
//!
//! ADR-0147 lets the vault hold a ChatGPT subscription OAuth grant instead of a
//! gateway API key. That changes **which credential** this module presents and
//! **who refreshes it** ([`crate::oauth`]), plus one measured header:
//! `chatgpt-account-id`, which is how the ChatGPT backend picks the paying
//! account when a token is entitled to several.
//!
//! B5.4 also measured the caveat that made a second wire unavoidable: the shipped
//! Codex CLI (`@openai/codex` 0.144.1) does not send a ChatGPT OAuth token to
//! `/chat/completions` at all. Its strings show the pair
//! `https://chatgpt.com/backend-api/codex` + `/responses` — the **Responses
//! API** — and `https://api.openai.com/v1/responses` for the API-key path.
//!
//! ## B5.4b: two wires, and the one thing that chooses between them
//!
//! ADR-0147's 이행 note resolves the "no second contract without a decision" rule
//! above explicitly: the Responses adapter is "결정 2의 필수 수단, 별도 방향 변경
//! 아님". So this crate now speaks two wires, and exactly one fact selects
//! between them — the **sealed envelope kind** ([`ProviderWire::for_credential`]):
//!
//! | vault contents | wire | path |
//! |---|---|---|
//! | [`LinkCredential::Bearer`] (every row that exists today, and the env fallback) | chat/completions | `POST {base_url}/chat/completions` |
//! | [`LinkCredential::OpenAiOAuth`] (ADR-0147) | Responses | `POST {base_url}/responses` |
//!
//! The mapping is on the credential rather than on the base URL because the base
//! URL is free text an operator types, and guessing a protocol from a hostname is
//! how a working link silently starts speaking the wrong one. The kind is the
//! thing momo actually knows.
//!
//! Routing lives in [`WireRoutedProvider`], not inside either adapter, so each
//! adapter stays one wire a reviewer can read end to end and a test can point a
//! mock at either arm.
//!
//! **The chat wire stays non-streamed (B5.1, still true after B5.4c).** This
//! adapter issues the `stream=false` request directly — which is exactly Swift's
//! `nonStreamCompletion` (:232-284), the path that already exists for gateways
//! that mangle streamed tool calls. B5.4c makes the *Responses* wire streamed,
//! because the ChatGPT backend refuses anything else ([`crate::responses`]); a
//! legacy bearer link is untouched by that and keeps sending `stream=false`.
//! **goal SRV-T1 adds the tool channel.** [`ChatRequest::tools`] carries the
//! agent's declared functions (`agent.tool_schema`, which B5.2 already shipped
//! on the job payload and this worker discarded), and [`ChatCompletion`] grew
//! `tool_calls`. Until this batch a turn that returned only tool calls produced
//! no text and was reported as a *failed* turn — the model asked to do something
//! and the server called that an outage.
//!
//! The parse is deliberately tolerant in one direction only: a tool call whose
//! `arguments` string is not valid JSON is still returned as a tool call, with
//! its raw text preserved, because the honest answer to a malformed argument is
//! a `tool_result` telling the model so — not a dropped call that leaves the run
//! looking like it produced nothing.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use momo_settings::chain::classify_status;
use momo_settings::{CascadeDecision, LinkCredential};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::responses::OpenAiResponsesProvider;

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
    /// The agent's declared functions, verbatim from `agent.tool_schema`
    /// (`001_init.sql:80`, "OpenAI function defs").
    ///
    /// Passed through rather than re-shaped: the column already holds the
    /// provider's own format, and a translation layer here would be a second
    /// schema to keep in sync with a vendor's. Empty means the `tools` key is
    /// omitted entirely — sending `"tools": []` makes some gateways reject the
    /// request outright.
    pub tools: Vec<Value>,
    /// Tools **momo itself** implements, offered because this agent's profile
    /// turned them on (goal SRV-B3f).
    ///
    /// Kept apart from [`tools`](Self::tools) rather than merged into it,
    /// because the two have opposite provenance and opposite handling.
    /// `tools` is operator-authored JSON in the provider's own format and is
    /// passed through untouched; these are momo's, and each wire renders them
    /// in ITS shape — `/chat/completions` nests the fields under a `function`
    /// object, the Responses API flattens them onto the tool. Pre-rendering
    /// them into `tools` would be correct on one wire and silently wrong on the
    /// other.
    pub momo_tools: Vec<momo_agent::tools::ToolDefinition>,
}

/// Render momo's own tool definitions in the `/chat/completions` shape.
fn chat_tool_json(definitions: &[momo_agent::tools::ToolDefinition]) -> Vec<Value> {
    definitions
        .iter()
        .map(|definition| {
            serde_json::json!({
                "type": "function",
                "function": {
                    // goal SRV-HOT1: the wire-safe name. momo's own dots stay in
                    // momo; the backend refuses them with `400 Invalid
                    // 'tools[0].name'` and kills the whole request.
                    "name": momo_agent::tools::wire_tool_name(definition.name),
                    "description": definition.description,
                    "parameters": definition.parameters,
                }
            })
        })
        .collect()
}

/// One tool call the model asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderToolCall {
    /// The provider's own id for this call. The whole protocol hangs off it:
    /// it is what a `tool_result` references and what makes the pairing
    /// idempotent.
    pub id: String,
    pub name: String,
    /// The raw `arguments` string exactly as the provider sent it.
    ///
    /// Kept as text, not as a parsed object, because it is what must be shown
    /// to the model again on resume — re-serialising would reorder keys, and to
    /// a model a different string is a different input.
    pub arguments: String,
}

impl ProviderToolCall {
    /// The arguments as JSON, or `Null` when the provider sent something that is
    /// not JSON.
    ///
    /// `Null` rather than an error: a malformed argument is a conversation to
    /// have with the model through a `tool_result`, not a transport failure.
    pub fn arguments_json(&self) -> Value {
        serde_json::from_str(&self.arguments).unwrap_or(Value::Null)
    }
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
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatCompletion {
    pub text: String,
    pub usage: Option<ChatUsage>,
    /// The tool calls this turn asked for, in the order the provider listed
    /// them (goal SRV-T1).
    ///
    /// A completion may carry text, tool calls, or both. `text.is_empty() &&
    /// tool_calls.is_empty()` is the only shape the worker still treats as a
    /// failed turn.
    pub tool_calls: Vec<ProviderToolCall>,
}

/// Which request/response format an endpoint speaks (B5.4b).
///
/// This is deliberately a two-valued enum rather than a free string: the only
/// two wires momo implements are the two below, and an unknown third value would
/// have to be handled at every call site with a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProviderWire {
    /// `POST {base_url}/chat/completions` — the contract every existing
    /// `provider_link` row and the env fallback speak (Swift `HermesTransport`).
    #[default]
    ChatCompletions,
    /// `POST {base_url}/responses` — the OpenAI Responses API, which is what a
    /// ChatGPT subscription OAuth token is entitled to call (ADR-0147 이행).
    Responses,
}

impl ProviderWire {
    /// The **only** thing that decides the wire: what the vault holds.
    ///
    /// A legacy bearer keeps chat/completions byte for byte — including the
    /// env-resolved transport, which has no envelope at all — so B5.4b cannot
    /// change what a deployment that never registered an OAuth link sends.
    pub fn for_credential(credential: &LinkCredential) -> ProviderWire {
        match credential {
            LinkCredential::Bearer(_) => ProviderWire::ChatCompletions,
            LinkCredential::OpenAiOAuth(_) => ProviderWire::Responses,
        }
    }

    /// The path appended to `base_url`.
    pub fn path(self) -> &'static str {
        match self {
            ProviderWire::ChatCompletions => "/chat/completions",
            ProviderWire::Responses => "/responses",
        }
    }

    /// A non-secret label for logs and `Debug`.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderWire::ChatCompletions => "chat_completions",
            ProviderWire::Responses => "responses",
        }
    }
}

/// Where this turn's request goes and what it presents.
///
/// `Debug` is implemented by hand: the bearer is a live provider credential, and
/// a `#[derive(Debug)]` on this struct would put it in the first
/// `tracing::error!(?endpoint, …)` anyone adds (ADR-0004 Rules #2/#5).
#[derive(Clone, PartialEq, Eq, Default)]
pub struct ProviderEndpoint {
    pub base_url: String,
    pub bearer: String,
    /// `"database"` when the operator's `provider_link` supplied it, else
    /// `"environment"` — the only provenance fact that may be logged.
    pub source: &'static str,
    /// Which wire this endpoint speaks (B5.4b). Defaults to the legacy
    /// chat/completions contract, so anything that builds an endpoint without
    /// thinking about wires keeps the behaviour that shipped before B5.4b.
    pub wire: ProviderWire,
    /// `chatgpt-account-id` for an ADR-0147 subscription OAuth link.
    ///
    /// A ChatGPT OAuth token can be entitled to more than one account, and the
    /// backend picks which one pays from this header — the Codex CLI carries
    /// `tokens.account_id` from its `auth.json` for exactly that reason. It is an
    /// account *identifier*, not a credential, but it is still only sent, never
    /// logged: pairing it with a redacted endpoint label in a log line would
    /// deanonymise whose subscription a run spent.
    pub account_id: Option<String>,
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
            .field("wire", &self.wire.as_str())
            .field("account_id", &self.account_id.as_ref().map(|_| "<present>"))
            .finish()
    }
}

impl ProviderEndpoint {
    /// The only endpoint string a log line may carry (userinfo/query/fragment
    /// stripped, Swift `redactedEndpointLabel`).
    pub fn label(&self) -> String {
        momo_settings::redacted_endpoint_label(&self.base_url)
    }

    /// The absolute URL this turn posts to: the operator's base URL plus the
    /// wire's path. One function, so the two adapters cannot drift on how a
    /// trailing slash is handled.
    pub fn url(&self) -> String {
        format!(
            "{}{}",
            self.base_url.trim_end_matches('/'),
            self.wire.path()
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("provider answered with HTTP {0}: {1}")]
    HttpStatus(u16, String),
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
            ProviderError::HttpStatus(status, _) => {
                matches!(classify_status(Some(*status)), CascadeDecision::FallOver(_))
            }
            ProviderError::InvalidResponse(_) | ProviderError::ErrorEnvelope(_) => false,
        }
    }
}

/// Where a streamed answer's slices go **while the turn is still running**
/// (goal SRV-B3e).
///
/// Deliberately **synchronous and infallible**. The implementations that call it
/// are inside a byte-fed SSE loop, and anything that could block or fail there
/// would put the provider read at the mercy of the database: a slow `INSERT`
/// would stall the socket, and a failed one would have to decide whether to
/// abandon an answer that is arriving fine. So the sink's whole job is to hand
/// the slice off — `momo-agent-worker`'s implementation pushes it onto an
/// unbounded channel and returns — and every question about batching, ordering
/// and failure belongs to whoever drains that channel.
pub trait DeltaSink: Send + Sync {
    /// One slice of assistant text, exactly as the provider emitted it. Never
    /// the accumulated answer.
    fn text_delta(&self, delta: &str);
}

/// The sink for every path that does not publish progress — non-streaming
/// wires, retries whose partials were already sent, and every unit test.
pub struct DiscardDeltas;

impl DeltaSink for DiscardDeltas {
    fn text_delta(&self, _delta: &str) {}
}

/// The seam the worker calls and the conformance tests replace.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError>;

    /// The same turn, with somewhere to put the slices as they arrive.
    ///
    /// The default **ignores the sink and calls [`complete`](Self::complete)**,
    /// which is the honest answer for a wire that does not stream: those
    /// providers have no slices to report, and a default that pretended
    /// otherwise (say, by emitting the whole answer as one delta at the end)
    /// would put a "streaming" frame on the rail for a turn that never streamed.
    ///
    /// It is a defaulted method rather than a parameter on `complete` so that
    /// adding progress could not churn every implementation and every test
    /// harness in the workspace — only the one provider that actually has a
    /// stream to report overrides it.
    async fn complete_streaming(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
        sink: &dyn DeltaSink,
    ) -> Result<ChatCompletion, ProviderError> {
        let _ = sink;
        self.complete(endpoint, request).await
    }
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
        Ok(OpenAiCompatProvider::from_client(
            reqwest::Client::builder()
                .timeout(request_timeout)
                .build()?,
        ))
    }

    /// Build on an existing client, so the two wires of a
    /// [`WireRoutedProvider`] share one connection pool instead of holding two.
    pub fn from_client(client: reqwest::Client) -> OpenAiCompatProvider {
        OpenAiCompatProvider { client }
    }
}

#[async_trait]
impl ChatProvider for OpenAiCompatProvider {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        let mut body = json!({
            "model": request.model,
            "messages": request
                .messages
                .iter()
                .map(|message| json!({"role": message.role, "content": message.content}))
                .collect::<Vec<_>>(),
            "stream": false,
            "max_tokens": request.max_tokens,
        });
        // Omitted entirely when the agent declares none: several
        // OpenAI-compatible gateways 400 on `"tools": []`, and an agent with no
        // tool schema is the common case.
        // The agent's own JSON first, then momo's — an operator who declared a
        // function by hand keeps the position they gave it.
        let mut tools = request.tools.clone();
        tools.extend(chat_tool_json(&request.momo_tools));
        if !tools.is_empty() {
            if let Some(object) = body.as_object_mut() {
                object.insert("tools".into(), Value::Array(tools));
            }
        }
        let text = post_json(&self.client, endpoint, &body).await?;
        parse_completion(&text)
    }
}

/// The one outbound call both wires make: `POST endpoint.url()` with the
/// resolved Bearer, returning the whole 200 body.
///
/// It is shared rather than duplicated because the two rules in it are the ones
/// a second copy would quietly get wrong: the `chatgpt-account-id` header (sent
/// on both wires — a subscription token needs it wherever it goes) and the
/// "non-200 is a status, not a body" split that keeps
/// [`ProviderError::is_retryable`] the only place retry policy lives.
pub(crate) async fn post_json(
    client: &reqwest::Client,
    endpoint: &ProviderEndpoint,
    body: &serde_json::Value,
) -> Result<String, ProviderError> {
    let response = post(client, endpoint, body, None).await?;
    response
        .text()
        .await
        .map_err(|error| ProviderError::Unreachable(error.to_string()))
}

/// The same POST, handed back **before** the body is read (B5.4c).
///
/// The Responses wire cannot use [`post_json`]: a `text/event-stream` answer is
/// only complete when the provider closes it, so buffering it into a `String`
/// first would make every streamed turn wait for the whole stream *and* discard
/// the event boundaries the adapter has to read. The status/header rules stay in
/// one place — the caller only owns the body.
pub(crate) async fn post_event_stream(
    client: &reqwest::Client,
    endpoint: &ProviderEndpoint,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ProviderError> {
    post(client, endpoint, body, Some("text/event-stream")).await
}

/// Send the request and settle the status question; the body is the caller's.
async fn post(
    client: &reqwest::Client,
    endpoint: &ProviderEndpoint,
    body: &serde_json::Value,
    accept: Option<&str>,
) -> Result<reqwest::Response, ProviderError> {
    let mut request_builder = client.post(endpoint.url()).bearer_auth(&endpoint.bearer);
    if let Some(account_id) = endpoint
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request_builder = request_builder.header("chatgpt-account-id", account_id);
    }
    if let Some(accept) = accept {
        request_builder = request_builder.header("accept", accept);
    }

    let response = request_builder
        .json(body)
        .send()
        .await
        // The error is stringified through reqwest's Display, which never
        // includes the request headers — the bearer cannot ride out here.
        .map_err(|error| ProviderError::Unreachable(error.to_string()))?;

    let status = response.status().as_u16();
    if status != 200 {
        // Diagnosis needs the provider's own error sentence. The body is the
        // provider's response, never our request — no bearer can ride here.
        // Measured worth: NCP's live smoke reduced the ChatGPT backend's refusal
        // to this one sentence — "Stream must be set to true" — which is the
        // fact B5.4c is built on.
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        return Err(ProviderError::HttpStatus(status, snippet));
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// the mapping: envelope kind → adapter
// ---------------------------------------------------------------------------

/// Sends each turn to the adapter its endpoint's [`ProviderWire`] names.
///
/// This is the whole of B5.4b's "second wire" risk surface, and it is kept to
/// one `match` on purpose. Neither adapter knows the other exists, so a bug in
/// the Responses path cannot change a byte of what a legacy bearer link sends —
/// which is the property that lets an existing deployment take this upgrade
/// without re-testing its gateway.
pub struct WireRoutedProvider {
    chat_completions: Arc<dyn ChatProvider>,
    responses: Arc<dyn ChatProvider>,
}

impl WireRoutedProvider {
    pub fn new(
        chat_completions: Arc<dyn ChatProvider>,
        responses: Arc<dyn ChatProvider>,
    ) -> WireRoutedProvider {
        WireRoutedProvider {
            chat_completions,
            responses,
        }
    }

    /// The shipped pair, on one shared HTTP client.
    pub fn http(request_timeout: Duration) -> Result<WireRoutedProvider, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(request_timeout)
            .build()?;
        Ok(WireRoutedProvider::new(
            Arc::new(OpenAiCompatProvider::from_client(client.clone())),
            Arc::new(OpenAiResponsesProvider::from_client(client)),
        ))
    }
}

#[async_trait]
impl ChatProvider for WireRoutedProvider {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        match endpoint.wire {
            ProviderWire::ChatCompletions => {
                self.chat_completions.complete(endpoint, request).await
            }
            ProviderWire::Responses => self.responses.complete(endpoint, request).await,
        }
    }

    /// Forwarded, not defaulted: the whole point of this router is that a real
    /// turn and a test take the same branch, and a router that silently dropped
    /// the sink would make the Responses wire look non-streaming in production
    /// while its own suite streamed fine.
    async fn complete_streaming(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
        sink: &dyn DeltaSink,
    ) -> Result<ChatCompletion, ProviderError> {
        match endpoint.wire {
            // `/chat/completions` is sent with `stream=false` here, so there is
            // nothing to report slice by slice.
            ProviderWire::ChatCompletions => {
                self.chat_completions.complete(endpoint, request).await
            }
            ProviderWire::Responses => {
                self.responses
                    .complete_streaming(endpoint, request, sink)
                    .await
            }
        }
    }
}

/// The provider `main.rs` runs and the conformance suites inject, so a test and
/// production route identically. A test that built only one adapter would prove
/// nothing about which one a real turn picks.
pub fn http_provider(request_timeout: Duration) -> Result<Arc<dyn ChatProvider>, reqwest::Error> {
    Ok(Arc::new(WireRoutedProvider::http(request_timeout)?))
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

    // goal SRV-T1. An entry missing its `function` block, its name, or its id
    // is dropped rather than guessed at: a tool call with no id cannot be
    // answered (a `tool_result` references it), and one with no name cannot be
    // dispatched. Silently inventing either would produce a call the model
    // never made.
    let tool_calls = choice
        .message
        .as_ref()
        .and_then(|message| message.tool_calls.as_ref())
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| {
                    let function = call.function.as_ref()?;
                    let name = function.name.as_ref()?.trim();
                    let id = call.id.as_ref()?.trim();
                    if name.is_empty() || id.is_empty() {
                        return None;
                    }
                    Some(ProviderToolCall {
                        id: id.to_string(),
                        // …and back, so everything above this boundary — the
                        // approval row, the audit detail, the tool_result props,
                        // every client surface — reads momo's own name.
                        name: momo_agent::tools::momo_tool_name(name),
                        arguments: function.arguments.clone().unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(ChatCompletion {
        text,
        tool_calls,
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
    tool_calls: Option<Vec<RawToolCall>>,
}

#[derive(Deserialize)]
struct RawToolCall {
    id: Option<String>,
    function: Option<RawToolFunction>,
}

#[derive(Deserialize)]
struct RawToolFunction {
    name: Option<String>,
    arguments: Option<String>,
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
    /// What the mock puts on the sink before it answers, when a test wants a
    /// turn that actually streams (#1161). `None` — the default — keeps every
    /// existing test on the non-streaming path, which is still the honest shape
    /// for the wires that do not stream.
    stream_plan: Option<StreamPlan>,
    calls: Mutex<Vec<ObservedCall>>,
    /// One entry per turn: what tool calls that turn returns (goal SRV-T1).
    ///
    /// A queue rather than a fixed value because the shape a tool test needs is
    /// a *sequence* — turn 1 asks to run something, turn 2 (the resume, after a
    /// human approved) answers in text. A single value could not express the
    /// second turn, and that second turn is the half of the loop that proves
    /// `resume_approval` is no longer swallowed.
    tool_call_script: Mutex<std::collections::VecDeque<Vec<ProviderToolCall>>>,
}

/// How a streaming mock turn arrives (#1161).
///
/// The gap is real time rather than a virtual clock because what a conformance
/// test needs to exercise is the pump's **shipped** window — a test that moved
/// the window would prove the pump against a configuration production never
/// runs.
struct StreamPlan {
    /// Text to emit as deltas. `None` means "whatever this turn's answer is",
    /// which is what a success test wants; a failure test has to say it out
    /// loud, because a failing turn has no answer to borrow.
    text: Option<String>,
    slices: usize,
    gap: Duration,
}

enum MockOutcome {
    Echo,
    Fail(ProviderError),
    /// Ordered `(needle, answer)` rules matched against the **last `user` turn**
    /// of the assembled transcript; the first hit wins, and no hit falls back to
    /// [`MockOutcome::Echo`].
    ///
    /// Keyed on what the agent was *told* rather than on call order, because an
    /// A2A chain is several agents answering each other: a positional script
    /// would still pass if the wrong agent had been woken, or if two turns ran
    /// in the other order — which is exactly the bug a delegation test exists to
    /// catch.
    Scripted(Vec<(String, String)>),
}

/// What the mock was asked, recorded so a test can assert on it — including
/// which bearer the worker resolved for the turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedCall {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub bearer: String,
    pub base_url: String,
    pub account_id: Option<String>,
    /// Which wire the worker resolved for this turn — the fact a routing test
    /// asserts on without needing a socket.
    pub wire: ProviderWire,
    /// Names of the momo-implemented tools this turn offered (goal SRV-B3f).
    /// Names rather than rendered JSON: the *shape* is pinned by the two wires'
    /// own body tests, and what a wiring test needs to know is whether the
    /// profile's switch reached the request at all.
    pub momo_tools: Vec<String>,
}

impl MockChatProvider {
    /// Answers `"mock: <last user content>"` with fixed token counts.
    pub fn echo() -> MockChatProvider {
        MockChatProvider {
            outcome: MockOutcome::Echo,
            stream_plan: None,
            calls: Mutex::new(Vec::new()),
            tool_call_script: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// Answers by script: the first rule whose needle appears in the last `user`
    /// turn wins, otherwise [`MockChatProvider::echo`]'s answer.
    ///
    /// This is how a whole agent→agent conversation is staged without a network:
    /// one provider serves every agent in the chain, and each answer is a
    /// function of what that agent was actually shown.
    pub fn scripted<K, V>(rules: impl IntoIterator<Item = (K, V)>) -> MockChatProvider
    where
        K: Into<String>,
        V: Into<String>,
    {
        MockChatProvider {
            outcome: MockOutcome::Scripted(
                rules
                    .into_iter()
                    .map(|(needle, answer)| (needle.into(), answer.into()))
                    .collect(),
            ),
            stream_plan: None,
            calls: Mutex::new(Vec::new()),
            tool_call_script: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// Always fails with `error`.
    pub fn failing(error: ProviderError) -> MockChatProvider {
        MockChatProvider {
            outcome: MockOutcome::Fail(error),
            stream_plan: None,
            calls: Mutex::new(Vec::new()),
            tool_call_script: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    pub fn calls(&self) -> Vec<ObservedCall> {
        self.calls.lock().expect("mock provider lock").clone()
    }

    /// Stage what each successive turn returns in its tool channel (goal
    /// SRV-T1).
    ///
    /// `with_tool_calls([vec![call], vec![]])` is the shape a closed-loop test
    /// wants: the first turn asks to run something, the second — the resume
    /// after a human approved — answers in text. Turns past the end of the
    /// script return no tool calls.
    pub fn with_tool_calls(
        self,
        script: impl IntoIterator<Item = Vec<ProviderToolCall>>,
    ) -> MockChatProvider {
        MockChatProvider {
            tool_call_script: Mutex::new(script.into_iter().collect()),
            ..self
        }
    }

    /// Deliver this turn's answer as `slices` deltas, `gap` apart, before
    /// returning it whole (#1161).
    ///
    /// This is what makes a conformance test a *streaming* turn rather than a
    /// turn that merely could have been one: the deltas go through the same sink
    /// a real SSE loop writes to, so the pump's window, the growing message and
    /// the closing slice are all exercised by the shipped code path.
    ///
    /// `gap` should exceed [`crate::partial::PARTIAL_WINDOW`] when the test
    /// wants more than one window's worth of slices — the pump coalesces, so
    /// four fast deltas are one slice, not four.
    pub fn streaming(self, slices: usize, gap: Duration) -> MockChatProvider {
        MockChatProvider {
            stream_plan: Some(StreamPlan {
                text: None,
                slices,
                gap,
            }),
            ..self
        }
    }

    /// Stream `text` and *then* do whatever this mock does — which, on a
    /// [`MockChatProvider::failing`], is die.
    ///
    /// The half-written answer has to be named explicitly because a failing turn
    /// has no answer to borrow, and "what the reader had already read when the
    /// provider went away" is the exact thing ADR-0155 is about.
    pub fn streaming_text(
        self,
        text: impl Into<String>,
        slices: usize,
        gap: Duration,
    ) -> MockChatProvider {
        MockChatProvider {
            stream_plan: Some(StreamPlan {
                text: Some(text.into()),
                slices,
                gap,
            }),
            ..self
        }
    }

    /// The answer this mock would give for a request, without recording a call.
    fn answer_text(&self, request: &ChatRequest) -> String {
        match &self.outcome {
            MockOutcome::Echo | MockOutcome::Fail(_) => MockChatProvider::echo_text(request),
            MockOutcome::Scripted(rules) => {
                let prompt = MockChatProvider::last_user_content(request);
                rules
                    .iter()
                    .find(|(needle, _)| prompt.contains(needle.as_str()))
                    .map(|(_, answer)| answer.clone())
                    .unwrap_or_else(|| MockChatProvider::echo_text(request))
            }
        }
    }

    /// The deterministic answer for a given request — exposed so a test can
    /// assert on the exact body it expects to find in the channel.
    pub fn echo_text(request: &ChatRequest) -> String {
        format!("mock: {}", MockChatProvider::last_user_content(request))
    }

    /// The last thing the agent was told — the transcript turn every mock
    /// outcome keys on.
    fn last_user_content(request: &ChatRequest) -> &str {
        request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(|message| message.content.as_str())
            .unwrap_or("")
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
                account_id: endpoint.account_id.clone(),
                wire: endpoint.wire,
                momo_tools: request
                    .momo_tools
                    .iter()
                    .map(|definition| definition.name.to_string())
                    .collect(),
            });
        if let MockOutcome::Fail(error) = &self.outcome {
            return Err(error.clone());
        }
        let text = self.answer_text(request);
        // One turn, one entry. An exhausted script means "no tool calls", which
        // is what makes the resume turn answer in text.
        let tool_calls = self
            .tool_call_script
            .lock()
            .ok()
            .and_then(|mut script| script.pop_front())
            .unwrap_or_default();
        Ok(ChatCompletion {
            text,
            tool_calls,
            usage: Some(ChatUsage {
                prompt_tokens: 11,
                completion_tokens: 7,
                cached_tokens: 3,
                reasoning_tokens: 2,
            }),
        })
    }

    /// Put the planned slices on the sink, then answer (or fail) exactly as
    /// [`complete`](MockChatProvider::complete) would.
    ///
    /// The deltas go out **before** the outcome is decided, which is the shape a
    /// dying provider actually has: a reader who watched half an answer arrive
    /// and then saw it stop is not looking at a turn that failed before it
    /// spoke.
    async fn complete_streaming(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
        sink: &dyn DeltaSink,
    ) -> Result<ChatCompletion, ProviderError> {
        if let Some(plan) = &self.stream_plan {
            let text = plan
                .text
                .clone()
                .unwrap_or_else(|| self.answer_text(request));
            for slice in split_into_slices(&text, plan.slices) {
                sink.text_delta(slice);
                tokio::time::sleep(plan.gap).await;
            }
        }
        self.complete(endpoint, request).await
    }
}

/// Cut `text` into at most `slices` pieces on character boundaries.
///
/// Character boundaries rather than byte offsets because momo's channels are
/// mostly Korean: a naive byte split would hand the sink invalid UTF-8 roughly
/// two times in three, and the bug it produced would be in the test harness
/// rather than in the thing under test.
fn split_into_slices(text: &str, slices: usize) -> Vec<&str> {
    let chars: Vec<usize> = text.char_indices().map(|(at, _)| at).collect();
    if slices <= 1 || chars.len() <= 1 {
        return vec![text];
    }
    let per = chars.len().div_ceil(slices);
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + per).min(chars.len());
        let from = chars[start];
        let to = chars.get(end).copied().unwrap_or(text.len());
        out.push(&text[from..to]);
        start = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `/chat/completions` shape: a function's fields live **under** a
    /// `function` object. The Responses wire flattens the same fields, and
    /// `responses.rs` has the mirror of this test — together they are what stops
    /// one rendering from being used on both wires (goal SRV-B3f).
    #[test]
    fn momo_tools_render_nested_on_the_chat_wire() {
        let rendered = chat_tool_json(&momo_agent::tools::catalog_definitions());
        // The whole catalog, not the first entry: a tool added without this
        // rendering would reach the wire with momo's dots in its name and 400
        // the request for every OTHER tool too (goal SRV-HOT1).
        assert_eq!(rendered.len(), momo_agent::tools::CATALOG.len());
        for (tool, momo_name) in rendered.iter().zip(momo_agent::tools::CATALOG) {
            assert_eq!(tool["type"], serde_json::json!("function"));
            assert_eq!(
                tool["function"]["name"],
                serde_json::json!(momo_agent::tools::wire_tool_name(momo_name)),
                "nested under `function`, not flat — AND the WIRE name, not \
                 momo's. This assertion said `work.session.end` when #1018 \
                 shipped, which is precisely why the dot reached the backend and \
                 400'd every turn (goal SRV-HOT1): {tool}"
            );
            assert!(
                tool.get("name").is_none(),
                "a flat `name` here is the Responses shape on the wrong wire: {tool}"
            );
        }
        let tool = &rendered[0];
        assert_eq!(
            tool["function"]["parameters"]["type"],
            serde_json::json!("object")
        );
        assert!(
            tool["function"]["description"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()),
            "the model needs to know when to use it: {tool}"
        );
    }

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
                tool_calls: Vec::new(),
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
                tool_calls: Vec::new(),
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
        let status = |code| ProviderError::HttpStatus(code, String::new());
        assert!(ProviderError::Unreachable("connect refused".into()).is_retryable());
        assert!(status(429).is_retryable());
        assert!(status(500).is_retryable());
        assert!(status(503).is_retryable());
        assert!(!status(400).is_retryable());
        assert!(!status(401).is_retryable());
        assert!(!status(404).is_retryable());
        assert!(!ProviderError::InvalidResponse("x".into()).is_retryable());
        assert!(!ProviderError::ErrorEnvelope("x".into()).is_retryable());

        // The diagnostic snippet is evidence for an operator, never an input to
        // the decision: a 400 that *reads* like an outage is still a 400.
        assert!(
            !ProviderError::HttpStatus(400, "Stream must be set to true".to_string())
                .is_retryable(),
            "the measured ChatGPT refusal is a client bug to fix, not a retry to spend"
        );
    }

    /// The snippet is the whole point of carrying a body on the error: an
    /// operator reading a log must see the provider's own sentence.
    #[test]
    fn an_http_failure_carries_the_providers_own_sentence() {
        let error = ProviderError::HttpStatus(400, "Stream must be set to true".to_string());
        assert_eq!(
            error.to_string(),
            "provider answered with HTTP 400: Stream must be set to true"
        );
    }

    /// The bearer must not be reachable through the ordinary debug path, because
    /// that is the one a future `tracing::error!(?endpoint)` would take.
    #[test]
    fn debugging_an_endpoint_never_prints_its_bearer() {
        let endpoint = ProviderEndpoint {
            base_url: "https://gateway.example/v1".to_string(),
            bearer: "sk-live-supersecret".to_string(),
            source: "database",
            wire: ProviderWire::Responses,
            account_id: Some("acct-whose-subscription".to_string()),
        };
        let rendered = format!("{endpoint:?}");
        assert!(!rendered.contains("sk-live-supersecret"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(rendered.contains("gateway.example"), "{rendered}");
        assert!(
            !rendered.contains("acct-whose-subscription"),
            "the paying account must not be identifiable from a log line: {rendered}"
        );
    }

    #[tokio::test]
    async fn the_mock_echoes_the_last_user_turn_and_records_the_bearer() {
        let provider = MockChatProvider::echo();
        let endpoint = ProviderEndpoint {
            base_url: "http://mock/v1".to_string(),
            bearer: "sk-test".to_string(),
            source: "environment",
            wire: ProviderWire::ChatCompletions,
            account_id: None,
        };
        let request = ChatRequest {
            tools: Vec::new(),
            momo_tools: Vec::new(),
            model: "m".to_string(),
            messages: vec![ChatMessage::system("sys"), ChatMessage::user("질문")],
            max_tokens: Some(64),
        };
        let completion = provider.complete(&endpoint, &request).await.expect("mock");
        assert_eq!(completion.text, "mock: 질문");
        assert_eq!(provider.calls().len(), 1);
        assert_eq!(provider.calls()[0].bearer, "sk-test");
    }

    // -----------------------------------------------------------------------
    // B5.4b: the envelope kind → adapter mapping
    // -----------------------------------------------------------------------

    /// The mapping, stated once. Flipping either arm would send a subscription
    /// OAuth token to a wire it is not entitled to call (and answer every turn
    /// with a 404), or move every existing gateway link onto a wire its gateway
    /// has never been asked to speak.
    #[test]
    fn the_sealed_envelope_kind_is_what_picks_the_wire() {
        assert_eq!(
            ProviderWire::for_credential(&LinkCredential::Bearer("sk-live".into())),
            ProviderWire::ChatCompletions,
            "every provider_link row that exists today is a bearer; it must not move"
        );
        assert_eq!(
            ProviderWire::for_credential(&LinkCredential::OpenAiOAuth(Box::new(
                momo_settings::OpenAiOAuthCredential::from_refresh_token("rt")
            ))),
            ProviderWire::Responses
        );
        // The default is the legacy wire, so an endpoint built without thinking
        // about wires keeps pre-B5.4b behaviour.
        assert_eq!(ProviderWire::default(), ProviderWire::ChatCompletions);
    }

    /// One URL builder for both wires, so a trailing slash cannot mean two
    /// different things depending on which adapter runs.
    #[test]
    fn the_url_is_the_base_plus_the_wires_path_with_one_slash() {
        let endpoint = |base: &str, wire| ProviderEndpoint {
            base_url: base.to_string(),
            wire,
            ..ProviderEndpoint::default()
        };
        assert_eq!(
            endpoint("https://gw.example/v1", ProviderWire::ChatCompletions).url(),
            "https://gw.example/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://gw.example/v1/", ProviderWire::Responses).url(),
            "https://gw.example/v1/responses"
        );
        assert_eq!(
            endpoint(
                "https://chatgpt.com/backend-api/codex",
                ProviderWire::Responses
            )
            .url(),
            "https://chatgpt.com/backend-api/codex/responses",
            "the measured Codex CLI pair (base + /responses)"
        );
    }

    /// The router sends each turn to exactly one adapter and never to both.
    /// Without this, a "helpful" fallback that retried the other wire on a 404
    /// would present a subscription token to a second endpoint on every failure.
    #[tokio::test]
    async fn the_router_sends_each_wire_to_its_own_adapter_and_only_that_one() {
        let chat = Arc::new(MockChatProvider::echo());
        let responses = Arc::new(MockChatProvider::echo());
        let router = WireRoutedProvider::new(chat.clone(), responses.clone());
        let request = ChatRequest {
            tools: Vec::new(),
            momo_tools: Vec::new(),
            model: "m".to_string(),
            messages: vec![ChatMessage::user("질문")],
            max_tokens: Some(64),
        };

        let oauth = ProviderEndpoint {
            base_url: "http://mock".to_string(),
            wire: ProviderWire::Responses,
            ..ProviderEndpoint::default()
        };
        router.complete(&oauth, &request).await.expect("routed");
        assert_eq!(responses.calls().len(), 1);
        assert!(chat.calls().is_empty(), "the legacy adapter was not called");

        let legacy = ProviderEndpoint {
            base_url: "http://mock".to_string(),
            wire: ProviderWire::ChatCompletions,
            ..ProviderEndpoint::default()
        };
        router.complete(&legacy, &request).await.expect("routed");
        assert_eq!(chat.calls().len(), 1);
        assert_eq!(responses.calls().len(), 1, "still one; no double dispatch");
        assert_eq!(chat.calls()[0].wire, ProviderWire::ChatCompletions);
        assert_eq!(responses.calls()[0].wire, ProviderWire::Responses);
    }
}
