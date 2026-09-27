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

/// The server allow-list (G2). **v1 = `ai.connect` alone.**
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
pub const SUGGESTABLE_COMMANDS: &[SuggestableCommand] = &[SuggestableCommand {
    id: COMMAND_AI_CONNECT,
    args_schema: ai_connect_args_schema,
    normalize: normalize_ai_connect_args,
    label: ai_connect_label,
}];

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
///   the 「내 계정」 절 with no harness pre-selected. Its label is 「AI 연결」,
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
        Some("team_key") => "팀 API 키 연결",
        _ => "AI 연결",
    }
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
/// message. The label is from the static table and needs nothing.
pub fn suggestion_tool_output(requester_display_name: &str, label: &str) -> String {
    format!(
        "{}님에게 「{label}」 카드를 보냈어요. 연결은 그 사람이 카드에서 직접 해요.",
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
             claude or codex with mine). body must be 1-{} bytes.",
            refusal.as_str(),
            suggestable_command_ids(),
            AI_CONNECT_HARNESSES,
            AI_CONNECT_SCOPES,
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
    fn v1_suggests_exactly_ai_connect() {
        assert_eq!(suggestable_command_ids(), vec!["ai.connect"]);
        assert!(suggestable_command("ai.connect").is_some());
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
            (json!({"harness": "team_key"}), "팀 API 키 연결"),
            (json!({"scope": "team"}), "팀 API 키 연결"),
            (json!({"scope": "mine"}), "AI 연결"),
            (json!({}), "AI 연결"),
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
        let output = suggestion_tool_output("[눌러](https://evil.example)`x`", "Claude 구독 연결");
        assert!(!output.contains("[눌러]"), "{output}");
        assert!(!output.contains("https://"), "{output}");
        assert!(!output.contains('`'), "{output}");
        assert!(output.contains("「Claude 구독 연결」"));
        assert_eq!(
            suggestion_tool_output("곽성재", "AI 연결"),
            "곽성재님에게 「AI 연결」 카드를 보냈어요. 연결은 그 사람이 카드에서 직접 해요."
        );
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
}
