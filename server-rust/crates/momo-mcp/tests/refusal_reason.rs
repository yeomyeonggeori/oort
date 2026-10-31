//! ADR-0200 증보 4 (#4618) — a refusal's **reason** is a closed token, and every sentence the
//! dispatcher can say has one.
//!
//! One JSON-RPC code covers many causes (`-32020` alone is eight header/metadata mismatches), and
//! which one a runtime hit is the diagnosis. The server's own fixed sentence is looked up by exact
//! match in `momo_mcp::REFUSAL_REASONS`; only the table's token ever leaves.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `every_reachable_refusal_gets_its_own_token` | ~40 real malformed requests, driven through the real dispatcher, each answer with the documented status, code and token | a sentence loses its row, two causes are merged, or a token is renamed |
//! | `every_tool_failure_has_a_token` | all ten `ToolFailure` variants, through `tool_failure`, map to a token that is not `other` | a new failure variant ships without a row |
//! | `every_sentence_in_the_dispatcher_has_a_row` | the string literals in `src/lib.rs` passed to `error(` / `version_mismatch(` / `Err(\"JSON …\")` are all keys of the table (≥ 35 found, so the scan cannot pass by finding nothing) | a sentence is added to the dispatcher without deciding its token |
//! | `a_sentence_the_server_does_not_own_is_other` | any `error.message` that is not an exact table key is `other`, whatever it says; a success has no reason | the lookup becomes a prefix/contains match, or copies text |
//! | `the_token_vocabulary_is_closed_and_small` | tokens are short lowercase snake_case and few | a token starts carrying a value |

use momo_mcp::{
    dispatch, dispatch_with_tools, reason_of_sentence, refusal_reason, tool_failure, ArtifactRule,
    ArtifactViolation, AssembleParams, HttpRequest, HttpResponse, Outcome, ToolCall,
    ToolCapability, ToolEra, ToolFailure, ToolView, JSON_CONTENT_TYPE, LEGACY_PROTOCOL_VERSION,
    MAX_BODY_BYTES, MODERN_PROTOCOL_VERSION, REASON_OTHER, REASON_TOOL_ARTIFACTS, REFUSAL_REASONS,
    TOOL_CATALOG, TOOL_INBOX_READ,
};
use serde_json::{json, Value};

const ACCEPT: &str = "application/json, text/event-stream";

/// One HTTP-level request to the dispatcher. Defaults are a well-formed transport; each case
/// overrides exactly what it breaks.
#[derive(Clone)]
struct Req {
    content_type: Option<&'static str>,
    accept: Option<&'static str>,
    version: Option<&'static str>,
    mcp_method: Option<&'static str>,
    mcp_name: Option<&'static str>,
    body: Vec<u8>,
}

fn req(body: &Value) -> Req {
    Req {
        content_type: Some(JSON_CONTENT_TYPE),
        accept: Some(ACCEPT),
        version: None,
        mcp_method: None,
        mcp_name: None,
        body: serde_json::to_vec(body).unwrap(),
    }
}

fn raw(body: &[u8]) -> Req {
    Req {
        body: body.to_vec(),
        ..req(&json!({}))
    }
}

fn run(request: &Req, view: &ToolView) -> HttpResponse {
    let http = HttpRequest {
        content_type: request.content_type,
        accept: request.accept,
        protocol_version: request.version,
        mcp_method: request.mcp_method,
        mcp_name: request.mcp_name,
        body: &request.body,
    };
    match dispatch_with_tools(http, view) {
        Outcome::Response(response) => response,
        Outcome::Tool(call) => panic!("a refusal case ran a tool: {}", call.tool.name),
    }
}

fn modern_meta(version: &str) -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {}
    })
}

/// A modern request body with `extra` merged into `params`.
fn modern(method: &str, extra: Value) -> Value {
    let mut params = json!({"_meta": modern_meta(MODERN_PROTOCOL_VERSION)});
    for (key, value) in extra.as_object().unwrap() {
        params
            .as_object_mut()
            .unwrap()
            .insert(key.clone(), value.clone());
    }
    json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
}

fn modern_req(method: &str, extra: Value) -> Req {
    Req {
        version: Some(MODERN_PROTOCOL_VERSION),
        mcp_method: Some(match method {
            "tools/list" => "tools/list",
            "tools/call" => "tools/call",
            "server/discover" => "server/discover",
            _ => "tools/list",
        }),
        ..req(&modern(method, extra))
    }
}

fn legacy_req(body: &Value) -> Req {
    Req {
        version: Some(LEGACY_PROTOCOL_VERSION),
        ..req(body)
    }
}

fn scopes(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

#[test]
fn every_reachable_refusal_gets_its_own_token() {
    let empty = ToolView::empty();
    let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
    let long_string = json!({"jsonrpc":"2.0","id":1,"method":"ping",
                             "params":{"x":"A".repeat(9 * 1024)}});
    let many_items = json!({"jsonrpc":"2.0","id":1,"method":"ping",
                            "params":{"x":(0..300).collect::<Vec<_>>()}});
    let oversize = vec![b' '; MAX_BODY_BYTES + 1];

    // (what is wrong, request, expected HTTP status, expected JSON-RPC code, expected token)
    let cases: Vec<(&str, Req, u16, i64, &str)> = vec![
        // ---- the transport ----
        ("body over the ceiling", raw(&oversize), 413, -32600, "body_too_large"),
        (
            "no content type",
            Req { content_type: None, ..req(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})) },
            415, -32600, "content_type",
        ),
        (
            "wrong content type",
            Req { content_type: Some("text/plain"), ..req(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})) },
            415, -32600, "content_type",
        ),
        (
            "accept without the event stream",
            Req { accept: Some("application/json"), ..req(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})) },
            415, -32600, "accept",
        ),
        (
            "no accept",
            Req { accept: None, ..req(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})) },
            415, -32600, "accept",
        ),
        ("not json", raw(b"not json"), 400, -32700, "parse_error"),
        (
            "a raw newline inside a string (shell interpolation)",
            raw(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{\"cursor\":\"a\nb\"}}"),
            400, -32700, "parse_error",
        ),
        ("nesting too deep", raw(deep.as_bytes()), 400, -32600, "json_limits"),
        ("a string over 8 KiB", req(&long_string), 400, -32600, "json_limits"),
        ("a collection over 256 items", req(&many_items), 400, -32600, "json_limits"),
        // ---- the JSON-RPC envelope ----
        ("an array instead of an object", raw(b"[1]"), 400, -32600, "request_shape"),
        (
            "a batch",
            req(&json!([{"jsonrpc":"2.0","id":1,"method":"ping"}])),
            400, -32600, "request_shape",
        ),
        (
            "an unknown top-level field",
            req(&json!({"jsonrpc":"2.0","id":1,"method":"ping","extra":1})),
            400, -32600, "request_shape",
        ),
        (
            "jsonrpc 1.0",
            req(&json!({"jsonrpc":"1.0","id":1,"method":"ping"})),
            400, -32600, "request_shape",
        ),
        ("no method", req(&json!({"jsonrpc":"2.0","id":1})), 400, -32600, "request_shape"),
        (
            "an empty method",
            req(&json!({"jsonrpc":"2.0","id":1,"method":""})),
            400, -32600, "request_shape",
        ),
        (
            "a null id",
            req(&json!({"jsonrpc":"2.0","id":null,"method":"ping"})),
            400, -32600, "request_shape",
        ),
        (
            "params that is not an object",
            req(&json!({"jsonrpc":"2.0","id":1,"method":"ping","params":5})),
            400, -32602, "request_shape",
        ),
        // ---- the protocol era, and whether headers and body agree ----
        (
            "a protocol version the server does not speak",
            Req { version: Some("2025-06-18"), ..req(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})) },
            400, -32022, "version_unsupported",
        ),
        (
            "no protocol header and no metadata on a follow-up",
            req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})),
            400, -32022, "version_unsupported",
        ),
        (
            "modern metadata with no protocol header",
            Req { mcp_method: Some("tools/list"), ..req(&modern("tools/list", json!({}))) },
            400, -32020, "version_header",
        ),
        (
            "the modern header over legacy metadata",
            Req {
                version: Some(MODERN_PROTOCOL_VERSION),
                mcp_method: Some("tools/list"),
                ..req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list",
                              "params":{"_meta": modern_meta(LEGACY_PROTOCOL_VERSION)}}))
            },
            400, -32020, "version_mismatch",
        ),
        (
            "legacy version named in modern metadata, no header",
            req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list",
                        "params":{"_meta": modern_meta(LEGACY_PROTOCOL_VERSION)}})),
            400, -32020, "version_mismatch",
        ),
        (
            "modern metadata under the legacy header",
            legacy_req(&modern("tools/list", json!({}))),
            400, -32020, "version_mismatch",
        ),
        (
            "a modern protocolVersion proposed to the legacy initialize",
            legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"initialize",
                               "params":{"protocolVersion": MODERN_PROTOCOL_VERSION,
                                         "capabilities":{},
                                         "clientInfo":{"name":"t","version":"1"}}})),
            400, -32020, "version_mismatch",
        ),
        (
            "Mcp-Method header disagrees with the body",
            Req { mcp_method: Some("tools/call"), ..modern_req("tools/list", json!({})) },
            400, -32020, "mcp_method_header",
        ),
        (
            "Mcp-Name header disagrees with params.name",
            Req {
                mcp_name: Some("oort_ping"),
                ..modern_req("tools/call", json!({"name": TOOL_INBOX_READ}))
            },
            400, -32020, "mcp_name_header",
        ),
        (
            "Mcp-Name on a method that is not tools/call",
            Req { mcp_name: Some("oort_ping"), ..modern_req("tools/list", json!({})) },
            400, -32020, "mcp_name_header",
        ),
        // ---- what a modern request must carry ----
        (
            "a modern request with no params at all",
            Req {
                version: Some(MODERN_PROTOCOL_VERSION),
                mcp_method: Some("tools/list"),
                ..req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            },
            400, -32602, "modern_meta",
        ),
        (
            "modern params with no _meta",
            Req {
                version: Some(MODERN_PROTOCOL_VERSION),
                mcp_method: Some("tools/list"),
                ..req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}))
            },
            400, -32602, "modern_meta",
        ),
        (
            "modern _meta with no protocolVersion",
            Req {
                version: Some(MODERN_PROTOCOL_VERSION),
                mcp_method: Some("tools/list"),
                ..req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list",
                              "params":{"_meta":{"io.modelcontextprotocol/clientCapabilities":{}}}}))
            },
            400, -32602, "modern_meta",
        ),
        (
            "modern _meta with no clientCapabilities",
            Req {
                version: Some(MODERN_PROTOCOL_VERSION),
                mcp_method: Some("tools/list"),
                ..req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list",
                              "params":{"_meta":{"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION}}}))
            },
            400, -32602, "modern_meta",
        ),
        (
            "modern clientInfo that is not an object",
            Req {
                version: Some(MODERN_PROTOCOL_VERSION),
                mcp_method: Some("tools/list"),
                ..req(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list",
                              "params":{"_meta":{
                                  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
                                  "io.modelcontextprotocol/clientCapabilities": {},
                                  "io.modelcontextprotocol/clientInfo": 5}}}))
            },
            400, -32602, "modern_meta",
        ),
        // ---- the legacy handshake ----
        (
            "initialize with no params",
            legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"})),
            400, -32602, "initialize_params",
        ),
        (
            "initialize with no protocolVersion",
            legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})),
            400, -32602, "initialize_params",
        ),
        (
            "initialize with no clientInfo",
            legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"initialize",
                               "params":{"protocolVersion": LEGACY_PROTOCOL_VERSION}})),
            400, -32602, "initialize_params",
        ),
        (
            "notifications/initialized sent as a request with an id",
            legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"notifications/initialized"})),
            400, -32600, "initialized_has_id",
        ),
        // ---- the method and its params ----
        (
            "tools/list with a param it does not take",
            modern_req("tools/list", json!({"bogus": 1})),
            400, -32602, "method_params",
        ),
        (
            "ping with params",
            legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":1}})),
            400, -32602, "method_params",
        ),
        (
            "tools/call with a param it does not take",
            Req {
                mcp_name: Some("oort_ping"),
                ..modern_req("tools/call", json!({"name":"oort_ping","bogus":1}))
            },
            400, -32602, "tools_call_params",
        ),
        (
            "tools/call with an empty name",
            Req { mcp_name: Some(""), ..modern_req("tools/call", json!({"name":""})) },
            400, -32602, "tools_call_params",
        ),
        (
            "a method the server does not have",
            legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"resources/list"})),
            400, -32601, "method_not_found",
        ),
        // ---- the tool ----
        (
            "a real tool the view does not offer",
            Req {
                mcp_name: Some("oort_inbox_read"),
                ..modern_req("tools/call", json!({"name": TOOL_INBOX_READ, "arguments": {}}))
            },
            400, -32602, "unknown_tool",
        ),
    ];

    assert!(cases.len() >= 40, "{} cases", cases.len());
    let mut seen_tokens = std::collections::BTreeSet::new();
    for (what, request, status, rpc, token) in &cases {
        let response = run(request, &empty);
        let body = response.body.as_deref();
        assert_eq!(response.status, *status, "{what}");
        assert_eq!(
            momo_mcp::response_rpc_code(body),
            Some(*rpc),
            "{what}: {}",
            String::from_utf8_lossy(body.unwrap_or_default())
        );
        assert_eq!(
            refusal_reason(body),
            Some(*token),
            "{what}: {}",
            String::from_utf8_lossy(body.unwrap_or_default())
        );
        seen_tokens.insert(*token);
    }

    // The tool-level refusals need a view that offers the tool.
    let all = scopes(&[
        "agent:port:connect",
        "agent:inbox:read",
        "agent:runs:callback",
        "agent:jobs:read",
    ]);
    let view = ToolView::intersect(&all, &all, ToolCapability::FULL);
    let wrong_type = Req {
        mcp_name: Some("oort_inbox_read"),
        ..modern_req(
            "tools/call",
            json!({"name": TOOL_INBOX_READ, "arguments": {"cursor": 5}}),
        )
    };
    let response = run(&wrong_type, &view);
    assert_eq!(response.status, 400);
    assert_eq!(
        refusal_reason(response.body.as_deref()),
        Some("tool_arguments")
    );
    let bad_artifacts = Req {
        mcp_name: Some("oort_run_complete"),
        ..modern_req(
            "tools/call",
            json!({"name": "oort_run_complete",
                   "arguments": {"leaseHandle": "x", "status": "succeeded",
                                 "artifacts": {"resultKind": "nope"}}}),
        )
    };
    let response = run(&bad_artifacts, &view);
    assert_eq!(response.status, 400);
    assert_eq!(
        refusal_reason(response.body.as_deref()),
        Some(REASON_TOOL_ARTIFACTS),
        "{}",
        String::from_utf8_lossy(response.body.as_deref().unwrap_or_default())
    );
    seen_tokens.insert("tool_arguments");
    seen_tokens.insert(REASON_TOOL_ARTIFACTS);

    // A success has no reason.
    let ok = run(
        &legacy_req(&json!({"jsonrpc":"2.0","id":1,"method":"ping"})),
        &empty,
    );
    assert_eq!(ok.status, 200);
    assert_eq!(refusal_reason(ok.body.as_deref()), None);

    // Every protocol-level token in the table was exercised by a real request above (the two
    // unreachable defensive sentences share their token with a reachable one).
    let table_tokens: std::collections::BTreeSet<&str> =
        REFUSAL_REASONS.iter().map(|(_, token)| *token).collect();
    for token in &table_tokens {
        let transport_adapter_only = ["transport_headers", "rate_limited"].contains(token);
        let tool_failure_token = token.starts_with("tool_") && *token != "tool_arguments";
        if transport_adapter_only || tool_failure_token {
            continue; // the adapter and `every_tool_failure_has_a_token` own these
        }
        assert!(
            seen_tokens.contains(token),
            "table token {token:?} was never produced by a real request"
        );
    }
    // and the dispatcher never answered with `other`.
    assert!(!seen_tokens.contains(REASON_OTHER));
}

fn some_call() -> ToolCall {
    ToolCall {
        id: json!(1),
        era: ToolEra::Modern,
        tool: &TOOL_CATALOG[0],
        arguments: json!({}),
    }
}

#[test]
fn every_tool_failure_has_a_token() {
    let call = some_call();
    // A match with no wildcard: a new variant stops this file compiling until it is listed.
    fn expected(failure: ToolFailure) -> &'static str {
        match failure {
            // The fixed sentence stays, so the token is the plain arguments one: the names it
            // carries travel in `error.data`, not in the sentence.
            ToolFailure::InvalidArguments | ToolFailure::InvalidAssembleParams(_) => {
                "tool_arguments"
            }
            ToolFailure::InvalidArtifacts(_) => REASON_TOOL_ARTIFACTS,
            ToolFailure::NotAuthorized | ToolFailure::HandleRefused => "tool_not_authorized",
            ToolFailure::Unavailable => "tool_unavailable",
            ToolFailure::Conflict => "tool_conflict",
            ToolFailure::AlreadyClaimed => "tool_already_claimed",
            ToolFailure::ClaimExpired => "tool_claim_expired",
            ToolFailure::Internal => "tool_internal",
        }
    }
    let variants = [
        ToolFailure::InvalidArguments,
        ToolFailure::InvalidArtifacts(ArtifactViolation {
            field: "artifacts.resultKind",
            rule: ArtifactRule::Enum,
            allowed: &[],
            requires: None,
            hint: "must be one of the closed values",
        }),
        ToolFailure::InvalidAssembleParams(
            AssembleParams::from_names(["presets"]).expect("a closed name"),
        ),
        ToolFailure::NotAuthorized,
        ToolFailure::HandleRefused,
        ToolFailure::Unavailable,
        ToolFailure::Conflict,
        ToolFailure::AlreadyClaimed,
        ToolFailure::ClaimExpired,
        ToolFailure::Internal,
    ];
    for failure in variants {
        let response = tool_failure(&call, failure);
        assert_eq!(
            refusal_reason(response.body.as_deref()),
            Some(expected(failure)),
            "{failure:?}"
        );
        assert_ne!(expected(failure), REASON_OTHER);
    }
}

/// The string literals passed as argument `index` (0-based) of every call to `callee(` in
/// `source`, when that argument is **only** a string literal.
fn literal_args(source: &str, callee: &str, index: usize) -> Vec<String> {
    let needle = format!("{callee}(");
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = source[from..].find(&needle) {
        let start = from + offset;
        from = start + needle.len();
        let before = &source[..start];
        // A whole identifier, and not the definition (`fn callee(`).
        if before
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
            || before.trim_end().ends_with("fn")
        {
            continue;
        }
        let (mut depth, mut arg) = (0i32, 0usize);
        let (mut in_string, mut escaped) = (false, false);
        let (mut literal, mut other_tokens) = (String::new(), false);
        let mut finish = |arg: usize, literal: &mut String, other_tokens: &mut bool| {
            if arg == index && !*other_tokens && !literal.is_empty() {
                found.push(std::mem::take(literal));
            }
            literal.clear();
            *other_tokens = false;
        };
        for c in source[from..].chars() {
            if in_string {
                if escaped {
                    escaped = false;
                    if arg == index {
                        literal.push(c);
                    }
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    in_string = false;
                } else if arg == index {
                    literal.push(c);
                }
                continue;
            }
            match c {
                '"' => {
                    in_string = true;
                    if arg == index && depth == 0 {
                        literal.clear();
                    }
                }
                '(' | '[' | '{' => {
                    depth += 1;
                    if arg == index {
                        other_tokens = true;
                    }
                }
                ')' | ']' | '}' => {
                    if depth == 0 {
                        finish(arg, &mut literal, &mut other_tokens);
                        break;
                    }
                    depth -= 1;
                }
                ',' if depth == 0 => {
                    finish(arg, &mut literal, &mut other_tokens);
                    arg += 1;
                }
                c if !c.is_whitespace() && arg == index => other_tokens = true,
                _ => {}
            }
        }
    }
    found
}

#[test]
fn every_sentence_in_the_dispatcher_has_a_row() {
    let source = include_str!("../src/lib.rs");
    let mut sentences: Vec<String> = Vec::new();
    // error(status, id, code, "sentence", data)
    sentences.extend(literal_args(source, "error", 3));
    // version_mismatch(id, "sentence")
    sentences.extend(literal_args(source, "version_mismatch", 1));
    // validate_bounds: Err("JSON … exceeds the limit")
    sentences.extend(
        literal_args(source, "Err", 0)
            .into_iter()
            .filter(|sentence| sentence.starts_with("JSON ")),
    );
    sentences.sort();
    sentences.dedup();

    // Not vacuous: the scan really finds the dispatcher's sentences, including known ones.
    assert!(
        sentences.len() >= 35,
        "the scan found only {} sentences: {sentences:#?}",
        sentences.len()
    );
    for known in [
        "parse error",
        "unknown tool",
        "method not found",
        "Mcp-Name does not match tools/call params.name",
        "JSON nesting exceeds the limit",
        "unsupported protocol version",
    ] {
        assert!(
            sentences.iter().any(|sentence| sentence == known),
            "the scan missed {known:?}"
        );
    }
    for sentence in &sentences {
        assert_ne!(
            reason_of_sentence(sentence),
            REASON_OTHER,
            "{sentence:?} is said by the dispatcher but has no row in REFUSAL_REASONS"
        );
    }
}

#[test]
fn a_sentence_the_server_does_not_own_is_other() {
    let body = |message: &str| {
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,
                                    "error":{"code":-32600,"message":message}}))
        .unwrap()
    };
    // Not an exact key: a prefix, a suffix, a different case, a caller-looking string, a secret.
    for message in [
        "parse error ",
        " parse error",
        "Parse error",
        "parse",
        "parse error: oort_inbox_read",
        "momo_agent_v1.00000000-0000-0000-0000-000000000000.s3cr3t",
        "unknown tool oort_nonexistent",
        "",
    ] {
        assert_eq!(
            refusal_reason(Some(&body(message))),
            Some(REASON_OTHER),
            "{message:?}"
        );
    }
    // The token is the table's, never the sentence.
    let token = refusal_reason(Some(&body("parse error"))).unwrap();
    assert_eq!(token, "parse_error");
    assert!(!token.contains(' '));
    // No `message` at all is still `other`; no `error` is a success.
    assert_eq!(
        refusal_reason(Some(br#"{"error":{"code":-32600}}"#)),
        Some(REASON_OTHER)
    );
    assert_eq!(
        refusal_reason(Some(br#"{"error":{"code":-32600,"message":5}}"#)),
        Some(REASON_OTHER)
    );
    assert_eq!(
        refusal_reason(Some(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#)),
        None
    );
    assert_eq!(refusal_reason(None), None);
    assert_eq!(refusal_reason(Some(b"not json")), None);
    // A look-alike `data` without both keys is not the artifacts marker.
    assert_eq!(
        refusal_reason(Some(
            br#"{"error":{"code":-32602,"message":"invalid tool arguments","data":{"field":"x"}}}"#
        )),
        Some("tool_arguments")
    );
}

#[test]
fn the_token_vocabulary_is_closed_and_small() {
    let mut tokens: Vec<&str> = REFUSAL_REASONS.iter().map(|(_, token)| *token).collect();
    tokens.push(REASON_OTHER);
    tokens.push(REASON_TOOL_ARTIFACTS);
    tokens.sort_unstable();
    tokens.dedup();
    assert!(tokens.len() <= 40, "{} tokens", tokens.len());
    for token in &tokens {
        assert!(
            !token.is_empty()
                && token.len() <= 32
                && token.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "{token:?} is not a short snake_case token"
        );
    }
    // A sentence is a key once.
    let mut sentences: Vec<&str> = REFUSAL_REASONS
        .iter()
        .map(|(sentence, _)| *sentence)
        .collect();
    let before = sentences.len();
    sentences.sort_unstable();
    sentences.dedup();
    assert_eq!(sentences.len(), before, "a sentence has two rows");
    // The dispatcher's reachable error codes all fall into a token (none maps to the wrong family).
    assert_eq!(dispatch_status_is_a_refusal(), ());
}

/// Smoke: the plain `dispatch` (empty view) is the same dispatcher the table is checked against.
fn dispatch_status_is_a_refusal() {
    let response = dispatch(HttpRequest {
        content_type: Some(JSON_CONTENT_TYPE),
        accept: Some(ACCEPT),
        protocol_version: Some(MODERN_PROTOCOL_VERSION),
        mcp_method: Some("tools/list"),
        mcp_name: None,
        body: b"{",
    });
    assert_eq!(response.status, 400);
    assert_eq!(
        refusal_reason(response.body.as_deref()),
        Some("parse_error")
    );
}
