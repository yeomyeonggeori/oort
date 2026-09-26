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

        match kind.as_str() {
            "message_start" => {
                if let Some(usage) = event.pointer("/message/usage") {
                    self.read_usage(usage);
                }
            }
            "content_block_start" => {
                let block = self.blocks.entry(index).or_default();
                let start = event.get("content_block").unwrap_or(&Value::Null);
                if start.get("type").and_then(Value::as_str) == Some("tool_use") {
                    block.tool_id = start.get("id").and_then(Value::as_str).map(str::to_string);
                    block.tool_name = start
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    block.tool_input_start = start.get("input").cloned();
                } else if let Some(text) = start.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
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
                            self.text.push_str(text);
                            self.deltas += 1;
                            sink.text_delta(text);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            self.blocks
                                .entry(index)
                                .or_default()
                                .tool_input
                                .push_str(partial);
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
    })
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
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(value) = block.get("text").and_then(Value::as_str) {
                    text.push_str(value);
                }
            }
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

    #[test]
    fn the_request_body_is_the_messages_shape() {
        let request = ChatRequest {
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
}
