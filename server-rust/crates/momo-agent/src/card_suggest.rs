//! Agent-suggested client-command cards — ADR-0186 증보 2026-09-27 G1~G3
//! (GC-6, #2947).
//!
//! An agent that understood 「내 클로드 구독 연결해 줘」 answers with a message
//! whose props carry `momo.command_suggest.v1`, and the requester's client draws
//! the connect card from **its own settings store**. The agent chooses *which*
//! card and *which* of its few arguments; it chooses nothing else.
//!
//! Two doors reach this module and both call the same functions here, so the
//! two can never disagree about what a legal suggestion is:
//!
//! * hosted — the Agent Port tool `oort_card_suggest`
//!   (`bins/momo-server/src/routes/agent_port_tools.rs`);
//! * server worker — the catalog tool [`crate::tools::CARD_SUGGEST`]
//!   (`bins/momo-agent-worker/src/tool_exec.rs`).
//!
//! ## What the agent cannot decide (G1, G3)
//!
//! * **where** — the channel is the lease handle's / the run's, never an
//!   argument;
//! * **for whom** — `for_member_id` is the author of the run's trigger message,
//!   read from `agent_run.trigger_message_id` here, and must be a human
//!   ([`suggestion_requester_in_tx`]);
//! * **what the card is called** — `label` is derived from
//!   `(command_id, args)` by a table beside [`SUGGESTABLE_COMMANDS`]; an agent's
//!   string never becomes a card title (phishing copy);
//! * **what else rides in props** — the props object is exactly five keys and
//!   is assembled here from normalised values ([`command_suggest_props`]).
//!
//! [`validate_suggestion`] is the **whole** gate for the worker door: provider
//! arguments reach it raw, with no protocol validator in front. The hosted
//! door also has `momo_mcp::validate_arguments` in front of it, and that is a
//! redundant first fence rather than the rule — the pair rule
//! (`team_key ⇔ team`) is not expressible in that validator at all.
//!
//! ## What this module does not do
//!
//! It executes nothing. No PTY, no provider link, no settings route: a person
//! taps the card on their own device and their own client does the rest (G1
//! 「에이전트는 실행하지 않는다」). The one write either door makes is the
//! message itself, through `momo_messaging::send_message_in_tx`, which is why
//! this crate still owns no message SQL — only the read that finds the
//! requester.

use momo_db::{DbError, PgConnection};
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

/// The props key of a suggestion card (ADR-0186 부록 D, replaced by G3).
pub const COMMAND_SUGGEST_PROPS_KEY: &str = "momo.command_suggest";

/// `momo.command_suggest.v1`.
pub const COMMAND_SUGGEST_VERSION: i64 = 1;

/// `ai.connect` — the connect card (GC-2's client command, kind `client`).
pub const COMMAND_AI_CONNECT: &str = "ai.connect";

/// `settings.open` — "open this settings section" (ADR-0201 v2 H6-4, #3939 E-S6,
/// kind `client`, risk `none`). **This ticket owns the wire name and the enum**;
/// the client registry entry and the card render are #3940 (U-S6).
pub const COMMAND_SETTINGS_OPEN: &str = "settings.open";

/// `settings.open` `args.section` — settings section ids as the web settings
/// page resolves them (`?section=<id>`), **not paths** (`/ai/external/apps` is
/// never a value). Eleven are the nav rows of
/// `clients/web/src/features/settings/settingsNav.ts` (`SettingsSectionId`);
/// the twelfth, `plugins`, is the legacy id that
/// `packages/momo-core/src/features/ai/aiHubModel.ts` (`AI_EXTERNAL_ROWS`
/// `fromSettings`) resolves to the AI hub's 「앱」 page — it is how ADR-0201
/// v2:284 (「`settings.open`(앱 섹션) 카드」) is expressible at all, because the
/// apps screen is no nav row. Left out on purpose:
///
/// * `ai` — a link row to the AI hub, not a settings screen; connecting an AI is
///   the `ai.connect` card, whose copy and states are already its own;
/// * the other legacy ids (`account`, `link-previews`, `terminal`, `agents`,
///   `webhooks`, `events`) — old deep-link names a client still resolves, never
///   a name a new card should mint.
///
/// A value a given build cannot reach (`updates` outside the desktop shell,
/// `code`/`memory` on a server that does not carry the surface) is still a legal
/// *suggestion*: the receiving client decides reachability and falls back to the
/// body text (U-S6). The order is the settings nav's, and the label table below
/// has exactly one row per entry.
pub const SETTINGS_OPEN_SECTIONS: [&str; 12] = [
    "profile",
    "appearance",
    "notifications",
    "shortcuts",
    "devices",
    "workspace",
    "members",
    "memory",
    "usage",
    "code",
    "updates",
    "plugins",
];

/// The body ceiling, in UTF-8 bytes — the same number `oort_message_post`
/// publishes and enforces, so the two doors that post an agent's words agree.
pub const SUGGESTION_BODY_MAX_BYTES: usize = 8_000;

/// The label ceiling (G3: 「상한 40자」). Checked by a test over every derived
/// label rather than at runtime: the table is static, so a label that broke it
/// is a build-time mistake, not a request-time one.
pub const SUGGESTION_LABEL_MAX_CHARS: usize = 40;

/// `ai.connect` `args.harness` (G2). **No `grok`** — Grok's subscription row is
/// 「준비 중」 (ADR-0193 증보 · AI 계정 Q7, planner 2026-09-27); it arrives in a
/// later 증보 together with its label, and until then `harness:"grok"` is
/// `InvalidArguments` like any other unknown value.
pub const AI_CONNECT_HARNESSES: [&str; 3] = ["claude", "codex", "team_key"];

/// `ai.connect` `args.scope` (G2).
pub const AI_CONNECT_SCOPES: [&str; 2] = ["mine", "team"];

/// `work.request.open` — "open the 「작업 요청」 sheet, already filled in" (ADR-0201 증보 v3 B8 C1,
/// #4972 S9; kind `client`, risk `none`, the same G2 four places as `settings.open`).
///
/// The person's own client opens the sheet of ADR-0198 D4 with `harness` and `prompt` filled and
/// **a person sends it**. The spawn is a control signed by the owner's device key (ADR-0198 D4),
/// so nothing a suggestion says runs by itself: the server writes the card's message and nothing
/// else — no approval row, no audit row for the command (B15-A15). The helper reads no code and
/// runs none (B8 C1, ADR-0198 D1·D5).
pub const COMMAND_WORK_REQUEST_OPEN: &str = "work.request.open";

/// `work.request.open` `args.harness` — the tools of the person's own Mac the sheet always
/// offers (ADR-0198 D4: Claude Code, Codex; OpenCode shows up only when a Mac reports it, so a
/// card never names it). **A subset of [`AI_CONNECT_HARNESSES`] on purpose**: `claude` and
/// `codex` mean the same tool in both commands, which is why the two share one `args.harness`
/// property on the wire (see [`merged_args_properties`]). `team_key` is a team API key — an
/// agent, never a tool on somebody's Mac — and is refused here.
pub const WORK_REQUEST_HARNESSES: [&str; 2] = ["claude", "codex"];

/// `work.request.open` `args.prompt` ceiling, in UTF-8 bytes — the body's own number
/// ([`SUGGESTION_BODY_MAX_BYTES`]). The sheet takes up to 32,768 characters, but this text rides
/// in the card's props, which every member of the channel receives, and a coding request a
/// person is asked to read before sending is not a document.
pub const WORK_REQUEST_PROMPT_MAX_BYTES: usize = 8_000;

/// What the team AI helper may suggest (ADR-0201 v3 B8 C1). Narrower than
/// [`SUGGESTABLE_COMMANDS`] on purpose: `ai.connect` and `settings.open` have no sentence in the
/// helper's prompt, and the helper's tool offers only what its request advertises
/// ([`crate::team_ai_roles::TeamAiRoles::advertised_command_ids`]). H6-4's `settings.open` for the
/// helper (ADR-0201 확인 필요 ④) is a later, separate decision: it joins this list **and** gets a
/// prompt sentence together, never one without the other.
pub const TEAM_AI_SUGGESTABLE_COMMAND_IDS: [&str; 1] = [COMMAND_WORK_REQUEST_OPEN];

/// The worker's system-prompt rule for a connection request (GC-8, #2949).
///
/// The tool description tells a model *what* `card_suggest` does; this block
/// tells it *when* to reach for it instead of doing the thing it would
/// otherwise try — walking the person through settings, or asking for a key.
/// It rides as its own `system` turn **only when the profile offered the
/// tool** ([`card_suggest_directive`]): telling a model to call a tool it was
/// not given spends a turn on a refusal (`tools::exempt_tool_not_enabled`).
///
/// The hosted twin of this rule is prose in `docs/SELF_HOST_AGENT.md`
/// (§3.3.16c, §3.3.17.4), because a hosted runtime's instructions are written
/// by its operator, not assembled here.
pub const CARD_SUGGEST_DIRECTIVE: &str = "Connection requests: when a person asks you \
to connect an AI, to sign in to an AI subscription (Claude, Codex) or to connect a \
team API key, do not try to do it yourself and do not walk them through settings. \
Call the `card_suggest` tool with `commandId` `ai.connect` \
(set `args.harness` to `claude`, `codex` or `team_key` only if they named one) and \
put a one-sentence answer in `body`. Their own app draws the card and they connect \
on their own device. Never ask for a key, token, password or login code in chat.";

/// [`CARD_SUGGEST_DIRECTIVE`] when `enabled` (the profile's resolved tool list)
/// offers `card_suggest`, otherwise `None`. Matching is `tools::normalize`,
/// the executor's rule, so the block and the tool can never disagree.
pub fn card_suggest_directive(enabled: &[crate::tools::ToolDefinition]) -> Option<&'static str> {
    let wanted = crate::tools::normalize(crate::tools::CARD_SUGGEST);
    enabled
        .iter()
        .any(|definition| crate::tools::normalize(definition.name) == wanted)
        .then_some(CARD_SUGGEST_DIRECTIVE)
}

/// The keys an agent may send to either door, besides the door's own plumbing
/// (`handle`/`clientMsgId`/`rootId` on the hosted one).
pub const SUGGESTION_ARGUMENT_KEYS: [&str; 3] = ["commandId", "args", "body"];

/// Keys G1 names as refused outright. Not the rule — the rule is "only the keys
/// the door declares" — but named so the red proof can walk exactly the list
/// the ADR wrote and a reader can see the four that matter most.
pub const REFUSED_ARGUMENT_KEYS: [&str; 4] = ["label", "forMemberId", "channelId", "props"];

/// Why a suggestion was refused. Two causes, because the two doors must answer
/// them differently: a bad argument is the caller's fault and says nothing about
/// the room; a missing human requester says the run was not raised by a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestionRefusal {
    /// Anything about the arguments: an unknown key, an id outside
    /// [`SUGGESTABLE_COMMANDS`], an argument value outside its enum, a broken
    /// pair, an empty or oversized body.
    InvalidArguments,
    /// The run has no trigger message, or its author is not a human member
    /// (G3). Nothing is written.
    NoHumanRequester,
}

impl SuggestionRefusal {
    /// The word both doors use when they have to name the refusal — the worker
    /// in its `tool_result`, the hosted door in its log.
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionRefusal::InvalidArguments => "invalid_arguments",
            SuggestionRefusal::NoHumanRequester => "no_human_requester",
        }
    }
}

/// One command an agent may suggest (G2).
#[derive(Debug, Clone, Copy)]
pub struct SuggestableCommand {
    pub id: &'static str,
    /// Closed JSON Schema of `args`. The worker's tool definition embeds it;
    /// the protocol crate's copy is measured against it by a drift test.
    args_schema: fn() -> Value,
    /// `args` (already known to be an object) → the normalised object, or a
    /// refusal. The whole argument rule for this command lives here.
    normalize: fn(&Map<String, Value>) -> Result<Value, SuggestionRefusal>,
    /// Normalised `args` → the card title. Never an agent string.
    label: fn(&Value) -> &'static str,
}

/// Identity is the id, as for [`crate::actions::WorkspaceAction`].
impl PartialEq for SuggestableCommand {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for SuggestableCommand {}

impl SuggestableCommand {
    pub fn args_schema(&self) -> Value {
        (self.args_schema)()
    }

    pub fn label_for(&self, normalized_args: &Value) -> &'static str {
        (self.label)(normalized_args)
    }
}

/// The server allow-list (G2): `ai.connect`, `settings.open {section}`
/// (ADR-0201 v2 H6-4, #3939) and `work.request.open {harness?, prompt}`
/// (ADR-0201 v3 B8 C1, #4972).
///
/// Adding a command is four edits that one test measures together
/// (`routes::actions::the_suggestable_ids_are_one_list_in_four_places` in
/// `momo-server`, and `clients/web/src/app/commandRegistry.test.ts` reading
/// `SuggestableCommandId`): this list,
/// `momo_mcp`'s `SUGGESTABLE_COMMAND_IDS`, `docs/api/openapi.yaml`'s
/// `SuggestableCommandId`, and the TS registry's `agentSuggestable: true`.
///
/// G5's line: a command that **changes server state** never goes here. It goes
/// to D2 (`workspace:propose` + approval). Every entry is a client command whose
/// risk is `none` (ADR-0186 D3).
pub const SUGGESTABLE_COMMANDS: &[SuggestableCommand] = &[
    SuggestableCommand {
        id: COMMAND_AI_CONNECT,
        args_schema: ai_connect_args_schema,
        normalize: normalize_ai_connect_args,
        label: ai_connect_label,
    },
    SuggestableCommand {
        id: COMMAND_SETTINGS_OPEN,
        args_schema: settings_open_args_schema,
        normalize: normalize_settings_open_args,
        label: settings_open_label,
    },
    SuggestableCommand {
        id: COMMAND_WORK_REQUEST_OPEN,
        args_schema: work_request_open_args_schema,
        normalize: normalize_work_request_open_args,
        label: work_request_open_label,
    },
];

/// The allow-list's ids, in order. The two tool enums and the OpenAPI enum are
/// measured against exactly this.
pub fn suggestable_command_ids() -> Vec<&'static str> {
    SUGGESTABLE_COMMANDS
        .iter()
        .map(|command| command.id)
        .collect()
}

/// The command `id` names, or `None`. An id the ADR has not opened yet
/// (`appearance.accent` before AX-5) and an id that will never be here
/// (`invite.create`) answer alike.
pub fn suggestable_command(id: &str) -> Option<&'static SuggestableCommand> {
    SUGGESTABLE_COMMANDS.iter().find(|command| command.id == id)
}

fn ai_connect_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "harness": {"type": "string", "enum": AI_CONNECT_HARNESSES},
            "scope": {"type": "string", "enum": AI_CONNECT_SCOPES}
        }
    })
}

/// The pair a harness implies (G2: `team_key ⇔ team`, `claude | codex ⇔ mine`).
fn scope_of_harness(harness: &str) -> &'static str {
    if harness == "team_key" {
        "team"
    } else {
        "mine"
    }
}

/// One optional string argument restricted to an enum. `null` is absent — the
/// hosted schema's nullability contract, applied identically to the worker.
fn enum_arg(
    args: &Map<String, Value>,
    key: &str,
    allowed: &[&'static str],
) -> Result<Option<&'static str>, SuggestionRefusal> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => allowed
            .iter()
            .copied()
            .find(|candidate| *candidate == raw)
            .map(Some)
            .ok_or(SuggestionRefusal::InvalidArguments),
        Some(_) => Err(SuggestionRefusal::InvalidArguments),
    }
}

/// `ai.connect` `args` → normalised `args` (G2).
///
/// * Closed: any key but `harness`/`scope` is refused — `apiKey`, `token`,
///   `email` included. No value is free text.
/// * Pair: one side given → the server fills the other where it is unique;
///   both given and mismatched → refused.
/// * `{scope:"mine"}` alone has **two** candidate harnesses (claude, codex), so
///   there is no unique pair to fill: it is kept as `{scope:"mine"}` and opens
///   the 「내 계정」 절 with no harness pre-selected. Its label is 「내 AI 계정 연결」,
///   the no-harness row of the table. (Decision recorded in the PR; G2 does not
///   name this case.)
/// * `{}` stays `{}` and opens the whole card.
fn normalize_ai_connect_args(args: &Map<String, Value>) -> Result<Value, SuggestionRefusal> {
    if args.keys().any(|key| key != "harness" && key != "scope") {
        return Err(SuggestionRefusal::InvalidArguments);
    }
    let harness = enum_arg(args, "harness", &AI_CONNECT_HARNESSES)?;
    let scope = enum_arg(args, "scope", &AI_CONNECT_SCOPES)?;
    let (harness, scope) = match (harness, scope) {
        (Some(harness), Some(scope)) if scope_of_harness(harness) != scope => {
            return Err(SuggestionRefusal::InvalidArguments)
        }
        (Some(harness), _) => (Some(harness), Some(scope_of_harness(harness))),
        (None, Some("team")) => (Some("team_key"), Some("team")),
        (None, scope) => (None, scope),
    };
    let mut normalized = Map::new();
    if let Some(harness) = harness {
        normalized.insert("harness".into(), Value::String(harness.into()));
    }
    if let Some(scope) = scope {
        normalized.insert("scope".into(), Value::String(scope.into()));
    }
    Ok(Value::Object(normalized))
}

/// G3's derivation table for `ai.connect`.
fn ai_connect_label(args: &Value) -> &'static str {
    match args.get("harness").and_then(Value::as_str) {
        Some("claude") => "Claude 구독 연결",
        Some("codex") => "Codex 구독 연결",
        Some("team_key") => "팀 AI 키 연결",
        _ => "내 AI 계정 연결",
    }
}

fn settings_open_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "section": {"type": "string", "enum": SETTINGS_OPEN_SECTIONS}
        },
        "required": ["section"]
    })
}

/// `settings.open` `args` → normalised `args`.
///
/// Closed and **required**: the one key is `section`, an enum member. A missing
/// `section`, a `null`, a path (`/settings`, `?section=…`), a legacy alias, an
/// unknown id or a second key is `InvalidArguments` — the tool result tells the
/// model to answer in text instead, which is the server half of "an unknown
/// section falls back to prose".
fn normalize_settings_open_args(args: &Map<String, Value>) -> Result<Value, SuggestionRefusal> {
    if args.keys().any(|key| key != "section") {
        return Err(SuggestionRefusal::InvalidArguments);
    }
    let section = enum_arg(args, "section", &SETTINGS_OPEN_SECTIONS)?
        .ok_or(SuggestionRefusal::InvalidArguments)?;
    Ok(json!({ "section": section }))
}

/// The derivation table for `settings.open` — one row per
/// [`SETTINGS_OPEN_SECTIONS`] entry, never an agent string. Each is the nav
/// row's own label plus 「열기」, so the card says what the settings page says.
fn settings_open_label(args: &Value) -> &'static str {
    match args.get("section").and_then(Value::as_str) {
        Some("profile") => "프로필 설정 열기",
        Some("appearance") => "모양 설정 열기",
        Some("notifications") => "알림 설정 열기",
        Some("shortcuts") => "단축키 설정 열기",
        Some("devices") => "기기 설정 열기",
        Some("workspace") => "워크스페이스 설정 열기",
        Some("members") => "멤버와 초대 열기",
        Some("memory") => "기억 설정 열기",
        Some("usage") => "사용량 열기",
        Some("code") => "실행 호스트 설정 열기",
        Some("updates") => "업데이트 설정 열기",
        Some("plugins") => "앱 설정 열기",
        // Unreachable through `validate_suggestion` (the normaliser refuses
        // anything else); a generic row rather than a panic.
        _ => "설정 열기",
    }
}

fn work_request_open_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "harness": {"type": "string", "enum": WORK_REQUEST_HARNESSES},
            "prompt": {
                "type": "string",
                "minLength": 1,
                "maxLength": WORK_REQUEST_PROMPT_MAX_BYTES,
                "description": "What to ask the person's own Claude Code or Codex to do, in the person's voice and as plain text (1-8000 UTF-8 bytes; line feeds and tabs are the only control characters; it may not start with `/`). They read it in the sheet and send it themselves."
            }
        },
        "required": ["prompt"]
    })
}

/// `work.request.open` `args` → normalised `args`.
///
/// Closed, and **`prompt` is required** — the one free-text value a suggestion carries, so it
/// is the one with a rule of its own ([`normalize_work_request_prompt`]). `harness` is optional
/// and an enum member ([`WORK_REQUEST_HARNESSES`]); `null` is absent, `team_key`, `grok`,
/// `opencode` and spellings are `InvalidArguments`. Nothing else rides along.
fn normalize_work_request_open_args(args: &Map<String, Value>) -> Result<Value, SuggestionRefusal> {
    if args.keys().any(|key| key != "harness" && key != "prompt") {
        return Err(SuggestionRefusal::InvalidArguments);
    }
    let harness = enum_arg(args, "harness", &WORK_REQUEST_HARNESSES)?;
    let prompt = match args.get("prompt") {
        Some(Value::String(raw)) => normalize_work_request_prompt(raw)?,
        _ => return Err(SuggestionRefusal::InvalidArguments),
    };
    let mut normalized = Map::new();
    if let Some(harness) = harness {
        normalized.insert("harness".into(), Value::String(harness.into()));
    }
    normalized.insert("prompt".into(), Value::String(prompt));
    Ok(Value::Object(normalized))
}

/// The prompt a card may carry: the text the sheet's send path would accept, and shorter.
///
/// * line endings are made `\n` (a carriage return is refused by the send path, which asks
///   clients to send `\n`) and the ends are trimmed, as the sheet trims before sending;
/// * [`momo_wire::human_control::spawn_prompt_problem`] — **the function the signed spawn
///   itself judges the prompt with**: not blank, 1...32,768 characters, only line feeds and tabs
///   as control characters, nothing hidden (zero-width, direction marks, private use…);
/// * not an adapter command: a prompt starting with `/` is what the phone sheet refuses to
///   send, so a card never pre-fills one;
/// * at most [`WORK_REQUEST_PROMPT_MAX_BYTES`] UTF-8 bytes.
///
/// The text is an agent's own words and stays so: it is shown only inside the sheet's input,
/// where the person reads and may edit it before sending. It is never a card title, a label or
/// a notification line, and it is never written to an audit row or a trace (H9-I10).
fn normalize_work_request_prompt(raw: &str) -> Result<String, SuggestionRefusal> {
    let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
    let text = unified.trim();
    if momo_wire::human_control::spawn_prompt_problem(text).is_some()
        || text.starts_with('/')
        || text.len() > WORK_REQUEST_PROMPT_MAX_BYTES
    {
        return Err(SuggestionRefusal::InvalidArguments);
    }
    Ok(text.to_string())
}

/// The derivation table for `work.request.open` — keyed by `harness` only, never by the prompt
/// and never an agent string. The owner's own wording (「내 맥의 Claude Code·Codex에 맡기기」),
/// narrowed to the tool the card names.
fn work_request_open_label(args: &Value) -> &'static str {
    match args.get("harness").and_then(Value::as_str) {
        Some("claude") => "내 맥의 Claude Code에 맡기기",
        Some("codex") => "내 맥의 Codex에 맡기기",
        _ => "내 맥에 작업 맡기기",
    }
}

/// Every command's `args` properties as the properties of **one closed object** — the shape both
/// published tool schemas use (the worker's `card_suggest`, and the protocol crate's copy for the
/// hosted `oort_card_suggest`, which `routes::actions` measures against this).
///
/// Two commands may declare the same property name only when both declare it as a string enum
/// (`ai.connect` and `work.request.open` both take `harness`): the merged property carries the
/// **union** of the enums, in first-seen order. Merging widens only the first fence; each
/// command's own normaliser stays the gate and still refuses the other command's values
/// (`team_key` for a work request). Any other shared name is a build-time mistake and panics, as
/// the schema builder did before the merge was allowed.
pub fn merged_args_properties(commands: &[SuggestableCommand]) -> Map<String, Value> {
    let mut merged = Map::new();
    for command in commands {
        let schema = command.args_schema();
        let Some(own) = schema["properties"].as_object() else {
            continue;
        };
        for (name, property) in own {
            match merged.get_mut(name) {
                None => {
                    merged.insert(name.clone(), property.clone());
                }
                Some(existing) => merge_shared_enum_property(name, existing, property),
            }
        }
    }
    merged
}

fn merge_shared_enum_property(name: &str, existing: &mut Value, other: &Value) {
    let both_enums = existing.get("enum").and_then(Value::as_array).is_some()
        && other.get("enum").and_then(Value::as_array).is_some();
    assert!(
        both_enums && existing.get("type") == other.get("type"),
        "two suggestable commands both declare args.{name}, and it is not the same kind of enum on both sides"
    );
    let mut union = existing["enum"].as_array().cloned().unwrap_or_default();
    for value in other["enum"].as_array().into_iter().flatten() {
        if !union.contains(value) {
            union.push(value.clone());
        }
    }
    existing["enum"] = Value::Array(union);
}

/// A suggestion that passed every rule, in the only shape props are built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedSuggestion {
    pub command_id: &'static str,
    /// Normalised — never the agent's object copied through.
    pub args: Value,
    /// Derived from `(command_id, args)`.
    pub label: &'static str,
    /// The agent's own answer text, which the message carries as its body.
    pub body: String,
}

/// Validate a suggestion's three agent-facing fields.
///
/// `arguments` is the whole tool-call argument object. `allowed_extra` names
/// the keys the calling door owns itself (the hosted door's `handle`,
/// `clientMsgId`, `rootId`); the worker passes none. **Every other key is
/// refused** — which is what makes `label`, `forMemberId`, `channelId` and
/// `props` impossible to pass on either door, rather than silently ignored.
pub fn validate_suggestion(
    arguments: &Value,
    allowed_extra: &[&str],
) -> Result<ValidatedSuggestion, SuggestionRefusal> {
    validate_suggestion_among(arguments, allowed_extra, None)
}

/// [`validate_suggestion`] for a door that offers **fewer** commands than the allow-list: the
/// team AI helper, whose request advertises only the commands its role bundles are on for
/// ([`crate::team_ai_roles::TeamAiRoles::advertised_command_ids`]). `offered: Some(ids)` refuses
/// a `commandId` that is on the allow-list but not on `ids`, so a model that names a command it
/// was not shown gets nothing; `None` is the plain allow-list, which the hosted door and the
/// ordinary worker door use.
pub fn validate_suggestion_among(
    arguments: &Value,
    allowed_extra: &[&str],
    offered: Option<&[&str]>,
) -> Result<ValidatedSuggestion, SuggestionRefusal> {
    let invalid = SuggestionRefusal::InvalidArguments;
    let object = arguments.as_object().ok_or(invalid)?;
    if object.keys().any(|key| {
        !SUGGESTION_ARGUMENT_KEYS.contains(&key.as_str()) && !allowed_extra.contains(&key.as_str())
    }) {
        return Err(invalid);
    }
    let command_id = object
        .get("commandId")
        .and_then(Value::as_str)
        .ok_or(invalid)?;
    let command = suggestable_command(command_id).ok_or(invalid)?;
    if offered.is_some_and(|offered| !offered.contains(&command.id)) {
        return Err(invalid);
    }
    let args = match object.get("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(args)) => args.clone(),
        Some(_) => return Err(invalid),
    };
    let args = (command.normalize)(&args)?;
    let body = object.get("body").and_then(Value::as_str).ok_or(invalid)?;
    if body.trim().is_empty() || body.len() > SUGGESTION_BODY_MAX_BYTES {
        return Err(invalid);
    }
    Ok(ValidatedSuggestion {
        command_id: command.id,
        label: command.label_for(&args),
        args,
        body: body.to_string(),
    })
}

/// `message.props` of a suggestion (G3) — **exactly five keys**, all
/// server-built. No state, no result, no key tail, no email, no display name,
/// no device, no path: the card reads live state from the viewer's own settings
/// store, so there is nothing here that could go stale or leak.
pub fn command_suggest_props(suggestion: &ValidatedSuggestion, for_member_id: Uuid) -> Value {
    json!({
        COMMAND_SUGGEST_PROPS_KEY: {
            "v": COMMAND_SUGGEST_VERSION,
            "command_id": suggestion.command_id,
            "args": suggestion.args.clone(),
            "for_member_id": for_member_id.to_string(),
            "label": suggestion.label,
        }
    })
}

/// Who a suggestion is for, and where the run's trigger sat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestionRequester {
    pub member_id: Uuid,
    /// For the worker's reply sentence only, and only through
    /// [`crate::inert_display_name`]. Never written into props.
    pub display_name: String,
    /// The trigger's channel. The worker posts the card here.
    pub channel_id: Uuid,
    /// The thread the trigger was in (`None` at channel top level). The worker
    /// posts the card in the same place (G1 「트리거 메시지 자리」).
    pub thread_root_id: Option<Uuid>,
}

/// `for_member_id` (G3): the author of `agent_run.trigger_message_id`, if that
/// author is a **human** member of this workspace.
///
/// `None` — which both doors turn into `no_human_requester` with zero messages
/// — when the run has no trigger (a work run, a resumed run whose trigger was
/// never recorded), the trigger's author is an agent (agent-to-agent
/// delegation), the person deleted the request, or the person is no longer an
/// active member of the trigger's channel (#2959 review L1: a card for someone
/// who cannot see it would only leave 「…에게 제안했어요」 in the room, and a
/// deleted request must not come back as a card). The run row is the source rather than a job payload: the run is
/// durable and survives a resume, and `resume_job_payload` writes no trigger.
///
/// A read. This crate still owns no message *writes* (Cargo.toml).
pub async fn suggestion_requester_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Option<SuggestionRequester>, DbError> {
    let row = sqlx::query(
        "SELECT m.id AS member_id, m.display_name, t.channel_id, t.root_id \
           FROM agent_run r \
           JOIN message t \
             ON t.id = r.trigger_message_id \
            AND t.workspace_id = $1 \
            AND t.deleted_at IS NULL \
           JOIN member m \
             ON m.id = t.author_member_id \
            AND m.workspace_id = $1 \
            AND m.kind = 'human' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          WHERE r.id = $2 \
            AND r.workspace_id = $1 \
            AND EXISTS ( \
              SELECT 1 FROM membership ms \
               WHERE ms.workspace_id = $1 \
                 AND ms.channel_id = t.channel_id \
                 AND ms.member_id = m.id \
                 AND ms.left_at IS NULL \
            )",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(SuggestionRequester {
        member_id: row.try_get("member_id")?,
        display_name: row.try_get("display_name")?,
        channel_id: row.try_get("channel_id")?,
        thread_root_id: row.try_get("root_id")?,
    }))
}

/// The namespace the worker card's idempotency key hangs off.
///
/// A **third** key space beside the worker's two (`tool_exec::call_message_id`
/// = `new_v5(&run_id, call_id)` and `tool_exec::result_message_id` =
/// `new_v5(b"momo.tool_result", run‖call)`): all three messages share
/// `(channel, author)`, so any two keys agreeing would make the spine's
/// `ON CONFLICT DO NOTHING` drop one of them silently. A fixed namespace rather
/// than a prefixed name, for #1133's reason — a provider controls `call_id`,
/// so a name prefix could be spelled into another space. Byte 6 is `a`
/// (`0x61`), version nibble 6, so no `uuidv7()` run id can equal it.
const CARD_SUGGEST_NAMESPACE: Uuid = Uuid::from_bytes(*b"momo.card_suggst");

/// The worker card's `client_msg_id` (G1: 「멱등 키는 `(run_id, tool_call_id)`에서
/// 결정적으로」). `run_id` is a fixed 16-byte prefix, so the mapping is
/// injective, like `result_message_id`.
pub fn worker_card_client_msg_id(run_id: Uuid, call_id: &str) -> Uuid {
    let mut name = Vec::with_capacity(16 + call_id.len());
    name.extend_from_slice(run_id.as_bytes());
    name.extend_from_slice(call_id.as_bytes());
    Uuid::new_v5(&CARD_SUGGEST_NAMESPACE, &name)
}

/// The worker's `tool_result` sentence — which `finish_tool_turn` also posts
/// as the turn's reply, so it is **rendered by the clients' markdown parser**.
/// The requester's name therefore goes through [`crate::inert_display_name`]:
/// a member named `[여기](https://…)` must not become a link in an agent's
/// message. The label is from the static table and needs nothing. The closing
/// clause is the command's own (a settings card connects nothing), from a
/// static table keyed by `command_id`.
pub fn suggestion_tool_output(
    requester_display_name: &str,
    label: &str,
    command_id: &str,
) -> String {
    let closing = match command_id {
        COMMAND_SETTINGS_OPEN => "열지는 그 사람이 카드에서 직접 정해요.",
        COMMAND_WORK_REQUEST_OPEN => "보낼지는 그 사람이 열린 시트에서 직접 정해요.",
        _ => "연결은 그 사람이 카드에서 직접 해요.",
    };
    format!(
        "{}님에게 「{label}」 카드를 보냈어요. {closing}",
        crate::inert_display_name(requester_display_name)
    )
}

/// The worker's `tool_result` for a refusal. Names the reason in the model's
/// terms so it does not retry the same call; carries no argument echo.
pub fn suggestion_refusal_output(refusal: SuggestionRefusal) -> String {
    match refusal {
        SuggestionRefusal::InvalidArguments => format!(
            "card_suggest refused ({}): send only commandId, args and body. \
             commandId must be one of {:?}; for ai.connect, args may carry only \
             harness ({:?}) and scope ({:?}), and they must pair (team_key with team, \
             claude or codex with mine); for settings.open, args must be exactly \
             {{\"section\": one of {:?}}}; for work.request.open, args must be \
             {{\"prompt\": 1-{} bytes of plain text that does not start with /, \
             \"harness\": optional, one of {:?}}}. body must be 1-{} bytes.",
            refusal.as_str(),
            suggestable_command_ids(),
            AI_CONNECT_HARNESSES,
            AI_CONNECT_SCOPES,
            SETTINGS_OPEN_SECTIONS,
            WORK_REQUEST_PROMPT_MAX_BYTES,
            WORK_REQUEST_HARNESSES,
            SUGGESTION_BODY_MAX_BYTES,
        ),
        SuggestionRefusal::NoHumanRequester => format!(
            "card_suggest refused ({}): this run was not started by a person, so \
             there is nobody to suggest a card to. Answer in text instead.",
            refusal.as_str()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn suggest(arguments: Value) -> Result<ValidatedSuggestion, SuggestionRefusal> {
        validate_suggestion(&arguments, &[])
    }

    #[test]
    fn the_allow_list_is_exactly_the_three_commands() {
        assert_eq!(
            suggestable_command_ids(),
            vec!["ai.connect", "settings.open", "work.request.open"]
        );
        assert!(suggestable_command("ai.connect").is_some());
        assert!(suggestable_command("settings.open").is_some());
        assert!(suggestable_command("work.request.open").is_some());
    }

    /// G6: an id outside the allow-list is refused — a workspace action and a
    /// client command AX-5 has not opened yet alike.
    #[test]
    fn an_id_outside_the_allow_list_is_refused() {
        for id in [
            "invite.create",
            "appearance.accent",
            "nav.inbox",
            "",
            "AI.CONNECT",
        ] {
            assert_eq!(
                suggest(json!({"commandId": id, "body": "연결해 드릴게요"})),
                Err(SuggestionRefusal::InvalidArguments),
                "{id}"
            );
        }
    }

    /// G6: the four keys G1 names are refused on the worker door (no extras),
    /// and on the hosted door (its own three extras) — the hosted extras do not
    /// open them.
    #[test]
    fn the_four_refused_keys_are_refused_on_both_doors() {
        for key in REFUSED_ARGUMENT_KEYS {
            let mut arguments = json!({"commandId": "ai.connect", "body": "연결 카드예요"});
            arguments[key] = json!("anything");
            assert_eq!(
                suggest(arguments.clone()),
                Err(SuggestionRefusal::InvalidArguments),
                "worker door accepted {key}"
            );
            assert_eq!(
                validate_suggestion(&arguments, &["handle", "clientMsgId", "rootId"]),
                Err(SuggestionRefusal::InvalidArguments),
                "hosted door accepted {key}"
            );
        }
        // …and a typo is not an ignored key either.
        assert_eq!(
            suggest(json!({"commandId": "ai.connect", "body": "x", "Body": "y"})),
            Err(SuggestionRefusal::InvalidArguments)
        );
    }

    /// G6: a secret-shaped key inside `args` is refused, and so is every other
    /// key but the two the command declares.
    #[test]
    fn args_are_closed_and_secret_names_are_refused() {
        for key in [
            "apiKey",
            "token",
            "email",
            "api_key",
            "password",
            "label",
            "for_member_id",
        ] {
            assert_eq!(
                suggest(
                    json!({"commandId": "ai.connect", "args": {key: "sk-live-x"}, "body": "b"})
                ),
                Err(SuggestionRefusal::InvalidArguments),
                "{key}"
            );
        }
        assert_eq!(
            suggest(json!({"commandId": "ai.connect", "args": "claude", "body": "b"})),
            Err(SuggestionRefusal::InvalidArguments),
            "args is an object or absent"
        );
    }

    /// G2: `grok` is not in v1, and values are an enum, not free text.
    #[test]
    fn grok_and_free_text_values_are_refused() {
        for args in [
            json!({"harness": "grok"}),
            json!({"harness": "Claude"}),
            json!({"harness": 1}),
            json!({"scope": "everyone"}),
        ] {
            assert_eq!(
                suggest(json!({"commandId": "ai.connect", "args": args.clone(), "body": "b"})),
                Err(SuggestionRefusal::InvalidArguments),
                "{args}"
            );
        }
        assert!(!AI_CONNECT_HARNESSES.contains(&"grok"));
    }

    /// G2 / G6: the pair rule. A mismatch is refused; one side fills the other
    /// where the pair is unique.
    #[test]
    fn the_pair_rule_refuses_mismatches_and_fills_unique_pairs() {
        for (harness, scope) in [("team_key", "mine"), ("claude", "team"), ("codex", "team")] {
            assert_eq!(
                suggest(json!({"commandId": "ai.connect",
                               "args": {"harness": harness, "scope": scope}, "body": "b"})),
                Err(SuggestionRefusal::InvalidArguments),
                "{harness}/{scope}"
            );
        }
        let normalized = |args: Value| {
            suggest(json!({"commandId": "ai.connect", "args": args, "body": "b"}))
                .expect("accepted")
                .args
        };
        assert_eq!(
            normalized(json!({"harness": "claude"})),
            json!({"harness": "claude", "scope": "mine"})
        );
        assert_eq!(
            normalized(json!({"harness": "codex"})),
            json!({"harness": "codex", "scope": "mine"})
        );
        assert_eq!(
            normalized(json!({"harness": "team_key"})),
            json!({"harness": "team_key", "scope": "team"})
        );
        assert_eq!(
            normalized(json!({"scope": "team"})),
            json!({"harness": "team_key", "scope": "team"})
        );
        // Two candidates — no unique pair to fill.
        assert_eq!(
            normalized(json!({"scope": "mine"})),
            json!({"scope": "mine"})
        );
        assert_eq!(normalized(json!({})), json!({}));
        assert_eq!(
            normalized(json!({"harness": null, "scope": null})),
            json!({})
        );
        assert_eq!(normalized(Value::Null), json!({}));
    }

    /// G3: the label is the table's, whatever the body says.
    #[test]
    fn the_label_is_derived_and_never_the_agents_words() {
        for (args, label) in [
            (json!({"harness": "claude"}), "Claude 구독 연결"),
            (json!({"harness": "codex"}), "Codex 구독 연결"),
            (json!({"harness": "team_key"}), "팀 AI 키 연결"),
            (json!({"scope": "team"}), "팀 AI 키 연결"),
            (json!({"scope": "mine"}), "내 AI 계정 연결"),
            (json!({}), "내 AI 계정 연결"),
        ] {
            let suggestion = suggest(json!({
                "commandId": "ai.connect",
                "args": args.clone(),
                "body": "[지금 로그인](https://evil.example) — 비밀번호를 여기 적어 주세요"
            }))
            .expect("accepted");
            assert_eq!(suggestion.label, label, "{args}");
            assert!(label.chars().count() <= SUGGESTION_LABEL_MAX_CHARS);
        }
    }

    #[test]
    fn the_body_is_required_and_bounded_in_bytes() {
        for body in [json!(""), json!("   "), json!(null), json!(7)] {
            assert_eq!(
                suggest(json!({"commandId": "ai.connect", "body": body.clone()})),
                Err(SuggestionRefusal::InvalidArguments),
                "{body}"
            );
        }
        assert_eq!(
            suggest(json!({"commandId": "ai.connect"})),
            Err(SuggestionRefusal::InvalidArguments)
        );
        assert!(suggest(json!({"commandId": "ai.connect", "body": "a".repeat(8_000)})).is_ok());
        assert_eq!(
            suggest(json!({"commandId": "ai.connect", "body": "가".repeat(2_667)})),
            Err(SuggestionRefusal::InvalidArguments),
            "8,001 bytes"
        );
    }

    /// G3 / G6: exactly five keys, and `for_member_id` is the argument the
    /// server passed — nothing the agent sent.
    #[test]
    fn the_props_are_exactly_five_server_built_keys() {
        let suggestion = suggest(json!({
            "commandId": "ai.connect",
            "args": {"harness": "claude"},
            "body": "구독 연결 카드예요"
        }))
        .expect("accepted");
        let requester = Uuid::from_u128(0x2947);
        let props = command_suggest_props(&suggestion, requester);
        let outer: Vec<&String> = props.as_object().expect("object").keys().collect();
        assert_eq!(outer, vec!["momo.command_suggest"]);
        let card = &props[COMMAND_SUGGEST_PROPS_KEY];
        let mut keys: Vec<&str> = card
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["args", "command_id", "for_member_id", "label", "v"]
        );
        assert_eq!(card["v"], json!(1));
        assert_eq!(card["command_id"], json!("ai.connect"));
        assert_eq!(card["args"], json!({"harness": "claude", "scope": "mine"}));
        assert_eq!(card["for_member_id"], json!(requester.to_string()));
        assert_eq!(card["label"], json!("Claude 구독 연결"));
        // The body is the message's, never the card's.
        assert!(!props.to_string().contains("구독 연결 카드예요"));
    }

    /// The worker's reply sentence is markdown-rendered, so the requester's
    /// name is made inert (#2889's rule).
    #[test]
    fn the_worker_sentence_makes_the_requesters_name_inert() {
        let output = suggestion_tool_output(
            "[눌러](https://evil.example)`x`",
            "Claude 구독 연결",
            "ai.connect",
        );
        assert!(!output.contains("[눌러]"), "{output}");
        assert!(!output.contains("https://"), "{output}");
        assert!(!output.contains('`'), "{output}");
        assert!(output.contains("「Claude 구독 연결」"));
        assert_eq!(
            suggestion_tool_output("곽성재", "내 AI 계정 연결", "ai.connect"),
            "곽성재님에게 「내 AI 계정 연결」 카드를 보냈어요. 연결은 그 사람이 카드에서 직접 해요."
        );
        // A settings card connects nothing — its sentence does not say so.
        let opened = suggestion_tool_output("곽성재", "알림 설정 열기", "settings.open");
        assert_eq!(
            opened,
            "곽성재님에게 「알림 설정 열기」 카드를 보냈어요. 열지는 그 사람이 카드에서 직접 정해요."
        );
        assert!(!opened.contains("연결"), "{opened}");
    }

    #[test]
    fn the_refusal_sentences_name_their_reason() {
        assert!(
            suggestion_refusal_output(SuggestionRefusal::NoHumanRequester)
                .contains("no_human_requester")
        );
        let invalid = suggestion_refusal_output(SuggestionRefusal::InvalidArguments);
        assert!(invalid.contains("invalid_arguments"));
        assert!(!invalid.contains("grok"), "{invalid}");
    }

    #[test]
    fn the_card_key_is_deterministic_and_run_scoped() {
        let run = Uuid::from_u128(1);
        assert_eq!(
            worker_card_client_msg_id(run, "c"),
            worker_card_client_msg_id(run, "c")
        );
        assert_ne!(
            worker_card_client_msg_id(run, "c"),
            worker_card_client_msg_id(run, "d")
        );
        assert_ne!(
            worker_card_client_msg_id(run, "c"),
            worker_card_client_msg_id(Uuid::from_u128(2), "c")
        );
    }

    #[test]
    fn every_args_schema_is_closed_and_lists_the_enums_the_normaliser_reads() {
        for command in SUGGESTABLE_COMMANDS {
            let schema = command.args_schema();
            assert_eq!(schema["type"], "object", "{}", command.id);
            assert_eq!(schema["additionalProperties"], false, "{}", command.id);
        }
        let schema = suggestable_command(COMMAND_AI_CONNECT)
            .expect("v1")
            .args_schema();
        assert_eq!(
            schema["properties"]["harness"]["enum"],
            json!(AI_CONNECT_HARNESSES)
        );
        assert_eq!(
            schema["properties"]["scope"]["enum"],
            json!(AI_CONNECT_SCOPES)
        );
    }

    /// GC-8 (#2949): the connection-request rule rides with the tool and only
    /// with it. Offered without the tool, it would send the model to a refusal;
    /// withheld while the tool is on, the tool is a name the model has no
    /// reason to reach for when a person says 「연결해 줘」.
    #[test]
    fn the_directive_rides_only_with_the_tool_it_names() {
        use crate::tools::{enabled_tool_definitions, CARD_SUGGEST, CATALOG};
        let on = enabled_tool_definitions(&[CARD_SUGGEST.to_string()]);
        assert_eq!(card_suggest_directive(&on), Some(CARD_SUGGEST_DIRECTIVE));
        // The executor's spelling rule, not a byte compare.
        let shouted = enabled_tool_definitions(&["Card-Suggest".to_string()]);
        assert_eq!(
            card_suggest_directive(&shouted),
            Some(CARD_SUGGEST_DIRECTIVE)
        );
        // Every other catalog tool, switched on together, still carries no rule.
        let others: Vec<String> = CATALOG
            .iter()
            .filter(|name| **name != CARD_SUGGEST)
            .map(|name| name.to_string())
            .collect();
        assert!(!others.is_empty());
        let other = enabled_tool_definitions(&others);
        assert_eq!(other.len(), others.len());
        assert_eq!(card_suggest_directive(&other), None);
        assert_eq!(card_suggest_directive(&[]), None);
    }

    /// The directive names the tool and the command the server actually
    /// accepts, and says the two things the model must not do. A rename on
    /// either side fails here instead of teaching the model a dead name.
    #[test]
    fn the_directive_names_the_live_tool_and_command() {
        assert!(CARD_SUGGEST_DIRECTIVE.contains(&format!("`{}`", crate::tools::CARD_SUGGEST)));
        assert!(CARD_SUGGEST_DIRECTIVE.contains(&format!("`{COMMAND_AI_CONNECT}`")));
        assert!(suggestable_command(COMMAND_AI_CONNECT).is_some());
        for harness in AI_CONNECT_HARNESSES {
            assert!(
                CARD_SUGGEST_DIRECTIVE.contains(&format!("`{harness}`")),
                "{harness}"
            );
        }
        assert!(CARD_SUGGEST_DIRECTIVE.contains("do not try to do it yourself"));
        assert!(CARD_SUGGEST_DIRECTIVE.contains("Never ask for a key, token, password"));
    }

    /// GC-8 (#2949): the golden vector both tracks read. What this crate
    /// assembles for each case is byte-for-byte the committed props, so a
    /// change on the server side fails here before a client renders it wrong.
    #[test]
    fn the_props_match_the_shared_golden_vector() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/api/command-suggest-ai-connect.golden.json"
        );
        let golden: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read golden"))
                .expect("golden is JSON");
        let requester = Uuid::parse_str(
            golden["for_member_id_placeholder"]
                .as_str()
                .expect("placeholder"),
        )
        .expect("placeholder uuid");
        let cases = golden["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), 4, "one case per label row");
        for case in cases {
            let validated =
                validate_suggestion(&case["arguments"], &[]).expect("golden arguments are legal");
            assert_eq!(
                command_suggest_props(&validated, requester),
                case["props"],
                "{}",
                case["name"]
            );
        }
    }

    // ---- settings.open {section} (ADR-0201 v2 H6-4, #3939 E-S6) -------------

    fn open_section(section: &str) -> Result<ValidatedSuggestion, SuggestionRefusal> {
        suggest(json!({
            "commandId": "settings.open",
            "args": {"section": section},
            "body": "설정에서 열 수 있어요"
        }))
    }

    /// The enum is pinned here as a literal, **independent of the constant**: a
    /// test that iterated the constant would stay green when a value is deleted
    /// from it (the red proof this ticket owes).
    const PINNED_SECTIONS: [&str; 12] = [
        "profile",
        "appearance",
        "notifications",
        "shortcuts",
        "devices",
        "workspace",
        "members",
        "memory",
        "usage",
        "code",
        "updates",
        "plugins",
    ];

    #[test]
    fn every_pinned_section_is_accepted_with_its_derived_label() {
        assert_eq!(SETTINGS_OPEN_SECTIONS, PINNED_SECTIONS);
        let mut labels = std::collections::BTreeSet::new();
        for section in PINNED_SECTIONS {
            let suggestion = open_section(section)
                .unwrap_or_else(|error| panic!("{section} was refused: {error:?}"));
            assert_eq!(suggestion.command_id, "settings.open");
            assert_eq!(suggestion.args, json!({"section": section}));
            assert_ne!(suggestion.label, "설정 열기", "{section} has no label row");
            assert!(suggestion.label.chars().count() <= SUGGESTION_LABEL_MAX_CHARS);
            assert!(labels.insert(suggestion.label), "{section} repeats a label");
        }
    }

    /// Red proof of the fallback: anything outside the enum is a refusal (the
    /// model answers in prose), and so is anything shaped like a path or an
    /// alias. Removing a value from `SETTINGS_OPEN_SECTIONS` turns the test
    /// above red; adding one turns the pin red.
    #[test]
    fn an_unknown_section_is_refused_so_the_answer_stays_prose() {
        for section in [
            "ai",
            "account",
            "link-previews",
            "terminal",
            "agents",
            "webhooks",
            "events",
            "apps",
            "Profile",
            "",
            " profile",
            "/settings",
            "/settings?section=profile",
            "/ai/external/apps",
            "?section=profile",
            "../profile",
        ] {
            assert_eq!(
                open_section(section),
                Err(SuggestionRefusal::InvalidArguments),
                "{section:?}"
            );
        }
    }

    #[test]
    fn settings_open_args_are_closed_and_the_section_is_required() {
        for args in [
            json!({}),
            json!(null),
            json!({"section": null}),
            json!({"section": 1}),
            json!({"section": ["profile"]}),
            json!({"section": "profile", "path": "/settings"}),
            json!({"section": "profile", "harness": "claude"}),
            json!({"section": "profile", "href": "https://evil.example"}),
            json!({"harness": "claude"}),
            json!("profile"),
        ] {
            assert_eq!(
                suggest(json!({"commandId": "settings.open", "args": args.clone(), "body": "b"})),
                Err(SuggestionRefusal::InvalidArguments),
                "{args}"
            );
        }
        // `args` absent is the same as `{}`: a section is required.
        assert_eq!(
            suggest(json!({"commandId": "settings.open", "body": "b"})),
            Err(SuggestionRefusal::InvalidArguments)
        );
        // …and the vocabularies do not leak across commands.
        assert_eq!(
            suggest(
                json!({"commandId": "ai.connect", "args": {"section": "profile"}, "body": "b"})
            ),
            Err(SuggestionRefusal::InvalidArguments)
        );
    }

    /// The labels are the table's, whatever the body says, and the props stay
    /// exactly the five server-built keys.
    #[test]
    fn settings_open_props_are_five_server_built_keys() {
        let suggestion = suggest(json!({
            "commandId": "settings.open",
            "args": {"section": "notifications"},
            "body": "[여기](https://evil.example) 알림 설정을 열어 드릴게요"
        }))
        .expect("accepted");
        let props = command_suggest_props(&suggestion, Uuid::from_u128(0x3939));
        let card = &props[COMMAND_SUGGEST_PROPS_KEY];
        let mut keys: Vec<&str> = card
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["args", "command_id", "for_member_id", "label", "v"]
        );
        assert_eq!(card["command_id"], json!("settings.open"));
        assert_eq!(card["args"], json!({"section": "notifications"}));
        assert_eq!(card["label"], json!("알림 설정 열기"));
        assert!(!props.to_string().contains("evil.example"));
    }

    /// The section ids are the **real** ids, read from the sources of truth
    /// rather than restated: a nav row renamed or removed in the web settings
    /// nav, or `plugins` dropped from the core AI hub model, turns this red
    /// instead of leaving a card that opens the profile page.
    #[test]
    fn the_sections_are_the_web_nav_ids_plus_the_core_apps_alias() {
        let read = |relative: &str| {
            std::fs::read_to_string(format!(
                "{}/../../../{relative}",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap_or_else(|error| panic!("read {relative}: {error}"))
        };
        let nav = read("clients/web/src/features/settings/settingsNav.ts");
        let union = nav
            .split("export type SettingsSectionId")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("SettingsSectionId union");
        let nav_ids: Vec<&str> = union
            .split('"')
            .enumerate()
            .filter_map(|(index, part)| (index % 2 == 1).then_some(part))
            .collect();
        assert!(nav_ids.len() >= 12, "parsed {nav_ids:?}");
        // The only nav ids left out are the AI hub link row and the old AI
        // link screen: `ai` until #4111 split it, then `ai` (AI 연결, not an
        // agent-openable section yet) and `aiHub` (the link row), and since
        // #4663 `devTools` (명령줄·AI 도구 — token issuance stays a human-only
        // door, so agents get no card that opens it). A new nav row still turns
        // this red until it is either openable or listed here.
        let left_out: Vec<&str> = nav_ids
            .iter()
            .copied()
            .filter(|id| !SETTINGS_OPEN_SECTIONS.contains(id))
            .collect();
        assert!(!left_out.is_empty(), "the AI hub link row is a nav id");
        assert!(
            left_out
                .iter()
                .all(|id| ["ai", "aiHub", "devTools"].contains(id)),
            "unexpected nav ids outside settings.open: {left_out:?}"
        );
        // Everything else is a nav id, except the apps alias, which core owns.
        let hub = read("packages/momo-core/src/features/ai/aiHubModel.ts");
        for section in SETTINGS_OPEN_SECTIONS {
            if section == "plugins" {
                assert!(
                    hub.contains("fromSettings: \"plugins\""),
                    "core no longer resolves ?section=plugins to the apps page"
                );
            } else {
                assert!(nav_ids.contains(&section), "{section} is not a nav id");
            }
        }
    }

    #[test]
    fn the_settings_open_props_match_the_shared_golden_vector() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/api/command-suggest-settings-open.golden.json"
        );
        let golden: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read golden"))
                .expect("golden is JSON");
        let requester = Uuid::parse_str(
            golden["for_member_id_placeholder"]
                .as_str()
                .expect("placeholder"),
        )
        .expect("placeholder uuid");
        let cases = golden["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), PINNED_SECTIONS.len(), "one case per section");
        for case in cases {
            let validated =
                validate_suggestion(&case["arguments"], &[]).expect("golden arguments are legal");
            assert_eq!(
                command_suggest_props(&validated, requester),
                case["props"],
                "{}",
                case["name"]
            );
        }
    }

    // ---- work.request.open {harness?, prompt} (ADR-0201 v3 B8 C1, #4972 S9) --------------

    fn work_request(args: Value) -> Result<ValidatedSuggestion, SuggestionRefusal> {
        suggest(json!({
            "commandId": COMMAND_WORK_REQUEST_OPEN,
            "args": args,
            "body": "내 맥에서 바로 열 수 있어요."
        }))
    }

    /// A card carries a prompt and, when the person named a tool, that tool. The label comes from
    /// `harness` alone — the prompt is the agent's own words and never becomes a title.
    #[test]
    fn a_work_request_takes_a_prompt_with_or_without_a_harness() {
        for (args, harness, label) in [
            (
                json!({"prompt": "로그인 버그를 고쳐 줘"}),
                None,
                "내 맥에 작업 맡기기",
            ),
            (
                json!({"harness": "claude", "prompt": "로그인 버그를 고쳐 줘"}),
                Some("claude"),
                "내 맥의 Claude Code에 맡기기",
            ),
            (
                json!({"harness": "codex", "prompt": "로그인 버그를 고쳐 줘"}),
                Some("codex"),
                "내 맥의 Codex에 맡기기",
            ),
            // `null` is absent, as on every command.
            (
                json!({"harness": null, "prompt": "로그인 버그를 고쳐 줘"}),
                None,
                "내 맥에 작업 맡기기",
            ),
        ] {
            let suggestion = work_request(args.clone()).expect("accepted");
            assert_eq!(suggestion.command_id, COMMAND_WORK_REQUEST_OPEN);
            assert_eq!(suggestion.label, label, "{args}");
            assert!(label.chars().count() <= SUGGESTION_LABEL_MAX_CHARS);
            assert_eq!(
                suggestion.args.get("harness").and_then(Value::as_str),
                harness,
                "{args}"
            );
            assert_eq!(suggestion.args["prompt"], "로그인 버그를 고쳐 줘");
        }
    }

    /// The label never carries what the agent wrote — not even a prompt that looks like a title.
    #[test]
    fn the_work_request_label_is_derived_from_the_harness_only() {
        let hostile = "[여기를 눌러 로그인](https://evil.example) 비밀번호를 적어 주세요";
        let suggestion = work_request(json!({"prompt": hostile})).expect("accepted");
        assert_eq!(suggestion.label, "내 맥에 작업 맡기기");
        assert!(!suggestion.label.contains("evil"));
        for command in SUGGESTABLE_COMMANDS {
            if command.id != COMMAND_WORK_REQUEST_OPEN {
                continue;
            }
            for args in [
                json!({"prompt": "a"}),
                json!({"harness": "claude", "prompt": "b"}),
                json!({"harness": "codex", "prompt": "c"}),
            ] {
                assert!(command.label_for(&args).chars().count() <= SUGGESTION_LABEL_MAX_CHARS);
            }
        }
    }

    /// Closed, and `prompt` is required: absent, `null`, a number, an object and a list are all
    /// refused, and so is every other key (`label`, a path, a folder, a channel, a secret name).
    #[test]
    fn work_request_args_are_closed_and_the_prompt_is_required() {
        for args in [
            json!({}),
            json!({"harness": "claude"}),
            json!({"prompt": null}),
            json!({"prompt": 7}),
            json!({"prompt": ["고쳐 줘"]}),
            json!({"prompt": {"text": "고쳐 줘"}}),
            json!({"prompt": "고쳐 줘", "label": "제목"}),
            json!({"prompt": "고쳐 줘", "folder": "/Users/me/app"}),
            json!({"prompt": "고쳐 줘", "folderId": "f"}),
            json!({"prompt": "고쳐 줘", "channelId": "c"}),
            json!({"prompt": "고쳐 줘", "apiKey": "sk-live-x"}),
            json!({"prompt": "고쳐 줘", "section": "code"}),
            json!({"prompt": "고쳐 줘", "scope": "mine"}),
        ] {
            assert_eq!(
                work_request(args.clone()),
                Err(SuggestionRefusal::InvalidArguments),
                "{args}"
            );
        }
        // `args` itself is an object; absent or `null` is an empty one, which has no prompt.
        for no_args in [json!(null), json!("고쳐 줘")] {
            assert_eq!(
                suggest(json!({
                    "commandId": COMMAND_WORK_REQUEST_OPEN,
                    "args": no_args,
                    "body": "b"
                })),
                Err(SuggestionRefusal::InvalidArguments)
            );
        }
        assert_eq!(
            suggest(json!({"commandId": COMMAND_WORK_REQUEST_OPEN, "body": "b"})),
            Err(SuggestionRefusal::InvalidArguments)
        );
    }

    /// The sheet offers Claude Code and Codex (OpenCode only when a Mac reports it): a card names
    /// one of those two. `team_key` is `ai.connect`'s word for a team API key — an agent, not a
    /// tool on somebody's Mac — and shares the property name without sharing the value.
    #[test]
    fn the_work_request_harness_is_claude_or_codex_only() {
        for harness in [
            json!("team_key"),
            json!("grok"),
            json!("opencode"),
            json!("Claude"),
            json!("claude_code"),
            json!(""),
            json!(1),
            json!(true),
            json!(["claude"]),
        ] {
            assert_eq!(
                work_request(json!({"harness": harness.clone(), "prompt": "고쳐 줘"})),
                Err(SuggestionRefusal::InvalidArguments),
                "{harness}"
            );
        }
        // …and the other way round: `ai.connect` still takes `team_key`, and no `prompt`.
        assert!(suggest(json!({
            "commandId": "ai.connect",
            "args": {"harness": "team_key"},
            "body": "b"
        }))
        .is_ok());
        assert_eq!(
            suggest(json!({
                "commandId": "ai.connect",
                "args": {"prompt": "고쳐 줘"},
                "body": "b"
            })),
            Err(SuggestionRefusal::InvalidArguments)
        );
    }

    fn prompt_of(raw: &str) -> Result<String, SuggestionRefusal> {
        work_request(json!({"prompt": raw}))
            .map(|suggestion| suggestion.args["prompt"].as_str().unwrap().to_string())
    }

    /// The first free-text value a suggestion carries has a rule of its own: the one the signed
    /// spawn judges a prompt with, plus the `/` rule and the byte cap.
    #[test]
    fn the_work_request_prompt_follows_the_sheets_own_rule() {
        // Plain text, newlines and tabs stay; the ends are trimmed; CRLF and CR become LF.
        assert_eq!(
            prompt_of("  첫째 줄\n\t둘째 줄  ").unwrap(),
            "첫째 줄\n\t둘째 줄"
        );
        assert_eq!(prompt_of("가\r\n나\r다").unwrap(), "가\n나\n다");
        // Refused: blank, a command for the adapter, controls, hidden characters.
        for bad in [
            "",
            "   \n\t ",
            "/clear",
            "  /clear 다 지워 줘",
            "고쳐\u{0007} 줘",
            "고쳐\u{001b}[31m 줘",
            "고쳐\u{0000} 줘",
            "고쳐\u{200b} 줘",
            "고쳐\u{202e} 줘",
            "고쳐\u{feff} 줘",
            "고쳐\u{e000} 줘",
            "고쳐\u{0085} 줘",
        ] {
            assert_eq!(
                prompt_of(bad),
                Err(SuggestionRefusal::InvalidArguments),
                "{bad:?}"
            );
        }
        // A `/` that is not first is only text.
        assert!(prompt_of("src/ 폴더의 버그를 고쳐 줘").is_ok());
    }

    /// The card never accepts what the sheet's send is bound to refuse: every string it accepts
    /// passes `spawn_prompt_problem`, and what the function refuses it refuses (the pin that
    /// keeps the two rules one rule).
    #[test]
    fn a_prompt_the_card_accepts_is_one_the_signed_spawn_accepts() {
        let samples = [
            "고쳐 줘",
            "line one\nline two\tindented",
            "a\u{200d}b",
            "  padded  ",
            "x\u{0008}y",
            "\u{2028}",
            "emoji 👨‍👩‍👧 family",
        ];
        for sample in samples {
            if let Ok(accepted) = prompt_of(sample) {
                assert_eq!(
                    momo_wire::human_control::spawn_prompt_problem(&accepted),
                    None,
                    "{sample:?}"
                );
            }
        }
        // And the function really is what refuses these (not a second list in this file).
        for hidden in ["a\u{200b}b", "a\u{2028}b", "a\u{0008}b"] {
            assert!(momo_wire::human_control::spawn_prompt_problem(hidden).is_some());
            assert!(prompt_of(hidden).is_err(), "{hidden:?}");
        }
    }

    #[test]
    fn the_work_request_prompt_is_bounded_in_bytes() {
        assert!(prompt_of(&"a".repeat(WORK_REQUEST_PROMPT_MAX_BYTES)).is_ok());
        assert_eq!(
            prompt_of(&"a".repeat(WORK_REQUEST_PROMPT_MAX_BYTES + 1)),
            Err(SuggestionRefusal::InvalidArguments)
        );
        // 2,666 Korean syllables are 7,998 bytes; 2,667 are 8,001.
        assert!(prompt_of(&"가".repeat(2_666)).is_ok());
        assert_eq!(
            prompt_of(&"가".repeat(2_667)),
            Err(SuggestionRefusal::InvalidArguments),
            "8,001 bytes"
        );
        // The spaces trimmed off the ends do not count against the cap.
        assert!(prompt_of(&format!(
            "  {}  ",
            "a".repeat(WORK_REQUEST_PROMPT_MAX_BYTES)
        ))
        .is_ok());
    }

    /// G3: the props are the five server-built keys, and `args` carries the normalised prompt —
    /// the one place an agent's own words ride, which is why nothing else may be added beside it.
    #[test]
    fn work_request_props_are_five_server_built_keys() {
        let requester = Uuid::from_u128(0x77);
        let suggestion =
            work_request(json!({"harness": "codex", "prompt": " 고쳐 줘 "})).expect("accepted");
        let props = command_suggest_props(&suggestion, requester);
        let envelope = props[COMMAND_SUGGEST_PROPS_KEY]
            .as_object()
            .expect("an object");
        let mut keys: Vec<&str> = envelope.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["args", "command_id", "for_member_id", "label", "v"]);
        assert_eq!(envelope["command_id"], COMMAND_WORK_REQUEST_OPEN);
        assert_eq!(
            envelope["args"],
            json!({"harness": "codex", "prompt": "고쳐 줘"})
        );
        assert_eq!(envelope["for_member_id"], requester.to_string());
        assert_eq!(envelope["label"], "내 맥의 Codex에 맡기기");
    }

    /// The helper door offers fewer commands than the allow-list: a command that is on the
    /// allow-list but was not offered to this request gets nothing.
    #[test]
    fn a_suggestion_among_the_offered_commands_refuses_the_rest() {
        let offered = [COMMAND_WORK_REQUEST_OPEN];
        let request = |command: &str, args: Value| {
            validate_suggestion_among(
                &json!({"commandId": command, "args": args, "body": "b"}),
                &[],
                Some(&offered),
            )
        };
        assert!(request(COMMAND_WORK_REQUEST_OPEN, json!({"prompt": "고쳐 줘"})).is_ok());
        assert_eq!(
            request(COMMAND_AI_CONNECT, json!({"harness": "claude"})),
            Err(SuggestionRefusal::InvalidArguments)
        );
        assert_eq!(
            request(COMMAND_SETTINGS_OPEN, json!({"section": "profile"})),
            Err(SuggestionRefusal::InvalidArguments)
        );
        // Nothing offered refuses everything; `None` is the plain allow-list.
        assert_eq!(
            validate_suggestion_among(
                &json!({"commandId": COMMAND_WORK_REQUEST_OPEN, "args": {"prompt": "x"}, "body": "b"}),
                &[],
                Some(&[]),
            ),
            Err(SuggestionRefusal::InvalidArguments)
        );
        assert!(validate_suggestion_among(
            &json!({"commandId": COMMAND_AI_CONNECT, "body": "b"}),
            &[],
            None
        )
        .is_ok());
    }

    /// `ai.connect` and `work.request.open` both take `harness`, so the merged property carries
    /// the union of the two enums; any other name two commands share is refused at build time.
    #[test]
    fn a_shared_enum_property_is_merged_and_any_other_clash_is_refused() {
        let merged = merged_args_properties(SUGGESTABLE_COMMANDS);
        assert_eq!(merged["harness"]["enum"], json!(AI_CONNECT_HARNESSES));
        assert_eq!(merged["scope"]["enum"], json!(AI_CONNECT_SCOPES));
        assert_eq!(merged["section"]["enum"], json!(SETTINGS_OPEN_SECTIONS));
        assert_eq!(
            merged["prompt"]["maxLength"],
            json!(WORK_REQUEST_PROMPT_MAX_BYTES)
        );
        let mut names: Vec<&str> = merged.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(names, ["harness", "prompt", "scope", "section"]);
        // The union is order-stable and keeps the first command's order.
        let work_first = [
            *suggestable_command(COMMAND_WORK_REQUEST_OPEN).unwrap(),
            *suggestable_command(COMMAND_AI_CONNECT).unwrap(),
        ];
        assert_eq!(
            merged_args_properties(&work_first)["harness"]["enum"],
            json!(["claude", "codex", "team_key"])
        );
        // A shared name that is not an enum on both sides is a mistake, not a merge.
        fn free_text_harness() -> Value {
            json!({"type": "object", "properties": {"harness": {"type": "string"}}})
        }
        fn no_normalize(_: &Map<String, Value>) -> Result<Value, SuggestionRefusal> {
            Ok(json!({}))
        }
        fn no_label(_: &Value) -> &'static str {
            "x"
        }
        let clash = [
            *suggestable_command(COMMAND_AI_CONNECT).unwrap(),
            SuggestableCommand {
                id: "test.clash",
                args_schema: free_text_harness,
                normalize: no_normalize,
                label: no_label,
            },
        ];
        assert!(std::panic::catch_unwind(|| merged_args_properties(&clash)).is_err());
    }

    /// The worker's sentence closes with what the person does next, per command.
    #[test]
    fn the_work_request_sentence_says_the_person_sends_it() {
        let sentence =
            suggestion_tool_output("구민수", "내 맥에 작업 맡기기", COMMAND_WORK_REQUEST_OPEN);
        assert!(sentence.contains("구민수님에게 「내 맥에 작업 맡기기」 카드를 보냈어요."));
        assert!(sentence.contains("보낼지는 그 사람이 열린 시트에서 직접 정해요."));
        let invalid = suggestion_refusal_output(SuggestionRefusal::InvalidArguments);
        assert!(invalid.contains("work.request.open"), "{invalid}");
        assert!(invalid.contains("prompt"), "{invalid}");
    }

    #[test]
    fn the_work_request_props_match_the_shared_golden_vector() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/api/command-suggest-work-request-open.golden.json"
        );
        let golden: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read golden"))
                .expect("golden is JSON");
        let requester = Uuid::parse_str(
            golden["for_member_id_placeholder"]
                .as_str()
                .expect("placeholder"),
        )
        .expect("placeholder uuid");
        let cases = golden["cases"].as_array().expect("cases");
        assert_eq!(
            cases.len(),
            5,
            "one case per label row, plus the multi-line and CRLF prompts"
        );
        for case in cases {
            let validated =
                validate_suggestion(&case["arguments"], &[]).expect("golden arguments are legal");
            assert_eq!(
                command_suggest_props(&validated, requester),
                case["props"],
                "{}",
                case["name"]
            );
        }
    }
}
