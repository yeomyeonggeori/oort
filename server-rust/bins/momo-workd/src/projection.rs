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
//! Text that does cross is sanitised (ADR-0188 D5 정화 규칙, event-stream half):
//!
//! * display — bidirectional-override and invisible formatting characters are
//!   removed, as are C0 controls other than newline and tab, so a relayed line
//!   cannot render differently from what it is ([`sanitize_text`]);
//! * credentials — private keys and recognisable credential tokens are
//!   replaced before anything is sent ([`redact_credentials`], see
//!   [`crate::redact`] for the families and why this is a secondary defence);
//!   the relay sends only complete lines until a message ends, and holds an
//!   open key block, so a credential split across two flushes is still whole
//!   when it is scanned (#2602 M-1, #2607 N-4);
//! * size — no field carries more than [`MAX_FIELD_CHARS`] characters. Streamed
//!   answer text is cut into consecutive fields of at most that size
//!   ([`chunk_field`]); a single-valued field keeps its head and tail
//!   ([`bound_field`]).

use serde_json::{json, Map, Value};

/// ADR-0188 D5: the most characters one relayed field carries.
pub const MAX_FIELD_CHARS: usize = 3_500;
pub use crate::redact::{
    open_private_key_block, redact_credentials, REDACTED_CREDENTIAL, REDACTED_PRIVATE_KEY,
};

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
    let content = bound_field(
        &redact_credentials(&sanitize_text(content)),
        MAX_PLAN_ENTRY_CHARS,
    );
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

// ---- permission preview (#3118, ADR-0146 증보 H1 · ADR-0188 D5) -----------

/// Most tool calls remembered per session for their preview: a permission
/// request names one by `toolCallId`, and ACP lets the request carry only a
/// partial update of the call the agent announced before.
pub const MAX_REMEMBERED_TOOL_CALLS: usize = 64;

/// Fold a `tool_call` / `tool_call_update` notification's fields into what
/// this session remembers of that call. Later non-null fields win (ACP
/// `ToolCallUpdate` semantics). Returns `false` for anything else.
pub fn remember_tool_call(calls: &mut Vec<(String, Map<String, Value>)>, params: &Value) -> bool {
    let Some(update) = params.get("update").and_then(Value::as_object) else {
        return false;
    };
    if !matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("tool_call") | Some("tool_call_update")
    ) {
        return false;
    }
    let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
        return false;
    };
    merge_tool_call(calls, id, update);
    true
}

fn merge_tool_call(
    calls: &mut Vec<(String, Map<String, Value>)>,
    id: &str,
    fields: &Map<String, Value>,
) {
    let index = match calls.iter().position(|(known, _)| known == id) {
        Some(index) => index,
        None => {
            if calls.len() >= MAX_REMEMBERED_TOOL_CALLS {
                calls.remove(0);
            }
            calls.push((id.to_string(), Map::new()));
            calls.len() - 1
        }
    };
    let entry = &mut calls[index].1;
    for key in ["title", "kind", "locations", "rawInput"] {
        if let Some(value) = fields.get(key).filter(|value| !value.is_null()) {
            entry.insert(key.to_string(), value.clone());
        }
    }
}

/// The preview of one `session/request_permission` (#3118): the tool call it
/// names, as this session knows it, with the request's own fields on top —
/// sanitised the way ADR-0188 D5 says. The host is the preview's source; the
/// hash of [`momo_wire::permission_preview::PermissionPreview::to_value`] is
/// what an owner's allow must name.
pub fn permission_preview(
    calls: &mut Vec<(String, Map<String, Value>)>,
    params: &Value,
) -> momo_wire::permission_preview::PermissionPreview {
    let request = params
        .get("toolCall")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let fields = match request.get("toolCallId").and_then(Value::as_str) {
        Some(id) => {
            merge_tool_call(calls, id, &request);
            calls
                .iter()
                .find(|(known, _)| known == id)
                .map(|(_, fields)| fields.clone())
                .unwrap_or_default()
        }
        None => request,
    };
    let kind = fields
        .get("kind")
        .and_then(Value::as_str)
        .map(tool_kind)
        .unwrap_or("other");
    let title = fields
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let locations: Vec<String> = fields
        .get("locations")
        .and_then(Value::as_array)
        .map(|locations| {
            locations
                .iter()
                .filter_map(|location| {
                    let path = location.get("path").and_then(Value::as_str)?;
                    Some(match location.get("line").and_then(Value::as_u64) {
                        Some(line) => format!("{path}:{line}"),
                        None => path.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let input = match fields.get("rawInput") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
    };
    let mut truncated = false;
    let mut field = |text: &str| {
        let (bounded, cut) = preview_field(text);
        truncated |= cut;
        bounded
    };
    let title = field(title);
    let locations = field(&locations.join("\n"));
    let input = field(&input);
    momo_wire::permission_preview::PermissionPreview {
        kind: kind.to_string(),
        title,
        locations,
        input,
        truncated,
    }
}

/// One preview field: invisible and direction characters removed — the
/// relay's set, the credential scan's invisible set, and the line and
/// paragraph separators, so an app's display sanitiser finds nothing left to
/// neutralise and shows exactly the hashed bytes — credential shapes masked,
/// then at most [`MAX_FIELD_CHARS`] characters with head and tail kept.
/// Returns whether it was cut.
fn preview_field(text: &str) -> (String, bool) {
    let visible: String = text
        .chars()
        .filter(|character| {
            !is_disallowed(*character)
                && !crate::redact::is_invisible(*character)
                && !matches!(character, '\u{2028}' | '\u{2029}')
        })
        .collect();
    let masked = mask_display_shapes(&redact_credentials(&visible));
    let cut = masked.chars().count() > MAX_FIELD_CHARS;
    (bound_field(&masked, MAX_FIELD_CHARS), cut)
}

/// The credential shapes an app's display sanitiser masks
/// (`@momo/core` `agentPane.ts` `CREDENTIAL_PATTERNS`), masked here too — each
/// at least as widely — so the app finds nothing left to mask and shows the
/// hashed bytes unchanged (#3118 security review M1). A preview the app would
/// alter cannot be allowed, so without this an honest `curl -H "Authorization:
/// Bearer …"` request could never be allowed from a phone. Runs after
/// [`redact_credentials`], whose marks match none of these shapes.
fn mask_display_shapes(text: &str) -> String {
    fn word(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_'
    }
    fn run(rest: &str, allowed: impl Fn(char) -> bool) -> usize {
        rest.chars()
            .take_while(|c| allowed(*c))
            .map(char::len_utf8)
            .sum()
    }
    fn alnum(c: char) -> bool {
        c.is_ascii_alphanumeric()
    }
    fn b64url(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_' || c == '-'
    }
    /// `(bytes kept before the mask, bytes masked)` of a shape starting here.
    fn shape(rest: &str) -> Option<(usize, usize)> {
        let prefixed = |prefix: &str, allowed: fn(char) -> bool, min: usize| {
            let tail = rest.strip_prefix(prefix)?;
            let n = run(tail, allowed);
            (tail[..n].chars().count() >= min).then_some((0, prefix.len() + n))
        };
        if let Some(hit) = prefixed("sk-", b64url, 16) {
            return Some(hit);
        }
        for p in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
            if let Some(hit) = prefixed(p, alnum, 20) {
                return Some(hit);
            }
        }
        if let Some(hit) = prefixed("github_pat_", word, 20) {
            return Some(hit);
        }
        for p in ["xoxa-", "xoxb-", "xoxp-", "xoxo-", "xoxs-", "xoxr-"] {
            if let Some(hit) = prefixed(p, |c| c.is_ascii_alphanumeric() || c == '-', 10) {
                return Some(hit);
            }
        }
        if let Some(hit) = prefixed("AKIA", |c| c.is_ascii_digit() || c.is_ascii_uppercase(), 16) {
            return Some(hit);
        }
        if let Some(hit) = prefixed("AIza", b64url, 30) {
            return Some(hit);
        }
        if let Some(tail) = rest.strip_prefix("eyJ") {
            let mut at = 0;
            let mut ok = true;
            for part in 0..3 {
                let n = run(&tail[at..], b64url);
                // The first part's 8 include nothing of `eyJ`, as in the core.
                if tail[at..at + n].len() < 8 {
                    ok = false;
                    break;
                }
                at += n;
                if part < 2 {
                    if !tail[at..].starts_with('.') {
                        ok = false;
                        break;
                    }
                    at += 1;
                }
            }
            if ok {
                return Some((0, 3 + at));
            }
        }
        if rest
            .get(..6)
            .is_some_and(|p| p.eq_ignore_ascii_case("bearer"))
        {
            let after = &rest[6..];
            let spaces = run(after, char::is_whitespace);
            if spaces > 0 {
                let token = &after[spaces..];
                let n = run(token, |c| {
                    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '+' | '/' | '-')
                });
                if n >= 16 {
                    let pad = run(&token[n..], |c| c == '=');
                    return Some((6 + spaces, n + pad));
                }
            }
        }
        None
    }
    let mut out = String::with_capacity(text.len());
    let mut previous: Option<char> = None;
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        let at_boundary = !previous.is_some_and(word);
        if at_boundary {
            if let Some((keep, masked)) = shape(rest) {
                out.push_str(&rest[..keep]);
                out.push_str(REDACTED_CREDENTIAL);
                index += keep + masked;
                previous = Some(']');
                continue;
            }
        }
        let c = rest.chars().next().expect("index < len");
        out.push(c);
        previous = Some(c);
        index += c.len_utf8();
    }
    out
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

/// Split `text` into consecutive fields of at most `max_chars` characters and
/// `max_bytes` UTF-8 bytes each, on character boundaries (nothing is dropped).
pub fn chunk_field(text: &str, max_chars: usize, max_bytes: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut characters = 0usize;
    for character in text.chars() {
        if characters == max_chars || current.len() + character.len_utf8() > max_bytes {
            chunks.push(std::mem::take(&mut current));
            characters = 0;
        }
        current.push(character);
        characters += 1;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// A single-valued field of at most `max_chars` characters: over the limit,
/// its head and tail are kept around an elision mark (ADR-0188 D5 「앞뒤를
/// 남기고 자른다」).
pub fn bound_field(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let mark = " … ";
    let keep = max_chars.saturating_sub(mark.chars().count());
    let head = keep.div_ceil(2);
    let tail = keep - head;
    let mut bounded: String = text.chars().take(head).collect();
    bounded.push_str(mark);
    bounded.extend(text.chars().skip(total - tail));
    bounded
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
    fn plan_entries_are_redacted_and_bounded() {
        // #2607 N-7: a plan entry is text the agent writes, so the same
        // credential masking and a 500-character bound apply to it.
        let long = "step ".repeat(400);
        let projected = project(&update(json!({
            "sessionUpdate": "plan",
            "entries": [
                {"content": format!("export KEY={SK_ANT} then deploy"), "status": "pending"},
                {"content": long, "status": "pending"}
            ]
        })));
        let Projection::Status(payload) = projected else {
            panic!()
        };
        let first = payload["plan"][0]["content"].as_str().unwrap();
        assert_eq!(
            first,
            format!("export KEY={REDACTED_CREDENTIAL} then deploy")
        );
        let second = payload["plan"][1]["content"].as_str().unwrap();
        assert_eq!(second.chars().count(), MAX_PLAN_ENTRY_CHARS);
        assert!(second.contains(" … "), "head and tail kept around the mark");
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

    // Synthetic credentials: well-formed, never real.
    // Synthetic, well-formed shapes — never real. Assembled with `concat!` so
    // the source carries no scanner-shaped literal (scripts/check_secrets.sh
    // scans every ref).
    const SK_ANT: &str = concat!(
        "sk-",
        "ant-api03-",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    const GHP: &str = concat!("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789");
    const AWS: &str = concat!("AKIA", "ABCDEFGHIJKLMNOP");
    const SLACK: &str = concat!("xoxb", "-1234567890-abcdefghij");
    const JWT: &str = concat!(
        "eyJhbGciOiJIUzI1NiJ9",
        ".",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".",
        "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    );
    const PEM: &str = concat!(
        "-----BEGIN OPENSSH ",
        "PRIVATE KEY-----\n",
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n",
        "-----END OPENSSH ",
        "PRIVATE KEY-----"
    );

    #[test]
    fn every_credential_shape_is_redacted() {
        let text = format!("key {SK_ANT} gh {GHP} aws {AWS} slack {SLACK} jwt {JWT}\n{PEM}\nafter");
        let clean = redact_credentials(&text);
        for secret in [SK_ANT, GHP, AWS, SLACK, JWT, "b3BlbnNzaC1rZXkt"] {
            assert!(!clean.contains(secret), "{secret} survived: {clean}");
        }
        assert_eq!(clean.matches(REDACTED_CREDENTIAL).count(), 5, "{clean}");
        assert_eq!(clean.matches(REDACTED_PRIVATE_KEY).count(), 1, "{clean}");
        assert!(clean.ends_with("\nafter"));
    }

    #[test]
    fn words_that_merely_contain_a_prefix_are_left_alone() {
        for text in [
            "risk-assessment-for-the-quarter-2026",
            "the task-sk-list",
            "AKIA is a prefix",
            "eyJ.not.a.jwt",
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    #[test]
    fn an_unterminated_private_key_is_redacted_to_the_end_and_reported_open() {
        let text = concat!("before\n-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow");
        assert_eq!(
            redact_credentials(text),
            format!("before\n{REDACTED_PRIVATE_KEY}")
        );
        assert_eq!(open_private_key_block(text), Some("before\n".len()));
        assert_eq!(open_private_key_block("-----BEGIN OPENSSH PRIV"), Some(0));
        assert_eq!(open_private_key_block(PEM), None);
        assert_eq!(open_private_key_block("no key"), None);
    }

    /// #3118: the preview is the request's tool call as the session knows
    /// it, sanitised, masked and bounded — and its hash moves with each field.
    #[test]
    fn a_permission_preview_is_the_named_tool_call_sanitised() {
        let mut calls = Vec::new();
        assert!(remember_tool_call(
            &mut calls,
            &update(json!({"sessionUpdate": "tool_call", "toolCallId": "call-1",
                "title": "Run `cat ~/.ssh/id_ed25519`", "kind": "execute",
                "locations": [{"path": "/home/me/.ssh/id_ed25519", "line": 3}],
                "rawInput": {"command": "cat ~/.ssh/id_ed25519"}}))
        ));
        // The request carries a partial update: its title wins, the rest is
        // what the agent announced.
        let preview = permission_preview(
            &mut calls,
            &json!({"toolCall": {"toolCallId": "call-1",
                "title": "Run \u{202E}`cat x`\u{2028} ghp_0123456789abcdefghijklmnopqrstuvwxyz"}}),
        );
        assert_eq!(preview.kind, "execute");
        assert_eq!(
            preview.title,
            format!("Run `cat x` {REDACTED_CREDENTIAL}"),
            "direction and separator characters removed, the token masked"
        );
        assert_eq!(preview.locations, "/home/me/.ssh/id_ed25519:3");
        assert_eq!(preview.input, r#"{"command":"cat ~/.ssh/id_ed25519"}"#);
        assert!(!preview.truncated);
        let hash = momo_wire::permission_preview::preview_sha256(&preview.to_value()).unwrap();
        assert_eq!(hash.len(), 64);

        // An unknown call and a bare request still give a preview (of what
        // there is); a long input is cut and says so.
        let bare = permission_preview(&mut calls, &json!({}));
        assert_eq!(
            (bare.kind.as_str(), bare.title.as_str(), bare.truncated),
            ("other", "", false)
        );
        let long = permission_preview(
            &mut calls,
            &json!({"toolCall": {"toolCallId": "call-2", "kind": "sudo",
                "rawInput": "y".repeat(MAX_FIELD_CHARS + 10)}}),
        );
        assert_eq!(long.kind, "other");
        assert!(long.truncated);
        assert_eq!(long.input.chars().count(), MAX_FIELD_CHARS);
        assert!(momo_wire::permission_preview::validate_preview(&long.to_value()).is_ok());
    }

    /// #3118 security review M1: every shape the app's display sanitiser
    /// masks is masked by the host first, so an honest preview reaches the
    /// app unchanged by display and can be allowed.
    #[test]
    fn the_preview_masks_every_shape_the_app_would() {
        let samples = [
            (
                "Bearer",
                "curl -H 'Authorization: Bearer abcdefghijklmnopqrst' x",
            ),
            ("bearer lower", "bearer abcdefghijklmnop=="),
            ("sk-16", "key sk-abcdefghijklmnop end"),
            ("sk-proj", "sk-proj-abcdefghijklmnop"),
            ("gh", "ghp_abcdefghijklmnopqrst"),
            ("github_pat", "github_pat_abcdefghijklmnopqrst"),
            ("slack", "xoxb-1234567890"),
            ("aws", "AKIAABCDEFGHIJKLMNOP"),
            ("google", "AIzaabcdefghijklmnopqrstuvwxyz0123"),
            ("jwt short", "eyJabcdefgh.abcdefgh.abcdefgh"),
        ];
        for (what, sample) in samples {
            let (field, _) = preview_field(sample);
            assert!(field.contains(REDACTED_CREDENTIAL), "{what}: {field}");
            for needle in ["abcdefghijklmnop", "1234567890", "ABCDEFGHIJKLMNOP"] {
                assert!(!field.contains(needle), "{what}: {field}");
            }
        }
        // Words that merely contain a prefix, and short tokens, are left alone.
        for text in [
            "risk-assessment-for-the-quarter",
            "task-abcdefghijklmnopq",
            "Bearer short",
            "한글 설정.md를 고쳐요 ✅ bé",
        ] {
            assert_eq!(preview_field(text).0, text);
        }
    }

    #[test]
    fn remembered_tool_calls_are_bounded() {
        let mut calls = Vec::new();
        for n in 0..(MAX_REMEMBERED_TOOL_CALLS + 5) {
            remember_tool_call(
                &mut calls,
                &update(
                    json!({"sessionUpdate": "tool_call", "toolCallId": format!("c{n}"), "title": "t"}),
                ),
            );
        }
        assert_eq!(calls.len(), MAX_REMEMBERED_TOOL_CALLS);
        assert_eq!(calls[0].0, "c5");
        assert!(!remember_tool_call(
            &mut calls,
            &update(json!({"sessionUpdate": "plan", "entries": []}))
        ));
    }

    #[test]
    fn fields_are_bounded_and_chunks_lose_nothing() {
        let long = "가".repeat(10_000);
        let chunks = chunk_field(&long, MAX_FIELD_CHARS, 4_096);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= MAX_FIELD_CHARS && chunk.len() <= 4_096));
        assert_eq!(chunks.concat(), long);

        let bounded = bound_field(&"x".repeat(10_000), MAX_FIELD_CHARS);
        assert_eq!(bounded.chars().count(), MAX_FIELD_CHARS);
        assert!(bounded.contains(" … "));
        assert_eq!(bound_field("short", MAX_FIELD_CHARS), "short");
    }
}
