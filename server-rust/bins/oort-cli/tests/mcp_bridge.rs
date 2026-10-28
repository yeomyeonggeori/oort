//! `oort mcp` as an AI tool would start it: a child process speaking newline-delimited JSON-RPC on
//! standard input and output, with a recording mock where the human MCP door would be. The same
//! bridge against the real door is in `server_e2e_pg.rs`.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `the_bridge_speaks_the_doors_era_and_passes_its_answers_through` | initialize is proposed as 2025-11-25, every request carries the version header and the bearer, no Origin / Mcp-Method in that era, the 2026 era keeps its own headers, the door's answers (an error included) come back verbatim, standard output is JSON-RPC lines only | the version rewrite, a header or the pass-through is dropped |
//! | `a_ended_login_is_an_error_to_the_client_and_the_bridge_keeps_serving` | 401 → JSON-RPC -32001 with the request's id, the next request is still served | the bridge exits or answers nothing |
//! | `an_overlong_line_is_refused_and_the_next_request_is_served` | 70 KiB line → -32600 id null, the next line intact | the line bound or the resync is dropped |
//! | `without_a_login_the_bridge_exits_before_speaking` | exit 3, nothing on standard output | it starts serving without a credential |

mod common;

use std::io::Write;
use std::process::Stdio;

use common::*;
use serde_json::{json, Value};

const LEGACY: &str = "2025-11-25";
const MODERN: &str = "2026-07-28";

fn door() -> impl Fn(&Request) -> Response + Send + Sync + 'static {
    let token = card();
    move |request: &Request| {
        if request.path != "/v1/mcp/me" || request.method != "POST" {
            return Response::json(404, &json!({"error": {"message": "not found"}}));
        }
        if request.header("authorization") != Some(format!("Bearer {token}").as_str()) {
            return Response::json(401, &json!({"error": {"message": "invalid token"}}));
        }
        let body = request.json();
        let id = body.get("id").cloned().unwrap_or(Value::Null);
        match body["method"].as_str().unwrap_or("") {
            "initialize" => Response::json(
                200,
                &json!({"jsonrpc": "2.0", "id": id, "result": {
                    "protocolVersion": LEGACY,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "oort-me", "version": "test"},
                }}),
            ),
            "notifications/initialized" => Response::empty(202),
            "tools/list" => Response::json(
                200,
                &json!({"jsonrpc": "2.0", "id": id, "result": {"tools": [{"name": "oort_me_whoami"}]}}),
            ),
            "tools/call" => Response::json(
                200,
                &json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": "{}"}], "structuredContent": {}, "isError": false}}),
            ),
            "ping" => Response::json(200, &json!({"jsonrpc": "2.0", "id": id, "result": {}})),
            _ => Response::json(
                400,
                &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}}),
            ),
        }
    }
}

/// Start `oort mcp`, send `lines`, close standard input, and return what it printed.
fn converse(home: &Home, origin: &str, lines: &[String]) -> std::process::Output {
    let mut child = home
        .command()
        .env("OORT_TOKEN", card())
        .args(["mcp", "--server", origin])
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn oort mcp");
    {
        let mut stdin = child.stdin.take().expect("stdin");
        for line in lines {
            stdin.write_all(line.as_bytes()).expect("write");
            stdin.write_all(b"\n").expect("write");
        }
    }
    child.wait_with_output().expect("wait")
}

fn rpc(id: u64, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

#[test]
fn the_bridge_speaks_the_doors_era_and_passes_its_answers_through() {
    let mock = Mock::start(door());
    let home = Home::new();
    let lines = vec![
        rpc(
            1,
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "tool", "version": "1"}}),
        ),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        rpc(2, "tools/list", json!({})),
        rpc(
            3,
            "tools/call",
            json!({"name": "oort_me_whoami", "arguments": {}}),
        ),
        rpc(4, "resources/list", json!({})),
        // the 2026 era carries its version in `_meta` and mirrors method and name in headers
        rpc(
            5,
            "tools/call",
            json!({"name": "oort_me_whoami", "arguments": {}, "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientCapabilities": {},
            }}),
        ),
    ];
    let out = converse(&home, &mock.origin(), &lines);
    assert_eq!(code(&out), 0, "{}", stderr(&out));

    // standard output is JSON-RPC and nothing else: five answers, the notification has none
    let answers: Vec<Value> = stdout(&out)
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("not JSON ({error}): {line:?}"))
        })
        .collect();
    assert_eq!(answers.len(), 5, "{answers:?}");
    for answer in &answers {
        assert_eq!(answer["jsonrpc"], "2.0", "{answer}");
    }
    let ids: Vec<_> = answers.iter().map(|answer| answer["id"].clone()).collect();
    assert_eq!(ids, [json!(1), json!(2), json!(3), json!(4), json!(5)]);
    assert_eq!(
        answers[0]["result"]["protocolVersion"], LEGACY,
        "the door's own answer, verbatim"
    );
    assert_eq!(
        answers[3]["error"]["code"], -32601,
        "a door refusal is the client's to read"
    );

    let seen = mock.requests();
    assert_eq!(seen.len(), 6);
    for request in &seen {
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {}", card()).as_str())
        );
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(
            request.header("accept"),
            Some("application/json, text/event-stream")
        );
        assert_eq!(
            request.header("origin"),
            None,
            "a browser-page marker must not be sent"
        );
        assert!(request.query.is_empty());
    }
    assert_eq!(
        seen[0].json()["params"]["protocolVersion"],
        LEGACY,
        "the proposal was rewritten"
    );
    assert_eq!(
        seen[0].json()["params"]["clientInfo"]["name"],
        "tool",
        "nothing else of it was"
    );
    for request in &seen[..5] {
        assert_eq!(request.header("mcp-protocol-version"), Some(LEGACY));
        assert_eq!(request.header("mcp-method"), None);
        assert_eq!(request.header("mcp-name"), None);
    }
    assert_eq!(seen[5].header("mcp-protocol-version"), Some(MODERN));
    assert_eq!(seen[5].header("mcp-method"), Some("tools/call"));
    assert_eq!(seen[5].header("mcp-name"), Some("oort_me_whoami"));

    let needles = leak_needles(&card());
    assert_no_leak("stdout", &stdout(&out), &needles);
    assert_no_leak("stderr", &stderr(&out), &needles);
    assert!(
        stderr(&out).contains("2025-06-18"),
        "the rewrite is said, on standard error: {}",
        stderr(&out)
    );
}

#[test]
fn a_ended_login_is_an_error_to_the_client_and_the_bridge_keeps_serving() {
    let mock = Mock::start(|_| {
        Response::json(
            401,
            &json!({"error": {"message": "invalid token SECRETWIRE"}}),
        )
    });
    let home = Home::new();
    let lines = vec![rpc(1, "tools/list", json!({})), rpc(2, "ping", json!({}))];
    let out = converse(&home, &mock.origin(), &lines);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let answers: Vec<Value> = stdout(&out)
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON"))
        .collect();
    assert_eq!(answers.len(), 2, "{answers:?}");
    assert_eq!(
        (answers[0]["id"].clone(), answers[1]["id"].clone()),
        (json!(1), json!(2))
    );
    for answer in &answers {
        assert_eq!(answer["error"]["code"], -32001, "{answer}");
        assert!(answer["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("oort login")));
    }
    assert_eq!(
        mock.count(),
        2,
        "both requests reached the door: the bridge did not give up after the first"
    );
    assert_no_leak("stdout", &stdout(&out), &leak_needles(&card()));
}

#[test]
fn an_overlong_line_is_refused_and_the_next_request_is_served() {
    let mock = Mock::start(door());
    let home = Home::new();
    let big = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"ping","params":{{"pad":"{}"}}}}"#,
        "x".repeat(70 * 1024)
    );
    let out = converse(&home, &mock.origin(), &[big, rpc(2, "ping", json!({}))]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let answers: Vec<Value> = stdout(&out)
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON"))
        .collect();
    assert_eq!(answers.len(), 2, "{answers:?}");
    assert_eq!(answers[0]["error"]["code"], -32600);
    assert_eq!(answers[0]["id"], Value::Null);
    assert_eq!(answers[1]["id"], 2);
    assert_eq!(answers[1]["result"], json!({}));
    assert_eq!(mock.count(), 1, "the oversized request was never sent");
}

#[test]
fn without_a_login_the_bridge_exits_before_speaking() {
    let home = Home::new();
    let mut child = home
        .command()
        .arg("mcp")
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn");
    drop(child.stdin.take());
    let out = child.wait_with_output().expect("wait");
    assert_eq!(code(&out), 3, "{}", stderr(&out));
    assert!(
        stdout(&out).is_empty(),
        "nothing but JSON-RPC may ever be written to standard output"
    );
    assert!(stderr(&out).contains("oort login"), "{}", stderr(&out));
}
