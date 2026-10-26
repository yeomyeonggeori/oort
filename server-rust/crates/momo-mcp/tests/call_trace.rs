//! ADR-0200 증보 4 (#4618) — the call trace's vocabulary is closed.
//!
//! The server writes one audit row per admitted Agent Port POST. What may go into
//! that row is decided here, in pure functions, so the PostgreSQL suite only has to
//! prove the row is written and these tests prove what it can ever say:
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_method_and_a_tool_are_only_ever_names_this_crate_owns` | every shape of body maps to a string from a fixed list; a hostile method or tool name becomes `other` / `unknown` | `call_shape` returns (part of) the caller's string, or matches loosely (case, spaces) |
//! | `the_outcome_vocabulary_is_the_tool_failure_vocabulary` | for every `ToolFailure` the trace's outcome equals `ToolFailure::code()` | the mapping and the run ledger's `tool_call` codes drift apart |
//! | `the_outcome_of_a_real_refusal_is_read_from_the_real_response` | the dispatcher's own answers (-32022, -32020, -32601, -32602, success) map to the documented outcome | `response_rpc_code` or `outcome_code` read the wrong field |
//! | `a_trace_never_reads_a_value` | the shape of two bodies that differ only in argument values is equal | a value (cursor, handle, body text) starts to influence the shape |

use momo_mcp::{
    call_shape, dispatch, outcome_code, response_rpc_code, ArtifactRule, ArtifactViolation,
    CallShape, HttpRequest, ToolFailure, CALL_METHODS, CALL_METHOD_NONE, CALL_METHOD_OTHER,
    CALL_METHOD_UNPARSED, CALL_TOOL_UNKNOWN, JSON_CONTENT_TYPE, LEGACY_PROTOCOL_VERSION,
    MODERN_PROTOCOL_VERSION, TOOL_CATALOG, TOOL_INBOX_READ,
};
use serde_json::{json, Value};

const ACCEPT: &str = "application/json, text/event-stream";

fn shape(body: &Value) -> CallShape {
    call_shape(&serde_json::to_vec(body).unwrap())
}

#[test]
fn a_method_and_a_tool_are_only_ever_names_this_crate_owns() {
    // A known method with a catalog tool.
    assert_eq!(
        shape(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                      "params":{"name":TOOL_INBOX_READ,"arguments":{}}})),
        CallShape {
            method: "tools/call",
            tool: Some(TOOL_INBOX_READ)
        }
    );
    // Every catalog name is accepted as itself, so none of the thirteen is mislabelled.
    for tool in TOOL_CATALOG.iter() {
        assert_eq!(
            shape(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                          "params":{"name":tool.name}}))
            .tool,
            Some(tool.name)
        );
    }
    // Every method the server answers is itself, and carries no tool.
    for method in CALL_METHODS
        .iter()
        .copied()
        .filter(|method| *method != "tools/call")
    {
        assert_eq!(
            shape(&json!({"jsonrpc":"2.0","id":1,"method":method})),
            CallShape { method, tool: None },
            "{method}"
        );
    }

    // A tool name the caller made up is `unknown`, never itself — including one that
    // looks like a secret, carries a newline, or is only a catalog name in disguise.
    for hostile in [
        "oort_evil",
        "momo_agent_v1.00000000-0000-0000-0000-000000000000.s3cr3t",
        "oort_inbox_read\nX-Injected: 1",
        "OORT_INBOX_READ",
        " oort_inbox_read",
        "oort_inbox_read ",
        "oort_inbox_read\u{0}",
        "",
    ] {
        let got = shape(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                                "params":{"name":hostile}}));
        assert_eq!(got.method, "tools/call", "{hostile:?}");
        assert_eq!(got.tool, Some(CALL_TOOL_UNKNOWN), "{hostile:?}");
    }
    // A `tools/call` with no readable name at all is `unknown` too.
    for params in [
        json!({}),
        json!({"name": 5}),
        json!({"name": null}),
        json!("oort_inbox_read"),
    ] {
        assert_eq!(
            shape(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":params})).tool,
            Some(CALL_TOOL_UNKNOWN)
        );
    }
    assert_eq!(
        shape(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call"})).tool,
        Some(CALL_TOOL_UNKNOWN)
    );

    // A method the server does not answer is `other` — however it is spelled, and
    // even when it is a tool's name.
    for method in [
        "resources/list",
        "prompts/list",
        "logging/setLevel",
        "Tools/Call",
        " tools/call",
        "tools/call ",
        "oort_inbox_read",
        "",
    ] {
        assert_eq!(
            shape(&json!({"jsonrpc":"2.0","id":1,"method":method})),
            CallShape {
                method: CALL_METHOD_OTHER,
                tool: None
            },
            "{method:?}"
        );
    }

    // A body with no usable method is told apart from a body that is not JSON.
    for body in [
        json!({"jsonrpc":"2.0","id":1}),
        json!({"method": 5}),
        json!({"method": null}),
        json!([{"jsonrpc":"2.0","id":1,"method":"ping"}]),
        json!("tools/call"),
        json!(5),
        Value::Null,
    ] {
        assert_eq!(
            shape(&body),
            CallShape {
                method: CALL_METHOD_NONE,
                tool: None
            },
            "{body}"
        );
    }
    for raw in [
        &b""[..],
        b"not json",
        b"{\"method\":\"ping\"",
        b"{\"method\":\"ping\"}\n{",
        b"{\"cursor\":\"abc\ndef\"}",
        &[0xff, 0xfe, 0x00],
    ] {
        assert_eq!(
            call_shape(raw),
            CallShape {
                method: CALL_METHOD_UNPARSED,
                tool: None
            },
            "{raw:?}"
        );
    }

    // The vocabulary itself is bounded and distinct.
    let mut names: Vec<&str> = CALL_METHODS.to_vec();
    names.extend([CALL_METHOD_OTHER, CALL_METHOD_UNPARSED, CALL_METHOD_NONE]);
    let count = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), count, "no two method tokens are the same");
    assert!(names.iter().all(|name| name.len() <= 64));
}

#[test]
fn a_trace_never_reads_a_value() {
    // Same method and tool, different argument values: the shape cannot differ.
    let call = |arguments: Value| {
        shape(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                      "params":{"name":TOOL_INBOX_READ,"arguments":arguments}}))
    };
    let baseline = call(json!({}));
    for arguments in [
        json!({"cursor": "momo_inbox_cursor_v1.AAAA"}),
        json!({"cursor": "x".repeat(400)}),
        json!({"cursor": 5}),
        json!({"limit": 1, "unknown": {"deep": ["secret"]}}),
        json!(null),
    ] {
        assert_eq!(call(arguments), baseline);
    }
    // The id is a value too.
    assert_eq!(
        shape(&json!({"jsonrpc":"2.0","id":"secret-looking-id","method":"ping"})),
        shape(&json!({"jsonrpc":"2.0","id":7,"method":"ping"}))
    );
}

/// A match with no wildcard: adding a `ToolFailure` variant stops this file compiling
/// until the new variant is given a trace outcome on purpose.
fn every_failure_has_a_row() -> Vec<ToolFailure> {
    fn exhaustive(failure: ToolFailure) {
        match failure {
            ToolFailure::InvalidArguments
            | ToolFailure::InvalidArtifacts(_)
            | ToolFailure::NotAuthorized
            | ToolFailure::HandleRefused
            | ToolFailure::Unavailable
            | ToolFailure::Conflict
            | ToolFailure::AlreadyClaimed
            | ToolFailure::ClaimExpired
            | ToolFailure::Internal => {}
        }
    }
    let all = vec![
        ToolFailure::InvalidArguments,
        ToolFailure::InvalidArtifacts(ArtifactViolation {
            field: "artifacts.resultKind",
            rule: ArtifactRule::Enum,
            allowed: &[],
            requires: None,
            hint: "must be one of the closed values",
        }),
        ToolFailure::NotAuthorized,
        ToolFailure::HandleRefused,
        ToolFailure::Unavailable,
        ToolFailure::Conflict,
        ToolFailure::AlreadyClaimed,
        ToolFailure::ClaimExpired,
        ToolFailure::Internal,
    ];
    all.iter().copied().for_each(exhaustive);
    all
}

#[test]
fn the_outcome_vocabulary_is_the_tool_failure_vocabulary() {
    assert_eq!(outcome_code(None), "ok");
    for failure in every_failure_has_a_row() {
        let (_, rpc, _) = failure.wire();
        assert_eq!(
            outcome_code(Some(rpc)),
            failure.code(),
            "{failure:?} (JSON-RPC {rpc})"
        );
    }
    // What the transport itself refuses is one token, whatever the code.
    for rpc in [-32700, -32600, -32601, -32020, -32022, -32029, 0, 1, 500] {
        assert_eq!(outcome_code(Some(rpc)), "protocol_error", "{rpc}");
    }
}

#[test]
fn response_rpc_code_reads_only_the_error_code() {
    assert_eq!(response_rpc_code(None), None);
    assert_eq!(response_rpc_code(Some(b"")), None);
    assert_eq!(response_rpc_code(Some(b"not json")), None);
    assert_eq!(
        response_rpc_code(Some(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#)),
        None
    );
    assert_eq!(
        response_rpc_code(Some(
            br#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"x"}}"#
        )),
        Some(-32602)
    );
    // A `result` that merely contains an `error.code` is not an error response.
    assert_eq!(
        response_rpc_code(Some(
            br#"{"jsonrpc":"2.0","id":1,"result":{"error":{"code":-32602}}}"#
        )),
        None
    );
    // A non-integer code is not a code.
    assert_eq!(
        response_rpc_code(Some(
            br#"{"jsonrpc":"2.0","id":1,"error":{"code":"-32602","message":"x"}}"#
        )),
        None
    );
}

fn modern_list(version_in_meta: &str) -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion": version_in_meta,
        "io.modelcontextprotocol/clientCapabilities": {}}}})
}

fn answer(
    body: &Value,
    version: Option<&str>,
    method: Option<&str>,
    name: Option<&str>,
) -> momo_mcp::HttpResponse {
    let bytes = serde_json::to_vec(body).unwrap();
    dispatch(HttpRequest {
        content_type: Some(JSON_CONTENT_TYPE),
        accept: Some(ACCEPT),
        protocol_version: version,
        mcp_method: method,
        mcp_name: name,
        body: &bytes,
    })
}

#[test]
fn the_outcome_of_a_real_refusal_is_read_from_the_real_response() {
    // (request, expected HTTP status, expected JSON-RPC code, expected outcome)
    let cases: Vec<(momo_mcp::HttpResponse, u16, Option<i64>, &str)> = vec![
        // A client that proposes a protocol version this server does not speak.
        (
            answer(
                &modern_list("2025-06-18"),
                Some("2025-06-18"),
                Some("tools/list"),
                None,
            ),
            400,
            Some(-32022),
            "protocol_error",
        ),
        // A modern call whose `Mcp-Method` header disagrees with its body.
        (
            answer(
                &modern_list(MODERN_PROTOCOL_VERSION),
                Some(MODERN_PROTOCOL_VERSION),
                Some("tools/call"),
                None,
            ),
            400,
            Some(-32020),
            "protocol_error",
        ),
        // A legacy follow-up that forgot the `MCP-Protocol-Version` header.
        (
            answer(
                &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
                None,
                None,
                None,
            ),
            400,
            Some(-32022),
            "protocol_error",
        ),
        // A method this server does not have.
        (
            answer(
                &json!({"jsonrpc":"2.0","id":1,"method":"resources/list"}),
                Some(LEGACY_PROTOCOL_VERSION),
                None,
                None,
            ),
            400,
            Some(-32601),
            "protocol_error",
        ),
        // A well-formed tool call for a tool outside the (empty) view: the wire says
        // "unknown tool", which is `invalid_arguments` in the trace's vocabulary.
        (
            answer(
                &json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                        "params":{"name":TOOL_INBOX_READ,"arguments":{}}}),
                Some(LEGACY_PROTOCOL_VERSION),
                None,
                None,
            ),
            400,
            Some(-32602),
            "invalid_arguments",
        ),
        // A success (the foundation `tools/list` of an empty view).
        (
            answer(
                &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
                Some(LEGACY_PROTOCOL_VERSION),
                None,
                None,
            ),
            200,
            None,
            "ok",
        ),
    ];
    for (index, (response, status, rpc, outcome)) in cases.into_iter().enumerate() {
        assert_eq!(response.status, status, "case {index}");
        let code = response_rpc_code(response.body.as_deref());
        assert_eq!(code, rpc, "case {index}");
        assert_eq!(outcome_code(code), outcome, "case {index}");
    }
}
