//! The OpenAI **Responses** wire (B5.4b — ADR-0147 이행 완결).
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
//! `stream: false` is the same scope call B5.1 made for chat/completions:
//! streaming and `agent.partial` are a later batch, so the request asks for the
//! whole answer at once.

use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::provider::{
    post_json, ChatCompletion, ChatProvider, ChatRequest, ChatUsage, ProviderEndpoint,
    ProviderError,
};

/// `POST {base_url}/responses`, `stream=false`, `store=false`.
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
        let body = build_request_body(request);
        let text = post_json(&self.client, endpoint, &body).await?;
        parse_response(&text)
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
        "stream": false,
        "store": false,
    });
    let object = body.as_object_mut().expect("json object");
    if !instructions.is_empty() {
        object.insert("instructions".into(), json!(instructions.join("\n\n")));
    }
    // Omitted rather than sent as `null`: the Responses API reads an explicit
    // null as "no ceiling", which is true but is not the same statement as "the
    // caller has no opinion", and only the second one is what an absent budget
    // means here.
    if let Some(max_output_tokens) = request.max_tokens {
        object.insert("max_output_tokens".into(), json!(max_output_tokens));
    }
    body
}

/// Decode one non-streamed Responses body.
///
/// Order matters and mirrors [`crate::provider::parse_completion`]: the error
/// object is read **first**, because a 200 carrying one is a refusal, and
/// decoding it as a response would report an empty successful turn — the failure
/// mode where a user's question disappears without a trace.
pub fn parse_response(body: &str) -> Result<ChatCompletion, ProviderError> {
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

    let response: RawResponse = serde_json::from_str(body)
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

    let text = collect_output_text(response.output.as_deref());
    if text.trim().is_empty() {
        // A response with no assistant text is not an answer, and saying *why*
        // is the difference between an operator raising the token budget and an
        // operator restarting a provider that is working fine.
        return Err(ProviderError::InvalidResponse(unusable_reason(&response)));
    }

    Ok(ChatCompletion { text, usage })
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

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    message: Option<String>,
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
    use crate::provider::ChatMessage;

    fn request() -> ChatRequest {
        ChatRequest {
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
        assert_eq!(body["stream"], json!(false));
        assert_eq!(body["store"], json!(false));
        assert_eq!(body["max_output_tokens"], json!(512));
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
}
