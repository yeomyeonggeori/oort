//! The Anthropic **Messages** wire (#2872): `POST {base_url}/messages`,
//! streamed.
//!
//! ## Why a third wire
//!
//! `provider.rs` records the rule that momo speaks exactly the wires a decision
//! names. ADR-0147 증보 (2026-09-26) and ADR-0193 (c) made **BYOK API keys** the
//! team default, and a Claude console key does not speak `/chat/completions`
//! natively. So the sealed credential kind `anthropic-key` selects this adapter,
//! the same way `oauth-openai` selects the Responses one — the key never rides as
//! a `Bearer` to a URL typed as free text.
//!
//! ## The measured contract
//!
//! From Anthropic's public API reference (runtime-unverified against the live
//! API — the suites here run against a mock that speaks the documented shape):
//!
//! * Headers `x-api-key: <key>` and `anthropic-version: 2023-06-01`. No
//!   `Authorization` header is sent.
//! * Body `{model, max_tokens, system?, messages:[{role, content}], stream,
//!   tools?:[{name, description, input_schema}]}`. `max_tokens` is required;
//!   `system` is a top-level string, never a message role.
//! * SSE events: `message_start` (input usage), `content_block_start`
//!   (`text` | `tool_use{id,name}`), `content_block_delta` (`text_delta` |
//!   `input_json_delta`), `content_block_stop`, `message_delta` (output usage,
//!   `stop_reason`), `message_stop` (terminal), `ping`, `error`.
//!
//! The streaming rules are [`crate::responses::ResponseStream`]'s, for the same
//! reasons: split lines on the `\n` byte before decoding (Korean is 3 bytes a
//! character), report each text slice to the sink as it arrives, and treat a
//! stream that ends without its terminal event as **retryable** rather than
//! committing half a sentence.

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::provider::{
    post_event_stream, ChatCompletion, ChatProvider, ChatRequest, ChatUsage, DeltaSink,
    DiscardDeltas, ProviderEndpoint, ProviderError, ProviderToolCall,
};

/// `anthropic-version` — the stable Messages API version header.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Anthropic requires `max_tokens`; a request with no budget gets this one.
const DEFAULT_MAX_TOKENS: i32 = 1024;

/// The same bound the Responses adapter keeps on a non-SSE body.
const NON_SSE_FALLBACK_LIMIT: usize = 4 * 1024 * 1024;

pub struct AnthropicMessagesProvider {
    client: reqwest::Client,
}

impl AnthropicMessagesProvider {
    pub fn new(request_timeout: Duration) -> Result<AnthropicMessagesProvider, reqwest::Error> {
        Ok(AnthropicMessagesProvider::from_client(
            reqwest::Client::builder()
                .timeout(request_timeout)
                .build()?,
        ))
    }

    pub fn from_client(client: reqwest::Client) -> AnthropicMessagesProvider {
        AnthropicMessagesProvider { client }
    }
}

#[async_trait]
impl ChatProvider for AnthropicMessagesProvider {
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
        let mut stream = MessageStream::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    stream.push_to(&chunk, sink);
                    if stream.is_terminal() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => return stream.interrupted(&error.to_string()),
            }
        }
        stream.finish()
    }
}

/// Render one [`ChatRequest`] as a Messages body.
pub fn build_request_body(request: &ChatRequest) -> Value {
    let mut system: Vec<&str> = Vec::new();
    let mut messages: Vec<(String, String)> = Vec::new();
    for message in &request.messages {
        if message.role == "system" || message.role == "developer" {
            system.push(message.content.as_str());
            continue;
        }
        // The Messages API has two conversational roles. Anything else momo
        // might emit (a future `tool` text turn) is context the user side
        // supplied.
        let role = if message.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        // Consecutive same-role turns are merged: the API expects the two
        // roles to alternate, and momo's context window routinely carries
        // several human lines in a row.
        match messages.last_mut() {
            Some((last_role, content)) if last_role == role => {
                content.push_str("\n\n");
                content.push_str(&message.content);
            }
            _ => messages.push((role.to_string(), message.content.clone())),
        }
    }
    // The first turn must be the user's. A context window that happens to
    // open on the agent's own earlier reply gets a neutral opener rather than
    // a 400 that would read as "the model is down".
    if messages.first().is_none_or(|(role, _)| role != "user") {
        messages.insert(0, ("user".to_string(), "(이전 대화)".to_string()));
    }

    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS).max(1),
        "messages": messages
            .into_iter()
            .map(|(role, content)| json!({"role": role, "content": content}))
            .collect::<Vec<_>>(),
        "stream": true,
    });
    let object = body.as_object_mut().expect("json object");
    if !system.is_empty() {
        object.insert("system".into(), json!(system.join("\n\n")));
    }

    let mut tools: Vec<Value> = request.tools.iter().map(anthropic_tool).collect();
    tools.extend(request.momo_tools.iter().map(|definition| {
        json!({
            "name": momo_agent::tools::wire_tool_name(definition.name),
            "description": definition.description,
            "input_schema": definition.parameters,
        })
    }));
    if !tools.is_empty() {
        object.insert("tools".into(), Value::Array(tools));
    }
    body
}

/// `agent.tool_schema` holds OpenAI function definitions. Re-shape the two
/// OpenAI spellings (nested `function`, or flat Responses-style) into
/// `{name, description, input_schema}`; anything already carrying
/// `input_schema` is passed through untouched.
fn anthropic_tool(tool: &Value) -> Value {
    if tool.get("input_schema").is_some() {
        return tool.clone();
    }
    // The provider's own web search — `{"type":"web_search_…","name":…}` — is
    // already in Anthropic's shape and has no schema to re-home (ADR-0201 증보 v2
    // H5). Only that server tool rides through: `web_fetch_…`, `code_execution_…`
    // or `computer_…` in an operator's `tool_schema` are re-shaped into inert
    // custom tools like before, so no profile can switch on a fetch/exec path
    // (H9-I6) through this door.
    if tool
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("web_search_"))
    {
        return tool.clone();
    }
    let function = tool.get("function").unwrap_or(tool);
    let Some(name) = function.get("name").and_then(Value::as_str) else {
        return tool.clone();
    };
    let mut rendered = json!({
        "name": name,
        "input_schema": function
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object"})),
    });
    if let Some(description) = function.get("description") {
        rendered["description"] = description.clone();
    }
    rendered
}

/// One content block as it is being assembled.
#[derive(Debug, Default)]
struct Block {
    tool_id: Option<String>,
    tool_name: Option<String>,
    /// `input_json_delta.partial_json` fragments, or the start block's
    /// complete `input` when no delta ever arrives.
    tool_input: String,
    tool_input_start: Option<Value>,
}

/// The streamed-answer state machine (see the module docs).
#[derive(Default)]
pub struct MessageStream {
    buffer: Vec<u8>,
    data: String,
    event_name: Option<String>,
    text: String,
    blocks: BTreeMap<u64, Block>,
    input_tokens: Option<i64>,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    output_tokens: Option<i64>,
    web_search_requests: i64,
    /// Content blocks that show a provider-side tool ran (`server_tool_use`) and the results a
    /// web search returned (`web_search_tool_result`) — counted from the stream itself, because
    /// `usage` is a billing figure and can be missing while the content is what the model read.
    server_tool_blocks: i64,
    search_result_blocks: i64,
    stop_reason: Option<String>,
    outcome: Option<Result<ChatCompletion, ProviderError>>,
    events: usize,
    deltas: usize,
    non_sse: Option<Vec<u8>>,
}

impl MessageStream {
    pub fn new() -> MessageStream {
        MessageStream {
            non_sse: Some(Vec::new()),
            ..MessageStream::default()
        }
    }

    pub fn push_to(&mut self, chunk: &[u8], sink: &dyn DeltaSink) {
        if self.outcome.is_some() {
            return;
        }
        if let Some(raw) = self.non_sse.as_mut() {
            if raw.len() + chunk.len() > NON_SSE_FALLBACK_LIMIT {
                self.non_sse = None;
            } else {
                raw.extend_from_slice(chunk);
            }
        }
        // Review M-2: scan only the new bytes, and bound the pending line.
        let lines = match crate::sse::take_lines(&mut self.buffer, chunk) {
            Ok(lines) => lines,
            Err(error) => {
                self.outcome = Some(Err(error));
                return;
            }
        };
        for line in lines {
            self.line(&String::from_utf8_lossy(&line), sink);
            if self.outcome.is_some() {
                return;
            }
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.push_to(chunk, &DiscardDeltas);
    }

    pub fn is_terminal(&self) -> bool {
        self.outcome.is_some()
    }

    pub fn finish(mut self) -> Result<ChatCompletion, ProviderError> {
        self.flush(&DiscardDeltas);
        if let Some(outcome) = self.outcome {
            return outcome;
        }
        match self.non_sse {
            // A gateway that ignored `stream: true` and answered one object.
            Some(raw) if self.events == 0 && !raw.is_empty() => {
                parse_message(&String::from_utf8_lossy(&raw))
            }
            _ => Err(ProviderError::Unreachable(format!(
                "stream closed before message_stop ({} text deltas received)",
                self.deltas
            ))),
        }
    }

    pub fn interrupted(self, reason: &str) -> Result<ChatCompletion, ProviderError> {
        if let Some(outcome) = self.outcome {
            return outcome;
        }
        Err(ProviderError::Unreachable(format!(
            "message stream broke after {} text deltas: {reason}",
            self.deltas
        )))
    }

    fn line(&mut self, line: &str, sink: &dyn DeltaSink) {
        if line.is_empty() {
            self.flush(sink);
        } else if line.starts_with(':') {
        } else if let Some(value) = field(line, "data") {
            if self.data.len() + value.len() + 1 > crate::sse::MAX_EVENT_BYTES {
                self.outcome = Some(Err(crate::sse::over_limit(
                    "SSE event",
                    crate::sse::MAX_EVENT_BYTES,
                )));
                return;
            }
            if !self.data.is_empty() {
                self.data.push('\n');
            }
            self.data.push_str(value);
        } else if let Some(value) = field(line, "event") {
            self.event_name = Some(value.to_string());
        }
    }

    fn flush(&mut self, sink: &dyn DeltaSink) {
        let data = std::mem::take(&mut self.data);
        let event_name = self.event_name.take();
        if data.is_empty() {
            return;
        }
        self.events += 1;
        self.non_sse = None;
        if self.outcome.is_some() {
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            return;
        };
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .or(event_name.as_deref())
            .unwrap_or_default()
            .to_string();
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        if index > crate::sse::MAX_BLOCK_INDEX {
            // Review M-2: an attacker-chosen index must not grow the map.
            self.outcome = Some(Err(ProviderError::InvalidResponse(format!(
                "content block index {index} exceeds {}",
                crate::sse::MAX_BLOCK_INDEX
            ))));
            return;
        }

        match kind.as_str() {
            "message_start" => {
                if let Some(usage) = event.pointer("/message/usage") {
                    self.read_usage(usage);
                }
            }
            "content_block_start" => {
                let block = self.blocks.entry(index).or_default();
                let start = event.get("content_block").unwrap_or(&Value::Null);
                match start.get("type").and_then(Value::as_str) {
                    Some("server_tool_use") => self.server_tool_blocks += 1,
                    Some("web_search_tool_result") => self.search_result_blocks += 1,
                    _ => {}
                }
                if start.get("type").and_then(Value::as_str) == Some("tool_use") {
                    block.tool_id = start.get("id").and_then(Value::as_str).map(str::to_string);
                    block.tool_name = start
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    block.tool_input_start = start.get("input").cloned();
                } else if let Some(text) = start.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        if self.text.len() + text.len() > crate::sse::MAX_TEXT_BYTES {
                            self.outcome = Some(Err(crate::sse::over_limit(
                                "answer text",
                                crate::sse::MAX_TEXT_BYTES,
                            )));
                            return;
                        }
                        self.text.push_str(text);
                        sink.text_delta(text);
                    }
                }
            }
            "content_block_delta" => {
                let delta = event.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            if self.text.len() + text.len() > crate::sse::MAX_TEXT_BYTES {
                                self.outcome = Some(Err(crate::sse::over_limit(
                                    "answer text",
                                    crate::sse::MAX_TEXT_BYTES,
                                )));
                                return;
                            }
                            self.text.push_str(text);
                            self.deltas += 1;
                            sink.text_delta(text);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            let input = &mut self.blocks.entry(index).or_default().tool_input;
                            if input.len() + partial.len() > crate::sse::MAX_TOOL_INPUT_BYTES {
                                self.outcome = Some(Err(crate::sse::over_limit(
                                    "tool input",
                                    crate::sse::MAX_TOOL_INPUT_BYTES,
                                )));
                                return;
                            }
                            input.push_str(partial);
                        }
                    }
                    // thinking / signature / citations: not part of the answer.
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(usage) = event.get("usage") {
                    self.read_usage(usage);
                }
                if let Some(reason) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
            }
            "message_stop" => {
                self.outcome = Some(self.settle());
            }
            "error" => {
                self.outcome = Some(Err(error_from(&event)));
            }
            // `ping`, `content_block_stop`, and anything new.
            _ => {}
        }
    }

    fn read_usage(&mut self, usage: &Value) {
        let read = |key: &str| usage.get(key).and_then(Value::as_i64);
        if let Some(value) = read("input_tokens") {
            self.input_tokens = Some(value);
        }
        if let Some(value) = read("cache_read_input_tokens") {
            self.cache_read_tokens = value;
        }
        if let Some(value) = read("cache_creation_input_tokens") {
            self.cache_creation_tokens = value;
        }
        if let Some(value) = read("output_tokens") {
            self.output_tokens = Some(value);
        }
        // Cumulative on `message_delta`, so the last report wins.
        if let Some(value) = web_searches_of(usage) {
            self.web_search_requests = value;
        }
    }

    fn settle(&mut self) -> Result<ChatCompletion, ProviderError> {
        let tool_calls = std::mem::take(&mut self.blocks)
            .into_values()
            .filter_map(|block| {
                let id = block.tool_id?.trim().to_string();
                let name = block.tool_name?.trim().to_string();
                if id.is_empty() || name.is_empty() {
                    return None;
                }
                let arguments = if block.tool_input.trim().is_empty() {
                    block
                        .tool_input_start
                        .map(|input| input.to_string())
                        .unwrap_or_else(|| "{}".to_string())
                } else {
                    block.tool_input
                };
                Some(ProviderToolCall {
                    id,
                    name: momo_agent::tools::momo_tool_name(&name),
                    arguments,
                })
            })
            .collect::<Vec<_>>();
        let usage = usage_of(
            self.input_tokens,
            self.cache_read_tokens,
            self.cache_creation_tokens,
            self.output_tokens,
        );
        completion(
            std::mem::take(&mut self.text),
            tool_calls,
            usage,
            self.stop_reason.as_deref(),
            searches_seen(
                self.web_search_requests,
                self.server_tool_blocks,
                self.search_result_blocks,
            ),
        )
    }
}

fn usage_of(
    input: Option<i64>,
    cache_read: i64,
    cache_creation: i64,
    output: Option<i64>,
) -> Option<ChatUsage> {
    // Nothing measured ⇒ `None`, so the ledger row is `was_estimated`.
    if input.is_none() && output.is_none() {
        return None;
    }
    let clamp = |value: i64| value.clamp(0, i32::MAX as i64) as i32;
    // The ledger's `prompt_tokens` is the whole prompt with `cached_tokens` a
    // subset of it (the OpenAI shape). Anthropic reports the uncached part as
    // `input_tokens` and the cache reads/writes beside it, so they are summed.
    Some(ChatUsage {
        prompt_tokens: clamp(input.unwrap_or(0) + cache_read + cache_creation),
        completion_tokens: clamp(output.unwrap_or(0)),
        cached_tokens: clamp(cache_read),
        reasoning_tokens: 0,
    })
}

fn completion(
    text: String,
    tool_calls: Vec<ProviderToolCall>,
    usage: Option<ChatUsage>,
    stop_reason: Option<&str>,
    web_search_requests: i64,
) -> Result<ChatCompletion, ProviderError> {
    if text.trim().is_empty() && tool_calls.is_empty() {
        return Err(ProviderError::InvalidResponse(format!(
            "message carried no text and no tool_use (stop_reason `{}`)",
            stop_reason.unwrap_or("none")
        )));
    }
    Ok(ChatCompletion {
        text,
        usage,
        tool_calls,
        web_search_requests: web_search_requests.clamp(0, i32::MAX as i64) as i32,
    })
}

/// `usage.server_tool_use.web_search_requests` — what Anthropic bills a search by
/// (ADR-0201 증보 v2 H5). Absent ⇒ `None`.
fn web_searches_of(usage: &Value) -> Option<i64> {
    usage
        .pointer("/server_tool_use/web_search_requests")
        .and_then(Value::as_i64)
}

/// The searches a response made, as the rest of the worker counts them (the taint of a request
/// that read the web, the daily search ledger): the billing figure, or — when the content shows
/// more — what the content shows. The content is one block per provider-side tool call
/// (`server_tool_use`, whatever its name: only `web_search` is ever offered, so any other name is
/// read as a search too, the safe side) and one per `web_search_tool_result`; the larger of those
/// two counts is the content's. `usage` can be absent or zero while the blocks are there.
fn searches_seen(reported: i64, server_tool_blocks: i64, search_result_blocks: i64) -> i64 {
    reported
        .max(server_tool_blocks)
        .max(search_result_blocks)
        .max(0)
}

/// The provider's own server-side web search tool for a team-AI call
/// (ADR-0201 증보 v2 H5). Only search: `web_fetch` and code execution are never
/// offered (an arbitrary URL is an exfiltration path).
///
/// The type string follows the model (claude-api skill reference, cached
/// 2026-09-25): the dynamic-filtering `web_search_20260209` exists on Opus
/// 4.6+/Sonnet 4.6+ and the 5-series (Fable, Mythos, Opus 5/5.5, Sonnet 5/5.5);
/// every other model, and Vertex AI (basic variant only), gets
/// `web_search_20250305`. `runtime-unverified` against the live API.
pub fn web_search_tool(model: &str, base_url: &str, max_uses: i64) -> Value {
    json!({
        "type": web_search_tool_type(model, base_url),
        "name": "web_search",
        "max_uses": max_uses,
    })
}

pub fn web_search_tool_type(model: &str, base_url: &str) -> &'static str {
    const BASIC: &str = "web_search_20250305";
    const FILTERING: &str = "web_search_20260209";
    if base_url.to_ascii_lowercase().contains("googleapis.com") {
        return BASIC;
    }
    let model = model.trim().to_ascii_lowercase();
    let model = model.strip_prefix("anthropic.").unwrap_or(&model);
    let newer = [
        "claude-fable-",
        "claude-mythos-",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
    ];
    if newer.iter().any(|prefix| model.starts_with(prefix)) {
        FILTERING
    } else {
        BASIC
    }
}

/// An Anthropic error object (`{"type":"error","error":{"type","message"}}`).
///
/// `overloaded_error` and `api_error` are the provider's own outage signals
/// (the HTTP analogues are 529/500), so they stay retryable; every other error
/// type is a verdict about this request.
fn error_from(payload: &Value) -> ProviderError {
    let error = payload.get("error").unwrap_or(payload);
    let kind = error.get("type").and_then(Value::as_str).unwrap_or("error");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .unwrap_or("the provider reported an error with no message");
    match kind {
        "overloaded_error" | "api_error" => {
            ProviderError::Unreachable(format!("{kind}: {message}"))
        }
        _ => ProviderError::ErrorEnvelope(format!("{kind}: {message}")),
    }
}

/// Decode one non-streamed Messages response (or a 200 error object).
pub fn parse_message(body: &str) -> Result<ChatCompletion, ProviderError> {
    let payload: Value = serde_json::from_str(body)
        .map_err(|error| ProviderError::InvalidResponse(error.to_string()))?;
    if payload.get("type").and_then(Value::as_str) == Some("error") {
        return Err(error_from(&payload));
    }
    let content = payload
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| ProviderError::InvalidResponse("message has no content".to_string()))?;
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    let (mut server_tool_blocks, mut search_result_blocks) = (0i64, 0i64);
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(value) = block.get("text").and_then(Value::as_str) {
                    text.push_str(value);
                }
            }
            Some("server_tool_use") => server_tool_blocks += 1,
            Some("web_search_tool_result") => search_result_blocks += 1,
            Some("tool_use") => {
                let id = block.get("id").and_then(Value::as_str).unwrap_or("").trim();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if !id.is_empty() && !name.is_empty() {
                    tool_calls.push(ProviderToolCall {
                        id: id.to_string(),
                        name: momo_agent::tools::momo_tool_name(name),
                        arguments: block
                            .get("input")
                            .map(Value::to_string)
                            .unwrap_or_else(|| "{}".to_string()),
                    });
                }
            }
            _ => {}
        }
    }
    let usage = payload.get("usage").and_then(|usage| {
        let read = |key: &str| usage.get(key).and_then(Value::as_i64);
        usage_of(
            read("input_tokens"),
            read("cache_read_input_tokens").unwrap_or(0),
            read("cache_creation_input_tokens").unwrap_or(0),
            read("output_tokens"),
        )
    });
    completion(
        text,
        tool_calls,
        usage,
        payload.get("stop_reason").and_then(Value::as_str),
        searches_seen(
            payload.get("usage").and_then(web_searches_of).unwrap_or(0),
            server_tool_blocks,
            search_result_blocks,
        ),
    )
}

fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(name)?.strip_prefix(':')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ChatMessage;
    use std::sync::Mutex;

    fn sse(name: &str, data: Value) -> String {
        format!("event: {name}\ndata: {data}\n\n")
    }

    fn happy_stream(deltas: &[&str]) -> String {
        let mut out = sse(
            "message_start",
            json!({"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],
                "usage":{"input_tokens":40,"cache_read_input_tokens":25,"cache_creation_input_tokens":5,"output_tokens":1}}}),
        );
        out.push_str(&sse(
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        ));
        out.push_str(&sse("ping", json!({"type":"ping"})));
        for delta in deltas {
            out.push_str(&sse(
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":delta}}),
            ));
        }
        out.push_str(&sse(
            "content_block_stop",
            json!({"type":"content_block_stop","index":0}),
        ));
        out.push_str(&sse(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":17}}),
        ));
        out.push_str(&sse("message_stop", json!({"type":"message_stop"})));
        out
    }

    struct Collect(Mutex<Vec<String>>);
    impl DeltaSink for Collect {
        fn text_delta(&self, delta: &str) {
            self.0.lock().unwrap().push(delta.to_string());
        }
    }

    fn drive_chunked(
        raw: &str,
        size: usize,
        sink: &dyn DeltaSink,
    ) -> Result<ChatCompletion, ProviderError> {
        let mut stream = MessageStream::new();
        for chunk in raw.as_bytes().chunks(size) {
            stream.push_to(chunk, sink);
        }
        stream.finish()
    }

    /// #4143: the Hermes provider slug is a chat/completions field only.
    #[test]
    fn the_messages_wire_never_carries_the_hermes_provider_slug() {
        let request = ChatRequest {
            provider: Some("anthropic".into()),
            model: "claude-sonnet-5-5".into(),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: Some(16),
            tools: Vec::new(),
            momo_tools: Vec::new(),
        };
        let body = build_request_body(&request);
        assert!(body.get("provider").is_none(), "{body}");
    }

    #[test]
    fn the_request_body_is_the_messages_shape() {
        let request = ChatRequest {
            provider: None,
            model: "claude-sonnet-4-5".into(),
            messages: vec![
                ChatMessage::system("너는 hermes다"),
                ChatMessage {
                    role: "assistant".into(),
                    content: "이전 답".into(),
                },
                ChatMessage::user("[성재] 첫째"),
                ChatMessage::user("[성재] @hermes 둘째"),
            ],
            max_tokens: Some(512),
            tools: vec![
                json!({"type":"function","function":{"name":"lookup","description":"찾기","parameters":{"type":"object","properties":{"q":{"type":"string"}}}}}),
            ],
            momo_tools: Vec::new(),
        };
        let body = build_request_body(&request);
        assert_eq!(body["model"], json!("claude-sonnet-4-5"));
        assert_eq!(body["max_tokens"], json!(512));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["system"], json!("너는 hermes다"));
        assert_eq!(
            body["messages"],
            json!([
                {"role":"user","content":"(이전 대화)"},
                {"role":"assistant","content":"이전 답"},
                {"role":"user","content":"[성재] 첫째\n\n[성재] @hermes 둘째"},
            ]),
            "system lifted out, same-role turns merged, user first"
        );
        assert_eq!(
            body["tools"],
            json!([{"name":"lookup","description":"찾기","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}])
        );
        assert!(body.get("temperature").is_none());

        let bare = ChatRequest {
            provider: None,
            model: "m".into(),
            messages: vec![ChatMessage::user("q")],
            max_tokens: None,
            tools: Vec::new(),
            momo_tools: Vec::new(),
        };
        let body = build_request_body(&bare);
        assert_eq!(
            body["max_tokens"],
            json!(DEFAULT_MAX_TOKENS),
            "max_tokens is required by the API"
        );
        assert!(body.get("system").is_none() && body.get("tools").is_none());
    }

    /// 5-byte chunks split the 3-byte Korean characters; every delta reaches
    /// the sink in order and the committed text is exactly their concatenation.
    #[test]
    fn a_streamed_answer_accumulates_across_split_utf8_and_reports_each_slice() {
        let sink = Collect(Mutex::new(Vec::new()));
        let completion =
            drive_chunked(&happy_stream(&["클로드가 ", "답합니다"]), 5, &sink).expect("answer");
        assert_eq!(completion.text, "클로드가 답합니다");
        assert_eq!(*sink.0.lock().unwrap(), vec!["클로드가 ", "답합니다"]);
        assert_eq!(
            completion.usage,
            Some(ChatUsage {
                prompt_tokens: 70,
                completion_tokens: 17,
                cached_tokens: 25,
                reasoning_tokens: 0
            })
        );
    }

    #[test]
    fn a_tool_use_block_becomes_a_tool_call_under_momos_name() {
        let mut raw = sse(
            "message_start",
            json!({"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}),
        );
        raw.push_str(&sse("content_block_start", json!({"type":"content_block_start","index":0,
            "content_block":{"type":"tool_use","id":"toolu_01","name":"work_session_end","input":{}}})));
        for part in ["{\"session", "_id\":\"s-1\"}"] {
            raw.push_str(&sse(
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,
                "delta":{"type":"input_json_delta","partial_json":part}}),
            ));
        }
        raw.push_str(&sse("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}})));
        raw.push_str(&sse("message_stop", json!({"type":"message_stop"})));
        let completion = drive_chunked(&raw, 64, &DiscardDeltas).expect("tool call");
        assert!(completion.text.is_empty());
        assert_eq!(completion.tool_calls.len(), 1);
        let call = &completion.tool_calls[0];
        assert_eq!(call.id, "toolu_01");
        assert_eq!(
            call.name,
            momo_agent::tools::momo_tool_name("work_session_end")
        );
        assert_eq!(call.arguments_json(), json!({"session_id":"s-1"}));
    }

    #[test]
    fn a_stream_without_message_stop_is_retryable_not_half_published() {
        let full = happy_stream(&["반쯤 ", "끊긴"]);
        let cut = &full[..full.find("event: content_block_stop").unwrap()];
        let result = drive_chunked(cut, 7, &DiscardDeltas);
        let error = result.expect_err("no terminal event");
        assert!(matches!(error, ProviderError::Unreachable(_)), "{error:?}");
        assert!(error.is_retryable());
    }

    #[test]
    fn error_events_split_outage_from_verdict() {
        let overloaded = sse(
            "error",
            json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}),
        );
        let error = drive_chunked(&overloaded, 64, &DiscardDeltas).expect_err("overloaded");
        assert!(error.is_retryable(), "{error:?}");
        let invalid = sse(
            "error",
            json!({"type":"error","error":{"type":"invalid_request_error","message":"bad model"}}),
        );
        let error = drive_chunked(&invalid, 64, &DiscardDeltas).expect_err("invalid");
        assert!(matches!(error, ProviderError::ErrorEnvelope(ref m) if m.contains("bad model")));
        assert!(!error.is_retryable());
    }

    /// Review M-2: every accumulator has a ceiling, and crossing one ends the
    /// stream at once with a non-retryable error.
    #[test]
    fn hostile_streams_hit_a_ceiling_instead_of_growing() {
        fn fed_until_terminal(chunks: impl Iterator<Item = Vec<u8>>) -> (MessageStream, usize) {
            let mut stream = MessageStream::new();
            let mut fed = 0;
            for chunk in chunks {
                fed += chunk.len();
                stream.push(&chunk);
                if stream.is_terminal() {
                    break;
                }
            }
            (stream, fed)
        }
        let assert_refused = |stream: MessageStream, what: &str| {
            let error = stream.finish().expect_err(what);
            assert!(
                matches!(error, ProviderError::InvalidResponse(ref m) if m.contains("limit") || m.contains("index")),
                "{what}: {error:?}"
            );
            assert!(!error.is_retryable(), "{what}");
        };

        // 1. 64 MiB with no newline.
        let started = std::time::Instant::now();
        let (stream, fed) = fed_until_terminal(std::iter::repeat_n(vec![b'x'; 64 * 1024], 1024));
        assert!(stream.is_terminal(), "no newline ceiling");
        assert!(fed <= crate::sse::MAX_LINE_BYTES + 64 * 1024);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_refused(stream, "newline-free flood");

        // 2. `data:` lines that never close an event.
        let line = format!("data: {}\n", "y".repeat(512 * 1024));
        let (stream, _) = fed_until_terminal(std::iter::repeat_n(line.into_bytes(), 64));
        assert_refused(stream, "unterminated event");

        // 3. A content block index chosen by the provider.
        let raw = sse(
            "content_block_start",
            json!({"type":"content_block_start","index":1_000_000,"content_block":{"type":"text","text":""}}),
        );
        let (stream, _) = fed_until_terminal(std::iter::once(raw.into_bytes()));
        assert_refused(stream, "block index");

        // 4. Tool arguments that never end.
        let mut chunks = vec![sse(
            "content_block_start",
            json!({"type":"content_block_start","index":0,
            "content_block":{"type":"tool_use","id":"t","name":"n","input":{}}}),
        )
        .into_bytes()];
        let piece = "z".repeat(256 * 1024);
        for _ in 0..8 {
            chunks.push(
                sse(
                    "content_block_delta",
                    json!({"type":"content_block_delta","index":0,
                "delta":{"type":"input_json_delta","partial_json":piece}}),
                )
                .into_bytes(),
            );
        }
        let (stream, _) = fed_until_terminal(chunks.into_iter());
        assert_refused(stream, "tool input");

        // 5. Answer text past the ceiling.
        let piece = "가".repeat(300 * 1024);
        let chunks = (0..8).map(|_| {
            sse(
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":piece}}),
            )
            .into_bytes()
        });
        let (stream, _) = fed_until_terminal(chunks);
        assert_refused(stream, "answer text");
    }

    #[test]
    fn a_non_streamed_message_body_is_still_an_answer() {
        let body = json!({"type":"message","role":"assistant","content":[{"type":"text","text":"한 번에"}],
            "stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":2}}).to_string();
        let completion = drive_chunked(&body, 11, &DiscardDeltas).expect("json fallback");
        assert_eq!(completion.text, "한 번에");
        assert_eq!(completion.usage.unwrap().prompt_tokens, 5);
        let empty = json!({"type":"message","content":[],"stop_reason":"max_tokens"}).to_string();
        assert!(matches!(
            parse_message(&empty),
            Err(ProviderError::InvalidResponse(_))
        ));
    }

    /// ADR-0201 증보 v2 H5: a server tool rides through byte for byte (a bogus
    /// `input_schema` would turn it into a custom tool the model has to "call"),
    /// while an OpenAI function still re-shapes.
    #[test]
    fn a_server_web_search_tool_passes_through_unchanged() {
        let search = web_search_tool("claude-sonnet-5-5", "https://api.anthropic.com/v1", 3);
        let request = ChatRequest {
            provider: None,
            model: "claude-sonnet-5-5".into(),
            messages: vec![ChatMessage::user("q")],
            max_tokens: Some(100),
            tools: vec![
                search.clone(),
                json!({"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}),
            ],
            momo_tools: Vec::new(),
        };
        let body = build_request_body(&request);
        assert_eq!(body["tools"][0], search);
        assert_eq!(
            body["tools"][0],
            json!({"type":"web_search_20260209","name":"web_search","max_uses":3})
        );
        assert!(body["tools"][0].get("input_schema").is_none());
        assert_eq!(
            body["tools"][1],
            json!({"name":"lookup","input_schema":{"type":"object"}})
        );
        assert!(!body.to_string().contains("web_fetch"));

        // #3899 review: only web search rides through. A fetch / exec server tool
        // smuggled in an operator `tool_schema` comes out as an inert custom tool.
        for smuggled in [
            json!({"type":"web_fetch_20250910","name":"web_fetch","max_uses":5}),
            json!({"type":"code_execution_20250825","name":"code_execution"}),
        ] {
            let request = ChatRequest {
                provider: None,
                model: "claude-sonnet-5-5".into(),
                messages: vec![ChatMessage::user("q")],
                max_tokens: Some(100),
                tools: vec![smuggled.clone()],
                momo_tools: Vec::new(),
            };
            let rendered = &build_request_body(&request)["tools"][0];
            assert!(rendered.get("type").is_none(), "{rendered}");
            assert_eq!(rendered["input_schema"], json!({"type":"object"}));
        }
    }

    #[test]
    fn the_search_type_follows_the_model_and_the_platform() {
        for model in [
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-sonnet-5",
            "claude-fable-5-1",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "anthropic.claude-opus-5-5",
        ] {
            assert_eq!(
                web_search_tool_type(model, "https://api.anthropic.com/v1"),
                "web_search_20260209",
                "{model}"
            );
        }
        for model in [
            "claude-haiku-4-5",
            "claude-sonnet-4-5",
            "claude-opus-4-5",
            "unknown",
        ] {
            assert_eq!(
                web_search_tool_type(model, "https://api.anthropic.com/v1"),
                "web_search_20250305",
                "{model}"
            );
        }
        assert_eq!(
            web_search_tool_type(
                "claude-opus-5-5",
                "https://us-east5-aiplatform.googleapis.com/v1"
            ),
            "web_search_20250305",
            "Vertex has the basic variant only"
        );
    }

    /// A searched answer: `server_tool_use` / `web_search_tool_result` blocks are
    /// not tool calls the worker must run, the text survives, and the billed
    /// search count is reported.
    #[test]
    fn a_searched_answer_reports_its_search_count_and_no_tool_call() {
        let mut raw = sse(
            "message_start",
            json!({"type":"message_start","message":{"usage":{"input_tokens":30,"output_tokens":0}}}),
        );
        raw.push_str(&sse("content_block_start", json!({"type":"content_block_start","index":0,
            "content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}})));
        raw.push_str(&sse(
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,
            "delta":{"type":"input_json_delta","partial_json":"{\"query\":\"oort\"}"}}),
        ));
        raw.push_str(&sse(
            "content_block_start",
            json!({"type":"content_block_start","index":1,
            "content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1",
            "content":[{"type":"web_search_result","url":"https://example.com","title":"t"}]}}),
        ));
        raw.push_str(&sse(
            "content_block_start",
            json!({"type":"content_block_start","index":2,
            "content_block":{"type":"text","text":""}}),
        ));
        raw.push_str(&sse(
            "content_block_delta",
            json!({"type":"content_block_delta","index":2,
            "delta":{"type":"text_delta","text":"찾아봤어요."}}),
        ));
        raw.push_str(&sse(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},
            "usage":{"output_tokens":12,"server_tool_use":{"web_search_requests":2}}}),
        ));
        raw.push_str(&sse("message_stop", json!({"type":"message_stop"})));
        let completion = drive_chunked(&raw, 40, &DiscardDeltas).expect("searched answer");
        assert_eq!(completion.text, "찾아봤어요.");
        assert!(
            completion.tool_calls.is_empty(),
            "a server tool is not ours to run"
        );
        assert_eq!(completion.web_search_requests, 2);

        let body = json!({"type":"message","content":[{"type":"text","text":"네"}],
            "stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":2,
            "server_tool_use":{"web_search_requests":1}}})
        .to_string();
        assert_eq!(parse_message(&body).unwrap().web_search_requests, 1);
    }

    fn search_call(id: &str) -> Value {
        json!({"type":"server_tool_use","id":id,"name":"web_search","input":{"query":"oort"}})
    }

    fn search_result(id: &str) -> Value {
        json!({"type":"web_search_tool_result","tool_use_id":id,
            "content":[{"type":"web_search_result","url":"https://example.com","title":"t"}]})
    }

    fn own_proposal_call() -> Value {
        json!({"type":"tool_use","id":"toolu_1","name":"workspace_action_propose","input":{}})
    }

    /// The search count follows the content of a whole response: blocks that show a search count
    /// even when `usage` carries no `server_tool_use` figure, a reported zero does not erase them,
    /// a larger billing figure still wins, and a response with no such block counts nothing (our
    /// own tool call is not a search).
    #[test]
    fn a_whole_response_counts_its_searches_from_its_content_blocks() {
        let text = json!({"type":"text","text":"찾아봤어요."});
        let body = |blocks: Vec<Value>, figure: Option<i64>| {
            let mut usage = json!({"input_tokens":5,"output_tokens":2});
            if let Some(figure) = figure {
                usage["server_tool_use"] = json!({"web_search_requests": figure});
            }
            json!({"type":"message","content":blocks,"stop_reason":"end_turn","usage":usage})
                .to_string()
        };
        let cases: Vec<(&str, Vec<Value>, Option<i64>, i32)> = vec![
            (
                "a call and its result, no figure",
                vec![search_call("a"), search_result("a"), text.clone()],
                None,
                1,
            ),
            (
                "two searches, no figure",
                vec![
                    search_call("a"),
                    search_result("a"),
                    search_call("b"),
                    search_result("b"),
                    text.clone(),
                ],
                None,
                2,
            ),
            (
                "a result block alone",
                vec![search_result("a"), text.clone()],
                None,
                1,
            ),
            (
                "a reported zero does not erase the blocks",
                vec![search_call("a"), search_result("a"), text.clone()],
                Some(0),
                1,
            ),
            (
                "a larger billing figure wins",
                vec![search_call("a"), search_result("a"), text.clone()],
                Some(3),
                3,
            ),
            (
                "our own tool call is not a search",
                vec![own_proposal_call(), text.clone()],
                None,
                0,
            ),
        ];
        for (label, blocks, figure, expected) in cases {
            let completion = parse_message(&body(blocks, figure)).expect(label);
            assert_eq!(completion.web_search_requests, expected, "{label}");
        }
    }

    /// The same count over the stream: the blocks arrive as `content_block_start` events and the
    /// `message_delta` usage may carry no `server_tool_use` figure.
    #[test]
    fn a_streamed_response_counts_its_searches_from_its_content_blocks() {
        let stream = |blocks: Vec<Value>, figure: Option<i64>| -> String {
            let mut raw = sse(
                "message_start",
                json!({"type":"message_start","message":{"usage":{"input_tokens":30,"output_tokens":0}}}),
            );
            let mut index = 0;
            for block in blocks {
                raw.push_str(&sse(
                    "content_block_start",
                    json!({"type":"content_block_start","index":index,"content_block":block}),
                ));
                raw.push_str(&sse(
                    "content_block_stop",
                    json!({"type":"content_block_stop","index":index}),
                ));
                index += 1;
            }
            raw.push_str(&sse(
                "content_block_start",
                json!({"type":"content_block_start","index":index,
                "content_block":{"type":"text","text":"찾아봤어요."}}),
            ));
            let mut usage = json!({"output_tokens":12});
            if let Some(figure) = figure {
                usage["server_tool_use"] = json!({"web_search_requests": figure});
            }
            raw.push_str(&sse(
                "message_delta",
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":usage}),
            ));
            raw.push_str(&sse("message_stop", json!({"type":"message_stop"})));
            raw
        };
        let cases: Vec<(&str, Vec<Value>, Option<i64>, i32)> = vec![
            (
                "a call and its result, no figure",
                vec![search_call("a"), search_result("a")],
                None,
                1,
            ),
            (
                "two searches, no figure",
                vec![
                    search_call("a"),
                    search_result("a"),
                    search_call("b"),
                    search_result("b"),
                ],
                None,
                2,
            ),
            (
                "a reported zero does not erase the blocks",
                vec![search_call("a"), search_result("a")],
                Some(0),
                1,
            ),
            (
                "a larger billing figure wins",
                vec![search_call("a"), search_result("a")],
                Some(3),
                3,
            ),
            (
                "our own tool call is not a search",
                vec![own_proposal_call()],
                None,
                0,
            ),
        ];
        for (label, blocks, figure, expected) in cases {
            let completion =
                drive_chunked(&stream(blocks, figure), 37, &DiscardDeltas).expect(label);
            assert_eq!(completion.web_search_requests, expected, "{label}");
        }
    }
}
