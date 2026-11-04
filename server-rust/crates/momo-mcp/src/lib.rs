//! Bounded, persistence-free MCP wire core for the oort Agent Port.
//!
//! This crate intentionally has no database, HTTP server, or HTTP client
//! dependency. The Axum adapter authenticates every POST before passing the
//! normalized transport headers and body to [`dispatch`].

use std::collections::HashSet;
use std::fmt;

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

pub mod handle;
/// ADR-0216 D5 / #4661 — the human MCP's tool catalog (`POST /v1/mcp/me`).
pub mod human;
pub mod oauth;
pub mod tools;

pub use handle::{decode_lease_handle, encode_lease_handle, LeaseHandle, LeaseHandleError};
pub use oauth::{
    authorization_redirect, authorization_server_metadata, parse_requested_scopes,
    percent_encode_query_value, protected_resource_metadata, redirect_uri_is_registered,
    validate_code_challenge, validate_resource, validate_state, verify_pkce_s256, OauthError,
    AUTHORIZATION_SERVER_WELL_KNOWN, CODE_CHALLENGE_METHOD_S256, GRANT_TYPE_AUTHORIZATION_CODE,
    GRANT_TYPE_REFRESH_TOKEN, MAX_CLIENT_ID_BYTES, MAX_REDIRECT_URI_BYTES, MAX_RESOURCE_BYTES,
    MAX_STATE_BYTES, PROTECTED_RESOURCE_WELL_KNOWN_PREFIX, RESPONSE_TYPE_CODE, TOKEN_TYPE_BEARER,
};
pub use tools::{
    validate_arguments, ArtifactRule, ArtifactViolation, AssembleParams, RunEventViolation,
    ToolAnnotations, ToolCapability, ToolDescriptor, ToolFailure, ToolSurface, ToolView,
    APPS_USED_ENTRY_KEYS, APP_NOTICE_KEYS, APP_NOTICE_REPORTABLE_KINDS, ARTIFACT_KEYS,
    ASSEMBLE_PARAMS, ASSEMBLY_PARAMS_INVALID, MAX_ACTIVITY_ID_BYTES, MAX_ACTIVITY_LABEL_BYTES,
    MAX_APPS_USED_ENTRIES, MAX_APPS_USED_TOOL_BYTES, MAX_ARTIFACT_COUNT, MAX_PLAN_TEXT_BYTES,
    MAX_REPORTED_COUNT, MAX_RUN_ACTIVITIES, MAX_RUN_PLAN_ITEMS, MAX_STAGE_BYTES, NEXT_ACTIONS,
    RESULT_KINDS, RUN_ACTIVITY_KINDS, RUN_ACTIVITY_STATUSES, RUN_EVENT_REPORT_FIELDS,
    RUN_PLAN_STATUSES, TEST_COUNT_KEYS, TOOL_ACTION_CLAIM_SECRET, TOOL_ACTION_INITIATE,
    TOOL_ACTION_PROPOSE, TOOL_CARD_SUGGEST, TOOL_CATALOG, TOOL_CONVERSATION_READ, TOOL_COUNT_KEYS,
    TOOL_EXPRESSION_ASSEMBLE, TOOL_INBOX_READ, TOOL_JOBS_CLAIM, TOOL_JOB_RELEASE, TOOL_JOB_RENEW,
    TOOL_JOB_START, TOOL_MESSAGE_POST, TOOL_PING, TOOL_RUN_COMPLETE, TOOL_RUN_EVENT,
};

pub const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";
pub const LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 2] =
    [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];

pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const MAX_JSON_DEPTH: usize = 32;
pub const MAX_STRING_BYTES: usize = 8 * 1024;

/// The one bulk string the Agent Port accepts: an `avatar.dataBase64` (ADR-0186
/// 증보 v3 V3-2a) — the base64 of an image of at most 44 000 bytes, 58 668
/// characters. It is allowed to exceed [`MAX_STRING_BYTES`] **only under this key
/// name** and only up to this many bytes; the whole request is still bounded by
/// [`MAX_BODY_BYTES`] before it is parsed, so this adds no allocation the body bound
/// did not already allow.
pub const MAX_BULK_BASE64_BYTES: usize = 58_700;
/// The key [`MAX_BULK_BASE64_BYTES`] applies to.
pub const BULK_BASE64_KEY: &str = "dataBase64";
pub const MAX_COLLECTION_ITEMS: usize = 256;

/// ADR-0218 appendix A / ADR-0186 v8 X8-1: the whole JSON-RPC request of an
/// `oort_action_propose` for **`expression.create`** may be up to 6 MiB (four generated
/// candidates of at most 1 MiB each, base64, plus the envelope). It is a budget of that one
/// action, not a wider limit: every other call, and every other action, keeps
/// [`MAX_BODY_BYTES`] / [`MAX_BULK_BASE64_BYTES`], and a body between the two limits is
/// admitted only after it parses as exactly this call ([`is_expression_create_call`]).
pub const MAX_EXPRESSION_REQUEST_BYTES: usize = 6 * 1024 * 1024;
/// One generated candidate's `dataBase64` under that budget: base64 of 1 MiB.
pub const MAX_EXPRESSION_BASE64_BYTES: usize = 1_398_104;
/// The action id the larger budget belongs to (the registry's `expression.create`).
pub const EXPRESSION_CREATE_ACTION_ID: &str = "expression.create";

/// Is `request` (already parsed) a `tools/call` of `oort_action_propose` naming
/// `expression.create`? The one shape allowed past [`MAX_BODY_BYTES`]. A huge string hidden in
/// another action, another tool or an unknown field never matches.
pub fn is_expression_create_call(request: &Value) -> bool {
    request.get("method").and_then(Value::as_str) == Some("tools/call")
        && request.pointer("/params/name").and_then(Value::as_str) == Some(TOOL_ACTION_PROPOSE)
        && request
            .pointer("/params/arguments/actionId")
            .and_then(Value::as_str)
            == Some(EXPRESSION_CREATE_ACTION_ID)
}

/// Cheap pre-filter before a body past [`MAX_BODY_BYTES`] is parsed at all: the action id must
/// appear in it. (Necessary, not sufficient: the parsed shape is what admits it.)
fn mentions_expression_create(body: &[u8]) -> bool {
    mentions(body, EXPRESSION_CREATE_ACTION_ID)
}

fn mentions(body: &[u8], needle: &str) -> bool {
    let needle = needle.as_bytes();
    body.windows(needle.len()).any(|window| window == needle)
}

/// ADR-0218 G3.2 / G3.7 (a), #4820 C1b: the **second and last** call that may exceed
/// [`MAX_BODY_BYTES`] — `oort_expression_assemble` carrying one picture as base64. The picture is
/// at most 4 MiB decoded, which is exactly 5,592,408 base64 characters, and the whole request
/// stays inside the same 6 MiB budget ([`MAX_EXPRESSION_REQUEST_BYTES`]). Like
/// `expression.create`'s, it is that one tool's budget and no wider limit: the base64 bound
/// applies only under the `dataBase64` key of a call that parses as exactly this tool.
pub const MAX_ASSEMBLE_BASE64_BYTES: usize = 5_592_408;

/// Is `request` (already parsed) a `tools/call` of `oort_expression_assemble`?
pub fn is_expression_assemble_call(request: &Value) -> bool {
    request.get("method").and_then(Value::as_str) == Some("tools/call")
        && request.pointer("/params/name").and_then(Value::as_str) == Some(TOOL_EXPRESSION_ASSEMBLE)
}

pub const JSON_CONTENT_TYPE: &str = "application/json";
pub const REQUIRED_ACCEPT_JSON: &str = "application/json";
pub const REQUIRED_ACCEPT_SSE: &str = "text/event-stream";
pub const HEADER_PROTOCOL_VERSION: &str = "MCP-Protocol-Version";
pub const HEADER_MCP_METHOD: &str = "Mcp-Method";
pub const HEADER_MCP_NAME: &str = "Mcp-Name";
pub const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
pub const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";

pub const ERR_VERSION_MISMATCH: i64 = -32020;
pub const ERR_UNSUPPORTED_VERSION: i64 = -32022;

#[derive(Debug, Clone, Copy)]
pub struct HttpRequest<'a> {
    pub content_type: Option<&'a str>,
    pub accept: Option<&'a str>,
    pub protocol_version: Option<&'a str>,
    pub mcp_method: Option<&'a str>,
    pub mcp_name: Option<&'a str>,
    pub body: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Option<Vec<u8>>,
    pub content_type: Option<&'static str>,
}

/// Protocol-valid foundation calls that may advance hosted pairing/proof.
/// Notifications and ping deliberately have no variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FoundationRequest {
    ModernDiscover,
    ModernToolsList,
    LegacyInitialize,
    LegacyToolsList,
}

pub fn classify_foundation_request(request: HttpRequest<'_>) -> Option<FoundationRequest> {
    if dispatch(request).status != 200 {
        return None;
    }
    let value: Value = serde_json::from_slice(request.body).ok()?;
    let method = value.get("method")?.as_str()?;
    match (request.protocol_version, method) {
        (Some(MODERN_PROTOCOL_VERSION), "server/discover") => {
            Some(FoundationRequest::ModernDiscover)
        }
        (Some(MODERN_PROTOCOL_VERSION), "tools/list") => Some(FoundationRequest::ModernToolsList),
        (Some(LEGACY_PROTOCOL_VERSION), "initialize") | (None, "initialize") => {
            Some(FoundationRequest::LegacyInitialize)
        }
        (Some(LEGACY_PROTOCOL_VERSION), "tools/list") | (None, "tools/list") => {
            Some(FoundationRequest::LegacyToolsList)
        }
        _ => None,
    }
}

impl HttpResponse {
    fn empty(status: u16) -> Self {
        Self {
            status,
            body: None,
            content_type: None,
        }
    }

    fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            body: Some(serde_json::to_vec(&value).expect("JSON value serialization is infallible")),
            content_type: Some(JSON_CONTENT_TYPE),
        }
    }
}

/// Which protocol era a validated tool call arrived on. The eras shape the
/// success envelope and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolEra {
    Modern,
    Legacy,
}

/// A `tools/call` that passed protocol validation **and** the caller's
/// [`ToolView`]. Producing one is the adapter's cue to run a typed domain port;
/// this crate reaches no product data itself and holds none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub id: Value,
    pub era: ToolEra,
    pub tool: &'static ToolDescriptor,
    /// The already-bounded `params.arguments` object, or `{}` when omitted.
    pub arguments: Value,
}

/// The two things one validated POST can become.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A complete answer; the adapter writes it out unchanged.
    Response(HttpResponse),
    /// An authorized tool invocation the adapter must execute.
    Tool(ToolCall),
}

/// Validate and dispatch one already-authenticated Agent Port POST **with the
/// caller's own tool view**.
///
/// `view` is the only thing that makes a product tool visible or callable, and
/// it feeds `tools/list` and `tools/call` through one code path — that shared
/// input is the structural reason the advertised catalog and the callable
/// catalog cannot disagree.
pub fn dispatch_with_tools(request: HttpRequest<'_>, view: &ToolView) -> Outcome {
    let mut call = None;
    let response = dispatch_inner(request, view, &mut call);
    match call {
        Some(call) => Outcome::Tool(call),
        None => Outcome::Response(response),
    }
}

/// Validate and dispatch one already-authenticated Agent Port POST with **no**
/// product capability: the foundation surface HAP-E2 shipped.
///
/// Equivalent to [`dispatch_with_tools`] under an empty [`ToolView`], which is
/// also what a connect-only credential gets, so this stays the exact behaviour
/// of the transport before any tool scope is granted.
pub fn dispatch(request: HttpRequest<'_>) -> HttpResponse {
    match dispatch_with_tools(request, &ToolView::empty()) {
        Outcome::Response(response) => response,
        // Unreachable: an empty view makes every tool name uncallable, so the
        // tools/call arm below answers "unknown tool" instead of emitting one.
        Outcome::Tool(call) => error(400, call.id, -32602, "unknown tool", None),
    }
}

/// What a refused request looked like, as **names only**.
///
/// Built for the adapter's diagnostic log when a request is answered with a
/// JSON-RPC error: it carries the method, the top-level `params` key names and
/// the `params._meta` key names — never a value, never a nested name, never an
/// argument key. Names come from the caller, so they are capped in count and
/// length and the adapter logs them through `Debug` formatting.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestShape {
    pub method: Option<String>,
    pub params_keys: Vec<String>,
    pub meta_keys: Vec<String>,
}

const SHAPE_MAX_KEYS: usize = 16;
const SHAPE_MAX_NAME_CHARS: usize = 64;

fn bounded_name(name: &str) -> String {
    name.chars().take(SHAPE_MAX_NAME_CHARS).collect()
}

fn bounded_keys(object: &serde_json::Map<String, Value>) -> Vec<String> {
    object
        .keys()
        .take(SHAPE_MAX_KEYS)
        .map(|key| bounded_name(key))
        .collect()
}

/// Extract the [`RequestShape`] of a raw body. Unparseable input yields the
/// empty shape; this never fails and never echoes a value.
pub fn request_shape(body: &[u8]) -> RequestShape {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return RequestShape::default();
    };
    let Some(object) = value.as_object() else {
        return RequestShape::default();
    };
    let params = object.get("params").and_then(Value::as_object);
    RequestShape {
        method: object
            .get("method")
            .and_then(Value::as_str)
            .map(bounded_name),
        params_keys: params.map(bounded_keys).unwrap_or_default(),
        meta_keys: params
            .and_then(|params| params.get("_meta"))
            .and_then(Value::as_object)
            .map(bounded_keys)
            .unwrap_or_default(),
    }
}

/// The JSON-RPC methods this server answers. The only `method` values a call trace
/// ever carries besides [`CALL_METHOD_OTHER`], [`CALL_METHOD_UNPARSED`] and
/// [`CALL_METHOD_NONE`].
pub const CALL_METHODS: [&str; 6] = [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call",
    "server/discover",
];
/// A well-formed request whose method is not one of [`CALL_METHODS`].
pub const CALL_METHOD_OTHER: &str = "other";
/// The body is not JSON at all (a broken string, a truncated body, a stray newline).
pub const CALL_METHOD_UNPARSED: &str = "unparsed";
/// The body is JSON but names no method (a batch array, an object without `method`).
pub const CALL_METHOD_NONE: &str = "no_method";
/// A `tools/call` whose `params.name` is not a [`TOOL_CATALOG`] name (or is absent).
pub const CALL_TOOL_UNKNOWN: &str = "unknown";

/// What one Agent Port call was, in **closed vocabulary only** (ADR-0200 증보 4, #4618).
///
/// Both fields are `&'static str` on purpose: the only way to build one is to pick a
/// string this crate owns, so a method or tool name the *caller* chose can never reach
/// the audit row this feeds — not a prefix of it, not a truncation, not a hash.
/// Arguments, cursors, handles and every other value are not read at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallShape {
    /// One of [`CALL_METHODS`], [`CALL_METHOD_OTHER`], [`CALL_METHOD_UNPARSED`] or
    /// [`CALL_METHOD_NONE`].
    pub method: &'static str,
    /// For a `tools/call` only: the [`TOOL_CATALOG`] name it asked for, or
    /// [`CALL_TOOL_UNKNOWN`]. The catalog name is recorded even when this caller's view
    /// cannot call it — which is exactly the diagnosis "it asked for a tool it was not
    /// given" — and the wire answer stays the same "unknown tool" for both.
    pub tool: Option<&'static str>,
}

/// Classify a raw Agent Port body. Never fails, never echoes a caller string.
pub fn call_shape(body: &[u8]) -> CallShape {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return CallShape {
            method: CALL_METHOD_UNPARSED,
            tool: None,
        };
    };
    let Some(method) = value
        .as_object()
        .and_then(|object| object.get("method"))
        .and_then(Value::as_str)
    else {
        return CallShape {
            method: CALL_METHOD_NONE,
            tool: None,
        };
    };
    let Some(method) = CALL_METHODS.iter().copied().find(|known| *known == method) else {
        return CallShape {
            method: CALL_METHOD_OTHER,
            tool: None,
        };
    };
    let tool = (method == "tools/call").then(|| {
        value
            .get("params")
            .and_then(Value::as_object)
            .and_then(|params| params.get("name"))
            .and_then(Value::as_str)
            .and_then(|name| TOOL_CATALOG.iter().find(|tool| tool.name == name))
            .map_or(CALL_TOOL_UNKNOWN, |tool| tool.name)
    });
    CallShape { method, tool }
}

/// How much a successful answer handed over, as small integers the **server** computed
/// from its own response — the one thing a call trace needs beyond "it succeeded" to tell
/// "the runtime read the inbox and saw no job" from "it saw the job and never claimed it".
///
/// Only three tools have a count, only on success, and a count is all there is: no id, no
/// cursor, no handle, no text, no channel. The caller's input is not an input here at all
/// (the argument is the server's own answer body and the catalog tool name the dispatcher
/// already resolved).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResultCounts {
    /// `oort_inbox_read`: events on the page the server returned.
    pub events: Option<u32>,
    /// `oort_inbox_read`: how many of those are `agent_job` (a tracked turn).
    pub agent_jobs: Option<u32>,
    /// `oort_jobs_claim`: jobs handed over; `oort_job_start`: `1` when it handed one over,
    /// `0` when `job` was null (nothing pending, or a closed run).
    pub jobs: Option<u32>,
}

fn clamp_count(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

/// The [`ResultCounts`] of a success body for `tool` (a [`TOOL_CATALOG`] name). Anything
/// that is not a success of one of the three tools — an error body, another tool, a body
/// that does not parse, a field of the wrong shape — has no counts.
pub fn result_counts(tool: &str, body: Option<&[u8]>) -> ResultCounts {
    let Some(structured) = body
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
        .and_then(|value| {
            value
                .get("result")?
                .get("structuredContent")
                .filter(|content| content.is_object())
                .cloned()
        })
    else {
        return ResultCounts::default();
    };
    match tool {
        TOOL_INBOX_READ => {
            let Some(events) = structured.get("events").and_then(Value::as_array) else {
                return ResultCounts::default();
            };
            ResultCounts {
                events: Some(clamp_count(events.len())),
                agent_jobs: Some(clamp_count(
                    events
                        .iter()
                        .filter(|event| {
                            event.get("kind").and_then(Value::as_str) == Some("agent_job")
                        })
                        .count(),
                )),
                jobs: None,
            }
        }
        TOOL_JOBS_CLAIM => ResultCounts {
            jobs: structured
                .get("jobs")
                .and_then(Value::as_array)
                .map(|jobs| clamp_count(jobs.len())),
            ..ResultCounts::default()
        },
        TOOL_JOB_START => ResultCounts {
            jobs: structured.get("job").map(|job| u32::from(job.is_object())),
            ..ResultCounts::default()
        },
        _ => ResultCounts::default(),
    }
}

/// The JSON-RPC `error.code` a response body carries, or `None` for a success (or a
/// body-less answer such as the `202` for `notifications/initialized`).
pub fn response_rpc_code(body: Option<&[u8]>) -> Option<i64> {
    serde_json::from_slice::<Value>(body?)
        .ok()?
        .get("error")?
        .get("code")?
        .as_i64()
}

/// The closed result token for a response's JSON-RPC code: `ok` for none, the same
/// seven tokens [`ToolFailure::code`] uses for the tool failures (so a call trace and
/// the run ledger's `tool_call` rows speak one vocabulary), and `protocol_error` for
/// everything the transport itself refused (`-32700`, `-32600`, `-32601`, `-32020`,
/// `-32022`, `-32029`).
///
/// `-32602` is `invalid_arguments` for a tool call **and** for a malformed envelope:
/// the wire already answers both with the same code, and the trace's `method`/`tool`
/// say which one it was.
pub fn outcome_code(rpc_code: Option<i64>) -> &'static str {
    match rpc_code {
        None => "ok",
        Some(-32602) => "invalid_arguments",
        Some(-32003) => "not_authorized",
        Some(-32004) => "unavailable",
        Some(-32005) => "conflict",
        Some(-32006) => "already_claimed",
        Some(-32007) => "claim_expired",
        Some(-32603) => "internal",
        Some(_) => "protocol_error",
    }
}

/// The server's own refusal sentences, each mapped to a **closed reason token**.
///
/// One JSON-RPC code covers many causes (`-32020` is eight different reachable header/metadata
/// mismatches, `-32600` about a dozen envelope and transport faults), and which one a runtime hit is
/// the whole diagnosis: "forgot the `Mcp-Name` header" and "sent a modern `_meta` with no
/// protocol header" need different fixes in a routine. The sentence itself is
/// server-authored, but a trace must not depend on that staying true, so it is never copied:
/// the response's `error.message` is looked up here by **exact match** and only the table's
/// token comes out. Anything else — a sentence added without a row, a message that ever
/// carried caller text — is [`REASON_OTHER`], so the vocabulary is closed by construction
/// and a missing row is visible as `other`, not as a leak. A test fails when a sentence in
/// this crate has no row.
pub const REFUSAL_REASONS: &[(&str, &str)] = &[
    // The transport, before the body is a request.
    ("request body exceeds the limit", "body_too_large"),
    ("Content-Type must be application/json", "content_type"),
    (
        "Accept must include application/json and text/event-stream",
        "accept",
    ),
    ("invalid Agent Port transport headers", "transport_headers"),
    ("parse error", "parse_error"),
    ("JSON nesting exceeds the limit", "json_limits"),
    ("JSON string exceeds the limit", "json_limits"),
    ("JSON collection exceeds the limit", "json_limits"),
    // The JSON-RPC envelope.
    ("request must be an object", "request_shape"),
    ("request contains an unknown field", "request_shape"),
    ("jsonrpc must equal 2.0", "request_shape"),
    ("method is required", "request_shape"),
    ("invalid JSON-RPC id", "request_shape"),
    ("params must be an object", "request_shape"),
    // Which protocol era, and whether the headers and the body agree.
    ("unsupported protocol version", "version_unsupported"),
    (
        "modern requests require the matching MCP-Protocol-Version",
        "version_header",
    ),
    (
        "legacy follow-up requests require MCP-Protocol-Version",
        "version_header",
    ),
    (
        "metadata and header protocol versions do not match",
        "version_mismatch",
    ),
    (
        "legacy protocolVersion is not valid in modern _meta",
        "version_mismatch",
    ),
    (
        "modern protocol metadata is not valid in legacy requests",
        "version_mismatch",
    ),
    (
        "initialize header and proposed version do not match",
        "version_mismatch",
    ),
    (
        "modern protocolVersion cannot use legacy initialize",
        "version_mismatch",
    ),
    (
        "Mcp-Method does not match the JSON-RPC method",
        "mcp_method_header",
    ),
    (
        "Mcp-Name does not match tools/call params.name",
        "mcp_name_header",
    ),
    ("Mcp-Name is only valid for tools/call", "mcp_name_header"),
    // What a modern request must carry in `params._meta`.
    ("modern params are required", "modern_meta"),
    ("modern params._meta is required", "modern_meta"),
    ("modern protocolVersion metadata is required", "modern_meta"),
    (
        "modern clientCapabilities metadata is required",
        "modern_meta",
    ),
    ("invalid modern clientInfo metadata", "modern_meta"),
    // What the legacy handshake must carry.
    ("initialize params are required", "initialize_params"),
    (
        "initialize protocolVersion is required",
        "initialize_params",
    ),
    (
        "initialize capabilities and clientInfo are required",
        "initialize_params",
    ),
    ("initialized must be a notification", "initialized_has_id"),
    // The method and its params.
    ("method params contain an unknown field", "method_params"),
    ("method params must be empty", "method_params"),
    ("invalid tools/call params", "tools_call_params"),
    ("tools/call name is required", "tools_call_params"),
    ("method not found", "method_not_found"),
    // The tool.
    ("unknown tool", "unknown_tool"),
    ("invalid tool arguments", "tool_arguments"),
    (
        "tool is not authorized for this connection",
        "tool_not_authorized",
    ),
    ("tool target is unavailable", "tool_unavailable"),
    ("tool target refused the transition", "tool_conflict"),
    ("secret was already claimed", "tool_already_claimed"),
    ("claim window has passed", "tool_claim_expired"),
    ("internal error", "tool_internal"),
    // The adapter's own `429` sentence (`routes/agent_port.rs`). Kept so a refusal that says it maps to
    // a token rather than `other`, but nothing reaches it today: the admission limiter answers before
    // any identity exists, so a `429` is never traced (ADR-0200 증보 4, A1). A defensive row, not a live one.
    ("rate limit exceeded", "rate_limited"),
];
/// The token for a refusal whose sentence has no row in [`REFUSAL_REASONS`].
pub const REASON_OTHER: &str = "other";
/// The token for a refused `oort_run_complete.artifacts` (its message names a field from a
/// static list, so it is recognised by its `error.data {field, rule}` instead of by sentence).
pub const REASON_TOOL_ARTIFACTS: &str = "tool_artifacts";

/// The token of one refusal sentence: the table's token on an exact match, else
/// [`REASON_OTHER`]. The only way a sentence becomes a token.
pub fn reason_of_sentence(sentence: &str) -> &'static str {
    REFUSAL_REASONS
        .iter()
        .find(|(known, _)| *known == sentence)
        .map_or(REASON_OTHER, |(_, token)| token)
}

/// The closed reason token of a refusal body, or `None` for a success (or no body).
pub fn refusal_reason(body: Option<&[u8]>) -> Option<&'static str> {
    let value: Value = serde_json::from_slice(body?).ok()?;
    let error = value.get("error")?;
    // `oort_run_complete.artifacts` only: a refused `oort_run_event` report also carries
    // `error.data {field, rule}` (ADR-0200 증보 7) but keeps the plain arguments sentence, so it
    // is told by the sentence like every other refusal and never mislabelled `tool_artifacts`.
    if error
        .get("data")
        .and_then(Value::as_object)
        .is_some_and(|data| {
            data.contains_key("rule")
                && data
                    .get("field")
                    .and_then(Value::as_str)
                    .is_some_and(|field| field.starts_with("artifacts"))
        })
    {
        return Some(REASON_TOOL_ARTIFACTS);
    }
    Some(
        error
            .get("message")
            .and_then(Value::as_str)
            .map_or(REASON_OTHER, reason_of_sentence),
    )
}

fn dispatch_inner(
    request: HttpRequest<'_>,
    view: &ToolView,
    call: &mut Option<ToolCall>,
) -> HttpResponse {
    // The body limit: 64 KiB for every call. Past it, only an `expression.create` proposal or an
    // `oort_expression_assemble` call within the one 6 MiB budget is let through, and that is
    // proved after parsing below.
    let past_standard_limit = request.body.len() > MAX_BODY_BYTES;
    if past_standard_limit
        && (request.body.len() > MAX_EXPRESSION_REQUEST_BYTES
            || !(mentions_expression_create(request.body)
                || mentions(request.body, TOOL_EXPRESSION_ASSEMBLE)))
    {
        return error(
            413,
            Value::Null,
            -32600,
            "request body exceeds the limit",
            None,
        );
    }

    if !is_json_content_type(request.content_type) {
        return error(
            415,
            Value::Null,
            -32600,
            "Content-Type must be application/json",
            None,
        );
    }
    if !accepts_required_types(request.accept) {
        return error(
            415,
            Value::Null,
            -32600,
            "Accept must include application/json and text/event-stream",
            None,
        );
    }

    let value: Value = match serde_json::from_slice::<UniqueValue>(request.body) {
        Ok(value) => value.0,
        Err(_) => return error(400, Value::Null, -32700, "parse error", None),
    };
    let expression_budget = is_expression_create_call(&value);
    let assemble_budget = is_expression_assemble_call(&value);
    if past_standard_limit && !(expression_budget || assemble_budget) {
        return error(
            413,
            Value::Null,
            -32600,
            "request body exceeds the limit",
            None,
        );
    }
    if let Err(message) = validate_bounds(
        &value,
        if expression_budget {
            MAX_EXPRESSION_BASE64_BYTES
        } else if assemble_budget {
            MAX_ASSEMBLE_BASE64_BYTES
        } else {
            MAX_BULK_BASE64_BYTES
        },
    ) {
        // The bound violation may itself be the id. Never reflect attacker-sized
        // strings or collections in an error response.
        return error(400, Value::Null, -32600, message, None);
    }

    let object = match value.as_object() {
        Some(object) => object,
        None => return error(400, Value::Null, -32600, "request must be an object", None),
    };
    if !has_only_keys(object, &["jsonrpc", "id", "method", "params"]) {
        return error(
            400,
            request_id(&value),
            -32600,
            "request contains an unknown field",
            None,
        );
    }
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return error(
            400,
            request_id(&value),
            -32600,
            "jsonrpc must equal 2.0",
            None,
        );
    }
    let method = match object.get("method").and_then(Value::as_str) {
        Some(method) if !method.is_empty() && method.len() <= 256 => method,
        _ => return error(400, request_id(&value), -32600, "method is required", None),
    };
    if !valid_id_shape(object.get("id"), method) {
        return error(400, Value::Null, -32600, "invalid JSON-RPC id", None);
    }
    if let Some(params) = object.get("params") {
        if !params.is_object() {
            return error(
                400,
                request_id(&value),
                -32602,
                "params must be an object",
                None,
            );
        }
    }

    match select_era(request.protocol_version, object) {
        Ok(Era::Modern) => dispatch_modern(request, object, method, view, call),
        Ok(Era::Legacy) => dispatch_legacy(request, object, method, view, call),
        Err(response) => response,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Era {
    Modern,
    Legacy,
}

fn select_era(
    header_version: Option<&str>,
    object: &serde_json::Map<String, Value>,
) -> Result<Era, HttpResponse> {
    match header_version {
        Some(MODERN_PROTOCOL_VERSION) => return Ok(Era::Modern),
        Some(LEGACY_PROTOCOL_VERSION) => return Ok(Era::Legacy),
        Some(other) => {
            return Err(unsupported_version(
                request_id_from_object(object),
                Some(other),
            ))
        }
        None => {}
    }

    if let Some(version) = modern_meta_version(object) {
        return match version {
            MODERN_PROTOCOL_VERSION => Ok(Era::Modern),
            LEGACY_PROTOCOL_VERSION => Err(version_mismatch(
                request_id_from_object(object),
                "legacy protocolVersion is not valid in modern _meta",
            )),
            other => Err(unsupported_version(
                request_id_from_object(object),
                Some(other),
            )),
        };
    }

    if object.get("method").and_then(Value::as_str) == Some("initialize") {
        return Ok(Era::Legacy);
    }

    Err(unsupported_version(request_id_from_object(object), None))
}

fn dispatch_modern(
    request: HttpRequest<'_>,
    object: &serde_json::Map<String, Value>,
    method: &str,
    view: &ToolView,
    call: &mut Option<ToolCall>,
) -> HttpResponse {
    let id = request_id_from_object(object);
    if request.protocol_version != Some(MODERN_PROTOCOL_VERSION) {
        return version_mismatch(
            id,
            "modern requests require the matching MCP-Protocol-Version",
        );
    }
    if request.mcp_method != Some(method) {
        return version_mismatch(id, "Mcp-Method does not match the JSON-RPC method");
    }

    let params = match object.get("params").and_then(Value::as_object) {
        Some(params) => params,
        None => return error(400, id, -32602, "modern params are required", None),
    };
    let meta = match params.get("_meta").and_then(Value::as_object) {
        Some(meta) => meta,
        None => return error(400, id, -32602, "modern params._meta is required", None),
    };
    // Unknown `_meta` keys are tolerated and ignored: the MCP spec reserves
    // `_meta` for client-defined extensions (`progressToken`, related-task
    // markers, vendor keys) and nothing in it is ever read as a tool argument.
    // Only the three keys this server defines are validated below.
    let meta_version = match meta.get(META_PROTOCOL_VERSION).and_then(Value::as_str) {
        Some(version) => version,
        None => {
            return error(
                400,
                id,
                -32602,
                "modern protocolVersion metadata is required",
                None,
            )
        }
    };
    if meta_version != MODERN_PROTOCOL_VERSION {
        if SUPPORTED_PROTOCOL_VERSIONS.contains(&meta_version) {
            return version_mismatch(id, "metadata and header protocol versions do not match");
        }
        return unsupported_version(id, Some(meta_version));
    }
    if !matches!(meta.get(META_CLIENT_CAPABILITIES), Some(Value::Object(_))) {
        return error(
            400,
            id,
            -32602,
            "modern clientCapabilities metadata is required",
            None,
        );
    }
    if let Some(client_info) = meta.get(META_CLIENT_INFO) {
        if !valid_implementation_info(client_info) {
            return error(400, id, -32602, "invalid modern clientInfo metadata", None);
        }
    }

    match method {
        "server/discover" if !has_only_keys(params, &["_meta"]) => {
            return error(
                400,
                id,
                -32602,
                "method params contain an unknown field",
                None,
            );
        }
        "tools/list" if !valid_list_params(params) => {
            return error(
                400,
                id,
                -32602,
                "method params contain an unknown field",
                None,
            );
        }
        "tools/call" if !valid_tool_call_params(params) => {
            return error(400, id, -32602, "invalid tools/call params", None);
        }
        _ => {}
    }

    let body_name = params.get("name").and_then(Value::as_str);
    if method == "tools/call" {
        let body_name = match body_name {
            Some(name) if !name.is_empty() && name.len() <= 128 => name,
            _ => return error(400, id, -32602, "tools/call name is required", None),
        };
        if request.mcp_name != Some(body_name) {
            return version_mismatch(id, "Mcp-Name does not match tools/call params.name");
        }
    } else if request.mcp_name.is_some() {
        return version_mismatch(id, "Mcp-Name is only valid for tools/call");
    }

    match method {
        "server/discover" => HttpResponse::json(
            200,
            success(
                id,
                serde_json::json!({
                    "protocolVersion": MODERN_PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": view.surface().server_info(),
                    "resultType": "server/discover",
                    "cache": {"ttlSeconds": 300, "scope": "private"}
                }),
            ),
        ),
        "tools/list" => HttpResponse::json(
            200,
            success(
                id,
                serde_json::json!({
                    "tools": view.listing(),
                    "resultType": "tools/list",
                    "cache": {"ttlSeconds": 0, "scope": "private"}
                }),
            ),
        ),
        "tools/call" => admit_tool_call(id, ToolEra::Modern, params, body_name, view, call),
        _ => error(400, id, -32601, "method not found", None),
    }
}

/// The one place a validated `tools/call` becomes an invocation.
///
/// A name the view cannot call and a name that does not exist take the same
/// exit, so `tools/call` never enumerates the catalog for a credential that was
/// not granted it.
fn admit_tool_call(
    id: Value,
    era: ToolEra,
    params: &serde_json::Map<String, Value>,
    body_name: Option<&str>,
    view: &ToolView,
    call: &mut Option<ToolCall>,
) -> HttpResponse {
    let Some(tool) = body_name.and_then(|name| view.callable(name)) else {
        return error(400, id, -32602, "unknown tool", None);
    };
    // An absent or `null` `arguments` is an empty object, so exactly one shape
    // reaches schema validation and every domain port. Nothing else in the
    // params (`_meta`, `task`) is ever forwarded.
    let arguments = match params.get("arguments") {
        Some(Value::Object(arguments)) => Value::Object(arguments.clone()),
        _ => Value::Object(serde_json::Map::new()),
    };
    // The published schema is enforced HERE, before the call becomes an
    // invocation — so an unknown field or an out-of-bounds number never reaches
    // a domain port, and `additionalProperties: false` means what it says.
    // The answer is byte-identical to the adapter's own invalid-arguments
    // failure (pinned by a test), so a caller cannot tell which layer refused.
    if let Err(failure) = tools::validate_arguments(tool, &arguments) {
        let (status, code, _) = failure.wire();
        return error(status, id, code, &failure.message(), failure.data());
    }
    *call = Some(ToolCall {
        id: id.clone(),
        era,
        tool,
        arguments,
    });
    error(400, id, -32602, "unknown tool", None)
}

/// The MCP result envelope for a tool that ran.
///
/// `structuredContent` is the machine half and the `content` text is the same
/// object rendered once — never a second, hand-written projection, so the two
/// halves cannot describe different outcomes.
pub fn tool_success(call: &ToolCall, structured: Value) -> HttpResponse {
    tool_result(call, structured, false)
}

/// The MCP result envelope for a tool that ran and **refused** (`isError: true`).
///
/// A tool-level refusal — "that channel is not one you can read" — is a result the
/// model reads and reacts to, not a protocol fault, so it travels as HTTP 200 with
/// the same two halves as a success (`content` text and `structuredContent`, one
/// object rendered twice). The Agent Port never uses this (its refusals are the
/// closed [`ToolFailure`] set); the human MCP does, because its refusals are the
/// REST row's own answers to the same person.
pub fn tool_error_result(call: &ToolCall, structured: Value) -> HttpResponse {
    tool_result(call, structured, true)
}

fn tool_result(call: &ToolCall, structured: Value, is_error: bool) -> HttpResponse {
    let text = serde_json::to_string(&structured).unwrap_or_else(|_| "{}".to_string());
    let mut result = serde_json::json!({
        "content": [{"type": "text", "text": text}],
        "structuredContent": structured,
        "isError": is_error
    });
    if call.era == ToolEra::Modern {
        if let Some(object) = result.as_object_mut() {
            object.insert("resultType".to_owned(), Value::String("tools/call".into()));
            object.insert(
                "cache".to_owned(),
                serde_json::json!({"ttlSeconds": 0, "scope": "private"}),
            );
        }
    }
    HttpResponse::json(200, success(call.id.clone(), result))
}

/// The JSON-RPC error envelope for a tool that refused.
///
/// Every failure is one of [`ToolFailure`]'s closed set, and each carries a fixed
/// message: a domain string here would leak the very existence facts the
/// fail-closed reads refuse to confirm. The one exception is
/// [`ToolFailure::InvalidArtifacts`] (ADR-0162 증보 5 C3), whose message and
/// `error.data` name an `artifacts` field and a closed rule from a static list —
/// still never a value the caller sent. [`ToolFailure::InvalidAssembleParams`]
/// (ADR-0218 G3.8) keeps the fixed message and adds `error.data {code, params}` with the
/// wrong parameters' names from [`ASSEMBLE_PARAMS`], again never a value.
pub fn tool_failure(call: &ToolCall, failure: ToolFailure) -> HttpResponse {
    let (status, code, _) = failure.wire();
    error(
        status,
        call.id.clone(),
        code,
        &failure.message(),
        failure.data(),
    )
}

fn dispatch_legacy(
    request: HttpRequest<'_>,
    object: &serde_json::Map<String, Value>,
    method: &str,
    view: &ToolView,
    call: &mut Option<ToolCall>,
) -> HttpResponse {
    let id = request_id_from_object(object);
    if modern_meta_version(object).is_some() {
        return version_mismatch(
            id,
            "modern protocol metadata is not valid in legacy requests",
        );
    }
    if method == "initialize" {
        if request.protocol_version.is_some()
            && request.protocol_version != Some(LEGACY_PROTOCOL_VERSION)
        {
            return version_mismatch(id, "initialize header and proposed version do not match");
        }
        if let Some(mirror) = request.mcp_method {
            if mirror != method {
                return version_mismatch(id, "Mcp-Method does not match the JSON-RPC method");
            }
        }
        if request.mcp_name.is_some() {
            return version_mismatch(id, "Mcp-Name is only valid for tools/call");
        }
        let params = match object.get("params").and_then(Value::as_object) {
            Some(params) => params,
            None => return error(400, id, -32602, "initialize params are required", None),
        };
        let proposed = match params.get("protocolVersion").and_then(Value::as_str) {
            Some(version) => version,
            None => {
                return error(
                    400,
                    id,
                    -32602,
                    "initialize protocolVersion is required",
                    None,
                )
            }
        };
        if proposed != LEGACY_PROTOCOL_VERSION {
            return if SUPPORTED_PROTOCOL_VERSIONS.contains(&proposed) {
                version_mismatch(id, "modern protocolVersion cannot use legacy initialize")
            } else {
                unsupported_version(id, Some(proposed))
            };
        }
        if !matches!(params.get("capabilities"), Some(Value::Object(_)))
            || !params
                .get("clientInfo")
                .is_some_and(valid_implementation_info)
            || !has_only_keys(
                params,
                &["protocolVersion", "capabilities", "clientInfo", "_meta"],
            )
            || !meta_is_object_if_present(params)
        {
            return error(
                400,
                id,
                -32602,
                "initialize capabilities and clientInfo are required",
                None,
            );
        }
        return HttpResponse::json(
            200,
            success(
                id,
                serde_json::json!({
                    "protocolVersion": LEGACY_PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": view.surface().server_info()
                }),
            ),
        );
    }

    if request.protocol_version != Some(LEGACY_PROTOCOL_VERSION) {
        return version_mismatch(id, "legacy follow-up requests require MCP-Protocol-Version");
    }
    if let Some(mirror) = request.mcp_method {
        if mirror != method {
            return version_mismatch(id, "Mcp-Method does not match the JSON-RPC method");
        }
    }
    let params = object.get("params");
    if let Some(params) = params {
        if !params.is_object() {
            return error(400, id, -32602, "params must be an object", None);
        }
    }

    if matches!(method, "notifications/initialized" | "ping") && !params_are_meta_only(params) {
        return error(400, id, -32602, "method params must be empty", None);
    }
    if method == "tools/list"
        && !params.is_none_or(|params| params.as_object().is_some_and(valid_list_params))
    {
        return error(400, id, -32602, "method params must be empty", None);
    }

    if method == "tools/call" {
        let params = match params.and_then(Value::as_object) {
            Some(params) if valid_tool_call_params(params) => params,
            _ => return error(400, id, -32602, "invalid tools/call params", None),
        };
        let body_name = params.get("name").and_then(Value::as_str);
        let body_name = match body_name {
            Some(name) if !name.is_empty() && name.len() <= 128 => name,
            _ => return error(400, id, -32602, "tools/call name is required", None),
        };
        if let Some(mirror) = request.mcp_name {
            if mirror != body_name {
                return version_mismatch(id, "Mcp-Name does not match tools/call params.name");
            }
        }
    } else if request.mcp_name.is_some() {
        return version_mismatch(id, "Mcp-Name is only valid for tools/call");
    }

    match method {
        "notifications/initialized" => {
            if object.contains_key("id") {
                error(400, id, -32600, "initialized must be a notification", None)
            } else {
                HttpResponse::empty(202)
            }
        }
        "ping" => HttpResponse::json(200, success(id, serde_json::json!({}))),
        "tools/list" => HttpResponse::json(
            200,
            success(id, serde_json::json!({"tools": view.listing()})),
        ),
        "tools/call" => match params.and_then(Value::as_object) {
            Some(params) => admit_tool_call(
                id,
                ToolEra::Legacy,
                params,
                params.get("name").and_then(Value::as_str),
                view,
                call,
            ),
            None => error(400, id, -32602, "invalid tools/call params", None),
        },
        _ => error(400, id, -32601, "method not found", None),
    }
}

fn success(id: Value, result: Value) -> Value {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(status: u16, id: Value, code: i64, message: &str, data: Option<Value>) -> HttpResponse {
    let mut detail = serde_json::json!({"code": code, "message": message});
    if let Some(data) = data {
        detail
            .as_object_mut()
            .expect("error detail is an object")
            .insert("data".to_owned(), data);
    }
    HttpResponse::json(
        status,
        serde_json::json!({"jsonrpc": "2.0", "id": id, "error": detail}),
    )
}

fn version_mismatch(id: Value, message: &str) -> HttpResponse {
    error(400, id, ERR_VERSION_MISMATCH, message, None)
}

fn unsupported_version(id: Value, _received: Option<&str>) -> HttpResponse {
    error(
        400,
        id,
        ERR_UNSUPPORTED_VERSION,
        "unsupported protocol version",
        Some(serde_json::json!({
            "supported": SUPPORTED_PROTOCOL_VERSIONS
        })),
    )
}

fn request_id(value: &Value) -> Value {
    value
        .as_object()
        .map(request_id_from_object)
        .unwrap_or(Value::Null)
}

fn request_id_from_object(object: &serde_json::Map<String, Value>) -> Value {
    match object.get("id") {
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 128 => {
            Value::String(value.clone())
        }
        Some(Value::Number(value)) => Value::Number(value.clone()),
        _ => Value::Null,
    }
}

fn valid_id_shape(id: Option<&Value>, method: &str) -> bool {
    match id {
        None => method == "notifications/initialized",
        Some(Value::String(value)) => !value.is_empty() && value.len() <= 128,
        Some(Value::Number(_)) => true,
        Some(Value::Null) => false,
        _ => false,
    }
}

fn modern_meta_version(object: &serde_json::Map<String, Value>) -> Option<&str> {
    object
        .get("params")?
        .as_object()?
        .get("_meta")?
        .as_object()?
        .get(META_PROTOCOL_VERSION)?
        .as_str()
}

fn valid_implementation_info(value: &Value) -> bool {
    let Some(info) = value.as_object() else {
        return false;
    };
    has_only_keys(info, &["name", "title", "version"])
        && matches!(info.get("name"), Some(Value::String(name)) if !name.is_empty() && name.len() <= 128)
        && matches!(info.get("version"), Some(Value::String(version)) if !version.is_empty() && version.len() <= 64)
        && !matches!(info.get("title"), Some(value) if !matches!(value, Value::String(title) if !title.is_empty() && title.len() <= 128))
}

fn has_only_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

/// `_meta` is the one MCP-reserved extension slot on every request; when it is
/// present it must be an object, and its contents are not interpreted here.
fn meta_is_object_if_present(params: &serde_json::Map<String, Value>) -> bool {
    params.get("_meta").is_none_or(Value::is_object)
}

/// Params for methods that take nothing but the optional `_meta` slot.
fn params_are_meta_only(params: Option<&Value>) -> bool {
    match params {
        None => true,
        Some(Value::Object(params)) => {
            has_only_keys(params, &["_meta"]) && meta_is_object_if_present(params)
        }
        Some(_) => false,
    }
}

/// `tools/list` params per MCP: optional `cursor` (a string) and `_meta`.
/// This server never issues a `nextCursor`, so a cursor is accepted and
/// ignored rather than failing a client that echoes the field.
fn valid_list_params(params: &serde_json::Map<String, Value>) -> bool {
    has_only_keys(params, &["_meta", "cursor"])
        && meta_is_object_if_present(params)
        && params.get("cursor").is_none_or(Value::is_string)
}

/// `tools/call` params per MCP 2025-06-18 / 2025-11-25: `name`, `arguments`
/// (object; `null` is read as absent), `_meta`, and the task-augmentation
/// marker `task` (object). `task` and `_meta` are accepted and ignored: this
/// server declares no tasks capability, so the call always runs synchronously.
/// Any other key is still refused.
fn valid_tool_call_params(params: &serde_json::Map<String, Value>) -> bool {
    has_only_keys(params, &["_meta", "name", "arguments", "task"])
        && meta_is_object_if_present(params)
        && params
            .get("arguments")
            .is_none_or(|value| value.is_object() || value.is_null())
        && params.get("task").is_none_or(Value::is_object)
}

fn is_json_content_type(content_type: Option<&str>) -> bool {
    let Some(content_type) = content_type else {
        return false;
    };
    let mut parts = content_type.split(';');
    if !parts
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(JSON_CONTENT_TYPE))
    {
        return false;
    }
    let mut saw_charset = false;
    for parameter in parts {
        let Some((name, value)) = parameter.trim().split_once('=') else {
            return false;
        };
        if !name.trim().eq_ignore_ascii_case("charset") || saw_charset {
            return false;
        }
        let value = value.trim();
        let value = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
            &value[1..value.len() - 1]
        } else if value.contains('"') {
            return false;
        } else {
            value
        };
        if !value.eq_ignore_ascii_case("utf-8") {
            return false;
        }
        saw_charset = true;
    }
    true
}

fn accepts_required_types(accept: Option<&str>) -> bool {
    let Some(accept) = accept else {
        return false;
    };
    let mut json = false;
    let mut sse = false;
    for item in accept.split(',') {
        let mut parts = item.split(';');
        let media = parts.next().unwrap_or_default().trim();
        let Some((media_type, media_subtype)) = media.split_once('/') else {
            return false;
        };
        if !valid_media_token(media_type) || !valid_media_token(media_subtype) {
            return false;
        }
        let mut quality = 1.0f32;
        let mut saw_quality = false;
        for parameter in parts {
            let Some((name, value)) = parameter.trim().split_once('=') else {
                return false;
            };
            if !name.trim().eq_ignore_ascii_case("q") || saw_quality {
                return false;
            }
            let value = value.trim();
            quality = match strict_quality(value) {
                Some(quality) => quality,
                None => return false,
            };
            saw_quality = true;
        }
        let enabled = quality > 0.0;
        json |= enabled && media.eq_ignore_ascii_case(REQUIRED_ACCEPT_JSON);
        sse |= enabled && media.eq_ignore_ascii_case(REQUIRED_ACCEPT_SSE);
    }
    json && sse
}

fn valid_media_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn strict_quality(value: &str) -> Option<f32> {
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() && fraction.len() <= 3 => {
            (whole, Some(fraction))
        }
        Some(_) => return None,
        None => (value, None),
    };
    if !matches!(whole, "0" | "1") {
        return None;
    }
    if let Some(fraction) = fraction {
        if !fraction.bytes().all(|byte| byte.is_ascii_digit())
            || (whole == "1" && !fraction.bytes().all(|byte| byte == b'0'))
        {
            return None;
        }
    }
    value.parse().ok()
}

/// JSON value that rejects duplicate object names at every nesting level.
/// `serde_json::Value` alone uses last-key-wins, which would make era-bearing
/// fields parser-dependent across proxies and adapters.
struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(UniqueValueVisitor)
    }
}

struct UniqueValueVisitor;

impl<'de> Visitor<'de> for UniqueValueVisitor {
    type Value = UniqueValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object names")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Number(value.into())))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Number(value.into())))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .map(UniqueValue)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<UniqueValue>()? {
            values.push(value.0);
        }
        Ok(UniqueValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = HashSet::new();
        let mut values = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate JSON object name"));
            }
            let value = map.next_value::<UniqueValue>()?;
            values.insert(key, value.0);
        }
        Ok(UniqueValue(Value::Object(values)))
    }
}

fn validate_bounds(root: &Value, bulk_limit: usize) -> Result<(), &'static str> {
    let mut stack = vec![(root, 1usize)];
    while let Some((value, depth)) = stack.pop() {
        if depth > MAX_JSON_DEPTH {
            return Err("JSON nesting exceeds the limit");
        }
        match value {
            Value::String(value) if value.len() > MAX_STRING_BYTES => {
                return Err("JSON string exceeds the limit")
            }
            Value::Array(values) => {
                if values.len() > MAX_COLLECTION_ITEMS {
                    return Err("JSON collection exceeds the limit");
                }
                stack.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(values) => {
                if values.len() > MAX_COLLECTION_ITEMS {
                    return Err("JSON collection exceeds the limit");
                }
                for (key, value) in values {
                    if key.len() > MAX_STRING_BYTES {
                        return Err("JSON string exceeds the limit");
                    }
                    // The single bulk exception (see `MAX_BULK_BASE64_BYTES`).
                    if key == BULK_BASE64_KEY {
                        if let Value::String(text) = value {
                            if text.len() > bulk_limit {
                                return Err("JSON string exceeds the limit");
                            }
                            continue;
                        }
                    }
                    stack.push((value, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request<'a>(
        protocol: Option<&'a str>,
        method: Option<&'a str>,
        body: &'a [u8],
    ) -> HttpRequest<'a> {
        HttpRequest {
            content_type: Some(JSON_CONTENT_TYPE),
            accept: Some("application/json, text/event-stream"),
            protocol_version: protocol,
            mcp_method: method,
            mcp_name: None,
            body,
        }
    }

    /// A `tools/call` of `oort_action_propose` as the wire carries it (legacy shape: the
    /// size gate is era-independent and runs first).
    fn propose_body(action_id: &str, args: serde_json::Value, rationale: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": TOOL_ACTION_PROPOSE, "arguments": {
                "handle": "h", "actionId": action_id, "args": args, "rationale": rationale}}
        }))
        .unwrap()
    }

    fn candidate(base64_len: usize) -> serde_json::Value {
        serde_json::json!({
            "name": "happy", "displayName": "happy", "tags": [], "subjectMemberId": null,
            "image": {"source": "generated", "mime": "image/png",
                      "dataBase64": "A".repeat(base64_len), "prompt": "p"}
        })
    }

    fn verdict(body: &[u8]) -> (u16, String) {
        let response = dispatch(request(Some(LEGACY_PROTOCOL_VERSION), None, body));
        let text = String::from_utf8_lossy(&response.body.unwrap_or_default()).to_string();
        (response.status, text)
    }

    /// ADR-0218 appendix A: `expression.create` alone may carry four 1 MiB candidates in a
    /// request of up to 6 MiB. Every bound that makes the budget one action's, not a wider
    /// limit, is a red test below if its line goes.
    #[test]
    fn only_an_expression_create_proposal_may_exceed_the_standard_body_limit() {
        // Four candidates at the per-candidate maximum: past 64 KiB, within 6 MiB, accepted
        // by the size gate (the empty view then refuses the tool, which is not a size error).
        let big = propose_body(
            EXPRESSION_CREATE_ACTION_ID,
            serde_json::json!({"candidates": [candidate(MAX_EXPRESSION_BASE64_BYTES),
                candidate(MAX_EXPRESSION_BASE64_BYTES), candidate(MAX_EXPRESSION_BASE64_BYTES),
                candidate(MAX_EXPRESSION_BASE64_BYTES)]}),
            "r",
        );
        assert!(big.len() > MAX_BODY_BYTES && big.len() <= MAX_EXPRESSION_REQUEST_BYTES);
        let (status, text) = verdict(&big);
        assert_ne!(status, 413, "{text}");
        assert!(!text.contains("exceeds the limit"), "{text}");

        // One base64 character past a candidate's budget: refused.
        let over = propose_body(
            EXPRESSION_CREATE_ACTION_ID,
            serde_json::json!({"candidates": [candidate(MAX_EXPRESSION_BASE64_BYTES + 1)]}),
            "r",
        );
        let (status, text) = verdict(&over);
        assert_eq!(
            (status, text.contains("exceeds the limit")),
            (400, true),
            "{text}"
        );

        // Past 6 MiB in total: refused before a byte is parsed.
        let mut too_big = propose_body(EXPRESSION_CREATE_ACTION_ID, serde_json::json!({}), "r");
        too_big.extend(vec![b' '; MAX_EXPRESSION_REQUEST_BYTES]);
        assert_eq!(verdict(&too_big).0, 413);

        // The same bytes dressed as ANOTHER action (the id is only mentioned), another tool, or
        // `member.avatar.set`'s own 1 MiB base64: all refused at the standard limits.
        let other_action = propose_body(
            "member.avatar.set",
            serde_json::json!({"avatar": {"source": "generated",
                "dataBase64": "A".repeat(MAX_EXPRESSION_BASE64_BYTES)}}),
            "expression.create",
        );
        assert_eq!(verdict(&other_action).0, 413);
        let mentioned = propose_body(
            "invite.create",
            serde_json::json!({}),
            &format!("expression.create {}", "x".repeat(MAX_BODY_BYTES)),
        );
        assert_eq!(verdict(&mentioned).0, 413);
        let other_tool = serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": TOOL_MESSAGE_POST, "arguments": {
                "actionId": EXPRESSION_CREATE_ACTION_ID,
                "pad": "x".repeat(MAX_BODY_BYTES)}}
        }))
        .unwrap();
        assert_eq!(verdict(&other_tool).0, 413);
        // ...and the avatar's 58,700-character bulk bound is untouched by the new budget.
        let avatar_over = propose_body(
            "member.avatar.set",
            serde_json::json!({"avatar": {"source": "generated",
                "dataBase64": "A".repeat(MAX_BULK_BASE64_BYTES + 1)}}),
            "r",
        );
        assert_eq!(verdict(&avatar_over).0, 400);
        // A string that is not a base64 field keeps the 8 KiB bound even under the budget.
        let long_prompt_key = propose_body(
            EXPRESSION_CREATE_ACTION_ID,
            serde_json::json!({"candidates": [candidate(8)]}),
            &"r".repeat(MAX_STRING_BYTES + 1),
        );
        assert_eq!(verdict(&long_prompt_key).0, 400);
    }

    /// A `tools/call` of `oort_expression_assemble` carrying `base64_len` characters of picture.
    fn assemble_body(base64_len: usize, prompt: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": TOOL_EXPRESSION_ASSEMBLE, "arguments": {
                "handle": "h",
                "source": {"from": "base64", "mime": "image/png",
                           "dataBase64": "A".repeat(base64_len)},
                "motion": {"kind": "preset", "presets": ["bounce"]},
                "prompt": prompt}}
        }))
        .unwrap()
    }

    /// ADR-0218 G3.2 / G3.7 (a): `oort_expression_assemble` is the second call that may carry
    /// a picture past 64 KiB — one base64 string of up to 5,592,408 characters (4 MiB decoded)
    /// inside the same 6 MiB request budget. Every bound that makes it one tool's budget and
    /// not a wider limit is a red test below if its line goes.
    #[test]
    fn only_an_assemble_call_may_carry_a_four_mib_picture_past_the_standard_body_limit() {
        // The largest picture: past 64 KiB, within 6 MiB, accepted by the size gate.
        // The base64 of exactly 4 MiB (padding included), not a round number picked by feel.
        assert_eq!(
            MAX_ASSEMBLE_BASE64_BYTES,
            (4 * 1024 * 1024usize).div_ceil(3) * 4
        );
        let big = assemble_body(MAX_ASSEMBLE_BASE64_BYTES, "p");
        assert!(big.len() > MAX_BODY_BYTES && big.len() <= MAX_EXPRESSION_REQUEST_BYTES);
        let (status, text) = verdict(&big);
        assert_ne!(status, 413, "{text}");
        assert!(!text.contains("exceeds the limit"), "{text}");

        // One character past the picture's budget: refused by the bulk bound.
        let (status, text) = verdict(&assemble_body(MAX_ASSEMBLE_BASE64_BYTES + 1, "p"));
        assert_eq!(
            (status, text.contains("exceeds the limit")),
            (400, true),
            "{text}"
        );

        // Past 6 MiB in total: refused before a byte is parsed.
        let mut too_big = assemble_body(8, "p");
        too_big.extend(vec![b' '; MAX_EXPRESSION_REQUEST_BYTES]);
        assert_eq!(verdict(&too_big).0, 413);

        // The same picture under another tool, or under the avatar's own bulk key of another
        // action, never gets this budget; neither does an assemble call mentioned in passing.
        let other_tool = serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": TOOL_MESSAGE_POST, "arguments": {
                "handle": TOOL_EXPRESSION_ASSEMBLE,
                "source": {"dataBase64": "A".repeat(MAX_ASSEMBLE_BASE64_BYTES)}}}
        }))
        .unwrap();
        assert_eq!(verdict(&other_tool).0, 413);
        let avatar_sized = propose_body(
            "member.avatar.set",
            serde_json::json!({"avatar": {"source": "generated",
                "dataBase64": "A".repeat(MAX_BULK_BASE64_BYTES + 1)}}),
            TOOL_EXPRESSION_ASSEMBLE,
        );
        assert_eq!(verdict(&avatar_sized).0, 400);
        let mentioned = propose_body(
            "invite.create",
            serde_json::json!({}),
            &format!("{TOOL_EXPRESSION_ASSEMBLE} {}", "x".repeat(MAX_BODY_BYTES)),
        );
        assert_eq!(verdict(&mentioned).0, 413);

        // A string that is not the picture keeps the 8 KiB bound even under the budget.
        let (status, _) = verdict(&assemble_body(8, &"p".repeat(MAX_STRING_BYTES + 1)));
        assert_eq!(status, 400);

        // The new budget does not widen expression.create's per-candidate bound, and that
        // one does not widen this one.
        let create_over = propose_body(
            EXPRESSION_CREATE_ACTION_ID,
            serde_json::json!({"candidates": [candidate(MAX_EXPRESSION_BASE64_BYTES + 1)]}),
            "r",
        );
        assert_eq!(verdict(&create_over).0, 400);
        let create_with_assemble_sized_picture = propose_body(
            EXPRESSION_CREATE_ACTION_ID,
            serde_json::json!({"candidates": [candidate(MAX_ASSEMBLE_BASE64_BYTES)]}),
            "r",
        );
        assert_eq!(verdict(&create_with_assemble_sized_picture).0, 400);
        // ...and a short assemble call needs no budget at all.
        let (status, text) = verdict(&assemble_body(8, "p"));
        assert_ne!(status, 413, "{text}");
    }

    #[test]
    fn modern_discover_and_list_are_foundation_requests() {
        for (method, expected) in [
            ("server/discover", FoundationRequest::ModernDiscover),
            ("tools/list", FoundationRequest::ModernToolsList),
        ] {
            let body = serde_json::to_vec(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": {"_meta": {
                    META_PROTOCOL_VERSION: MODERN_PROTOCOL_VERSION,
                    META_CLIENT_CAPABILITIES: {},
                    META_CLIENT_INFO: {"name": "fixture", "version": "1"}
                }}
            }))
            .unwrap();
            assert_eq!(
                classify_foundation_request(request(
                    Some(MODERN_PROTOCOL_VERSION),
                    Some(method),
                    &body
                )),
                Some(expected)
            );
        }
    }

    #[test]
    fn legacy_initialize_and_list_are_foundation_requests() {
        let initialize = serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "fixture", "version": "1"}
            }
        }))
        .unwrap();
        assert_eq!(
            classify_foundation_request(request(None, None, &initialize)),
            Some(FoundationRequest::LegacyInitialize)
        );

        let list = br#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
        assert_eq!(
            classify_foundation_request(request(
                Some(LEGACY_PROTOCOL_VERSION),
                Some("tools/list"),
                list
            )),
            Some(FoundationRequest::LegacyToolsList)
        );
    }

    #[test]
    fn ping_notifications_and_invalid_requests_never_advance_pairing() {
        let ping = br#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#;
        assert_eq!(
            classify_foundation_request(request(Some(LEGACY_PROTOCOL_VERSION), Some("ping"), ping)),
            None
        );
        let initialized = br#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#;
        assert_eq!(
            classify_foundation_request(request(
                Some(LEGACY_PROTOCOL_VERSION),
                Some("notifications/initialized"),
                initialized
            )),
            None
        );
        assert_eq!(
            classify_foundation_request(request(
                Some(MODERN_PROTOCOL_VERSION),
                Some("server/discover"),
                br#"{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}"#
            )),
            None
        );
    }

    #[test]
    fn bulk_base64_is_allowed_only_under_its_own_key_and_up_to_its_own_ceiling() {
        let big = |len: usize| "A".repeat(len);
        let ok =
            serde_json::json!({"args": {"avatar": {"dataBase64": big(MAX_BULK_BASE64_BYTES)}}});
        assert!(validate_bounds(&ok, MAX_BULK_BASE64_BYTES).is_ok());
        let over = serde_json::json!({"dataBase64": big(MAX_BULK_BASE64_BYTES + 1)});
        assert_eq!(
            validate_bounds(&over, MAX_BULK_BASE64_BYTES),
            Err("JSON string exceeds the limit")
        );
        // Any other key keeps the 8 KiB rule — including a near miss in spelling.
        for key in ["data", "database64", "dataBase64 ", "body"] {
            let other = serde_json::json!({ key: big(MAX_STRING_BYTES + 1) });
            assert_eq!(
                validate_bounds(&other, MAX_BULK_BASE64_BYTES),
                Err("JSON string exceeds the limit"),
                "{key}"
            );
        }
        // A string of the allowed size is fine; one byte over the ordinary limit under
        // another key is not, and the exception does not extend to an array of strings.
        let list = serde_json::json!({"dataBase64": [big(MAX_STRING_BYTES + 1)]});
        assert_eq!(
            validate_bounds(&list, MAX_BULK_BASE64_BYTES),
            Err("JSON string exceeds the limit")
        );
    }
}
