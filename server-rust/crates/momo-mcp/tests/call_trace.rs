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
//! | `every_listed_method_is_one_the_dispatcher_answers` | each name in `CALL_METHODS` gets a well-formed request the dispatcher answers (never `-32601`) and is classified as itself; a method outside the list is `-32601` and `other` | the hand-kept list and the dispatcher's own methods part ways, so a real method is recorded as `other` |
//! | `a_trace_never_reads_a_value` | the shape of two bodies that differ only in argument values is equal | a value (cursor, handle, body text) starts to influence the shape |
//! | `counts_come_only_from_a_success_of_the_three_tools` | `events` / `agent_jobs` / `jobs` are read from the server's own success body of `oort_inbox_read` / `oort_jobs_claim` / `oort_job_start`, and nowhere else | a count appears for another tool, an error body, or a malformed field; or `agent_job` is counted by something other than its `kind` |
//! | `a_count_carries_no_text_from_the_answer` | whatever strings, ids and handles an answer holds, the counts are plain integers | the count type grows a string or id |

use momo_mcp::{
    call_shape, dispatch, outcome_code, response_rpc_code, result_counts, ArtifactRule,
    ArtifactViolation, AssembleParams, CallShape, HttpRequest, ResultCounts, ToolFailure,
    CALL_METHODS, CALL_METHOD_NONE, CALL_METHOD_OTHER, CALL_METHOD_UNPARSED, CALL_TOOL_UNKNOWN,
    JSON_CONTENT_TYPE, LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION, TOOL_CATALOG,
    TOOL_INBOX_READ, TOOL_JOBS_CLAIM, TOOL_JOB_START, TOOL_PING,
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
            | ToolFailure::InvalidAssembleParams(_)
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
        ToolFailure::InvalidAssembleParams(
            AssembleParams::from_names(["frameMs", "size"]).expect("two closed names"),
        ),
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

/// A well-formed request for each method the trace names, in the era that method lives in.
fn request_for(method: &str) -> (Value, Option<&'static str>, Option<&'static str>) {
    match method {
        // The legacy handshake: no protocol header yet, the version is proposed in the body.
        "initialize" => (
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "probe", "version": "1"}}}),
            None,
            None,
        ),
        // Legacy follow-ups carry the negotiated version in the header.
        "notifications/initialized" => (
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            Some(LEGACY_PROTOCOL_VERSION),
            None,
        ),
        "ping" => (
            json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
            Some(LEGACY_PROTOCOL_VERSION),
            None,
        ),
        "tools/list" => (
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            Some(LEGACY_PROTOCOL_VERSION),
            None,
        ),
        "tools/call" => (
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                   "params":{"name":TOOL_PING,"arguments":{}}}),
            Some(LEGACY_PROTOCOL_VERSION),
            None,
        ),
        // The modern discovery call: `_meta` in the body and the method named in a header.
        "server/discover" => (
            json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{
                "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {}}}}),
            Some(MODERN_PROTOCOL_VERSION),
            Some("server/discover"),
        ),
        other => panic!("CALL_METHODS names `{other}` and this test knows no request for it"),
    }
}

/// `CALL_METHODS` is a hand-kept list beside the dispatcher's own `match`. If a listed name stops being
/// one the dispatcher answers (a typo in the list, a rename on the dispatcher's side) the trace would
/// label a real method `other` and the diagnosis would quietly lie. Every listed method must be one the
/// dispatcher answers (anything but `-32601 method not found`) and be classified as itself, and a method
/// that is not listed must still be refused as unknown.
///
/// What this cannot see: a method added to the dispatcher and not to the list. The dispatcher spells its
/// methods in several `match`es and `if`s, so there is no honest scan for it; such a method is recorded
/// as `other` — a closed value, visible as exactly that when the rows are read.
#[test]
fn every_listed_method_is_one_the_dispatcher_answers() {
    assert_eq!(CALL_METHODS.len(), 6, "the list the ADR names");
    for method in CALL_METHODS {
        let (body, version, mcp_method) = request_for(method);
        let response = answer(&body, version, mcp_method, None);
        let code = response_rpc_code(response.body.as_deref());
        assert_ne!(
            code,
            Some(-32601),
            "`{method}` is in CALL_METHODS but the dispatcher does not know it: {:?}",
            response.body.as_deref().map(String::from_utf8_lossy)
        );
        // And the shape of that very request is classified under its own name, not `other`.
        assert_eq!(
            shape(&body).method,
            method,
            "`{method}` is labelled as itself"
        );
    }
    // The control: a name that is not listed is unknown to the dispatcher too.
    let (unlisted, version, mcp_method) = (
        json!({"jsonrpc":"2.0","id":1,"method":"resources/list"}),
        Some(LEGACY_PROTOCOL_VERSION),
        None,
    );
    let refused = answer(&unlisted, version, mcp_method, None);
    assert_eq!(response_rpc_code(refused.body.as_deref()), Some(-32601));
    assert_eq!(shape(&unlisted).method, CALL_METHOD_OTHER);
}

/// The MCP success envelope of a tool answer, as the server writes it.
fn success_body(structured: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": 1,
        "result": {"content": [{"type": "text", "text": "{}"}],
                   "structuredContent": structured, "isError": false}
    }))
    .unwrap()
}

fn counts(tool: &str, structured: Value) -> ResultCounts {
    result_counts(tool, Some(&success_body(structured)))
}

#[test]
fn counts_come_only_from_a_success_of_the_three_tools() {
    // oort_inbox_read: how many events, and how many of them are tracked turns.
    assert_eq!(
        counts(
            TOOL_INBOX_READ,
            json!({"events": [], "nextCursor": "c", "hasMore": false})
        ),
        ResultCounts {
            events: Some(0),
            agent_jobs: Some(0),
            jobs: None
        }
    );
    assert_eq!(
        counts(
            TOOL_INBOX_READ,
            json!({"events": [
                {"kind": "message", "channelId": "a"},
                {"kind": "agent_job", "channelId": "a"},
                {"kind": "agent_run", "channelId": "a"},
                {"kind": "agent_job", "channelId": "b"},
                {"channelId": "no-kind"},
                {"kind": 5}
            ], "nextCursor": "c", "hasMore": true})
        ),
        ResultCounts {
            events: Some(6),
            agent_jobs: Some(2),
            jobs: None
        },
        "agent_job is counted by its `kind` and by nothing else"
    );

    // oort_jobs_claim: jobs handed over.
    assert_eq!(counts(TOOL_JOBS_CLAIM, json!({"jobs": []})).jobs, Some(0));
    assert_eq!(
        counts(
            TOOL_JOBS_CLAIM,
            json!({"jobs": [{"leaseHandle": "h1"}, {"leaseHandle": "h2"}]})
        ),
        ResultCounts {
            events: None,
            agent_jobs: None,
            jobs: Some(2)
        }
    );

    // oort_job_start: 1 when it handed a job over, 0 for `job: null` (nothing pending, or
    // a closed run) — never the job itself.
    assert_eq!(
        counts(
            TOOL_JOB_START,
            json!({"job": null, "started": false, "resumed": false})
        )
        .jobs,
        Some(0)
    );
    assert_eq!(
        counts(
            TOOL_JOB_START,
            json!({"job": null, "started": false, "resumed": true, "closed": "run_settled"})
        )
        .jobs,
        Some(0)
    );
    assert_eq!(
        counts(
            TOOL_JOB_START,
            json!({"job": {"leaseHandle": "h", "work": {"prompt": "x"}},
                   "started": true, "resumed": false})
        ),
        ResultCounts {
            events: None,
            agent_jobs: None,
            jobs: Some(1)
        }
    );

    // Nothing else has a count, whatever its answer looks like.
    for tool in [
        TOOL_PING,
        "oort_message_post",
        "oort_run_event",
        "unknown",
        "",
    ] {
        assert_eq!(
            counts(tool, json!({"events": [1, 2], "jobs": [1], "job": {}})),
            ResultCounts::default(),
            "{tool:?}"
        );
    }

    // A refusal, a body-less answer, junk and wrongly shaped fields have none.
    let refusal =
        br#"{"jsonrpc":"2.0","id":1,"error":{"code":-32004,"message":"tool target is unavailable"}}"#;
    for body in [
        Some(&refusal[..]),
        None,
        Some(&b""[..]),
        Some(&b"not json"[..]),
        Some(br#"{"result":{}}"#),
        Some(br#"{"result":{"structuredContent":"events"}}"#),
        Some(br#"{"result":{"structuredContent":[1,2,3]}}"#),
    ] {
        for tool in [TOOL_INBOX_READ, TOOL_JOBS_CLAIM, TOOL_JOB_START] {
            assert_eq!(result_counts(tool, body), ResultCounts::default(), "{tool}");
        }
    }
    for structured in [
        json!({"events": "none"}),
        json!({"events": {"0": {}}}),
        json!({"events": null}),
        json!({"jobs": 3}),
        json!({"jobs": "1"}),
        json!({}),
    ] {
        for tool in [TOOL_INBOX_READ, TOOL_JOBS_CLAIM] {
            assert_eq!(
                counts(tool, structured.clone()),
                ResultCounts::default(),
                "{tool} {structured}"
            );
        }
    }
    // `job` of a wrong type is not a job, and not a missing key either: it is 0 handed over.
    assert_eq!(counts(TOOL_JOB_START, json!({"job": "yes"})).jobs, Some(0));
    assert_eq!(counts(TOOL_JOB_START, json!({})).jobs, None);

    // A huge page cannot overflow the count type.
    let many: Vec<Value> = (0..1000).map(|_| json!({"kind": "agent_job"})).collect();
    assert_eq!(
        counts(TOOL_INBOX_READ, json!({"events": many})).agent_jobs,
        Some(1000)
    );
}

#[test]
fn a_count_carries_no_text_from_the_answer() {
    // The type is three optional integers; this pins that by construction: a value built from
    // an answer full of strings, ids and handles is `Copy` + `Eq` and holds nothing but numbers.
    let hostile = json!({"events": [
        {"kind": "agent_job", "channelId": "MARKER-CHANNEL", "messageId": "MARKER-MESSAGE"}
    ], "nextCursor": "MARKER-CURSOR", "hasMore": false});
    let got = counts(TOOL_INBOX_READ, hostile);
    let rendered = format!("{got:?}");
    assert!(!rendered.contains("MARKER"), "{rendered}");
    assert_eq!(
        got,
        ResultCounts {
            events: Some(1),
            agent_jobs: Some(1),
            jobs: None
        }
    );
    fn plain_data<T: Copy + Eq + Default>(_: T) {}
    plain_data(got);
}
