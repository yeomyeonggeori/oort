use momo_mcp::{
    dispatch, HttpRequest, HttpResponse, ERR_UNSUPPORTED_VERSION, ERR_VERSION_MISMATCH,
    JSON_CONTENT_TYPE, LEGACY_PROTOCOL_VERSION, MAX_BODY_BYTES, MAX_COLLECTION_ITEMS,
    MAX_JSON_DEPTH, MAX_STRING_BYTES, MODERN_PROTOCOL_VERSION,
};
use serde_json::{json, Value};

const ACCEPT: &str = "application/json, text/event-stream";

fn invoke(
    body: &Value,
    version: Option<&str>,
    method: Option<&str>,
    name: Option<&str>,
) -> HttpResponse {
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

fn modern(method: &str, id: Value, extra: Value) -> Value {
    let mut params = json!({
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {}
        }
    });
    for (key, value) in extra.as_object().unwrap() {
        params
            .as_object_mut()
            .unwrap()
            .insert(key.clone(), value.clone());
    }
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

fn json_body(response: &HttpResponse) -> Value {
    serde_json::from_slice(response.body.as_deref().expect("JSON body")).unwrap()
}

fn error_code(response: &HttpResponse) -> i64 {
    json_body(response)["error"]["code"].as_i64().unwrap()
}

#[test]
fn modern_discovery_has_the_exact_stable_shape() {
    let response = invoke(
        &modern("server/discover", json!("discover-1"), json!({})),
        Some(MODERN_PROTOCOL_VERSION),
        Some("server/discover"),
        None,
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.content_type, Some(JSON_CONTENT_TYPE));
    assert_eq!(
        json_body(&response),
        json!({
            "jsonrpc": "2.0",
            "id": "discover-1",
            "result": {
                "protocolVersion": "2026-07-28",
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {
                    "name": "oort-agent-port",
                    "title": "oort Agent Port",
                    "version": "0.0.0"
                },
                "resultType": "server/discover",
                "cache": {"ttlSeconds": 300, "scope": "private"}
            }
        })
    );
}

#[test]
fn modern_tools_list_is_empty_private_and_not_cacheable() {
    let request = modern("tools/list", json!(7), json!({}));
    let first = invoke(
        &request,
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/list"),
        None,
    );
    let second = invoke(
        &request,
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/list"),
        None,
    );

    assert_eq!(first.status, 200);
    assert_eq!(
        first.body, second.body,
        "dispatch must be byte-deterministic"
    );
    assert_eq!(
        json_body(&first)["result"],
        json!({
            "tools": [],
            "resultType": "tools/list",
            "cache": {"ttlSeconds": 0, "scope": "private"}
        })
    );
}

#[test]
fn fractional_json_rpc_id_is_accepted_and_round_tripped() {
    let request = modern("tools/list", json!(1.5), json!({}));
    let response = invoke(
        &request,
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/list"),
        None,
    );
    assert_eq!(response.status, 200);
    assert_eq!(json_body(&response)["id"], json!(1.5));
}

#[test]
fn modern_optional_client_info_is_validated() {
    let valid = modern(
        "tools/list",
        json!(1),
        json!({
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {
                    "name": "fixture",
                    "title": "Fixture",
                    "version": "1.0"
                }
            }
        }),
    );
    assert_eq!(
        invoke(
            &valid,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            None
        )
        .status,
        200
    );

    let invalid = modern(
        "tools/list",
        json!(1),
        json!({
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {"name": "fixture"}
            }
        }),
    );
    assert_eq!(
        error_code(&invoke(
            &invalid,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            None
        )),
        -32602
    );
}

#[test]
fn legacy_initialize_is_sessionless_and_exactly_pinned() {
    let response = invoke(
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "legacy-fixture", "version": "1.0"}
            }
        }),
        None,
        None,
        None,
    );

    assert_eq!(response.status, 200);
    assert_eq!(
        json_body(&response),
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": "2025-11-25",
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {
                    "name": "oort-agent-port",
                    "title": "oort Agent Port",
                    "version": "0.0.0"
                }
            }
        })
    );
}

#[test]
fn legacy_initialized_is_the_only_notification_and_returns_empty_202() {
    let response = invoke(
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
        Some(LEGACY_PROTOCOL_VERSION),
        None,
        None,
    );
    assert_eq!(
        response,
        HttpResponse {
            status: 202,
            body: None,
            content_type: None
        }
    );

    let with_id = invoke(
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "notifications/initialized",
            "params": {}
        }),
        Some(LEGACY_PROTOCOL_VERSION),
        None,
        None,
    );
    assert_eq!(with_id.status, 400);
    assert_eq!(error_code(&with_id), -32600);
}

#[test]
fn legacy_ping_and_empty_tools_list_are_conventional_json_rpc() {
    let ping = invoke(
        &json!({"jsonrpc":"2.0","id":"p","method":"ping","params":{}}),
        Some(LEGACY_PROTOCOL_VERSION),
        None,
        None,
    );
    assert_eq!(ping.status, 200);
    assert_eq!(json_body(&ping)["result"], json!({}));

    let list = invoke(
        &json!({"jsonrpc":"2.0","id":"l","method":"tools/list","params":{}}),
        Some(LEGACY_PROTOCOL_VERSION),
        None,
        None,
    );
    assert_eq!(list.status, 200);
    assert_eq!(json_body(&list)["result"], json!({"tools": []}));
}

#[test]
fn both_eras_return_invalid_params_for_a_tool_that_is_not_advertised() {
    let modern_call = modern("tools/call", json!(1), json!({"name": "never"}));
    let response = invoke(
        &modern_call,
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("never"),
    );
    assert_eq!(response.status, 400);
    assert_eq!(error_code(&response), -32602);

    let legacy_call = json!({
        "jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"never"}
    });
    let response = invoke(
        &legacy_call,
        Some(LEGACY_PROTOCOL_VERSION),
        None,
        Some("never"),
    );
    assert_eq!(response.status, 400);
    assert_eq!(error_code(&response), -32602);
}

#[test]
fn modern_header_never_falls_back_to_legacy_initialize() {
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": LEGACY_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "fixture", "version": "1"},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {}
            }
        }
    });
    let response = invoke(
        &request,
        Some(MODERN_PROTOCOL_VERSION),
        Some("initialize"),
        None,
    );
    assert_eq!(response.status, 400);
    assert_eq!(error_code(&response), -32601);
}

#[test]
fn legacy_header_never_exposes_modern_discovery() {
    let request = modern("server/discover", json!(1), json!({}));
    let response = invoke(
        &request,
        Some(LEGACY_PROTOCOL_VERSION),
        Some("server/discover"),
        None,
    );
    assert_eq!(response.status, 400);
    assert_eq!(error_code(&response), ERR_VERSION_MISMATCH);
}

#[test]
fn explicit_legacy_version_rejects_reserved_modern_metadata() {
    let request = modern("tools/list", json!(1), json!({}));
    let response = invoke(&request, Some(LEGACY_PROTOCOL_VERSION), None, None);
    assert_eq!(response.status, 400);
    assert_eq!(error_code(&response), ERR_VERSION_MISMATCH);
}

#[test]
fn modern_version_method_and_name_mirrors_are_exact() {
    let list = modern("tools/list", json!(1), json!({}));
    for response in [
        invoke(&list, None, Some("tools/list"), None),
        invoke(
            &list,
            Some(MODERN_PROTOCOL_VERSION),
            Some("server/discover"),
            None,
        ),
        invoke(
            &list,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            Some("unexpected"),
        ),
    ] {
        assert_eq!(response.status, 400);
        assert_eq!(error_code(&response), ERR_VERSION_MISMATCH);
    }

    let call = modern("tools/call", json!(1), json!({"name": "one"}));
    let response = invoke(
        &call,
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("two"),
    );
    assert_eq!(error_code(&response), ERR_VERSION_MISMATCH);
}

#[test]
fn metadata_header_version_mutations_fail_closed() {
    let legacy_meta = json!({
        "jsonrpc":"2.0","id":1,"method":"tools/list","params":{
            "_meta":{
                "io.modelcontextprotocol/protocolVersion":LEGACY_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities":{}
            }
        }
    });
    assert_eq!(
        error_code(&invoke(
            &legacy_meta,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            None
        )),
        ERR_VERSION_MISMATCH
    );

    let unsupported = modern("tools/list", json!(2), json!({}));
    let response = invoke(&unsupported, Some("2099-01-01"), None, None);
    assert_eq!(response.status, 400);
    assert_eq!(error_code(&response), ERR_UNSUPPORTED_VERSION);
    assert_eq!(
        json_body(&response)["error"]["data"]["supported"],
        json!(["2026-07-28", "2025-11-25"])
    );
}

#[test]
fn legacy_initialize_rejects_other_proposals_and_followups_require_a_version() {
    let initialize = |version: &str| {
        json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":version,"capabilities":{},
                "clientInfo":{"name":"fixture","version":"1"}
            }
        })
    };
    assert_eq!(
        error_code(&invoke(&initialize("2099-01-01"), None, None, None)),
        ERR_UNSUPPORTED_VERSION
    );
    assert_eq!(
        error_code(&invoke(
            &initialize(MODERN_PROTOCOL_VERSION),
            None,
            None,
            None
        )),
        ERR_VERSION_MISMATCH
    );

    let ping = json!({"jsonrpc":"2.0","id":1,"method":"ping","params":{}});
    assert_eq!(
        error_code(&invoke(&ping, None, None, None)),
        ERR_UNSUPPORTED_VERSION
    );
}

#[test]
fn media_type_and_accept_are_both_fail_closed() {
    let body = serde_json::to_vec(&modern("tools/list", json!(1), json!({}))).unwrap();
    let wrong_content = dispatch(HttpRequest {
        content_type: Some("text/plain"),
        accept: Some(ACCEPT),
        protocol_version: Some(MODERN_PROTOCOL_VERSION),
        mcp_method: Some("tools/list"),
        mcp_name: None,
        body: &body,
    });
    assert_eq!(wrong_content.status, 415);

    let wrong_accept = dispatch(HttpRequest {
        content_type: Some("application/json; charset=utf-8"),
        accept: Some("application/json"),
        protocol_version: Some(MODERN_PROTOCOL_VERSION),
        mcp_method: Some("tools/list"),
        mcp_name: None,
        body: &body,
    });
    assert_eq!(wrong_accept.status, 415);

    let disabled_sse = dispatch(HttpRequest {
        content_type: Some("application/json"),
        accept: Some("application/json, text/event-stream;q=0"),
        protocol_version: Some(MODERN_PROTOCOL_VERSION),
        mcp_method: Some("tools/list"),
        mcp_name: None,
        body: &body,
    });
    assert_eq!(disabled_sse.status, 415);

    for malformed in [
        "application/json; garbage",
        "application/json; charset=utf-8; charset=utf-8",
        "application/json; charset=latin1",
        "application/json; =utf-8",
        "application/json; charset=\"utf-8",
        "application/json; charset=utf-8\"",
    ] {
        let response = dispatch(HttpRequest {
            content_type: Some(malformed),
            accept: Some(ACCEPT),
            protocol_version: Some(MODERN_PROTOCOL_VERSION),
            mcp_method: Some("tools/list"),
            mcp_name: None,
            body: &body,
        });
        assert_eq!(response.status, 415, "Content-Type {malformed:?}");
    }

    for malformed in [
        "application/json; garbage, text/event-stream",
        "application/json;q=+1, text/event-stream",
        "application/json;q=1;q=1, text/event-stream",
        "application/json;q=2, text/event-stream",
        "application/json;q=01, text/event-stream",
        "application/json;q=1., text/event-stream",
        "application/json;q=0.1234, text/event-stream",
        "garbage; nope, application/json, text/event-stream",
    ] {
        let response = dispatch(HttpRequest {
            content_type: Some(JSON_CONTENT_TYPE),
            accept: Some(malformed),
            protocol_version: Some(MODERN_PROTOCOL_VERSION),
            mcp_method: Some("tools/list"),
            mcp_name: None,
            body: &body,
        });
        assert_eq!(response.status, 415, "Accept {malformed:?}");
    }
}

#[test]
fn duplicate_era_bearing_json_names_fail_closed_before_dispatch() {
    for raw in [
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/list","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#.as_slice(),
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{},"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#.as_slice(),
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25","io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#.as_slice(),
    ] {
        let response = dispatch(HttpRequest {
            content_type: Some(JSON_CONTENT_TYPE),
            accept: Some(ACCEPT),
            protocol_version: Some(MODERN_PROTOCOL_VERSION),
            mcp_method: Some("tools/list"),
            mcp_name: None,
            body: raw,
        });
        assert_eq!(response.status, 400);
        assert_eq!(error_code(&response), -32700);
        assert_eq!(json_body(&response)["id"], Value::Null);
    }
}

#[test]
fn malformed_json_rpc_ids_params_and_metadata_are_rejected() {
    let malformed = dispatch(HttpRequest {
        content_type: Some(JSON_CONTENT_TYPE),
        accept: Some(ACCEPT),
        protocol_version: Some(MODERN_PROTOCOL_VERSION),
        mcp_method: Some("tools/list"),
        mcp_name: None,
        body: b"{",
    });
    assert_eq!(error_code(&malformed), -32700);

    for body in [
        json!([]),
        json!({"jsonrpc":"1.0","id":1,"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":null,"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":true,"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":{},"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":[],"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":[]}),
    ] {
        let response = invoke(
            &body,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            None,
        );
        assert_eq!(response.status, 400, "body: {body}");
    }

    for params in [
        json!({}),
        json!({"_meta": {}}),
        json!({"_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION
        }}),
    ] {
        let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":params});
        assert_eq!(
            error_code(&invoke(
                &body,
                Some(MODERN_PROTOCOL_VERSION),
                Some("tools/list"),
                None
            )),
            -32602
        );
    }
}

#[test]
fn invalid_ids_are_never_reflected_by_earlier_envelope_errors() {
    for raw in [
        br#"{"jsonrpc":"2.0","id":{"secret":"attacker-marker"},"method":"tools/list","params":{},"extra":true}"#.as_slice(),
        br#"{"jsonrpc":"1.0","id":["attacker-marker"],"method":"tools/list","params":{}}"#.as_slice(),
        br#"{"jsonrpc":"2.0","id":{"secret":"attacker-marker"},"params":{}}"#.as_slice(),
    ] {
        let response = dispatch(HttpRequest {
            content_type: Some(JSON_CONTENT_TYPE),
            accept: Some(ACCEPT),
            protocol_version: Some(MODERN_PROTOCOL_VERSION),
            mcp_method: Some("tools/list"),
            mcp_name: None,
            body: raw,
        });
        assert_eq!(response.status, 400);
        assert_eq!(json_body(&response)["id"], Value::Null);
        let body = response.body.expect("bounded error body");
        assert!(body.len() < 256);
        assert!(!String::from_utf8_lossy(&body).contains("attacker-marker"));
    }
}

#[test]
fn unknown_fields_and_method_specific_params_are_rejected() {
    let mut unknown_top = modern("tools/list", json!(1), json!({}));
    unknown_top
        .as_object_mut()
        .unwrap()
        .insert("extra".into(), json!(true));

    let unknown_meta = json!({
        "jsonrpc":"2.0","id":1,"method":"tools/list","params":{
            "_meta":{
                "io.modelcontextprotocol/protocolVersion":MODERN_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities":{},
                "extra":true
            }
        }
    });
    let unknown_params = modern("tools/list", json!(1), json!({"extra": true}));
    let invalid_arguments = modern(
        "tools/call",
        json!(1),
        json!({"name":"never","arguments":[]}),
    );

    for body in [unknown_top, unknown_meta, unknown_params, invalid_arguments] {
        let method = body["method"].as_str().unwrap();
        let name = (method == "tools/call").then_some("never");
        let response = invoke(&body, Some(MODERN_PROTOCOL_VERSION), Some(method), name);
        assert_eq!(response.status, 400, "body: {body}");
    }

    let legacy_ping_extra = json!({
        "jsonrpc":"2.0","id":1,"method":"ping","params":{"extra":true}
    });
    assert_eq!(
        error_code(&invoke(
            &legacy_ping_extra,
            Some(LEGACY_PROTOCOL_VERSION),
            None,
            None
        )),
        -32602
    );

    let legacy_initialize_extra = json!({
        "jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":LEGACY_PROTOCOL_VERSION,
            "capabilities":{},
            "clientInfo":{"name":"fixture","version":"1"},
            "extra":true
        }
    });
    assert_eq!(
        error_code(&invoke(&legacy_initialize_extra, None, None, None)),
        -32602
    );
}

#[test]
fn client_info_fields_have_closed_shapes_and_lengths() {
    for client_info in [
        json!({"name":"fixture","version":"1","extra":true}),
        json!({"name":"fixture","version":"1","title":""}),
        json!({"name":"x".repeat(129),"version":"1"}),
        json!({"name":"fixture","version":"x".repeat(65)}),
    ] {
        let request = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/list","params":{
                "_meta":{
                    "io.modelcontextprotocol/protocolVersion":MODERN_PROTOCOL_VERSION,
                    "io.modelcontextprotocol/clientCapabilities":{},
                    "io.modelcontextprotocol/clientInfo":client_info
                }
            }
        });
        assert_eq!(
            error_code(&invoke(
                &request,
                Some(MODERN_PROTOCOL_VERSION),
                Some("tools/list"),
                None
            )),
            -32602
        );
    }
}

#[test]
fn all_declared_bounds_are_enforced_before_dispatch() {
    let oversized = vec![b' '; MAX_BODY_BYTES + 1];
    let response = dispatch(HttpRequest {
        content_type: Some(JSON_CONTENT_TYPE),
        accept: Some(ACCEPT),
        protocol_version: None,
        mcp_method: None,
        mcp_name: None,
        body: &oversized,
    });
    assert_eq!(response.status, 413);

    let long = "x".repeat(MAX_STRING_BYTES + 1);
    let body = modern("tools/list", json!(1), json!({"payload": long}));
    assert_eq!(
        error_code(&invoke(
            &body,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            None
        )),
        -32600
    );

    let oversized_id = json!({
        "jsonrpc":"2.0",
        "id":"x".repeat(MAX_STRING_BYTES + 1),
        "method":"tools/list",
        "params":{
            "_meta":{
                "io.modelcontextprotocol/protocolVersion":MODERN_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientCapabilities":{}
            }
        }
    });
    let response = invoke(
        &oversized_id,
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/list"),
        None,
    );
    assert_eq!(response.status, 400);
    assert_eq!(error_code(&response), -32600);
    assert_eq!(json_body(&response)["id"], Value::Null);
    assert!(response.body.as_ref().is_some_and(|body| body.len() < 256));

    let collection = vec![Value::Null; MAX_COLLECTION_ITEMS + 1];
    let body = modern("tools/list", json!(1), json!({"payload": collection}));
    assert_eq!(
        error_code(&invoke(
            &body,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            None
        )),
        -32600
    );

    let mut deep = Value::Null;
    for _ in 0..MAX_JSON_DEPTH {
        deep = json!([deep]);
    }
    let body = modern("tools/list", json!(1), json!({"payload": deep}));
    assert_eq!(
        error_code(&invoke(
            &body,
            Some(MODERN_PROTOCOL_VERSION),
            Some("tools/list"),
            None
        )),
        -32600
    );
}

#[test]
fn the_protocol_crate_cannot_reach_transport_database_or_product_crates() {
    let manifest = include_str!("../Cargo.toml");
    for forbidden in ["axum", "reqwest", "sqlx", "momo-db", "momo-messaging"] {
        assert!(
            !manifest.lines().any(|line| {
                let line = line.trim_start();
                line.starts_with(&format!("{forbidden} ="))
                    || line.starts_with(&format!("{forbidden}.workspace"))
            }),
            "forbidden protocol-core dependency: {forbidden}"
        );
    }
}

// ---------------------------------------------------------------------------
// HAP-E5 — the tool surface. The catalog is data (see `tools.rs`); what is
// pinned here is that the *protocol* half of it cannot drift: one view answers
// both questions, an invisible tool is indistinguishable from an absent one,
// and the two eras shape the result envelope and nothing else.
// ---------------------------------------------------------------------------

use momo_mcp::{
    dispatch_with_tools, tool_failure, tool_success, Outcome, ToolCapability, ToolEra, ToolFailure,
    ToolView,
};

fn scopes(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn full_view() -> ToolView {
    let granted = scopes(&[
        "agent:port:connect",
        "agent:inbox:read",
        "messages:read",
        "messages:write",
        "agent:jobs:read",
        "agent:runs:callback",
    ]);
    ToolView::intersect(&granted, &granted, ToolCapability::FULL)
}

fn invoke_with(
    body: &Value,
    version: Option<&str>,
    method: Option<&str>,
    name: Option<&str>,
    view: &ToolView,
) -> Outcome {
    let bytes = serde_json::to_vec(body).unwrap();
    dispatch_with_tools(
        HttpRequest {
            content_type: Some(JSON_CONTENT_TYPE),
            accept: Some(ACCEPT),
            protocol_version: version,
            mcp_method: method,
            mcp_name: name,
            body: &bytes,
        },
        view,
    )
}

fn response_of(outcome: Outcome) -> HttpResponse {
    match outcome {
        Outcome::Response(response) => response,
        Outcome::Tool(call) => panic!("expected a response, got a call to {}", call.tool.name),
    }
}

#[test]
fn both_eras_advertise_exactly_the_view_they_can_call() {
    let view = full_view();
    let modern_list = response_of(invoke_with(
        &modern("tools/list", json!(1), json!({})),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/list"),
        None,
        &view,
    ));
    let legacy_list = response_of(invoke_with(
        &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
        Some(LEGACY_PROTOCOL_VERSION),
        Some("tools/list"),
        None,
        &view,
    ));
    let modern_names: Vec<String> = json_body(&modern_list)["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect();
    let legacy_names: Vec<String> = json_body(&legacy_list)["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(modern_names, legacy_names);
    assert_eq!(
        modern_names,
        vec![
            "oort_inbox_read",
            "oort_conversation_read",
            "oort_message_post",
            "oort_jobs_claim",
            "oort_job_renew",
            "oort_job_release",
            "oort_run_event",
            "oort_run_complete",
        ]
    );
    // Every advertised tool is callable, in both eras.
    for name in &modern_names {
        assert!(view.callable(name).is_some(), "{name}");
    }
}

#[test]
fn a_connect_only_credential_lists_nothing_and_calls_nothing() {
    let connect = scopes(&["agent:port:connect"]);
    let view = ToolView::intersect(&connect, &connect, ToolCapability::FULL);
    let listed = response_of(invoke_with(
        &modern("tools/list", json!(1), json!({})),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/list"),
        None,
        &view,
    ));
    assert_eq!(json_body(&listed)["result"]["tools"], json!([]));

    let called = response_of(invoke_with(
        &modern(
            "tools/call",
            json!(2),
            json!({"name": "oort_message_post", "arguments": {}}),
        ),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_message_post"),
        &view,
    ));
    assert_eq!(called.status, 400);
    assert_eq!(error_code(&called), -32602);
    // Byte-identical to a tool that has never existed: no enumeration.
    let unknown = response_of(invoke_with(
        &modern(
            "tools/call",
            json!(2),
            json!({"name": "oort_not_a_tool", "arguments": {}}),
        ),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_not_a_tool"),
        &view,
    ));
    assert_eq!(json_body(&called), json_body(&unknown));
}

#[test]
fn an_admitted_call_carries_its_era_tool_and_bounded_arguments() {
    let view = full_view();
    let modern_call = invoke_with(
        &modern(
            "tools/call",
            json!("call-1"),
            json!({"name": "oort_inbox_read", "arguments": {"limit": 5}}),
        ),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_inbox_read"),
        &view,
    );
    let Outcome::Tool(call) = modern_call else {
        panic!("modern tools/call must be admitted");
    };
    assert_eq!(call.era, ToolEra::Modern);
    assert_eq!(call.tool.name, "oort_inbox_read");
    assert_eq!(call.tool.required_scope, "agent:inbox:read");
    assert_eq!(call.arguments, json!({"limit": 5}));
    assert_eq!(call.id, json!("call-1"));

    let legacy_call = invoke_with(
        &json!({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "oort_job_renew", "arguments": {"leaseHandle": "x"}}
        }),
        Some(LEGACY_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_job_renew"),
        &view,
    );
    let Outcome::Tool(call) = legacy_call else {
        panic!("legacy tools/call must be admitted");
    };
    assert_eq!(call.era, ToolEra::Legacy);
    assert_eq!(call.tool.name, "oort_job_renew");
    assert_eq!(call.arguments, json!({"leaseHandle": "x"}));
}

/// An omitted `arguments` is an empty object, never a missing key the adapter
/// has to special-case — one shape reaches every domain port.
#[test]
fn an_omitted_arguments_object_is_admitted_as_empty() {
    let view = full_view();
    let outcome = invoke_with(
        &modern("tools/call", json!(1), json!({"name": "oort_jobs_claim"})),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_jobs_claim"),
        &view,
    );
    let Outcome::Tool(call) = outcome else {
        panic!("admitted");
    };
    assert_eq!(call.arguments, json!({}));
}

/// Protocol validation still runs first: a mirror mismatch is refused before
/// the view is consulted, so a granted scope cannot buy a header shortcut.
#[test]
fn transport_mirrors_are_still_enforced_for_an_authorized_tool() {
    let view = full_view();
    let response = response_of(invoke_with(
        &modern(
            "tools/call",
            json!(1),
            json!({"name": "oort_message_post", "arguments": {}}),
        ),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_inbox_read"),
        &view,
    ));
    assert_eq!(error_code(&response), ERR_VERSION_MISMATCH);
}

#[test]
fn the_success_envelope_differs_only_by_era_metadata() {
    let view = full_view();
    let outcome = invoke_with(
        &modern("tools/call", json!(3), json!({"name": "oort_jobs_claim"})),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_jobs_claim"),
        &view,
    );
    let Outcome::Tool(mut call) = outcome else {
        panic!("admitted");
    };
    let modern_result = json_body(&tool_success(&call, json!({"jobs": []})));
    assert_eq!(modern_result["id"], json!(3));
    assert_eq!(modern_result["result"]["isError"], json!(false));
    assert_eq!(
        modern_result["result"]["structuredContent"],
        json!({"jobs": []})
    );
    assert_eq!(
        modern_result["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
        "{\"jobs\":[]}"
    );
    assert_eq!(modern_result["result"]["resultType"], json!("tools/call"));
    assert_eq!(
        modern_result["result"]["cache"],
        json!({"ttlSeconds": 0, "scope": "private"})
    );

    call.era = ToolEra::Legacy;
    let legacy_result = json_body(&tool_success(&call, json!({"jobs": []})));
    assert!(legacy_result["result"].get("resultType").is_none());
    assert!(legacy_result["result"].get("cache").is_none());
    assert_eq!(
        legacy_result["result"]["structuredContent"],
        modern_result["result"]["structuredContent"]
    );
}

/// Five failures, five fixed messages. A domain string here would answer
/// questions the fail-closed reads refuse to answer.
#[test]
fn every_tool_failure_is_one_of_five_fixed_answers() {
    let view = full_view();
    let outcome = invoke_with(
        &modern("tools/call", json!(9), json!({"name": "oort_jobs_claim"})),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_jobs_claim"),
        &view,
    );
    let Outcome::Tool(call) = outcome else {
        panic!("admitted");
    };
    for (failure, status, code) in [
        (ToolFailure::InvalidArguments, 400, -32602),
        (ToolFailure::NotAuthorized, 403, -32003),
        (ToolFailure::Unavailable, 409, -32004),
        (ToolFailure::Conflict, 409, -32005),
        (ToolFailure::Internal, 500, -32603),
    ] {
        let response = tool_failure(&call, failure);
        assert_eq!(response.status, status);
        let body = json_body(&response);
        assert_eq!(body["error"]["code"], json!(code));
        assert_eq!(body["id"], json!(9));
        assert!(body["error"].get("data").is_none());
    }
}

/// **The two layers that can refuse arguments answer identically.**
///
/// Schema enforcement lives in the protocol crate and domain refusals live in
/// the adapter. If those produced different envelopes, a caller could tell
/// "your field name is wrong" from "your value was rejected downstream" — a new
/// enumeration oracle bolted onto a surface built to avoid them.
#[test]
fn a_schema_refusal_is_byte_identical_to_the_adapter_invalid_arguments() {
    let view = full_view();
    let admitted = invoke_with(
        &modern("tools/call", json!(4), json!({"name": "oort_jobs_claim"})),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_jobs_claim"),
        &view,
    );
    let Outcome::Tool(call) = admitted else {
        panic!("admitted");
    };
    let adapter_shape = tool_failure(&call, ToolFailure::InvalidArguments);

    let schema_refusal = response_of(invoke_with(
        &modern(
            "tools/call",
            json!(4),
            json!({"name": "oort_jobs_claim", "arguments": {"limitt": 3}}),
        ),
        Some(MODERN_PROTOCOL_VERSION),
        Some("tools/call"),
        Some("oort_jobs_claim"),
        &view,
    ));
    assert_eq!(schema_refusal.status, adapter_shape.status);
    assert_eq!(json_body(&schema_refusal), json_body(&adapter_shape));
}

/// Every published constraint is enforced, and every violation is the same
/// verdict. Table-driven so a new catalog keyword cannot be added without a
/// case here.
#[test]
fn the_published_schema_is_enforced_field_by_field() {
    use momo_mcp::validate_arguments;

    let tool = |name: &str| {
        momo_mcp::TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == name)
            .expect("catalog tool")
    };
    let post = tool("oort_message_post");
    let good = json!({
        "channelId": "5b1f4a2e-0000-4000-8000-000000000001",
        "clientMsgId": "5b1f4a2e-0000-4000-8000-000000000002",
        "body": "hello"
    });
    assert!(validate_arguments(post, &good).is_ok());
    // `null` is how the wire omits an optional field.
    let mut with_null = good.clone();
    with_null["rootId"] = Value::Null;
    assert!(validate_arguments(post, &with_null).is_ok());

    for (tool_name, arguments, why) in [
        ("oort_message_post", json!({}), "required fields missing"),
        (
            "oort_message_post",
            json!({"channelId": "5b1f4a2e-0000-4000-8000-000000000001",
                   "clientMsgId": "5b1f4a2e-0000-4000-8000-000000000002",
                   "body": "hi", "rootID": "5b1f4a2e-0000-4000-8000-000000000003"}),
            "unknown field",
        ),
        (
            "oort_message_post",
            json!({"channelId": "nope",
                   "clientMsgId": "5b1f4a2e-0000-4000-8000-000000000002",
                   "body": "hi"}),
            "uuid format",
        ),
        (
            "oort_message_post",
            json!({"channelId": "5b1f4a2e-0000-4000-8000-000000000001",
                   "clientMsgId": "5b1f4a2e-0000-4000-8000-000000000002",
                   "body": ""}),
            "minLength",
        ),
        ("oort_inbox_read", json!({"limit": 0}), "minimum"),
        ("oort_inbox_read", json!({"limit": 101}), "maximum"),
        ("oort_inbox_read", json!({"limit": 1.5}), "integer type"),
        (
            "oort_jobs_claim",
            json!({"limit": "10"}),
            "string for integer",
        ),
        (
            "oort_run_event",
            json!({"leaseHandle": "x", "status": "succeeded"}),
            "enum",
        ),
        (
            "oort_run_complete",
            json!({"leaseHandle": "x", "status": "succeeded",
                   "usage": {"promptTokens": -1}}),
            "nested minimum",
        ),
        (
            "oort_run_complete",
            json!({"leaseHandle": "x", "status": "succeeded",
                   "usage": {"prompt_tokens": 1}}),
            "nested unknown field",
        ),
        ("oort_jobs_claim", json!([]), "arguments must be an object"),
    ] {
        assert_eq!(
            validate_arguments(tool(tool_name), &arguments),
            Err(ToolFailure::InvalidArguments),
            "{tool_name}: {why}"
        );
    }
}
