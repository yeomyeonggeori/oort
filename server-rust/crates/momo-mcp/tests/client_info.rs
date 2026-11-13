//! #5787 · ADR-0216 증보 (2026-11-14) — a `clientInfo` key this server does not know is accepted
//! and never read. Both doors (the Agent Port and the human MCP `/v1/mcp/me`) run this one wire
//! core, so every test below asks both views. The three keys the server does know keep their
//! closed shapes, and the request-wide bounds still hold the whole object.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_real_clients_client_info_is_admitted_on_both_doors_in_both_eras` | the `clientInfo` Claude Code sends (`name`·`title`·`version` with `description`·`websiteUrl`, plus `icons` and a vendor key) passes the legacy `initialize` and the modern `server/discover`·`tools/list`·`tools/call`, and every answer is byte-for-byte the answer to the three-key `clientInfo` | an unknown key is refused again, or starts to change an answer |
//! | `the_known_keys_keep_their_shapes_beside_unknown_keys` | with unknown keys present, a missing / empty / too long / non-string `name`, `version` or `title`, and a `clientInfo` that is not an object, are still `-32602` in both eras on both doors; the exact length limits (128 · 64 · 128) still pass | a known-key check is loosened together with the unknown keys, or a limit moves by one |
//! | `the_request_wide_bounds_still_hold_an_unknown_key` | inside an unknown key, an over-long string, an over-full collection, too deep a nesting, too many keys in `clientInfo` and a body past 64 KiB are refused before dispatch; a string at the limit is admitted | the bounds stop walking into `clientInfo` |
//! | `an_unknown_keys_value_reaches_no_answer_and_no_diagnostic` | an unknown key's value (and its nested key names) is in no answer — admitted, refused by a known key, or refused by a bound — nor in `request_shape` (the refusal log line) or `call_shape` (the call trace) | a value or a nested name is echoed, logged or traced |

use momo_mcp::human::{human_view, SCOPE_IDENTITY, TOOL_WHOAMI};
use momo_mcp::{
    call_shape, dispatch_with_tools, request_shape, HttpRequest, HttpResponse, Outcome, ToolView,
    JSON_CONTENT_TYPE, LEGACY_PROTOCOL_VERSION, MAX_BODY_BYTES, MAX_COLLECTION_ITEMS,
    MAX_JSON_DEPTH, MAX_STRING_BYTES, MODERN_PROTOCOL_VERSION,
};
use serde_json::{json, Value};

const ACCEPT: &str = "application/json, text/event-stream";
const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
/// Every value and every nested key name an unknown key carries in these tests holds this word,
/// so "it reached no answer" is one substring check.
const CANARY: &str = "canary5787";

/// The two doors, by the view each one dispatches with. The Agent Port's foundation view is the
/// empty one (what a connect-only credential gets); the human door's is a developer token's.
fn doors() -> [(&'static str, ToolView); 2] {
    [
        ("agent-port", ToolView::empty()),
        ("human-mcp", human_view(&[SCOPE_IDENTITY.to_string()])),
    ]
}

/// The `clientInfo` Claude Code sends (ADR-0216, #4662 implementation note — measured with
/// Claude Code 2.1.312): the spec's `description` and `websiteUrl` beside the three keys.
fn claude_code_info() -> Value {
    json!({
        "name": "claude-code",
        "title": "Claude Code",
        "version": "2.1.312",
        "description": "Anthropic's agentic coding tool",
        "websiteUrl": "https://claude.com/claude-code"
    })
}

/// Unknown keys whose values and nested names all carry [`CANARY`]: the spec's other optional
/// field (`icons`) and a vendor extension object.
fn canary_extras() -> Value {
    json!({
        "description": format!("{CANARY}-description"),
        "websiteUrl": format!("https://{CANARY}.example/site"),
        "icons": [{"src": format!("https://{CANARY}.example/icon.png"), "mimeType": "image/png"}],
        "x-vendor": {format!("{CANARY}-nested-name"): format!("{CANARY}-nested-value")}
    })
}

fn with(mut info: Value, extra: &Value) -> Value {
    for (key, value) in extra.as_object().expect("extras are an object") {
        info[key] = value.clone();
    }
    info
}

/// One request in each era that carries `info` where that era carries it.
struct Probe {
    label: &'static str,
    body: Value,
    version: Option<&'static str>,
    method: Option<&'static str>,
    name: Option<&'static str>,
}

fn legacy_initialize(info: Value) -> Probe {
    Probe {
        label: "legacy initialize",
        // Claude Code's first legacy POST: no version header yet (the version is proposed in the
        // body), no Mcp-Method mirror.
        body: json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
            "protocolVersion": LEGACY_PROTOCOL_VERSION,
            "capabilities": {"roots": {}, "elicitation": {}},
            "clientInfo": info
        }}),
        version: None,
        method: None,
        name: None,
    }
}

fn modern_meta(info: Value) -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {"roots": {}},
        META_CLIENT_INFO: info
    })
}

fn modern_discover(info: Value) -> Probe {
    Probe {
        label: "modern server/discover",
        body: json!({"jsonrpc": "2.0", "id": 0, "method": "server/discover",
                     "params": {"_meta": modern_meta(info)}}),
        version: Some(MODERN_PROTOCOL_VERSION),
        method: Some("server/discover"),
        name: None,
    }
}

fn modern_list(info: Value) -> Probe {
    Probe {
        label: "modern tools/list",
        body: json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list",
                     "params": {"_meta": modern_meta(info)}}),
        version: Some(MODERN_PROTOCOL_VERSION),
        method: Some("tools/list"),
        name: None,
    }
}

fn modern_call(info: Value) -> Probe {
    Probe {
        label: "modern tools/call",
        body: json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "_meta": modern_meta(info),
            "name": TOOL_WHOAMI,
            "arguments": {}
        }}),
        version: Some(MODERN_PROTOCOL_VERSION),
        method: Some("tools/call"),
        name: Some(TOOL_WHOAMI),
    }
}

/// The probes that carry a `clientInfo`, one per era-and-method that reads it.
fn probes(info: &Value) -> [Probe; 4] {
    [
        legacy_initialize(info.clone()),
        modern_discover(info.clone()),
        modern_list(info.clone()),
        modern_call(info.clone()),
    ]
}

fn send(probe: &Probe, view: &ToolView) -> Outcome {
    let bytes = serde_json::to_vec(&probe.body).expect("serialize the probe");
    send_bytes(probe, &bytes, view)
}

fn send_bytes(probe: &Probe, bytes: &[u8], view: &ToolView) -> Outcome {
    dispatch_with_tools(
        HttpRequest {
            content_type: Some(JSON_CONTENT_TYPE),
            accept: Some(ACCEPT),
            protocol_version: probe.version,
            mcp_method: probe.method,
            mcp_name: probe.name,
            body: bytes,
        },
        view,
    )
}

fn response(outcome: Outcome, context: &str) -> HttpResponse {
    match outcome {
        Outcome::Response(response) => response,
        Outcome::Tool(call) => panic!(
            "{context}: expected an answer, got a call to {}",
            call.tool.name
        ),
    }
}

fn body_text(response: &HttpResponse) -> String {
    String::from_utf8_lossy(response.body.as_deref().unwrap_or_default()).into_owned()
}

fn rpc_error_code(response: &HttpResponse) -> Option<i64> {
    let value: Value = serde_json::from_slice(response.body.as_deref()?).ok()?;
    value.pointer("/error/code")?.as_i64()
}

#[test]
fn a_real_clients_client_info_is_admitted_on_both_doors_in_both_eras() {
    let plain = json!({"name": "claude-code", "title": "Claude Code", "version": "2.1.312"});
    let real = claude_code_info();
    let real_and_more = with(claude_code_info(), &canary_extras());
    for (door, view) in doors() {
        for (index, probe) in probes(&plain).iter().enumerate() {
            let baseline = send(probe, &view);
            for info in [&real, &real_and_more] {
                let probe = &probes(info)[index];
                let context = format!("{door} · {} · {info}", probe.label);
                let outcome = send(probe, &view);
                match (&baseline, &outcome) {
                    // `tools/call` on the human door becomes a call: the same tool, the same
                    // arguments, the same id — nothing of `clientInfo` rides along.
                    (Outcome::Tool(expected), Outcome::Tool(admitted)) => {
                        assert_eq!(admitted, expected, "{context}");
                    }
                    (Outcome::Response(expected), Outcome::Response(answered)) => {
                        assert_eq!(answered, expected, "{context}: {}", body_text(answered));
                        // The baseline is a real admission, not two equal refusals — except the
                        // Agent Port's `tools/call`, which has no tool to call in this view and
                        // answers the plain three-key request with the same "unknown tool".
                        if !(door == "agent-port" && probe.label == "modern tools/call") {
                            assert_eq!(answered.status, 200, "{context}: {}", body_text(answered));
                        }
                    }
                    _ => panic!("{context}: the outcome kind changed"),
                }
            }
        }
    }
}

#[test]
fn the_known_keys_keep_their_shapes_beside_unknown_keys() {
    let extras = with(json!({}), &canary_extras());
    let refused = [
        json!({"version": "1"}),
        json!({"name": "", "version": "1"}),
        json!({"name": "x".repeat(129), "version": "1"}),
        json!({"name": 7, "version": "1"}),
        json!({"name": null, "version": "1"}),
        json!({"name": "c"}),
        json!({"name": "c", "version": ""}),
        json!({"name": "c", "version": "x".repeat(65)}),
        json!({"name": "c", "version": 1}),
        json!({"name": "c", "version": "1", "title": ""}),
        json!({"name": "c", "version": "1", "title": "x".repeat(129)}),
        json!({"name": "c", "version": "1", "title": 1}),
        json!({"name": "c", "version": "1", "title": null}),
    ];
    for (door, view) in doors() {
        for known in &refused {
            for probe in probes(&with(known.clone(), &extras)) {
                let context = format!("{door} · {} · {known}", probe.label);
                let answer = response(send(&probe, &view), &context);
                assert_eq!(answer.status, 400, "{context}: {}", body_text(&answer));
                assert_eq!(rpc_error_code(&answer), Some(-32602), "{context}");
            }
        }
        for not_an_object in [
            json!("claude-code"),
            json!(["claude-code", "1"]),
            json!(null),
            json!(1),
        ] {
            for probe in probes(&not_an_object) {
                let context = format!("{door} · {} · {not_an_object}", probe.label);
                let answer = response(send(&probe, &view), &context);
                assert_eq!(answer.status, 400, "{context}");
                assert_eq!(rpc_error_code(&answer), Some(-32602), "{context}");
            }
        }
        // The limits are exactly where they were: at the limit, with unknown keys beside, it passes.
        let at_limits = with(
            json!({"name": "n".repeat(128), "title": "t".repeat(128), "version": "v".repeat(64)}),
            &extras,
        );
        for probe in probes(&at_limits).iter().take(3) {
            let context = format!("{door} · {} · at the limits", probe.label);
            let answer = response(send(probe, &view), &context);
            assert_eq!(answer.status, 200, "{context}: {}", body_text(&answer));
        }
    }
}

#[test]
fn the_request_wide_bounds_still_hold_an_unknown_key() {
    let base = || json!({"name": "claude-code", "version": "2.1.312"});

    let mut deep = json!(CANARY);
    for _ in 0..MAX_JSON_DEPTH {
        deep = json!([deep]);
    }
    let mut crowded = base();
    for index in 0..(MAX_COLLECTION_ITEMS - 1) {
        crowded[format!("x-{CANARY}-{index}")] = json!(0);
    }
    let refused_by_bounds = [
        (
            "an over-long string",
            with(
                base(),
                &json!({"description": format!("{CANARY}{}", "x".repeat(MAX_STRING_BYTES))}),
            ),
        ),
        (
            "an over-full array",
            with(
                base(),
                &json!({"icons": vec![json!(CANARY); MAX_COLLECTION_ITEMS + 1]}),
            ),
        ),
        (
            "too deep a nesting",
            with(base(), &json!({"x-vendor": deep})),
        ),
        ("too many keys in clientInfo", crowded),
    ];
    for (door, view) in doors() {
        for (what, info) in &refused_by_bounds {
            for probe in probes(info) {
                let context = format!("{door} · {} · {what}", probe.label);
                let answer = response(send(&probe, &view), &context);
                assert_eq!(answer.status, 400, "{context}: {}", body_text(&answer));
                assert_eq!(rpc_error_code(&answer), Some(-32600), "{context}");
            }
        }

        // A body past the request limit made only of unknown keys, each under the string limit.
        let mut wide = base();
        for index in 0..((MAX_BODY_BYTES / (MAX_STRING_BYTES - 64)) + 1) {
            wide[format!("x-{index}")] =
                json!(format!("{CANARY}{}", "x".repeat(MAX_STRING_BYTES - 64)));
        }
        for probe in probes(&wide) {
            let bytes = serde_json::to_vec(&probe.body).expect("serialize");
            assert!(bytes.len() > MAX_BODY_BYTES);
            let context = format!(
                "{door} · {} · a body past {MAX_BODY_BYTES} bytes",
                probe.label
            );
            let answer = response(send_bytes(&probe, &bytes, &view), &context);
            assert_eq!(answer.status, 413, "{context}");
        }

        // The string bound is the request-wide one, not a new tighter one: at it, it passes.
        let at_string_limit = with(
            base(),
            &json!({"description": "d".repeat(MAX_STRING_BYTES)}),
        );
        for probe in probes(&at_string_limit).iter().take(3) {
            let context = format!("{door} · {} · a string at the limit", probe.label);
            let answer = response(send(probe, &view), &context);
            assert_eq!(answer.status, 200, "{context}: {}", body_text(&answer));
        }
    }
}

#[test]
fn an_unknown_keys_value_reaches_no_answer_and_no_diagnostic() {
    let extras = canary_extras();
    let cases = [
        ("admitted", with(claude_code_info(), &extras)),
        (
            "refused by a known key",
            with(json!({"name": "", "version": "1"}), &extras),
        ),
        (
            "refused by a bound",
            with(
                claude_code_info(),
                &json!({"description": format!("{CANARY}{}", "x".repeat(MAX_STRING_BYTES))}),
            ),
        ),
    ];
    for (door, view) in doors() {
        for (what, info) in &cases {
            for probe in probes(info) {
                let context = format!("{door} · {} · {what}", probe.label);
                let bytes = serde_json::to_vec(&probe.body).expect("serialize");
                assert!(
                    String::from_utf8_lossy(&bytes).contains(CANARY),
                    "{context}: the probe carries the canary"
                );
                match send_bytes(&probe, &bytes, &view) {
                    Outcome::Response(answer) => {
                        let text = body_text(&answer);
                        assert!(!text.contains(CANARY), "{context}: the answer holds {text}");
                    }
                    Outcome::Tool(call) => {
                        let rendered = format!("{call:?}");
                        assert!(
                            !rendered.contains(CANARY),
                            "{context}: the call holds {rendered}"
                        );
                    }
                }
                // What the Agent Port logs for a `-32602` and what its call trace records.
                let logged = format!("{:?}", request_shape(&bytes));
                assert!(
                    !logged.contains(CANARY),
                    "{context}: the log line holds {logged}"
                );
                assert!(
                    !logged.contains("websiteUrl"),
                    "{context}: a nested name in {logged}"
                );
                let traced = format!("{:?}", call_shape(&bytes));
                assert!(
                    !traced.contains(CANARY),
                    "{context}: the trace holds {traced}"
                );
            }
        }
    }
}
