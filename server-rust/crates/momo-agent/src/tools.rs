//! The tool catalog and the §3.3 G6 approval policy (goal SRV-T1).
//!
//! ## What a "tool" is here, and what it is not
//!
//! An agent declares the functions it may call in `agent.tool_schema`
//! (`001_init.sql:80`, "OpenAI function defs"). That column is already read by
//! [`crate::mention::load_mention_candidates_in_tx`] and already shipped to the
//! worker as `agent_job.payload.tools` — the declaration half has existed since
//! B5.2 and nothing consumed it.
//!
//! This module adds the two halves that were missing, and keeps them apart on
//! purpose:
//!
//! | half | question | answer lives in |
//! |---|---|---|
//! | **declaration** | what may this agent ask for? | `agent.tool_schema` (per agent, operator-authored) |
//! | **catalog** | what can this *server* actually run? | [`CATALOG`] (per build, this file) |
//! | **policy** | does running it need a human first? | [`requires_approval`] (per call) |
//!
//! A tool the agent declares but the catalog does not implement is not an
//! error in the agent's configuration — it is a capability this server has not
//! grown yet. It is answered with a `tool_result` naming the gap, never with a
//! silent success and never by inventing an executor.
//!
//! ## Why these two tools execute
//!
//! goal SRV-T1 exists to close the **approval** axis, not to grow the tool
//! surface: ADR-0137 D5's third axis has no producer at all, so
//! `INSERT INTO approval` is 0 and the inbox is empty by construction. The
//! shortest honest path to a closed loop is one tool that a human genuinely
//! must authorise, wired end to end.
//!
//! [`WORK_SESSION_END`] is that tool, and the reason is **irreversibility**:
//! ending a work session runs `t3_terminate`, which seals the T3 billing ledger
//! (`momo_t3` — "settlement happens in `t3_terminate` and nowhere else") and
//! destroys the running host's state. A spawn can be ended; an end cannot be
//! un-ended. Irreversibility is the best single predicate for "a person decides
//! this", so it is the tool whose approval gate is worth the most.
//!
//! Three properties made it the choice over the alternatives, and each one is a
//! constraint this batch could not have met otherwise:
//!
//! * **It is not a new capability.** `momo_t3::end_work_session_in_tx` +
//!   `terminate_in_tx` are the same domain calls
//!   `routes::work_sessions::end` makes. The tool is a second *caller*, not a
//!   second implementation — so the tool cannot drift from the REST surface.
//! * **It carries no provider credential** (ADR-0004). Execution is a local
//!   Postgres lifecycle transition; nothing about it reaches an LLM provider,
//!   so the tool loop cannot become a path for a key to enter the server.
//! * **It flows through Swift's *generic* approval path.** Swift routes
//!   `work.spawn` through `WorkControlRoutes.applySpawnApprovalDecision`
//!   instead (`ApprovalDecisionRoutes.shouldApplyGenericAgentDecisionFlow`
//!   is `workControlID == nil`), and `work_control` is not ported. Choosing
//!   spawn would have forced either porting that subsystem or diverging from
//!   the contract this batch exists to honour.
//!
//! ## The second tool: `work.session.spawn` (#1114)
//!
//! The paragraph above ends with the reason spawn was *excluded*: "Swift routes
//! `work.spawn` through `WorkControlRoutes.applySpawnApprovalDecision` instead
//! … and `work_control` is not ported. Choosing spawn would have forced either
//! porting that subsystem or diverging from the contract this batch exists to
//! honour."
//!
//! #1114 ported that subsystem (`momo_t3::work_control`), so the exclusion has
//! expired and [`WORK_SESSION_SPAWN`] is the second entry. It keeps all three
//! properties that qualified the first:
//!
//! * **not a new capability** — the executor calls the same domain functions
//!   `routes::work_sessions::create` calls, and records the same `work_control`
//!   spawn row the REST ledger records. It is a third caller, not a third
//!   implementation.
//! * **no provider credential** (ADR-0004) — creating a session is a local
//!   Postgres lifecycle transition plus an outbox row.
//! * **a human genuinely decides** — and here the decision carries *content*
//!   rather than just consent: ADR-0125 D6-A's host picker means the approval
//!   answers **where** this runs, not only whether. The candidates ride in the
//!   approval payload (`momo_t3::work_control::spawn_host_candidates_in_tx`).
//!
//! The one policy spawn adds and end does not is ADR-0114 D5's
//! `work_auto_approve`: a host owner may pre-authorise a tool on their own
//! hosts, and then the gate opens without a card. That is a *narrowing* of who
//! must be asked, decided by the same person who would otherwise be asked — not
//! a widening of what an agent may do.
//!
//! Everything else the roadmap names is listed in [`DECLARED_NOT_EXECUTABLE`]
//! and refused by name. That list is the scope boundary, written down rather
//! than implied.
//!
//! ## G6 fails closed
//!
//! [`requires_approval`] is a port of Swift `LoopGuards.requiresApproval`
//! (`LoopGuards.swift:251-281`). Missing, duplicated, or unrecognised grant
//! metadata all resolve to **approval required**. That direction is the whole
//! point: the failure mode of a permissive default is an agent taking an
//! irreversible action nobody authorised, and there is no undo for it.

use serde_json::{json, Map, Value};

/// `work.session.end` — end a running work session.
///
/// Arguments: `{"session_id": "<uuid>"}`. See the module docs for why this one.
pub const WORK_SESSION_END: &str = "work.session.end";

/// `work.session.spawn` — start a tool on a work host (#1114).
///
/// Arguments: `{"tool": "codex", "label": "…", "host_id": "<uuid>"?}`. `host_id`
/// is **optional** on purpose: ADR-0125 D6-A puts the host choice on the
/// approval card, so the model may propose one and the human may replace it. A
/// call that names none is normal, not malformed.
pub const WORK_SESSION_SPAWN: &str = "work.session.spawn";

/// `work.session.login_handoff` — stop and ask a person to log in on the
/// session's own screen (LIVE-4 / ADR-0004 증보 3).
///
/// Arguments: `{"session_id": "<uuid>", "reason": "…"}`.
///
/// ## Why this one belongs in the catalog
///
/// It keeps the three properties the module header requires of an entry, and it
/// keeps the middle one in the strongest possible form:
///
/// * **not a new capability** — it opens nothing, dials nothing and grants
///   nothing. The whole of its effect is an `approval_request` card and the hold
///   that card already implies, both of which this crate already writes for
///   every gated tool.
/// * **no credential, of any kind** — this is the tool that exists *because*
///   the agent must not receive one. 증보 3 D2: the password is typed by a
///   person into the VM, and the only thing that crosses this boundary is the
///   fact that they finished.
/// * **a human genuinely decides** — here the human does not merely consent,
///   they *are* the action. Which is why [`approval_reason`] refuses to let a
///   grant exempt it: an auto-approved login handoff would resume an agent in
///   front of a login screen nobody has touched.
///
/// The executor is deliberately thin, and that is not a gap
/// (`tool_exec::login_handoff`). What runs after the approval is a **report**:
/// it reads the control window ledger and tells the model which of the three
/// boundary endings happened, because `returned` and `expired` mean different
/// things to whatever the agent does next.
pub const WORK_SESSION_LOGIN_HANDOFF: &str = "work.session.login_handoff";

/// `card_suggest` — suggest a client-command card to the person who asked
/// (ADR-0186 증보 2026-09-27 G1, GC-6 #2947).
///
/// Arguments: `{"commandId": "ai.connect", "args": {…}?, "body": "…"}`, and
/// nothing else — [`crate::card_suggest::validate_suggestion`] is the whole
/// gate, shared with the hosted `oort_card_suggest`.
///
/// ## Why this one runs without a card of its own (ADR-0114 D5 exception)
///
/// It changes no server state (ADR-0186 D3 risk `none`): the one write is a
/// message in the run's own channel, the same thing the agent's ordinary answer
/// is. What the suggestion *offers* happens only when a person taps it, on
/// their own device and with their own authority. Gating the suggestion behind
/// an approval card would make 「승인해야 볼 수 있는 카드」. So
/// [`approval_reason`] exempts it **by name**, before any grant is read, and no
/// grant can widen the exemption to another tool (planner decision
/// 2026-09-27, #2952 review).
pub const CARD_SUGGEST: &str = "card_suggest";

/// `memory_suggest` — propose 「기억해 둘게요」 to the channel (ADR-0196 D4/D9, #3169).
///
/// Arguments: `{"kind": "decision", "text": "…", "evidence": [12, 14], "subject": "…"?}` and
/// nothing else — [`crate::memory_suggest::validate_suggestion`] is the whole argument gate and
/// `mem_propose_item` (migration 105) the whole data gate.
///
/// ## Why this one runs without a card of its own (same exception as [`CARD_SUGGEST`])
///
/// It makes nothing readable. The one write is a **pending** `mem_proposal` row that search,
/// serving and the memory browser never read; it becomes a memory only when a person in the
/// channel accepts it through the API, which re-validates all of its evidence. Gating a
/// suggestion behind an approval card would put a card in front of the card that asks 「기억할까요?」.
/// So [`approval_reason`] exempts it **by name**, before any grant is read, and — like
/// `card_suggest` — it runs only if the agent's profile turned it on ([`exempt_tool_not_enabled`]).
pub const MEMORY_SUGGEST: &str = "memory_suggest";

/// `workspace_action_propose` — the team AI's one tool (ADR-0201 D2/D3).
///
/// Arguments: `{"actionId": "<one of TEAM_AI_ACTION_IDS>", "args": {…}, "rationale"?: "…"}`.
/// It raises the ADR-0186 approval card and **parks the run**; it executes nothing.
///
/// ## Why it runs without the generic approval card (same exception as [`CARD_SUGGEST`])
///
/// It *is* the approval producer: its one write is a pending `workspace_action`
/// approval with its card. Stacking the generic tool-approval card in front would
/// ask a person twice about one thing. [`approval_reason`] exempts it by name, and
/// — as for the other name exemptions — it runs only if the agent's profile turned
/// it on ([`exempt_tool_not_enabled`]) **and** the worker finds the agent is the
/// workspace's team AI (`crate::team_ai`); any other agent that somehow lists it
/// is refused there.
pub const WORKSPACE_ACTION_PROPOSE: &str = "workspace_action_propose";

/// `approval.action_type` for a tool call, matching Swift
/// `ApprovalRuntime.pausePlan` (`ApprovalRuntime.swift:36-45`).
///
/// The column's comment offers `'tool_call','deploy','spend'`; Swift's generic
/// agent path always writes the first, and the decision route branches on
/// `work.spawn` to tell a work-control approval apart from this one.
pub const ACTION_TYPE_TOOL_CALL: &str = "tool_call";

/// `audit_log.action` values for the approval lifecycle (Swift
/// `ApprovalRuntime` + `ApprovalDecisionRoutes.auditAction`).
pub const AUDIT_APPROVAL_REQUESTED: &str = "approval.requested";
/// The tool ran (or refused to) after a human said yes.
pub const AUDIT_TOOL_EXECUTED: &str = "tool.executed";
/// The tool could not run after a human said yes.
pub const AUDIT_TOOL_FAILED: &str = "tool.failed";

/// The `detail.schema` every audit row in this subsystem versions on.
pub const TOOL_AUDIT_SCHEMA: &str = "momo.agent_tool_call.v0";

/// What this server can actually execute today.
///
/// Growing it is a deliberate act with its own ticket: each addition needs an
/// executor, an argument validator, and a decision about whether its approval
/// default may ever be anything but "required". #1114's spawn brought all three
/// (`tool_exec::spawn_session`, `tool_exec::spawn_arguments`, and ADR-0114 D5's
/// `work_auto_approve`).
pub const CATALOG: &[&str] = &[
    WORK_SESSION_END,
    WORK_SESSION_SPAWN,
    WORK_SESSION_LOGIN_HANDOFF,
    CARD_SUGGEST,
    MEMORY_SUGGEST,
    WORKSPACE_ACTION_PROPOSE,
];

/// Capabilities the product already has that a **future** batch may expose as
/// tools, kept as a list rather than as code.
///
/// These are surfaces momo-server already serves over HTTP; none of them is
/// invented here. They are named so that "why is this not a tool yet" has a
/// written answer, and so the next batch starts from a list instead of a guess.
///
/// | tool | existing surface | why not yet |
/// |---|---|---|
/// | `work.session.resume` | `POST …/work-sessions/{s}/resume` | ADR-0154 D3 splits 재개 from 인수 and the second needs a precondition check (clean tree, pushed branch, same repo) no server surface performs yet |
/// | `agent.pause` | `PATCH …/agents/{a}` | reversible, so it does not exercise the gate this catalog exists to prove |
/// | `message.post` | `POST …/channels/{c}/messages` | the agent already speaks through the run's own reply path |
pub const DECLARED_NOT_EXECUTABLE: &[&str] =
    &["work.session.resume", "agent.pause", "message.post"];

/// One tool this server can execute, described the way a model needs to see it
/// (goal SRV-B3f).
///
/// **Wire-agnostic on purpose.** The two provider wires disagree about where a
/// function's fields live — `/chat/completions` nests them under a `function`
/// object and the Responses API flattens them onto the tool itself (the same
/// split `responses.rs` already documents on the *parse* side, for
/// `function_call` items). So this type carries the three facts and each adapter
/// renders them in its own shape; a single pre-rendered JSON blob here would be
/// correct for exactly one of the two wires and silently wrong on the other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the arguments object.
    pub parameters: Value,
}

/// The definition of every tool in [`CATALOG`], in catalog order.
///
/// Built rather than `const` because the schema is a `serde_json::Value`. The
/// list is asserted against `CATALOG` by a test, so a tool that gains an
/// executor without gaining a description cannot ship: the model would be told a
/// name with no idea when to use it.
pub fn catalog_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: WORK_SESSION_END,
            // Written for the model, not for a changelog: it has to convey the one
            // property that makes this tool worth an approval — it cannot be undone.
            description: "End a running work session. This terminates the session's \
             host and seals its billing ledger; it cannot be undone. Requires \
             human approval before it runs.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "UUID of the work session to end."
                    }
                },
                "required": ["session_id"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: WORK_SESSION_SPAWN,
            // The last two sentences are the ones that change model behaviour:
            // naming a host is a suggestion, so it stops inventing uuids when it
            // has not been given one; and a member's own machine is never a
            // target (ADR-0188 R0.1 A′ — the call is refused, not carded), so it
            // does not spend a step learning that.
            description: "Start a coding tool in a new work session on one of this \
             workspace's registered hosts. Requires human approval, and the \
             person approving chooses which host it runs on — propose `host_id` \
             only if you were told which host to use. Never propose a member's \
             own machine (a member-scoped host): an agent's work is not sent \
             there, and such a call is refused.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "tool": {
                        "type": "string",
                        "description": "Tool key to start, e.g. `codex` or `claude`. \
                                        Must be enabled in this workspace."
                    },
                    "label": {
                        "type": "string",
                        "description": "Short human-readable name for the session \
                                        (1-120 characters)."
                    },
                    "host_id": {
                        "type": "string",
                        "description": "Optional UUID of the work host to run on. \
                                        Omit to let the approver pick."
                    }
                },
                "required": ["tool", "label"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: WORK_SESSION_LOGIN_HANDOFF,
            // Two sentences change model behaviour and both are deliberate.
            // The first tells it what it gets back, so it does not treat the
            // handoff as a guaranteed success; the second forbids the failure
            // mode ADR-0004 증보 3 D2 exists to prevent, in the one place the
            // model is actually reading.
            description: "Stop and ask a person to sign in on this work session's \
             screen, then continue once they are done. Use this when a login, a \
             two-factor prompt or a CAPTCHA blocks you. The result tells you \
             whether the person finished or the handoff lapsed, and a lapse \
             means you must re-check the screen instead of assuming you are \
             signed in. Never ask for a password, a code or any credential in \
             chat: the person types it directly into the session, and you will \
             not see it.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "UUID of the work session whose screen is \
                                        showing the login."
                    },
                    "reason": {
                        "type": "string",
                        "description": "One sentence for the person: what is on \
                                        screen and what they need to do. Never \
                                        include a credential."
                    }
                },
                "required": ["session_id", "reason"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: CARD_SUGGEST,
            // The model has to learn three things here: when (a person asked to
            // connect an AI), that the card does the connecting (so it must
            // not walk them through settings or ask for a key), and that the
            // title is not its to write.
            description: "Show the person who asked you a card they can act on              in place — use `ai.connect` when they ask to connect an AI              subscription or a team API key, `settings.open` (with `args.section`) when they ask where a setting is, and `work.request.open` (with `args.prompt`, and `args.harness` if they named Claude Code or Codex) when they ask you to hand coding work to their own Mac. Put your short answer in `body`;              the card itself is drawn by their app from their own settings, so              do not explain settings steps and never ask for a key, token or              password. The card's title and recipient are set by the server.",
            parameters: card_suggest_parameters(),
        },
        ToolDefinition {
            name: MEMORY_SUGGEST,
            // Three things change model behaviour: when (only what people clearly settled),
            // what evidence is (the #numbers in its window), and that it cannot remember by
            // itself — a person accepts, so it must ask rather than announce.
            description: "Offer to remember a decision, commitment or fact the people in this \
             channel clearly settled. Cite the #numbers printed before their messages as \
             `evidence`. This only makes a proposal: nothing is remembered until a person \
             accepts it, so ask 「기억해 둘까요?」 and never say you already remembered it. \
             Never propose guesses, small talk, credentials, or states that live in a \
             connected tool (PRs, deploys, metrics).",
            parameters: crate::memory_suggest::parameters(),
        },
        // The catalog is the whole allow-list; a request is offered the part its workspace's role
        // bundles leave on (`workspace_action_propose_definition`, ADR-0201 증보 v3 B3).
        workspace_action_propose_definition(&crate::actions::TEAM_AI_ACTION_IDS)
            .expect("the allow-list is not empty"),
    ]
}

/// The `args` description: each offered action's keys, read from the registry's
/// own schemas (`?` = optional), so the model is told the shape the server checks
/// and a key added to a schema reaches the model without a second edit. Only the ids
/// this request is offered are described — a hint for an action the workspace's role
/// bundles turned off would be guidance for a switch that is off.
fn workspace_action_args_description(action_ids: &[&str]) -> String {
    let mut lines = vec![
        "The change's arguments (the action's own schema). Handles without @. Keys by actionId:"
            .to_string(),
    ];
    for id in action_ids {
        let Some(action) = crate::actions::action_by_id(id) else {
            continue;
        };
        let schema = action.args_schema();
        let required: Vec<&str> = schema["required"]
            .as_array()
            .map(|keys| keys.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let keys: Vec<String> = schema["properties"]
            .as_object()
            .map(|properties| {
                properties
                    .keys()
                    .map(|key| {
                        if required.contains(&key.as_str()) {
                            key.clone()
                        } else {
                            format!("{key}?")
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        lines.push(format!("{id} {{{}}}", keys.join(", ")));
    }
    let offers = |id: &str| action_ids.contains(&id);
    if offers(crate::actions::ACTION_MEMBER_DISPLAY_NAME_SET)
        || offers(crate::actions::ACTION_MEMBER_AVATAR_SET)
        || offers(crate::actions::ACTION_AGENT_PROFILE_UPDATE)
    {
        lines.push(
            "member.display_name.set {displayName} changes only the requesting human, with their approval. member.avatar.set accepts exactly one of {attachmentId} (their image in this conversation) or {avatar:{source:'generated',dataBase64}} (retrieved/generated PNG/JPEG/WebP, strict base64, <=44000 decoded bytes). agent.profile.update accepts avatar:{source:'attachment',attachmentId} or {source:'generated',dataBase64}, or a preset. No member target argument, no URL."
                .to_string(),
        );
    }
    if offers(crate::actions::ACTION_WORKSPACE_MEMORY_UPDATE) {
        lines.push(
            "workspace.memory.update can only turn memory off (enabled:false) or pause/resume it."
                .to_string(),
        );
    }
    if offers(crate::actions::ACTION_INVITE_CREATE) || offers(crate::actions::ACTION_AGENT_INVITE) {
        lines.push(
            "invite.create and agent.invite are for an admin to approve: the link and the pairing \
             code are never given to you, the server delivers them after the approval, so do not \
             ask for one, guess one or repeat one."
                .to_string(),
        );
    }
    if offers(crate::actions::ACTION_TEAM_AI_ROLES_SET) {
        lines.push(format!(
            "team_ai.roles.set changes ONE bundle per card; bundle is one of {} (the chat and read role cannot be switched).",
            crate::team_ai_roles::SWITCHABLE_BUNDLES.join(", ")
        ));
    }
    lines.join(" ")
}

/// `workspace_action_propose`'s published schema — the enum is the ids this request is
/// offered, so the model is never told an id the server refuses.
fn workspace_action_propose_parameters(action_ids: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": {
            "actionId": {
                "type": "string",
                "enum": action_ids,
                "description": "Which change."
            },
            "args": {
                "type": "object",
                "description": workspace_action_args_description(action_ids)
            },
            "rationale": {
                "type": "string",
                "description": "One short sentence for the approver, at most 280 characters."
            }
        },
        "required": ["actionId", "args"],
        "additionalProperties": false
    })
}

// The tool's description is a `&'static str` (every `ToolDefinition` carries one), so the
// variants a role bundle can leave behind are built at compile time, from the same pieces:
// the head and tail are shared, only the list of things it may propose differs.
macro_rules! propose_description {
    ($($items:tt)*) => {
        concat!(
            "Propose ONE simple workspace change that the person who asked wants (",
            $($items)*,
            "). This only makes an approval card: nothing changes until a person approves it, so \
             say you proposed it, never that it is done. Use only the listed actionIds. Do not \
             use it for anything else, and never put a key, token or password in `args`."
        )
    };
}
macro_rules! propose_admin_items {
    () => {
        "change the requesting person's own name with member.display_name.set, their photo \
         with member.avatar.set, your agent name with agent.rename or photo with \
         agent.profile.update avatar; create a channel, add people to a channel, \
         change the workspace welcome text or role labels, turn link previews on or off, \
         turn team memory off or pause it, change how work resumes when a host is lost, \
         install one of the official apps GitHub, Notion, Linear or Google Drive"
    };
}
macro_rules! propose_roles_item {
    () => {
        "switch ONE of your own role bundles on or off with team_ai.roles.set"
    };
}
macro_rules! propose_invite_item {
    () => {
        "make a team invite link with invite.create or bring in an external agent with \
         agent.invite (you are never given the link or the pairing code)"
    };
}
const PROPOSE_DESCRIPTION_ADMIN_INVITE_ROLES: &str = propose_description!(
    propose_admin_items!(),
    "; ",
    propose_invite_item!(),
    "; ",
    propose_roles_item!()
);
const PROPOSE_DESCRIPTION_ADMIN_INVITE: &str =
    propose_description!(propose_admin_items!(), "; ", propose_invite_item!());
const PROPOSE_DESCRIPTION_ADMIN_AND_ROLES: &str =
    propose_description!(propose_admin_items!(), "; ", propose_roles_item!());
const PROPOSE_DESCRIPTION_ADMIN: &str = propose_description!(propose_admin_items!());
const PROPOSE_DESCRIPTION_INVITE_ROLES: &str =
    propose_description!(propose_invite_item!(), "; ", propose_roles_item!());
const PROPOSE_DESCRIPTION_INVITE: &str = propose_description!(propose_invite_item!());
const PROPOSE_DESCRIPTION_ROLES: &str = propose_description!(propose_roles_item!());

/// The `workspace_action_propose` tool as one request is offered it: `action_ids` is the
/// `actionId` enum, and the description and the `args` hint speak only about those ids.
///
/// `None` when there is nothing to offer (every bundle that owns an id is off, and the request
/// has already read something) — a tool whose enum is empty is not a tool. The caller passes
/// [`crate::team_ai_roles::TeamAiRoles::advertised_action_ids`].
pub fn workspace_action_propose_definition(action_ids: &[&str]) -> Option<ToolDefinition> {
    if action_ids.is_empty() {
        return None;
    }
    // Three kinds of thing a description can speak about, each only while at least one id of it is
    // offered: the workspace cards, the two invites (the `invite_access` bundle, ADR-0201 증보 v3
    // B4) and the roles card. A bundle that is off, or an id a read took out (B4-3), leaves no word.
    let roles = action_ids.contains(&crate::actions::ACTION_TEAM_AI_ROLES_SET);
    let invite = action_ids.iter().any(|id| is_invite_id(id));
    let admin = action_ids
        .iter()
        .any(|id| *id != crate::actions::ACTION_TEAM_AI_ROLES_SET && !is_invite_id(id));
    Some(ToolDefinition {
        name: WORKSPACE_ACTION_PROPOSE,
        description: match (admin, invite, roles) {
            (true, true, true) => PROPOSE_DESCRIPTION_ADMIN_INVITE_ROLES,
            (true, true, false) => PROPOSE_DESCRIPTION_ADMIN_INVITE,
            (true, false, true) => PROPOSE_DESCRIPTION_ADMIN_AND_ROLES,
            (true, false, false) => PROPOSE_DESCRIPTION_ADMIN,
            (false, true, true) => PROPOSE_DESCRIPTION_INVITE_ROLES,
            (false, true, false) => PROPOSE_DESCRIPTION_INVITE,
            (false, false, _) => PROPOSE_DESCRIPTION_ROLES,
        },
        parameters: workspace_action_propose_parameters(action_ids),
    })
}

/// The two ids of the `invite_access` bundle.
fn is_invite_id(id: &str) -> bool {
    id == crate::actions::ACTION_INVITE_CREATE || id == crate::actions::ACTION_AGENT_INVITE
}

/// `card_suggest`'s published schema, built from the allow-list so the enum
/// the model sees is [`crate::card_suggest::SUGGESTABLE_COMMANDS`] itself. The
/// drift test in `momo-server` still reads it back as a *third* list, because a
/// hand edit here would otherwise pass silently.
fn card_suggest_parameters() -> Value {
    card_suggest_parameters_of(crate::card_suggest::SUGGESTABLE_COMMANDS)
}

/// One sentence per command for `commandId`'s description, written only for the commands the
/// schema offers: a command that is not on the enum has no sentence anywhere in the tool (the
/// helper's request must not describe a card its bundle is off for, B15-A16).
fn card_command_hint(id: &str) -> &'static str {
    match id {
        crate::card_suggest::COMMAND_AI_CONNECT => {
            "`ai.connect` is the AI connection card (args: harness, scope)."
        }
        crate::card_suggest::COMMAND_SETTINGS_OPEN => {
            "`settings.open` opens one settings section (args: section, required)."
        }
        crate::card_suggest::COMMAND_WORK_REQUEST_OPEN => {
            "`work.request.open` opens the person's own work-request sheet with your prompt filled in, for coding work on their own Mac (args: prompt, required; harness: claude or codex, optional). They read it and send it themselves."
        }
        _ => "",
    }
}

/// [`card_suggest_parameters`] for any subset of the allow-list.
///
/// One closed `args` object whose properties are the commands' own, merged
/// ([`crate::card_suggest::merged_args_properties`]: a name two commands share — `harness` — keeps
/// the union of the enums). The per-command rule (which keys, which pairs, which are required) is
/// the normaliser's, not this schema's: JSON-Schema `oneOf` is not portable across the providers
/// the worker speaks to, so the schema is the first fence and `validate_suggestion` is the gate.
fn card_suggest_parameters_of(commands: &[crate::card_suggest::SuggestableCommand]) -> Value {
    let properties = crate::card_suggest::merged_args_properties(commands);
    let ids: Vec<&str> = commands.iter().map(|command| command.id).collect();
    let hints: Vec<&str> = ids.iter().map(|id| card_command_hint(id)).collect();
    let args = json!({"type": "object", "additionalProperties": false, "properties": properties});
    json!({
        "type": "object",
        "properties": {
            "commandId": {
                "type": "string",
                "enum": ids,
                "description": format!("Which card. {}", hints.join(" "))
            },
            "args": args,
            "body": {
                "type": "string",
                "description": "Your answer to the person, 1-8000 bytes. Shown above the card."
            }
        },
        "required": ["commandId", "body"],
        "additionalProperties": false
    })
}

/// What the helper's `card_suggest` tells the model. Only the commands its request offers are
/// named (see [`card_command_hint`]); the tool's own sentence is about **when** and **what the
/// card is**, never about how to write the title or whom it goes to — those are the server's.
const HELPER_CARD_SUGGEST_DESCRIPTION: &str = "Give the person who asked you a card that opens their own work-request sheet, already filled in. Use it when they ask you to do coding work (fix a bug, write or change code in a repository): put what they want done in `args.prompt` in their own voice, with the details they gave you, and `args.harness` only if they named Claude Code (`claude`) or Codex (`codex`). Put one short sentence in `body`. The card runs nothing by itself: they read the prompt in the sheet and send it from their own Mac. You never read or run code, and never put a key, token or password in the prompt. The card's title and recipient are set by the server.";

/// The team AI helper's `card_suggest` (ADR-0201 증보 v3 B8 C1, #4972): the same tool, the same
/// gate ([`crate::card_suggest::validate_suggestion_among`]), **narrowed to `command_ids`** — the
/// commands this request's role bundles are on for
/// ([`crate::team_ai_roles::TeamAiRoles::advertised_command_ids`]). `None` when nothing is on
/// offer: a tool with no command to give is not offered at all, like the proposal tool with no
/// `actionId` left. Ids that are not on the allow-list or not on
/// [`crate::card_suggest::TEAM_AI_SUGGESTABLE_COMMAND_IDS`] are ignored.
pub fn card_suggest_definition(command_ids: &[&str]) -> Option<ToolDefinition> {
    let commands: Vec<crate::card_suggest::SuggestableCommand> =
        crate::card_suggest::SUGGESTABLE_COMMANDS
            .iter()
            .filter(|command| {
                command_ids.contains(&command.id)
                    && crate::card_suggest::TEAM_AI_SUGGESTABLE_COMMAND_IDS.contains(&command.id)
            })
            .copied()
            .collect();
    if commands.is_empty() {
        return None;
    }
    Some(ToolDefinition {
        name: CARD_SUGGEST,
        description: HELPER_CARD_SUGGEST_DESCRIPTION,
        parameters: card_suggest_parameters_of(&commands),
    })
}

/// The definitions for the names an agent profile turned on — the **consumer**
/// `agent_profile.enabled_tools` never had (goal SRV-B3f).
///
/// Until this function existed the column was written, validated (`≤128`
/// entries, unique, non-empty) and read by nothing: no query selected it, no
/// payload carried it, and no provider request was shaped by it. An operator
/// could turn a tool on and the only observable effect was a row version bump.
///
/// ## The intersection is the security property
///
/// The answer is `enabled_tools ∩ CATALOG`, and the direction of that
/// intersection is deliberate:
///
/// * a name the catalog does not implement is **dropped**, not advertised. The
///   alternative — telling the model about a tool this build cannot run — spends
///   a whole turn to arrive at the `tool_result` that names the gap.
/// * a name the catalog *does* implement is offered **only if the profile turned
///   it on**. `CATALOG` is what this server *can* run; `enabled_tools` is what
///   this agent *may* ask for. Handing out the catalog to an agent whose profile
///   is empty would make every agent a work-session terminator by default.
///
/// Matching folds case and dashes ([`normalize`]), the same rule the executor
/// uses, so an operator who wrote `Work-Session-End` gets the tool they meant
/// rather than silence. Order follows `CATALOG`, not the profile, so two
/// profiles listing the same tools produce byte-identical requests.
pub fn enabled_tool_definitions(enabled: &[String]) -> Vec<ToolDefinition> {
    let wanted: Vec<String> = enabled.iter().map(|name| normalize(name)).collect();
    catalog_definitions()
        .into_iter()
        .filter(|definition| {
            let known = normalize(definition.name);
            wanted.contains(&known)
        })
        .collect()
}

/// The character class the provider requires of a tool name, measured
/// (goal SRV-HOT1).
///
/// The ChatGPT backend answers a name outside `^[a-zA-Z0-9_-]+$` with
/// `400 Invalid 'tools[0].name'`, and it does so for the **whole request** — so
/// one badly-named tool kills every turn of every agent that has it switched on,
/// answer and all. #1018 shipped `work.session.end` verbatim onto the wire and
/// that dot is the violation.
///
/// momo's own names keep their dots: they are the vocabulary the approval
/// ledger, the audit rows, the tool-result props and every client surface speak,
/// and renaming them to suit one provider's regex would push a wire detail into
/// the product. The translation lives at the provider boundary instead, in the
/// two functions below.
pub const WIRE_TOOL_NAME_PATTERN: &str = "^[a-zA-Z0-9_-]+$";

/// momo name → the name that goes on the wire (`.` → `_`).
///
/// Only the dot is rewritten because it is the only character momo's catalog
/// uses that the pattern forbids — asserted over the whole catalog by
/// [`tests::every_catalog_name_survives_the_providers_pattern`], so a future
/// tool named with a slash or a space fails the build's tests rather than the
/// user's turn.
pub fn wire_tool_name(momo_name: &str) -> String {
    momo_name.replace('.', "_")
}

/// The name on the wire → momo's name, or the wire name unchanged.
///
/// **A catalog lookup, not the inverse string transform**, and that is the whole
/// correctness argument: `_` → `.` is ambiguous (an operator's own function may
/// legitimately contain an underscore), so inverting the transform would rename
/// tools momo does not own. Comparing against the catalog's *rendered* names is
/// exact.
///
/// A name momo does not recognise passes through untouched, because it is an
/// operator's own `agent.tool_schema` function and its name is theirs.
pub fn momo_tool_name(wire_name: &str) -> String {
    let trimmed = wire_name.trim();
    CATALOG
        .iter()
        .find(|known| wire_tool_name(known) == trimmed)
        .map(|known| (*known).to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

/// Is this a tool this build knows how to run?
pub fn is_executable(tool_name: &str) -> bool {
    let normalized = normalize(tool_name);
    CATALOG.iter().any(|known| normalize(known) == normalized)
}

/// Swift `ToolGrantMetadata.normalize` (`AgentJobPayload.swift:315-319`):
/// trim, lowercase, and treat `-` as `_`.
///
/// Shared by the catalog lookup and the grant matcher so a tool cannot be
/// executable under one spelling and ungranted under another.
pub fn normalize(value: &str) -> String {
    value.trim().to_lowercase().replace('-', "_")
}

/// One tool call as the provider reported it.
///
/// `arguments` is a `Value` rather than a `String` because the wire delivers it
/// as a JSON *string* and every consumer wants the object; parsing once, at the
/// edge, keeps the rest of the pipeline from each having its own opinion about
/// malformed JSON. A call whose arguments do not parse is still a tool call —
/// it simply fails its validator later, with a `tool_result` that says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

impl ToolCall {
    /// `message.props` for a `tool_call` row — the schema's own contract
    /// (`001_init.sql:168`): `{name, arguments, call_id}`.
    ///
    /// Nothing else goes in. `props` is broadcast to every client in the
    /// channel, so this object is a public surface: it carries what the tool
    /// call *is*, never the grant metadata that decided its policy.
    pub fn message_props(&self) -> Value {
        let mut props = Map::new();
        props.insert("name".into(), Value::String(self.name.clone()));
        props.insert("arguments".into(), self.arguments.clone());
        props.insert("call_id".into(), Value::String(self.call_id.clone()));
        Value::Object(props)
    }

    /// The one-line body a client renders when it has no `tool_call` view yet.
    ///
    /// Every message row carries a human-readable `body` so a surface that does
    /// not know this `type` degrades to a sentence instead of a blank bubble.
    pub fn message_body(&self) -> String {
        format!("Tool call: {}", self.name)
    }
}

/// The result of running (or refusing to run) a tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub call_id: String,
    pub output: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(call_id: impl Into<String>, output: impl Into<String>) -> ToolResult {
        ToolResult {
            call_id: call_id.into(),
            output: output.into(),
            is_error: false,
        }
    }

    pub fn error(call_id: impl Into<String>, output: impl Into<String>) -> ToolResult {
        ToolResult {
            call_id: call_id.into(),
            output: output.into(),
            is_error: true,
        }
    }

    /// `message.props` for a `tool_result` row — `{call_id, output, is_error}`
    /// (`001_init.sql:169`).
    pub fn message_props(&self) -> Value {
        let mut props = Map::new();
        props.insert("call_id".into(), Value::String(self.call_id.clone()));
        props.insert("output".into(), Value::String(self.output.clone()));
        props.insert("is_error".into(), Value::Bool(self.is_error));
        Value::Object(props)
    }

    pub fn message_body(&self) -> String {
        self.output.clone()
    }
}

/// One `tool_grants` entry from the Context Packet projection, reduced to the
/// three fields the policy actually reads.
///
/// Swift's `ToolGrantMetadata` (`AgentJobPayload.swift:188-203`) carries
/// fourteen; the other eleven are provenance for surfaces this batch does not
/// serve. Decoding only what is read means an unfamiliar field cannot fail the
/// decode — and the whole object still rides along untouched into
/// `approval.payload.tool_call.tool_grant`, so nothing is lost for the batch
/// that needs it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolGrant {
    pub tool_name: String,
    pub approval_policy: Option<String>,
    /// Swift's `grant` field: `"read"` is the only value that can make a tool
    /// exempt, and only together with a read risk level.
    pub grant: Option<String>,
    /// Swift's `effectiveRiskLevel`: `risk_level ?? risk`, and **`None` when the
    /// two aliases disagree** (`riskAliasesConflict`).
    pub risk_level: Option<String>,
}

impl ToolGrant {
    /// Decode one grant object. Unknown keys are ignored; a missing
    /// `tool_name` makes the entry unusable, which the caller reads as "no
    /// single match" and therefore as approval-required.
    pub fn from_json(value: &Value) -> Option<ToolGrant> {
        let object = value.as_object()?;
        let tool_name = object.get("tool_name")?.as_str()?.to_string();
        let string = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };

        // Swift `effectiveRiskLevel` (:262-265): when `risk` and `risk_level`
        // are both present and disagree, the level is *unknown*, not
        // "whichever we read first". An unknown risk fails closed below.
        let risk = string("risk");
        let risk_level_field = string("risk_level");
        let risk_level = match (&risk, &risk_level_field) {
            (Some(risk), Some(level)) if normalize(risk) != normalize(level) => None,
            _ => risk_level_field.or(risk),
        };

        Some(ToolGrant {
            tool_name,
            approval_policy: string("approval_policy"),
            grant: string("grant"),
            risk_level,
        })
    }

    /// Decode the payload's whole `tool_grants` array.
    pub fn from_json_array(value: &Value) -> Vec<ToolGrant> {
        value
            .as_array()
            .map(|entries| entries.iter().filter_map(ToolGrant::from_json).collect())
            .unwrap_or_default()
    }

    /// Swift `isReadOnlyGrant` (:283-285): a grant is read-only only when
    /// **both** `grant` and the effective risk level say `read`.
    pub fn is_read_only(&self) -> bool {
        self.grant.as_deref().map(normalize).as_deref() == Some("read")
            && self.risk_level.as_deref().map(normalize).as_deref() == Some("read")
    }

    /// Swift `singleMatch` (:305-313): exactly one entry must match, because
    /// two entries for one tool mean the projection is ambiguous about which
    /// policy applies — and an ambiguous policy is not a policy.
    pub fn single_match<'g>(grants: &'g [ToolGrant], tool_name: &str) -> Option<&'g ToolGrant> {
        let target = normalize(tool_name);
        if target.is_empty() {
            return None;
        }
        let mut matches = grants
            .iter()
            .filter(|grant| normalize(&grant.tool_name) == target);
        let first = matches.next()?;
        match matches.next() {
            Some(_) => None,
            None => Some(first),
        }
    }
}

/// Why a call needs (or does not need) a human — carried into the approval
/// payload so a reviewer can see the reason the gate fired without replaying
/// the projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalReason {
    /// No `tool_grants` projection, or no single matching entry. Fail closed.
    GrantMissingOrAmbiguous,
    /// The grant names a policy that demands a human.
    PolicyRequiresApproval,
    /// The grant names a policy this build has no runtime for (e.g. a
    /// conditional budget threshold). Pause rather than guess.
    PolicyUnsupported,
    /// The grant exempts the call and the grant is genuinely read-only.
    ExemptReadOnly,
    /// The tool's whole content is a person doing something, so no grant can
    /// stand in for them (LIVE-4, [`WORK_SESSION_LOGIN_HANDOFF`]).
    ///
    /// Distinct from [`Self::PolicyRequiresApproval`] because that reason names
    /// a *grant* as the author of the pause, and a reviewer reading this
    /// approval would go looking for a grant that need not exist. Here the
    /// author is the tool.
    HumanIsTheAction,
    /// The tool only suggests; a person acts on their own device
    /// ([`CARD_SUGGEST`], ADR-0186 증보 G1 · ADR-0114 D5 exception). Named by the
    /// tool, like [`Self::HumanIsTheAction`], because no grant authored it.
    SuggestionOnly,
}

impl ApprovalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalReason::GrantMissingOrAmbiguous => "grant_missing_or_ambiguous",
            ApprovalReason::PolicyRequiresApproval => "policy_requires_approval",
            ApprovalReason::PolicyUnsupported => "policy_unsupported",
            ApprovalReason::ExemptReadOnly => "exempt_read_only",
            ApprovalReason::HumanIsTheAction => "human_is_the_action",
            ApprovalReason::SuggestionOnly => "suggestion_only",
        }
    }

    pub fn requires_approval(self) -> bool {
        !matches!(
            self,
            ApprovalReason::ExemptReadOnly | ApprovalReason::SuggestionOnly
        )
    }
}

/// G6 — does this tool call need a human before it runs?
///
/// Port of Swift `LoopGuards.requiresApproval(toolName:toolGrants:)`
/// (`LoopGuards.swift:251-281`). Swift's MOMO-164 verb-heuristic fallback
/// (`:284`) is **not** ported: Swift itself marks it legacy and MOMO-165 already
/// made the metadata path fail closed, so porting a second, looser answer would
/// only create a way to disagree with the first.
///
/// Returns the *reason*, not a bare bool, because the reason is what the
/// approval row records — and "why did this stop" is the first question a human
/// reading an approval inbox asks.
pub fn approval_reason(tool_name: &str, grants: Option<&[ToolGrant]>) -> ApprovalReason {
    // LIVE-4: the login handoff is unexemptable, and it is checked before the
    // grant projection is even read.
    //
    // The gate below can be opened by a grant whose policy says `never` and
    // whose risk is read-only, and a login handoff would slip through it: the
    // call touches nothing, so an operator writing that grant is not obviously
    // wrong. What it would produce is the exact failure 증보 3 exists to
    // prevent — an agent that asked for a person, was never given one, and
    // carried on in front of a login screen as though it had been.
    //
    // Fail-closed here is therefore not "assume the worst about the grant"; it
    // is that consent is not the thing being asked for. Nobody can pre-approve
    // typing somebody else's password.
    if normalize(tool_name) == normalize(WORK_SESSION_LOGIN_HANDOFF) {
        return ApprovalReason::HumanIsTheAction;
    }
    // ADR-0186 증보 G1 — the one approval-default exception, bound to one name.
    // Checked before the grants are read so that a grant can neither remove it
    // nor be the thing that extends it to anything else.
    if normalize(tool_name) == normalize(CARD_SUGGEST)
        || normalize(tool_name) == normalize(MEMORY_SUGGEST)
        || normalize(tool_name) == normalize(WORKSPACE_ACTION_PROPOSE)
    {
        return ApprovalReason::SuggestionOnly;
    }
    let Some(grants) = grants else {
        return ApprovalReason::GrantMissingOrAmbiguous;
    };
    let Some(grant) = ToolGrant::single_match(grants, tool_name) else {
        return ApprovalReason::GrantMissingOrAmbiguous;
    };
    let Some(policy) = grant.approval_policy.as_deref().map(normalize) else {
        return ApprovalReason::GrantMissingOrAmbiguous;
    };

    match policy.as_str() {
        "require_approval" | "requires_approval" | "approval_required" | "always" | "required" => {
            ApprovalReason::PolicyRequiresApproval
        }
        // Swift `:271-274`: an exemption is honoured only when the grant is
        // genuinely read-only. A grant that claims "never" while holding write
        // risk is a misconfiguration, and the safe reading of it is a pause.
        "never" | "none" | "read_only" | "readonly" => {
            if grant.is_read_only() {
                ApprovalReason::ExemptReadOnly
            } else {
                ApprovalReason::PolicyRequiresApproval
            }
        }
        // v0 has no runtime for conditional policies (`budget_threshold` and
        // friends). Swift pauses; so do we.
        _ => ApprovalReason::PolicyUnsupported,
    }
}

/// A call that the gate exempts **by name** runs only when the agent's profile
/// turned that tool on (#2959 review M3).
///
/// Every other catalog tool has G6's fail-closed approval as the backstop for a
/// call the profile never advertised (a prompt-injected model, a provider that
/// does not enforce the offered list): no grant, so a person is asked. A name
/// exemption removes that backstop, so the profile is what stands in for it —
/// an operator who leaves `card_suggest` off gets a refusal, not a card.
///
/// `true` means "refuse this call": the tool is exempt by name and absent from
/// `enabled`. Matching is [`normalize`], the executor's rule.
pub fn exempt_tool_not_enabled(tool_name: &str, enabled: &[ToolDefinition]) -> bool {
    approval_reason(tool_name, None) == ApprovalReason::SuggestionOnly
        && !enabled
            .iter()
            .any(|definition| normalize(definition.name) == normalize(tool_name))
}

/// The `tool_result` for [`exempt_tool_not_enabled`].
pub fn not_enabled_output(tool_name: &str) -> String {
    format!(
        "Tool `{tool_name}` is not enabled for this agent, so it did not run. \
         Answer in text instead."
    )
}

/// The bool form, for call sites that only branch.
pub fn requires_approval(tool_name: &str, grants: Option<&[ToolGrant]>) -> bool {
    approval_reason(tool_name, grants).requires_approval()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The measured constraint, applied to the whole catalog (goal SRV-HOT1).
    ///
    /// This is the test that would have caught #1018 before a user did: it
    /// checks the name that actually goes on the wire, not the one momo uses
    /// internally. A future tool called `work/session.end` fails here instead of
    /// killing every turn of every agent that enabled it.
    #[test]
    fn every_catalog_name_survives_the_providers_pattern() {
        for name in CATALOG {
            let wire = wire_tool_name(name);
            assert!(
                !wire.is_empty()
                    && wire
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "{name} renders as {wire:?}, which the backend refuses with \
                 `400 Invalid 'tools[0].name'` ({WIRE_TOOL_NAME_PATTERN})"
            );
        }
        // The specific violation #1018 shipped.
        assert_eq!(wire_tool_name(WORK_SESSION_END), "work_session_end");
        assert!(WORK_SESSION_END.contains('.'), "momo keeps its own dots");
    }

    /// Round trip, both directions, for every tool momo owns.
    #[test]
    fn the_wire_name_round_trips_back_to_the_momo_name() {
        for name in CATALOG {
            assert_eq!(
                momo_tool_name(&wire_tool_name(name)),
                *name,
                "the approval ledger and every client surface read the momo name"
            );
        }
        assert_eq!(momo_tool_name("work_session_end"), WORK_SESSION_END);
        assert_eq!(momo_tool_name("  work_session_end  "), WORK_SESSION_END);
    }

    /// A name momo does not own is not momo's to rename.
    ///
    /// The reverse map is a catalog lookup rather than `_` → `.` precisely so
    /// that an operator's own function keeps the name they gave it — inverting
    /// the transform would turn `search_issues` into `search.issues` and then
    /// fail to dispatch it.
    #[test]
    fn an_operators_own_tool_name_passes_through_untouched() {
        for foreign in [
            "search_issues",
            "github_search",
            "web_search",
            "a_b_c",
            "plain",
        ] {
            assert_eq!(momo_tool_name(foreign), foreign);
            assert!(
                !is_executable(&momo_tool_name(foreign)),
                "{foreign} must not be mapped onto a momo tool"
            );
        }
    }

    /// The mapped-back name is what the executor recognises — this is the join
    /// between the wire and `CATALOG` that makes an approval possible at all.
    #[test]
    fn the_mapped_back_name_is_the_one_the_executor_runs() {
        let from_wire = momo_tool_name("work_session_end");
        assert!(is_executable(&from_wire));
        assert!(requires_approval(&from_wire, None), "G6 still fails closed");
        // …and the raw wire name is NOT executable, which is why the mapping has
        // to happen before dispatch rather than after.
        assert!(!is_executable("work_session_end"));
    }

    /// Every executable tool has a definition, and every definition names an
    /// executable tool. A tool that gained an executor without a description
    /// would be a name the model is told about with no idea when to use it.
    #[test]
    fn the_catalog_and_its_definitions_are_the_same_set() {
        let defined: Vec<&str> = catalog_definitions().iter().map(|d| d.name).collect();
        assert_eq!(defined, CATALOG.to_vec());
        for definition in catalog_definitions() {
            assert!(is_executable(definition.name), "{}", definition.name);
            assert!(
                !definition.description.trim().is_empty(),
                "{} has no description",
                definition.name
            );
            assert_eq!(definition.parameters["type"], json!("object"));
        }
    }

    /// `enabled_tools ∩ CATALOG`, in both directions.
    #[test]
    fn only_a_tool_that_is_both_enabled_and_executable_is_offered() {
        // Enabled + executable → offered.
        let offered = enabled_tool_definitions(&[WORK_SESSION_END.to_string()]);
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].name, WORK_SESSION_END);

        // Enabled but NOT executable → dropped, not advertised. Telling the
        // model about it would spend a turn to reach "this server cannot".
        for unknown in ["web.search", "work.session.resume", "message.post"] {
            assert!(
                enabled_tool_definitions(&[unknown.to_string()]).is_empty(),
                "{unknown} is not in this build's catalog"
            );
        }
        // …including every name the roadmap has reserved but not built.
        for declared in DECLARED_NOT_EXECUTABLE {
            assert!(enabled_tool_definitions(&[declared.to_string()]).is_empty());
        }

        // Executable but NOT enabled → withheld. This is what stops an empty
        // profile from making every agent a work-session terminator.
        assert!(enabled_tool_definitions(&[]).is_empty());
        assert!(enabled_tool_definitions(&["something.else".to_string()]).is_empty());
    }

    /// The declaration matches by **exactly** the executor's rule, whatever that
    /// rule is — which is the property that matters, not the rule itself.
    ///
    /// `normalize` folds case and dashes and deliberately **not** dots
    /// (`matching_folds_case_and_dashes_but_not_dots` pins that). So the two
    /// halves are asserted against each other rather than against a list I wrote
    /// by hand: any spelling the executor would run must be a spelling the
    /// declaration offers, and vice versa. A drift either way is a real bug —
    /// offering a tool that will not run, or running one never offered.
    #[test]
    fn enabling_matches_by_exactly_the_executors_rule() {
        for spelling in [
            "work.session.end",
            "Work.Session.End",
            "  WORK.SESSION.END  ",
            // Not the same tool: dots are not dashes to `normalize`.
            "work-session-end",
            "work_session_end",
            "work.session.ended",
            "",
        ] {
            let offered = !enabled_tool_definitions(&[spelling.to_string()]).is_empty();
            assert_eq!(
                offered,
                is_executable(spelling),
                "declaration and execution disagree about {spelling:?}: \
                 offered={offered}, executable={}",
                is_executable(spelling)
            );
        }
        // …and the three that DO match are the case/whitespace family.
        for spelling in [
            "work.session.end",
            "Work.Session.End",
            "  WORK.SESSION.END  ",
        ] {
            assert_eq!(enabled_tool_definitions(&[spelling.to_string()]).len(), 1);
        }
    }

    /// Order comes from the catalog, so two profiles listing the same tools in
    /// different orders produce byte-identical provider requests — and a
    /// duplicate entry cannot make a provider reject the request for declaring
    /// one function twice.
    #[test]
    fn the_offer_is_deduplicated_and_ordered_by_the_catalog() {
        let noisy = enabled_tool_definitions(&[
            WORK_SESSION_END.to_string(),
            "work-session-end".to_string(),
            WORK_SESSION_END.to_string(),
        ]);
        assert_eq!(noisy.len(), 1, "a name repeated is still one function");
        assert_eq!(
            noisy.iter().map(|d| d.name).collect::<Vec<_>>(),
            enabled_tool_definitions(&[WORK_SESSION_END.to_string()])
                .iter()
                .map(|d| d.name)
                .collect::<Vec<_>>()
        );
    }
    use serde_json::json;

    fn grant(policy: &str, grant_kind: &str, risk: &str) -> ToolGrant {
        ToolGrant {
            tool_name: WORK_SESSION_END.to_string(),
            approval_policy: Some(policy.to_string()),
            grant: Some(grant_kind.to_string()),
            risk_level: Some(risk.to_string()),
        }
    }

    /// The invariant this whole module exists for. Revert any arm and an
    /// irreversible action runs with nobody's permission.
    #[test]
    fn g6_fails_closed_on_every_uncertainty() {
        // no projection at all
        assert!(requires_approval(WORK_SESSION_END, None));
        // projection present, tool absent
        assert!(requires_approval(WORK_SESSION_END, Some(&[])));
        // two entries for one tool = ambiguous
        let duplicated = [
            grant("never", "read", "read"),
            grant("never", "read", "read"),
        ];
        assert!(
            requires_approval(WORK_SESSION_END, Some(&duplicated)),
            "a duplicated grant is ambiguous, and an ambiguous policy is not a policy"
        );
        // a grant with no policy at all
        let policyless = [ToolGrant {
            tool_name: WORK_SESSION_END.to_string(),
            ..ToolGrant::default()
        }];
        assert!(requires_approval(WORK_SESSION_END, Some(&policyless)));
        // a policy this build cannot evaluate
        let conditional = [grant("budget_threshold", "write", "high")];
        assert_eq!(
            approval_reason(WORK_SESSION_END, Some(&conditional)),
            ApprovalReason::PolicyUnsupported
        );
    }

    /// An exemption must be earned by BOTH fields, not claimed by one.
    #[test]
    fn a_never_policy_does_not_exempt_a_write_grant() {
        assert!(
            requires_approval(WORK_SESSION_END, Some(&[grant("never", "write", "high")])),
            "a grant claiming exemption while holding write risk is a misconfiguration"
        );
        assert!(!requires_approval(
            WORK_SESSION_END,
            Some(&[grant("never", "read", "read")])
        ));
    }

    /// Swift `effectiveRiskLevel`: disagreeing aliases mean the level is
    /// unknown, which costs the exemption.
    #[test]
    fn conflicting_risk_aliases_lose_the_exemption() {
        let decoded = ToolGrant::from_json(&json!({
            "tool_name": WORK_SESSION_END,
            "approval_policy": "never",
            "grant": "read",
            "risk": "read",
            "risk_level": "high",
        }))
        .expect("decodes");
        assert_eq!(decoded.risk_level, None);
        assert!(!decoded.is_read_only());
        assert!(requires_approval(WORK_SESSION_END, Some(&[decoded])));
    }

    /// Swift `normalize` (:315-319) folds case and treats `-` as `_` — and
    /// leaves `.` alone. Both halves matter:
    ///
    /// * case and dash/underscore must fold, or a grant authored
    ///   `Work_Session-End` would silently fail to match the call and (because
    ///   G6 fails closed) turn every invocation into an approval;
    /// * `.` must **not** fold, or `work.session.end` and `work_session_end`
    ///   would become one name and a grant written for one tool would authorise
    ///   a different one.
    #[test]
    fn matching_folds_case_and_dashes_but_not_dots() {
        let mut spelled = grant("never", "read", "read");
        spelled.tool_name = "WORK.SESSION-END".to_string();
        assert!(
            !requires_approval("work.session_end", Some(&[spelled.clone()])),
            "case and dash/underscore fold"
        );
        assert!(
            requires_approval("work_session_end", Some(&[spelled])),
            "a dot is a real character; folding it would let one grant authorise another tool"
        );
        assert!(is_executable("  WORK.SESSION.END  "));
    }

    /// The catalog is the executable set, and every entry outside it is named.
    #[test]
    fn only_the_catalog_executes() {
        assert!(is_executable(WORK_SESSION_END));
        assert!(is_executable(WORK_SESSION_SPAWN));
        for declared in DECLARED_NOT_EXECUTABLE {
            assert!(
                !is_executable(declared),
                "{declared} is a named future tool, not an executable one"
            );
        }
        assert!(!is_executable("rm.-rf"));
    }

    /// `props` is broadcast to every client in the channel. It carries the call,
    /// never the policy metadata that judged it.
    #[test]
    fn tool_call_props_match_the_schema_contract() {
        let call = ToolCall {
            call_id: "call_1".into(),
            name: WORK_SESSION_END.into(),
            arguments: json!({"session_id": "s"}),
        };
        let props = call.message_props();
        let object = props.as_object().expect("object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["arguments", "call_id", "name"],
            "schema_v0.sql:168 pins tool_call props to exactly {{name, arguments, call_id}}"
        );

        let result = ToolResult::error("call_1", "nope");
        let object = result.message_props();
        let object = object.as_object().expect("object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["call_id", "is_error", "output"]);
    }

    // ---- LIVE-4: the login handoff is unexemptable ---------------------------

    #[test]
    fn no_grant_can_pre_approve_a_login_handoff() {
        // The exact grant that exempts every other tool: policy `never` on a
        // read-only risk. For `work.session.end` this is the one shape that
        // legitimately opens the gate.
        let exempting = [grant("never", "read", "read")];
        assert_eq!(
            approval_reason(WORK_SESSION_END, Some(&exempting)),
            ApprovalReason::ExemptReadOnly,
            "the control case: this grant really does exempt an ordinary tool"
        );

        // Same grant, aimed at the handoff. It must not open anything: consent
        // is not the thing being asked for, so there is nothing to pre-give.
        let aimed = [ToolGrant {
            tool_name: WORK_SESSION_LOGIN_HANDOFF.to_string(),
            approval_policy: Some("never".to_string()),
            risk_level: Some("read".to_string()),
            ..ToolGrant::default()
        }];
        for grants in [None, Some(&[][..]), Some(&aimed[..]), Some(&exempting[..])] {
            assert!(
                requires_approval(WORK_SESSION_LOGIN_HANDOFF, grants),
                "a login handoff without a human is an agent talking to a login screen"
            );
        }
        assert_eq!(
            approval_reason(WORK_SESSION_LOGIN_HANDOFF, Some(&aimed)),
            ApprovalReason::HumanIsTheAction,
            "the reason names the tool, not a grant a reviewer would go looking for"
        );
    }

    #[test]
    fn the_handoff_is_unexemptable_by_every_spelling_of_its_name() {
        // The executor matches on `normalize`, and so must the gate: a spelling
        // the executor would run but the gate would not recognise is a hole
        // through which an auto-approved handoff walks. `normalize` folds case
        // and dashes and NOT dots (`matching_folds_case_and_dashes_but_not_dots`),
        // and the wire spelling is mapped back before either is consulted
        // (`the_mapped_back_name_is_the_one_the_executor_runs`), so these are
        // exactly the spellings that must reach the same answer.
        for spelling in [
            "work.session.login_handoff",
            "  WORK.SESSION.LOGIN_HANDOFF  ",
            "Work.Session.Login-Handoff",
            &momo_tool_name(&wire_tool_name(WORK_SESSION_LOGIN_HANDOFF)),
        ] {
            assert_eq!(
                approval_reason(spelling, Some(&[grant("never", "read", "read")])),
                ApprovalReason::HumanIsTheAction,
                "{spelling} must reach the same gate the executor reaches"
            );
        }
    }

    #[test]
    fn every_approval_reason_has_a_distinct_wire_label() {
        let labels = [
            ApprovalReason::GrantMissingOrAmbiguous.as_str(),
            ApprovalReason::PolicyRequiresApproval.as_str(),
            ApprovalReason::PolicyUnsupported.as_str(),
            ApprovalReason::ExemptReadOnly.as_str(),
            ApprovalReason::HumanIsTheAction.as_str(),
            ApprovalReason::SuggestionOnly.as_str(),
        ];
        let mut sorted = labels.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            labels.len(),
            "a reason that shares a label cannot be read back"
        );
        assert!(ApprovalReason::HumanIsTheAction.requires_approval());
    }

    #[test]
    fn the_login_handoff_is_described_without_inviting_a_credential() {
        let definition = catalog_definitions()
            .into_iter()
            .find(|definition| definition.name == WORK_SESSION_LOGIN_HANDOFF)
            .expect("the catalog and its definitions are the same set");
        // ADR-0004 증보 3 D2 lives or dies in the sentence the model reads.
        assert!(
            definition.description.contains("Never ask for a password"),
            "the one place the model is told not to build a credential path in chat"
        );
        // The lapse branch must be in the description too: a model told only
        // that the person "finishes" will assume completion on every ending.
        assert!(definition.description.contains("lapse"));
        let required = definition.parameters["required"]
            .as_array()
            .expect("required is a list");
        assert_eq!(required.len(), 2);
        assert!(required.iter().any(|value| value == "session_id"));
        assert!(required.iter().any(|value| value == "reason"));
    }

    // ---- ADR-0186 증보 G1: card_suggest ------------------------------------

    /// The exemption is the name `card_suggest` and nothing else: every other
    /// catalog tool still fails closed with no grants, and no grant — not even
    /// one saying `require_approval` — moves `card_suggest` back behind a card or
    /// lends its exemption to a neighbour.
    #[test]
    fn only_card_suggest_is_exempt_by_name_and_grants_cannot_move_it() {
        for spelling in [CARD_SUGGEST, "Card_Suggest", "  card-suggest  "] {
            assert_eq!(
                approval_reason(spelling, None),
                ApprovalReason::SuggestionOnly
            );
            assert!(!requires_approval(spelling, None), "{spelling}");
        }
        let demanding = [ToolGrant {
            tool_name: CARD_SUGGEST.to_string(),
            approval_policy: Some("require_approval".to_string()),
            ..ToolGrant::default()
        }];
        assert_eq!(
            approval_reason(CARD_SUGGEST, Some(&demanding)),
            ApprovalReason::SuggestionOnly
        );
        // The second by-name exemption (`memory_suggest`, #3169) is exactly as narrow: a grant
        // cannot move it, and it lends nothing to a neighbour.
        for spelling in [MEMORY_SUGGEST, "Memory_Suggest", "  memory-suggest  "] {
            assert_eq!(
                approval_reason(spelling, None),
                ApprovalReason::SuggestionOnly
            );
        }
        let demanding_memory = [ToolGrant {
            tool_name: MEMORY_SUGGEST.to_string(),
            approval_policy: Some("require_approval".to_string()),
            ..ToolGrant::default()
        }];
        assert_eq!(
            approval_reason(MEMORY_SUGGEST, Some(&demanding_memory)),
            ApprovalReason::SuggestionOnly
        );
        // The third (`workspace_action_propose`, ADR-0201): it IS the approval producer, so
        // it skips the generic card — and only by its exact name, never by a neighbour.
        assert_eq!(
            approval_reason(WORKSPACE_ACTION_PROPOSE, None),
            ApprovalReason::SuggestionOnly
        );
        for near in [
            "workspace.action.propose",
            "workspace_action_proposal",
            "workspace_action",
            "action_propose",
        ] {
            assert!(requires_approval(near, None), "{near}");
        }
        for near in [
            "memory.suggest",
            "memory_suggestion",
            "memorysuggest",
            "memory_add",
        ] {
            assert!(requires_approval(near, None), "{near}");
        }
        for other in CATALOG.iter().filter(|name| {
            **name != CARD_SUGGEST && **name != MEMORY_SUGGEST && **name != WORKSPACE_ACTION_PROPOSE
        }) {
            assert!(requires_approval(other, None), "{other} lost its gate");
            // A grant *named* card_suggest does not reach another tool.
            let borrowed = [ToolGrant {
                tool_name: CARD_SUGGEST.to_string(),
                approval_policy: Some("never".to_string()),
                grant: Some("read".to_string()),
                risk_level: Some("read".to_string()),
            }];
            assert!(requires_approval(other, Some(&borrowed)), "{other}");
        }
        // Nearby spellings are not the tool.
        for near in ["card.suggest", "card_suggestion", "cardsuggest"] {
            assert!(requires_approval(near, None), "{near}");
        }
        assert!(ApprovalReason::SuggestionOnly.as_str() == "suggestion_only");
    }

    /// `memory_suggest` runs only when the profile offered it: the by-name exemption removes
    /// the approval backstop, so the profile is what stands in for it (#2959 M3 rule).
    #[test]
    fn memory_suggest_runs_only_when_the_profile_turned_it_on() {
        let off = enabled_tool_definitions(&[CARD_SUGGEST.to_string()]);
        assert!(exempt_tool_not_enabled(MEMORY_SUGGEST, &off));
        let on = enabled_tool_definitions(&[MEMORY_SUGGEST.to_string()]);
        assert!(!exempt_tool_not_enabled(MEMORY_SUGGEST, &on));
        assert!(is_executable(MEMORY_SUGGEST));
        assert_eq!(wire_tool_name(MEMORY_SUGGEST), "memory_suggest");
        // The definition is a closed object; its keys are the ones the gate reads.
        let definition = catalog_definitions()
            .into_iter()
            .find(|definition| definition.name == MEMORY_SUGGEST)
            .expect("in the catalog");
        assert_eq!(definition.parameters["additionalProperties"], false);
        let mut keys: Vec<&str> = definition.parameters["properties"]
            .as_object()
            .expect("properties")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut gate = crate::memory_suggest::ARGUMENT_KEYS.to_vec();
        gate.sort_unstable();
        assert_eq!(keys, gate);
        assert!(crate::memory_suggest::directive(&on).is_some());
        assert!(crate::memory_suggest::directive(&off).is_none());
    }

    /// The worker's definition is built from the allow-list, and it is a closed
    /// object whose three keys are the ones `validate_suggestion` reads.
    #[test]
    fn the_card_suggest_definition_embeds_the_allow_list() {
        let definition = catalog_definitions()
            .into_iter()
            .find(|definition| definition.name == CARD_SUGGEST)
            .expect("the catalog and its definitions are the same set");
        let parameters = &definition.parameters;
        assert_eq!(parameters["additionalProperties"], json!(false));
        let mut keys: Vec<&str> = parameters["properties"]
            .as_object()
            .expect("properties")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["args", "body", "commandId"]);
        // `args` is one closed object whose properties are every command's; the one name two
        // commands share (`harness`) keeps the union of their enums.
        let args = &parameters["properties"]["args"];
        assert_eq!(args["additionalProperties"], json!(false));
        let expected =
            crate::card_suggest::merged_args_properties(crate::card_suggest::SUGGESTABLE_COMMANDS);
        assert_eq!(args["properties"], Value::Object(expected));
        assert_eq!(
            args["properties"]["section"]["enum"],
            json!(crate::card_suggest::SETTINGS_OPEN_SECTIONS)
        );
        // `ai.connect` and `work.request.open` both take `harness`: the merged enum is the union,
        // which is `ai.connect`'s own (claude and codex are in it), so the published schema is
        // the one it was before the work request joined.
        assert_eq!(
            args["properties"]["harness"]["enum"],
            json!(crate::card_suggest::AI_CONNECT_HARNESSES)
        );
        assert_eq!(args["properties"]["prompt"]["maxLength"], json!(8_000));
        assert_eq!(args["properties"]["prompt"]["minLength"], json!(1));
        assert!(definition.description.contains("never ask for a key"));
        assert!(is_executable(CARD_SUGGEST));
        assert_eq!(wire_tool_name(CARD_SUGGEST), "card_suggest");
    }

    /// #2959 M3 — the name exemption does not outrun the profile.
    #[test]
    fn an_exempt_tool_runs_only_when_the_profile_enabled_it() {
        let none: Vec<ToolDefinition> = Vec::new();
        let enabled = enabled_tool_definitions(&[CARD_SUGGEST.to_string()]);
        for spelling in [CARD_SUGGEST, "Card-Suggest"] {
            assert!(exempt_tool_not_enabled(spelling, &none), "{spelling}");
            assert!(!exempt_tool_not_enabled(spelling, &enabled), "{spelling}");
        }
        // Gated tools keep their own backstop (the approval), untouched here.
        assert!(!exempt_tool_not_enabled(WORK_SESSION_END, &none));
        assert!(not_enabled_output(CARD_SUGGEST).contains("not enabled"));
    }

    /// #4972: the helper's `card_suggest` is the catalog tool **narrowed** to what the request
    /// offers — one command, one property set — and it names nothing else.
    #[test]
    fn the_helpers_card_suggest_offers_only_the_commands_its_request_names() {
        use crate::card_suggest::{
            COMMAND_AI_CONNECT, COMMAND_SETTINGS_OPEN, COMMAND_WORK_REQUEST_OPEN,
        };
        // Nothing offered, nothing on offer; ids the helper may not suggest are ignored even when
        // a caller passes them (the allow-list of the helper is not the caller's to widen).
        assert!(card_suggest_definition(&[]).is_none());
        assert!(card_suggest_definition(&[COMMAND_AI_CONNECT, COMMAND_SETTINGS_OPEN]).is_none());

        let definition = card_suggest_definition(&[
            COMMAND_AI_CONNECT,
            COMMAND_SETTINGS_OPEN,
            COMMAND_WORK_REQUEST_OPEN,
        ])
        .expect("the work request is on offer");
        assert_eq!(definition.name, CARD_SUGGEST);
        let parameters = &definition.parameters;
        assert_eq!(
            parameters["properties"]["commandId"]["enum"],
            json!([COMMAND_WORK_REQUEST_OPEN])
        );
        // The args are the work request's own two properties — no `scope`, no `section`, and the
        // shared `harness` is the work request's enum, not `ai.connect`'s (no `team_key`).
        let args = parameters["properties"]["args"]["properties"]
            .as_object()
            .expect("args properties");
        let mut names: Vec<&str> = args.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["harness", "prompt"]);
        assert_eq!(
            args["harness"]["enum"],
            json!(crate::card_suggest::WORK_REQUEST_HARNESSES)
        );
        // Every sentence the model reads about the other two cards is absent (B15-A16).
        let whole = format!("{} {}", definition.description, parameters);
        for other in [
            COMMAND_AI_CONNECT,
            COMMAND_SETTINGS_OPEN,
            "team_key",
            "section",
        ] {
            assert!(!whole.contains(other), "{other}: {whole}");
        }
        assert!(whole.contains(COMMAND_WORK_REQUEST_OPEN));
        // It is the same tool the executors and the exemption know by name.
        assert!(is_executable(CARD_SUGGEST));
    }
}
