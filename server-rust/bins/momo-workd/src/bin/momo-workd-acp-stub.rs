//! TEST-ONLY fake ACP agent for `momo-workd`'s invariant and conformance tests.
//! Not shipped: no release path builds it, and it does nothing but speak a
//! scripted slice of ACP over stdio.
//!
//! Flags (all optional):
//!   --record PATH        append every received message, plus argv/cwd and the
//!                        permission outcome, to PATH as JSON lines
//!   --mode ID            `currentModeId` reported by `session/new` (default `default`)
//!   --no-modes           omit `modes` from `session/new`
//!   --permission         during each prompt, ask `session/request_permission`
//!   --escape-mode ID     during each prompt, report `current_mode_update` → ID
//!   --escape-via-config  report that escape as `config_option_update` instead
//!   --hang               never answer `session/prompt` until cancelled
//!   --leak               during each prompt, stream synthetic credentials in
//!                        slow chunks that split a token and a PEM header
//!
//! Anything else on the command line (the host's isolation arguments) is
//! accepted and recorded.

use std::fs::OpenOptions;
use std::io::{BufRead as _, Write as _};

use serde_json::{json, Value};

struct Options {
    record: Option<String>,
    mode: String,
    modes: bool,
    permission: bool,
    escape_mode: Option<String>,
    escape_via_config: bool,
    hang: bool,
    leak: bool,
}

fn parse() -> Options {
    let mut options = Options {
        record: None,
        mode: "default".to_string(),
        modes: true,
        permission: false,
        escape_mode: None,
        escape_via_config: false,
        hang: false,
        leak: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--record" => options.record = args.next(),
            "--mode" => options.mode = args.next().unwrap_or_default(),
            "--no-modes" => options.modes = false,
            "--permission" => options.permission = true,
            "--escape-mode" => options.escape_mode = args.next(),
            "--escape-via-config" => options.escape_via_config = true,
            "--hang" => options.hang = true,
            "--leak" => options.leak = true,
            _ => {}
        }
    }
    options
}

struct Stub {
    options: Options,
    out: std::io::Stdout,
    lines: std::io::Lines<std::io::StdinLock<'static>>,
    next_id: i64,
}

impl Stub {
    fn record(&self, entry: Value) {
        if let Some(path) = &self.options.record {
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{entry}");
            }
        }
    }

    fn send(&mut self, message: Value) {
        let mut out = self.out.lock();
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    }

    fn respond(&mut self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn update(&mut self, session_id: &str, update: Value) {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": session_id, "update": update},
        }));
    }

    /// Read the next message, recording it. `None` on EOF.
    fn read(&mut self) -> Option<Value> {
        loop {
            let line = self.lines.next()?.ok()?;
            if line.trim().is_empty() {
                continue;
            }
            let message: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            self.record(json!({"received": message}));
            return Some(message);
        }
    }

    fn prompt(&mut self, id: &Value, params: &Value) {
        let session_id = params["sessionId"].as_str().unwrap_or_default().to_string();
        let text = params["prompt"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        self.update(
            &session_id,
            json!({"sessionUpdate": "agent_message_chunk",
                   "content": {"type": "text", "text": format!("stub heard: {text}")}}),
        );
        if self.options.leak {
            // Synthetic, well-formed credentials — never real, and assembled
            // with `concat!` so this source carries no scanner-shaped literal.
            // The pauses are longer than the host's age flush, so its flushes
            // land inside the `sk-ant-` token and inside the PEM header.
            for piece in [
                concat!(" leak sk-", "ant-api03-"),
                concat!(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gh ghp",
                    "_abcdefghijklmnopqrstuvwxyz0123456789 aws AKIA",
                    "ABCDEFGHIJKLMNOP\n-----BEGIN OPENSSH PRIV"
                ),
                "ATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n",
                concat!(
                    "-----END OPENSSH PRIVATE KEY-----\nslack xoxb",
                    "-1234567890-abcdefghij jwt eyJhbGciOiJIUzI1NiJ9",
                    ".",
                    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
                    ".",
                    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end"
                ),
            ] {
                self.update(
                    &session_id,
                    json!({"sessionUpdate": "agent_message_chunk",
                           "content": {"type": "text", "text": piece}}),
                );
                std::thread::sleep(std::time::Duration::from_millis(700));
            }
        }
        self.update(
            &session_id,
            json!({"sessionUpdate": "agent_thought_chunk",
                   "content": {"type": "text", "text": "private reasoning"}}),
        );
        self.update(
            &session_id,
            json!({"sessionUpdate": "plan", "entries": [
                {"content": "Read the code", "priority": "high", "status": "in_progress"},
                {"content": "Report back", "priority": "medium", "status": "pending"}
            ]}),
        );
        self.update(
            &session_id,
            json!({"sessionUpdate": "tool_call", "toolCallId": "call-1",
                   "title": "Run `cat ~/.ssh/id_ed25519`", "kind": "execute",
                   "status": "pending", "rawInput": {"command": "cat ~/.ssh/id_ed25519"}}),
        );
        if self.options.permission {
            let request_id = self.next_id;
            self.next_id += 1;
            self.send(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/request_permission",
                "params": {
                    "sessionId": session_id,
                    "toolCall": {"toolCallId": "call-1", "title": "Run `cat ~/.ssh/id_ed25519`", "kind": "execute"},
                    "options": [
                        {"optionId": "allow-always", "name": "Always Allow", "kind": "allow_always"},
                        {"optionId": "allow-once", "name": "Allow", "kind": "allow_once"},
                        {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
                    ]
                }
            }));
            // Wait for the host's answer; anything else that arrives meanwhile is
            // recorded by `read` and otherwise ignored.
            let outcome = loop {
                match self.read() {
                    None => return,
                    Some(message) if message["id"] == json!(request_id) => {
                        break message["result"]["outcome"].clone();
                    }
                    Some(_) => {}
                }
            };
            self.record(json!({"permission_outcome": outcome}));
            let allowed = outcome["outcome"] == "selected"
                && outcome["optionId"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("allow"));
            self.update(
                &session_id,
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "call-1",
                       "status": if allowed { "completed" } else { "failed" }}),
            );
        }
        if let Some(mode) = self.options.escape_mode.clone() {
            let update = if self.options.escape_via_config {
                json!({"sessionUpdate": "config_option_update", "configOptions": [
                    {"id": "model", "name": "Model", "category": "model", "type": "select",
                     "currentValue": "stub-model", "options": []},
                    {"id": "mode", "name": "Mode", "category": "mode", "type": "select",
                     "currentValue": mode, "options": []}
                ]})
            } else {
                json!({"sessionUpdate": "current_mode_update", "currentModeId": mode})
            };
            self.update(&session_id, update);
        }
        if self.options.hang {
            loop {
                match self.read() {
                    None => return,
                    Some(message) if message["method"] == "session/cancel" => {
                        self.respond(id, json!({"stopReason": "cancelled"}));
                        return;
                    }
                    Some(_) => {}
                }
            }
        }
        self.update(
            &session_id,
            json!({"sessionUpdate": "agent_message_chunk",
                   "content": {"type": "text", "text": " — done."}}),
        );
        self.respond(id, json!({"stopReason": "end_turn"}));
    }

    fn serve(&mut self) {
        while let Some(message) = self.read() {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            match message["method"].as_str() {
                Some("initialize") => self.respond(
                    &id,
                    json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": false},
                           "authMethods": []}),
                ),
                Some("session/new") => {
                    let mut result = json!({"sessionId": "stub-session-1"});
                    if self.options.modes {
                        result["modes"] = json!({
                            "currentModeId": self.options.mode,
                            "availableModes": [
                                {"id": "default", "name": "Default"},
                                {"id": "acceptEdits", "name": "Accept Edits"},
                                {"id": "plan", "name": "Plan"},
                                {"id": "bypassPermissions", "name": "Bypass Permissions"}
                            ]
                        });
                    }
                    self.respond(&id, result);
                }
                Some("session/prompt") => {
                    let params = message["params"].clone();
                    self.prompt(&id, &params);
                }
                Some(_) if id.is_null() => {}
                Some(_) => self.send(json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": {"code": -32601, "message": "stub: method not found"}
                })),
                None => {}
            }
        }
    }
}

fn main() {
    let options = parse();
    let stdin: &'static std::io::Stdin = Box::leak(Box::new(std::io::stdin()));
    let mut stub = Stub {
        options,
        out: std::io::stdout(),
        lines: stdin.lock().lines(),
        next_id: 9000,
    };
    stub.record(json!({
        "argv": std::env::args().skip(1).collect::<Vec<_>>(),
        "cwd": std::env::current_dir().map(|dir| dir.display().to_string()).unwrap_or_default(),
        "env_has_momo": std::env::vars().any(|(key, _)| key.starts_with("MOMO_")),
        "env_isolation": {
            "INITIAL_AGENT_MODE": std::env::var("INITIAL_AGENT_MODE").ok(),
            "CODEX_CONFIG": std::env::var("CODEX_CONFIG").ok(),
        },
    }));
    stub.serve();
}
