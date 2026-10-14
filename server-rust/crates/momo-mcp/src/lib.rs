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
    validate_arguments, ToolCapability, ToolDescriptor, ToolFailure, ToolView, MAX_ARTIFACT_COUNT,
    MAX_STAGE_BYTES, TOOL_ACTION_CLAIM_SECRET, TOOL_ACTION_PROPOSE, TOOL_CARD_SUGGEST,
    TOOL_CATALOG, TOOL_CONVERSATION_READ, TOOL_INBOX_READ, TOOL_JOBS_CLAIM, TOOL_JOB_RELEASE,
    TOOL_JOB_RENEW, TOOL_MESSAGE_POST, TOOL_PING, TOOL_RUN_COMPLETE, TOOL_RUN_EVENT,
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

fn dispatch_inner(
    request: HttpRequest<'_>,
    view: &ToolView,
    call: &mut Option<ToolCall>,
) -> HttpResponse {
    if request.body.len() > MAX_BODY_BYTES {
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
    if let Err(message) = validate_bounds(&value) {
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
                    "serverInfo": server_info(),
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
        let (status, code, message) = failure.wire();
        return error(status, id, code, message, None);
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
    let text = serde_json::to_string(&structured).unwrap_or_else(|_| "{}".to_string());
    let mut result = serde_json::json!({
        "content": [{"type": "text", "text": text}],
        "structuredContent": structured,
        "isError": false
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
/// Every failure is one of [`ToolFailure`]'s five, and each carries a fixed
/// message: a domain string here would leak the very existence facts the
/// fail-closed reads refuse to confirm.
pub fn tool_failure(call: &ToolCall, failure: ToolFailure) -> HttpResponse {
    let (status, code, message) = failure.wire();
    error(status, call.id.clone(), code, message, None)
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
                    "serverInfo": server_info()
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

fn server_info() -> Value {
    serde_json::json!({
        "name": "oort-agent-port",
        "title": "oort Agent Port",
        "version": env!("CARGO_PKG_VERSION")
    })
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

fn validate_bounds(root: &Value) -> Result<(), &'static str> {
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
                            if text.len() > MAX_BULK_BASE64_BYTES {
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
        assert!(validate_bounds(&ok).is_ok());
        let over = serde_json::json!({"dataBase64": big(MAX_BULK_BASE64_BYTES + 1)});
        assert_eq!(validate_bounds(&over), Err("JSON string exceeds the limit"));
        // Any other key keeps the 8 KiB rule — including a near miss in spelling.
        for key in ["data", "database64", "dataBase64 ", "body"] {
            let other = serde_json::json!({ key: big(MAX_STRING_BYTES + 1) });
            assert_eq!(
                validate_bounds(&other),
                Err("JSON string exceeds the limit"),
                "{key}"
            );
        }
        // A string of the allowed size is fine; one byte over the ordinary limit under
        // another key is not, and the exception does not extend to an array of strings.
        let list = serde_json::json!({"dataBase64": [big(MAX_STRING_BYTES + 1)]});
        assert_eq!(validate_bounds(&list), Err("JSON string exceeds the limit"));
    }
}
