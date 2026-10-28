//! `oort mcp`: a stdio MCP server that carries each JSON-RPC message to the human MCP door
//! (`POST {server}/v1/mcp/me`, ADR-0216 D5) with the stored developer credential — so the AI
//! tool's configuration names a command and holds **no secret** (ADR-0216 D10: the first of the
//! three ways to attach a tool).
//!
//! * **stdout is JSON-RPC and nothing else**, one object per line, flushed per line. Anything a
//!   person should read goes to standard error and never includes a token or message content.
//! * **The era is the client's.** A request carrying the 2026-07-28 `_meta` protocol version is
//!   forwarded as that era (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`). Every other request
//!   is the 2025-11-25 era: the server accepts nothing else once a legacy session starts, so the
//!   client's `initialize` proposal is rewritten to that version (and the rewrite is said on
//!   standard error) and every later request carries the matching header. The server's own
//!   answer, including the version it settled on, goes back untouched.
//! * **The server's JSON-RPC answers are passed through verbatim**, whatever the HTTP status: the
//!   door's `-32601` for a method it does not have is the client's to read. Only a failure that
//!   has no JSON-RPC body (no login, a network fault, a 5xx page) is turned into one — and then
//!   from a closed vocabulary, never from the wire.
//! * Requests are handled one at a time, in order. A refresh happens under the store lock like
//!   every other command's.

use std::io::{BufRead, Write};

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};

use crate::api::{refusal, Reply};
use crate::error::{CliError, Kind};
use crate::output::{note, sanitize};
use crate::session::{Active, Ctx};

pub const LEGACY_VERSION: &str = "2025-11-25";
const META_VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
/// The door buffers at most this much (`momo_mcp::MAX_BODY_BYTES`); a longer line is refused here.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
const MCP_PATH: &str = "/v1/mcp/me";

const RPC_PARSE_ERROR: i64 = -32700;
const RPC_INVALID_REQUEST: i64 = -32600;
const RPC_INTERNAL: i64 = -32603;
const RPC_LOGIN_REQUIRED: i64 = -32001;
const RPC_NOT_ALLOWED: i64 = -32003;
const RPC_NOT_FOUND: i64 = -32004;
const RPC_RATE_LIMITED: i64 = -32029;

/// What to do with one line from the client.
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// Answer on the spot (the line was not a request the door could be asked).
    Local(Value),
    /// Nothing to do (a response to a request nobody made, a blank line).
    Ignore,
    /// Send to the door.
    Forward(Forward),
}

#[derive(Debug, PartialEq)]
pub struct Forward {
    pub body: Vec<u8>,
    pub headers: Vec<(&'static str, String)>,
    /// `None` for a notification: the door's answer is not forwarded to anyone.
    pub id: Option<Value>,
    pub rewritten_from: Option<String>,
}

fn rpc_error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

/// Decide what a line from the client becomes.
pub fn plan(line: &str) -> Plan {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            return Plan::Local(rpc_error(Value::Null, RPC_PARSE_ERROR, "parse error", None));
        }
    };
    let Value::Object(mut object) = value else {
        // A batch (or a bare scalar): this protocol has none. The door says so itself.
        return Plan::Forward(Forward {
            body: line.as_bytes().to_vec(),
            headers: vec![("MCP-Protocol-Version", LEGACY_VERSION.to_string())],
            id: Some(Value::Null),
            rewritten_from: None,
        });
    };
    let Some(method) = object
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        // A response (to something the door never asked) or junk: nothing to carry.
        return Plan::Ignore;
    };
    let id = object.get("id").cloned();

    let modern_version = object
        .get("params")
        .and_then(|params| params.get("_meta"))
        .and_then(|meta| meta.get(META_VERSION_KEY))
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut rewritten_from = None;
    let mut headers: Vec<(&'static str, String)> = Vec::new();
    match modern_version {
        Some(version) => {
            headers.push(("MCP-Protocol-Version", version));
            headers.push(("Mcp-Method", method.clone()));
            if method == "tools/call" {
                if let Some(name) = object
                    .get("params")
                    .and_then(|params| params.get("name"))
                    .and_then(Value::as_str)
                {
                    headers.push(("Mcp-Name", name.to_string()));
                }
            }
        }
        None => {
            headers.push(("MCP-Protocol-Version", LEGACY_VERSION.to_string()));
            if method == "initialize" {
                if let Some(Value::Object(params)) = object.get_mut("params") {
                    if let Some(Value::String(proposed)) = params.get("protocolVersion") {
                        if proposed != LEGACY_VERSION {
                            rewritten_from = Some(proposed.clone());
                            params.insert(
                                "protocolVersion".to_string(),
                                Value::String(LEGACY_VERSION.to_string()),
                            );
                        }
                    }
                }
            }
        }
    }
    let Ok(body) = serde_json::to_vec(&Value::Object(object)) else {
        return Plan::Local(rpc_error(
            id.unwrap_or(Value::Null),
            RPC_INTERNAL,
            "request could not be encoded",
            None,
        ));
    };
    Plan::Forward(Forward {
        body,
        headers,
        id,
        rewritten_from,
    })
}

/// A failure of this CLI (no login, the network, a refresh) or a door refusal that carried no
/// JSON-RPC body, as a JSON-RPC error. The message is ours, plus at most the server's own
/// sentence — control characters already replaced and cut to a bounded length by
/// [`crate::api::refusal`] — never a token, never anything the client sent.
fn error_to_rpc(id: Value, error: &CliError) -> Value {
    let code = match error.kind {
        Kind::LoginRequired => RPC_LOGIN_REQUIRED,
        Kind::Forbidden => RPC_NOT_ALLOWED,
        Kind::NotFound => RPC_NOT_FOUND,
        Kind::RateLimited => RPC_RATE_LIMITED,
        _ => RPC_INTERNAL,
    };
    let data = error
        .retry_after_seconds
        .map(|seconds| json!({ "retryAfterSeconds": seconds }));
    rpc_error(id, code, &error.message, data)
}

/// What goes back to the client for the door's answer, if anything.
pub fn answer(forward: &Forward, reply: &Reply) -> Option<Value> {
    // A notification is never answered, whatever the door said; a request always is, or its
    // client would wait for ever.
    let id = forward.id.clone()?;
    if let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(&reply.body) {
        let is_response = object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
            && (object.contains_key("result") || object.contains_key("error"));
        if is_response {
            return Some(Value::Object(object));
        }
    }
    if (200..300).contains(&reply.status) {
        return Some(rpc_error(
            id,
            RPC_INTERNAL,
            "서버 응답을 읽을 수 없어요.",
            None,
        ));
    }
    Some(error_to_rpc(id, &refusal(reply)))
}

/// One bounded line.
#[derive(Debug, PartialEq)]
pub enum Line {
    Eof,
    TooLong,
    Text(String),
}

pub fn read_line<R: BufRead>(reader: &mut R, max: usize) -> std::io::Result<Line> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut too_long = false;
    let mut saw_anything = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !saw_anything {
                return Ok(Line::Eof);
            }
            break;
        }
        saw_anything = true;
        let (chunk, done) = match available.iter().position(|byte| *byte == b'\n') {
            Some(position) => (&available[..position], Some(position + 1)),
            None => (available, None),
        };
        if !too_long {
            if buffer.len() + chunk.len() > max {
                too_long = true;
                buffer.clear();
            } else {
                buffer.extend_from_slice(chunk);
            }
        }
        let consumed = done.unwrap_or(available.len());
        reader.consume(consumed);
        if done.is_some() {
            break;
        }
    }
    if too_long {
        return Ok(Line::TooLong);
    }
    while buffer.last() == Some(&b'\r') {
        buffer.pop();
    }
    Ok(Line::Text(String::from_utf8_lossy(&buffer).into_owned()))
}

fn write_json(value: &Value) -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    handle.write_all(&line)?;
    handle.flush()
}

pub fn serve(ctx: &Ctx) -> Result<(), CliError> {
    // No login is an exit before the first byte, not a server that answers every call with an
    // error: the client shows our standard error next to "failed to start".
    let mut active = Active::resolve(ctx)?;
    let url = active.api().url(MCP_PATH);
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        let line = match read_line(&mut input, MAX_LINE_BYTES) {
            Ok(Line::Eof) => return Ok(()),
            Ok(Line::TooLong) => {
                let response = rpc_error(
                    Value::Null,
                    RPC_INVALID_REQUEST,
                    "request is too large",
                    None,
                );
                if write_json(&response).is_err() {
                    return Ok(());
                }
                continue;
            }
            Ok(Line::Text(text)) => text,
            Err(_) => return Ok(()),
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match plan(&line) {
            Plan::Ignore => None,
            Plan::Local(response) => Some(response),
            Plan::Forward(forward) => {
                if let Some(proposed) = &forward.rewritten_from {
                    note(&format!(
                        "oort mcp: initialize의 protocolVersion {}을 {LEGACY_VERSION}으로 맞춰 보내요.",
                        sanitize(proposed)
                    ));
                }
                let sent = active.send(ctx, &|api, token| {
                    let mut request = api
                        .client()
                        .post(&url)
                        .bearer_auth(token.expose())
                        .header(CONTENT_TYPE, "application/json")
                        .header(ACCEPT, "application/json, text/event-stream");
                    for (name, value) in &forward.headers {
                        request = request.header(*name, value);
                    }
                    request.body(forward.body.clone())
                });
                match sent {
                    Ok(reply) => answer(&forward, &reply),
                    Err(error) => match forward.id.clone() {
                        Some(id) => Some(error_to_rpc(id, &error)),
                        None => {
                            note(&format!(
                                "oort mcp: 알림을 보내지 못했어요({}).",
                                error.code
                            ));
                            None
                        }
                    },
                }
            }
        };
        if let Some(response) = response {
            if write_json(&response).is_err() {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn forward(line: &str) -> Forward {
        match plan(line) {
            Plan::Forward(forward) => forward,
            other => panic!("expected a forward, got {other:?}"),
        }
    }

    fn header<'a>(forward: &'a Forward, name: &str) -> Option<&'a str> {
        forward
            .headers
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn body(forward: &Forward) -> Value {
        serde_json::from_slice(&forward.body).expect("a JSON body")
    }

    #[test]
    fn a_legacy_initialize_is_proposed_as_the_one_version_the_door_speaks() {
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}"#;
        let sent = forward(line);
        assert_eq!(body(&sent)["params"]["protocolVersion"], LEGACY_VERSION);
        assert_eq!(sent.rewritten_from.as_deref(), Some("2025-06-18"));
        assert_eq!(header(&sent, "MCP-Protocol-Version"), Some(LEGACY_VERSION));
        assert_eq!(
            header(&sent, "Mcp-Method"),
            None,
            "no mirror headers in the legacy era"
        );
        // everything else of the request is the client's, untouched
        assert_eq!(body(&sent)["params"]["clientInfo"]["name"], "c");
        assert_eq!(body(&sent)["id"], 1);

        let already = forward(
            r#"{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}"#,
        );
        assert_eq!(already.rewritten_from, None);
    }

    #[test]
    fn every_later_legacy_request_carries_the_version_header_and_no_mirror_headers() {
        for line in [
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"oort_me_whoami","arguments":{}}}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#,
        ] {
            let sent = forward(line);
            assert_eq!(
                header(&sent, "MCP-Protocol-Version"),
                Some(LEGACY_VERSION),
                "{line}"
            );
            assert_eq!(header(&sent, "Mcp-Method"), None, "{line}");
            assert_eq!(header(&sent, "Mcp-Name"), None, "{line}");
        }
    }

    #[test]
    fn a_modern_request_keeps_its_era_and_gets_its_mirror_headers() {
        let call = forward(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"oort_me_read","arguments":{"channelId":"c"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#,
        );
        assert_eq!(header(&call, "MCP-Protocol-Version"), Some("2026-07-28"));
        assert_eq!(header(&call, "Mcp-Method"), Some("tools/call"));
        assert_eq!(header(&call, "Mcp-Name"), Some("oort_me_read"));
        assert_eq!(call.rewritten_from, None);
        let list = forward(
            r#"{"jsonrpc":"2.0","id":10,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#,
        );
        assert_eq!(header(&list, "Mcp-Method"), Some("tools/list"));
        assert_eq!(header(&list, "Mcp-Name"), None);
    }

    #[test]
    fn a_notification_has_no_id_and_so_nothing_is_ever_answered() {
        let sent = forward(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!(sent.id, None);
        let accepted = Reply {
            status: 202,
            retry_after_seconds: None,
            body: Vec::new(),
        };
        assert_eq!(answer(&sent, &accepted), None);
        // even a body-bearing failure of a notification is not forwarded to the client
        let failed = Reply {
            status: 500,
            retry_after_seconds: None,
            body: b"oops".to_vec(),
        };
        assert_eq!(answer(&sent, &failed), None);
    }

    #[test]
    fn lines_that_are_not_requests_are_not_forwarded() {
        match plan("not json") {
            Plan::Local(response) => {
                assert_eq!(response["error"]["code"], RPC_PARSE_ERROR);
                assert_eq!(response["id"], Value::Null);
            }
            other => panic!("{other:?}"),
        }
        // a response from the client (we never asked anything), and an object with no method
        assert_eq!(
            plan(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#),
            Plan::Ignore
        );
        assert_eq!(plan(r#"{"hello":1}"#), Plan::Ignore);
    }

    fn request(id: i64) -> Forward {
        forward(&format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/list"}}"#
        ))
    }

    #[test]
    fn the_doors_json_rpc_answers_pass_through_whatever_the_http_status() {
        let ok = Reply {
            status: 200,
            retry_after_seconds: None,
            body: br#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#.to_vec(),
        };
        assert_eq!(
            answer(&request(1), &ok),
            Some(json!({"jsonrpc":"2.0","id":1,"result":{"tools":[]}}))
        );
        let missing = Reply {
            status: 400,
            retry_after_seconds: None,
            body:
                br#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"method not found"}}"#
                    .to_vec(),
        };
        let passed = answer(&request(2), &missing).expect("passed through");
        assert_eq!(passed["error"]["code"], -32601);
        let limited = Reply {
            status: 429,
            retry_after_seconds: Some(9),
            body: br#"{"jsonrpc":"2.0","id":3,"error":{"code":-32029,"message":"rate limit exceeded"}}"#.to_vec(),
        };
        assert_eq!(
            answer(&request(3), &limited).expect("passed")["error"]["code"],
            -32029
        );
    }

    #[test]
    fn a_failure_without_a_json_rpc_body_becomes_a_bounded_printable_error() {
        // The server's own words may be anything, escape sequences and a flood included; what
        // reaches the client's model is one sentence of printable text of bounded length.
        let wire = format!("SERVERSAYS\u{1b}[2J\u{7}{}", "x".repeat(5000));
        for (status, expected_code) in [
            (401, RPC_LOGIN_REQUIRED),
            (403, RPC_NOT_ALLOWED),
            (429, RPC_RATE_LIMITED),
            (502, RPC_INTERNAL),
        ] {
            let reply = Reply {
                status,
                retry_after_seconds: (status == 429).then_some(4),
                body: json!({ "error": { "message": wire, "code": "dev_scope_denied" } })
                    .to_string()
                    .into_bytes(),
            };
            let response = answer(&request(7), &reply).expect("an error response");
            assert_eq!(response["id"], 7);
            assert_eq!(response["error"]["code"], expected_code, "{status}");
            let message = response["error"]["message"].as_str().expect("a message");
            assert!(
                !message.chars().any(char::is_control),
                "{status}: {message:?}"
            );
            assert!(
                message.chars().count() < 400,
                "{status}: {} chars",
                message.chars().count()
            );
        }
        // an empty-bodied 429 is still an answer for a request, with the wait carried as data
        let limited = Reply {
            status: 429,
            retry_after_seconds: Some(4),
            body: Vec::new(),
        };
        let response = answer(&request(8), &limited).expect("a request is always answered");
        assert_eq!(response["error"]["code"], RPC_RATE_LIMITED);
        assert_eq!(response["error"]["data"]["retryAfterSeconds"], 4);
        // and so is a success with nothing in it: the client must not wait for ever
        let empty = Reply {
            status: 200,
            retry_after_seconds: None,
            body: Vec::new(),
        };
        assert_eq!(
            answer(&request(9), &empty).expect("answered")["error"]["code"],
            RPC_INTERNAL
        );
    }

    #[test]
    fn a_line_is_read_up_to_a_bound_and_the_overlong_one_is_skipped_whole() {
        let mut input = Cursor::new(b"first\r\nsecond\n".to_vec());
        assert_eq!(
            read_line(&mut input, 64).unwrap(),
            Line::Text("first".into())
        );
        assert_eq!(
            read_line(&mut input, 64).unwrap(),
            Line::Text("second".into())
        );
        assert_eq!(read_line(&mut input, 64).unwrap(), Line::Eof);

        let mut long = vec![b'a'; 100];
        long.push(b'\n');
        long.extend_from_slice(b"after\n");
        let mut input = Cursor::new(long);
        assert_eq!(read_line(&mut input, 64).unwrap(), Line::TooLong);
        assert_eq!(
            read_line(&mut input, 64).unwrap(),
            Line::Text("after".into()),
            "the next line is intact"
        );

        let mut input = Cursor::new(b"no newline at the end".to_vec());
        assert_eq!(
            read_line(&mut input, 64).unwrap(),
            Line::Text("no newline at the end".into())
        );
        assert_eq!(read_line(&mut input, 64).unwrap(), Line::Eof);
    }
}
