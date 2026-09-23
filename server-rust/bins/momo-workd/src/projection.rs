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
//! * credentials — PEM private-key blocks and recognisable tokens (`sk-…`
//!   including `sk-ant-…`, `gh?_…`/`github_pat_…`, `AKIA…`/`ASIA…`, `xox?-…`,
//!   JWTs) are replaced before anything is sent ([`redact_credentials`]; the
//!   relay also holds back a trailing fragment so a credential split across two
//!   flushes is still whole when it is scanned, #2602 M-1);
//! * size — no field carries more than [`MAX_FIELD_CHARS`] characters. Streamed
//!   answer text is cut into consecutive fields of at most that size
//!   ([`chunk_field`]); a single-valued field keeps its head and tail
//!   ([`bound_field`]).

use serde_json::{json, Map, Value};

/// ADR-0188 D5: the most characters one relayed field carries.
pub const MAX_FIELD_CHARS: usize = 3_500;
/// What a redacted credential becomes on the wire.
pub const REDACTED_CREDENTIAL: &str = "[redacted credential]";
/// What a redacted private-key block becomes on the wire.
pub const REDACTED_PRIVATE_KEY: &str = "[redacted private key]";

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

/// Replace private-key blocks and recognisable credential tokens.
///
/// Hand-written scanners, not a regex engine (none is in the workspace graph):
/// every pattern is a fixed prefix followed by a run of a known alphabet, and
/// each prefix must start at a token boundary so words that merely contain it
/// (`risk-assessment`) are left alone.
pub fn redact_credentials(text: &str) -> String {
    redact_tokens(&redact_private_keys(text))
}

const PEM_BEGIN: &str = "-----BEGIN ";
const PEM_END: &str = "-----END ";
const PEM_DASHES: &str = "-----";

/// Where a PEM header that names a private key starts, and where it ends.
fn find_private_key_header(text: &str, from: usize) -> Option<(usize, Option<usize>)> {
    let mut search = from;
    while let Some(offset) = text[search..].find(PEM_BEGIN) {
        let begin = search + offset;
        let label_start = begin + PEM_BEGIN.len();
        match text[label_start..].find(PEM_DASHES) {
            Some(close) => {
                let label = &text[label_start..label_start + close];
                let header_end = label_start + close + PEM_DASHES.len();
                if label.contains("PRIVATE KEY") {
                    return Some((begin, Some(header_end)));
                }
                search = header_end;
            }
            // The header itself is not finished: it may be a private key.
            None => return Some((begin, None)),
        }
    }
    None
}

/// Where the END line of a private-key block closes, searching from `from`.
fn find_private_key_footer(text: &str, from: usize) -> Option<usize> {
    let mut search = from;
    while let Some(offset) = text[search..].find(PEM_END) {
        let end = search + offset;
        let label_start = end + PEM_END.len();
        let close = text[label_start..].find(PEM_DASHES)?;
        let footer_end = label_start + close + PEM_DASHES.len();
        if text[label_start..label_start + close].contains("PRIVATE KEY") {
            return Some(footer_end);
        }
        search = footer_end;
    }
    None
}

fn redact_private_keys(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut position = 0;
    while let Some((begin, header_end)) = find_private_key_header(text, position) {
        out.push_str(&text[position..begin]);
        out.push_str(REDACTED_PRIVATE_KEY);
        // An unfinished header or an unterminated block is redacted to the end.
        match header_end.and_then(|header_end| find_private_key_footer(text, header_end)) {
            Some(footer_end) => position = footer_end,
            None => return out,
        }
    }
    out.push_str(&text[position..]);
    out
}

/// The start of an unterminated private-key block (or of an unfinished PEM
/// header), if the text ends inside one: the relay holds everything from here
/// until the block closes.
pub fn open_private_key_block(text: &str) -> Option<usize> {
    let mut position = 0;
    let mut open = None;
    while let Some((begin, header_end)) = find_private_key_header(text, position) {
        match header_end.and_then(|header_end| find_private_key_footer(text, header_end)) {
            Some(footer_end) => position = footer_end,
            None => {
                open = Some(begin);
                break;
            }
        }
    }
    open
}

fn is_token_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '-'
}

/// Whether `character` can occur inside a credential token this module
/// recognises (PEM blocks aside): base64url and the JWT separator. A credential
/// never straddles any other character.
pub fn is_credential_char(character: char) -> bool {
    is_token_char(character) || character == '.'
}

fn run_len(text: &str, allowed: impl Fn(char) -> bool) -> usize {
    text.char_indices()
        .find(|(_, character)| !allowed(*character))
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

/// The byte length of a credential token starting exactly at `rest`, if any.
fn credential_len(rest: &str) -> Option<usize> {
    let base64url = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let alnum = |c: char| c.is_ascii_alphanumeric();
    // OpenAI and Anthropic keys (`sk-…`, `sk-proj-…`, `sk-ant-…`).
    if let Some(body) = rest.strip_prefix("sk-") {
        let run = run_len(body, base64url);
        return (run >= 20).then_some(3 + run);
    }
    // GitHub tokens.
    if let Some(body) = rest.strip_prefix("github_pat_") {
        let run = run_len(body, |c| c.is_ascii_alphanumeric() || c == '_');
        return (run >= 20).then_some(11 + run);
    }
    let bytes = rest.as_bytes();
    if bytes.len() > 4
        && bytes.starts_with(b"gh")
        && matches!(bytes[2], b'p' | b'o' | b'u' | b's' | b'r')
        && bytes[3] == b'_'
    {
        let run = run_len(&rest[4..], alnum);
        return (run >= 30).then_some(4 + run);
    }
    // AWS access key ids: exactly 16 more upper-case alphanumerics.
    if rest.starts_with("AKIA") || rest.starts_with("ASIA") {
        let run = run_len(&rest[4..], |c| c.is_ascii_uppercase() || c.is_ascii_digit());
        return (run == 16).then_some(20);
    }
    // Slack tokens.
    if bytes.len() > 5
        && bytes.starts_with(b"xox")
        && matches!(bytes[3], b'a' | b'b' | b'p' | b'r' | b's' | b'o')
        && bytes[4] == b'-'
    {
        let run = run_len(&rest[5..], |c| c.is_ascii_alphanumeric() || c == '-');
        return (run >= 10).then_some(5 + run);
    }
    // JWTs: three base64url segments, the first two JSON objects (`eyJ`).
    if rest.starts_with("eyJ") {
        let first = run_len(rest, base64url);
        let after_first = &rest[first..];
        if first >= 10 && after_first.starts_with(".eyJ") {
            let second = run_len(&after_first[1..], base64url);
            let after_second = &after_first[1 + second..];
            if second >= 10 && after_second.starts_with('.') {
                let third = run_len(&after_second[1..], base64url);
                if third >= 8 {
                    return Some(first + 1 + second + 1 + third);
                }
            }
        }
    }
    None
}

fn redact_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous: Option<char> = None;
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        let at_boundary = previous.is_none_or(|character| !is_token_char(character));
        if at_boundary {
            if let Some(length) = credential_len(rest) {
                out.push_str(REDACTED_CREDENTIAL);
                index += length;
                previous = text[..index].chars().next_back();
                continue;
            }
        }
        let character = rest.chars().next().expect("index is on a char boundary");
        out.push(character);
        previous = Some(character);
        index += character.len_utf8();
    }
    out
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
