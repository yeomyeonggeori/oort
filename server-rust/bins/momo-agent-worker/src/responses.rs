//! The OpenAI **Responses** wire (B5.4b — ADR-0147 이행 완결), streamed (B5.4c).
//!
//! ## Why this wire exists at all
//!
//! B5.4 shipped the credential machinery for a ChatGPT subscription OAuth grant
//! and measured, in the same batch, the fact that made it unusable on its own:
//! a subscription token is not entitled to `/chat/completions`. ADR-0147's 이행
//! note records the resolution — the Responses adapter is "결정 2의 필수 수단,
//! 별도 방향 변경 아님" — which is the decision [`crate::provider`]'s module docs
//! require before a second contract may exist.
//!
//! ## The wire, measured
//!
//! Two independent sources, because either alone would be a guess:
//!
//! **(1) The shipped Codex CLI** (`@openai/codex` 0.144.1, platform binary
//! `codex-darwin-arm64`), read as strings — never as credentials:
//!
//! ```text
//! endpoints  https://chatgpt.com/backend-api/codex  (+ "/responses")
//!            https://api.openai.com/v1/responses      ← the API-key path
//! request    response.create{model, instructions, previous_response_id,
//!                            tool_choice, parallel_tool_calls, store, stream,
//!                            stream_options, include, service_tier, …}
//! items      internally tagged enum ResponseItem{message{role, content}, reasoning,
//!                            function_call, function_call_output, …}
//! content    internally tagged enum ContentItem{input_text, input_image, output_text}
//! usage      struct ResponseCompletedUsage with 5 elements
//!              {input_tokens, input_tokens_details, output_tokens,
//!               output_tokens_details, total_tokens}
//!            struct ResponseCompletedInputTokensDetails  {cached_tokens}
//!            struct ResponseCompletedOutputTokensDetails {reasoning_tokens}
//! ```
//!
//! **(2) The public SDK types** (`openai-python`, `src/openai/types/responses/`),
//! which pin the same names for the half Codex only ever sees streamed:
//! `Response{id, status, error, incomplete_details, output, usage, …}`,
//! `status ∈ {completed, failed, in_progress, cancelled, queued, incomplete}`,
//! `IncompleteDetails{reason}`, `ResponseOutputMessage{type:"message", role:
//! "assistant", content}`, `ResponseOutputText{type:"output_text", text}`,
//! `ResponseUsage{input_tokens, input_tokens_details{cached_tokens},
//! output_tokens, output_tokens_details{reasoning_tokens}, total_tokens}`,
//! `EasyInputMessageParam{role ∈ {user, assistant, system, developer},
//! type:"message", content}`.
//!
//! Nothing outside those two lists is sent. In particular this adapter does
//! **not** forge Codex's own client-identity headers (`originator: codex_cli_rs`,
//! `x-codex-installation-id`, its `OpenAI-Beta` value): they identify the Codex
//! CLI to OpenAI, and momo is not the Codex CLI. See the PR body — the honest
//! consequence is that `chatgpt.com/backend-api/codex` may still gate this
//! adapter, while `api.openai.com/v1/responses` and any Responses-compatible
//! gateway answer it.
//!
//! ## Three shape decisions a reviewer should check
//!
//! * **`system` → `instructions`, not an input item.** Codex sends its system
//!   text as top-level `instructions`, and [`crate::context::assemble`] only ever
//!   emits a single leading `system` message, so the two are equivalent here —
//!   with the measured form preferred. Should assembly ever emit several, they
//!   are joined in order rather than silently dropped.
//! * **`assistant` history uses `output_text` content items, `user` uses
//!   `input_text`.** That is Codex's `ContentItem` split, and it is what lets a
//!   model tell its own past turns from the user's inside one `input` array.
//! * **`store: false`.** The default is server-side retention. momo is a
//!   self-hosted messenger whose history already lives in Postgres (invariant #1),
//!   never uses `previous_response_id`, and has no consent story for leaving
//!   member conversations on a provider. Sending `false` is the choice that
//!   matches what momo actually promises.
//!
//! ## B5.4c: `stream: true` is not a preference, it is the only wire
//!
//! B5.4b shipped `stream: false` as a scope call. NCP's live smoke then measured
//! what the ChatGPT backend does with it: the model name is accepted, the
//! subscription credential is accepted, and the request is refused with exactly
//! one sentence — **`"Stream must be set to true"`**. So the non-streamed
//! Responses request is not a smaller version of this adapter; it is a request
//! that cannot be answered at all. B5.4c sends `stream: true` on the first
//! attempt and consumes the SSE, with **no non-stream attempt to fall back
//! from** — a fallback would spend a round trip to arrive at the same refusal.
//!
//! ### The event names, measured
//!
//! Same two-source rule as the request shape above, because a guessed event name
//! is a stream that silently accumulates nothing:
//!
//! **(1) `openai-python`** `src/openai/types/responses/`, on two installed
//! versions (2.16.0 and 2.31.0), which pin the `type` tag of each event:
//!
//! ```text
//! response_text_delta_event.py   type: Literal["response.output_text.delta"]  + delta: str
//! response_completed_event.py    type: Literal["response.completed"]          + response: Response
//! response_incomplete_event.py   type: Literal["response.incomplete"]         + response: Response
//! response_failed_event.py       type: Literal["response.failed"]             + response: Response
//! response_error_event.py        type: Literal["error"]                       + message: str, code, param
//! ```
//!
//! The terminal events carry a whole `Response` — the same object the
//! non-streamed body is — so `usage` is read from `response.completed` by the
//! same code that read it from a body, not by a second parser.
//!
//! **(2) The shipped Codex CLI** (`@openai/codex` 0.144.1, `codex-darwin-arm64`),
//! read as strings, which carries `response.completed`, `response.failed`,
//! `response.error`, `response.create`, `ResponseCompletedUsage{input_tokens,
//! input_tokens_details, output_tokens, output_tokens_details, total_tokens}` —
//! and, decisively for the rule below, the literal message
//! **`"stream closed before response.completed"`** in its own SSE module
//! (`codex-api/src/sse/responses.rs`). This build does not carry the delta tag as
//! a greppable literal, which is why source (1) is the one that pins it.
//!
//! ### Three rules a reviewer should check
//!
//! * **A stream that ends without a terminal event is an availability failure,
//!   not a short answer.** Codex names the same condition. Committing the
//!   accumulated half-sentence would publish a truncated answer as the agent's
//!   final word, with nothing in the channel or the log saying it was cut; the
//!   retry re-asks and costs one turn.
//! * **The deltas are the answer; `response.completed` is the auditor.** The
//!   terminal payload's `output[]` is used only when no delta arrived, which is
//!   what a provider that batches its stream produces. `usage` always comes from
//!   the terminal payload, because deltas do not carry it.
//! * **Nothing is relayed to clients mid-stream.** The downstream contract is
//!   unchanged: one final message on the ordinary write path → outbox → relay.
//!   `agent.partial` is a later batch, and this batch deliberately does not open
//!   that door — streaming here is an implementation detail of one HTTP round
//!   trip, invisible to Postgres, the outbox and every client.

use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::provider::{
    post_event_stream, ChatCompletion, ChatProvider, ChatRequest, ChatUsage, DeltaSink,
    DiscardDeltas, ProviderEndpoint, ProviderError, ProviderToolCall,
};

/// `POST {base_url}/responses`, `stream=true`, `store=false`.
pub struct OpenAiResponsesProvider {
    client: reqwest::Client,
}

impl OpenAiResponsesProvider {
    pub fn new(request_timeout: Duration) -> Result<OpenAiResponsesProvider, reqwest::Error> {
        Ok(OpenAiResponsesProvider::from_client(
            reqwest::Client::builder()
                .timeout(request_timeout)
                .build()?,
        ))
    }

    /// Build on an existing client, so both wires share one connection pool.
    pub fn from_client(client: reqwest::Client) -> OpenAiResponsesProvider {
        OpenAiResponsesProvider { client }
    }
}

#[async_trait]
impl ChatProvider for OpenAiResponsesProvider {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        self.complete_streaming(endpoint, request, &DiscardDeltas)
            .await
    }

    async fn complete_streaming(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
        sink: &dyn DeltaSink,
    ) -> Result<ChatCompletion, ProviderError> {
        let body = build_request_body(request);
        let mut response = post_event_stream(&self.client, endpoint, &body).await?;
        let mut stream = ResponseStream::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    stream.push_to(&chunk, sink);
                    // Stop at the terminal event rather than reading to EOF: the
                    // answer is already complete, and a gateway that holds the
                    // socket open after it would otherwise cost this turn the
                    // whole request timeout.
                    if stream.is_terminal() {
                        break;
                    }
                }
                Ok(None) => break,
                // The socket broke mid-stream. Whether that leaves a usable turn
                // is exactly the question `finish` answers, so it answers it once.
                Err(error) => return stream.interrupted(&error.to_string()),
            }
        }
        stream.finish()
    }
}

/// Turn one [`ChatRequest`] into a Responses create body.
///
/// Split out from the HTTP call so the wire assertion in the conformance suite —
/// and the unit tests below — can read the exact object that goes on the socket
/// without standing up a server.
pub fn build_request_body(request: &ChatRequest) -> Value {
    let mut instructions: Vec<&str> = Vec::new();
    let mut input: Vec<Value> = Vec::new();

    for message in &request.messages {
        // `developer` is the Responses vocabulary's own name for the same slot;
        // accepting both means a future assembler can emit either without this
        // adapter turning it into an ordinary user turn.
        if message.role == "system" || message.role == "developer" {
            instructions.push(message.content.as_str());
            continue;
        }
        let content_type = if message.role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        input.push(json!({
            "type": "message",
            "role": message.role,
            "content": [{"type": content_type, "text": message.content}],
        }));
    }

    let mut body = json!({
        "model": request.model,
        "input": input,
        // B5.4c: measured, not chosen — the ChatGPT backend answers a `false`
        // here with "Stream must be set to true" and nothing else.
        "stream": true,
        "store": false,
    });
    let object = body.as_object_mut().expect("json object");
    if !instructions.is_empty() {
        object.insert("instructions".into(), json!(instructions.join("\n\n")));
    }
    // goal SRV-T1. Passed through in the agent's own `tool_schema` shape, and
    // omitted when empty for the same reason the chat wire omits it.
    // goal SRV-B3f: the agent's own passthrough JSON, then momo's own tools
    // rendered **flat** — the Responses wire puts a function's fields on the
    // tool itself rather than under a `function` object, the same asymmetry this
    // adapter already documents on the parse side for `function_call` items.
    let mut tools = request.tools.clone();
    tools.extend(request.momo_tools.iter().map(|definition| {
        json!({
            "type": "function",
            // goal SRV-HOT1 — see `wire_tool_name`. Same translation as the chat
            // wire; only the surrounding shape differs.
            "name": momo_agent::tools::wire_tool_name(definition.name),
            "description": definition.description,
            "parameters": definition.parameters,
        })
    }));
    if !tools.is_empty() {
        object.insert("tools".into(), Value::Array(tools));
    }
    // `max_output_tokens`는 보내지 않는다 — ChatGPT 백엔드(이 와이어의 실소비자)가
    // "Unsupported parameter"로 400을 답한다(2026-08-02 실 smoke 실측). 출력 예산은
    // usage ledger 계상으로 사후 관측한다. api.openai.com 표준 Responses에 이 필드를
    // 조건부로 되살리는 것은 후속(와이어별 capability 분기).
    let _ = request.max_tokens;
    body
}

/// Decode one whole (non-streamed) Responses body.
///
/// After B5.4c this is not what an ordinary turn takes: it is the decoder for a
/// terminal event's `response` payload (the same object), and the fallback for a
/// gateway that answered a `stream: true` request with the whole body anyway.
pub fn parse_response(body: &str) -> Result<ChatCompletion, ProviderError> {
    let payload: Value = serde_json::from_str(body)
        .map_err(|error| ProviderError::InvalidResponse(error.to_string()))?;
    decode_response(&payload, "")
}

/// One Responses payload → one turn's answer.
///
/// `streamed` is the text already accumulated from `response.output_text.delta`
/// events (empty for a whole body). It wins when it is non-empty: it is what the
/// provider actually emitted token by token, and the terminal payload is read for
/// `usage` and for the reason a turn carried no answer.
///
/// Order matters and mirrors [`crate::provider::parse_completion`]: the error
/// object is read **first**, because a payload carrying one is a refusal, and
/// decoding it as a response would report an empty successful turn — the failure
/// mode where a user's question disappears without a trace.
fn decode_response(payload: &Value, streamed: &str) -> Result<ChatCompletion, ProviderError> {
    if let Some(message) = error_message(payload) {
        return Err(ProviderError::ErrorEnvelope(message));
    }

    let response: RawResponse = serde_json::from_value(payload.clone())
        .map_err(|error| ProviderError::InvalidResponse(error.to_string()))?;
    let usage = response.usage.as_ref().map(|usage| ChatUsage {
        // `input_tokens`/`output_tokens` are the Responses names for the same two
        // counts `prompt_tokens`/`completion_tokens` carry on the chat wire, and
        // the details are subsets of them on both — so the ledger's four columns
        // keep meaning exactly what they meant before B5.4b.
        prompt_tokens: usage.input_tokens.unwrap_or(0),
        completion_tokens: usage.output_tokens.unwrap_or(0),
        cached_tokens: usage
            .input_tokens_details
            .and_then(|details| details.cached_tokens)
            .unwrap_or(0),
        reasoning_tokens: usage
            .output_tokens_details
            .and_then(|details| details.reasoning_tokens)
            .unwrap_or(0),
    });

    let text = if streamed.trim().is_empty() {
        collect_output_text(response.output.as_deref())
    } else {
        streamed.to_string()
    };
    let tool_calls = collect_tool_calls(response.output.as_deref());
    // goal SRV-T1 relaxes this in exactly one direction: a response carrying
    // tool calls IS an answer, even with no assistant text. Before the tool
    // channel existed, "no text" and "nothing usable" were the same thing;
    // now a turn that only asks to run something is the normal shape of a tool
    // call, and reporting it as a provider fault would make every tool use look
    // like an outage.
    if text.trim().is_empty() && tool_calls.is_empty() {
        // A response with no assistant text is not an answer, and saying *why*
        // is the difference between an operator raising the token budget and an
        // operator restarting a provider that is working fine.
        return Err(ProviderError::InvalidResponse(unusable_reason(&response)));
    }

    Ok(ChatCompletion {
        text,
        usage,
        tool_calls,
    })
}

/// `output[]` items of `type == "function_call"` (goal SRV-T1).
///
/// Same drop rule as the chat wire: an item without both a `call_id` and a
/// `name` cannot be answered or dispatched, so it is skipped rather than
/// completed with a guess.
fn collect_tool_calls(output: Option<&[RawOutputItem]>) -> Vec<ProviderToolCall> {
    output
        .unwrap_or(&[])
        .iter()
        .filter(|item| item.item_type.as_deref() == Some("function_call"))
        .filter_map(|item| {
            let id = item.call_id.as_deref().unwrap_or_default().trim();
            let name = item.name.as_deref().unwrap_or_default().trim();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            Some(ProviderToolCall {
                id: id.to_string(),
                // Mapped back at the boundary, so a `work_session_end` call
                // becomes the `work.session.end` the executor and the approval
                // ledger know.
                name: momo_agent::tools::momo_tool_name(name),
                arguments: item.arguments.clone().unwrap_or_default(),
            })
        })
        .collect()
}

/// `payload.error.message`, if it is a message rather than a `null` or a blank.
///
/// `"error": null` is what every SUCCESSFUL response carries, so a check that
/// only asked whether the key exists would fail every good turn.
fn error_message(payload: &Value) -> Option<String> {
    payload
        .get("error")?
        .get("message")?
        .as_str()
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
}

/// Every `output_text` part of every assistant message, concatenated.
///
/// Concatenation with no separator is the SDKs' own `output_text` helper rule:
/// the parts of one message are contiguous pieces of one string, and inserting a
/// separator would put characters in a user's channel that the model never
/// produced. Non-message items (`reasoning`, tool calls) are skipped — reasoning
/// is not an answer, and tool calls are out of scope for this batch.
fn collect_output_text(output: Option<&[RawOutputItem]>) -> String {
    let mut text = String::new();
    for item in output.unwrap_or(&[]) {
        if item.item_type.as_deref() != Some("message") {
            continue;
        }
        for part in item.content.as_deref().unwrap_or(&[]) {
            if part.part_type.as_deref() == Some("output_text") {
                if let Some(part_text) = part.text.as_deref() {
                    text.push_str(part_text);
                }
            }
        }
    }
    text
}

/// Name the reason a body carried no answer, using the provider's own words.
fn unusable_reason(response: &RawResponse) -> String {
    let status = response.status.as_deref().unwrap_or("unknown");
    match response
        .incomplete_details
        .as_ref()
        .and_then(|details| details.reason.as_deref())
    {
        // `max_output_tokens` here means the budget was spent before any text
        // was emitted (reasoning models can do this); the operator's repair is
        // the budget, not the provider.
        Some(reason) => format!("response status `{status}` carried no output text ({reason})"),
        None if response.output.is_none() => "response carries no output".to_string(),
        None => format!("response status `{status}` carried no output text"),
    }
}

// ---------------------------------------------------------------------------
// the SSE stream (B5.4c)
// ---------------------------------------------------------------------------

/// How much of a non-SSE answer is kept in case the provider ignored `stream`.
///
/// The buffer exists only until the first SSE event arrives, so on the wire this
/// adapter actually speaks it holds one chunk and is then dropped. The cap is
/// what keeps a 200 that streams megabytes of something-that-is-not-SSE from
/// being accumulated in memory instead of being reported.
const NON_SSE_FALLBACK_LIMIT: usize = 1 << 20;

/// The `text/event-stream` body of one Responses turn, consumed incrementally.
///
/// It is a byte-fed state machine rather than a function over the whole body for
/// two reasons a reviewer should check:
///
/// * **UTF-8 boundaries.** A chunk can split a multi-byte character, and momo's
///   channels are mostly Korean — decoding each chunk on arrival would replace
///   the split character with `U+FFFD`. Lines are cut on the `\n` byte (which
///   cannot appear inside a multi-byte sequence) and only then decoded.
/// * **Testability.** Nothing here touches a socket, so every rule below —
///   accumulation, the terminal events, the interrupted stream — is a unit test
///   with no server and no network.
#[derive(Default)]
pub struct ResponseStream {
    /// Bytes not yet forming a complete line.
    buffer: Vec<u8>,
    /// The current event's `data:` field(s), joined with `\n` as SSE requires.
    data: String,
    /// The current event's `event:` field, used only when the payload has no
    /// `type` of its own.
    event_name: Option<String>,
    /// Text accumulated from `response.output_text.delta`.
    text: String,
    /// Set by the first terminal event; later events are ignored.
    outcome: Option<Result<ChatCompletion, ProviderError>>,
    events: usize,
    deltas: usize,
    /// The raw body, kept only while no SSE event has been seen.
    non_sse: Option<Vec<u8>>,
}

impl ResponseStream {
    pub fn new() -> ResponseStream {
        ResponseStream {
            non_sse: Some(Vec::new()),
            ..ResponseStream::default()
        }
    }

    /// Feed one chunk off the socket, reporting each text delta as it is
    /// decoded (goal SRV-B3e).
    ///
    /// The sink is called from **inside** the byte loop rather than from a pass
    /// over the accumulated text afterwards, because the whole value of a
    /// partial is that it is early: a slice reported after `finish()` would
    /// arrive with the final message and prove nothing a reader could not
    /// already see.
    pub fn push_to(&mut self, chunk: &[u8], sink: &dyn DeltaSink) {
        if let Some(raw) = self.non_sse.as_mut() {
            if raw.len() + chunk.len() > NON_SSE_FALLBACK_LIMIT {
                self.non_sse = None;
            } else {
                raw.extend_from_slice(chunk);
            }
        }

        self.buffer.extend_from_slice(chunk);
        while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=index).collect();
            let line = line.strip_suffix(b"\n").unwrap_or(&line);
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            self.line(&String::from_utf8_lossy(line), sink);
        }
    }

    /// Feed one chunk with nowhere to report slices — the shape every unit test
    /// and every non-progress caller wants.
    pub fn push(&mut self, chunk: &[u8]) {
        self.push_to(chunk, &DiscardDeltas);
    }

    /// Has a terminal event already settled this turn?
    pub fn is_terminal(&self) -> bool {
        self.outcome.is_some()
    }

    /// The stream reached EOF.
    pub fn finish(mut self) -> Result<ChatCompletion, ProviderError> {
        // EOF is an event boundary. The SSE spec discards an event that was not
        // closed by a blank line, but a server that writes the terminal event and
        // closes immediately is common enough that discarding it would throw away
        // a complete answer over a missing newline.
        self.flush(&DiscardDeltas);
        if let Some(outcome) = self.outcome {
            return outcome;
        }
        match self.non_sse {
            // Not one SSE event arrived, so this was never a stream: an
            // OpenAI-compatible gateway that ignores `stream: true` and answers
            // the whole object at once is still answering.
            Some(raw) if self.events == 0 && !raw.is_empty() => {
                parse_response(&String::from_utf8_lossy(&raw))
            }
            _ => Err(ProviderError::Unreachable(format!(
                "stream closed before response.completed ({} text deltas received)",
                self.deltas
            ))),
        }
    }

    /// The socket broke before EOF.
    pub fn interrupted(self, reason: &str) -> Result<ChatCompletion, ProviderError> {
        if let Some(outcome) = self.outcome {
            return outcome;
        }
        // Retryable on purpose. The alternative — publishing the deltas received
        // so far — would commit a sentence that stops mid-word as the agent's
        // final answer, with nothing anywhere saying it was cut off.
        Err(ProviderError::Unreachable(format!(
            "response stream broke after {} text deltas: {reason}",
            self.deltas
        )))
    }

    fn line(&mut self, line: &str, sink: &dyn DeltaSink) {
        if line.is_empty() {
            self.flush(sink);
        } else if line.starts_with(':') {
            // A comment — the keep-alive an idle stream sends.
        } else if let Some(value) = field(line, "data") {
            if !self.data.is_empty() {
                self.data.push('\n');
            }
            self.data.push_str(value);
        } else if let Some(value) = field(line, "event") {
            self.event_name = Some(value.to_string());
        }
        // `id:`, `retry:` and anything else are not part of this contract.
    }

    /// Dispatch the event the blank line (or EOF) just closed.
    fn flush(&mut self, sink: &dyn DeltaSink) {
        let data = std::mem::take(&mut self.data);
        let event_name = self.event_name.take();
        if data.is_empty() {
            return;
        }
        // The chat wire's terminator. The Responses stream does not send it, but
        // a compatible gateway that reuses one SSE writer might.
        if data.trim() == "[DONE]" {
            return;
        }
        self.events += 1;
        // The body was a stream after all; the whole-body fallback is dead.
        self.non_sse = None;
        if self.outcome.is_some() {
            return;
        }

        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            // An unparseable payload is either a truncated tail or a dialect this
            // adapter does not speak. Either way it is not an answer, and the
            // stream still has to end with a terminal event to become one.
            return;
        };
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .or(event_name.as_deref())
            .unwrap_or_default();

        match kind {
            // openai-python `ResponseTextDeltaEvent`.
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.text.push_str(delta);
                    self.deltas += 1;
                    // Reported even though it is also accumulated: the
                    // accumulation is what the final message is built from, the
                    // report is what the rail shows while it is still arriving.
                    // Neither can be derived from the other after the fact.
                    sink.text_delta(delta);
                }
            }
            // Both carry a whole `Response`. `incomplete` is a truncated turn,
            // and B5.4b's rule holds: a partial answer IS an answer, so it is
            // decoded exactly like a completed one and only fails when it
            // carried no text at all.
            "response.completed" | "response.incomplete" => {
                // An absent `response` is an empty one, not a decode failure: the
                // deltas already spell the answer, and losing it over a missing
                // audit object would be the wrong half to keep.
                let payload = event.get("response").cloned().unwrap_or_else(|| json!({}));
                self.outcome = Some(decode_response(&payload, &self.text));
            }
            "response.failed" => {
                let payload = event.get("response").unwrap_or(&Value::Null).clone();
                self.outcome = Some(Err(ProviderError::ErrorEnvelope(
                    error_message(&payload).unwrap_or_else(|| {
                        format!(
                            "response status `{}` failed without an error message",
                            payload
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("failed")
                        )
                    }),
                )));
            }
            // openai-python `ResponseErrorEvent` — the error is top level here,
            // not inside a `response`.
            "error" | "response.error" => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
                    .unwrap_or("the provider reported an error with no message");
                self.outcome = Some(Err(ProviderError::ErrorEnvelope(message.to_string())));
            }
            // Every other event is progress, reasoning or bookkeeping:
            // `response.created`, `response.in_progress`, `response.output_item.*`,
            // `response.content_part.*`, `response.output_text.done`,
            // `response.reasoning_summary_text.delta`, … Ignoring them by default
            // is what keeps a new event name from turning a good turn into a
            // failure.
            _ => {}
        }
    }
}

/// `name: value` with the single optional leading space SSE strips.
fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(name)?.strip_prefix(':')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

#[derive(Deserialize)]
struct RawResponse {
    status: Option<String>,
    output: Option<Vec<RawOutputItem>>,
    usage: Option<RawUsage>,
    incomplete_details: Option<RawIncompleteDetails>,
}

#[derive(Deserialize)]
struct RawOutputItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    content: Option<Vec<RawContentPart>>,
    /// `function_call` items (goal SRV-T1). The Responses wire flattens the
    /// call onto the output item itself rather than nesting it under a
    /// `function` object the way chat/completions does, so these three are read
    /// here and not from [`RawContentPart`].
    call_id: Option<String>,
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct RawContentPart {
    #[serde(rename = "type")]
    part_type: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct RawIncompleteDetails {
    reason: Option<String>,
}

#[derive(Deserialize)]
struct RawUsage {
    input_tokens: Option<i32>,
    output_tokens: Option<i32>,
    input_tokens_details: Option<RawInputTokensDetails>,
    output_tokens_details: Option<RawOutputTokensDetails>,
}

#[derive(Deserialize, Clone, Copy)]
struct RawInputTokensDetails {
    cached_tokens: Option<i32>,
}

#[derive(Deserialize, Clone, Copy)]
struct RawOutputTokensDetails {
    reasoning_tokens: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The live 400, locked as a fixture** (goal SRV-HOT1).
    ///
    /// This is the failure #1018 shipped, reproduced from the backend's own
    /// refusal: a dotted tool name makes the provider reject the **entire**
    /// request, so every turn of every agent with a tool enabled dies — the
    /// answer too, not just the tool.
    ///
    /// The test pins two things at once: that momo now sends a name the pattern
    /// accepts, and that if it ever stops doing so, the shape of what comes back
    /// is this — a terminal `ErrorEnvelope`, not an outage, not a retry loop.
    const TOOL_NAME_REFUSAL: &str = concat!(
        "{\"error\":{\"message\":\"Invalid 'tools[0].name': string does not match ",
        "pattern '^[a-zA-Z0-9_-]+$'.\",\"type\":\"invalid_request_error\",",
        "\"param\":\"tools[0].name\",\"code\":\"invalid_value\"}}",
    );

    #[test]
    fn the_measured_tool_name_refusal_is_terminal_and_names_the_field() {
        let error = parse_response(TOOL_NAME_REFUSAL).expect_err("a refusal is not an answer");
        let sentence = error.to_string();
        assert!(sentence.contains("tools[0].name"), "{sentence}");
        assert!(
            !error.is_retryable(),
            "a name the pattern refuses is refused every time; retrying burns the \
             subscription to arrive at the same 400: {sentence}"
        );

        // …and the name momo actually sends satisfies the pattern the refusal
        // quotes, so this body is a museum piece rather than today's behaviour.
        let sent = build_request_body(&ChatRequest {
            model: "gpt-5.6-sol".to_string(),
            messages: vec![ChatMessage::user("q")],
            max_tokens: None,
            tools: Vec::new(),
            momo_tools: momo_agent::tools::catalog_definitions(),
        });
        let name = sent["tools"][0]["name"].as_str().expect("named");
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "{name:?} would reproduce {TOOL_NAME_REFUSAL}"
        );
    }

    /// The other half of the boundary: a call that comes back under the wire
    /// name is handed up under momo's name, or nothing downstream can dispatch
    /// or authorise it.
    #[test]
    fn a_tool_call_returns_under_momos_own_name() {
        let body = json!({
            "status": "completed",
            "output": [{
                "type": "function_call",
                "call_id": "call_abc",
                "name": "work_session_end",
                "arguments": "{\"session_id\":\"019f-…\"}"
            }]
        })
        .to_string();
        let completion = parse_response(&body).expect("a tool call is an answer");
        assert_eq!(completion.tool_calls.len(), 1);
        assert_eq!(
            completion.tool_calls[0].name, "work.session.end",
            "the approval row, the audit detail and every client surface read \
             momo's name — the wire's spelling stops here"
        );
        assert!(momo_agent::tools::is_executable(
            &completion.tool_calls[0].name
        ));
    }

    /// The Responses shape: a function's fields sit **on** the tool. The chat
    /// wire nests the same fields under `function`, and `provider.rs` has the
    /// mirror of this test (goal SRV-B3f).
    #[test]
    fn momo_tools_render_flat_on_the_responses_wire() {
        let body = build_request_body(&ChatRequest {
            model: "gpt-5.6-sol".to_string(),
            messages: vec![ChatMessage::user("세션 정리해줘")],
            max_tokens: None,
            tools: Vec::new(),
            momo_tools: momo_agent::tools::catalog_definitions(),
        });
        let tools = body["tools"].as_array().expect("tools");
        // Every catalog entry, for the reason `provider.rs`'s mirror gives: one
        // badly-rendered tool kills the whole request, not just its own turn.
        assert_eq!(tools.len(), momo_agent::tools::CATALOG.len());
        for (tool, momo_name) in tools.iter().zip(momo_agent::tools::CATALOG) {
            assert_eq!(tool["type"], json!("function"));
            assert_eq!(
                tool["name"],
                json!(momo_agent::tools::wire_tool_name(momo_name)),
                "flat, not nested — AND the WIRE name. The backend refuses \
                 anything outside `^[a-zA-Z0-9_-]+$` with a 400 that fails the \
                 WHOLE request, so momo's dots stop at this boundary (goal \
                 SRV-HOT1): {tool}"
            );
            assert!(
                tool.get("function").is_none(),
                "a nested `function` here is the chat shape on the wrong wire: {tool}"
            );
        }
        assert_eq!(tools[0]["parameters"]["required"], json!(["session_id"]));
        assert_eq!(tools[1]["parameters"]["required"], json!(["tool", "label"]));
    }

    /// The agent's own JSON keeps its place, and momo's is appended — an
    /// operator who declared a function by hand does not have it reordered.
    #[test]
    fn the_agents_own_tool_json_is_still_passed_through_verbatim() {
        // A wire-legal operator name. momo does NOT rewrite these — see the
        // assertion at the end of this test for why, and what it costs.
        let declared = json!({"type": "function", "name": "operator_thing"});
        let body = build_request_body(&ChatRequest {
            model: "m".to_string(),
            messages: vec![ChatMessage::user("q")],
            max_tokens: None,
            tools: vec![declared.clone()],
            momo_tools: momo_agent::tools::catalog_definitions(),
        });
        let tools = body["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 1 + momo_agent::tools::CATALOG.len());
        assert_eq!(tools[0], declared, "passthrough, untouched and first");
        assert_eq!(tools[1]["name"], json!("work_session_end"));

        // Every name momo *renders* satisfies the pattern. The operator's own
        // entry is deliberately NOT checked here, and that boundary is the
        // point: `tool_schema` is passed through verbatim because the column
        // "already holds the provider's own format", and rewriting a name momo
        // does not own would (a) break that contract and (b) make the reverse
        // map ambiguous — `momo_tool_name` is a catalog lookup precisely so an
        // operator's `search_issues` is never renamed to `search.issues`.
        //
        // The honest consequence, worth stating rather than hiding: an operator
        // who writes a dotted name into `tool_schema` gets the same 400 this
        // goal fixed for momo's own tools. That is theirs to fix, and there is
        // no surface to write `tool_schema` on this server yet anyway (#1001).
        let momo_rendered = tools.last().expect("momo's tool is appended last");
        let name = momo_rendered["name"].as_str().expect("named");
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "{name:?} violates {}",
            momo_agent::tools::WIRE_TOOL_NAME_PATTERN
        );
    }

    /// Neither source present ⇒ the key is omitted entirely. Sending
    /// `"tools": []` makes some gateways refuse the request outright.
    #[test]
    fn no_tools_at_all_omits_the_key() {
        let body = build_request_body(&ChatRequest {
            model: "m".to_string(),
            messages: vec![ChatMessage::user("q")],
            max_tokens: None,
            tools: Vec::new(),
            momo_tools: Vec::new(),
        });
        assert!(body.get("tools").is_none(), "{body}");
    }
    use crate::provider::ChatMessage;

    fn request() -> ChatRequest {
        ChatRequest {
            tools: Vec::new(),
            momo_tools: Vec::new(),
            model: "gpt-5.4-codex".to_string(),
            messages: vec![
                ChatMessage::system("you are hermes"),
                ChatMessage::user("[성재] 안녕"),
                ChatMessage {
                    role: "assistant".to_string(),
                    content: "반가워요".to_string(),
                },
                ChatMessage::user("[성재] @hermes 오늘 뭐해?"),
            ],
            max_tokens: Some(512),
        }
    }

    /// The request shape, field by field. Every assertion here is a measured
    /// name from the module docs; dropping any one of them is a request the
    /// Responses endpoint answers with a 400 that reads like a model problem.
    #[test]
    fn the_request_carries_the_fields_the_responses_wire_requires() {
        let body = build_request_body(&request());
        assert_eq!(body["model"], json!("gpt-5.4-codex"));
        assert_eq!(
            body["stream"],
            json!(true),
            "measured: the ChatGPT backend refuses anything else with \
             \"Stream must be set to true\""
        );
        assert_eq!(body["store"], json!(false));
        assert!(
            body.get("max_output_tokens").is_none(),
            "ChatGPT 백엔드 미지원 — 보내지 않는다"
        );
        assert_eq!(body["instructions"], json!("you are hermes"));

        // The chat wire's field names must NOT appear: a body carrying both is a
        // body that was assembled by guessing rather than by the mapping.
        assert!(body.get("messages").is_none());
        assert!(body.get("max_tokens").is_none());

        let input = body["input"].as_array().expect("input array");
        assert_eq!(input.len(), 3, "the system turn moved to `instructions`");
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[0]["role"], json!("user"));
        assert_eq!(input[0]["content"][0]["type"], json!("input_text"));
        assert_eq!(input[0]["content"][0]["text"], json!("[성재] 안녕"));
        assert_eq!(
            input[1]["content"][0]["type"],
            json!("output_text"),
            "the agent's own past turn is model output, not user input"
        );
        assert_eq!(input[1]["role"], json!("assistant"));
        assert_eq!(
            input[2]["content"][0]["text"],
            json!("[성재] @hermes 오늘 뭐해?")
        );
    }

    /// No system prompt and no budget: both keys are absent rather than null.
    #[test]
    fn an_absent_system_prompt_and_budget_are_absent_keys_not_nulls() {
        let bare = ChatRequest {
            tools: Vec::new(),
            momo_tools: Vec::new(),
            model: "m".to_string(),
            messages: vec![ChatMessage::user("직접 물어봄")],
            max_tokens: None,
        };
        let body = build_request_body(&bare);
        assert!(body.get("instructions").is_none());
        assert!(body.get("max_output_tokens").is_none());
        assert_eq!(body["input"].as_array().expect("input").len(), 1);
    }

    /// Several system turns are joined in order. Keeping only the first would
    /// silently drop instructions a future assembler meant to add.
    #[test]
    fn multiple_system_turns_are_joined_rather_than_dropped() {
        let request = ChatRequest {
            tools: Vec::new(),
            momo_tools: Vec::new(),
            model: "m".to_string(),
            messages: vec![
                ChatMessage::system("첫째"),
                ChatMessage {
                    role: "developer".to_string(),
                    content: "둘째".to_string(),
                },
                ChatMessage::user("질문"),
            ],
            max_tokens: None,
        };
        let body = build_request_body(&request);
        assert_eq!(body["instructions"], json!("첫째\n\n둘째"));
        assert_eq!(body["input"].as_array().expect("input").len(), 1);
    }

    /// The happy path, including every usage axis the ledger records.
    #[test]
    fn a_response_decodes_its_text_and_every_usage_axis() {
        let body = r#"{
            "id": "resp_1",
            "object": "response",
            "status": "completed",
            "output": [
                {"type": "reasoning", "summary": []},
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "안녕하세요"}
                ]}
            ],
            "usage": {
                "input_tokens": 100, "output_tokens": 20,
                "input_tokens_details": {"cached_tokens": 60},
                "output_tokens_details": {"reasoning_tokens": 5},
                "total_tokens": 120
            }
        }"#;
        assert_eq!(
            parse_response(body),
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

    /// Multiple `output_text` parts are one string. A separator here would put
    /// characters in a channel the model never produced.
    #[test]
    fn output_text_parts_concatenate_and_non_message_items_are_skipped() {
        let body = r#"{
            "status": "completed",
            "output": [
                {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "숨은 생각"}]},
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "가"},
                    {"type": "refusal", "refusal": "무시"},
                    {"type": "output_text", "text": "나"}
                ]}
            ]
        }"#;
        let completion = parse_response(body).expect("decode");
        assert_eq!(completion.text, "가나");
        assert!(
            !completion.text.contains("숨은 생각"),
            "reasoning is not the answer"
        );
        assert_eq!(completion.usage, None, "no usage object ⇒ was_estimated");
    }

    /// A 200 with an error object is a refusal, not an empty answer — same rule
    /// and same order as the chat wire.
    #[test]
    fn a_200_error_object_is_a_failure_not_an_empty_answer() {
        let body = r#"{"error": {"code": "model_not_found", "message": "model not found"}}"#;
        assert_eq!(
            parse_response(body),
            Err(ProviderError::ErrorEnvelope("model not found".to_string()))
        );
        // `"error": null` is what every SUCCESSFUL response carries; reading it
        // as an envelope would fail every good turn.
        let ok = r#"{"error": null, "status": "completed",
                     "output": [{"type":"message","content":[{"type":"output_text","text":"hi"}]}]}"#;
        assert_eq!(parse_response(ok).expect("decode").text, "hi");
    }

    /// A body with no assistant text is terminal, and it says which of the three
    /// reasons it was.
    #[test]
    fn a_response_without_output_text_names_why_it_is_unusable() {
        let truncated = r#"{"status": "incomplete",
                            "incomplete_details": {"reason": "max_output_tokens"},
                            "output": [{"type": "reasoning", "summary": []}]}"#;
        let error = parse_response(truncated).expect_err("terminal");
        assert!(matches!(error, ProviderError::InvalidResponse(_)));
        assert!(error.to_string().contains("max_output_tokens"), "{error}");
        assert!(error.to_string().contains("incomplete"), "{error}");
        assert!(
            !error.is_retryable(),
            "a truncated turn repeats identically"
        );

        let empty = parse_response(r#"{"status": "completed"}"#).expect_err("terminal");
        assert!(empty.to_string().contains("carries no output"), "{empty}");

        // Not a Responses body at all (an HTML gateway page) stays terminal too.
        assert!(matches!(
            parse_response("<html>gateway</html>"),
            Err(ProviderError::InvalidResponse(_))
        ));
    }

    /// A partial answer IS an answer: truncation must not throw away text the
    /// user is entitled to see.
    #[test]
    fn a_truncated_response_that_still_carries_text_is_delivered() {
        let body = r#"{"status": "incomplete",
                       "incomplete_details": {"reason": "max_output_tokens"},
                       "output": [{"type":"message","role":"assistant",
                                   "content":[{"type":"output_text","text":"답이 중간에"}]}],
                       "usage": {"input_tokens": 5, "output_tokens": 512}}"#;
        let completion = parse_response(body).expect("a partial answer is still an answer");
        assert_eq!(completion.text, "답이 중간에");
        assert_eq!(
            completion.usage.expect("usage").completion_tokens,
            512,
            "the user is billed for what the provider actually spent"
        );
    }

    // -----------------------------------------------------------------------
    // B5.4c — the SSE stream
    // -----------------------------------------------------------------------

    /// One `event:`/`data:` pair, as the Responses API frames it.
    fn sse(event: &str, data: Value) -> String {
        format!("event: {event}\ndata: {data}\n\n")
    }

    fn delta(text: &str) -> String {
        sse(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "sequence_number": 1,
                "item_id": "msg_1",
                "output_index": 0,
                "content_index": 0,
                "delta": text,
                "logprobs": [],
            }),
        )
    }

    fn completed(text: &str, usage: Value) -> String {
        let mut response = json!({
            "id": "resp_1",
            "object": "response",
            "status": "completed",
            "error": null,
            "incomplete_details": null,
            "output": [
                {"type": "reasoning", "id": "rs_1", "summary": []},
                {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                 "content": [{"type": "output_text", "text": text, "annotations": []}]}
            ],
        });
        if !usage.is_null() {
            response["usage"] = usage;
        }
        sse(
            "response.completed",
            json!({"type": "response.completed", "sequence_number": 9, "response": response}),
        )
    }

    /// Feed a whole body one chunk at a time.
    fn drive(chunks: &[&[u8]]) -> Result<ChatCompletion, ProviderError> {
        let mut stream = ResponseStream::new();
        for chunk in chunks {
            stream.push(chunk);
            if stream.is_terminal() {
                break;
            }
        }
        stream.finish()
    }

    /// The headline property: what the deltas spelled is byte-for-byte what the
    /// turn commits — including when a chunk boundary lands in the middle of a
    /// Korean character, which is the failure a per-chunk `from_utf8_lossy`
    /// would turn into `U+FFFD` in a user's channel.
    #[test]
    fn the_accumulated_deltas_are_exactly_the_final_body() {
        let body = format!(
            "{}{}{}{}",
            sse("response.created", json!({"type": "response.created"})),
            delta("안녕하세"),
            delta("요, 성재님"),
            completed("안녕하세요, 성재님", Value::Null)
        );
        let bytes = body.as_bytes();

        let whole = drive(&[bytes]).expect("one chunk");
        assert_eq!(whole.text, "안녕하세요, 성재님");

        // Byte at a time: every possible split, including mid-character ones.
        let per_byte: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(
            drive(&per_byte).expect("byte at a time").text,
            "안녕하세요, 성재님",
            "a chunk boundary inside a multi-byte character must not corrupt the answer"
        );
    }

    /// `usage` is only ever on the terminal event, and every axis the ledger
    /// records has to survive the trip.
    #[test]
    fn the_completed_event_carries_the_usage_the_ledger_bills() {
        let body = format!(
            "{}{}",
            delta("답"),
            completed(
                "답",
                json!({
                    "input_tokens": 100, "output_tokens": 20,
                    "input_tokens_details": {"cached_tokens": 60},
                    "output_tokens_details": {"reasoning_tokens": 5},
                    "total_tokens": 120,
                })
            )
        );
        assert_eq!(
            drive(&[body.as_bytes()]),
            Ok(ChatCompletion {
                tool_calls: Vec::new(),
                text: "답".to_string(),
                usage: Some(ChatUsage {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    cached_tokens: 60,
                    reasoning_tokens: 5,
                })
            })
        );

        // No usage object ⇒ `was_estimated`, exactly as on a whole body.
        let unmeasured = format!("{}{}", delta("답"), completed("답", Value::Null));
        assert_eq!(drive(&[unmeasured.as_bytes()]).expect("decode").usage, None);
    }

    /// A stream that stops before `response.completed` is an availability
    /// failure — the same call the shipped Codex CLI makes, whose own SSE module
    /// carries the string "stream closed before response.completed".
    ///
    /// Delivering the half-sentence instead would publish a truncated answer as
    /// the agent's final word with nothing saying it was cut.
    #[test]
    fn a_stream_that_ends_before_completed_is_retried_not_delivered_half() {
        let body = format!("{}{}", delta("답이 중간에"), delta(" 끊겼"));
        let error = drive(&[body.as_bytes()]).expect_err("no terminal event");
        assert!(
            error.is_retryable(),
            "a cut stream is an availability failure: {error}"
        );
        assert!(error.to_string().contains("response.completed"), "{error}");
        assert!(
            !error.to_string().contains("답이 중간에"),
            "the partial text must not be smuggled into the failure reason: {error}"
        );

        // The same rule when the socket itself errors rather than reaching EOF.
        let mut stream = ResponseStream::new();
        stream.push(delta("절반").as_bytes());
        let broken = stream
            .interrupted("connection reset by peer")
            .expect_err("the socket broke");
        assert!(broken.is_retryable(), "{broken}");
        assert!(broken.to_string().contains("connection reset"), "{broken}");
    }

    /// An answer that completed before the socket did is still an answer: a
    /// terminal event already settled the turn, so a broken connection after it
    /// must not throw the answer away and bill a second turn for it.
    #[test]
    fn a_socket_that_breaks_after_the_terminal_event_still_answers() {
        let mut stream = ResponseStream::new();
        stream.push(delta("다 왔다").as_bytes());
        stream.push(completed("다 왔다", Value::Null).as_bytes());
        assert!(stream.is_terminal());
        assert_eq!(
            stream
                .interrupted("connection reset")
                .expect("answered")
                .text,
            "다 왔다"
        );
    }

    /// The two refusal shapes, both terminal and neither retryable: retrying a
    /// refusal spends the subscription to be told the same thing.
    #[test]
    fn a_failed_response_and_an_error_event_are_refusals_not_outages() {
        let failed = format!(
            "{}{}",
            delta("시작은 했"),
            sse(
                "response.failed",
                json!({"type": "response.failed", "response": {
                    "id": "resp_1", "status": "failed",
                    "error": {"code": "server_error", "message": "the model failed mid-turn"}
                }})
            )
        );
        let error = drive(&[failed.as_bytes()]).expect_err("failed is terminal");
        assert_eq!(
            error,
            ProviderError::ErrorEnvelope("the model failed mid-turn".to_string())
        );
        assert!(!error.is_retryable());

        // openai-python's `ResponseErrorEvent`: `type: "error"`, message at the
        // top level rather than inside a `response`.
        let bare = sse(
            "error",
            json!({"type": "error", "code": "rate_limit", "message": "slow down", "sequence_number": 2}),
        );
        assert_eq!(
            drive(&[bare.as_bytes()]),
            Err(ProviderError::ErrorEnvelope("slow down".to_string()))
        );
    }

    /// `response.incomplete` is B5.4b's truncated turn, streamed: the text it
    /// did produce is delivered, and a truncation that produced none names why.
    #[test]
    fn an_incomplete_terminal_event_delivers_the_text_it_managed() {
        let incomplete = |text: &str, streamed: &str| {
            let event = sse(
                "response.incomplete",
                json!({"type": "response.incomplete", "response": {
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"},
                    "output": if text.is_empty() { json!([]) } else {
                        json!([{"type": "message", "role": "assistant",
                                "content": [{"type": "output_text", "text": text}]}])
                    },
                    "usage": {"input_tokens": 5, "output_tokens": 512}
                }}),
            );
            if streamed.is_empty() {
                event
            } else {
                format!("{}{event}", delta(streamed))
            }
        };

        let answered = drive(&[incomplete("답이 중간에", "답이 중간에").as_bytes()])
            .expect("a partial answer is still an answer");
        assert_eq!(answered.text, "답이 중간에");
        assert_eq!(answered.usage.expect("usage").completion_tokens, 512);

        let empty = drive(&[incomplete("", "").as_bytes()]).expect_err("no text at all");
        assert!(empty.to_string().contains("max_output_tokens"), "{empty}");
        assert!(
            !empty.is_retryable(),
            "a truncated turn repeats identically"
        );
    }

    /// Everything that is not one of the five events above is ignored, because a
    /// new event name in a future API version must not turn a good turn into a
    /// failure. Comments (`: keep-alive`) and `[DONE]` are ignored for the same
    /// reason.
    #[test]
    fn progress_events_comments_and_done_are_ignored() {
        let body = format!(
            ": keep-alive\n\n{}{}{}{}{}{}data: [DONE]\n\n",
            sse("response.created", json!({"type": "response.created"})),
            sse(
                "response.output_item.added",
                json!({"type": "response.output_item.added", "output_index": 0})
            ),
            sse(
                "response.reasoning_summary_text.delta",
                json!({"type": "response.reasoning_summary_text.delta", "delta": "숨은 생각"})
            ),
            delta("보이는 답"),
            sse(
                "response.output_text.done",
                json!({"type": "response.output_text.done", "text": "보이는 답"})
            ),
            completed("보이는 답", Value::Null),
        );
        let completion = drive(&[body.as_bytes()]).expect("decode");
        assert_eq!(completion.text, "보이는 답");
        assert!(
            !completion.text.contains("숨은 생각"),
            "reasoning is not the answer"
        );
    }

    /// A terminal event with no deltas before it: the payload's own `output[]`
    /// is the answer. A gateway that batches its stream produces exactly this.
    #[test]
    fn a_terminal_event_without_deltas_falls_back_to_its_own_output() {
        let body = completed("한 번에 다 보냄", Value::Null);
        assert_eq!(
            drive(&[body.as_bytes()]).expect("decode").text,
            "한 번에 다 보냄"
        );

        // And the other direction: a terminal event that carries no `response`
        // object at all still delivers what the deltas spelled. Failing here
        // would throw away a complete answer over a missing audit payload.
        let no_payload = format!(
            "{}{}",
            delta("델타는 다 왔다"),
            sse(
                "response.completed",
                json!({"type": "response.completed", "sequence_number": 2})
            )
        );
        assert_eq!(
            drive(&[no_payload.as_bytes()]).expect("decode").text,
            "델타는 다 왔다"
        );
    }

    /// An OpenAI-compatible gateway that ignored `stream: true` and answered the
    /// whole object at once is still answering. Without this the operator would
    /// see "stream closed before response.completed" — a message that describes
    /// our parser rather than their server — and the turn would retry forever.
    #[test]
    fn a_gateway_that_ignored_stream_true_is_still_read() {
        let whole = r#"{"status": "completed",
                        "output": [{"type": "message", "role": "assistant",
                                    "content": [{"type": "output_text", "text": "통째로"}]}],
                        "usage": {"input_tokens": 3, "output_tokens": 4}}"#;
        let completion = drive(&[whole.as_bytes()]).expect("a whole body is an answer");
        assert_eq!(completion.text, "통째로");
        assert_eq!(completion.usage.expect("usage").prompt_tokens, 3);

        // And a 200 that is not a Responses body at all stays terminal rather
        // than looking like a dropped connection.
        let error = drive(&[b"<html>gateway</html>"]).expect_err("not an answer");
        assert!(
            matches!(error, ProviderError::InvalidResponse(_)),
            "{error}"
        );
        assert!(!error.is_retryable());
    }

    /// SSE framing details that a hand-written parser gets wrong: `\r\n` line
    /// ends, multi-line `data:`, a missing space after the colon, and a terminal
    /// event the server closed without the trailing blank line.
    #[test]
    fn the_sse_framing_rules_hold() {
        let event = json!({"type": "response.completed", "response": {
            "status": "completed",
            "output": [{"type": "message", "role": "assistant",
                        "content": [{"type": "output_text", "text": "프레이밍"}]}]
        }});
        let crlf = format!(
            "event: response.output_text.delta\r\ndata:{}\r\n\r\nevent: response.completed\r\ndata: {event}\r\n\r\n",
            json!({"type": "response.output_text.delta", "delta": "프레이밍"})
        );
        assert_eq!(drive(&[crlf.as_bytes()]).expect("crlf").text, "프레이밍");

        // Two `data:` lines are one payload joined with `\n` — the SSE rule that
        // makes a pretty-printed JSON event decodable.
        let split = "event: response.completed\ndata: {\"type\": \"response.completed\",\ndata: \"response\": {\"status\": \"completed\", \"output\": [{\"type\": \"message\", \"content\": [{\"type\": \"output_text\", \"text\": \"여러 줄\"}]}]}}\n\n";
        assert_eq!(
            drive(&[split.as_bytes()]).expect("multi-line").text,
            "여러 줄"
        );

        // Closed right after the terminal event, with no blank line to end it.
        let unterminated = format!("event: response.completed\ndata: {event}\n");
        assert_eq!(
            drive(&[unterminated.as_bytes()])
                .expect("EOF ends the event")
                .text,
            "프레이밍"
        );
    }

    // -----------------------------------------------------------------------
    // B5.4c — the same rules, over a real socket
    // -----------------------------------------------------------------------

    /// Serve one HTTP request from a loopback listener and answer it verbatim.
    ///
    /// This exists because the tests above stop at the parser: they say nothing
    /// about whether `reqwest` hands this adapter the stream at all, whether the
    /// `Accept` header goes out, or whether a body with no `Content-Length` ends
    /// on EOF. Those are the parts of B5.4c that only a socket can answer, and it
    /// needs no database, no docker and no provider — so unlike the conformance
    /// suite it runs on every `cargo test`.
    ///
    /// The captured request comes back as a receiver, not a `String`: awaiting it
    /// here would wait for a request the caller has not made yet.
    async fn serve_once(
        response: &'static str,
        chunk_size: usize,
    ) -> (String, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut seen = Vec::new();
            let mut buffer = [0u8; 4096];
            // Read the head, then exactly `Content-Length` more bytes. Reading
            // "once more for the body" instead would block forever: the client
            // has said everything it is going to say and is waiting for us.
            loop {
                let head_end = seen
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|offset| offset + 4);
                if let Some(head_end) = head_end {
                    let head = String::from_utf8_lossy(&seen[..head_end]).to_lowercase();
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if seen.len() >= head_end + length {
                        break;
                    }
                }
                match socket.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => seen.extend_from_slice(&buffer[..read]),
                }
            }
            let _ = request_tx.send(String::from_utf8_lossy(&seen).to_string());

            let _ = socket.set_nodelay(true);
            for slice in response.as_bytes().chunks(chunk_size) {
                if socket.write_all(slice).await.is_err() {
                    return;
                }
                let _ = socket.flush().await;
                tokio::task::yield_now().await;
            }
            let _ = socket.shutdown().await;
        });
        (format!("http://{addr}"), request_rx)
    }

    fn endpoint(base_url: &str) -> ProviderEndpoint {
        ProviderEndpoint {
            base_url: base_url.to_string(),
            bearer: "at-live".to_string(),
            source: "database",
            wire: crate::provider::ProviderWire::Responses,
            account_id: Some("acct-1".to_string()),
        }
    }

    /// A whole streamed turn over TCP: the request asks for a stream, and the
    /// answer arrives 7 bytes at a time — a chunk size that cuts every 3-byte
    /// Korean character in the reply in half.
    const STREAMED_ANSWER: &str = concat!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"성재님, \"}\n\n",
        ": keep-alive\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"스트리밍 답입니다\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",",
        "\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":",
        "[{\"type\":\"output_text\",\"text\":\"성재님, 스트리밍 답입니다\"}]}],",
        "\"usage\":{\"input_tokens\":41,\"output_tokens\":17,",
        "\"input_tokens_details\":{\"cached_tokens\":29},",
        "\"output_tokens_details\":{\"reasoning_tokens\":11}}}}\n\n",
    );

    #[tokio::test]
    async fn a_streamed_turn_over_a_socket_asks_for_sse_and_reassembles_it() {
        let (base_url, request) = serve_once(STREAMED_ANSWER, 7).await;
        let provider = OpenAiResponsesProvider::from_client(reqwest::Client::new());
        let completion: ChatCompletion = provider
            .complete(
                &endpoint(&base_url),
                &ChatRequest {
                    tools: Vec::new(),
                    momo_tools: Vec::new(),
                    model: "gpt-5.6-sol".to_string(),
                    messages: vec![ChatMessage::user("[성재] @hermes 안녕")],
                    max_tokens: Some(512),
                },
            )
            .await
            .expect("the stream answered");

        assert_eq!(completion.text, "성재님, 스트리밍 답입니다");
        assert_eq!(
            completion.usage,
            Some(ChatUsage {
                prompt_tokens: 41,
                completion_tokens: 17,
                cached_tokens: 29,
                reasoning_tokens: 11,
            })
        );

        // What went out, read off the socket rather than off the builder.
        let request = request.await.expect("the server captured the request");
        assert!(request.starts_with("POST /responses "), "{request}");
        assert!(
            request.to_lowercase().contains("accept: text/event-stream"),
            "a proxy that buffers the whole answer would make the stream pointless: {request}"
        );
        assert!(request.contains("chatgpt-account-id: acct-1"), "{request}");
        assert!(request.contains("\"stream\":true"), "{request}");
        assert!(!request.contains("sk-"), "no bearer shape in the head dump");
    }

    /// The provider hung up after one delta: no `Content-Length`, no terminal
    /// event, just EOF. The turn must be retryable rather than a half answer.
    #[tokio::test]
    async fn a_socket_that_closes_mid_stream_is_a_retryable_failure() {
        const CUT: &str = concat!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"답이 중간에\"}\n\n",
        );
        let (base_url, _) = serve_once(CUT, 7).await;
        let provider = OpenAiResponsesProvider::from_client(reqwest::Client::new());
        let error = provider
            .complete(
                &endpoint(&base_url),
                &ChatRequest {
                    tools: Vec::new(),
                    momo_tools: Vec::new(),
                    model: "m".to_string(),
                    messages: vec![ChatMessage::user("질문")],
                    max_tokens: None,
                },
            )
            .await
            .expect_err("a cut stream is not an answer");
        assert!(error.is_retryable(), "{error}");
        assert!(error.to_string().contains("response.completed"), "{error}");
    }

    /// The refusal this batch exists to remove, kept as a live wire test: if a
    /// regression ever sends `stream: false` again, this is the shape of what
    /// comes back — a 400 carrying the provider's sentence, not an outage.
    #[tokio::test]
    async fn the_measured_non_stream_refusal_surfaces_as_a_terminal_400() {
        const REFUSAL: &str = concat!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n",
            "Content-Length: 47\r\nConnection: close\r\n\r\n",
            "{\"error\":{\"message\":\"Stream must be set to true\"}}",
        );
        let (base_url, _) = serve_once(REFUSAL, 4096).await;
        let provider = OpenAiResponsesProvider::from_client(reqwest::Client::new());
        let error = provider
            .complete(
                &endpoint(&base_url),
                &ChatRequest {
                    tools: Vec::new(),
                    momo_tools: Vec::new(),
                    model: "m".to_string(),
                    messages: vec![ChatMessage::user("질문")],
                    max_tokens: None,
                },
            )
            .await
            .expect_err("400 is not an answer");
        assert!(
            error.to_string().contains("Stream must be set to true"),
            "the operator sees the provider's own sentence: {error}"
        );
        assert!(
            !error.is_retryable(),
            "retrying a request the provider will always refuse only spends budget"
        );
    }
}
