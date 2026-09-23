//! ACP `session/update` → the server's curated session events (ADR-0130 D1,
//! ADR-0137 / ADR-0114 D3 — the phone sees a curated stream, never raw ACP).
//!
//! The server accepts four event types on the host-signed PATCH and closes each
//! payload to a fixed key set (`routes/work_sessions.rs::validated_acp_event`).
//! This projection is the host's half of that contract, and it is narrower than
//! what the server would accept, on purpose:
//!
//! | ACP update | event | carried |
//! |---|---|---|
//! | `agent_message_chunk` (text) | `agent.partial` | the agent's answer text, coalesced by the relay |
//! | `tool_call` | `agent.status` | the ACP tool **kind** (`execute`, `edit`, …) — never the title |
//! | `plan` | `agent.status` | the plan entries (content, status, priority) |
//! | `current_mode_update`, `config_option_update` (the `mode` option) | — | handed to the mode policy, not relayed |
//! | everything else | — | dropped |
//!
//! A tool call's `title` is left out because agents put the command line or the
//! file path there (`Run \`cat ~/.ssh/config\``), and ADR-0004 keeps commands and
//! host paths off the server. Thought chunks are left out because they are
//! reasoning, not the answer, and at token granularity they would spend the
//! session's event budget (240/min) on text nobody asked to see.
//!
//! Text that does cross is display-sanitised: bidirectional-override and
//! invisible formatting characters are removed, as are C0 controls other than
//! newline and tab, so a relayed line cannot render differently from what it is
//! (ADR-0188 D5 정화 규칙, event-stream half).

use serde_json::{json, Map, Value};

/// Most plan entries relayed from one `plan` update.
pub const MAX_PLAN_ENTRIES: usize = 50;
/// Longest plan entry, in characters, after sanitising.
pub const MAX_PLAN_ENTRY_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub enum Projection {
    /// Agent-authored answer text, for `agent.partial` (already sanitised).
    Text(String),
    /// An `agent.status` payload, without the session-binding keys.
    Status(Map<String, Value>),
    /// The agent reports a permission-mode change; the policy decides.
    ModeChanged(String),
    Ignore,
}

/// Project one `session/update` notification's params.
pub fn project(params: &Value) -> Projection {
    let Some(update) = params.get("update").and_then(Value::as_object) else {
        return Projection::Ignore;
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "agent_message_chunk" => {
            let content = update.get("content");
            let is_text = content
                .and_then(|content| content.get("type"))
                .and_then(Value::as_str)
                == Some("text");
            match content
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
            {
                Some(text) if is_text => {
                    let clean = sanitize_text(text);
                    if clean.is_empty() {
                        Projection::Ignore
                    } else {
                        Projection::Text(clean)
                    }
                }
                _ => Projection::Ignore,
            }
        }
        "tool_call" => {
            let tool_kind = update
                .get("kind")
                .and_then(Value::as_str)
                .map(tool_kind)
                .unwrap_or("other");
            Projection::Status(status_payload(
                "streaming",
                [("tool_call_name", json!(tool_kind))],
            ))
        }
        "plan" => {
            let entries: Vec<Value> = update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(plan_entry)
                        .take(MAX_PLAN_ENTRIES)
                        .collect()
                })
                .unwrap_or_default();
            Projection::Status(status_payload(
                "thinking",
                [("has_plan", json!(true)), ("plan", Value::Array(entries))],
            ))
        }
        "current_mode_update" => update
            .get("currentModeId")
            .or_else(|| update.get("modeId"))
            .and_then(Value::as_str)
            .map(|mode| Projection::ModeChanged(mode.to_string()))
            // A mode update we cannot read is a mode we cannot vouch for.
            .unwrap_or_else(|| Projection::ModeChanged(String::new())),
        // Session config options carry the mode too, and an adapter may announce
        // a mode change only this way — codex-acp does, when a slash command in
        // a prompt sets the `mode` option.
        "config_option_update" => {
            let mode_option = update
                .get("configOptions")
                .and_then(Value::as_array)
                .and_then(|options| options.iter().find(|option| is_mode_option(option)));
            match mode_option {
                Some(option) => Projection::ModeChanged(
                    option
                        .get("currentValue")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                ),
                None => Projection::Ignore,
            }
        }
        _ => Projection::Ignore,
    }
}

fn is_mode_option(option: &Value) -> bool {
    option.get("category").and_then(Value::as_str) == Some("mode")
        || option.get("id").and_then(Value::as_str) == Some("mode")
}

/// An `agent.status` payload: `phase` ∈ {thinking, streaming}, `run_status`
/// always `running` (the only values the server accepts), plus `extra`.
pub fn status_payload<const N: usize>(
    phase: &str,
    extra: [(&str, Value); N],
) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("phase".into(), json!(phase));
    payload.insert("run_status".into(), json!("running"));
    for (key, value) in extra {
        payload.insert(key.into(), value);
    }
    payload
}

/// ACP `ToolKind` is a closed vocabulary; anything else collapses to `other`.
fn tool_kind(raw: &str) -> &'static str {
    match raw {
        "read" => "read",
        "edit" => "edit",
        "delete" => "delete",
        "move" => "move",
        "search" => "search",
        "execute" => "execute",
        "think" => "think",
        "fetch" => "fetch",
        "switch_mode" => "switch_mode",
        _ => "other",
    }
}

fn plan_entry(entry: &Value) -> Option<Value> {
    let content = entry.get("content").and_then(Value::as_str)?;
    let content: String = sanitize_text(content)
        .chars()
        .take(MAX_PLAN_ENTRY_CHARS)
        .collect();
    if content.trim().is_empty() {
        return None;
    }
    let status = match entry.get("status").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("in_progress") => "in_progress",
        _ => "pending",
    };
    let priority = match entry.get("priority").and_then(Value::as_str) {
        Some("high") => "high",
        Some("low") => "low",
        _ => "medium",
    };
    Some(json!({"content": content, "status": status, "priority": priority}))
}

/// Remove characters that change how text renders without being visible:
/// bidi embeddings/overrides/isolates and marks, zero-width space and word
/// joiner family, BOM, Mongolian vowel separator, and C0/C1 controls other than
/// `\n` and `\t`. ZWJ/ZWNJ stay — emoji sequences and several scripts need them.
pub fn sanitize_text(text: &str) -> String {
    text.chars()
        .filter(|character| !is_disallowed(*character))
        .collect()
}

fn is_disallowed(character: char) -> bool {
    matches!(character,
        '\u{202A}'..='\u{202E}'
        | '\u{2066}'..='\u{2069}'
        | '\u{200E}' | '\u{200F}' | '\u{061C}'
        | '\u{200B}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}' | '\u{180E}'
        | '\u{0080}'..='\u{009F}'
    ) || (character.is_control() && character != '\n' && character != '\t')
}

/// Split `text` into pieces of at most `limit` UTF-8 bytes, on char boundaries.
pub fn chunk_utf8(text: &str, limit: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if current.len() + character.len_utf8() > limit {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(value: Value) -> Value {
        json!({"sessionId": "s", "update": value})
    }

    #[test]
    fn answer_text_becomes_partial_text() {
        let projected = project(&update(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "hello"}
        })));
        assert_eq!(projected, Projection::Text("hello".into()));
        // Non-text content is not relayed.
        let image = project(&update(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "image", "data": "AAAA", "mimeType": "image/png"}
        })));
        assert_eq!(image, Projection::Ignore);
    }

    #[test]
    fn a_tool_call_relays_its_kind_and_never_its_title() {
        let projected = project(&update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "Run `cat ~/.ssh/id_ed25519`",
            "kind": "execute",
            "status": "pending",
            "rawInput": {"command": "cat ~/.ssh/id_ed25519"},
            "locations": [{"path": "/Users/me/.ssh/id_ed25519"}]
        })));
        let Projection::Status(payload) = projected else {
            panic!("tool_call must project to a status");
        };
        assert_eq!(payload["tool_call_name"], "execute");
        assert_eq!(payload["phase"], "streaming");
        assert_eq!(payload["run_status"], "running");
        let encoded = serde_json::to_string(&payload).unwrap();
        assert!(
            !encoded.contains("ssh"),
            "title/rawInput/locations never cross: {encoded}"
        );
        assert!(!encoded.contains("cat "));

        let odd = project(&update(
            json!({"sessionUpdate": "tool_call", "kind": "rm -rf /"}),
        ));
        let Projection::Status(payload) = odd else {
            panic!()
        };
        assert_eq!(payload["tool_call_name"], "other");
    }

    #[test]
    fn plans_are_bounded_and_closed() {
        let projected = project(&update(json!({
            "sessionUpdate": "plan",
            "entries": [
                {"content": "Read the \u{202E}code", "priority": "high", "status": "in_progress", "_meta": {"x": 1}},
                {"content": "", "priority": "low", "status": "pending"},
                {"content": "Write tests", "priority": "weird", "status": "done?"}
            ]
        })));
        let Projection::Status(payload) = projected else {
            panic!()
        };
        assert_eq!(payload["has_plan"], true);
        assert_eq!(
            payload["plan"],
            json!([
                {"content": "Read the code", "status": "in_progress", "priority": "high"},
                {"content": "Write tests", "status": "pending", "priority": "medium"}
            ])
        );
    }

    #[test]
    fn mode_updates_go_to_the_policy_and_other_updates_are_dropped() {
        assert_eq!(
            project(&update(
                json!({"sessionUpdate": "current_mode_update", "currentModeId": "bypassPermissions"})
            )),
            Projection::ModeChanged("bypassPermissions".into())
        );
        assert_eq!(
            project(&update(json!({"sessionUpdate": "current_mode_update"}))),
            Projection::ModeChanged(String::new())
        );
        // The config-option spelling of the same fact (codex-acp slash commands).
        assert_eq!(
            project(&update(
                json!({"sessionUpdate": "config_option_update", "configOptions": [
                    {"id": "model", "category": "model", "type": "select", "currentValue": "gpt-5"},
                    {"id": "mode", "category": "mode", "type": "select", "currentValue": "agent-full-access"}
                ]})
            )),
            Projection::ModeChanged("agent-full-access".into())
        );
        assert_eq!(
            project(&update(
                json!({"sessionUpdate": "config_option_update", "configOptions": [
                    {"id": "model", "category": "model", "type": "select", "currentValue": "gpt-5"}
                ]})
            )),
            Projection::Ignore,
            "a config change that names no mode is not a mode change"
        );
        for dropped in [
            json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}}),
            json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "hi"}}),
            json!({"sessionUpdate": "tool_call_update", "toolCallId": "c", "status": "completed"}),
            json!({"sessionUpdate": "available_commands_update", "availableCommands": []}),
        ] {
            assert_eq!(project(&update(dropped)), Projection::Ignore);
        }
    }

    #[test]
    fn sanitising_removes_bidi_invisible_and_control_characters_only() {
        let hostile = "a\u{202E}b\u{2066}c\u{200B}d\u{FEFF}e\u{1b}[31mf\u{0}g\r\nh\ti";
        assert_eq!(sanitize_text(hostile), "abcde[31mfg\nh\ti");
        // ZWJ emoji and Hangul survive.
        assert_eq!(sanitize_text("👩\u{200D}💻 성재"), "👩\u{200D}💻 성재");
    }

    #[test]
    fn chunks_never_split_a_character_or_exceed_the_limit() {
        let text = "가".repeat(3000); // 9000 bytes
        let chunks = chunk_utf8(&text, 4096);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= 4096 && !chunk.is_empty()));
        assert_eq!(chunks.concat(), text);
        assert!(chunk_utf8("", 4096).is_empty());
    }
}
